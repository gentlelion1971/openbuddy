# Build Status — OpenBuddy (Windows 11 desktop app)

Last updated: 2026-11-23 (v0.2.0 build complete; not yet tested on Windows).
Companion iOS app added 2026-11-22 (sources complete; NOT yet built in Xcode — see "Companion iOS app" below).

## Product decisions (from the user)

- **Full English.** UI strings, menus, buttons, settings, error messages,
  onboarding, tooltips, README and setup guide are all English. No Chinese
  characters anywhere in the software. (The user speaks Chinese to his
  assistant; the app itself is English-only.)
- **Real Windows desktop app.** Installed from a single EXE installer
  (electron-builder NSIS). Double-click to install, desktop shortcut, opens
  as a normal Windows window. Never a web page in a browser.
- **First-run setup wizard inside the app.** Checks for Ollama, downloads and
  launches the Ollama installer when missing, pulls the default model
  (`qwen3:8b-q8_0`) with one click. Manual steps kept to an absolute minimum.
- **Name: OpenBuddy (2026-11-23, user-confirmed).** The product was renamed
  from "Local Agent" to OpenBuddy; repo `github.com/gentlelion1971/openbuddy`.
  The display name, window title, setup wizard, installer name, executable
  name (`OpenBuddy.exe`), and the phone API's `app` field all say OpenBuddy
  now. Internal identifiers that do not show to the user were mostly kept:
  npm package name `local-agent-app`, SQLite file `local-agent.db` (renaming
  it would strand existing users' data), the iOS Xcode target
  `LocalAgentCompanion` (pending a Mac/Xcode pass — see "Companion iOS app").
- **Email attachments must be readable like a person reads them (v0.2.0,
  user requirement 2026-11-23).** FCA swimming and school emails often put
  the key information in attachments (Word, PDF, images). The agent now
  lists, downloads, and auto-reads attachments (PDF/DOCX/XLSX text plus
  image OCR); the morning digest includes attachment-derived info.
- **Attachments are temporary (v0.2.0).** Downloaded copies live in a temp
  folder under the app data dir and are deleted automatically after the
  retention period (default 60 days; 30 / 60 / 90 days or never in
  Settings). Only the app's own cached copies are ever deleted — never the
  original email or anything outside the attachments folder.
- **Model selection is manual (v0.2.0).** Settings → Models lists each model
  with a (Local) or (Remote) tag. Local = Ollama (default `qwen3:8b-q8_0`,
  no API key). Remote = OpenAI-compatible API with the user's own key
  (encrypted in the OS credential store, never plain text). Default stays
  local; remote is strictly opt-in. **Automatic model selection by task
  difficulty is a planned FUTURE feature — documented here, not built.**
- **Distribution is two channels (v0.2.0, both required).** (1) EXE/portable
  download for the user and non-technical users ("foolproof", download and
  run). (2) Open source on GitHub for technical users who read code and
  build it themselves. Both ship from the same source. The license is
  NON-COMMERCIAL (personal use free; commercial use needs a separate paid
  license) — see `LICENSE`. The true one-click NSIS installer still cannot
  be built on this Linux machine; the portable ZIP is the EXE channel for
  now, and the installer must be built on Windows
  (`npm run dist:win:installer`, config ready in `electron-builder.yml`,
  `scripts/build-sidecar-exe.ps1` ready).
- **Voice sidecar needs no manual install.** It is either bundled with the
  installer as a frozen exe (`python/voice-sidecar.exe`, built on Windows
  with `scripts/build-sidecar-exe.ps1`) or installed automatically by the
  wizard from embeddable Python + pip. The user never installs Python or
  packages by hand.
- **Fully offline** except when fetching live web info at the user's request.
- **Privacy: NEVER share information with Microsoft or any third party.**
  No telemetry, no diagnostics uploads, no usage data, no Microsoft
  services anywhere in the app or installer. There is no opt-in because
  there is nothing to opt into. Audited 2026-11-22 (see "Privacy audit"
  below); the two Microsoft touchpoints found (winget) were removed.
  The single exception is Tailscale, strictly opt-in, only for phone
  access away from home.
- **Email: direct IMAP/SMTP to Hotmail/Gmail/Yahoo, no middleman.**
  Credentials in Windows Credential Manager (encrypted). Gmail/Yahoo need
  app passwords (2FA); Hotmail uses the normal password. Scheduled inbox
  scans (hourly/daily, sender + keyword filters) alert on the desktop and
  in the phone app. SMS alerts are NOT native — carrier email-to-SMS (free,
  needs carrier) or Twilio (paid) would be needed; undecided.
- **Voice: Whisper (STT) + Piper (TTS), small local CPU models** — no added
  latency to the GPU LLM. Defaults are lightweight (Whisper tiny, Piper
  medium); a formal tiny-vs-base / medium-vs-high benchmark has not been
  run on the user's machine yet.
- **Target machine:** Windows 11 desktop, NVIDIA RTX 3060 12 GB VRAM.
  Default model `qwen3:8b-q8_0` (Ollama tag verified to exist), about 8 GB
  VRAM. Model switching supported (e.g. `qwen3:14b` Q4_K_M, about 9 GB).
- **Thinking-mode toggle.** Settings has a checkbox to turn Qwen3 thinking
  on/off (off by default for faster replies).
- **Remote phone access (companion app, native iOS first).** Pair once at
  home by scanning a QR code on the PC; afterwards the phone shows the same
  chat history and gets completion notifications, from anywhere. Data stays
  on the home PC; the user never deals with URLs or IPs. Away-from-home
  access goes over Tailscale (the app can install it with one click; the
  user signs in once) because the home public IP is dynamic (Verizon FIOS).
  Web/PWA + manual Tailscale setup was rejected as not foolproof enough.

## Stack

- Electron + TypeScript + React (Vite) for the desktop shell and UI.
- Ollama (local) as the LLM backend, with tool/function calling (Qwen3).
  Remote models (user opt-in) go through an OpenAI-compatible
  /chat/completions client (`src/main/openai-chat.ts`).
- OCR for image attachments: tesseract.js (offline, English; language data
  downloaded once during setup, then works offline).
- Voice: faster-whisper (STT) + Piper (TTS) in a Python sidecar process.
- Storage: SQLite (better-sqlite3). Secrets in Windows Credential Manager
  (Electron safeStorage / DPAPI), never in plain files.
- Email: IMAP/SMTP via imapflow + nodemailer. Browser: Playwright.
- Calendar: local events/reminders in SQLite; Microsoft Graph optional later.
- Phone access: built-in HTTP API server on the PC (port 47831) + QR
  pairing + Tailscale for remote reach; see README "Phone access".

## What is built

- Project scaffold: package.json, TypeScript configs, Vite config,
  electron-builder config (NSIS-first), .gitignore.
- Core: `src/main/tools/types.ts` (tool + permissions contract),
  `src/main/store.ts` (SQLite schema and data access, incl. paired devices
  and notifications), `src/main/credentials.ts` (safeStorage secrets).
- LLM + agent: `src/main/ollama.ts` (Ollama /api/chat streaming + tool
  calls + thinking flag), `src/main/openai-chat.ts` (OpenAI-compatible
  /chat/completions streaming + tool calls, with a no-tools fallback when
  an endpoint rejects tool calling), `src/main/models.ts` (model registry:
  local/remote entries, manual selection, encrypted remote API keys),
  `src/main/agent.ts` (agent turn loop, max 12 tool iterations,
  confirmation flow, system prompt from memories; routes each turn to the
  selected local or remote model).
- Tools: `src/main/tools/builtin.ts` (tasks, reminders, events, memory),
  `email.ts` (IMAP list/search/read, SMTP send, digest), `calendar.ts`
  (local events/reminders, ICS import/export), `browser.ts` (Playwright
  page text, DuckDuckGo search, form fill/submit, price comparison),
  `files.ts` (read/write/list, PDF/DOCX/XLSX read, DOCX/XLSX create),
  `attachments.ts` (attachment download to a temp folder, text extraction,
  retention cleanup), `ocr.ts` (offline OCR for image attachments).
- Main process: `src/main/main.ts` (window, all IPC, chat flow with
  streaming + confirmation queue, scheduler + sidecar + remote-server
  lifecycle), `src/main/scheduler.ts` (60 s tick: reminders + watches),
  `src/main/setup.ts` (Ollama check/install, model pull with progress,
  voice install from embeddable Python, OCR language-data download),
  `src/main/voice.ts` (sidecar manager), `src/main/remote.ts` (phone-access
  API, QR pairing, Tailscale).
- UI: preload bridge (`window.agent`), React app with sidebar, main chat +
  side chats, projects, setup wizard (now 5 steps: Ollama, model, voice,
  OCR data, done), and Email / Calendar / Tasks / Memory / Settings views
  (incl. Models list with (Local)/(Remote) tags + remote API-key config,
  thinking toggle, voice, attachment retention + OCR status, data folder,
  per-project permissions, phone access with QR pairing and Tailscale
  install).
- Tests: `test/unit/` — plain-node unit tests run with
  `npm run test:unit` (25 tests in v0.2.0: model registry, OpenAI-compatible
  chat client incl. the no-tools fallback, attachment helpers incl.
  retention cleanup, real OCR on a generated image). They run against the
  compiled `dist/` output with loader stubs for Electron safeStorage and
  the SQLite store (better-sqlite3 is built for Electron and cannot load
  under plain node).
- Voice sidecar: `python/sidecar/voice.py` (stdio JSON-lines protocol,
  faster-whisper STT, Piper TTS) + `requirements.txt` + `PROTOCOL.md`.
- Scripts: `scripts/build-sidecar-exe.ps1` (PyInstaller onefile),
  `scripts/setup-windows.ps1` (manual/dev setup).

## v0.2.0 — what was added (2026-11-23)

### Email attachments

- Attachment listing: `email.ts` exposes attachments from the IMAP
  bodyStructure (filename, MIME type, size) in inbox/search/read results
  (`AttachmentInfo`); the agent can download any attachment by message UID
  + part id (`email_download_attachment` tool, 25 MB per-file cap, safe
  filenames, stored under `<dataDir>/attachments/<uid>/`).
- Auto-read: reading a mail automatically extracts text from its
  attachments (PDF via pdf-parse, DOCX via mammoth, XLSX first sheet,
  plain text, images via OCR) and includes truncated text in the message
  result. The morning digest includes attachment-derived info (up to 5
  mails with attachments, 3 attachments each, 2 images OCR'd per digest).
- Images: offline OCR with tesseract.js 7 (pure JS/WASM). English language
  data (~5 MB) is downloaded once during setup (new wizard step 4) or
  later in Settings → Email attachments, then works offline. A single
  worker is cached and reused; 120 s per-image timeout; the worker is
  dropped and recreated after a failure.
- Vision-model decision (evaluated, NOT implemented): a small Ollama vision
  model (e.g. qwen2.5vl:7b, ~6 GB) does not fit alongside the main
  qwen3:8b-q8_0 (~8 GB) on the 12 GB RTX 3060 — running it would force the
  main model out of VRAM and back in (slow, interrupts the chat). The
  actual need (schedules, school letters, flyers) is printed text, where
  OCR is faster and more accurate. So: OCR only in v0.2.0; a vision model
  stays a documented future option for photos, charts, and handwriting.
- Retention + cleanup: downloaded attachments are TEMPORARY copies.
  Default retention 60 days, configurable in Settings → Email attachments
  as 30 / 60 / 90 days or never. The scheduler runs cleanup once a day
  (plus a "Clean up now" button). Only files inside the attachments temp
  folder are ever deleted; the original email is never touched.
  Unit-tested (old file deleted, fresh file kept, files outside the folder
  untouched, "never" skips).

### Model selection (manual)

- Settings → Models: a list of model entries, each tagged (Local) or
  (Remote). Local entries are Ollama tags (installed models offered as
  quick-add; any tag can be added). Remote entries are OpenAI-compatible
  endpoints: presets OpenAI (`https://api.openai.com/v1`) and DeepSeek
  (`https://api.deepseek.com/v1`), or a custom endpoint + model name.
  Selecting a remote model reveals its base URL, model name, and API-key
  fields.
- API keys are stored encrypted with the OS credential store (Electron
  safeStorage / Windows Credential Manager) via the existing
  `credentials.ts` helpers, never in plain files. If OS encryption is
  unavailable, saving a key fails with a plain error instead of saving it
  plain.
- Chat routing: `agent.ts` routes each turn to the selected model — Ollama
  /api/chat for local, OpenAI-compatible /chat/completions for remote
  (`openai-chat.ts`). The remote client maps tool calls to OpenAI
  `tool_call_id`s in order, supports SSE streaming and non-streaming JSON
  responses, and retries once without tools when an endpoint rejects tool
  calling — reporting `toolsUnsupported`, which the agent turns into a
  plain note in its reply instead of failing silently.
- Default stays local `qwen3:8b-q8_0`. Existing installs keep their saved
  model: the registry migrates from the legacy `model` setting (their tag
  is kept as a local entry) and only then adds the default. `setup.ts`
  DEFAULT_MODEL changed from `qwen3:8b` to `qwen3:8b-q8_0` for new
  installs.
- FUTURE (documented, not built): automatic model selection by task
  difficulty.

### OpenBuddy rebrand

- Product/display name is OpenBuddy everywhere the user sees it:
  `electron-builder.yml` productName + shortcutName, window title,
  sidebar, chat role labels, setup wizard ("Welcome to OpenBuddy"),
  installer name (`OpenBuddy-0.2.0-setup.exe`), executable
  (`OpenBuddy.exe`), phone API `app: 'openbuddy'` (QR payload +
  /api/status), iOS user-visible strings. The iOS app's validation of the
  QR payload was updated in lockstep (`app == "openbuddy"`), so pairing
  still works.
- Kept as internal identifiers: npm package name `local-agent-app`,
  SQLite file `local-agent.db`, iOS Xcode target `LocalAgentCompanion`
  (renaming the target needs a Mac/Xcode pass), voice-sidecar fallback
  folder (now `OpenBuddy`, dev-only path).
- The /api/status endpoint now reports the real version from
  `app.getVersion()` instead of a hardcoded `0.1.0`.

### Open-source prep + dual distribution

- `LICENSE`: OpenBuddy Personal Use License — free for personal,
  non-commercial use; commercial use requires a separate paid license
  (contact via the GitHub project page). This REPLACES the MIT license
  drafted earlier the same day (user correction 2026-11-23: not MIT).
- `README.md` rewritten: OpenBuddy branding, v0.2.0 features,
  build-from-source instructions for Windows (prerequisites Node.js 20+,
  Git, Ollama installed separately, Python only for the voice sidecar dev
  path; `npm install`, `npm run build`, `npm run dist:win`,
  `npm run dist:win:installer`; what the first-run wizard does), dual
  channels, license.
- Secrets audit (2026-11-23): no credentials, tokens, personal emails,
  addresses, or phone numbers anywhere in the source (grep over src/,
  scripts/, python/, companion-ios/); no `.env` files, no `.db` files in
  the repo; the only identifier naming a person was the old Electron
  `appId` `com.jijun.localagent`, changed to `com.openbuddy.desktop`. iOS
  bundle ID `com.localagent.companion` and empty DEVELOPMENT_TEAM are
  placeholders for the user to set. `.gitignore` covers node_modules,
  dist, dist-packaged, .env, .env.*, *.db, __pycache__/, voice-eval/venv/.
- NOT published: no GitHub repo was created and nothing was pushed.
  Publish happens after v0.2.0 lands (parent handles it); the intended
  home is github.com/gentlelion1971/openbuddy.
- The one-click NSIS installer still cannot be built on this Linux
  machine (needs Windows/Wine). `npm run dist:win:installer` and
  `scripts/build-sidecar-exe.ps1` stay ready for the Windows build step.
  The portable ZIP is the EXE channel for now.

## Privacy audit (2026-11-22)

Rule: the app must NEVER share any information with Microsoft or any other
third party — no telemetry, no diagnostics uploads, no usage data, no
Microsoft services anywhere in the app or installer. Audited by searching
the code for crash reporters, auto-updaters, analytics SDKs and every
hardcoded network destination, and by reviewing the installer config.

| Component | What it does | Verdict |
| --------- | ------------ | ------- |
| Electron main process | No `crashReporter`, no `autoUpdater`, no update check configured | Clean |
| electron-builder NSIS installer | No `publish` section, no update config, no telemetry | Clean |
| better-sqlite3, docx, xlsx, mammoth, pdf-parse | Local file/data libraries | No network use |
| tesseract.js, tesseract.js-core | Offline OCR (WASM); language data downloaded once from GitHub (tessdata_fast) during setup or from Settings | Download-only, no user data; no network after the download |
| Remote-model API calls (only when a remote model is selected) | HTTPS POST to the provider the user configured (OpenAI, DeepSeek, or a custom OpenAI-compatible endpoint), with the user's own API key | **User opt-in only.** Default is local; nothing is sent anywhere unless the user adds a remote model, saves a key, and selects it |
| imapflow, nodemailer | Direct IMAP/SMTP to the user's own providers | User's mail only, no middleman |
| Playwright (bundled Chromium) | Web lookups the user asks for; downloads its browser on first use | User-initiated only |
| qrcode, react, node-cron | UI / scheduling | No network use |
| Vite | Build-time bundler only | Not shipped |
| Ollama download (ollama.com) | Setup-time download; redirects through GitHub's CDN (Microsoft-owned) | Download-only, no user data; only official Ollama distribution |
| Python + pip download (python.org) | Setup-time download of embeddable Python | Download-only |
| Hugging Face (Piper voices) | Setup-time voice download | Download-only, user-approved |
| DuckDuckGo Lite | Web search, only when the user asks for a lookup | User-initiated only |
| Tailscale client (opt-in) | Coordination server contact to join the user's private tailnet; tunnel traffic is end-to-end encrypted | **The one exception.** Off by default; only runs if the user enables phone access and installs Tailscale. Tailscale never sees chats, mail, or files |
| Windows SmartScreen | Windows checks the unsigned installer file on first run | Windows behavior, not the app; no app data is sent. Code signing would avoid the prompt (no certificate held) |
| Ollama (separate product) | Has its own optional update check | Outside this app; can be turned off in Ollama's own settings |

**Changes made by this audit:**
- `src/main/remote.ts` `installTailscale()`: was `winget install
  Tailscale.Tailscale` (Microsoft's package manager). Now downloads the
  MSI straight from `https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi`
  (verified reachable, HTTP 302 to the file) and runs it with
  `msiexec /i <msi> /passive`.
- `scripts/setup-windows.ps1`: was `winget install Ollama.Ollama`. Now
  downloads `https://ollama.com/download/OllamaSetup.exe` directly and
  runs it.
- Renderer: no external URLs (verified — only a `https://…` placeholder
  in a TasksView input hint).
- `electron-updater` is not a dependency (verified in package-lock.json).

## Voice evaluation (2026-11-22)

Measured on this Linux build VM (4 CPU cores, no GPU) with
`voice-eval/benchmark.py` (full method + numbers: `voice-eval/results.md`,
raw data: `voice-eval/results.json`). Defaults NOT changed — measurement
first, per the plan.

**STT — Whisper tiny vs base vs small** (faster-whisper 1.2.1, CPU, int8,
greedy; clean Piper-synthesized clips, EN 5.49 s / ZH 4.53 s):

| Model | EN time (RTF) | EN WER | ZH time (RTF) | ZH CER raw | ZH CER normalized* |
| ----- | ------------- | ------ | ------------- | ---------- | ------------------ |
| tiny  | 0.92 s (0.17) | 5.3% | 0.71 s (0.16) | 47.6% | 19.0% |
| base  | 1.13 s (0.21) | 5.3% | 1.20 s (0.26) | 47.6% | 28.6% |
| small | 4.10 s (0.75) | 5.3% | 3.38 s (0.75) | 42.9% | 9.5% |

\* Normalized = traditional→simplified, digits→Chinese numerals,
punctuation stripped. English WER is identical for all three (one word:
"ten" → "10"); the clean clip is too easy to separate them. Chinese:
small is clearly best; tiny-vs-base is within noise on one short clip.

**TTS — Piper medium vs high** (synthesis RTF + intelligibility, scored by
transcribing the output with Whisper base):

| Voice | Synth RTF | Intelligibility |
| ----- | --------- | --------------- |
| en_US-lessac-medium | 0.50 | WER 5.3% |
| en_US-lessac-high   | 0.93 | WER 5.3% |
| zh_CN-huayan-medium | 0.35 | CER 4.8% |
| zh_CN-huayan-x_low  | 0.33 | CER 33.3% normalized |

**Findings:** English high is ~1.9x slower than medium with identical
measured intelligibility. **Chinese has no high voice** — the Piper repo
only ships huayan in medium and x_low; medium is the best available and
far more intelligible than x_low (4.8% vs 33.3% CER).

**Recommendation (defaults unchanged):** keep Whisper tiny + Piper medium
as defaults. Tiny is 4–5x faster than small with identical clean-English
accuracy; offer base as a Settings option for better Chinese; small is too
slow on CPU for interactive use (RTF 0.75). A human listening check for TTS
quality is still needed on the user's machine.

**Side finding (fixed):** pip resolved PyAV 19, which removed the
`metadata_errors` parameter faster-whisper 1.2.1 passes to `av.open`, so
every transcription crashed. `python/sidecar/requirements.txt` now pins
`av>=10,<15` (verified working: 12.3.0).

## Testing

### Windows VM install test — NOT POSSIBLE on this build machine

Checked 2026-11-22 on this Linux VM:

- `/dev/kvm` does not exist; no `vmx`/`svm` CPU flags (no nested
  virtualization); QEMU / virt-install / virsh are not installed.
- Free memory is about 432 MB (host total 7.7 GB, nearly all in use);
  Windows 11 needs at least 4 GB RAM for a VM.
- Disk space is fine (146 GB free), but without KVM and RAM a Windows 11
  VM cannot be provisioned here.

So the full install + first-launch + wizard flow **cannot be tested in a
Windows VM on this machine**. This is recorded here rather than claimed.

### Verified on this Linux build machine (2026-11-22)

1. `npm install` — succeeds (490 packages; later + `qrcode`).
2. `npm run typecheck` — clean (main + preload + renderer). Fixed during
   the run: imapflow `search()` returns `false | number[]`; a Node-stream
   typing error in the setup downloader; wrong relative import paths in
   renderer components; a `useEffect` returning a promise.
3. `npm run build` — succeeds (main + preload via tsc, renderer via Vite,
   37 modules).
4. `npm run dist:win` (`electron-builder --win --dir`) — succeeds. Verified
   unpacked structure in `dist-packaged/win-unpacked/`: `Local Agent.exe`,
   Electron runtime files, `resources/app.asar` (2,725 entries),
   `resources/app.asar.unpacked/node_modules` (native modules incl.
   better-sqlite3), `resources/python/sidecar/` (voice.py,
   requirements.txt, PROTOCOL.md, models/). Total 540 MB.
5. `npm run dist:linux` — succeeds; app launched under `xvfb-run` and
   stayed running 20+ s, created `local-agent.db` in the user-data folder,
   and the phone-access API answered
   `{"ok":true,"app":"local-agent","version":"0.1.0"}` on port 47831.
   No unhandled errors in the log. (Linux run needs `--no-sandbox` only
   because this VM runs as root; not needed on the user's machine.)
   - Bug found by this smoke test and fixed: `createWindow` used
     `__dirname`, which does not exist in ESM (`"type": "module"`), so the
     window never opened and the code after it (scheduler, remote server)
     never ran. Fixed by deriving `__dirname` from `import.meta.url` and
     making window creation non-fatal.
6. `npm run test:smoke` (`scripts/smoke-test.mjs`) — **PASSES 6/6**: app
   stays running; phone-access API answers; renderer page target exists;
   renderer mounted with visible text (the first-run setup wizard);
   SQLite database created; no fatal errors in the app log. A screenshot
   taken via Chrome DevTools Protocol confirms the wizard renders:
   "FIRST-RUN SETUP / Welcome to Local Agent / Step 1 of 4 — Check
   Ollama / [Download and install Ollama]".
   - Bug found by the screenshot check and fixed: the preload script was
     compiled as ESM, but Electron loads preload scripts as CommonJS, so
     it failed with "Cannot use import statement outside a module",
     `window.agent` was undefined, the React app crashed with
     `TypeError: Cannot read properties of undefined (reading 'setup')`,
     and the window stayed blank white. Fixed by compiling the preload
     to CommonJS and shipping it as `dist/preload/preload.cjs`
     (`scripts/rename-preload.cjs`, run by `npm run build:main`).
7. Phone-access API — headless test (`/tmp/test-remote.mjs` against the
   compiled server, 13 checks, all passed): server start, pairing code +
   QR data URL generation, `/api/status` 200, unauthenticated `/api/chats`
   401, wrong pairing code 403, correct pairing 200 (64-char token),
   pairing-code reuse 403, authenticated chats/messages 200, bad token
   401, `POST /send` 202 with the message delivered to the agent handler,
   `/api/notifications` and `/api/tasks` 200.
8. Voice sidecar — `python3 -m py_compile python/sidecar/voice.py`:
   **passes**. The sidecar protocol was smoke-tested without ML packages
   (ping/transcribe/speak/shutdown paths, error handling, `--check`).
   The underlying engines are verified end-to-end by the voice benchmark
   above (real Whisper transcriptions and Piper syntheses), but a live
   round-trip **through the sidecar protocol itself** (Electron spawning
   it and speaking/transcribing) is still untested — the earlier live
   attempt stalled on the tiny-model download. Also note: the Electron
   launcher already sets `VOICE_DATA_DIR` to the wizard's voice data dir
   (`voice.ts`), so the sidecar finds the wizard-downloaded Piper models
   without re-downloading them.
9. Playwright Chromium install + headless page-text fetch smoke test:
   **NOT DONE — blocked.** `npx playwright install chromium` failed to
   download the browser ("Failed to download Chrome Headless Shell
   159.0.8154.6 ... Download failure, code=1") and the action's approval
   timed out before it completed. Per instructions this is not retried
   without the user asking. Consequence: the browser tools
   (`browser.ts`: Playwright page-text fetch, form fill, price compare)
   are typechecked and bundled but have never run against a real
   Chromium here. They need a first run on the user's Windows machine
   (Playwright downloads its Chromium on first use there) or a re-try of
   the download here after approval.

### Verified on this Linux build machine (2026-11-23, v0.2.0)

1. `npm run typecheck` — clean (main + preload + renderer). Fixed during
   the run: a swallowed `const newPairing = async () => {` line in
   SettingsView.tsx (the Models-card insert had consumed it as its anchor).
2. `npm run build` — succeeds (main + preload via tsc, renderer via Vite,
   37 modules).
3. `npm run test:unit` — **25/25 PASS** (new in v0.2.0): model registry
   (migration incl. legacy-model preservation, validation, remote presets,
   API-key round-trip with the stored value verified encrypted,
   remove-fallback), OpenAI-compatible chat client (SSE parsing, chunked
   tool-call argument reassembly, tool_call_id mapping, tools-unsupported
   fallback against a stub server, non-streaming JSON, 401 handling),
   attachment helpers (safe filenames incl. traversal/reserved names,
   unique paths, PDF/DOCX/XLSX/text extraction from generated files,
   retention cleanup incl. never-skips and never-touches-outside-files),
   real OCR (tesseract.js worker + downloaded eng.traineddata read
   "Swim Practice / Monday 6:00 PM / Pool B" from a PIL-generated PNG).
   The tests run against compiled `dist/` with loader stubs for Electron
   safeStorage and the SQLite store (better-sqlite3 is built for Electron
   and cannot load under plain node).
4. `npm run dist:linux` — succeeds; `npm run test:smoke` — **PASSES 6/6**,
   and the rendered wizard now reads "Welcome to OpenBuddy".
5. `npm run dist:win` — succeeds. Verified `dist-packaged/win-unpacked/`:
   `OpenBuddy.exe`, `resources/app.asar` (3,216 entries, incl.
   `dist/main/models.js`, `openai-chat.js`, `tools/attachments.js`,
   `tools/ocr.js`), `resources/app.asar.unpacked/node_modules/tesseract.js`
   + `tesseract.js-core` (unpacked so the worker can load). Total 558 MB.
   Re-zipped as `OpenBuddy-v0.2.0-win-portable.zip` (204 MB,
   `win-unpacked/` at top level, same layout as v0.1.0). **Not uploaded
   anywhere — the parent handles delivery.**
6. OCR language-data download verified (eng.traineddata fetched from the
   same GitHub URL the setup wizard uses, ~5 MB) as part of the unit test
   above.

### What still needs testing on the user's real Windows machine

- v0.2.0 — attachments end to end: an FCA/swim or school mail with a
  Word/PDF/image attachment — check the agent quotes the attachment
  content and the digest surfaces it.
- v0.2.0 — OCR data download in the first-run wizard (step 4) and in
  Settings → Email attachments; OCR accuracy on real attachments (photos
  of schedules, scanned letters — handwriting and low-contrast photos
  will be weaker; that is expected).
- v0.2.0 — retention cleanup: confirm old cached attachments disappear on
  schedule and that "never" keeps them; confirm nothing outside the
  attachments folder is touched.
- v0.2.0 — remote model: add an OpenAI/DeepSeek/custom model in Settings →
  Models, save an API key (confirm it is encrypted — the settings DB must
  hold no plain key), send a chat, confirm tool calls work; try a model
  that does not support tool calling and confirm the agent says so
  plainly. Switch between local and remote in the same session.
- `npm run dist:win:installer` (NSIS `.exe` installer) — the NSIS target
  needs Windows (or Wine); it cannot be produced on this Linux machine.
  The `--win --dir` unpacked build above is verified, but the installer
  itself is not.
- Double-click install, desktop shortcut, first launch.
- First-run wizard: Ollama install, `qwen3:8b-q8_0` model download, voice
  engine install (including the frozen `voice-sidecar.exe` build via
  `scripts/build-sidecar-exe.ps1`, which must run on Windows).
- A real chat turn against local Ollama on the RTX 3060 (incl. tool calls
  and the thinking-mode toggle).
- Email account connection (Hotmail/Gmail/Yahoo) and a real send with approval.
- Voice: a live STT/TTS round-trip **through the sidecar protocol**
  (Electron spawning it) on the user's machine, plus a human listening
  check for TTS quality. The engine benchmark (tiny/base/small,
  medium/high) is done — see "Voice evaluation" above.
- Phone access end-to-end: QR pairing with the real iOS companion app
  (the app is now built as source under `companion-ios/` — see the
  "Companion iOS app" section below; it still needs its first Xcode build
  on the Mac, then pairing over the LAN and remote access away from home),
  Tailscale install + sign-in, remote access away from home.
- **No Windows install test is claimed as passed until it actually runs
  on Windows.**

## Companion iOS app

Added 2026-11-22. Native SwiftUI app (`companion-ios/`), iOS 17.0+,
Xcode 16.2+, Swift 6, version 0.1.0 (build 1), bundle ID placeholder
`com.localagent.companion` (the user sets their own). English-only.
**It has NOT been compiled: there is no Xcode/macOS on this Linux build
machine, and no Xcode build is claimed as passed.**
Rebrand note (2026-11-23): user-visible strings now say OpenBuddy (the
companion is "OpenBuddy Companion", the QR payload it validates is
`app == "openbuddy"`); the Xcode target/product name is still
`LocalAgentCompanion` — renaming it needs a Mac/Xcode pass.

### What was built

- Xcode project (`LocalAgentCompanion.xcodeproj/project.pbxproj`, written by
  hand) with one app target, automatic signing, and an Xcode synchronized
  folder group for `LocalAgentCompanion/` so new `.swift` files compile
  without hand-editing the project file. The TailscaleKit xcframework is
  referenced from `ThirdParty/TailscaleKit.xcframework` (linked + embedded).
  A shared scheme (`LocalAgentCompanion.xcscheme`) is included.
- Views: PairingView (AVFoundation QR scanner + manual 8-letter-code
  fallback), ChatListView, ChatDetailView (history, send text, on-device
  dictation via SFSpeechRecognizer, read-aloud via AVSpeechSynthesizer),
  TasksView, NotificationsView, SettingsView (connection status, paired PC,
  Tailscale status, unpair). The user never sees addresses, ports, or
  tunnel settings; an unreachable PC is reported plainly ("Your computer is
  off or unreachable — the app needs your PC on and connected").
- Services: PairingStore (token in iOS Keychain with
  `kSecAttrAccessibleAfterFirstUnlock` so background refresh works while
  locked; pairing record in UserDefaults), LocalAgentAPI (all endpoints in
  the README contract; Tailscale address first when the tailnet is up, LAN
  fallback; both failing = PC unreachable), TailscaleManager,
  NotificationPoller (foreground poll every 60 s; BGAppRefreshTask
  background refresh + local notifications), SpeechService.
- Polling: messages every 5 s while a chat is open and a send is pending
  (up to 3 min); notifications every 60 s in the foreground.
- `Info.plist`: camera / microphone / speech-recognition descriptions,
  `UIBackgroundModes = fetch`, `BGTaskSchedulerPermittedIdentifiers`,
  App Transport Security exceptions for plain HTTP to the user's own PC
  (LAN + Tailscale CGNAT addresses). No NetworkExtension capability.
- `scripts/build-tailscalekit.sh` builds the framework from source;
  `ThirdParty/README.md` documents the layout; `companion-ios/README.md`
  has the full build / pairing / TestFlight steps and the limitations
  section (background alerts can be minutes late; PC must be on; APNs
  follow-up documented, not built).
- App icon set generated (1024 px + smaller sizes, blue speech-bubble mark).

### TailscaleKit approach (verified against upstream source, not invented)

- Official **TailscaleKit** from tailscale/libtailscale (`swift/TailscaleKit/`):
  `TailscaleNode` actor, `Configuration(hostName:path:authKey:controlURL:ephemeral:)`,
  `up()` / `down()` / `close()` / `addrs()` / `statusJSON()`. Built from
  source as `TailscaleKit.xcframework` (`make ios-fat`, needs Go) — it is
  NOT a Swift Package. The code was verified against libtailscale commit
  `d1dc45d0` (2026-11-22), read from the actual upstream files
  (`swift/TailscaleKit/URLSession+Tailscale.swift`,
  `swift/TailscaleKit/LocalAPI/MessageProcessor.swift`,
  `swift/TailscaleKit/LocalAPI/Types.swift`,
  `swift/Examples/TailscaleKitHello/HelloFromTailscale/HelloManager.swift`).
- HTTP uses the verified extension
  `URLSessionConfiguration.tailscaleSession(_ node:)` (SOCKS5 proxy through
  the node) — no custom HTTP-over-dial code. First-run sign-in uses
  `authKey: nil` (web auth): the sign-in URL is surfaced from the IPN bus
  (`LocalAPIClient.watchIPNBus`, `Ipn.Notify.BrowseToURL`) and from
  `statusJSON()` (`AuthURL`, `BackendState == "NeedsLogin"`), and opens in a
  Safari sheet. Userspace (tsnet): no PacketTunnelProvider, no entitlement.
- The Swift code has a `#if canImport(TailscaleKit)` fallback that reports
  "not built yet" in the UI, but the project still does not link without the
  framework — run the build script first.

### Verified on this Linux build machine (2026-11-22)

1. `Info.plist` parses (plistlib) and carries every required key
   (camera / mic / speech descriptions, `fetch` background mode, BGTask
   identifier, ATS exceptions).
2. Scheme XML and all asset-catalog JSON parse; every referenced icon file
   exists and is a valid PNG.
3. `grep` over the whole `companion-ios/` tree for CJK characters: empty.
4. Every Swift file re-read for syntax plausibility (balanced braces,
   parens, brackets after stripping strings/comments); no TODO/FIXME left.
5. `project.pbxproj`: balanced braces/parens; all 20 referenced file IDs
   exist; the scheme's BlueprintIdentifier matches the target.
6. TailscaleKit API names used are only ones verified against the upstream
   source at commit `d1dc45d0` (listed above); no invented SDK names.
7. `scripts/build-tailscalekit.sh` passes `bash -n`.
8. No artifact tools were used; all files were written directly.

### What still needs the Mac (not verified)

- Run `scripts/build-tailscalekit.sh` (needs Go + Xcode 16.2+).
- Open the project in Xcode and build for a real iPhone. Confirm the
  synchronized folder group picks up all sources and the target builds.
  The hand-written `project.pbxproj` is the main risk: if Xcode rejects
  anything, fix the project file in Xcode and keep the change.
- Pair against the real desktop app over the LAN, then confirm the phone
  still reaches the PC away from home over Tailscale, and that the
  first-run Tailscale web sign-in sheet appears and completes.
- Confirm a sent message gets its reply, and a finished task produces a
  notification (foreground first, then background after a delay).
- Archive and upload to TestFlight (bundle ID + team must be set first).
