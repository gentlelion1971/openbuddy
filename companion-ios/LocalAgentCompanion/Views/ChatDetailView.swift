// ChatDetailView.swift
// Message history for one chat, plus sending text or dictated voice input,
// and read-aloud of the agent's replies.
//
// Sending: POST /api/chats/:id/send answers 202 immediately; the agent's
// reply arrives later, so this view polls the message list every 5 seconds
// while a reply is pending (up to 3 minutes), then stops and says the agent
// is still working. New replies appear when they arrive.

import SwiftUI

struct ChatDetailView: View {
    @EnvironmentObject private var appState: AppState

    let chat: ChatSummary

    @State private var messages: [ChatMessage] = []
    @State private var draftText = ""
    @State private var isLoading = false
    @State private var isSending = false
    @State private var isWaitingForReply = false
    @State private var errorMessage: String?
    @State private var lastMessageCount = 0
    @State private var speakingMessageId: String?

    private var speech: SpeechService { appState.speech }

    var body: some View {
        VStack(spacing: 0) {
            messageList
            divider
            composer
        }
        .navigationTitle(chat.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadMessages() }
        .task(id: isWaitingForReply) {
            guard isWaitingForReply else { return }
            await pollForReply()
        }
        .onDisappear {
            speech.stopSpeaking()
            if speech.isRecording { speech.stopDictation() }
        }
    }

    // MARK: - Message list

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if isLoading && messages.isEmpty {
                        ProgressView("Loading messages…")
                            .padding(.top, 24)
                    }
                    ForEach(messages) { message in
                        MessageRow(
                            message: message,
                            isSpeaking: speakingMessageId == message.id,
                            onReadAloud: { readAloud(message) }
                        )
                        .id(message.id)
                    }
                    if isWaitingForReply {
                        HStack(spacing: 6) {
                            ProgressView()
                                .controlSize(.small)
                            Text("The agent is working…")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                        .id("waiting")
                    }
                }
                .padding()
            }
            .onChange(of: messages.count) { _, _ in
                scrollToBottom(proxy: proxy)
            }
            .onChange(of: isWaitingForReply) { _, _ in
                scrollToBottom(proxy: proxy)
            }
        }
    }

    private func scrollToBottom(proxy: ScrollViewProxy) {
        let target = isWaitingForReply ? "waiting" : messages.last?.id
        if let target {
            withAnimation {
                proxy.scrollTo(target, anchor: .bottom)
            }
        }
    }

    private var divider: some View {
        Divider()
    }

    // MARK: - Composer

    private var composer: some View {
        VStack(spacing: 6) {
            if let errorMessage {
                Text(errorMessage)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if speech.isRecording {
                HStack {
                    Image(systemName: "waveform")
                        .foregroundStyle(.red)
                    Text(speech.recognizedText.isEmpty ? "Listening…" : speech.recognizedText)
                        .font(.callout)
                        .lineLimit(2)
                    Spacer()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 8) {
                TextField("Message your agent", text: $draftText, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isSending)
                Button {
                    toggleDictation()
                } label: {
                    Image(systemName: speech.isRecording ? "mic.fill" : "mic")
                        .foregroundStyle(speech.isRecording ? .red : .primary)
                }
                .accessibilityLabel(speech.isRecording ? "Stop dictation" : "Dictate a message")
                Button {
                    send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .disabled(isSending || draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send message")
            }
        }
        .padding()
    }

    // MARK: - Actions

    private func loadMessages() async {
        isLoading = true
        defer { isLoading = false }
        do {
            messages = try await appState.api.fetchMessages(chatId: chat.id)
            lastMessageCount = messages.count
            errorMessage = nil
        } catch let error as APIError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func send() {
        let text = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draftText = ""
        errorMessage = nil
        isSending = true
        Task {
            do {
                try await appState.api.sendMessage(chatId: chat.id, text: text)
                isSending = false
                isWaitingForReply = true
                await loadMessages()
            } catch let error as APIError {
                isSending = false
                errorMessage = error.localizedDescription
            } catch {
                isSending = false
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Polls every 5 s until a new assistant message arrives or 3 minutes
    /// pass. The .task(id:) modifier cancels this when isWaitingForReply
    /// turns false (view disappears, or a reply arrived).
    private func pollForReply() async {
        let deadline = Date(timeIntervalSinceNow: 180)
        while !Task.isCancelled, Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if Task.isCancelled { return }
            let before = messages.count
            await loadMessages()
            // A reply arrived when the list grew with an assistant message.
            if messages.count > before,
               messages.suffix(from: before).contains(where: { !$0.isFromUser }) {
                isWaitingForReply = false
                return
            }
            // The agent may also answer in an existing message slot; treat
            // any growth as progress and keep waiting for the newest
            // assistant message.
            if messages.count > lastMessageCount {
                lastMessageCount = messages.count
            }
        }
        // Still nothing after 3 minutes: stop polling, say so, and let the
        // user pull to refresh. The reply will appear when it arrives.
        isWaitingForReply = false
        errorMessage = "The agent is still working on this. New replies will appear here."
        lastMessageCount = messages.count
    }

    private func toggleDictation() {
        speech.toggleDictation { text in
            if let text, !text.isEmpty {
                draftText = text
            } else if let error = speech.dictationError {
                errorMessage = error
            }
        }
    }

    private func readAloud(_ message: ChatMessage) {
        if speakingMessageId == message.id {
            speech.stopSpeaking()
            speakingMessageId = nil
            return
        }
        speakingMessageId = message.id
        speech.speak(message.content)
    }
}

// MARK: - Message row

private struct MessageRow: View {
    let message: ChatMessage
    let isSpeaking: Bool
    let onReadAloud: () -> Void

    var body: some View {
        HStack {
            if message.isFromUser { Spacer(minLength: 48) }
            VStack(alignment: .leading, spacing: 4) {
                Text(message.content)
                    .font(.body)
                    .textSelection(.enabled)
                HStack(spacing: 8) {
                    Text(DisplayDate.relativeString(message.createdAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if !message.isFromUser {
                        Button {
                            onReadAloud()
                        } label: {
                            Image(systemName: isSpeaking ? "speaker.wave.3.fill" : "speaker.wave.2")
                                .font(.caption)
                        }
                        .accessibilityLabel(isSpeaking ? "Stop reading aloud" : "Read aloud")
                    }
                }
            }
            .padding(10)
            .background(message.isFromUser ? Color.blue.opacity(0.9) : Color(.secondarySystemBackground))
            .foregroundStyle(message.isFromUser ? .white : .primary)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            if !message.isFromUser { Spacer(minLength: 48) }
        }
    }
}
