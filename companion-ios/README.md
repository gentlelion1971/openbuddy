# OpenBuddy Companion (iOS)

The iPhone remote for the OpenBuddy desktop app (Windows 11). The phone
shows the same chats and history as the computer, can send text and voice
instructions to the agent, and gets a notification when a task finishes.
Data and the model stay on the home PC; the phone is a remote control and
viewer only.

English-only: UI strings, code, comments, and docs. No other language is
used anywhere in this app.

## How it works

1. **Pair once, at home.** On the PC, open Settings → Phone access and click
   **Generate pairing code**. A QR code and an 8-letter code appear (valid
   10 minutes). On the phone, open this app and scan the QR code. That is
   the entire setup: no URLs or IPs to type, no VPN app to install by hand.
   The phone stores a long-lived token in the iOS Keychain; the PC stores
   only a hash of it. The pairing code is single-use. (If the camera cannot
   scan, the app offers a manual fallback: the 8-letter code plus the PC
   address shown under the QR code.)
2. **Away from home** the phone reaches the PC over an embedded, encrypted
   Tailscale channel. The phone app contains its own Tailscale node
   (TailscaleKit, userspace — no VPN app, no NetworkExtension, no special
   entitlement). On first connect the user signs into the same Tailscale
   account as the PC, once, in a web sheet the app opens. Afterwards the
   phone connects from anywhere; the user never sees addresses, ports, or
   tunnel settings. No re-scan away from home.
3. **The PC must be on.** The API lives on the home PC (port 47831). When
   the PC is unreachable the app says so plainly: "Your computer is off or
   unreachable — the app needs your PC on and connected."

## What the app does

- **Chats** — the same chat list and message history as the desktop (shared
  store on the PC). Send text; dictate with the microphone (on-device speech
  recognition, no audio leaves the phone); have replies read aloud.
  Sending answers immediately with "accepted" — the agent's reply arrives
  later, so the chat polls every 5 seconds while a reply is pending (up to
  3 minutes).
- **Tasks** — the to-do list from the PC (read-only in v0.1.0).
- **Notifications** — completion notifications from the PC, unread first.
  Foreground polling runs every 60 seconds. Background alerts use
  BGAppRefreshTask (see Limitations).
- **Settings** — connection status, Tailscale status, paired phone details,
  and Unpair. Unpairing deletes the token from the phone; the phone can also
  be revoked on the PC under Settings → Phone access.

## API contract (desktop side)

Base URL: `http://<pc-lan-ip-or-tailscale-ip>:47831`. The QR payload is
`{"v":1,"app":"openbuddy","host":<lan-ip>,"tailscale":<tailscale-ip>,"port":47831,"code":<pairing-code>}`.

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| GET | `/api/status` | none | Health check |
| POST | `/api/pair` | pairing code | Body `{code, deviceName}` → `{token, deviceId}` |
| GET | `/api/chats` | Bearer token | Chat list |
| GET | `/api/chats/:id/messages` | Bearer token | Message history |
| POST | `/api/chats/:id/send` | Bearer token | Body `{text}` → 202; poll messages for the answer |
| GET | `/api/tasks` | Bearer token | To-do list |
| GET | `/api/notifications` | Bearer token | Completion notifications (unread first) |
| POST | `/api/notifications/read` | Bearer token | Mark all notifications read |
| GET | `/api/memories` | Bearer token | Global memory (read-only) |

Endpoint selection in the app: when the Tailscale node is up, the PC's
Tailscale address is tried first, then the LAN address. When both fail, the
PC is reported unreachable. Pairing tries the LAN address first (pairing
happens at home).

## Project layout

```
companion-ios/
  LocalAgentCompanion.xcodeproj/   Xcode project (hand-written project.pbxproj)
  Info.plist                       Camera / mic / speech descriptions, background fetch
  LocalAgentCompanion/             SwiftUI sources (Xcode synchronized folder group)
    LocalAgentCompanionApp.swift   @main entry, background-task registration
    AppState.swift                 Composition root + connection state
    Models.swift                   API models, errors, date formatting
    Services/
      PairingStore.swift           Token in Keychain, pairing record in UserDefaults
      TailscaleManager.swift       Embedded Tailscale node lifecycle + SOCKS5 session
      LocalAgentAPI.swift          HTTP client, endpoint selection, error mapping
      NotificationPoller.swift     Foreground/background notification polling
      SpeechService.swift          On-device dictation + read-aloud
    Views/
      ContentView.swift            Root: pairing flow or main tabs + PC-off banner
      PairingView.swift            QR scanner (AVFoundation) + manual code fallback
      ChatListView.swift           Chat list
      ChatDetailView.swift         History, send text/voice, read-aloud
      TasksView.swift              To-do list
      NotificationsView.swift      Completion notifications
      SettingsView.swift           Status, Tailscale, unpair
    Assets.xcassets/               App icon + accent color
  scripts/build-tailscalekit.sh    Builds TailscaleKit.xcframework from source
  ThirdParty/                      Build output lives here (not committed)
```

