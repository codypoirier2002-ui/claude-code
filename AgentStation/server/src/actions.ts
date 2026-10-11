// External actions: anything that leaves the station (sending, publishing,
// buying, deleting, changing systems, connecting accounts).
//
// An action runs only when ALL of these hold:
//   1. a human approved it in the dashboard,
//   2. its task's report was approved and the task completed,
//   3. its kind has an installed executor, and
//   4. its destination is allowed: for webhook_post, on the allowlist in
//      config/station.json; for slack_post, the Slack webhook that was set
//      when the operator approved the exact message text.
// Each action has a unique idempotency key and moves approved → executing →
// done with compare-and-set updates. An action that may have been delivered
// but was not confirmed (no answer, a server error, or "executing" found after
// a restart) goes to needs_review and is never retried automatically.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { nowIso, taskLabel, tx, type DB, type TaskRow } from './db.ts';
import type { StationConfig } from './config.ts';
import type { ExternalActionProposal } from './workflow.ts';
import { logEvent } from './events.ts';
import { slackWebhook, slackMessageForTask, webhookFingerprint } from './slack.ts';

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

// What the operator is shown when asked to approve an action. A Slack post
// carries its exact text once it has been written.
function approvalPayload(a: Pick<ActionRow, 'id' | 'kind' | 'target' | 'payload_json'>) {
  const p = JSON.parse(a.payload_json);
  return { actionId: a.id, kind: a.kind, target: a.target, reason: p.reason ?? '', ...(typeof p.text === 'string' ? { text: p.text } : {}) };
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
    const later = p.kind === 'slack_post' ? ' The message is written once the report is approved; you approve that exact text.' : '';
    logEvent(db, {
      taskId,
      agent: 'commander',
      type: 'action_proposed',
      message: `External action held for approval: ${p.kind} → ${p.target}. Nothing is sent unless you approve it.${later}`,
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
    db.prepare(`INSERT INTO approvals (task_id, kind, status, payload_json, created_at) VALUES (?, 'external_action', 'pending', ?, ?)`).run(
      taskId, JSON.stringify(approvalPayload(a)), nowIso(),
    );
    logEvent(db, { taskId, agent: 'commander', type: 'action_proposed', message: `External action held for approval again after retry: ${a.kind} → ${a.target}. Nothing is sent unless you approve it.` });
  }
  return voided.length;
}

export function recoverActions(db: DB): void {
  const stuck = db.prepare(`SELECT * FROM actions WHERE status='executing'`).all() as unknown as ActionRow[];
  for (const a of stuck) {
    db.prepare(`UPDATE actions SET status='needs_review', result_json=NULL, updated_at=? WHERE id=? AND status='executing'`).run(nowIso(), a.id);
    logEvent(db, {
      taskId: a.task_id,
      type: 'action_needs_review',
      message: `Action #${a.id} (${a.kind} → ${a.target}) was in progress when the station stopped. It will not be retried automatically because it may already have been sent. Check the destination, then mark it done or retry it.`,
    });
  }
}

// Operator resolution for an action left in needs_review.
export function resolveAction(db: DB, actionId: number, resolution: 'mark_done' | 'retry'): void {
  // The old "may have been sent" error no longer describes the action.
  const res = db
    .prepare(`UPDATE actions SET status=?, result_json=?, updated_at=? WHERE id=? AND status='needs_review'`)
    .run(resolution === 'mark_done' ? 'done' : 'approved', resolution === 'mark_done' ? JSON.stringify({ markedDoneBy: 'operator' }) : null, nowIso(), actionId);
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

// Thrown when the destination may have received the action but did not
// confirm it. Every other error means nothing was delivered.
class MaybeSent extends Error {}

// Connection failures that happen before any request bytes are sent.
const NOT_CONNECTED = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

const DELIVERY_TIMEOUT_MS = 20_000;

// POSTs JSON once, never following redirects. 2xx is delivered; 4xx
// (including 429) was refused, so nothing was delivered; 5xx and lost answers
// are MaybeSent. `secret` is removed from every error message.
async function postOnce(url: string, body: unknown, headers: Record<string, string>, secret?: string): Promise<{ httpStatus: number; response: string }> {
  const scrub = (m: string) => (secret ? m.split(secret).join('[webhook]') : m);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const code = e.cause?.code;
    if (code && NOT_CONNECTED.has(code)) throw new Error(scrub(`could not connect (${code}). Nothing was sent.`));
    throw new MaybeSent(scrub(`no answer (${e.name === 'TimeoutError' ? `timed out after ${DELIVERY_TIMEOUT_MS / 1000}s` : [e.message, code ?? e.cause?.message].filter(Boolean).join(': ')}).`));
  }
  const text = scrub(await res.text().then((t) => t.slice(0, 300), () => ''));
  if (res.ok) return { httpStatus: res.status, response: text };
  if (res.status >= 500) throw new MaybeSent(`the destination answered HTTP ${res.status}: ${text || res.statusText}`);
  throw new Error(`the destination refused it with HTTP ${res.status}: ${text || res.statusText}. Nothing was sent.`);
}

async function perform(db: DB, cfg: StationConfig, a: ActionRow): Promise<unknown> {
  if (a.kind === 'slack_post') {
    const p = JSON.parse(a.payload_json);
    const { url, status } = slackWebhook(cfg);
    if (!url) throw new Error(`Slack is not set up (${status.problem ?? `no SLACK_WEBHOOK_URL in ${status.setupFile}`}). Nothing was sent.`);
    if (typeof p.text !== 'string' || !p.text) throw new Error('There is no approved message text. Nothing was sent.');
    if (p.webhookFp !== webhookFingerprint(url)) throw new Error('The Slack webhook changed after this post was approved. Nothing was sent; post it again to approve the new destination.');
    const result = await postOnce(url, { text: p.text, unfurl_links: false, unfurl_media: false }, { 'user-agent': cfg.sources.userAgent }, url);
    return { ...result, posted: 'slack' };
  }
  if (a.kind !== 'webhook_post') {
    throw new Error(`No integration is installed for "${a.kind}". Nothing was sent.`);
  }
  if (!allowedTarget(a.target, cfg.actions.webhookAllowlist)) {
    throw new Error(`Destination ${a.target} is not on actions.webhookAllowlist in config/station.json. Nothing was sent.`);
  }
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(a.task_id) as any;
  const report = task.output_path ? readFileSync(path.join(cfg.rootDir, task.output_path), 'utf8') : '';
  return postOnce(
    a.target,
    { task: taskLabel(task.id), title: task.title, output_path: task.output_path, report },
    { 'idempotency-key': a.idempotency_key, 'user-agent': cfg.sources.userAgent },
  );
}

// Slack accepts about one message per second per webhook.
const SLACK_SPACING_MS = 1200;
let lastSlackPost = 0;

export async function executeReadyActions(db: DB, cfg: StationConfig): Promise<void> {
  const ready = db
    .prepare(`SELECT a.* FROM actions a JOIN tasks t ON t.id = a.task_id WHERE a.status='approved' AND t.status='completed' ORDER BY a.id`)
    .all() as unknown as ActionRow[];
  for (const a of ready) {
    if (a.kind === 'slack_post') {
      const wait = lastSlackPost + SLACK_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    const claimed = db.prepare(`UPDATE actions SET status='executing', updated_at=? WHERE id=? AND status='approved'`).run(nowIso(), a.id);
    if (claimed.changes !== 1) continue;
    try {
      const result = await perform(db, cfg, a);
      db.prepare(`UPDATE actions SET status='done', result_json=?, updated_at=? WHERE id=? AND status='executing'`).run(JSON.stringify(result), nowIso(), a.id);
      logEvent(db, { taskId: a.task_id, agent: 'commander', type: 'action_executed', message: `Approved action #${a.id} ran: ${a.kind} → ${a.target}.` });
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof MaybeSent) {
        db.prepare(`UPDATE actions SET status='needs_review', result_json=?, updated_at=? WHERE id=? AND status='executing'`).run(JSON.stringify({ error: msg, maybeSent: true }), nowIso(), a.id);
        logEvent(db, { taskId: a.task_id, agent: 'commander', type: 'action_needs_review', message: `Action #${a.id} (${a.kind} → ${a.target}) may have been sent: ${msg} It will not be retried automatically. Check the destination, then mark it done or retry it.` });
      } else {
        db.prepare(`UPDATE actions SET status='failed', result_json=?, updated_at=? WHERE id=? AND status='executing'`).run(JSON.stringify({ error: msg }), nowIso(), a.id);
        logEvent(db, { taskId: a.task_id, agent: 'commander', type: 'action_failed', message: `Action #${a.id} (${a.kind}) failed: ${msg}` });
      }
    } finally {
      if (a.kind === 'slack_post') lastSlackPost = Date.now();
    }
  }
}

// Operator path: "Post to Slack" on a completed task. Writes the message now
// and holds it as a pending approval; nothing is sent until that is approved.
export function prepareSlackPost(db: DB, cfg: StationConfig, taskId: number): number {
  const { url, status } = slackWebhook(cfg);
  if (!url) throw new Error(status.problem ?? `Slack is not set up. Add SLACK_WEBHOOK_URL to ${status.setupFile}.`);
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as unknown as TaskRow | undefined;
    if (!t) throw new Error(`No task ${taskLabel(taskId)}.`);
    const open = db
      .prepare(`SELECT id, status FROM actions WHERE task_id=? AND kind='slack_post' AND status IN ('proposed','approved','executing','needs_review','done') ORDER BY id DESC LIMIT 1`)
      .get(taskId) as { id: number; status: string } | undefined;
    if (open) {
      throw new Error(open.status === 'done' ? `${taskLabel(taskId)} was already posted to Slack (action #${open.id}).` : `${taskLabel(taskId)} already has a Slack post waiting (action #${open.id}, ${open.status.replace('_', ' ')}).`);
    }
    const text = slackMessageForTask(db, cfg, t);
    const { n } = db.prepare(`SELECT count(*) AS n FROM actions WHERE task_id=? AND kind='slack_post'`).get(taskId) as { n: number };
    const key = createHash('sha256').update(`${taskId}|slack_post|operator|${n}`).digest('hex');
    const reason = 'Operator asked to post the approved report to Slack.';
    const res = db
      .prepare(`INSERT INTO actions (task_id, kind, target, payload_json, idempotency_key, status, created_at, updated_at) VALUES (?, 'slack_post', 'slack', ?, ?, 'proposed', ?, ?)`)
      .run(taskId, JSON.stringify({ reason, text }), key, nowIso(), nowIso());
    const actionId = Number(res.lastInsertRowid);
    db.prepare(`INSERT INTO approvals (task_id, kind, status, payload_json, created_at) VALUES (?, 'external_action', 'pending', ?, ?)`).run(
      taskId, JSON.stringify({ actionId, kind: 'slack_post', target: 'slack', reason, text }), nowIso(),
    );
    logEvent(db, { taskId, type: 'action_proposed', message: `Slack post for ${taskLabel(taskId)} is ready for your approval. Nothing is sent unless you approve it.` });
    return actionId;
  });
}

