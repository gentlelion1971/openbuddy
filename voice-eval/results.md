# Voice Evaluation — Whisper STT and Piper TTS

Measured 2026-11-22 on this Linux build VM (4 CPU cores, no GPU).
Benchmark script: `benchmark.py` in this folder; raw numbers in `results.json`.
Defaults were NOT changed — this is measurement first, per the plan.

## Method

- **STT**: faster-whisper 1.2.1, CPU, int8, greedy decoding (`beam_size=1`).
  Test clips were synthesized with Piper (clean TTS speech, no background
  noise): English 5.49 s, Chinese 4.53 s.
- **Accuracy**: English = word error rate (WER); Chinese = character error
  rate (CER). Chinese is reported both raw and **normalized** (traditional
  characters mapped to simplified, Arabic digits mapped to Chinese
  numerals, punctuation stripped) — Whisper often outputs traditional
  characters and digits, which inflates the raw CER without changing
  meaning.
- **TTS**: Piper synthesis time vs audio length (real-time factor, RTF).
  Intelligibility = transcribe the synthesized audio with Whisper base and
  score it against the source text.
- **Machine caveat**: this VM's cores are slower than the user's desktop
  CPU, so absolute times will be lower on his machine; the ratios between
  models/voices should hold.

## (a) STT: Whisper tiny vs base vs small

| Model | Size | EN 5.49 s audio | EN WER | ZH 4.53 s audio | ZH CER raw | ZH CER normalized |
| ----- | ---- | --------------- | ------ | --------------- | ---------- | ----------------- |
| tiny  | 75 MB  | 0.92 s (RTF 0.17) | 5.3% | 0.71 s (RTF 0.16) | 47.6% | 19.0% |
| base  | 145 MB | 1.13 s (RTF 0.21) | 5.3% | 1.20 s (RTF 0.26) | 47.6% | 28.6% |
| small | 466 MB | 4.10 s (RTF 0.75) | 5.3% | 3.38 s (RTF 0.75) | 42.9% | 9.5% |

Notes:
- English WER is 5.3% for all three — one word in 19 ("ten" transcribed as
  "10"). The clean TTS clip is too easy to separate the models; on real
  speech (accents, noise, natural phrasing) the gaps will be bigger.
- Chinese: small is clearly best (9.5% normalized); tiny vs base is within
  noise on a single short clip (base scored worse than tiny here — do not
  over-read one sentence). Real misrecognitions in tiny/base included
  "baogao" (report) heard as "bao gao" and "qian" (sign) heard as "qian"
  (thousand) — same sound, wrong characters.
- Speed: tiny is ~4.5x faster than small; small at RTF 0.75 leaves almost
  no headroom on CPU for interactive use.

## (b) TTS: Piper medium vs high

| Voice | Synth time | Audio | RTF | Intelligibility |
| ----- | ---------- | ----- | --- | --------------- |
| en_US-lessac-medium | 2.62 s | 5.20 s | 0.50 | WER 5.3% (the "10"/"ten" artifact) |
| en_US-lessac-high   | 4.91 s | 5.27 s | 0.93 | WER 5.3% |
| zh_CN-huayan-medium | 1.73 s | 4.95 s | 0.35 | CER 4.8% (1 char) |
| zh_CN-huayan-x_low  | 1.54 s | 4.62 s | 0.33 | CER 33.3% normalized (57.1% raw) |

Notes:
- English high is ~1.9x slower than medium with **identical** measured
  intelligibility. No measured reason to switch.
- Chinese: **there is no huayan-high voice** — the Piper repo only ships
  huayan in medium and x_low (verified 2026-11-22). Medium is the best
  Chinese voice available, and it is dramatically more intelligible than
  x_low (4.8% vs 33.3% CER) at the same speed.
- Intelligibility here is a Whisper-transcription proxy, not a listening
  test. A human listen on the user's machine is still needed for a final
  quality judgement (naturalness, tone).

## Recommendation (defaults unchanged)

- **Keep Whisper tiny as the default STT.** It is 4–5x faster than small,
  identical on clean English, and acceptable on Chinese for short voice
  commands. Offer base as a Settings option for users who want better
  Chinese; small is too slow on CPU for interactive use.
- **Keep Piper medium voices as the default TTS.** English high costs ~2x
  the time for no measured gain; Chinese has no high voice; x_low is far
  worse.
- Re-run on the user's machine if absolute latencies matter; the ranking
  is what this benchmark establishes, not the exact seconds.

## Side finding (fixed)

The first benchmark runs failed: pip resolved PyAV 19, which removed the
`metadata_errors` parameter that faster-whisper 1.2.1 passes to `av.open`,
so every transcription crashed. The sidecar's `requirements.txt` now pins
`av>=10,<15` (verified working: 12.3.0). Without the upper bound the
wizard's voice install would hit the same crash on Windows.
