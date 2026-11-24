// NotificationPoller.swift
// Polls GET /api/notifications and turns newly arrived unread notifications
// into local notifications on the phone.
//
// Honest limitation: iOS does not let an app poll on a fixed schedule in the
// background. This uses BGAppRefreshTask, and iOS decides when it runs —
// typically every 15 minutes at best, often less often. Alerts can therefore
// be minutes late. True instant push would need APNs sent directly from the
// PC (documented as a follow-up in the README); it needs an APNs key from the
// Apple developer account and a small sender on the PC, and is not in v0.1.0.
//
// While the app is in the foreground, notifications are polled every 60 s
// and the badge updates immediately; no banner is shown then because the
// user is already looking at the app.

import Foundation
import BackgroundTasks
import UserNotifications

@MainActor
final class NotificationPoller: ObservableObject {
    static let backgroundTaskIdentifier = "com.localagent.companion.refresh"

    @Published private(set) var unreadCount: Int = 0
    @Published private(set) var latest: [AppNotification] = []

    private let api: LocalAgentAPI
    private var foregroundTimer: Timer?
    private var seenNotificationIDs: Set<String> {
        get {
            Set(UserDefaults.standard.stringArray(forKey: "seenNotificationIDs") ?? [])
        }
        set {
            UserDefaults.standard.set(Array(newValue), forKey: "seenNotificationIDs")
        }
    }

    init(api: LocalAgentAPI) {
        self.api = api
    }

    // MARK: - Foreground polling

    /// Starts the 60 s foreground poll. Call when the app becomes active and
    /// the phone is paired; call stopForegroundPolling() when it goes away.
    func startForegroundPolling() {
        stopForegroundPolling()
        Task { await refresh(showBannerIfBackground: false) }
        foregroundTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in await self.refresh(showBannerIfBackground: false) }
        }
    }

    func stopForegroundPolling() {
        foregroundTimer?.invalidate()
        foregroundTimer = nil
    }

    /// Fetches notifications, updates the badge, and returns the new unread
    /// items. When showBannerIfBackground is true and the app is not active,
    /// a local notification is posted for each new item.
    @discardableResult
    func refresh(showBannerIfBackground: Bool) async -> [AppNotification] {
        do {
            let notifications = try await api.fetchNotifications()
            latest = notifications
            let unread = notifications.filter { !$0.read }
            unreadCount = unread.count
            setBadge(unread.count)
            let newItems = unread.filter { !seenNotificationIDs.contains($0.id) }
            if !newItems.isEmpty {
                seenNotificationIDs.formUnion(newItems.map { $0.id })
            }
            if showBannerIfBackground, !newItems.isEmpty {
                postLocalNotifications(for: newItems)
            }
            return newItems
        } catch {
            // Polling failures are silent: the connection banner in the UI
            // already explains an unreachable PC.
            return []
        }
    }

    /// Marks every notification read on the PC and clears the local state.
    func markAllRead() async {
        do {
            try await api.markNotificationsRead()
            unreadCount = 0
            latest = latest.map { notification in
                var copy = notification
                copy.read = true
                return copy
            }
            setBadge(0)
        } catch {
            // The list view shows the error; the badge is left unchanged.
        }
    }

    // MARK: - Background refresh

    /// Registers the BGAppRefreshTask handler. Called once at app launch.
    static func registerBackgroundTask() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: backgroundTaskIdentifier, using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            // BGTask is not Sendable, so it is handed to the async work in a
            // small box. The box is only ever used by this one task.
            let box = SendableTaskBox(task: refreshTask)
            Task {
                await AppState.shared.handleBackgroundRefresh(task: box.task)
            }
        }
    }

    /// A Sendable box for a BGAppRefreshTask. BGTask does not conform to
    /// Sendable; the boxed task is confined to the single background task
    /// that owns it and is never shared across tasks.
    private struct SendableTaskBox: @unchecked Sendable {
        let task: BGAppRefreshTask
    }

    /// Schedules the next background refresh. iOS treats this as a request,
    /// not a guarantee: it decides the actual cadence.
    static func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: backgroundTaskIdentifier)
        // Earliest iOS will consider running it. It may run much later.
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            print("[notifications] Could not schedule background refresh: \(error)")
        }
    }

    // MARK: - Private

    private func postLocalNotifications(for items: [AppNotification]) {
        let center = UNUserNotificationCenter.current()
        for item in items {
            let content = UNMutableNotificationContent()
            content.title = item.title
            content.body = item.body
            content.sound = .default
            let request = UNNotificationRequest(
                identifier: "local-agent-\(item.id)",
                content: content,
                trigger: nil
            )
            center.add(request)
        }
    }

    private func setBadge(_ count: Int) {
        Task { @MainActor in
            await UNUserNotificationCenter.current().setBadgeCount(count)
        }
    }
}
