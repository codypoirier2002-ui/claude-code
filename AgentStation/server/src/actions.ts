// External actions: anything that leaves the station (sending, publishing,
// buying, deleting, changing systems, connecting accounts).
//
// An action runs only when ALL of these hold:
//   1. a human approved it in the dashboard,
//   2. its task's report was approved and the task completed,
//   3. its kind has an installed executor (only webhook_post today), and
//   4. its destination is on the allowlist in config/station.json.
// Each action has a unique idempotency key and moves approved → executing →
// done with compare-and-set updates. An action found "executing" after a
// restart is never retried automatically: it may already have happened.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { nowIso, taskLabel, type DB } from './db.ts';
import type { StationConfig } from './config.ts';
import type { ExternalActionProposal } from './workflow.ts';
import { logEvent } from './events.ts';

export interface ActionRow {
  id: number;
  task_id: number;
  kind: string;
  target: string;
  payload_json: string;
  idempotency_key: string;
  status: string;
  result_json: string | null;
}

export function proposeActions(db: DB, taskId: number, proposals: ExternalActionProposal[]): void {
  for (const p of proposals) {
    const key = createHash('sha256').update(`${taskId}|${p.kind}|${p.target}`).digest('hex');
    const res = db
      .prepare(`INSERT OR IGNORE INTO actions (task_id, kind, target, payload_json, idempotency_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)`)
      .run(taskId, p.kind, p.target, JSON.stringify({ reason: p.reason }), key, nowIso(), nowIso());
    if (res.changes !== 1) continue;
    const actionId = Number(res.lastInsertRowid);
    db.prepare(`INSERT INTO approvals (task_id, kind, status, payload_json, created_at) VALUES (?, 'external_action', 'pending', ?, ?)`).run(
      taskId,
      JSON.stringify({ actionId, kind: p.kind, target: p.target, reason: p.reason }),
      nowIso(),
    );
    logEvent(db, {
      taskId,
      agent: 'commander',
      type: 'action_proposed',
      message: `External action held for approval: ${p.kind} → ${p.target}. Nothing is sent unless you approve it.`,
    });
  }
}

export function voidOpenActions(db: DB, taskId: number, reason: string): void {
  const open = db.prepare(`SELECT id FROM actions WHERE task_id=? AND status IN ('proposed','approved')`).all(taskId) as { id: number }[];
  for (const a of open) {
    db.prepare(`UPDATE actions SET status='rejected', result_json=?, updated_at=? WHERE id=? AND status IN ('proposed','approved')`).run(JSON.stringify({ reason }), nowIso(), a.id);
  }
  db.prepare(`UPDATE approvals SET status='void', decided_at=? WHERE task_id=? AND kind='external_action' AND status='pending'`).run(nowIso(), taskId);
}

// Retrying a failed task brings back the actions its failure voided (not the
// ones the operator rejected), each as a fresh pending approval.
export function reviveActionsAfterRetry(db: DB, taskId: number): number {
  const voided = db.prepare(`SELECT * FROM actions WHERE task_id=? AND status='rejected' AND json_extract(result_json,'$.reason')='task failed'`).all(taskId) as unknown as ActionRow[];
  for (const a of voided) {
    db.prepare(`UPDATE actions SET status='proposed', result_json=NULL, updated_at=? WHERE id=?`).run(nowIso(), a.id);
    const reason = JSON.parse(a.payload_json).reason ?? '';
    db.prepare(`INSERT INTO approvals (task_id, kind, status, payload_json, created_at) VALUES (?, 'external_action', 'pending', ?, ?)`).run(
      taskId, JSON.stringify({ actionId: a.id, kind: a.kind, target: a.target, reason }), nowIso(),
    );
    logEvent(db, { taskId, agent: 'commander', type: 'action_proposed', message: `External action held for approval again after retry: ${a.kind} → ${a.target}. Nothing is sent unless you approve it.` });
  }
  return voided.length;
}

export function recoverActions(db: DB): void {
  const stuck = db.prepare(`SELECT * FROM actions WHERE status='executing'`).all() as unknown as ActionRow[];
  for (const a of stuck) {
    db.prepare(`UPDATE actions SET status='needs_review', updated_at=? WHERE id=? AND status='executing'`).run(nowIso(), a.id);
    logEvent(db, {
      taskId: a.task_id,
      type: 'action_needs_review',
      message: `Action #${a.id} (${a.kind} → ${a.target}) was in progress when the station stopped. It will not be retried automatically because it may already have been sent. Check the destination, then mark it done or retry it.`,
    });
  }
}

