# OpenBuddy

A local-first personal agent for Windows 11. A real desktop app — installed
from a single EXE installer (or run from a portable folder), opened as a
normal Windows window — powered by a local large language model (Ollama +
Qwen3) running on your own machine.

No cloud LLM calls by default. No telemetry. Your data stays on your computer.

Source: https://github.com/gentlelion1971/openbuddy

## What it does

- **Chat** — a main chat plus multiple side chats (create, rename, archive,
  search history), like Muse or ChatGPT.
- **Projects** — like ChatGPT Projects. Each project has its own folder, its
  own memory/notes, its own chats, and its own tool permissions (which folders
  it may read, whether it may send email, which accounts it may use).
- **Long-term memory** — facts, preferences and family details the agent
  remembers, plus per-project memory. Editable in Settings.
- **Email** — list, search, read, summarize and draft replies for your
  Outlook/Hotmail and Gmail accounts (IMAP/SMTP). A morning digest
  summarizes the inbox. The agent never sends email without your explicit
  confirmation in the app.
- **Email attachments (new in 0.2.0)** — the agent reads attachments like a
  person does: Word, PDF, and Excel files are opened and their text is
  included when the agent reads a mail, and the morning digest surfaces
  details that live only in attachments. Image attachments (PNG/JPG) are
  read with offline OCR (tesseract.js, English). Downloaded attachments are
  temporary copies: they are deleted automatically after the retention
  period (default 60 days; 30 / 60 / 90 days or never in Settings →
  Email attachments). The original email is never touched.
- **Models — pick your own (new in 0.2.0)** — Settings → Models lists every
  model with a (Local) or (Remote) tag. Local models run through Ollama on
  this PC (default `qwen3:8b-q8_0`, no API key, private). Remote models call
  an OpenAI-compatible API with your own key (OpenAI and DeepSeek presets,
  or any custom endpoint); the key is encrypted with the OS credential
  store (Windows Credential Manager) and never stored as plain text.
  Selection is manual — you pick, the agent uses your pick. The default
  stays local; remote is strictly opt-in. Some remote models do not support
  tool calling: if one does not, the agent says so instead of failing
  silently, and answers without tools.
- **Calendar & reminders** — view, add and reschedule events; one-off and
  recurring reminders; recurring watches (for example, check an inbox every
  hour for a reply and notify you when it arrives).
- **Browser & forms** — web lookups, price comparison, and filling web forms
  from data you provide. Every submission is shown for confirmation first.
  The first login on each site is done by you, in the app's browser.
- **Files & documents** — read and write local files, read PDF / DOCX / XLSX,
  create documents and spreadsheets, organize folders.
- **Tasks & tracking** — to-dos, long-running watches, goal progress.
- **Voice** — talk to the agent and have it read replies aloud. Speech
  recognition (faster-whisper) and speech synthesis (Piper) run locally.
  Typed input always works, even without the voice engine.
- **Safety** — destructive or outward actions (send email, submit a form,
  pay, delete) always require your confirmation. Credentials are stored
  encrypted with Windows Credential Manager (DPAPI), never in plain files.

## Install (Windows 11)

Requirements: Windows 11, NVIDIA GPU with 12 GB VRAM recommended
(RTX 3060 12 GB works), about 20 GB free disk space.

Two ways to get the app — both ship from the same source:

1. **Portable download (for everyone):** download
   `OpenBuddy-0.2.0-win-portable.zip`, unzip it, and run `OpenBuddy.exe`
   inside the `win-unpacked` folder. No install step. (A one-click NSIS
   installer, `OpenBuddy-0.2.0-setup.exe`, is built on Windows with
   `npm run dist:win:installer` — see "Build from source" below.)
2. **Build from source (for technical users):** clone
   https://github.com/gentlelion1971/openbuddy and follow "Build from
   source" below. You can read all the code first — that is the point.

Either way, the first-run setup wizard opens:

- **Step 1 — Ollama.** The wizard checks whether Ollama is installed.
  If not, click **Download and install Ollama**; complete the Ollama
  installer, then return to the wizard (it waits for Ollama to start).
- **Step 2 — Model.** Click **Download qwen3:8b-q8_0** (about 8 GB). This is
  the default model and fits a 12 GB graphics card. You can add and switch
  models later in Settings → Models.
