import { useState } from 'react';
import type { StationEvent } from '../types.ts';
import { Panel, fmtTime } from './ui.tsx';

const TONE: Record<string, string> = {
  task_failed: 'bad', step_failed: 'bad', action_failed: 'bad', gateway_disconnected: 'bad', engine_error: 'bad',
  limit_blocked: 'warn', gateway_blocked: 'warn', approval_requested: 'warn', action_proposed: 'warn', step_retry: 'warn', action_needs_review: 'warn', queue_paused: 'warn',
  task_completed: 'good', report_approved: 'good', action_executed: 'good', gateway_connected: 'good',
};

export function Activity({ events, selected }: { events: StationEvent[]; selected: number | null }) {
  const [onlySelected, setOnlySelected] = useState(false);
  const shown = onlySelected && selected !== null ? events.filter((e) => e.taskId === selected) : events;
  return (
    <Panel
      title="Activity history"
      id="activity"
      actions={
        <label className="small">
          <input type="checkbox" checked={onlySelected} disabled={selected === null} onChange={(e) => setOnlySelected(e.target.checked)} /> Selected task only
        </label>
      }
    >
      <ol className="events" aria-live="polite">
        {shown.slice(0, 120).map((e) => (
          <li key={e.id} className={`event tone-${TONE[e.type] ?? 'info'}`}>
            <time dateTime={e.ts}>{fmtTime(e.ts)}</time>
            {e.taskLabel && <span className="mono tag">{e.taskLabel}</span>}
            {e.agent && <span className={`tag agent-${e.agent}`}>{e.agent}</span>}
            <span className="msg">{e.message}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
