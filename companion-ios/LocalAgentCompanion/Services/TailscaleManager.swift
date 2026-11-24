// TailscaleManager.swift
// Embedded Tailscale node (userspace, tsnet) via the official TailscaleKit
// framework from tailscale/libtailscale (swift/TailscaleKit/).
//
// Verified against the upstream source (commit d1dc45d0, 2026-11-22):
//   - TailscaleNode actor; Configuration(hostName:path:authKey:controlURL:ephemeral:)
//   - TailscaleNode(config:logger:) throws; up() async throws; down() throws;
//     close() async throws; addrs() -> (ip4: String?, ip6: String?);
//     statusJSON() async throws -> Data
//   - URLSessionConfiguration.tailscaleSession(_ node:) async throws
//     -> (URLSessionConfiguration, TailscaleNode.LoopbackConfig)
//     (swift/TailscaleKit/URLSession+Tailscale.swift). This routes HTTP through
//     the node's internal SOCKS5 proxy. See the TailscaleKitHello example
//     (swift/Examples/TailscaleKitHello/) for the same pattern.
//   - LocalAPIClient(localNode:logger:); watchIPNBus(mask:consumer:) async throws
//     -> MessageProcessor; MessageConsumer protocol (notify(_:) / error(_:));
//     Ipn.Notify has BrowseToURL (open a browser to sign in) and State;
//     Ipn.NotifyWatchOpt has .initialState, .netmap, .rateLimitNetmaps,
//     .noPrivateKeys; LogSink protocol (log(_:)).
//   - The node state JSON (statusJSON) is ipnstate.Status with string fields
//     BackendState ("Running", "NeedsLogin", ...) and AuthURL.
//
// What this file deliberately does NOT use:
//   - No NetworkExtension / PacketTunnelProvider, no special entitlement.
//     TailscaleKit is userspace (tsnet); a plain app target is enough.
//   - No auth keys. authKey is nil, so first connect uses web-based auth:
//     the node publishes a sign-in URL (IPN bus BrowseToURL, or AuthURL in
//     statusJSON) and the app opens it in a web sheet. The user signs into
//     the same Tailscale account as the PC, once.
//
// The framework itself is built from source by scripts/build-tailscalekit.sh
// into ThirdParty/TailscaleKit.xcframework. If it is missing, this file still
// compiles (see the #else branch) but the project does not link; run the
// script first. See the companion README for the exact steps.

import Foundation

#if canImport(TailscaleKit)
import TailscaleKit
#endif

extension Notification.Name {
    static let tailscaleIPNNotify = Notification.Name("com.localagent.tailscale.ipn-notify")
}

enum TailscaleState: Equatable {
    case off
    case starting
    case needsSignIn
    case online(ip4: String)
    case error(String)
    case unavailable(String)
}

enum TailscaleManagerError: LocalizedError {
    case frameworkNotBuilt
    case nodeNotRunning

    var errorDescription: String? {
        switch self {
        case .frameworkNotBuilt:
            return "Tailscale support is not built yet. Run scripts/build-tailscalekit.sh on the Mac, then rebuild."
        case .nodeNotRunning:
            return "The secure connection is not running yet."
        }
    }
}

#if canImport(TailscaleKit)

/// Receives IPN bus notifications from the node. The only fields this app
/// needs are BrowseToURL (first-run sign-in) and State (Running).
actor IPNBusConsumer: MessageConsumer {
    func notify(_ notify: Ipn.Notify) {
        NotificationCenter.default.post(name: .tailscaleIPNNotify, object: notify)
    }

    func error(_ error: Error) {
        // Bus transport errors are transient. The status poller below is the
        // source of truth for the node state, so nothing is done here.
    }
}

struct TailscaleLogger: LogSink {
    func log(_ message: String) {
        print("[tailscale] \(message)")
    }
}

/// Lenient decode of the node status JSON (ipnstate.Status). Only the fields
/// this app needs; everything else is ignored.
private struct NodeStatusPayload: Decodable {
    var BackendState: String?
    var AuthURL: String?
    var TailscaleIPs: [String]?
}

@MainActor
final class TailscaleManager: ObservableObject {
    @Published private(set) var state: TailscaleState = .off
    /// The web sign-in URL the node publishes while it needs authentication.
    @Published private(set) var signInURL: URL?

    var isOnline: Bool {
        if case .online = state { return true }
        return false
    }

    var needsSignIn: Bool { state == .needsSignIn }

    private var node: TailscaleNode?
    private var localAPIClient: LocalAPIClient?
    private var processor: MessageProcessor?
    private var cachedSession: URLSession?
    private var statusTask: Task<Void, Never>?
    private var ipnObserver: NSObjectProtocol?
    private let logger = TailscaleLogger()

    init() {
        ipnObserver = NotificationCenter.default.addObserver(
            forName: .tailscaleIPNNotify, object: nil, queue: .main
        ) { [weak self] note in
            guard let self, let notify = note.object as? Ipn.Notify else { return }
            self.handleIPNNotify(notify)
        }
    }

    deinit {
        if let ipnObserver { NotificationCenter.default.removeObserver(ipnObserver) }
        statusTask?.cancel()
    }

