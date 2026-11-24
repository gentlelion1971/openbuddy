# Voice sidecar protocol

The voice sidecar (`python/sidecar/voice.py`) is a small Python process that
gives the Electron app offline speech-to-text (faster-whisper) and
text-to-speech (Piper). It speaks one protocol only: JSON objects, one per
line, over stdio.

## How the Electron app launches it

Two ways, in order of preference (see `src/main/setup.ts`):

1. **Bundled frozen exe** - `python/voice-sidecar.exe`, built on Windows with
   `scripts/build-sidecar-exe.ps1` (PyInstaller `--onefile`) and shipped
   inside the installer. Launched with no arguments.
2. **Embeddable Python** - the first-run wizard installs portable Python
   plus the packages in `requirements.txt` under the app data folder, then
   launches `python.exe python/sidecar/voice.py`.

Either way the app spawns the child with piped stdin/stdout, writes one JSON
request per line to stdin, and reads one JSON response per line from stdout.
The sidecar writes its logs to **stderr only** - stdout is reserved for
protocol JSON, so the parent must never parse log lines as responses.

The app sets the `VOICE_DATA_DIR` environment variable to its voice data
directory (the folder the setup wizard downloads the Piper models into)
before spawning the sidecar, so the sidecar finds the models there. When
`VOICE_DATA_DIR` is not set, the sidecar looks in a `models` folder next to
the script (next to the frozen exe when built), or on Windows in
`%LOCALAPPDATA%/LocalAgent/voice/models`.

## Protocol

Every request is a single JSON object on one stdin line; every response is
a single JSON object on one stdout line. Unknown or malformed requests get
an `error` response; the sidecar keeps running.

| Request | Response |
|---|---|
| `{"type": "ping"}` | `{"type": "pong", "ready": true, "stt": true, "tts": true}` |
| `{"type": "transcribe", "audioPath": "<abs path>", "model": "tiny"}` | `{"type": "transcript", "text": "...", "language": "zh"}` |
| `{"type": "speak", "text": "...", "voice": "zh_CN-huayan-medium", "outPath": "<abs path>"}` | `{"type": "spoken", "audioPath": "<same outPath>"}` |
| `{"type": "shutdown"}` | (no response; the process exits 0) |

Error response (for any failed request):

```json
{"type": "error", "message": "Audio file not found: C:\\...\\recording.webm"}
```

Details:

- `transcribe` - `audioPath` must be an absolute path to a wav, webm
  (Electron MediaRecorder output), or mp3 file. faster-whisper decodes it
  via av; an undecodable file returns an `error`. `model` is optional
  (default `"tiny"`); the Whisper model is downloaded by faster-whisper on
  first use and cached, then loaded lazily on the first transcribe call.
  `language` in the response is the auto-detected language code (`"zh"`,
  `"en"`, ...); it is not forced, so English and Chinese recordings both
  work. STT runs on CPU with `int8` compute.
- `speak` - `text` is required and must not be empty; `voice` is optional
  (default `zh_CN-huayan-medium`); `outPath` is an absolute path to write a
  wav file to (parent directories are created). The Piper voice is loaded
  lazily on the first speak call. If the text is ASCII-only and the
  requested (Chinese) voice cannot be loaded, the sidecar falls back to
  `en_US-lessac-medium`.
- `shutdown` - exits cleanly with code 0. The sidecar also exits cleanly
  when stdin reaches EOF (for example when the parent process dies).

## Voice model download behaviour

Piper needs two files per voice (`.onnx` model + `.onnx.json` config),
stored in `VOICE_DATA_DIR/models/`:

| Voice | HuggingFace path (`rhasspy/piper-voices`, `resolve/main/...`) |
|---|---|
| `zh_CN-huayan-medium` | `zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx[.json]` |
| `en_US-lessac-medium` | `en/en_US/lessac/medium/en_US-lessac-medium.onnx[.json]` |

On the first `speak` call for a voice, the sidecar checks for both files
(first in `VOICE_DATA_DIR/models/`, then in a `models` folder next to the
script/exe). If either file is missing it downloads it from the
rhasspy/piper-voices HuggingFace repo into the primary models directory
and then loads it. A failed download (for example no network) returns an
`error` response instead of crashing; the next `speak` call retries. The
setup wizard normally pre-downloads both voices, so this is a fallback,
not the usual path.

## Manual testing

From the project root (replace the paths with real ones on Windows):

```bash
# 1. Check the ML packages are importable (loads no models):
python python/sidecar/voice.py --check
# -> {"ok": true}
#    or {"ok": false, "error": "Missing or broken packages: ..."} (exit 1)

# 2. Start the sidecar and send requests (one JSON object per line):
printf '%s\n' '{"type":"ping"}' | python python/sidecar/voice.py
# -> {"type": "pong", "ready": true, "stt": true, "tts": true}

# 3. Interactive session (type each line, watch the response line):
python python/sidecar/voice.py
{"type":"speak","text":"Hello, this is a test.","voice":"en_US-lessac-medium","outPath":"C:\\Temp\\test.wav"}
{"type":"transcribe","audioPath":"C:\\Temp\\recording.webm","model":"tiny"}
{"type":"shutdown"}

# 4. With a models directory elsewhere:
VOICE_DATA_DIR=C:\Users\you\AppData\Roaming\OpenBuddy\voice python python/sidecar/voice.py
```

On Windows PowerShell, use `echo '{"type":"ping"}' | python python\sidecar\voice.py`
(the same lines work; quote carefully so the JSON survives the shell).

To test with the frozen exe instead, run `voice-sidecar.exe --check` and
then pipe the same JSON lines into `voice-sidecar.exe`.

## Notes for the frozen build

- The script imports only the standard library at module level; the ML
  packages are imported lazily, so `--check` can report a missing package
  instead of failing at startup.
- Paths never rely on `__file__`: when frozen, the models default and the
  fallback search use the directory holding the exe (`sys.executable`).
- If the frozen exe fails to start with an import error for `ctranslate2`
  or `onnxruntime`, rebuild with PyInstaller `--collect-all` for the
  missing package (see `scripts/build-sidecar-exe.ps1`).
