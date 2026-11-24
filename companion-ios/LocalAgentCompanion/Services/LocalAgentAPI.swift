// LocalAgentAPI.swift
// HTTP client for the desktop app's phone-access API (port 47831).
// Contract: GET /api/status, POST /api/pair, GET /api/chats,
// GET /api/chats/:id/messages, POST /api/chats/:id/send (202, then poll),
// GET /api/tasks, GET /api/notifications, POST /api/notifications/read,
// GET /api/memories. All but /api/status and /api/pair need
// "Authorization: Bearer <token>".
//
// Endpoint selection: when the Tailscale node is up, the PC's Tailscale
// address is tried first (works from anywhere); the LAN address is the
// fallback (works at home). When both fail, the PC is reported unreachable.
// Pairing happens at home, so it tries the LAN address first.
// The user never sees addresses or ports; failures surface as
// APIError.pcUnreachable with plain wording.

import Foundation

@MainActor
final class LocalAgentAPI {
    private let pairingStore: PairingStore
    private let tailscale: TailscaleManager

    /// The route that worked most recently, tried first next time.
    private var lastWorkingRoute: Route?
    private var plainSession: URLSession?

    init(pairingStore: PairingStore, tailscale: TailscaleManager) {
        self.pairingStore = pairingStore
        self.tailscale = tailscale
    }

    // MARK: - Routes

    private enum Route {
        case tailscale
        case lan
    }

    private func candidateRoutes(pairingFirst: Bool) -> [Route] {
        guard let pairing = pairingStore.pairing else { return [] }
        let hasTailscale = !pairing.tailscale.isEmpty && tailscale.isOnline
        if pairingFirst {
            // Pairing happens at home: LAN first, Tailscale second.
            return hasTailscale ? [.lan, .tailscale] : [.lan]
        }
        return hasTailscale ? [.tailscale, .lan] : [.lan]
    }

    private func baseURL(for route: Route) -> URL? {
        guard let pairing = pairingStore.pairing else { return nil }
        let host: String
        switch route {
        case .tailscale: host = pairing.tailscale
        case .lan: host = pairing.host
        }
        guard !host.isEmpty else { return nil }
        return URL(string: "http://\(host):\(pairing.port)")
    }

    private func session(for route: Route) async throws -> URLSession {
        switch route {
        case .tailscale:
            return try await tailscale.makeTailscaleSession()
        case .lan:
            if let plainSession { return plainSession }
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 15
            config.timeoutIntervalForResource = 30
            let session = URLSession(configuration: config)
            plainSession = session
            return session
        }
    }

    // MARK: - Pairing

    /// POST /api/pair. Called with the payload from the scanned QR code (or
    /// the manual fallback). Returns the token and device id on success.
    func pair(payload: PairingPayload, deviceName: String) async throws -> (token: String, deviceId: String) {
        let body = try JSONEncoder().encode(PairBody(code: payload.code, deviceName: deviceName))
        // Pairing uses the scanned payload, which may differ from any saved
        // pairing, so temporarily build routes from it.
        let routes: [Route] = payload.hasTailscaleAddress && tailscale.isOnline
            ? [.lan, .tailscale] : [.lan]
        var lastConnectionError: Error?
        for route in routes {
            let host = route == .lan ? payload.host : payload.tailscale
            guard !host.isEmpty,
                  let url = URL(string: "http://\(host):\(payload.port)/api/pair") else { continue }
            do {
                let session = try await session(for: route)
                let data = try await perform(url: url, method: "POST", body: body, token: nil, session: session)
                let decoded = try JSONDecoder().decode(PairResponse.self, from: data)
                guard decoded.ok, let token = decoded.token, let deviceId = decoded.deviceId else {
                    throw APIError.serverError(decoded.error ?? "Pairing failed.")
                }
                lastWorkingRoute = route
                return (token, deviceId)
            } catch let error as APIError {
                // Auth and server errors are answers from the PC, not routing
                // problems: do not try the other route.
                throw error
            } catch {
                lastConnectionError = error
                continue
            }
        }
        if let lastConnectionError { throw lastConnectionError }
        throw APIError.pcUnreachable
    }

    // MARK: - Authenticated endpoints

    func fetchChats() async throws -> [ChatSummary] {
        try await request(path: "/api/chats", responseType: ChatsResponse.self).chats ?? []
    }

    func fetchMessages(chatId: String) async throws -> [ChatMessage] {
        let path = "/api/chats/\(urlEscape(chatId))/messages"
        return try await request(path: path, responseType: MessagesResponse.self).messages ?? []
    }

