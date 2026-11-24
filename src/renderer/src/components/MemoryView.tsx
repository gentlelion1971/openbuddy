import React, { useEffect, useState } from 'react';
import type { Memory, Project } from '../../../preload/preload.js';

export default function MemoryView() {
  const [globalMemories, setGlobalMemories] = useState<Memory[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectMemories, setProjectMemories] = useState<Memory[]>([]);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [scope, setScope] = useState<'global' | 'project'>('global');

  const load = () => {
    window.agent.memories.list('global').then(setGlobalMemories).catch(() => undefined);
    window.agent.projects.list().then((p) => {
      setProjects(p);
      if (p.length > 0 && !projectId) setProjectId(p[0].id);
    }).catch(() => undefined);
  };

  useEffect(load, []);

  useEffect(() => {
    if (!projectId) return;
    window.agent.memories.list('project', projectId).then(setProjectMemories).catch(() => undefined);
  }, [projectId]);

  const add = async () => {
    if (!key.trim() || !value.trim()) return;
    await window.agent.memories.set(scope, scope === 'project' ? projectId : null, key, value);
    setKey(''); setValue('');
    load();
    if (scope === 'project' && projectId) {
      window.agent.memories.list('project', projectId).then(setProjectMemories).catch(() => undefined);
    }
  };

  const remove = async (id: string, s: 'global' | 'project') => {
    await window.agent.memories.remove(id);
    load();
    if (s === 'project' && projectId) {
      window.agent.memories.list('project', projectId).then(setProjectMemories).catch(() => undefined);
    }
  };

  const table = (items: Memory[], s: 'global' | 'project') => (
    <table>
      <thead><tr><th>Key</th><th>Value</th><th /></tr></thead>
      <tbody>
        {items.map((m) => (
          <tr key={m.id}><td>{m.key}</td><td>{m.value}</td>
            <td><button className="btn danger" onClick={() => remove(m.id, s)}>Delete</button></td></tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="view">
      <h2>Memory</h2>
      <p className="muted">Long-term facts the agent remembers and uses in every chat. Edit or delete anything here.</p>
      <h3>Global memory</h3>
      {globalMemories.length === 0 ? <p className="muted">Nothing stored yet.</p> : table(globalMemories, 'global')}
      <h3>Project memory</h3>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {projectMemories.length === 0 ? <p className="muted">No memories for this project yet.</p> : table(projectMemories, 'project')}
      <div className="card">
        <h3>Add a memory</h3>
        <div className="field"><label>Scope</label>
          <select value={scope} onChange={(e) => setScope(e.target.value as 'global' | 'project')}>
            <option value="global">Global (all chats)</option>
            <option value="project">This project only</option>
          </select>
        </div>
        <div className="field"><label>Key</label><input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. Home address" /></div>
        <div className="field"><label>Value</label><input value={value} onChange={(e) => setValue(e.target.value)} /></div>
        <button className="btn primary" onClick={add}>Save memory</button>
      </div>
    </div>
  );
}
