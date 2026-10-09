// Builds the dashboard snapshot. Agent animation states are derived only from
// facts in the database and the live gateway check, never guessed.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getSetting, taskLabel, type DB, type TaskRow, type StepRow } from './db.ts';
import { AGENT_ROLES, type StationConfig, type AgentRole } from './config.ts';
import type { Health } from './openclaw.ts';
import type { Engine } from './engine.ts';
import { usageSummary } from './usage.ts';

export type AgentVisualState = 'offline' | 'idle' | 'running' | 'awaiting_approval' | 'failed' | 'complete' | 'standby';

const COMPLETE_SHOW_MS = 60_000;
const FAILED_SHOW_MS = 30 * 60_000;

function taskOut(t: TaskRow) {
  return {
    id: t.id,
    label: taskLabel(t.id),
    title: t.title,
    description: t.description,
    status: t.status,
    stage: t.stage,
    assignedAgent: t.assigned_agent,
    dependsOn: JSON.parse(t.depends_on_json) as number[],
    project: t.project,
    outputPath: t.output_path,
    approvalRequired: t.approval_required === 1,
    error: t.error,
    errorDetail: t.error_detail,
    revisions: t.revisions,
    tokensTotal: t.tokens_total,
    costUsd: t.cost_usd,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    completedAt: t.completed_at,
  };
}

function agentStates(db: DB, cfg: StationConfig, health: Health, teamMode: string) {
  const now = Date.now();
  return AGENT_ROLES.map((role: AgentRole) => {
    const base = { role, name: role[0].toUpperCase() + role.slice(1), room: cfg.agents[role].room, openclawAgentId: cfg.agents[role].openclawAgentId };
    const running = db.prepare(`SELECT * FROM steps WHERE agent=? AND status='running' ORDER BY started_at LIMIT 1`).get(role) as unknown as StepRow | undefined;
    const last = db.prepare(`SELECT * FROM steps WHERE agent=? AND status IN ('completed','failed') ORDER BY finished_at DESC LIMIT 1`).get(role) as unknown as StepRow | undefined;
    let state: AgentVisualState = 'idle';
    let detail = 'Idle';
    let taskId: number | null = null;
    if (!health.connected) {
      state = 'offline';
      detail = 'Backend disconnected';
    } else if (running) {
      state = 'running';
      taskId = running.task_id;
      detail = `${running.stage} for ${taskLabel(running.task_id)} (${running.executor === 'station' ? 'station tool' : 'OpenClaw agent'})`;
    } else if (role === 'commander' && db.prepare(`SELECT 1 FROM approvals WHERE status='pending'`).get()) {
      state = 'awaiting_approval';
      const a = db.prepare(`SELECT task_id, kind FROM approvals WHERE status='pending' ORDER BY id LIMIT 1`).get() as { task_id: number; kind: string };
      taskId = a.task_id;
      detail = `Waiting for your ${a.kind.replace('_', ' ')} decision on ${taskLabel(a.task_id)}`;
    } else if (last) {
      const age = now - Date.parse(last.finished_at ?? '');
      const t = db.prepare('SELECT status FROM tasks WHERE id=?').get(last.task_id) as { status: string };
      if (last.status === 'failed' && t.status === 'failed' && age < FAILED_SHOW_MS) {
        state = 'failed';
        taskId = last.task_id;
        detail = `Failed ${last.stage} on ${taskLabel(last.task_id)}: ${(last.error ?? '').slice(0, 140)}`;
      } else if (last.status === 'completed' && age < COMPLETE_SHOW_MS) {
        state = 'complete';
        taskId = last.task_id;
        detail = `Finished ${last.stage} on ${taskLabel(last.task_id)}`;
      }
    }
    if (state === 'idle' && teamMode === 'solo' && role !== 'commander') {
      state = 'standby';
      detail = 'Standby: solo mode, Commander handles every stage';
    }
    return { ...base, state, detail, taskId };
  });
}