The `LocalAgentCompanion/` folder is an Xcode **synchronized folder group**:
new `.swift` files added under it compile without hand-editing
`project.pbxproj`. The project file itself was written by hand; the first
time it is opened in Xcode, check that the group shows all sources and that
the target builds (see "What was verified" below).

## Build on the Mac

Requirements: a Mac with Xcode 16.2 or later, Go (for building
TailscaleKit), an Apple developer account (for running on a real iPhone and
for TestFlight), and a real iPhone (the Tailscale node and the camera
scanner need a device; the app also runs in the simulator for UI work, but
pairing against the real PC needs a device on the same network).

1. Install Go: `brew install go` (or https://go.dev/dl/), and Xcode 16.2+
   from the App Store. Run Xcode once so its command-line tools install.
2. Build TailscaleKit (one time; repeat after pulling a newer libtailscale):
   ```sh
   cd companion-ios
   ./scripts/build-tailscalekit.sh
   ```
   This clones tailscale/libtailscale (shallow) into
   `ThirdParty/libtailscale-src`, runs `make ios-fat`, and copies the
   resulting `TailscaleKit.xcframework` into `ThirdParty/`. It also writes
   the built commit into `ThirdParty/TAILSCALEKIT_VERSION`. Without the
   framework, Xcode fails at link time with "framework not found" — run
   the script first.
3. Open `LocalAgentCompanion.xcodeproj` in Xcode.
4. Signing: select the `LocalAgentCompanion` target → Signing & Capabilities.
   The bundle ID placeholder is `com.localagent.companion` — **set your own**
   (for example `com.<yourname>.localagent.companion`) and pick your Apple
   developer team. Automatic signing is on. The Development Team field is
   intentionally blank in the project file; Xcode fills it once you pick a
   team.
5. Connect a real iPhone, pick it as the run destination, and press Run.
   The app needs a real device for the camera scanner and for the
   Tailscale node to be meaningful.
6. First run: the app asks for camera, microphone, speech-recognition, and
   notification permission. Pair by scanning the QR code on the PC
   (Settings → Phone access → Generate pairing code). If the Tailscale node
   is not signed in yet, the app opens a web sheet: sign in with the same
   Tailscale account as the PC, once. Then the main tabs appear.

## Archive and TestFlight

1. In Xcode, pick **Any iOS Device** as the destination.
2. Product → Archive. When the archive finishes, the Organizer opens.
3. Distribute App → App Store Connect → Upload. (TestFlight is the
   distribution used for this personal app; no App Store listing is needed
   for TestFlight-only distribution to your own account.)
4. In App Store Connect → TestFlight, add yourself as an internal tester and
   install the build on the iPhone.
5. Before submitting to App Store Connect, review the export-compliance
   question: `ITSAppUsesNonExemptEncryption` is set to `false` in
   `Info.plist` (the app's encryption is the Tailscale WireGuard channel
   and iOS-provided secure communications). Confirm that is right for your
   submission; if unsure, answer the compliance questions in App Store
   Connect instead of relying on the plist value.

## Tailscale design (what was used, and why)

- **Official TailscaleKit** from tailscale/libtailscale (`swift/TailscaleKit/`):
  a Swift framework wrapping libtailscale. Core type is the `TailscaleNode`
  actor; `Configuration` has `hostName`, `path` (state dir in the app
  container), `authKey` (`nil` → web-based auth), `controlURL` (default),
  `ephemeral`. Requires Xcode 16.2+, iOS 13.0+ (the app targets iOS 17.0+).
- **Built from source.** TailscaleKit ships as `TailscaleKit.xcframework`
  built with Go (`make ios-fat` in the libtailscale repo), the same way
  Tailscale's own Aperture sample app does it. It is **not** available as a
  Swift Package — do not add it as an SPM dependency.
- **HTTP through the node.** TailscaleKit provides a `URLSession+Tailscale`
  extension that configures URLSession with a SOCKS5 proxy:
  `URLSessionConfiguration.tailscaleSession(_ node:)` (see
  `swift/TailscaleKit/URLSession+Tailscale.swift` and the
  `TailscaleKitHello` example in `swift/Examples/TailscaleKitHello/`).
  The API client uses exactly that — no custom HTTP-over-dial code.
- **Sign-in.** `authKey` is `nil`, so first connect uses web-based auth.
  The node publishes its sign-in URL two ways, and the app uses both: the
  IPN bus (`LocalAPIClient.watchIPNBus`, `Ipn.Notify.BrowseToURL` — "UI
  should open a browser right now") and `statusJSON()` (`AuthURL` in
  `ipnstate.Status`, `BackendState == "NeedsLogin"`). The URL opens in a
  Safari sheet; the node comes online after sign-in. No auth keys are
  managed anywhere.
- **Userspace (tsnet).** TailscaleKit does **not** need a NetworkExtension
  PacketTunnelProvider or any special entitlement. No extra capabilities
  are enabled in the project.
- The Swift code was verified against libtailscale commit `d1dc45d0`
  (2026-11-22). If a newer main changes these APIs, the build script's
  note explains how to pin that commit.

## Info.plist notes

- `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
  `NSSpeechRecognitionUsageDescription` — required for the scanner and for
  dictation.
- `UIBackgroundModes = fetch` plus `BGTaskSchedulerPermittedIdentifiers`
  (`com.localagent.companion.refresh`) — background notification refresh.
- `NSAppTransportSecurity`: the app talks plain HTTP to the user's own
  computer only (LAN address at home, Tailscale address away). No internet
  host is ever contacted, so there is no HTTPS endpoint to use.
  `NSAllowsLocalNetworking` covers the LAN case; `NSAllowsArbitraryLoads`
  is also set because Tailscale addresses (100.64.0.0/10) are not RFC 1918
  local addresses.

## Limitations (honest)

1. **Background notifications can be minutes late.** iOS does not let an
   app poll on a fixed schedule in the background. This app uses
   `BGAppRefreshTask` and iOS decides when it runs (typically every 15
   minutes at best, often less often, and only when the phone is charging
   and idle). An alert about a finished task can therefore arrive minutes
   after the task finished. Foreground polling (every 60 s) is immediate.
   True instant push would need APNs sent directly from the PC: the PC
   would need an APNs key from the Apple developer account and a small
   sender that posts to Apple when a task completes. That is a follow-up,
   not in v0.1.0.
2. **The PC must be on and its Tailscale node up.** The phone has no copy
   of the data and runs no model. If the PC is off, asleep, or offline,
   the app shows "Your computer is off or unreachable" and nothing works
   until the PC is back. (Wake-on-LAN is not in v0.1.0.)
3. **First-run Tailscale sign-in needs the web sheet.** The first time the
   node connects, the user signs into Tailscale in a web page. That is a
   one-time step with the same account as the PC.
4. **Tasks are read-only in v0.1.0.** Creating or completing tasks happens
   on the desktop or through the agent; the phone lists them.
5. **The app has not been built in Xcode yet.** The project file was
   written by hand on a Linux machine without Xcode. See "What was
   verified" below for exactly what was checked here and what still needs
   the Mac.

## What was verified (on Linux, no Xcode/macOS)

- Every `.plist` / XML file parses (`plistlib` / XML parser).
- The whole `companion-ios/` tree contains no CJK characters.
- Every Swift file was re-read for syntax plausibility: balanced braces,
  parens, and brackets; imports resolve to frameworks the project links;
  TailscaleKit API names are only ones verified against the upstream
  source at commit `d1dc45d0` (`TailscaleNode`, `Configuration`,
  `up()`/`down()`/`close()`/`addrs()`/`statusJSON()`,
  `URLSessionConfiguration.tailscaleSession(_:)`, `LocalAPIClient`,
  `watchIPNBus`, `MessageConsumer`, `Ipn.Notify` / `Ipn.NotifyWatchOpt`,
  `LogSink`, `kDefaultControlURL`).
- `project.pbxproj` is well-formed: balanced braces/parens and every
  referenced file ID exists in the file.
- The app icon PNGs are valid (1024×1024 and smaller sizes).

## What still needs the Mac

- Run `scripts/build-tailscalekit.sh` (needs Go + Xcode).
- Open the project in Xcode 16.2+ and build for a real iPhone. Confirm the
  synchronized folder group picks up all sources (File inspector) and the
  target builds with no errors.
- Pair against the real desktop app over the LAN, then leave the home
  network and confirm the phone still reaches the PC over Tailscale.
- Confirm the first-run Tailscale web sign-in sheet appears and completes.
- Confirm a sent message gets its reply, and a finished task produces a
  notification (foreground first, then background after some delay).
- Archive and upload to TestFlight.

**Do not claim the app compiles until Xcode on the Mac actually builds it.**
