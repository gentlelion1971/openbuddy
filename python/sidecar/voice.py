#!/usr/bin/env python3
"""Voice sidecar for the OpenBuddy desktop app.

A stdio JSON-lines process launched by the Electron app as a child process.
It provides offline speech-to-text (faster-whisper) and text-to-speech
(Piper) over a tiny line-based JSON protocol.

Protocol (one JSON object per line on stdin, one JSON object per line on
stdout; all logs go to stderr, never stdout):

    {"type": "ping"}
      -> {"type": "pong", "ready": true, "stt": true, "tts": true}

    {"type": "transcribe", "audioPath": "<abs path to wav/webm/mp3>",
     "model": "tiny"}
      -> {"type": "transcript", "text": "...", "language": "zh"}
      or {"type": "error", "message": "..."}

    {"type": "speak", "text": "...", "voice": "zh_CN-huayan-medium",
     "outPath": "<abs path to write wav>"}
      -> {"type": "spoken", "audioPath": "<same outPath>"}
      or {"type": "error", "message": "..."}

    {"type": "shutdown"}
      -> exits 0 cleanly. Exits cleanly on stdin EOF as well.

Voice model files live under VOICE_DATA_DIR/models/ (environment variable).
When VOICE_DATA_DIR is not set, the default is a "models" folder next to
this script (next to the frozen exe when built with PyInstaller), or
%LOCALAPPDATA%/OpenBuddy/voice/models on Windows. The Electron app should
set VOICE_DATA_DIR to its voice data directory (the folder its first-run
wizard downloads the Piper models into) so the sidecar finds them.

Usage:
    python voice.py            # run the stdio loop
    python voice.py --check    # print {"ok": true} or a JSON error if a
                               # required package is missing (no models
                               # are loaded in this mode)

Only the Python standard library is imported at module load time. The
heavy ML packages (faster-whisper, piper-tts) are imported lazily, inside
the functions that need them, so `--check` works and reports missing
packages instead of crashing at import time, and so the module stays
importable in environments where the ML packages are not installed.
"""

import json
import os
import sys
import urllib.request
import wave

DEFAULT_VOICE = "zh_CN-huayan-medium"
FALLBACK_VOICE = "en_US-lessac-medium"
DEFAULT_STT_MODEL = "tiny"

PIPER_BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/"

# Known Piper voices: voice id -> HuggingFace repo sub-path (without the
# file name) and the file stem. Both the .onnx model and the .onnx.json
# config are needed. Keep this in sync with PIPER_VOICES in
# src/main/setup.ts, which downloads the same files during setup.
KNOWN_VOICES = {
    "zh_CN-huayan-medium": {
        "repo_path": "zh/zh_CN/huayan/medium",
        "file_stem": "zh_CN-huayan-medium",
    },
    "en_US-lessac-medium": {
        "repo_path": "en/en_US/lessac/medium",
        "file_stem": "en_US-lessac-medium",
    },
}

# Lazily loaded singletons: model size -> WhisperModel, voice id -> PiperVoice.
_stt_models = {}
_tts_voices = {}


