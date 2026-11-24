// AppState.swift
// Composition root: owns the pairing store, the Tailscale node, the API
// client and the notification poller, and derives the connection state the
// UI shows. The user never sees addresses or ports; connection problems are
// reported in plain words ("Your computer is off or unreachable").

import Foundation
import BackgroundTasks
import UserNotifications
import UIKit

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    let pairingStore = PairingStore()
    let tailscale = TailscaleManager()
    lazy var api: LocalAgentAPI = LocalAgentAPI(pairingStore: pairingStore, tailscale: tailscale)
    lazy var poller: NotificationPoller = NotificationPoller(api: api)
    let speech = SpeechService()

    @Published private(set) var connectionState: ConnectionState = .notPaired
    @Published private(set) var connectionDetail: String?
    @Published var isCheckingConnection = false

    /// The Tailscale sign-in URL, when the node needs first-run web auth.
    /// The root view presents it as a web sheet.
    var signInURL: URL? { tailscale.signInURL }

    init() {
        refreshConnectionState()
    }

    var isPaired: Bool { pairingStore.isPaired }

    /// Starts the Tailscale node and the notification polling. Called once
    /// at launch when the phone is already paired, and right after pairing.
    func startServices() {
        guard pairingStore.isPaired else { return }
        Task {
            await tailscale.start()
            await checkConnection()
        }
        poller.startForegroundPolling()
        NotificationPoller.scheduleBackgroundRefresh()
    }

    func stopServices() {
        poller.stopForegroundPolling()
        Task { await tailscale.stop() }
        refreshConnectionState()
    }

    /// Re-checks reachability of the PC and updates the connection state.
    func checkConnection() async {
        guard pairingStore.isPaired else {
            connectionState = .notPaired
            connectionDetail = nil
            return
        }
        isCheckingConnection = true
        defer { isCheckingConnection = false }
        // The Tailscale node must be up before its route can be tried.
        if tailscale.needsSignIn {
            connectionState = .tailscaleNeedsSignIn
            connectionDetail = "Sign in to Tailscale once to finish setting up the secure connection."
            return
        }
        let reachable = await api.checkReachability()
        if reachable {
            connectionState = tailscale.isOnline ? .onlineViaTailscale : .onlineViaLocalNetwork
            connectionDetail = tailscale.isOnline
                ? "Connected to your computer over the secure connection."
                : "Connected to your computer on your home network."
        } else {
            connectionState = .pcUnreachable
            connectionDetail = "Your computer is off or unreachable — the app needs your PC on and connected."
        }
    }

    /// Called when the app returns to the foreground.
    func appBecameActive() {
        guard pairingStore.isPaired else { return }
        poller.startForegroundPolling()
        Task { await checkConnection() }
    }

    func appWentBackground() {
        poller.stopForegroundPolling()
    }

    /// Unpairs this phone: deletes the token from the Keychain, clears the
    /// saved pairing and stops the secure connection. The PC keeps its own
    /// record until the phone is revoked there (Settings -> Phone access).
    func unpair() {
        pairingStore.unpair()
        stopServices()
        connectionState = .notPaired
        connectionDetail = nil
    }

    /// Runs a background refresh: makes sure the secure connection is up,
    /// polls for new notifications, and schedules the next refresh.
    func handleBackgroundRefresh(task: BGAppRefreshTask) async {
        NotificationPoller.scheduleBackgroundRefresh()
        guard pairingStore.isPaired else {
            task.setTaskCompleted(success: true)
            return
        }
        task.expirationHandler = {
            task.setTaskCompleted(success: false)
        }
        await tailscale.start()
        _ = await poller.refresh(showBannerIfBackground: true)
        task.setTaskCompleted(success: true)
    }

    /// Asks for notification permission. Called on first launch after pairing.
    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    private func refreshConnectionState() {
        if pairingStore.isPaired {
            connectionState = .connecting
            connectionDetail = nil
        } else {
            connectionState = .notPaired
            connectionDetail = nil
        }
    }
}