- **Step 3 — Voice (optional).** Click **Install voice engine** to
  install the local speech engine, or skip it — typed input always works.
- **Step 4 — OCR (optional).** Click **Download OCR data** to enable
  reading text in image attachments (English, about 5 MB, downloaded once,
  then works offline). You can also install it later in Settings →
  Email attachments.
- **Step 5 — Done.** Click **Start using OpenBuddy**.

Connect email in **Settings → Email** (or ask the agent in chat).
For Gmail, use an app password. Passwords are stored encrypted.

That is all. No Python, no packages, no command line needed.

## Model notes

- Default model: `qwen3:8b-q8_0` (Qwen3 8B, 8-bit quantization, about
  8 GB VRAM). It is the model the setup wizard downloads.
- Alternatives that fit a 12 GB card: `qwen3:14b` (4-bit, about 9 GB).
  Larger models such as `qwen3:32b` 4-bit need about 19 GB and do not fit.
- A local 8B model is weaker than a large cloud model at reasoning and
  tool use. It handles everyday work — email, reminders, lookups, forms —
  well, but complex multi-step tasks may be slower or need a second try.
- Change the model any time in **Settings → Models**: the list shows each
  model with a (Local) or (Remote) tag. Add any Ollama tag as a local model
  (pull it in Ollama first), or add a remote model with its base URL,
  model name, and your API key. The same card has a **Thinking mode**
  checkbox: when on, the local Qwen3 model reasons step by step before
  answering. Slower, but better for hard questions. Off by default for
  faster replies.
- Automatic model selection by task difficulty is a planned future feature,
  not built yet — selection is manual in this version.

## Voice

- Speech-to-text: faster-whisper (tiny model, multilingual including
  Chinese and English), running on CPU.
- Text-to-speech: Piper, default voice `zh_CN-huayan-medium` (Chinese),
  fallback `en_US-lessac-medium` (English).
- The voice engine is bundled with the installer as a frozen executable
  when available (`python/voice-sidecar.exe`); otherwise the setup wizard
  installs it automatically from portable Python. You never install Python
  or packages by hand.

## Phone access (companion app)

The PC app also serves your phone, so you can check on tasks while away
from home. Data stays on the home PC — there is no cloud account and no
third-party server in the path.

**Pairing (once, at home):**

1. On the PC, open **Settings → Phone access** and click **Generate
   pairing code**. A QR code and an 8-letter code appear (valid 10 minutes).
2. On the phone, open the companion app and scan the QR code while on the
   same Wi-Fi. The phone stores a long-lived token; the PC stores only a
   hash of it. The pairing code is single-use.
3. Afterwards the phone shows the same chat history, can send messages to
   the agent, and shows a notification when a task it started finishes.

**Away from home:** the phone reaches the PC over Tailscale, a private
mesh network, so it works even though the home public IP changes
(Verizon FIOS, dynamic IP). The PC app can install Tailscale for you with
one click (**Settings → Phone access → Install Tailscale**); you sign in
once with a Tailscale account. The phone app joins the same Tailscale
network. You never type a URL or an IP address.

**Managing access:** paired phones are listed in **Settings → Phone
access**; **Revoke** removes a phone immediately. Turn phone access off
entirely with the **Enable phone access** checkbox. The server listens on
the home network (port 47831) and requires a valid device token for every
endpoint except pairing.

**For the companion-app developer (API):** base URL is
`http://<pc-lan-ip-or-tailscale-ip>:47831`. The QR code contains a JSON
payload: `{"v":1,"app":"openbuddy","host":<lan-ip>,"tailscale":<tailscale-ip>,"port":47831,"code":<pairing-code>}`.

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| GET | `/api/status` | none | Health check: `{ok, app, version}` |
| POST | `/api/pair` | pairing code | Body `{code, deviceName}` → `{token, deviceId}` |
| GET | `/api/chats` | Bearer token | Chat list |
| GET | `/api/chats/:id/messages` | Bearer token | Message history |
| POST | `/api/chats/:id/send` | Bearer token | Body `{text}` → `202 accepted`; poll messages for the answer |
| GET | `/api/tasks` | Bearer token | To-do list |
| GET | `/api/notifications` | Bearer token | Completion notifications (unread first) |
| POST | `/api/notifications/read` | Bearer token | Mark all notifications read |
| GET | `/api/memories` | Bearer token | Global memory (read-only) |

