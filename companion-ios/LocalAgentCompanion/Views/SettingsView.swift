// SettingsView.swift
// Connection status, the paired computer, Tailscale status, and unpairing.
// The user never sees addresses, ports, or tunnel settings: status is shown
// in plain words only.

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState

    @State private var showingUnpairConfirmation = false
    @State private var showingSignIn = false

    var body: some View {
        List {
            Section("Connection") {
                HStack {
                    Text("Your computer")
                    Spacer()
                    Text(connectionText)
                        .foregroundStyle(connectionColor)
                }
                if let detail = appState.connectionDetail {
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                if appState.isCheckingConnection {
                    ProgressView()
                } else {
                    Button("Check connection now") {
                        Task { await appState.checkConnection() }
                    }
                }
            }

            Section("Secure connection") {
                HStack {
                    Text("Tailscale")
                    Spacer()
                    Text(tailscaleText)
                        .foregroundStyle(tailscaleColor)
                }
                Text(tailscaleDetail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                if appState.tailscale.needsSignIn {
                    Button("Sign in to Tailscale") {
                        showingSignIn = true
                    }
                    .disabled(appState.signInURL == nil)
                }
                if case .error(let message) = appState.tailscale.state {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(.red)
                }
                Button("Reconnect") {
                    Task { await appState.tailscale.start() }
                }
            }

            Section("This phone") {
                if let pairing = appState.pairingStore.pairing {
                    HStack {
                        Text("Paired as")
                        Spacer()
                        Text(pairing.deviceName)
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Text("Paired on")
                        Spacer()
                        Text(pairing.pairedAt, style: .date)
                            .foregroundStyle(.secondary)
                    }
                }
                Text("Your chats, tasks, and notifications live on your computer. This phone is a remote control and viewer only — no data or model runs here.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Section("Pairing") {
                Button("Unpair this phone", role: .destructive) {
                    showingUnpairConfirmation = true
                }
                Text("Unpairing removes the token from this phone. You can also revoke this phone on the computer under Settings → Phone access.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Section("About") {
                HStack {
                    Text("Version")
                    Spacer()
                    Text("0.1.0 (build 1)")
                        .foregroundStyle(.secondary)
                }
                Text("OpenBuddy Companion — the phone remote for the OpenBuddy desktop app. Data stays on your computer; the phone connects over an encrypted Tailscale channel.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog(
            "Unpair this phone?",
            isPresented: $showingUnpairConfirmation,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive) {
                appState.unpair()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You will need to scan the QR code on your computer again to pair.")
        }
        .sheet(isPresented: $showingSignIn) {
            if let url = appState.signInURL {
                SafariView(url: url)
            }
        }
    }

    // MARK: - Status text

    private var connectionText: String {
        switch appState.connectionState {
        case .notPaired: return "Not paired"
        case .connecting: return "Connecting…"
        case .onlineViaTailscale: return "Connected"
        case .onlineViaLocalNetwork: return "Connected at home"
        case .pcUnreachable: return "Unreachable"
        case .tailscaleNeedsSignIn: return "Needs sign-in"
        case .tailscaleUnavailable: return "Unavailable"
        }
    }

    private var connectionColor: Color {
        switch appState.connectionState {
        case .onlineViaTailscale, .onlineViaLocalNetwork: return .green
        case .pcUnreachable: return .red
        case .tailscaleNeedsSignIn, .tailscaleUnavailable: return .orange
        default: return .secondary
        }
    }

    private var tailscaleText: String {
        switch appState.tailscale.state {
        case .off: return "Off"
        case .starting: return "Starting…"
        case .needsSignIn: return "Needs sign-in"
        case .online: return "Connected"
        case .error: return "Error"
        case .unavailable: return "Not built"
        }
    }

    private var tailscaleColor: Color {
        switch appState.tailscale.state {
        case .online: return .green
        case .needsSignIn, .unavailable: return .orange
        case .error: return .red
        default: return .secondary
        }
    }

    private var tailscaleDetail: String {
        switch appState.tailscale.state {
        case .off:
            return "The secure connection is off."
        case .starting:
            return "Starting the secure connection…"
        case .needsSignIn:
            return "Sign in once with the same Tailscale account as your computer. The sign-in opens in a web page."
        case .online:
            return "Connected. The phone reaches your computer from anywhere over this encrypted channel."
        case .error:
            return "The secure connection ran into a problem. Try Reconnect."
        case .unavailable(let message):
            return message
        }
    }
}
