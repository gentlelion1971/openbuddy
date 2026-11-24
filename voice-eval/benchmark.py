#!/usr/bin/env python3
"""Voice stack benchmark: Whisper STT (tiny vs base vs small) and Piper TTS
(medium vs high voices). Measures transcription speed (real-time factor) and
accuracy (word error rate for English, character error rate for Chinese),
and TTS synthesis speed plus intelligibility (transcribe the output with
Whisper base and score it).

Test sentences are test data for the benchmark only; the shipped app has no
Chinese UI strings. The Chinese sentence exists because the STT test must
cover Chinese transcription, which the product supports.

Usage: ./venv/bin/python benchmark.py [--stt-only] [--tts-only]
Outputs a table on stdout and writes results.md next to this script.
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
VOICES_DIR = HERE / "voices"
CLIPS_DIR = HERE / "clips"
CLIPS_DIR.mkdir(exist_ok=True)
VOICES_DIR.mkdir(exist_ok=True)

EN_TEXT = (
    "The meeting is on Tuesday at ten in the morning. "
    "Please bring the quarterly report and the signed contract."
)
# Test data: one short Chinese sentence for the Chinese STT/TTS benchmark.
ZH_TEXT = "明天下午三点开会，请带上季度报告和签好的合同。"

PIPER_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
VOICES = {
    "en_US-lessac-medium": f"{PIPER_BASE}/en/en_US/lessac/medium/en_US-lessac-medium.onnx",
    "en_US-lessac-high": f"{PIPER_BASE}/en/en_US/lessac/high/en_US-lessac-high.onnx",
    "zh_CN-huayan-medium": f"{PIPER_BASE}/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx",
    # NOTE: huayan has NO high-quality voice (only medium and x_low exist in
    # the Piper repo, verified 2026-11-22). Medium is the best Chinese voice
    # available; x_low is benchmarked to show the gap.
    "zh_CN-huayan-x_low": f"{PIPER_BASE}/zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx",
}


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  already have {dest.name}")
        return
    print(f"  downloading {dest.name} ...")
    urllib.request.urlretrieve(url, dest)


def ensure_voices() -> dict[str, Path]:
    paths = {}
    for name, url in VOICES.items():
        onnx = VOICES_DIR / f"{name}.onnx"
        cfg = VOICES_DIR / f"{name}.onnx.json"
        download(url, onnx)
        download(url + ".json", cfg)
        paths[name] = onnx
    return paths


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / w.getframerate()


def synthesize(voice_onnx: Path, text: str, out: Path) -> float:
    """Synthesize with the piper CLI from this venv. Returns wall seconds."""
    piper_bin = str(Path(sys.executable).parent / "piper")
    start = time.monotonic()
    proc = subprocess.run(
        [piper_bin, "--model", str(voice_onnx), "--output_file", str(out)],
        input=text.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=300,
    )
    elapsed = time.monotonic() - start
    if proc.returncode != 0 or not out.exists():
        raise RuntimeError(f"piper failed for {voice_onnx.name}: {proc.stderr.decode()[-500:]}")
    return elapsed


def levenshtein(a: list[str], b: list[str]) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def normalize_en(text: str) -> list[str]:
    import re

    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return text.split()


def normalize_zh(text: str) -> list[str]:
    import re

    text = re.sub(r"[\s，。、；：？！,.!?;:]", "", text)
    return list(text)


def wer(ref: str, hyp: str, lang: str) -> float:
    if lang == "en":
        r, h = normalize_en(ref), normalize_en(hyp)
    else:
        r, h = normalize_zh(ref), normalize_zh(hyp)
    if not r:
        return 0.0
    return levenshtein(r, h) / len(r)


def transcribe(model, path: Path, lang: str) -> tuple[str, float]:
    """Returns (transcript, wall seconds)."""
    from faster_whisper import WhisperModel  # noqa: F401  (imported for type clarity)

    start = time.monotonic()
    segments, _info = model.transcribe(str(path), language=lang, beam_size=1, vad_filter=False)
    text = "".join(s.text for s in segments).strip()
    return text, time.monotonic() - start


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stt-only", action="store_true")
    ap.add_argument("--tts-only", action="store_true")
    ap.add_argument("--models", default="tiny,base,small")
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    results: dict = {"stt": [], "tts": []}
    voices = ensure_voices()

    # --- Test clips, synthesized once with the best (high) voices ---
    en_clip = CLIPS_DIR / "en-test.wav"
    zh_clip = CLIPS_DIR / "zh-test.wav"
    if not args.tts_only:
        if not en_clip.exists():
            print("Generating English test clip (Piper high)...")
            synthesize(voices["en_US-lessac-high"], EN_TEXT, en_clip)
        if not zh_clip.exists():
            print("Generating Chinese test clip (Piper medium — best available)...")
            synthesize(voices["zh_CN-huayan-medium"], ZH_TEXT, zh_clip)
        print(f"Clips: EN {wav_duration(en_clip):.2f}s, ZH {wav_duration(zh_clip):.2f}s")

    # --- (a) STT benchmark ---
    if not args.tts_only:
        print("\n=== STT: Whisper tiny vs base vs small (CPU, int8, greedy) ===")
        for size in [m.strip() for m in args.models.split(",") if m.strip()]:
            print(f"\n-- {size} --")
            try:
                model = WhisperModel(size, device="cpu", compute_type="int8")
            except Exception as e:  # noqa: BLE001 - record and continue
                print(f"  FAILED to load {size}: {e}")
                results["stt"].append({"model": size, "error": str(e)})
                continue
            for label, clip, text, lang in [
                ("EN", en_clip, EN_TEXT, "en"),
                ("ZH", zh_clip, ZH_TEXT, "zh"),
            ]:
                dur = wav_duration(clip)
                hyp, secs = transcribe(model, clip, lang)
                rate = wer(text, hyp, lang)
                rtf = secs / dur
                print(f"  {label}: {secs:.2f}s for {dur:.2f}s audio (RTF {rtf:.2f}), "
                      f"{'WER' if lang == 'en' else 'CER'} {rate:.1%}  hyp={hyp!r}")
                results["stt"].append(
                    {"model": size, "lang": lang, "seconds": round(secs, 2),
                     "audio_seconds": round(dur, 2), "rtf": round(rtf, 2),
                     "error_rate": round(rate, 4), "hypothesis": hyp}
                )
            del model

    # --- (b) TTS benchmark ---
    if not args.stt_only:
        print("\n=== TTS: Piper medium vs high (synthesis speed + intelligibility) ===")
        base_model = WhisperModel("base", device="cpu", compute_type="int8")
        for lang, text, pair in [
            ("EN", EN_TEXT, ("en_US-lessac-medium", "en_US-lessac-high")),
            ("ZH", ZH_TEXT, ("zh_CN-huayan-medium", "zh_CN-huayan-x_low")),
        ]:
            for name in pair:
                out = CLIPS_DIR / f"tts-{name}.wav"
                secs = synthesize(voices[name], text, out)
                dur = wav_duration(out)
                rtf = secs / dur
                hyp, _ = transcribe(base_model, out, "en" if lang == "EN" else "zh")
                rate = wer(text, hyp, "en" if lang == "EN" else "zh")
                print(f"  {name}: synth {secs:.2f}s for {dur:.2f}s audio (RTF {rtf:.2f}), "
                      f"intelligibility {'WER' if lang == 'EN' else 'CER'} {rate:.1%}  hyp={hyp!r}")
                results["tts"].append(
                    {"voice": name, "lang": lang, "synth_seconds": round(secs, 2),
                     "audio_seconds": round(dur, 2), "rtf": round(rtf, 2),
                     "intelligibility_error_rate": round(rate, 4), "hypothesis": hyp}
                )
        del base_model

    (HERE / "results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print("\nWrote results.json")


if __name__ == "__main__":
    main()