Auth header: `Authorization: Bearer <token>`. Errors are JSON
`{ok:false, error:"..."}` with HTTP 401 (not paired), 403 (bad/expired
pairing code), 404, or 500. The native iOS companion app is a separate
build (see `companion-ios/`); this API is its contract.

## Privacy and safety

**The rule: this app NEVER shares any information with Microsoft or any
other third party — no telemetry, no diagnostics uploads, no usage data,
no Microsoft services anywhere in the app or installer.** There is no
opt-in for sharing because there is nothing to opt into: the app has no
analytics, no crash reporting, no update check, and no account. (Any
"share information with Microsoft" prompt you see at install time comes
from Windows itself — for example SmartScreen checking an unsigned
installer — not from this app, and it does not send this app's data
anywhere.)

- All chats, memory, tasks and settings are stored in a local SQLite
  database under your Windows user data folder.
- The only network connections the app ever makes are:
  - Ollama model downloads (ollama.com) during setup;
  - Piper voice downloads from Hugging Face (download-only — no user data
    is uploaded there);
  - OCR language data (tesseract fast data, GitHub) downloaded once during
    setup or from Settings;
  - Direct IMAP/SMTP to your own email providers (Outlook/Hotmail, Gmail,
    Yahoo) — no middleman service reads your mail;
  - Web lookups you explicitly ask for (browser automation, price checks);
  - A remote model endpoint, only if you add a remote model and select it
    — your messages then go to the provider you configured, with your own
    API key. Local models never send anything anywhere.
- **Audit (2026-11-22, re-checked 2026-11-23):** every dependency and
  installer component was checked — Electron (no crash reporter, no
  auto-updater configured), electron-builder NSIS installer (no
  publish/update section, no telemetry), better-sqlite3, imapflow,
  nodemailer, Playwright, qrcode, React, Vite (build-time only),
  tesseract.js (local OCR, no network after the one-time language-data
  download). None of them sends data anywhere. Two Microsoft touchpoints
  were found and removed: Tailscale is now installed from a direct
  download (pkgs.tailscale.com) instead of winget, and the manual setup
  script downloads Ollama directly instead of using winget. See
  BUILD_STATUS.md for the full audit table.
- **The one exception — Tailscale, strictly opt-in:** phone access away
  from home uses Tailscale, whose client talks to Tailscale's coordination
  server to join your private tailnet. It is off by default, runs only if
  you enable phone access and install Tailscale, and carries only
  encrypted tunnel traffic — Tailscale never sees your chats, mail, or
  files. If you never enable phone access, Tailscale is never involved.
- **Two honest notes:** (1) Ollama's official download redirects through
  GitHub's CDN (Microsoft-owned) — a plain file download that sends no
  user data, and the only official way to get Ollama. (2) Ollama itself is
  a separate product with its own optional update check; this app does not
  add telemetry to it, and you can turn Ollama's update check off in its
  own settings.
- Email credentials are stored encrypted in Windows Credential Manager
  (DPAPI), never in a plain file. Gmail and Yahoo need an app password
  (2-step verification on); Hotmail/Outlook uses the normal password.
  Remote-model API keys use the same encrypted storage.
- Downloaded email attachments are temporary copies under the app data
  folder, deleted automatically after the retention period (default
  60 days). Only those copies are ever deleted — never the original email
  or anything outside the attachments folder.
- Voice (Whisper STT + Piper TTS) runs locally on the CPU with small
  models (Whisper tiny, Piper medium), so it adds no load to the GPU the
  LLM uses.
- Outward actions (send email, submit a form, pay, delete) always ask for
  your confirmation first — in the app, every time.

## Project layout

