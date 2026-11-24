import React, { useEffect, useState } from 'react';
import type { View } from '../App';
import type { ChatSummary, Project } from '../../../preload/preload.js';

interface Props {
  view: View;
  onNavigate: (v: View) => void;
  selectedChatId: string | null;
  selectedProjectId: string | null;
  onOpenChat: (chatId: string | null, projectId: string | null) => void;
}

export default function Sidebar({ view, onNavigate, selectedChatId, selectedProjectId, onOpenChat }: Props) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [newProjectName, setNewProjectName] = useState('');

  const refresh = () => {
    window.agent.chats.list().then(setChats).catch(() => undefined);
    window.agent.projects.list().then(setProjects).catch(() => undefined);
  };

  useEffect(refresh, []);

  const createChat = async (projectId: string | null) => {
    const chat = await window.agent.chats.create('New chat', projectId);
    refresh();
    onOpenChat(chat.id, projectId);
  };

  const createProject = async () => {
    const name = newProjectName.trim();
    if (!name) return;
    const folder = await window.agent.files.pickFolder();
    if (folder === null) return;
    await window.agent.projects.create(name, folder);
    setNewProjectName('');
    refresh();
  };

  const mainChats = chats.filter((c) => c.projectId === null && !c.archived);

  return (
    <div className="sidebar">
      <h1>OpenBuddy</h1>
      <button className="btn primary" onClick={() => createChat(null)}>+ New chat</button>
      <div className="section">Main chat</div>
      {mainChats.length === 0 && <div className="muted" style={{ padding: '0 10px' }}>No chats yet.</div>}
      {mainChats.map((c) => (
        <button
          key={c.id}
          className={`nav-item ${view === 'chat' && selectedChatId === c.id && selectedProjectId === null ? 'active' : ''}`}
          onClick={() => onOpenChat(c.id, null)}
        >
          <span className="dot" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
        </button>
      ))}
      <div className="section">Projects</div>
      {projects.map((p) => {
        const projectChats = chats.filter((c) => c.projectId === p.id && !c.archived);
        return (
          <div key={p.id}>
            <button
              className={`nav-item ${view === 'chat' && selectedProjectId === p.id ? 'active' : ''}`}
              onClick={() => {
                if (projectChats.length > 0) onOpenChat(projectChats[0].id, p.id);
                else createChat(p.id);
              }}
            >
              <span className="dot" style={{ background: '#2563eb' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            </button>
            {selectedProjectId === p.id && (
              <button className="nav-item" style={{ paddingLeft: 30 }} onClick={() => createChat(p.id)}>
                + New chat in project
              </button>
            )}
          </div>
        );
      })}
      <div className="row" style={{ padding: '4px 8px' }}>
        <input
          placeholder="New project name"
          value={newProjectName}
          onChange={(e) => setNewProjectName(e.target.value)}
          style={{ flex: 1, border: '1px solid #d4d4d8', borderRadius: 8, padding: '6px 8px' }}
        />
        <button className="btn" onClick={createProject}>Add</button>
      </div>
      <div className="section">Tools</div>
      <button className={`nav-item ${view === 'email' ? 'active' : ''}`} onClick={() => onNavigate('email')}>Email</button>
      <button className={`nav-item ${view === 'calendar' ? 'active' : ''}`} onClick={() => onNavigate('calendar')}>Calendar &amp; reminders</button>
      <button className={`nav-item ${view === 'tasks' ? 'active' : ''}`} onClick={() => onNavigate('tasks')}>Tasks &amp; watches</button>
      <button className={`nav-item ${view === 'memory' ? 'active' : ''}`} onClick={() => onNavigate('memory')}>Memory</button>
      <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => onNavigate('settings')}>Settings</button>
    </div>
  );
}
