import React, { useEffect, useState } from 'react';

interface CalEvent {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  location: string;
  notes: string;
}

interface Reminder {
  id: string;
  title: string;
  remindAt: string;
  done: number;
}

export default function CalendarView() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reminderTitle, setReminderTitle] = useState('');
  const [reminderAt, setReminderAt] = useState('');

  const load = () => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14).toISOString();
    window.agent.calendar.events(from, to).then((e) => setEvents(e as CalEvent[])).catch(() => undefined);
    window.agent.calendar.reminders().then((r) => setReminders(r as Reminder[])).catch(() => undefined);
  };

  useEffect(load, []);

  const addEvent = async () => {
    if (!title || !start || !end) return;
    await window.agent.calendar.add({ title, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), location: '', notes: '', source: 'local' });
    setTitle(''); setStart(''); setEnd('');
    load();
  };

  const addReminder = async () => {
    if (!reminderTitle || !reminderAt) return;
    await window.agent.calendar.addReminder(reminderTitle, new Date(reminderAt).toISOString());
    setReminderTitle(''); setReminderAt('');
    load();
  };

  return (
    <div className="view">
      <h2>Calendar &amp; reminders</h2>
      <h3>Next 14 days</h3>
      {events.length === 0 ? <p className="muted">No events scheduled.</p> : (
        <table>
          <thead><tr><th>When</th><th>Event</th><th>Location</th><th /></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.startAt).toLocaleString()}</td>
                <td>{e.title}</td>
                <td>{e.location}</td>
                <td><button className="btn danger" onClick={async () => { await window.agent.calendar.remove(e.id); load(); }}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="card">
        <h3>Add event</h3>
        <div className="field"><label>Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}><label>Start</label><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></div>
          <div className="field" style={{ flex: 1 }}><label>End</label><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
        </div>
        <button className="btn primary" onClick={addEvent}>Add event</button>
      </div>
      <h3>Reminders</h3>
      {reminders.length === 0 ? <p className="muted">No open reminders.</p> : (
        <table>
          <tbody>
            {reminders.map((r) => (
              <tr key={r.id}>
                <td>{r.title}</td>
                <td>{new Date(r.remindAt).toLocaleString()}</td>
                <td><button className="btn" onClick={async () => { await window.agent.calendar.completeReminder(r.id); load(); }}>Done</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="card">
        <h3>Add reminder</h3>
        <div className="field"><label>Title</label><input value={reminderTitle} onChange={(e) => setReminderTitle(e.target.value)} /></div>
        <div className="field"><label>Remind at</label><input type="datetime-local" value={reminderAt} onChange={(e) => setReminderAt(e.target.value)} /></div>
        <button className="btn primary" onClick={addReminder}>Add reminder</button>
      </div>
    </div>
  );
}