    /// Creates the node (if needed) and brings it up. Safe to call again:
    /// it re-runs up() and refreshes the status.
    func start() async {
        if case .starting = state { return }
        state = .starting
        do {
            if node == nil {
                let stateDir = try stateDirectory()
                let config = Configuration(
                    hostName: "openbuddy-phone",
                    path: stateDir.path,
                    authKey: nil,
                    controlURL: kDefaultControlURL,
                    ephemeral: false
                )
                node = try TailscaleNode(config: config, logger: logger)
            }
            guard let node else { return }
            startStatusPolling()
            try await node.up()
            // Follow the TailscaleKitHello example: LocalAPI client and IPN
            // bus watcher are set up after up(). Cancel any previous watcher
            // first: start() is safe to call again (background refresh does).
            processor?.cancel()
            processor = nil
            let client = LocalAPIClient(localNode: node, logger: logger)
            localAPIClient = client
            let consumer = IPNBusConsumer()
            let mask: Ipn.NotifyWatchOpt = [.initialState, .netmap, .rateLimitNetmaps, .noPrivateKeys]
            processor = try await client.watchIPNBus(mask: mask, consumer: consumer)
            await refreshStatus()
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    /// Takes the node down and releases it.
    func stop() async {
        statusTask?.cancel()
        statusTask = nil
        processor?.cancel()
        processor = nil
        localAPIClient = nil
        cachedSession = nil
        signInURL = nil
        if let node {
            try? node.down()
            try? await node.close()
        }
        node = nil
        state = .off
    }

    /// A URLSession that routes requests through the node's SOCKS5 proxy, so
    /// HTTP to the PC's Tailscale address works from anywhere. The session is
    /// cached for the lifetime of the node.
    func makeTailscaleSession() async throws -> URLSession {
        guard let node else { throw TailscaleManagerError.nodeNotRunning }
        if let cachedSession { return cachedSession }
        let (config, _) = try await URLSessionConfiguration.tailscaleSession(node)
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        let session = URLSession(configuration: config)
        cachedSession = session
        return session
    }

    /// Refreshes the node state once from statusJSON().
    func refreshStatus() async {
        guard let node else { return }
        do {
            let data = try await node.statusJSON()
            let payload = try JSONDecoder().decode(NodeStatusPayload.self, from: data)
            switch payload.BackendState {
            case "Running":
                let ip4 = await nodeIP4(node: node, fallback: payload.TailscaleIPs?.first)
                state = .online(ip4: ip4 ?? "")
                signInURL = nil
            case "NeedsLogin", "NeedsMachineAuth":
                state = .needsSignIn
                if let authURLString = payload.AuthURL,
                   !authURLString.isEmpty,
                   let url = URL(string: authURLString) {
                    signInURL = url
                }
            case "Starting", "Stopped", "NoState", nil:
                // Still coming up, or briefly down; keep polling.
                if !isOnline { state = .starting }
            default:
                if !isOnline { state = .starting }
            }
        } catch {
            // The node is not answering yet; the poller retries.
        }
    }

    // MARK: - Private

    private func nodeIP4(node: TailscaleNode, fallback: String?) async -> String? {
        if let addresses = try? await node.addrs(), let ip4 = addresses.ip4, !ip4.isEmpty {
            return ip4
        }
        return fallback
    }

    private func handleIPNNotify(_ notify: Ipn.Notify) {
        if let urlString = notify.BrowseToURL,
           !urlString.isEmpty,
           let url = URL(string: urlString) {
            // The node is asking the UI to open a browser so the user can
            // sign in. This is the first-run Tailscale sign-in.
            signInURL = url
            if state == .starting || state == .needsSignIn {
                state = .needsSignIn
            }
        }
        if notify.State == .Running {
            Task { await refreshStatus() }
        }
    }

    private func startStatusPolling() {
        statusTask?.cancel()
        statusTask = Task {
            while !Task.isCancelled {
                await refreshStatus()
                // Poll fast while connecting, slow once online.
                let delay: UInt64 = isOnline ? 30_000_000_000 : 3_000_000_000
                try? await Task.sleep(nanoseconds: delay)
            }
        }
    }

    private func stateDirectory() throws -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = support.appendingPathComponent("tailscale", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

#else

// Fallback when TailscaleKit.xcframework has not been built yet. The project
// does not link without the framework (see the README), so this only exists
// so the source still compiles and the missing step is reported in the UI
// instead of failing with an obscure error.

@MainActor
final class TailscaleManager: ObservableObject {
    @Published private(set) var state: TailscaleState = .unavailable(
        "Tailscale support is not built yet. Run scripts/build-tailscalekit.sh on the Mac, then rebuild."
    )
    @Published private(set) var signInURL: URL?

    var isOnline: Bool { false }
    var needsSignIn: Bool { false }

    func start() async {
        state = .unavailable(
            "Tailscale support is not built yet. Run scripts/build-tailscalekit.sh on the Mac, then rebuild."
        )
    }

    func stop() async {
        state = .off
    }

    func makeTailscaleSession() async throws -> URLSession {
        throw TailscaleManagerError.frameworkNotBuilt
    }

    func refreshStatus() async {}
}

#endif