// Commander path: a slack_post proposed at planning time gets its text when
// the report is approved and the task completes. Runs inside the completion
// transaction, so it never throws: the report is already published.
export function freezeSlackPosts(db: DB, cfg: StationConfig, taskId: number): void {
  const waiting = db.prepare(`SELECT * FROM actions WHERE task_id=? AND kind='slack_post' AND status='proposed'`).all(taskId) as unknown as ActionRow[];
  if (!waiting.length) return;
  try {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as unknown as TaskRow;
    const text = slackMessageForTask(db, cfg, t);
    for (const a of waiting) {
      db.prepare(`UPDATE actions SET payload_json=json_set(payload_json,'$.text',?), updated_at=? WHERE id=? AND status='proposed'`).run(text, nowIso(), a.id);
      db.prepare(`UPDATE approvals SET payload_json=json_set(payload_json,'$.text',?) WHERE kind='external_action' AND status='pending' AND json_extract(payload_json,'$.actionId')=?`).run(text, a.id);
    }
    logEvent(db, { taskId, agent: 'commander', type: 'action_ready', message: `The Slack message for ${taskLabel(taskId)} is written. Read it under Approvals; nothing is sent unless you approve it.` });
  } catch (err) {
    logEvent(db, { taskId, type: 'action_error', message: `Could not write the Slack message for ${taskLabel(taskId)}: ${(err as Error).message}. Reject the held post and use "Post to Slack" on the task instead.` });
  }
}

// Checks run when the operator approves a slack_post, inside the approval
// transaction: the text they saw must be the text that will be sent, and the
// approval is bound to the webhook set at that moment.
export function approveSlackPost(db: DB, cfg: StationConfig, actionId: number, shownText: unknown): void {
  const a = db.prepare('SELECT * FROM actions WHERE id=?').get(actionId) as unknown as ActionRow | undefined;
  if (!a || a.status !== 'proposed') throw new Error(`Action #${actionId} is not waiting for approval.`);
  const text = JSON.parse(a.payload_json).text;
  if (typeof text !== 'string' || !text) throw new Error('The Slack message is written when the report is approved. Approve this post after that.');
  if (text !== shownText) throw new Error('The Slack message changed. Reload and read it again.');
  const { url, status } = slackWebhook(cfg);
  if (!url) throw new Error(`Slack is not set up: ${status.problem ?? `add SLACK_WEBHOOK_URL to ${status.setupFile}`}.`);
  db.prepare(`UPDATE actions SET payload_json=json_set(payload_json,'$.webhookFp',?) WHERE id=?`).run(webhookFingerprint(url), actionId);
}
