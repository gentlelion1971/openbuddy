// SpeechService.swift
// Voice input and read-aloud for the companion app.
//
// Voice input uses on-device speech recognition (SFSpeechRecognizer with
// requiresOnDeviceRecognition). No audio leaves the phone. If the iPhone
// does not support on-device recognition for English, dictation reports
// that plainly instead of silently falling back to server recognition.
// Read-aloud uses AVSpeechSynthesizer, which is on-device as well.

import Foundation
import AVFoundation
import Speech

@MainActor
final class SpeechService: ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var recognizedText = ""
    @Published private(set) var dictationError: String?
    @Published private(set) var isSpeaking = false

    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let synthesizer = AVSpeechSynthesizer()

    init() {
        synthesizer.delegate = self
    }

    // MARK: - Dictation

    /// Toggles dictation. While recording, recognizedText updates live.
    /// The completion receives the final text (or nil when cancelled).
    func toggleDictation(completion: @escaping (String?) -> Void) {
        if isRecording {
            stopDictation()
            completion(recognizedText.isEmpty ? nil : recognizedText)
            return
        }
        startDictation(completion: completion)
    }

    func stopDictation() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        audioEngine = nil
        isRecording = false
    }

    private func startDictation(completion: @escaping (String?) -> Void) {
        dictationError = nil
        recognizedText = ""
        guard let recognizer, recognizer.isAvailable else {
            dictationError = "Dictation is not available on this iPhone right now."
            completion(nil)
            return
        }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                guard let self else { return }
                Task { @MainActor in
                    if status == .authorized {
                        self.startDictation(completion: completion)
                    } else {
                        self.dictationError = "Speech recognition is turned off. Allow it in Settings to dictate messages."
                        completion(nil)
                    }
                }
            }
            return
        }
        do {
            try beginAudioSession()
        } catch {
            dictationError = "Could not start the microphone (\(error.localizedDescription))."
            completion(nil)
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // On-device only: no audio is sent to any server.
        request.requiresOnDeviceRecognition = true
        recognitionRequest = request
        let engine = AVAudioEngine()
        audioEngine = engine
        let inputNode = engine.inputNode
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            Task { @MainActor in
                if let result {
                    self.recognizedText = result.bestTranscription.formattedString
                    if result.isFinal {
                        let text = self.recognizedText
                        self.stopDictation()
                        completion(text.isEmpty ? nil : text)
                    }
                } else if let error {
                    // requiresOnDeviceRecognition fails on devices without
                    // on-device support for the locale; say so plainly.
                    self.stopDictation()
                    self.dictationError = "On-device dictation is not available on this iPhone (\(error.localizedDescription))."
                    completion(nil)
                }
            }
        }
        let format = inputNode.outputFormat(forBus: 0)
        // Capture the request as a local value: the tap runs on the audio
        // thread and must not touch main-actor-isolated state.
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
            isRecording = true
        } catch {
            stopDictation()
            dictationError = "Could not start the microphone (\(error.localizedDescription))."
            completion(nil)
        }
    }

    private func beginAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Read-aloud

    /// Reads text aloud with the on-device speech synthesizer.
    func speak(_ text: String) {
        stopSpeaking()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        isSpeaking = true
        synthesizer.speak(utterance)
        // isSpeaking is cleared by the delegate callback below; as a
        // fallback the button toggles it off when tapped again.
    }

    func stopSpeaking() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        isSpeaking = false
    }
}

// MARK: - AVSpeechSynthesizerDelegate

extension SpeechService: AVSpeechSynthesizerDelegate {
    // Called on a background queue by AVFoundation; hop to the main actor.
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }
}
