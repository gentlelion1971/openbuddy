import React, { useEffect, useState } from 'react';
import type { EmailAccount, EmailSummary } from '../../../preload/preload.js';

// Direct IMAP presets. The app connects straight to each provider — no
// middleman service. Gmail and Yahoo need an app password (2-step
// verification on); Hotmail/Outlook uses the normal password.
const PROVIDERS: Record<string, { host: string; port: string; hint: string }> = {
  outlook: { host: 'outlook.office365.com', port: '993', hint: 'Hotmail / Outlook: use your normal password.' },
  gmail: { host: 'imap.gmail.com', port: '993', hint: 'Gmail: turn on 2-step verification first, then use an app password (Google Account → Security → App passwords).' },
  yahoo: { host: 'imap.mail.yahoo.com', port: '993', hint: 'Yahoo: turn on 2-step verification first, then use an app password (Account Security → Generate app password).' },
  custom: { host: '', port: '993', hint: 'Enter your provider’s IMAP host and port.' },
};

export default function EmailView() {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [messages, setMessages] = useState<EmailSummary[]>([]);
  const [query, setQuery] = useState('');
  const [reading, setReading] = useState<{ subject: string; from: string; date: string; body: string } | null>(null);
  const [digest, setDigest] = useState('');
  const [composing, setComposing] = useState(false);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [provider, setProvider] = useState('outlook');
  const [host, setHost] = useState('outlook.office365.com');
  const [port, setPort] = useState('993');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const loadAccounts = () => window.agent.email.accounts().then((a) => {
    setAccounts(a);
    if (a.length > 0 && !accountId) setAccountId(a[0].id);
  }).catch(() => undefined);

  useEffect(() => { void loadAccounts(); }, []);

  useEffect(() => {
    if (!accountId) return;
    window.agent.email.inbox(accountId).then(setMessages).catch(() => setMessages([]));
  }, [accountId]);

  const search = async () => {
    if (!accountId || !query.trim()) return;
    setMessages(await window.agent.email.search(accountId, query));
  };

  const read = async (uid: number) => {
    const m = (await window.agent.email.read(accountId, uid)) as { subject: string; from: string; date: string; body: string };
    setReading(m);
  };

  const send = async () => {
    if (!window.confirm(`Send this email to ${to}?`)) return;
    await window.agent.email.send(accountId, { to, subject, body });
    setComposing(false);
    setTo(''); setSubject(''); setBody('');
  };

  const pickProvider = (p: string) => {
    setProvider(p);
    const preset = PROVIDERS[p];
    if (preset) {
      setHost(preset.host);
      setPort(preset.port);
    }
  };

  const addAccount = async () => {
    await window.agent.email.addAccount(
      { label, kind: 'imap', host, port: Number(port), secure: 1, username },
      password,
    );
    setAdding(false);
    setLabel(''); setUsername(''); setPassword('');
    loadAccounts();
  };

  return (
    <div className="view">
      <h2>Email</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.username})</option>)}
        </select>
        <button className="btn" onClick={() => setAdding(!adding)}>Add account</button>
        <button className="btn" onClick={() => setComposing(!composing)}>Compose</button>
        <button className="btn" onClick={async () => accountId && setDigest(await window.agent.email.digest(accountId))}>
          Morning digest
        </button>
      </div>
      {adding && (
        <div className="card">
          <h3>Add an email account (IMAP)</h3>
          <div className="field"><label>Label</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Hotmail" /></div>
          <div className="field"><label>Provider</label>
            <select value={provider} onChange={(e) => pickProvider(e.target.value)}>
              <option value="outlook">Outlook / Hotmail</option>
              <option value="gmail">Gmail</option>
              <option value="yahoo">Yahoo Mail</option>
              <option value="custom">Other (custom IMAP)</option>
            </select>
          </div>
          <div className="field"><label>IMAP host</label><input value={host} onChange={(e) => setHost(e.target.value)} /></div>
          <div className="field"><label>Port</label><input value={port} onChange={(e) => setPort(e.target.value)} /></div>
          <div className="field"><label>Username (email address)</label><input value={username} onChange={(e) => setUsername(e.target.value)} /></div>
          <div className="field"><label>Password / app password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <p className="muted">{PROVIDERS[provider]?.hint} The password is stored encrypted with Windows Credential Manager (DPAPI), never in a plain file.</p>
          <button className="btn primary" onClick={addAccount}>Save account</button>
        </div>
      )}
      {composing && (
        <div className="card">
          <h3>Compose (sending asks for confirmation)</h3>
          <div className="field"><label>To</label><input value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="field"><label>Subject</label><input value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
          <div className="field"><label>Body</label><textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} /></div>
          <button className="btn primary" onClick={send}>Review &amp; send</button>
        </div>
      )}
      {digest && <div className="card"><h3>Digest</h3><div style={{ whiteSpace: 'pre-wrap' }}>{digest}</div></div>}
      <div className="row" style={{ marginBottom: 12 }}>
        <input style={{ flex: 1 }} placeholder="Search inbox…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <button className="btn" onClick={search}>Search</button>
      </div>
      {messages.length === 0 ? <div className="empty">No messages. Connect an account above.</div> : (
        <table>
          <thead><tr><th>From</th><th>Subject</th><th>Date</th></tr></thead>
          <tbody>
            {messages.map((m) => (
              <tr key={m.uid} onClick={() => read(m.uid)} style={{ cursor: 'pointer' }}>
                <td>{m.from}</td><td>{m.subject}</td><td>{new Date(m.date).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {reading && (
        <div className="modal-backdrop" onClick={() => setReading(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{reading.subject}</h3>
            <p className="muted">{reading.from} — {new Date(reading.date).toLocaleString()}</p>
            <div style={{ whiteSpace: 'pre-wrap' }}>{reading.body}</div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn" onClick={() => setReading(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
