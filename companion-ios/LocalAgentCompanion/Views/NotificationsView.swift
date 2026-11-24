// NotificationsView.swift
// Completion notifications from the PC (GET /api/notifications), unread
// first. "Mark all read" tells the PC (POST /api/notifications/read).

import SwiftUI

struct NotificationsView: View {
    @EnvironmentObject private var appState: AppState

    @State private var notifications: [AppNotification] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading && notifications.isEmpty {
                ProgressView("Loading notifications…")
            } else if let errorMessage, notifications.isEmpty {
                ContentUnavailableView {
                    Label("Could not load notifications", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Retry") { Task { await loadNotifications() } }
                }
            } else if notifications.isEmpty {
                ContentUnavailableView {
                    Label("No notifications", systemImage: "bell")
                } description: {
                    Text("When a task you started finishes, or a watch you set fires, a notification appears here.")
                }
            } else {
                List {
                    ForEach(notifications) { notification in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                if !notification.read {
                                    Circle()
                                        .fill(Color.blue)
                                        .frame(width: 8, height: 8)
                                }
                                Text(notification.title)
                                    .font(.headline)
                            }
                            Text(notification.body)
                                .font(.body)
                                .foregroundStyle(.secondary)
                            Text(DisplayDate.relativeString(notification.createdAt))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .refreshable { await loadNotifications() }
            }
        }
        .navigationTitle("Notifications")
        .toolbar {
            if !notifications.isEmpty {
                Button("Mark all read") {
                    Task {
                        await appState.poller.markAllRead()
                        await loadNotifications()
                    }
                }
            }
        }
        .task { await loadNotifications() }
    }

    private func loadNotifications() async {
        isLoading = true
        defer { isLoading = false }
        do {
            notifications = try await appState.api.fetchNotifications()
            errorMessage = nil
        } catch let error as APIError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
