// LocalAgentCompanionApp.swift
// App entry point. Registers the background refresh task, wires the shared
// AppState into the view hierarchy, and forwards scene-phase changes so
// foreground polling starts and stops with the app.

import SwiftUI
import BackgroundTasks

@main
struct LocalAgentCompanionApp: App {
    @StateObject private var appState = AppState.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        NotificationPoller.registerBackgroundTask()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appState)
                .onAppear {
                    if appState.isPaired {
                        appState.startServices()
                        appState.requestNotificationPermission()
                    }
                }
        }
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .active:
                appState.appBecameActive()
            case .background:
                appState.appWentBackground()
            case .inactive:
                break
            @unknown default:
                break
            }
        }
    }
}
