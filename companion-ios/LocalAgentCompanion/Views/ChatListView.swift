// ChatListView.swift
// The same chats as on the desktop, served from the shared store on the PC.
// Tapping a chat opens its message history.

import SwiftUI

struct ChatListView: View {
    @EnvironmentObject private var appState: AppState

    @State private var chats: [ChatSummary] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading && chats.isEmpty {
                ProgressView("Loading chats…")
            } else if let errorMessage, chats.isEmpty {
                ContentUnavailableView {
                    Label("Could not load chats", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Retry") { Task { await loadChats() } }
                }
            } else if chats.isEmpty {
                ContentUnavailableView {
                    Label("No chats yet", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Start a chat on your computer, or send a message here once a chat exists.")
                }
            } else {
                List(chats) { chat in
                    NavigationLink(value: chat) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(chat.displayTitle)
                                .font(.headline)
                                .lineLimit(1)
                            Text(DisplayDate.relativeString(chat.updatedAt))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .refreshable { await loadChats() }
            }
        }
        .navigationTitle("Chats")
        .navigationDestination(for: ChatSummary.self) { chat in
            ChatDetailView(chat: chat)
        }
        .task { await loadChats() }
    }

    private func loadChats() async {
        isLoading = true
        defer { isLoading = false }
        do {
            chats = try await appState.api.fetchChats()
            errorMessage = nil
        } catch let error as APIError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
