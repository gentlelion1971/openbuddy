// ContentView.swift
// Root view. Shows the pairing flow until the phone is paired, then the main
// tabs (Chats, Tasks, Notifications, Settings). A connection banner explains
// plainly when the PC cannot be reached, and the Tailscale sign-in sheet
// appears when the secure connection needs its one-time web sign-in.

import SwiftUI
import SafariServices

struct ContentView: View {
    @EnvironmentObject private var appState: AppState
    @State private var selectedTab = 0
    @State private var showingSignIn = false

    var body: some View {
        Group {
            if appState.isPaired {
                mainTabs
            } else {
                PairingView()
            }
        }
        .sheet(isPresented: $showingSignIn) {
            if let url = appState.signInURL {
                SafariView(url: url)
            }
        }
        .onChange(of: appState.connectionState) { _, newState in
            if newState == .tailscaleNeedsSignIn {
                showingSignIn = true
            }
        }
        .onReceive(appState.tailscale.$signInURL) { url in
            if url != nil && appState.connectionState == .tailscaleNeedsSignIn {
                showingSignIn = true
            }
        }
    }

    private var mainTabs: some View {
        TabView(selection: $selectedTab) {
            NavigationStack {
                ChatListView()
            }
            .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
            .tag(0)

            NavigationStack {
                TasksView()
            }
            .tabItem { Label("Tasks", systemImage: "checklist") }
            .tag(1)

            NavigationStack {
                NotificationsView()
            }
            .tabItem { Label("Notifications", systemImage: "bell") }
            .badge(appState.poller.unreadCount > 0 ? Text("\(appState.poller.unreadCount)") : nil)
            .tag(2)

            NavigationStack {
                SettingsView()
            }
            .tabItem { Label("Settings", systemImage: "gear") }
            .tag(3)
        }
        .overlay(alignment: .top) {
            if appState.connectionState == .pcUnreachable {
                connectionBanner
            }
        }
    }

    private var connectionBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text("Your computer is off or unreachable — the app needs your PC on and connected.")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button("Retry") {
                Task { await appState.checkConnection() }
            }
            .font(.footnote.bold())
        }
        .padding(10)
        .background(Color.orange.opacity(0.2))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal)
        .padding(.top, 8)
    }
}

/// A SFSafariViewController wrapper for the Tailscale web sign-in sheet.
struct SafariView: UIViewControllerRepresentable {
    var url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}