// Operator resolution for an action left in needs_review.
export function resolveAction(db: DB, actionId: number, resolution: 'mark_done' | 'retry'): void {
  const res = db
    .prepare(`UPDATE actions SET status=?, updated_at=? WHERE id=? AND status='needs_review'`)
    .run(resolution === 'mark_done' ? 'done' : 'approved', nowIso(), actionId);
  if (res.changes !== 1) throw new Error(`Action #${actionId} is not waiting for review.`);
  const a = db.prepare('SELECT task_id FROM actions WHERE id=?').get(actionId) as { task_id: number };
  logEvent(db, { taskId: a.task_id, type: 'action_resolved', message: `Operator ${resolution === 'mark_done' ? 'marked action #' + actionId + ' as done' : 'chose to retry action #' + actionId}.` });
}

// A target matches an allowlist entry when it has the same origin and its path
// is the entry's path or lies below it on a "/" boundary, so "/notify" does not
// allow "/notify-other". Userinfo and encoded slashes are refused outright.
// The dashboard's copy (dashboard/src/panels/Approvals.tsx) must match.
export function allowedTarget(target: string, allowlist: string[]): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.username || url.password || /%2f|%5c/i.test(url.pathname)) return false;
  return allowlist.some((entry) => {
    try {
      const p = new URL(entry);
      const below = p.pathname.endsWith('/') ? p.pathname : `${p.pathname}/`;
      return url.origin === p.origin && (url.pathname === p.pathname || url.pathname.startsWith(below));
    } catch {
      return false;
    }
  });
}

async function perform(db: DB, cfg: StationConfig, a: ActionRow): Promise<unknown> {
  if (a.kind !== 'webhook_post') {
    throw new Error(`No integration is installed for "${a.kind}". Nothing was sent.`);
  }
  if (!allowedTarget(a.target, cfg.actions.webhookAllowlist)) {
    throw new Error(`Destination ${a.target} is not on actions.webhookAllowlist in config/station.json. Nothing was sent.`);
  }
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(a.task_id) as any;
  const report = task.output_path ? readFileSync(path.join(cfg.rootDir, task.output_path), 'utf8') : '';
  const res = await fetch(a.target, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', 'idempotency-key': a.idempotency_key, 'user-agent': cfg.sources.userAgent },
    body: JSON.stringify({ task: taskLabel(task.id), title: task.title, output_path: task.output_path, report }),
  });
  const text = (await res.text()).slice(0, 500);
  if (!res.ok) throw new Error(`destination answered HTTP ${res.status}: ${text}`);
  return { httpStatus: res.status, response: text };
}

export async function executeReadyActions(db: DB, cfg: StationConfig): Promise<void> {
  const ready = db
    .prepare(`SELECT a.* FROM actions a JOIN tasks t ON t.id = a.task_id WHERE a.status='approved' AND t.status='completed' ORDER BY a.id`)
    .all() as unknown as ActionRow[];
  for (const a of ready) {
    const claimed = db.prepare(`UPDATE actions SET status='executing', updated_at=? WHERE id=? AND status='approved'`).run(nowIso(), a.id);
    if (claimed.changes !== 1) continue;
    try {
      const result = await perform(db, cfg, a);
      db.prepare(`UPDATE actions SET status='done', result_json=?, updated_at=? WHERE id=? AND status='executing'`).run(JSON.stringify(result), nowIso(), a.id);
      logEvent(db, { taskId: a.task_id, agent: 'commander', type: 'action_executed', message: `Approved action #${a.id} ran: ${a.kind} → ${a.target}.` });
    } catch (err) {
      db.prepare(`UPDATE actions SET status='failed', result_json=?, updated_at=? WHERE id=? AND status='executing'`).run(JSON.stringify({ error: (err as Error).message }), nowIso(), a.id);
      logEvent(db, { taskId: a.task_id, agent: 'commander', type: 'action_failed', message: `Action #${a.id} (${a.kind}) failed: ${(err as Error).message}` });
    }
  }
}
