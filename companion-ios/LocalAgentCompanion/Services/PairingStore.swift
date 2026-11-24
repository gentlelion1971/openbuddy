// PairingStore.swift
// Stores the pairing state: the long-lived device token in the iOS Keychain,
// the non-secret pairing record (PC addresses, device id) in UserDefaults.
//
// The token is the only secret. It is stored with
// kSecAttrAccessibleAfterFirstUnlock so background refresh can read it while
// the phone is locked. The PC stores only a hash of the token.

import Foundation
import Security

/// Thin Keychain wrapper for a single generic-password item.
enum KeychainStore {
    private static let service = "com.localagent.companion"
    private static let tokenAccount = "deviceToken"

    static func saveToken(_ token: String) -> Bool {
        guard let data = token.data(using: .utf8) else { return false }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        // Remove any previous item, then add the new one.
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    static func loadToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty else {
            return nil
        }
        return token
    }

    static func deleteToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// Owns the pairing state for the app. Observable so the root view can
/// switch between the pairing flow and the main tabs.
@MainActor
final class PairingStore: ObservableObject {
    @Published private(set) var pairing: SavedPairing?
    @Published private(set) var isPaired: Bool = false

    private let pairingDefaultsKey = "savedPairing"
    private let defaults = UserDefaults.standard

    init() {
        loadFromDefaults()
    }

    var token: String? { KeychainStore.loadToken() }

    var deviceName: String { UIDevice.current.name }

    /// Saves a completed pairing: token to the Keychain, the rest to UserDefaults.
    /// Returns false when the token could not be stored.
    @discardableResult
    func save(payload: PairingPayload, token: String, deviceId: String) -> Bool {
        guard KeychainStore.saveToken(token) else { return false }
        let saved = SavedPairing(
            host: payload.host,
            tailscale: payload.tailscale,
            port: payload.port,
            deviceId: deviceId,
            deviceName: deviceName,
            pairedAt: Date()
        )
        pairing = saved
        isPaired = true
        persist(saved)
        return true
    }

    /// Removes all pairing state from this phone. The PC keeps its own record
    /// until the phone is revoked there (Settings -> Phone access -> Revoke).
    func unpair() {
        KeychainStore.deleteToken()
        pairing = nil
        isPaired = false
        defaults.removeObject(forKey: pairingDefaultsKey)
    }

    private func loadFromDefaults() {
        guard let data = defaults.data(forKey: pairingDefaultsKey),
              let saved = try? JSONDecoder().decode(SavedPairing.self, from: data),
              KeychainStore.loadToken() != nil else {
            // A record without a token is not a pairing.
            pairing = nil
            isPaired = false
            return
        }
        pairing = saved
        isPaired = true
    }

    private func persist(_ saved: SavedPairing) {
        if let data = try? JSONEncoder().encode(saved) {
            defaults.set(data, forKey: pairingDefaultsKey)
        }
    }
}