```
openbuddy/
  package.json, tsconfig.*.json, vite.config.ts, electron-builder.yml
  LICENSE                  OpenBuddy Personal Use License (non-commercial)
  src/main/            Electron main process (window, IPC, agent loop, scheduler)
    main.ts            App entry, IPC handlers, chat flow, confirmations
    ollama.ts          Ollama HTTP client (chat + tool calling)
    openai-chat.ts     OpenAI-compatible HTTP client (remote models)
    models.ts          Model registry: local/remote selection, API-key storage
    agent.ts           Agent turn loop and system prompt
    setup.ts           First-run wizard backend (Ollama/model/voice/OCR install)
    credentials.ts     Encrypted secret storage (safeStorage / DPAPI)
    store.ts           SQLite data access (chats, projects, memory, tasks…)
    scheduler.ts       Reminders, recurring watches, attachment cleanup
    voice.ts           Voice sidecar process manager
    remote.ts          Phone-access API server + Tailscale + QR pairing
    tools/             Tool definitions (email, calendar, browser, files…)
      attachments.ts   Attachment download, text extraction, retention cleanup
      ocr.ts           Offline OCR for image attachments (tesseract.js)
  src/preload/         Preload bridge (window.agent API)
  src/renderer/        React UI (chat, projects, email, calendar, settings…)
  python/sidecar/      Voice sidecar (faster-whisper + Piper)
  scripts/             Windows setup and build scripts
  test/unit/           Plain-node unit tests (models, remote chat, attachments, OCR)
  companion-ios/       iOS companion app source (build in Xcode, TestFlight)
```

## Build from source (developers)

Prerequisites (Windows 11):

- **Node.js 20+** (https://nodejs.org) and **Git**.
- **Ollama** (https://ollama.com/download) — installed separately; the
  first-run wizard downloads and installs it for you if it is missing.
- **Python is only needed for the voice sidecar dev path** (building the
  frozen sidecar exe, `scripts/build-sidecar-exe.ps1`). The app itself,
  the build, and the installer do not need Python.

```powershell
git clone https://github.com/gentlelion1971/openbuddy.git
cd openbuddy
npm install
npm run build          # typecheck + build main + build renderer
npm start              # launch the app
npm run test:unit      # plain-node unit tests (models, remote chat, attachments, OCR)
npm run dist:win       # build the portable Windows folder (dist-packaged/win-unpacked)
npm run dist:win:installer   # build the one-click NSIS installer
```

Notes:

- `npm run dist:win:installer` (NSIS) must be built on Windows — it
  cannot be built on Linux. The portable folder from `npm run dist:win`
  is the cross-platform fallback and is what the portable ZIP ships.
- To bundle the voice engine into the installer, first build the frozen
  sidecar on Windows (requires Python 3.12):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-sidecar-exe.ps1
```

- On first launch the setup wizard runs: it installs Ollama if missing,
  pulls the default model `qwen3:8b-q8_0` (~8 GB), optionally installs the
  voice engine, and optionally downloads the OCR language data (~5 MB,
  English, one-time) so image attachments can be read offline.
- After that, `OpenBuddy.exe` (or the installed app) just runs — no
  command line, no Python, no manual setup.

See `BUILD_STATUS.md` for what is tested, what was verified on Linux,
and what still needs testing on a real Windows machine.

## Troubleshooting

- **"Ollama is not running"** — start Ollama (it runs in the system tray
  after install) or re-run the setup wizard from Settings.
- **Model download is slow** — `qwen3:8b-q8_0` is about 8 GB; the wizard
  shows progress. You can also run `ollama pull qwen3:8b-q8_0` in a
  terminal.
- **Voice engine fails to start** — check Settings → Voice, or reinstall
  it from there. Typed input always works without voice.
- **OCR says the language data is missing** — open Settings → Email
  attachments and click **Download OCR data** (needs internet once,
  about 5 MB), or re-run the setup wizard.
- **A remote model says "No API key saved"** — open Settings → Models,
  select the remote model, and paste your API key. It is encrypted with
  the OS credential store before it is saved.
- **A remote model "does not support tool calling"** — that provider or
  model cannot use the agent's tools (email, calendar, files). Pick a
  model that supports function calling, or switch back to a local model.
- **Email login fails** — for Gmail, create an app password (Google Account
  → Security → App passwords). For Outlook, use your normal password; if
  your account uses two-factor authentication, use an app password.
- **A website blocks the built-in browser** — some sites block automation.
  Log in once in the app's browser; if a site still refuses, the agent
  tells you and you can do that step yourself.

## License

OpenBuddy is free for personal, non-commercial use. Commercial use
requires a separate paid license — see `LICENSE` (OpenBuddy Personal Use
License) for the full terms. A company that wants to use it commercially
should contact the repository owner via the project page at
https://github.com/gentlelion1971/openbuddy.
