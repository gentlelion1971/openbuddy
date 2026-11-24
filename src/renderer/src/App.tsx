import React, { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import SetupWizard from './components/SetupWizard';
import EmailView from './components/EmailView';
import CalendarView from './components/CalendarView';
import TasksView from './components/TasksView';
import MemoryView from './components/MemoryView';
import SettingsView from './components/SettingsView';
import type { ConfirmRequest } from '../../preload/preload.js';

export type View = 'chat' | 'email' | 'calendar' | 'tasks' | 'memory' | 'settings';

export default function App() {
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const [view, setView] = useState<View>('chat');
  const [chatId, setChatId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    window.agent.setup.getStatus().then((s) => {
      const status = s as { setupComplete?: boolean };
      setSetupDone(Boolean(status.setupComplete));
    }).catch(() => setSetupDone(false));
    const offConfirm = window.agent.agent.onConfirm((req) => setConfirmReq(req));
    const offNotify = window.agent.agent.onNotify((title, body) => {
      setToast(`${title}: ${body}`);
      window.setTimeout(() => setToast(null), 6000);
    });
    return () => { offConfirm(); offNotify(); };
  }, []);

  if (setupDone === null) return <div className="empty">Loading…</div>;
  if (!setupDone) return <SetupWizard onDone={() => setSetupDone(true)} />;

  const openChat = (id: string | null, pid: string | null) => {
    setChatId(id);
    setProjectId(pid);
    setView('chat');
  };

  return (
    <div className="app">
      <Sidebar
        view={view}
        onNavigate={(v) => setView(v)}
        selectedChatId={chatId}
        selectedProjectId={projectId}
        onOpenChat={openChat}
      />
      <div className="main">
        {view === 'chat' && <ChatView chatId={chatId} projectId={projectId} onChatCreated={openChat} />}
        {view === 'email' && <EmailView />}
        {view === 'calendar' && <CalendarView />}
        {view === 'tasks' && <TasksView />}
        {view === 'memory' && <MemoryView />}
        {view === 'settings' && <SettingsView />}
      </div>
      {confirmReq && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Confirmation required</h3>
            <p>{confirmReq.summary}</p>
            <pre>{JSON.stringify(confirmReq.details, null, 2)}</pre>
            <p className="muted">The agent will only proceed if you approve.</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => { window.agent.agent.confirm(confirmReq.id, false); setConfirmReq(null); }}>
                Deny
              </button>
              <button className="btn primary" onClick={() => { window.agent.agent.confirm(confirmReq.id, true); setConfirmReq(null); }}>
                Approve
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
