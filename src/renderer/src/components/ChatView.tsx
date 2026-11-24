import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../../preload/preload.js';

interface Props {
  chatId: string | null;
  projectId: string | null;
  onChatCreated: (chatId: string, projectId: string | null) => void;
}

export default function ChatView({ chatId, projectId, onChatCreated }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [streaming, setStreaming] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    if (!chatId) { setMessages([]); setStreaming(''); return; }
    window.agent.chats.messages(chatId).then(setMessages).catch(() => undefined);
  }, [chatId]);

  useEffect(() => {
    const offToken = window.agent.agent.onToken((id, token) => {
      if (id === chatId) setStreaming((s) => s + token);
    });
    const offDone = window.agent.agent.onDone((id) => {
      if (id === chatId) {
        setBusy(false);
        setStreaming('');
        window.agent.chats.messages(id).then(setMessages).catch(() => undefined);
      }
    });
    const offError = window.agent.agent.onError((id, error) => {
      if (id === chatId) {
        setBusy(false);
        setStreaming('');
        setMessages((m) => [...m, { id: `err-${Date.now()}`, chatId: id, role: 'assistant', content: `Error: ${error}`, createdAt: new Date().toISOString() }]);
      }
    });
    return () => { offToken(); offDone(); offError(); };
  }, [chatId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streaming]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    let id = chatId;
    if (!id) {
      const chat = await window.agent.chats.create(trimmed.slice(0, 48), projectId);
      id = chat.id;
      onChatCreated(id, projectId);
    }
    setMessages((m) => [...m, { id: `u-${Date.now()}`, chatId: id!, role: 'user', content: trimmed, createdAt: new Date().toISOString() }]);
    setInput('');
    setBusy(true);
    setStreaming('');
    await window.agent.chats.send(id, trimmed);
  };

  const toggleRecording = async () => {
    if (recording) {
      mediaRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const base64 = await blobToBase64(blob);
        const audioPath = await window.agent.voice.saveRecording(base64, blob.type);
        const text = await window.agent.voice.transcribe(audioPath);
        if (text.trim()) setInput((cur) => (cur ? `${cur} ${text}` : text));
      };
      mediaRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      // Microphone unavailable; typed input still works.
    }
  };

  const speak = async (text: string) => {
    try {
      const dataUrl = await window.agent.voice.speak(text);
      const audio = new Audio(dataUrl);
      await audio.play();
    } catch {
      // Voice unavailable; ignore.
    }
  };

  return (
    <>
      <div className="chat-header">
        <h2>{messages.length > 0 ? 'Chat' : 'OpenBuddy'}</h2>
        <span className="sub">Runs fully offline on this machine (Ollama).</span>
      </div>
      <div className="messages" ref={listRef}>
        {messages.length === 0 && !streaming && (
          <div className="empty">
            Ask anything, or tell the agent to do something: check email, add a reminder,
            look something up, or draft a reply. Outward actions always ask for approval first.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role === 'user' ? 'user' : 'assistant'}`}>
            <div className="role">{m.role === 'user' ? 'You' : 'OpenBuddy'}</div>
            {m.content}
            {m.role === 'assistant' && (
              <div className="actions">
                <button className="btn" onClick={() => speak(m.content)}>Read aloud</button>
              </div>
            )}
          </div>
        ))}
        {streaming && (
          <div className="msg assistant">
            <div className="role">OpenBuddy</div>
            {streaming}
          </div>
        )}
      </div>
      <div className="composer">
        <button className="btn" onClick={toggleRecording} disabled={busy}>
          {recording ? 'Stop recording' : 'Voice input'}
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
          }}
          placeholder="Type a message, or use voice input…"
        />
        <button className="btn primary" onClick={() => send(input)} disabled={busy || !input.trim()}>
          Send
        </button>
      </div>
    </>
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
