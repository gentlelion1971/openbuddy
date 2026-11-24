import React, { useEffect, useState } from 'react';
import type { EmailAccount, TaskItem } from '../../../preload/preload.js';

interface Watch {
  id: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  active: number;
  lastRunAt: string | null;
}

export default function TasksView() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [title, setTitle] = useState('');
  const [watchName, setWatchName] = useState('');
  const [watchKind, setWatchKind] = useState('email');
  const [watchAccountId, setWatchAccountId] = useState('');
  const [watchFrom, setWatchFrom] = useState('');
  const [watchKeyword, setWatchKeyword] = useState('');
  const [watchInterval, setWatchInterval] = useState('60');
  const [watchUrl, setWatchUrl] = useState('');

  const load = () => {
    window.agent.tasks.list().then(setTasks).catch(() => undefined);
    window.agent.watches.list().then((w) => setWatches(w as Watch[])).catch(() => undefined);
    window.agent.email.accounts().then((a) => {
      setAccounts(a as EmailAccount[]);
      if (a.length > 0 && !watchAccountId) setWatchAccountId(a[0].id);
    }).catch(() => undefined);
  };

  useEffect(load, []);

  const addTask = async () => {
    if (!title.trim()) return;
    await window.agent.tasks.create(title, null, null);
    setTitle('');
    load();
  };

  const addWatch = async () => {
    const intervalMinutes = Number(watchInterval) || 60;
    const config: Record<string, unknown> =
      watchKind === 'email'
        ? { accountId: watchAccountId, from: watchFrom.trim(), keyword: watchKeyword.trim(), intervalMinutes }
        : { url: watchUrl.trim(), keyword: watchKeyword.trim(), intervalMinutes };
    await window.agent.watches.create(watchName || 'Watch', watchKind, config);
    setWatchName('');
    setWatchFrom('');
    setWatchKeyword('');
    setWatchUrl('');
    load();
  };

  return (
    <div className="view">
      <h2>Tasks &amp; watches</h2>
      <h3>To-dos</h3>
      {tasks.length === 0 ? <p className="muted">No tasks yet.</p> : (
        <table>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td><input type="checkbox" checked={t.status === 'done'} onChange={async () => { await window.agent.tasks.setStatus(t.id, t.status === 'done' ? 'open' : 'done'); load(); }} /></td>
                <td style={t.status === 'done' ? { textDecoration: 'line-through', color: '#71717a' } : undefined}>{t.title}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row" style={{ marginBottom: 20 }}>
        <input style={{ flex: 1 }} placeholder="New task…" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTask()} />
        <button className="btn primary" onClick={addTask}>Add task</button>
      </div>
      <h3>Recurring watches</h3>
      <p className="muted">Watches run in the background (for example, check an inbox every hour for a reply) and notify you when something arrives.</p>
      {watches.length === 0 ? <p className="muted">No watches configured.</p> : (
        <table>
          <thead><tr><th>Name</th><th>Kind</th><th>Active</th><th>Last run</th><th /></tr></thead>
          <tbody>
            {watches.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td><td>{w.kind}</td>
                <td><input type="checkbox" checked={w.active === 1} onChange={async () => { await window.agent.watches.setActive(w.id, w.active !== 1); load(); }} /></td>
                <td>{w.lastRunAt ? new Date(w.lastRunAt).toLocaleString() : '—'}</td>
                <td><button className="btn danger" onClick={async () => { await window.agent.watches.remove(w.id); load(); }}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="card">
        <h3>Add a watch</h3>
        <div className="field"><label>Name</label><input value={watchName} onChange={(e) => setWatchName(e.target.value)} placeholder="e.g. Watch inbox for Kat's reply" /></div>
        <div className="field"><label>Kind</label>
          <select value={watchKind} onChange={(e) => setWatchKind(e.target.value)}>
            <option value="email">Email inbox check</option>
            <option value="web">Web page check</option>
          </select>
        </div>
        {watchKind === 'email' ? (
          <>
            <div className="field"><label>Account</label>
              <select value={watchAccountId} onChange={(e) => setWatchAccountId(e.target.value)}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.username})</option>)}
              </select>
            </div>
            <div className="field"><label>From (sender filter, optional)</label><input value={watchFrom} onChange={(e) => setWatchFrom(e.target.value)} placeholder="e.g. ksorokko@legacyyte.org" /></div>
            <div className="field"><label>Keyword (optional)</label><input value={watchKeyword} onChange={(e) => setWatchKeyword(e.target.value)} placeholder="e.g. invoice" /></div>
          </>
        ) : (
          <>
            <div className="field"><label>Page URL</label><input value={watchUrl} onChange={(e) => setWatchUrl(e.target.value)} placeholder="https://…" /></div>
            <div className="field"><label>Keyword to watch for</label><input value={watchKeyword} onChange={(e) => setWatchKeyword(e.target.value)} placeholder="e.g. in stock" /></div>
          </>
        )}
        <div className="field"><label>Check every (minutes)</label><input value={watchInterval} onChange={(e) => setWatchInterval(e.target.value)} /></div>
        <p className="muted">When a match arrives you get a desktop notification and a phone-app alert. SMS alerts are not built in — carrier email-to-SMS or Twilio would be needed for that.</p>
        <button className="btn primary" onClick={addWatch}>Add watch</button>
      </div>
    </div>
  );
}
