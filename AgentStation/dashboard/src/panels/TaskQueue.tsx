import { useState } from 'react';
import type { Task } from '../types.ts';
import { api } from '../api.ts';
import { Chip, Panel, fmtAgo, fmtNum } from './ui.tsx';

export function TaskQueue({ tasks, selected, onSelect, onError, disabled }: { tasks: Task[]; selected: number | null; onSelect: (id: number) => void; onError: (m: string) => void; disabled: boolean }) {
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const shown = filter === 'all' ? tasks : tasks.filter((t) => !['completed', 'cancelled'].includes(t.status));
  const act = async (t: Task, what: 'cancel' | 'retry') => {
    if (what === 'cancel' && !window.confirm(`Cancel ${t.label}? Running agent work is stopped.`)) return;
    try {
      await api.post(`/api/tasks/${t.id}/${what}`);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <Panel
      title="Task queue"
      id="queue"
      actions={
        <div className="seg" role="group" aria-label="Filter tasks">
          <button className={filter === 'active' ? 'on' : ''} onClick={() => setFilter('active')}>Open</button>
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
        </div>
      }
    >
      {shown.length === 0 && <p className="muted">{filter === 'active' ? 'No open tasks.' : 'No tasks yet.'}</p>}
      <ul className="task-list">
        {shown.map((t) => (
          <li key={t.id} className={selected === t.id ? 'selected' : ''}>
            <button className="task-main" onClick={() => onSelect(t.id)} aria-pressed={selected === t.id}>
              <span className="mono">{t.label}</span>
              <span className="task-title">{t.title}</span>
              <Chip status={t.status} />
            </button>
            <div className="task-meta">
              <span>{t.stage ?? '–'} · {t.assignedAgent ?? '–'}</span>
              <span>{fmtNum(t.tokensTotal)} tok</span>
              {t.dependsOn.length > 0 && <span>after T-{String(t.dependsOn[0]).padStart(4, '0')}</span>}
              <span>{fmtAgo(t.updatedAt)}</span>
              {!['completed', 'failed', 'cancelled'].includes(t.status) && (
                <button className="btn tiny danger" disabled={disabled} onClick={() => act(t, 'cancel')}>Cancel</button>
              )}
              {t.status === 'failed' && (
                <button className="btn tiny" disabled={disabled} onClick={() => act(t, 'retry')}>Retry</button>
              )}
            </div>
            {t.status === 'failed' && t.error && <p className="error small">{t.error}</p>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