    /// POST /api/chats/:id/send. The server answers 202 immediately; the
    /// reply arrives later, so the caller polls fetchMessages.
    func sendMessage(chatId: String, text: String) async throws {
        let body = try JSONEncoder().encode(SendBody(text: text))
        let path = "/api/chats/\(urlEscape(chatId))/send"
        _ = try await request(path: path, method: "POST", body: body, responseType: SendResponse.self)
    }

    func fetchTasks() async throws -> [TaskItem] {
        try await request(path: "/api/tasks", responseType: TasksResponse.self).tasks ?? []
    }

    func fetchNotifications() async throws -> [AppNotification] {
        try await request(path: "/api/notifications", responseType: NotificationsResponse.self).notifications ?? []
    }

    func markNotificationsRead() async throws {
        let body = "{}".data(using: .utf8)
        _ = try await request(path: "/api/notifications/read", method: "POST", body: body, responseType: GenericOKResponse.self)
    }

    func fetchMemories() async throws -> [MemoryEntry] {
        try await request(path: "/api/memories", responseType: MemoriesResponse.self).memories ?? []
    }

    /// Probes the PC without authentication. Returns true when any route
    /// answers /api/status. Used to tell "PC off" apart from "not paired".
    func checkReachability() async -> Bool {
        for route in candidateRoutes(pairingFirst: false) {
            guard let base = baseURL(for: route) else { continue }
            do {
                let session = try await session(for: route)
                let url = endpointURL(base: base, path: "/api/status")
                let data = try await perform(url: url, method: "GET", body: nil, token: nil, session: session)
                if let status = try? JSONDecoder().decode(StatusResponse.self, from: data), status.ok {
                    lastWorkingRoute = route
                    return true
                }
            } catch {
                continue
            }
        }
        return false
    }

    // MARK: - Request machinery

    private func request<T: Decodable>(
        path: String,
        method: String = "GET",
        body: Data? = nil,
        responseType: T.Type
    ) async throws -> T {
        guard let token = pairingStore.token else { throw APIError.notPaired }
        var routes = candidateRoutes(pairingFirst: false)
        // Try the last working route first.
        if let last = lastWorkingRoute, routes.contains(last) {
            routes.removeAll { $0 == last }
            routes.insert(last, at: 0)
        }
        var lastConnectionError: Error?
        for route in routes {
            guard let base = baseURL(for: route) else { continue }
            do {
                let session = try await session(for: route)
                let url = endpointURL(base: base, path: path)
                let data = try await perform(url: url, method: method, body: body, token: token, session: session)
                lastWorkingRoute = route
                return try JSONDecoder().decode(T.self, from: data)
            } catch let error as APIError {
                throw error
            } catch {
                lastConnectionError = error
                continue
            }
        }
        if let lastConnectionError { throw lastConnectionError }
        throw APIError.pcUnreachable
    }

    /// Performs one HTTP request and maps HTTP status codes to APIError.
    /// Throws APIError for server answers; throws URLError (or another Error)
    /// for connection failures so the caller can try the next route.
    private func perform(
        url: URL,
        method: String,
        body: Data?,
        token: String?,
        session: URLSession
    ) async throws -> Data {
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            urlRequest.httpBody = body
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token {
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        switch http.statusCode {
        case 200...299:
            return data
        case 401:
            throw APIError.unauthorized
        case 403:
            throw APIError.invalidOrExpiredCode
        case 404:
            throw APIError.notFound
        default:
            if let errorBody = try? JSONDecoder().decode(APIErrorBody.self, from: data),
               let message = errorBody.error, !message.isEmpty {
                throw APIError.serverError(message)
            }
            throw APIError.serverError("Your computer answered with an error (HTTP \(http.statusCode)).")
        }
    }

    private func urlEscape(_ string: String) -> String {
        string.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? string
    }

    /// Joins a base URL and an API path. The leading "/" is stripped first
    /// because appendingPathComponent with a leading slash is unreliable.
    private func endpointURL(base: URL, path: String) -> URL {
        let clean = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return base.appendingPathComponent(clean)
    }

    // MARK: - Request bodies

    private struct PairBody: Encodable {
        var code: String
        var deviceName: String
    }

    private struct SendBody: Encodable {
        var text: String
    }

    private struct SendResponse: Decodable {
        var ok: Bool
        var accepted: Bool?
        var error: String?
    }

    private struct GenericOKResponse: Decodable {
        var ok: Bool
        var error: String?
    }
}