def log(message):
    """Write a log line to stderr only. Stdout is reserved for protocol JSON."""
    print(message, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Paths (must work when frozen with PyInstaller --onefile, where __file__
# points inside a temporary bundle directory, so never rely on __file__).
# ---------------------------------------------------------------------------

def _app_dir():
    """Directory holding the running script, or the frozen exe."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except NameError:
        # __file__ is not defined (e.g. run from an embedded interpreter).
        return os.path.dirname(os.path.abspath(sys.argv[0]))


def models_dir():
    """Primary directory that holds the Piper .onnx / .onnx.json files."""
    env_dir = os.environ.get("VOICE_DATA_DIR")
    if env_dir:
        return os.path.join(env_dir, "models")
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return os.path.join(local_app_data, "OpenBuddy", "voice", "models")
    return os.path.join(_app_dir(), "models")


def _models_search_dirs():
    """Directories searched for an already-downloaded voice, in order.

    The primary dir comes first; a "models" folder next to the script/exe
    is a fallback so a bundled voice still works when VOICE_DATA_DIR
    points elsewhere.
    """
    dirs = [models_dir()]
    next_to_app = os.path.join(_app_dir(), "models")
    if next_to_app not in dirs:
        dirs.append(next_to_app)
    return dirs


# ---------------------------------------------------------------------------
# Piper voice files: find locally, download on demand.
# ---------------------------------------------------------------------------

def _voice_file_paths(directory, voice_id):
    stem = KNOWN_VOICES[voice_id]["file_stem"]
    onnx = os.path.join(directory, stem + ".onnx")
    config = os.path.join(directory, stem + ".onnx.json")
    return onnx, config


def _find_voice_files(voice_id):
    """Return (onnx_path, config_path) if both files exist somewhere, else None."""
    for directory in _models_search_dirs():
        onnx, config = _voice_file_paths(directory, voice_id)
        if os.path.isfile(onnx) and os.path.isfile(config):
            return onnx, config
    return None


def _download_file(url, dest_path):
    """Download a URL to dest_path (via a temp file, then renamed)."""
    tmp_path = dest_path + ".tmp"
    log("Downloading %s ..." % url)
    request = urllib.request.Request(url, headers={"User-Agent": "OpenBuddyVoice/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        if response.status != 200:
            raise RuntimeError("Download failed (HTTP %s): %s" % (response.status, url))
        with open(tmp_path, "wb") as out_file:
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                out_file.write(chunk)
    os.replace(tmp_path, dest_path)
    log("Downloaded %s" % dest_path)


def ensure_voice_files(voice_id):
    """Make sure a voice's .onnx and .onnx.json exist; download if missing.

    Returns (onnx_path, config_path). Raises RuntimeError with a clear
    message when the voice is unknown or the download fails (e.g. offline).
    """
    if voice_id not in KNOWN_VOICES:
        known = ", ".join(sorted(KNOWN_VOICES))
        raise RuntimeError("Unknown voice: %s (known voices: %s)" % (voice_id, known))

    found = _find_voice_files(voice_id)
    if found is not None:
        return found

    target_dir = models_dir()
    os.makedirs(target_dir, exist_ok=True)
    info = KNOWN_VOICES[voice_id]
    onnx_path, config_path = _voice_file_paths(target_dir, voice_id)
    for suffix in (".onnx", ".onnx.json"):
        url = PIPER_BASE_URL + info["repo_path"] + "/" + info["file_stem"] + suffix
        dest = os.path.join(target_dir, info["file_stem"] + suffix)
        if not os.path.isfile(dest):
            _download_file(url, dest)
    if not (os.path.isfile(onnx_path) and os.path.isfile(config_path)):
        raise RuntimeError("Voice files missing after download: %s" % voice_id)
    return onnx_path, config_path


# ---------------------------------------------------------------------------
# Speech-to-text (faster-whisper, loaded lazily).
# ---------------------------------------------------------------------------

def _get_stt_model(model_size):
    if model_size in _stt_models:
        return _stt_models[model_size]
    from faster_whisper import WhisperModel

    log("Loading faster-whisper model: %s (cpu, int8)" % model_size)
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    _stt_models[model_size] = model
    return model


def transcribe(audio_path, model_size=DEFAULT_STT_MODEL):
    """Transcribe an audio file; returns (text, language).

    Accepts wav, webm (Electron MediaRecorder output), mp3 and anything
    else faster-whisper can decode via av. Raises RuntimeError/FileNotFoundError
    with a clear message when the file is missing or undecodable.
    """
    if not audio_path:
        raise ValueError("transcribe: 'audioPath' is required")
    if not os.path.isfile(audio_path):
        raise FileNotFoundError("Audio file not found: %s" % audio_path)

    model = _get_stt_model(model_size or DEFAULT_STT_MODEL)
    try:
        # Language is auto-detected; do not force it, so English and
        # Chinese recordings both work.
        segments, info = model.transcribe(audio_path)
        text = "".join(segment.text for segment in segments).strip()
    except Exception as exc:  # e.g. av decoding failure on a bad format
        raise RuntimeError(
            "Could not transcribe %s (is it a wav/webm/mp3 file?): %s"
            % (audio_path, exc)
        ) from exc
    language = getattr(info, "language", None) or "unknown"
    return text, language


# ---------------------------------------------------------------------------
# Text-to-speech (Piper, loaded lazily).
# ---------------------------------------------------------------------------

def _is_ascii_only(text):
    try:
        text.encode("ascii")
        return True
    except UnicodeEncodeError:
        return False


def _get_tts_voice(voice_id):
    if voice_id in _tts_voices:
        return _tts_voices[voice_id]
    from piper import PiperVoice

    onnx_path, config_path = ensure_voice_files(voice_id)
    log("Loading Piper voice: %s" % voice_id)
    voice = PiperVoice.load(onnx_path, config_path)
    _tts_voices[voice_id] = voice
    return voice


def speak(text, voice_id, out_path):
    """Synthesize text to a wav file; returns the out path.

    Falls back to the English voice when the text is ASCII-only and the
    requested (Chinese) voice cannot be loaded. Raises RuntimeError with a
    clear message when synthesis fails.
    """
    if not text or not text.strip():
        raise ValueError("speak: 'text' must not be empty")
    if not out_path:
        raise ValueError("speak: 'outPath' is required")
    if voice_id not in KNOWN_VOICES:
        known = ", ".join(sorted(KNOWN_VOICES))
        raise RuntimeError("Unknown voice: %s (known voices: %s)" % (voice_id, known))

    voice = None
    last_error = None
    try:
        voice = _get_tts_voice(voice_id)
    except Exception as exc:  # missing files, download failure, load failure
        last_error = exc
        log("Could not load voice %s: %s" % (voice_id, exc))

    if voice is None and _is_ascii_only(text) and voice_id != FALLBACK_VOICE:
        log("Falling back to %s for ASCII-only text" % FALLBACK_VOICE)
        try:
            voice = _get_tts_voice(FALLBACK_VOICE)
        except Exception as exc:
            last_error = exc

    if voice is None:
        raise RuntimeError(
            "Could not load voice %s: %s" % (voice_id, last_error)
        )

    parent = os.path.dirname(os.path.abspath(out_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    try:
        # piper-tts >= 1.3 renamed the wav-writing API: synthesize(text)
        # now only yields audio chunks, and synthesize_wav(text, wav_file)
        # writes them into an open wave.Wave_write object. Older versions
        # wrote the wav from synthesize(text, wav_file) directly.
        # Prefer synthesize_wav when present; fall back for old versions.
        # (Calling synthesize() with a file object silently produces
        # nothing in new versions because it returns a lazy generator.)
        if hasattr(voice, "synthesize_wav"):
            with wave.open(out_path, "wb") as wav_file:
                voice.synthesize_wav(text, wav_file)
        else:
            with open(out_path, "wb") as wav_file:
                voice.synthesize(text, wav_file)
    except Exception as exc:
        raise RuntimeError("Speech synthesis failed: %s" % exc) from exc
    if not os.path.isfile(out_path) or os.path.getsize(out_path) <= 44:
        # 44 bytes is just an empty wav header: no audio was produced.
        raise RuntimeError("Speech synthesis produced no audio for %r" % text)
    return out_path


# ---------------------------------------------------------------------------
# --check mode: verify the ML packages import, without loading any model.
# ---------------------------------------------------------------------------

def check():
    """Return (ok, missing, detail) for the packages this sidecar needs."""
    missing = []
    for module, what in (
        ("faster_whisper", "faster-whisper (STT)"),
        ("piper", "piper-tts (TTS)"),
    ):
        try:
            __import__(module)
        except Exception as exc:  # ImportError or a broken native dependency
            missing.append("%s: %s" % (what, exc))
    if missing:
        detail = "Missing or broken packages: " + "; ".join(missing)
        return False, missing, detail
    return True, [], "faster-whisper and piper-tts are importable"


# ---------------------------------------------------------------------------
# JSON-lines protocol loop.
# ---------------------------------------------------------------------------

def _send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _error(message):
    _send({"type": "error", "message": str(message)})


def handle_message(message):
    """Handle one decoded request object and send exactly one response."""
    if not isinstance(message, dict):
        _error("Request must be a JSON object")
        return True
    msg_type = message.get("type")

    if msg_type == "ping":
        _send({"type": "pong", "ready": True, "stt": True, "tts": True})
        return True

    if msg_type == "shutdown":
        return False

    if msg_type == "transcribe":
        try:
            text, language = transcribe(
                message.get("audioPath"),
                message.get("model") or DEFAULT_STT_MODEL,
            )
            _send({"type": "transcript", "text": text, "language": language})
        except Exception as exc:
            _error(exc)
        return True

    if msg_type == "speak":
        try:
            out_path = speak(
                message.get("text", ""),
                message.get("voice") or DEFAULT_VOICE,
                message.get("outPath"),
            )
            _send({"type": "spoken", "audioPath": out_path})
        except Exception as exc:
            _error(exc)
        return True

    _error("Unknown message type: %r" % (msg_type,))
    return True


def run_loop():
    """Read JSON lines from stdin until EOF or a shutdown message."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            _error("Invalid JSON: %s" % exc)
            continue
        try:
            if not handle_message(message):
                return 0
        except Exception as exc:  # a handler must never kill the loop
            log("Handler error: %s" % exc)
            try:
                _error(exc)
            except Exception:
                pass
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # Keep stdout/stderr as UTF-8 on Windows consoles; JSON output itself
    # is ASCII-escaped, but log lines may contain non-ASCII paths.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    if "--check" in argv:
        ok, _missing, detail = check()
        if ok:
            print(json.dumps({"ok": True}))
            return 0
        print(json.dumps({"ok": False, "error": detail}))
        return 1

    log("Voice sidecar started (pid %s)" % os.getpid())
    try:
        return run_loop()
    finally:
        log("Voice sidecar exiting")


if __name__ == "__main__":
    sys.exit(main())
