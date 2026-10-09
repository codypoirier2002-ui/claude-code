import { useState, type FormEvent } from 'react';
import type { SourceType, Task } from '../types.ts';
import { api } from '../api.ts';
import { Panel } from './ui.tsx';

const SOURCES: { id: SourceType; label: string }[] = [
  { id: 'wikipedia', label: 'Wikipedia' },
  { id: 'arxiv', label: 'arXiv' },
  { id: 'pypi', label: 'PyPI' },
  { id: 'github', label: 'GitHub READMEs' },
  { id: 'url', label: 'URLs I paste' },
];

export function TaskForm({ tasks, onCreated, onError, disabled }: { tasks: Task[]; onCreated: (id: number) => void; onError: (m: string) => void; disabled: boolean }) {
  const [description, setDescription] = useState('');
  const [project, setProject] = useState('');
  const [urls, setUrls] = useState('');
  const [sources, setSources] = useState<SourceType[]>(SOURCES.map((s) => s.id));
  const [dependsOn, setDependsOn] = useState('');
  const [busy, setBusy] = useState(false);
  // One key per form fill: a double click or a retried request cannot create two tasks.
  const [key, setKey] = useState(() => crypto.randomUUID());

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ task: { id: number }; created: boolean }>('/api/tasks', {
        description,
        project: project || null,
        urls: urls.split('\n').map((u) => u.trim()).filter(Boolean),
        sourceTypes: sources,
        dependsOn: dependsOn ? [Number(dependsOn)] : [],
        idempotencyKey: key,
      });
      setDescription('');
      setUrls('');
      setDependsOn('');
      setKey(crypto.randomUUID());
      onCreated(res.task.id);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const open = tasks.filter((t) => !['completed', 'failed', 'cancelled'].includes(t.status));
  return (
    <Panel title="New task" id="new-task">
      <form className="task-form" onSubmit={submit}>
        <label htmlFor="desc">What should the station research?</label>
        <textarea id="desc" rows={3} required minLength={10} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Research a topic from approved sources and produce a sourced report…" />
        <fieldset className="sources">
          <legend>Approved source types</legend>
          {SOURCES.map((s) => (
            <label key={s.id}>
              <input type="checkbox" checked={sources.includes(s.id)} onChange={(e) => setSources((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))} />
              {s.label}
            </label>
          ))}
        </fieldset>
        <div className="row2">
          <label className="stack">
            <span>Project (optional)</span>
            <input value={project} onChange={(e) => setProject(e.target.value)} maxLength={80} placeholder="Loads memory/projects/<name>.md" />
          </label>
          <label className="stack">
            <span>Start after (optional)</span>
            <select value={dependsOn} onChange={(e) => setDependsOn(e.target.value)}>
              <option value="">No dependency</option>
              {open.map((t) => <option key={t.id} value={t.id}>{t.label}: {t.title.slice(0, 40)}</option>)}
            </select>
          </label>
        </div>
        <label className="stack">
          <span>URLs to read (one per line, approved domains only)</span>
          <textarea rows={2} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://en.wikipedia.org/wiki/…" />
        </label>
        <button className="btn primary" type="submit" disabled={busy || disabled || description.trim().length < 10 || sources.length === 0}>
          {busy ? 'Queuing…' : 'Queue task'}
        </button>
      </form>
    </Panel>
  );
}
