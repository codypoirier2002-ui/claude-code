// Activity history (persisted) plus an in-process change signal for the
// dashboard's live stream.
import { EventEmitter } from 'node:events';
import { nowIso, type DB } from './db.ts';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function logEvent(db: DB, e: { taskId?: number | null; agent?: string | null; type: string; message: string; data?: unknown }): void {
  db.prepare('INSERT INTO events (ts, task_id, agent, type, message, data_json) VALUES (?, ?, ?, ?, ?, ?)').run(
    nowIso(),
    e.taskId ?? null,
    e.agent ?? null,
    e.type,
    e.message.slice(0, 1000),
    e.data === undefined ? null : JSON.stringify(e.data),
  );
  changed();
}

let pending: NodeJS.Timeout | null = null;
// Coalesce bursts of writes into one "state changed" signal.
export function changed(): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    bus.emit('changed');
  }, 100);
}
