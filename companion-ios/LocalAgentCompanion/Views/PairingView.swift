// PairingView.swift
// One-time pairing, done at home. The desktop app (Settings -> Phone access)
// shows a QR code; this view scans it once. That is the whole setup: no
// URLs or IPs to type, no VPN app to install by hand.
// A manual fallback (8-letter code + the PC address shown under the QR code)
// exists for when the camera cannot scan.

import SwiftUI
import AVFoundation

struct PairingView: View {
    @EnvironmentObject private var appState: AppState

    @State private var cameraStatus: AVAuthorizationStatus = .notDetermined
    @State private var showManualEntry = false
    @State private var manualCode = ""
    @State private var manualHost = ""
    @State private var isPairing = false
    @State private var didHandleCode = false
    @State private var errorMessage: String?
    @State private var infoMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Text("Pair with your computer")
                        .font(.title2.bold())
                        .padding(.top, 8)

                    Text("On your computer, open Settings → Phone access and click Generate pairing code. Then point this phone at the QR code.")
                        .font(.body)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal)

                    if showManualEntry {
                        manualEntryForm
                    } else {
                        scannerSection
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.callout)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                    if let infoMessage {
                        Text(infoMessage)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }

                    Button(showManualEntry ? "Scan a QR code instead" : "Enter the code manually") {
                        showManualEntry.toggle()
                        errorMessage = nil
                    }
                    .font(.callout)

                    Text("Pairing is a one-time step. Afterwards the phone connects from anywhere over the secure connection, and the same chats and history as your computer appear here.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
                .padding()
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .onAppear {
            cameraStatus = AVCaptureDevice.authorizationStatus(for: .video)
            if cameraStatus == .notDetermined {
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    Task { @MainActor in
                        cameraStatus = granted ? .authorized : .denied
                    }
                }
            }
        }
    }

    // MARK: - Scanner

    private var scannerSection: some View {
        Group {
            if isPairing {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Pairing…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(height: 320)
            } else if cameraStatus == .authorized {
                ZStack {
                    QRScannerView { code in
                        handleScannedCode(code)
                    }
                    .frame(height: 320)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    ScannerFrameOverlay()
                }
            } else if cameraStatus == .denied || cameraStatus == .restricted {
                VStack(spacing: 8) {
                    Image(systemName: "camera.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text("Camera access is off. Allow camera access in Settings to scan, or enter the code manually below.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Enter the code manually") {
                        showManualEntry = true
                    }
                }
                .frame(height: 320)
            } else {
                ProgressView()
                    .frame(height: 320)
            }
        }
    }

    // MARK: - Manual entry

    private var manualEntryForm: some View {
        VStack(spacing: 12) {
            Text("Enter the 8-letter code and the PC address shown under the QR code on your computer.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            TextField("8-letter code", text: $manualCode)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
            TextField("PC address (for example 192.168.1.10)", text: $manualHost)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.decimalPad)
                .textFieldStyle(.roundedBorder)
            Button {
                pairManually()
            } label: {
                if isPairing {
                    ProgressView()
                } else {
                    Text("Pair this phone")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isPairing || normalizedCode.isEmpty || manualHost.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private var normalizedCode: String {
        manualCode
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
            .filter { $0.isLetter || $0.isNumber }
    }

    // MARK: - Pairing

    private func handleScannedCode(_ string: String) {
        guard !didHandleCode, !isPairing else { return }
        guard let payload = parseQRCode(string) else {
            errorMessage = "That QR code is not an OpenBuddy pairing code. Check the QR code on your computer and try again."
            return
        }
        didHandleCode = true
        pair(with: payload)
    }

    private func pairManually() {
        let payload = PairingPayload(
            v: 1,
            app: "openbuddy",
            host: manualHost.trimmingCharacters(in: .whitespacesAndNewlines),
            tailscale: "",
            port: 47831,
            code: normalizedCode
        )
        pair(with: payload)
    }

    private func pair(with payload: PairingPayload) {
        errorMessage = nil
        infoMessage = nil
        isPairing = true
        Task {
            do {
                let result = try await appState.api.pair(payload: payload, deviceName: appState.pairingStore.deviceName)
                guard appState.pairingStore.save(payload: payload, token: result.token, deviceId: result.deviceId) else {
                    throw APIError.serverError("The pairing token could not be saved on this phone. Try again.")
                }
                infoMessage = "Paired. Setting up the secure connection…"
                appState.startServices()
                appState.requestNotificationPermission()
                // ContentView switches to the main tabs once isPaired flips.
            } catch let error as APIError {
                errorMessage = error.localizedDescription
                didHandleCode = false
                isPairing = false
            } catch {
                errorMessage = error.localizedDescription
                didHandleCode = false
                isPairing = false
            }
        }
    }

    /// Decodes and validates the QR payload. Anything else is rejected.
    private func parseQRCode(_ string: String) -> PairingPayload? {
        guard let data = string.data(using: .utf8),
              let payload = try? JSONDecoder().decode(PairingPayload.self, from: data),
              payload.isValid else {
            return nil
        }
        return payload
    }
}

// MARK: - Scanner overlay

/// Corner marks over the camera preview so the user knows where to aim.
struct ScannerFrameOverlay: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 16)
            .stroke(Color.white.opacity(0.9), lineWidth: 2)
            .frame(width: 220, height: 220)
    }
}

// MARK: - AVFoundation scanner

struct QRScannerView: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        QRScannerViewController(onCode: onCode)
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

final class QRScannerViewController: UIViewController {
    private let onCode: (String) -> Void
    private var captureSession: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?

    init(onCode: @escaping (String) -> Void) {
        self.onCode = onCode
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupSession()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if captureSession?.isRunning == false {
            captureSession?.startRunning()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if captureSession?.isRunning == true {
            captureSession?.stopRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    private func setupSession() {
        let session = AVCaptureSession()
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer
        captureSession = session
    }
}

extension QRScannerViewController: AVCaptureMetadataOutputObjectsDelegate {
    // Runs on the main queue (set in setupSession), so onCode may update UI state.
    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let string = object.stringValue else {
            return
        }
        onCode(string)
    }
}
