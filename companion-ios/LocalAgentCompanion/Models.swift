// Models.swift
// Data models for the OpenBuddy companion app.
// These match the phone-access API served by the desktop app on port 47831.
// See ../README.md ("Phone access") and the desktop server
// src/main/remote.ts for the authoritative contract.

import Foundation

// MARK: - Pairing

/// The JSON payload encoded in the QR code shown by the desktop app
/// (Settings -> Phone access). Example:
/// {"v":1,"app":"openbuddy","host":"192.168.1.10","tailscale":"100.64.1.2","port":47831,"code":"ABCDEFGH"}
struct PairingPayload: Codable, Equatable {
    var v: Int
    var app: String
    var host: String
    var tailscale: String
    var port: Int
    var code: String

    /// The PC address to reach away from home (empty when the PC has no Tailscale IP yet).
    var hasTailscaleAddress: Bool { !tailscale.isEmpty }

    var isValid: Bool {
        v == 1 && app == "openbuddy" && !host.isEmpty && port > 0 && !code.isEmpty
    }
}

/// Response of POST /api/pair.
struct PairResponse: Decodable {
    var ok: Bool
    var token: String?
    var deviceId: String?
    var error: String?
}

/// Non-secret pairing record kept in UserDefaults. The token itself lives
/// in the Keychain (see PairingStore) and is never stored here.
struct SavedPairing: Codable, Equatable {
    var host: String
    var tailscale: String
    var port: Int
    var deviceId: String
    var deviceName: String
    var pairedAt: Date
}

// MARK: - API envelope

/// Error body returned by the desktop API: {"ok":false,"error":"..."}.
struct APIErrorBody: Decodable {
    var ok: Bool
    var error: String?
}

// MARK: - Chats

struct ChatSummary: Decodable, Identifiable, Equatable, Hashable {
    var id: String
    var title: String
    var projectId: String?
    var updatedAt: String

    var displayTitle: String { title.isEmpty ? "Untitled chat" : title }
}

struct ChatsResponse: Decodable {
    var ok: Bool
    var chats: [ChatSummary]?
    var error: String?
}

struct ChatMessage: Decodable, Identifiable, Equatable {
    var id: String
    var role: String
    var content: String
    var createdAt: String

    var isFromUser: Bool { role == "user" }
}

struct MessagesResponse: Decodable {
    var ok: Bool
    var messages: [ChatMessage]?
    var error: String?
}

// MARK: - Tasks

struct TaskItem: Decodable, Identifiable, Equatable {
    var id: String
    var title: String
    var status: String
    var dueAt: String?
    var createdAt: String
}

struct TasksResponse: Decodable {
    var ok: Bool
    var tasks: [TaskItem]?
    var error: String?
}

// MARK: - Notifications

/// A completion notification from the desktop app (unread first).
/// `kind` is an opaque string from the server; the app does not interpret it.
struct AppNotification: Decodable, Identifiable, Equatable {
    var id: String
    var kind: String
    var title: String
    var body: String
    var chatId: String?
    var createdAt: String
    var read: Bool
}

struct NotificationsResponse: Decodable {
    var ok: Bool
    var notifications: [AppNotification]?
    var error: String?
}

// MARK: - Memories

struct MemoryEntry: Decodable, Identifiable, Equatable {
    var key: String
    var value: String

    var id: String { key }
}

struct MemoriesResponse: Decodable {
    var ok: Bool
    var memories: [MemoryEntry]?
    var error: String?
}

// MARK: - Health check

struct StatusResponse: Decodable {
    var ok: Bool
    var app: String?
    var version: String?
}

// MARK: - Connection state

/// What the app shows about reachability of the home PC.
/// The user never sees addresses or ports; these states are the whole story.
enum ConnectionState: Equatable {
    case notPaired
    case connecting
    case onlineViaTailscale
    case onlineViaLocalNetwork
    case pcUnreachable
    case tailscaleNeedsSignIn
    case tailscaleUnavailable(String)
}

// MARK: - API errors

enum APIError: LocalizedError, Equatable {
    case notPaired
    case invalidOrExpiredCode
    case unauthorized
    case notFound
    case pcUnreachable
    case serverError(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .notPaired:
            return "This phone is not paired yet. Scan the QR code on your computer to pair it."
        case .invalidOrExpiredCode:
            return "That pairing code is invalid or expired. Generate a new code on your computer and try again."
        case .unauthorized:
            return "Not paired. Scan the QR code on your computer to pair this phone again."
        case .notFound:
            return "That chat was not found on your computer."
        case .pcUnreachable:
            return "Your computer is off or unreachable — the app needs your PC on and connected."
        case .serverError(let message):
            return message
        case .invalidResponse:
            return "Your computer answered in a way this app did not understand. Try again."
        }
    }
}

// MARK: - Date formatting

enum DisplayDate {
    private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    /// Parses the ISO-8601 timestamps the desktop API returns.
    static func parse(_ string: String) -> Date? {
        isoWithFraction.date(from: string) ?? isoPlain.date(from: string)
    }

    /// Short relative text such as "5 min. ago". Falls back to the raw string.
    static func relativeString(_ string: String) -> String {
        guard let date = parse(string) else { return string }
        return relative.localizedString(for: date, relativeTo: Date())
    }
}