export function buildState(db: DB, cfg: StationConfig, engine: Engine, health: Health) {
  const teamMode = engine.teamMode();
  const tasks = (db.prepare(`SELECT * FROM tasks ORDER BY id DESC LIMIT 60`).all() as unknown as TaskRow[]).map(taskOut);
  const approvals = (db.prepare(`SELECT * FROM approvals WHERE status='pending' ORDER BY id`).all() as any[]).map((a) => ({
    id: a.id, taskId: a.task_id, taskLabel: taskLabel(a.task_id), kind: a.kind, payload: JSON.parse(a.payload_json), createdAt: a.created_at,
  }));
  const actions = (db.prepare(`SELECT * FROM actions ORDER BY id DESC LIMIT 30`).all() as any[]).map((a) => ({
    id: a.id, taskId: a.task_id, taskLabel: taskLabel(a.task_id), kind: a.kind, target: a.target, status: a.status,
    result: a.result_json ? JSON.parse(a.result_json) : null, updatedAt: a.updated_at,
  }));
  const events = (db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT 150`).all() as any[]).map((e) => ({
    id: e.id, ts: e.ts, taskId: e.task_id, taskLabel: e.task_id ? taskLabel(e.task_id) : null, agent: e.agent, type: e.type, message: e.message,
  }));
  const counts = db.prepare(`SELECT status, count(*) AS n FROM tasks GROUP BY status`).all() as { status: string; n: number }[];
  return {
    mode: cfg.mode,
    serverTime: new Date().toISOString(),
    gateway: health,
    queue: {
      paused: engine.isPaused(),
      block: getSetting<string | null>(db, 'queue_block', null),
      maxWorkers: cfg.queue.maxWorkers,
      runningSteps: (db.prepare(`SELECT count(*) AS n FROM steps WHERE status='running'`).get() as { n: number }).n,
      queuedSteps: (db.prepare(`SELECT count(*) AS n FROM steps WHERE status='queued'`).get() as { n: number }).n,
      teamMode,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    },
    usage: usageSummary(db, cfg),
    agents: agentStates(db, cfg, health, teamMode),
    tasks,
    approvals,
    actions,
    events,
    settings: { approvedDomains: engine.approvedDomains(), timezone: cfg.timezone, webhookAllowlist: cfg.actions.webhookAllowlist },
  };
}

export function taskDetail(db: DB, cfg: StationConfig, id: number) {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as TaskRow | undefined;
  if (!t) return null;
  const steps = (db.prepare(`SELECT * FROM steps WHERE task_id=? ORDER BY id`).all(id) as unknown as StepRow[]).map((s) => ({
    id: s.id, stage: s.stage, agent: s.agent, executor: s.executor, status: s.status, attempt: s.attempt, maxAttempts: s.max_attempts,
    timeoutMs: s.timeout_ms, error: s.error, output: s.output_json ? JSON.parse(s.output_json) : null,
    usage: s.usage_json ? JSON.parse(s.usage_json) : null, tokensTotal: s.tokens_total, openclawResponseId: s.openclaw_response_id,
    memorySha256: s.memory_sha256, createdAt: s.created_at, startedAt: s.started_at, finishedAt: s.finished_at,
  }));
  const sources = (db.prepare(`SELECT id, ref, source_type, url, title, retrieved_at, sha256, bytes, length(content) AS chars FROM sources WHERE task_id=? ORDER BY id`).all(id) as any[]).map((s) => ({
    id: s.id, ref: s.ref, type: s.source_type, url: s.url, title: s.title, retrievedAt: s.retrieved_at, sha256: s.sha256, bytes: s.bytes, chars: s.chars,
  }));
  const approvals = (db.prepare(`SELECT * FROM approvals WHERE task_id=? ORDER BY id`).all(id) as any[]).map((a) => ({
    id: a.id, kind: a.kind, status: a.status, payload: JSON.parse(a.payload_json), note: a.note, createdAt: a.created_at, decidedAt: a.decided_at,
  }));
  const actions = (db.prepare(`SELECT * FROM actions WHERE task_id=? ORDER BY id`).all(id) as any[]).map((a) => ({
    id: a.id, kind: a.kind, target: a.target, status: a.status, result: a.result_json ? JSON.parse(a.result_json) : null,
  }));
  const events = db.prepare(`SELECT id, ts, agent, type, message FROM events WHERE task_id=? ORDER BY id`).all(id);
  const read = (rel: string | null) => (rel && existsSync(path.join(cfg.rootDir, rel)) ? readFileSync(path.join(cfg.rootDir, rel), 'utf8') : null);
  const draftRel = path.relative(cfg.rootDir, path.join(cfg.stagingDir, taskLabel(id), 'draft.md'));
  return {
    task: taskOut(t),
    request: JSON.parse(t.request_json),
    steps,
    sources,
    approvals,
    actions,
    events,
    draft: read(draftRel),
    output: read(t.output_path),
  };
}
