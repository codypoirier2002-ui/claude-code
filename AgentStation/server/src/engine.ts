// The task engine: an explicit SQLite-backed queue that runs the workflow
//   Request → Plan → Research → Draft → Review → Human approval → Complete
// Agents only return text. Every side effect (fetching, files, memory,
// external actions) happens here, in code, after the checks it needs.
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { nowIso, tx, getSetting, setSetting, taskLabel, type DB, type TaskRow, type StepRow, type Stage, type TaskStatus } from './db.ts';
import type { StationConfig, AgentRole } from './config.ts';
import type { AgentRunner, Health } from './openclaw.ts';
import { GatewayError } from './openclaw.ts';
import { logEvent, changed } from './events.ts';
import { recordUsage, usageSummary, currentLimits } from './usage.ts';
import { loadMemory, memoryBlockFor, recordCompletion, recordEnd, stationDay, slugify, type MemorySnapshot } from './memory.ts';
import { fetchAll, SOURCE_TYPES, type SourceType, type SourceQuery } from './sources.ts';
import {
  planPrompt, parsePlan, researchPrompt, parseResearch, draftPrompt, parseDraft, checkDraft, reviewPrompt, parseReview,
  finalReport, OutputError, type Plan, type Research, type Review, type TaskRequest, type SourceForPrompt,
} from './workflow.ts';
import { proposeActions, executeReadyActions, recoverActions, voidOpenActions } from './actions.ts';

export type TeamMode = 'solo' | 'team';

export interface NewTask {
  description: string;
  project?: string | null;
  urls?: string[];
  sourceTypes?: SourceType[];
  dependsOn?: number[];
  idempotencyKey?: string | null;
}

export interface ApprovalDecision {
  decision: 'approve' | 'reject' | 'revise';
  note?: string;
  answers?: string[];
  keepDecisions?: string[];
}

class StepFailure extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.transient = transient;
  }
}

const STATION_STEP_TIMEOUT_MS = 120_000;
const RETRY_BACKOFF_MS = [0, 15_000, 60_000];
const MAX_OPERATOR_REVISIONS = 2;

export class Engine {
  readonly owner = randomUUID();
  private readonly db: DB;
  private readonly cfg: StationConfig;
  private readonly runner: AgentRunner;
  private readonly health: () => Health;
  private readonly inFlight = new Map<number, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private lastBlock: string | null = null;
  private ticking = false;
  private readonly fetchSources: typeof fetchAll;

  constructor(deps: { db: DB; cfg: StationConfig; runner: AgentRunner; health: () => Health; fetchSources?: typeof fetchAll }) {
    this.db = deps.db;
    this.cfg = deps.cfg;
    this.runner = deps.runner;
    this.health = deps.health;
    this.fetchSources = deps.fetchSources ?? fetchAll;
  }

  // ---------- lifecycle ----------

  start(): void {
    this.recover();
    this.timer = setInterval(() => void this.tick(), this.cfg.queue.pollMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.inFlight.values()) c.abort(new Error('station shutting down'));
    const deadline = Date.now() + 5000;
    while (this.inFlight.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  // Runs at boot. A step marked running belongs to a process that no longer
  // exists: requeue it if it has attempts left. Agent steps only produce
  // text, so re-running them repeats no external effect. External actions are
  // never retried automatically (see actions.ts).
  recover(): void {
    const stale = this.db.prepare(`SELECT * FROM steps WHERE status = 'running'`).all() as unknown as StepRow[];
    for (const s of stale) {
      if (s.attempt < s.max_attempts) {
        this.db.prepare(`UPDATE steps SET status='queued', lease_owner=NULL, lease_expires_at=NULL, error=? WHERE id=?`).run('interrupted by station restart; requeued', s.id);
        logEvent(this.db, { taskId: s.task_id, agent: s.agent, type: 'step_recovered', message: `${s.stage} step was interrupted by a restart and has been requeued (attempt ${s.attempt} of ${s.max_attempts} used).` });
      } else {
        this.db.prepare(`UPDATE steps SET status='failed', finished_at=?, error=? WHERE id=?`).run(nowIso(), 'interrupted by station restart with no attempts left', s.id);
        this.failTask(s.task_id, `${s.stage} step was interrupted by a restart and had no attempts left.`);
      }
      this.refreshTaskStatus(s.task_id);
    }
    recoverActions(this.db);
  }

  // ---------- configuration ----------

  teamMode(): TeamMode {
    return getSetting<TeamMode>(this.db, 'team_mode', 'team');
  }

  approvedDomains(): string[] {
    return getSetting<string[]>(this.db, 'approved_domains', this.cfg.sources.approvedDomains);
  }

  isPaused(): boolean {
    return getSetting<boolean>(this.db, 'queue_paused', false);
  }

  setPaused(paused: boolean): void {
    setSetting(this.db, 'queue_paused', paused);
    logEvent(this.db, { type: paused ? 'queue_paused' : 'queue_resumed', message: paused ? 'Queue paused by operator. Running steps finish; no new steps start.' : 'Queue resumed by operator.' });
  }

  roleFor(stage: Stage): AgentRole {
    if (stage === 'plan' || stage === 'approval' || stage === 'finalize') return 'commander';
    if (this.teamMode() === 'solo') return 'commander';
    return stage === 'fetch' || stage === 'research' ? 'researcher' : stage === 'draft' ? 'writer' : 'reviewer';
  }

  // ---------- tasks ----------

  createTask(input: NewTask): { task: TaskRow; created: boolean } {
    const description = input.description.trim();
    if (description.length < 10) throw new Error('Describe the task in at least 10 characters.');
    if (description.length > 4000) throw new Error('Task description is limited to 4,000 characters.');
    const urls = (input.urls ?? []).map((u) => u.trim()).filter(Boolean).slice(0, 8);
    const sourceTypes = (input.sourceTypes ?? []).filter((t) => SOURCE_TYPES.includes(t));
    const dependsOn = [...new Set((input.dependsOn ?? []).filter((n) => Number.isInteger(n) && n > 0))];
    for (const d of dependsOn) {
      if (!this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(d)) throw new Error(`Dependency ${taskLabel(d)} does not exist.`);
    }
    const key = input.idempotencyKey?.trim() || null;
    return tx(this.db, () => {
      if (key) {
        const existing = this.db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(key) as unknown as TaskRow | undefined;
        if (existing) return { task: existing, created: false };
      }
      const request: TaskRequest = { description, project: input.project?.trim() || null, urls, sourceTypes };
      const now = nowIso();
      const res = this.db
        .prepare(
          `INSERT INTO tasks (title, description, request_json, status, stage, assigned_agent, depends_on_json, project, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', 'plan', 'commander', ?, ?, ?, ?, ?)`,
        )
        .run(description.slice(0, 80), description, JSON.stringify(request), JSON.stringify(dependsOn), request.project, key, now, now);
      const id = Number(res.lastInsertRowid);
      this.addStep(id, 'plan', { request });
      logEvent(this.db, { taskId: id, agent: 'commander', type: 'task_created', message: `${taskLabel(id)} created: ${description.slice(0, 120)}` });
      return { task: this.getTask(id)!, created: true };
    });
  }

  getTask(id: number): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
  }

  private addStep(taskId: number, stage: Stage, input: unknown, dependsOn: number[] = []): number {
    const role = this.roleFor(stage);
    const executor = stage === 'fetch' || stage === 'finalize' ? 'station' : 'openclaw';
    const timeoutMs = executor === 'openclaw' ? this.cfg.agents[role].timeoutSec * 1000 : STATION_STEP_TIMEOUT_MS;
    const res = this.db
      .prepare(
        `INSERT INTO steps (task_id, stage, agent, executor, status, depends_on_json, max_attempts, timeout_ms, input_json, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(taskId, stage, role, executor, JSON.stringify(dependsOn), this.cfg.queue.maxAttempts, timeoutMs, JSON.stringify(input), nowIso());
    this.db.prepare(`UPDATE tasks SET stage=?, assigned_agent=?, updated_at=? WHERE id=?`).run(stage, role, nowIso(), taskId);
    return Number(res.lastInsertRowid);
  }

  private refreshTaskStatus(taskId: number): void {
    const t = this.getTask(taskId);
    if (!t || t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') return;
    const pendingApproval = this.db.prepare(`SELECT 1 FROM approvals WHERE task_id=? AND status='pending' AND kind IN ('final_report','clarification')`).get(taskId);
    const running = this.db.prepare(`SELECT 1 FROM steps WHERE task_id=? AND status='running'`).get(taskId);
    const status: TaskStatus = pendingApproval ? 'awaiting_approval' : running ? 'running' : 'queued';
    if (status !== t.status) {
      this.db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), taskId);
    }
    changed();
  }

  private failTask(taskId: number, error: string, detail?: string): void {
    const t = this.getTask(taskId);
    if (!t || ['completed', 'failed', 'cancelled'].includes(t.status)) return;
    this.db.prepare(`UPDATE tasks SET status='failed', error=?, error_detail=?, updated_at=? WHERE id=?`).run(error, detail ?? null, nowIso(), taskId);
    this.db.prepare(`UPDATE steps SET status='cancelled', finished_at=? WHERE task_id=? AND status='queued'`).run(nowIso(), taskId);
    this.db.prepare(`UPDATE approvals SET status='void', decided_at=? WHERE task_id=? AND status='pending'`).run(nowIso(), taskId);
    voidOpenActions(this.db, taskId, 'task failed');
    logEvent(this.db, { taskId, agent: t.assigned_agent, type: 'task_failed', message: `${taskLabel(taskId)} failed: ${error}` });
    try {
      recordEnd(this.cfg, taskLabel(taskId), t.title, 'failed', error);
    } catch (err) {
      logEvent(this.db, { taskId, type: 'memory_error', message: `could not write daily note: ${(err as Error).message}` });
    }
  }

  cancelTask(taskId: number, reason = 'cancelled by operator'): TaskRow {
    const t = this.getTask(taskId);
    if (!t) throw new Error(`No task ${taskLabel(taskId)}.`);
    if (['completed', 'failed', 'cancelled'].includes(t.status)) throw new Error(`${taskLabel(taskId)} is already ${t.status}.`);
    tx(this.db, () => {
      this.db.prepare(`UPDATE tasks SET status='cancelled', cancel_requested=1, error=?, updated_at=? WHERE id=?`).run(reason, nowIso(), taskId);
      this.db.prepare(`UPDATE steps SET status='cancelled', finished_at=?, error=? WHERE task_id=? AND status IN ('queued','running')`).run(nowIso(), reason, taskId);
      this.db.prepare(`UPDATE approvals SET status='void', decided_at=? WHERE task_id=? AND status='pending'`).run(nowIso(), taskId);
      voidOpenActions(this.db, taskId, reason);
    });
    for (const s of this.db.prepare(`SELECT id FROM steps WHERE task_id=?`).all(taskId) as { id: number }[]) {
      this.inFlight.get(s.id)?.abort(new Error(reason));
    }
    logEvent(this.db, { taskId, agent: t.assigned_agent, type: 'task_cancelled', message: `${taskLabel(taskId)} cancelled: ${reason}` });
    recordEnd(this.cfg, taskLabel(taskId), t.title, 'cancelled', reason);
    return this.getTask(taskId)!;
  }

  // Failed tasks can be retried from the step that failed, with fresh attempts.
  retryTask(taskId: number): TaskRow {
    const t = this.getTask(taskId);
    if (!t || t.status !== 'failed') throw new Error(`${taskLabel(taskId)} is not in a failed state.`);
    const last = this.db.prepare(`SELECT * FROM steps WHERE task_id=? AND status='failed' ORDER BY id DESC LIMIT 1`).get(taskId) as unknown as StepRow | undefined;
    if (!last) throw new Error('No failed step to retry.');
    tx(this.db, () => {
      this.db.prepare(`UPDATE tasks SET status='queued', error=NULL, error_detail=NULL, updated_at=? WHERE id=?`).run(nowIso(), taskId);
      this.addStep(taskId, last.stage, JSON.parse(last.input_json));
    });
    logEvent(this.db, { taskId, type: 'task_retried', message: `${taskLabel(taskId)} retried from the ${last.stage} stage by operator.` });
    return this.getTask(taskId)!;
  }

  // ---------- approvals ----------

  decideApproval(approvalId: number, d: ApprovalDecision): void {
    const a = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as any;
    if (!a) throw new Error(`No approval #${approvalId}.`);
    if (a.status !== 'pending') throw new Error(`Approval #${approvalId} was already ${a.status}.`);
    const t = this.getTask(a.task_id)!;
    const payload = JSON.parse(a.payload_json);
    const note = (d.note ?? '').trim().slice(0, 2000);
    tx(this.db, () => {
      // Compare-and-set: a double click or a second tab cannot apply twice.
      const status = d.decision === 'approve' ? 'approved' : 'rejected';
      const upd = this.db.prepare(`UPDATE approvals SET status=?, note=?, decided_at=? WHERE id=? AND status='pending'`).run(status, note || null, nowIso(), approvalId);
      if (upd.changes !== 1) throw new Error(`Approval #${approvalId} was already decided.`);

      if (a.kind === 'external_action') {
        this.db.prepare(`UPDATE actions SET status=?, updated_at=? WHERE id=? AND status='proposed'`).run(d.decision === 'approve' ? 'approved' : 'rejected', nowIso(), payload.actionId);
        logEvent(this.db, { taskId: t.id, agent: 'commander', type: 'action_decided', message: `External action #${payload.actionId} (${payload.kind} → ${payload.target}) ${d.decision === 'approve' ? 'approved' : 'rejected'} by operator.` });
        return;
      }
      if (a.kind === 'clarification') {
        if (d.decision === 'reject') {
          this.cancelInsideTx(t, `operator declined to clarify${note ? ': ' + note : ''}`);
          return;
        }
        const questions: string[] = payload.questions ?? [];
        const answers = d.answers ?? [];
        if (answers.length < questions.length || answers.some((x) => !x?.trim())) throw new Error('Answer every question.');
        const req: TaskRequest = JSON.parse(t.request_json);
        req.clarifications = [...(req.clarifications ?? []), ...questions.map((q, i) => ({ question: q, answer: answers[i].trim().slice(0, 1000) }))];
        this.db.prepare(`UPDATE tasks SET request_json=?, updated_at=? WHERE id=?`).run(JSON.stringify(req), nowIso(), t.id);
        this.addStep(t.id, 'plan', { request: req });
        logEvent(this.db, { taskId: t.id, agent: 'commander', type: 'clarified', message: `Operator answered ${questions.length} question(s); Commander will re-plan.` });
        return;
      }
      // final_report
      if (d.decision === 'reject') {
        this.cancelInsideTx(t, `report rejected by operator${note ? ': ' + note : ''}`);
        return;
      }
      if (d.decision === 'revise') {
        if (!note) throw new Error('Say what should change.');
        const opRevisions = this.db.prepare(`SELECT count(*) AS n FROM approvals WHERE task_id=? AND kind='final_report' AND status='rejected' AND json_extract(payload_json,'$.revisionRequested')=1`).get(t.id) as { n: number };
        if (opRevisions.n >= MAX_OPERATOR_REVISIONS) throw new Error(`This task already had ${MAX_OPERATOR_REVISIONS} operator revisions. Approve or reject it.`);
        this.db.prepare(`UPDATE approvals SET payload_json=json_set(payload_json,'$.revisionRequested',1) WHERE id=?`).run(approvalId);
        const lastDraft = this.latestOutput<{ draft: string }>(t.id, 'draft');
        this.addStep(t.id, 'draft', { feedback: [`Operator: ${note}`], previousDraft: lastDraft?.draft ?? null, operatorRevision: true });
        logEvent(this.db, { taskId: t.id, agent: 'commander', type: 'revision_requested', message: `Operator asked for changes: ${note.slice(0, 200)}` });
        return;
      }
      this.db.prepare(`UPDATE approvals SET payload_json=json_set(payload_json,'$.keepDecisions',json(?)) WHERE id=?`).run(JSON.stringify((d.keepDecisions ?? []).slice(0, 5)), approvalId);
      this.addStep(t.id, 'finalize', { approvalId });
      logEvent(this.db, { taskId: t.id, agent: 'commander', type: 'report_approved', message: `${taskLabel(t.id)} report approved by operator.` });
    });
    this.refreshTaskStatus(t.id);
  }

  private cancelInsideTx(t: TaskRow, reason: string) {
    this.db.prepare(`UPDATE tasks SET status='cancelled', cancel_requested=1, error=?, updated_at=? WHERE id=?`).run(reason, nowIso(), t.id);
    this.db.prepare(`UPDATE steps SET status='cancelled', finished_at=? WHERE task_id=? AND status IN ('queued','running')`).run(nowIso(), t.id);
    this.db.prepare(`UPDATE approvals SET status='void', decided_at=? WHERE task_id=? AND status='pending'`).run(nowIso(), t.id);
    voidOpenActions(this.db, t.id, reason);
    logEvent(this.db, { taskId: t.id, agent: 'commander', type: 'task_cancelled', message: `${taskLabel(t.id)} ended: ${reason}` });
    recordEnd(this.cfg, taskLabel(t.id), t.title, 'cancelled', reason);
  }

  // ---------- the queue ----------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.failTasksWithBrokenDependencies();
      if (this.isPaused()) return;
      await executeReadyActions(this.db, this.cfg);
      const free = this.cfg.queue.maxWorkers - this.inFlight.size;
      if (free <= 0) return;
      const usage = usageSummary(this.db, this.cfg);
      const gateway = this.health();
      const block = usage.blocked ? usage.blockReason : !gateway.ready ? `OpenClaw gateway not ready: ${gateway.detail}` : null;
      if (block !== this.lastBlock) {
        this.lastBlock = block;
        setSetting(this.db, 'queue_block', block);
        if (block) logEvent(this.db, { type: usage.blocked ? 'limit_blocked' : 'gateway_blocked', message: `New agent work is on hold. ${block}` });
        else logEvent(this.db, { type: 'queue_unblocked', message: 'Agent work can start again.' });
      }
      const candidates = this.db
        .prepare(
          `SELECT s.* FROM steps s JOIN tasks t ON t.id = s.task_id
           WHERE s.status='queued' AND t.status IN ('queued','running') AND t.cancel_requested=0
             AND (s.not_before IS NULL OR s.not_before <= ?)
           ORDER BY s.task_id, s.id LIMIT 20`,
        )
        .all(nowIso()) as unknown as StepRow[];
      let started = 0;
      for (const s of candidates) {
        if (started >= free) break;
        if (s.executor === 'openclaw' && block) continue;
        if (!this.dependenciesMet(s)) continue;
        if (s.executor === 'openclaw') {
          const t = this.getTask(s.task_id)!;
          const cap = currentLimits(this.db, this.cfg).perTaskTokenCap;
          if (t.tokens_total >= cap) {
            this.db.prepare(`UPDATE steps SET status='failed', error=?, finished_at=? WHERE id=?`).run('per-task token cap reached', nowIso(), s.id);
            this.failTask(t.id, `Per-task token cap reached (${t.tokens_total.toLocaleString('en-US')} of ${cap.toLocaleString('en-US')} tokens). Raise the cap or simplify the task.`);
            continue;
          }
        }
        if (!this.claim(s)) continue;
        started++;
        void this.execute(s.id);
      }
    } catch (err) {
      logEvent(this.db, { type: 'engine_error', message: `queue tick failed: ${(err as Error).message}` });
    } finally {
      this.ticking = false;
    }
  }

  private dependenciesMet(s: StepRow): boolean {
    const t = this.getTask(s.task_id)!;
    const taskDeps: number[] = JSON.parse(t.depends_on_json);
    for (const d of taskDeps) {
      const dt = this.getTask(d);
      if (!dt || dt.status !== 'completed') return false;
    }
    const stepDeps: number[] = JSON.parse(s.depends_on_json);
    for (const d of stepDeps) {
      const ds = this.db.prepare('SELECT status FROM steps WHERE id=?').get(d) as { status: string } | undefined;
      if (!ds || ds.status !== 'completed') return false;
    }
    return true;
  }

  private failTasksWithBrokenDependencies(): void {
    const waiting = this.db.prepare(`SELECT * FROM tasks WHERE status='queued' AND depends_on_json != '[]'`).all() as unknown as TaskRow[];
    for (const t of waiting) {
      for (const d of JSON.parse(t.depends_on_json) as number[]) {
        const dt = this.getTask(d);
        if (dt && (dt.status === 'failed' || dt.status === 'cancelled')) {
          this.failTask(t.id, `Dependency ${taskLabel(d)} ${dt.status}, so this task cannot start.`);
          break;
        }
      }
    }
  }

  private claim(s: StepRow): boolean {
    const now = nowIso();
    const lease = new Date(Date.now() + s.timeout_ms + 30_000).toISOString();
    const res = this.db
      .prepare(`UPDATE steps SET status='running', attempt=attempt+1, lease_owner=?, lease_expires_at=?, started_at=?, error=NULL WHERE id=? AND status='queued'`)
      .run(this.owner, lease, now, s.id);
    if (res.changes !== 1) return false;
    this.refreshTaskStatus(s.task_id);
    logEvent(this.db, { taskId: s.task_id, agent: s.agent, type: 'step_started', message: `${roleName(s.agent)} started ${s.stage} (attempt ${s.attempt + 1} of ${s.max_attempts}).` });
    return true;
  }

  private async execute(stepId: number): Promise<void> {
    const step = this.db.prepare('SELECT * FROM steps WHERE id=?').get(stepId) as unknown as StepRow;
    const controller = new AbortController();
    this.inFlight.set(stepId, controller);
    const timeout = AbortSignal.timeout(step.timeout_ms);
    const signal = AbortSignal.any([controller.signal, timeout]);
    try {
      const outcome = await this.runStage(step, signal);
      this.complete(step, outcome);
    } catch (err) {
      const e = err as Error;
      let message = e.message;
      let transient = err instanceof StepFailure ? err.transient : err instanceof GatewayError ? err.transient : err instanceof OutputError;
      if (timeout.aborted && !controller.signal.aborted) {
        message = `${roleName(step.agent)} timed out after ${Math.round(step.timeout_ms / 1000)}s during ${step.stage}`;
        transient = true;
      } else if (controller.signal.aborted) {
        message = `aborted: ${(controller.signal.reason as Error)?.message ?? 'cancelled'}`;
        transient = false;
      }
      this.fail(step, message, transient);
    } finally {
      this.inFlight.delete(stepId);
      changed();
    }
  }

  // Compare-and-set completion: if the step was cancelled while the agent was
  // working, the late result is discarded rather than applied.
  private complete(step: StepRow, outcome: StageOutcome): void {
    tx(this.db, () => {
      const res = this.db
        .prepare(`UPDATE steps SET status='completed', output_json=?, raw_output=?, finished_at=?, lease_owner=NULL WHERE id=? AND status='running' AND lease_owner=?`)
        .run(JSON.stringify(outcome.output), outcome.raw ?? null, nowIso(), step.id, this.owner);
      if (res.changes !== 1) {
        logEvent(this.db, { taskId: step.task_id, agent: step.agent, type: 'result_discarded', message: `${step.stage} result arrived after the step was cancelled; discarded.` });
        return;
      }
      logEvent(this.db, { taskId: step.task_id, agent: step.agent, type: 'step_completed', message: `${roleName(step.agent)} finished ${step.stage}. ${outcome.summary ?? ''}`.trim() });
      outcome.next?.();
    });
    this.refreshTaskStatus(step.task_id);
  }

  private fail(step: StepRow, message: string, transient: boolean): void {
    const current = this.db.prepare('SELECT status, attempt, max_attempts FROM steps WHERE id=?').get(step.id) as { status: string; attempt: number; max_attempts: number };
    if (current.status !== 'running') return; // cancelled meanwhile
    if (transient && current.attempt < current.max_attempts) {
      const wait = RETRY_BACKOFF_MS[Math.min(current.attempt, RETRY_BACKOFF_MS.length - 1)];
      this.db.prepare(`UPDATE steps SET status='queued', error=?, lease_owner=NULL, not_before=? WHERE id=? AND status='running'`).run(message, new Date(Date.now() + wait).toISOString(), step.id);
      logEvent(this.db, { taskId: step.task_id, agent: step.agent, type: 'step_retry', message: `${step.stage} attempt ${current.attempt} failed (${message}). Retrying in ${wait / 1000}s.` });
    } else {
      this.db.prepare(`UPDATE steps SET status='failed', error=?, finished_at=?, lease_owner=NULL WHERE id=? AND status='running'`).run(message, nowIso(), step.id);
      logEvent(this.db, { taskId: step.task_id, agent: step.agent, type: 'step_failed', message: `${roleName(step.agent)} failed ${step.stage}: ${message}` });
      this.failTask(step.task_id, `${step.stage} failed after ${current.attempt} attempt(s): ${message}`, transient ? 'Retries exhausted.' : 'Not retried: this error will not go away on its own.');
    }
    this.refreshTaskStatus(step.task_id);
  }

  // ---------- stages ----------

  private latestOutput<T>(taskId: number, stage: Stage): T | null {
    const row = this.db.prepare(`SELECT output_json FROM steps WHERE task_id=? AND stage=? AND status='completed' ORDER BY id DESC LIMIT 1`).get(taskId, stage) as { output_json: string } | undefined;
    return row ? (JSON.parse(row.output_json) as T) : null;
  }

  private sourcesFor(taskId: number): SourceForPrompt[] {
    return (this.db.prepare(`SELECT ref, url, title, retrieved_at, sha256, content FROM sources WHERE task_id=? ORDER BY id`).all(taskId) as any[]).map((r) => ({
      ref: r.ref, url: r.url, title: r.title, retrievedAt: r.retrieved_at, sha256: r.sha256, content: r.content,
    }));
  }

  private async callAgent(step: StepRow, prompt: string, memory: MemorySnapshot | null, signal: AbortSignal): Promise<string> {
    const agentId = this.cfg.agents[step.agent as AgentRole].openclawAgentId;
    this.db.prepare(`UPDATE steps SET memory_sha256=? WHERE id=?`).run(memory?.sha256 ?? null, step.id);
    const result = await this.runner.run(agentId, prompt, { signal });
    this.db.prepare(`UPDATE steps SET openclaw_response_id=?, raw_output=?, usage_json=?, tokens_total=tokens_total+? WHERE id=?`).run(
      result.responseId, result.text.slice(0, 200_000), result.usage ? JSON.stringify(result.usage) : null, result.usage?.totalTokens ?? 0, step.id,
    );
    if (result.usage) recordUsage(this.db, this.cfg, { taskId: step.task_id, stepId: step.id, agent: step.agent, usage: result.usage });
    else logEvent(this.db, { taskId: step.task_id, agent: step.agent, type: 'usage_missing', message: `OpenClaw reported no usage for this ${step.stage} call; it is not counted toward the cap.` });
    return result.text;
  }

  private async runStage(step: StepRow, signal: AbortSignal): Promise<StageOutcome> {
    const task = this.getTask(step.task_id)!;
    const label = taskLabel(task.id);
    const req: TaskRequest = JSON.parse(task.request_json);
    const input = JSON.parse(step.input_json);
    const memory = step.executor === 'openclaw' ? loadMemory(this.cfg, task.project) : null;

    switch (step.stage) {
      case 'plan': {
        const prompt = planPrompt({ taskLabel: label, today: stationDay(this.cfg), memory: memoryBlockFor('commander', memory!), request: input.request ?? req, approvedDomains: this.approvedDomains() });
        const text = await this.callAgent(step, prompt, memory, signal);
        const plan = parsePlan(text, req.sourceTypes);
        return {
          output: plan,
          raw: text,
          summary: plan.status === 'ready' ? `Plan: ${plan.title}` : `Needs clarification (${plan.clarifying_questions.length} question(s)).`,
          next: () => {
            if (plan.status === 'needs_clarification') {
              this.db.prepare(`INSERT INTO approvals (task_id, kind, status, payload_json, created_at) VALUES (?, 'clarification', 'pending', ?, ?)`).run(task.id, JSON.stringify({ questions: plan.clarifying_questions }), nowIso());
              logEvent(this.db, { taskId: task.id, agent: 'commander', type: 'approval_requested', message: `Commander needs answers before planning ${label}.` });
              return;
            }
            this.db.prepare(`UPDATE tasks SET title=?, updated_at=? WHERE id=?`).run(plan.title, nowIso(), task.id);
            proposeActions(this.db, task.id, plan.external_actions);
            this.addStep(task.id, 'fetch', {}, [step.id]);
          },
        };
      }
      case 'fetch': {
        const plan = this.latestOutput<Plan>(task.id, 'plan')!;
        const queries: SourceQuery[] = [...req.urls.map((u) => ({ source: 'url' as const, query: u })), ...plan.source_queries];
        if (!queries.length) throw new StepFailure('The plan has no source queries and the operator supplied no URLs.', false);
        const policy = {
          approvedDomains: this.approvedDomains(),
          maxBytes: this.cfg.sources.maxBytesPerSource,
          timeoutMs: this.cfg.sources.fetchTimeoutSec * 1000,
          userAgent: this.cfg.sources.userAgent,
        };
        const { sources, errors } = await this.fetchSources(queries, policy, this.cfg.sources.maxSourcesPerTask, signal);
        if (!sources.length) {
          const detail = errors.map((e) => `${e.query.source}:${e.query.query} → ${e.error}`).join('; ');
          throw new StepFailure(`No approved source could be fetched. ${detail}`, errors.length > 0 && errors.every((e) => e.transient));
        }
        return {
          output: { fetched: sources.length, errors },
          summary: `Fetched ${sources.length} source(s)${errors.length ? `; ${errors.length} query(ies) failed` : ''}.`,
          next: () => {
            this.db.prepare('DELETE FROM sources WHERE task_id=?').run(task.id);
            sources.forEach((s, i) => {
              this.db.prepare(`INSERT INTO sources (task_id, ref, source_type, url, title, retrieved_at, sha256, bytes, content) VALUES (?,?,?,?,?,?,?,?,?)`).run(task.id, `S${i + 1}`, s.type, s.url, s.title, s.retrievedAt, s.sha256, s.bytes, s.content);
            });
            for (const e of errors) logEvent(this.db, { taskId: task.id, agent: step.agent, type: 'source_error', message: `Source skipped: ${e.query.source} "${e.query.query}": ${e.error}` });
            this.addStep(task.id, 'research', {}, [step.id]);
          },
        };
      }
      case 'research': {
        const plan = this.latestOutput<Plan>(task.id, 'plan')!;
        const sources = this.sourcesFor(task.id);
        const prompt = researchPrompt({ taskLabel: label, memory: memoryBlockFor(step.agent as AgentRole, memory!), plan, sources, maxChars: this.cfg.sources.maxCharsPerSourceToAgent });
        const text = await this.callAgent(step, prompt, memory, signal);
        const research = parseResearch(text, sources.map((s) => ({ ...s, content: s.content.slice(0, this.cfg.sources.maxCharsPerSourceToAgent) })));
        const verified = research.findings.filter((f) => f.verified).length;
        return {
          output: research,
          raw: text,
          summary: `${verified} of ${research.findings.length} findings verified against source text.`,
          next: () => this.addStep(task.id, 'draft', { feedback: null, previousDraft: null }, [step.id]),
        };
      }
      case 'draft': {
        const plan = this.latestOutput<Plan>(task.id, 'plan')!;
        const research = this.latestOutput<Research>(task.id, 'research')!;
        const sources = this.sourcesFor(task.id);
        const prompt = draftPrompt({ taskLabel: label, memory: memoryBlockFor(step.agent as AgentRole, memory!), plan, research, sources, feedback: input.feedback ?? null, previousDraft: input.previousDraft ?? null });
        const text = await this.callAgent(step, prompt, memory, signal);
        const draft = parseDraft(text);
        const checks = checkDraft(draft, sources.map((s) => s.ref));
        if (checks.citedRefs.length === 0) throw new OutputError('draft cites no sources');
        return {
          output: { draft, checks },
          raw: text,
          summary: `Draft ready: ${draft.length} characters, cites ${checks.citedRefs.join(', ')}${checks.unknownRefs.length ? `; unknown IDs ${checks.unknownRefs.join(', ')}` : ''}.`,
          next: () => {
            const dir = path.join(this.cfg.stagingDir, label);
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, 'draft.md'), draft);
            if (this.teamMode() === 'solo') this.requestFinalApproval(task.id, null, draft, checks);
            else this.addStep(task.id, 'review', {}, [step.id]);
          },
        };
      }
      case 'review': {
        const plan = this.latestOutput<Plan>(task.id, 'plan')!;
        const research = this.latestOutput<Research>(task.id, 'research')!;
        const { draft, checks } = this.latestOutput<{ draft: string; checks: ReturnType<typeof checkDraft> }>(task.id, 'draft')!;
        const prompt = reviewPrompt({ taskLabel: label, memory: memoryBlockFor('reviewer', memory!), plan, research, draft, checks });
        const text = await this.callAgent(step, prompt, memory, signal);
        const review = parseReview(text);
        // Station checks can force a revision even if the model passes it.
        const mechanical = [
          ...checks.unknownRefs.map((r) => `Citation ${r} does not match any fetched source.`),
          ...(checks.uncitedParagraphs > 0 ? [`${checks.uncitedParagraphs} substantial paragraph(s) have no citation.`] : []),
        ];
        const needsRevision = review.verdict === 'revise' || mechanical.length > 0;
        return {
          output: { ...review, mechanical },
          raw: text,
          summary: `Verdict: ${review.verdict}${mechanical.length ? ` (+${mechanical.length} station check issue(s))` : ''}.`,
          next: () => {
            const dir = path.join(this.cfg.stagingDir, label);
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ ...review, mechanical, checks }, null, 2));
            const current = this.getTask(task.id)!;
            if (needsRevision && current.revisions < this.cfg.queue.maxRevisions) {
              this.db.prepare('UPDATE tasks SET revisions = revisions + 1 WHERE id=?').run(task.id);
              const feedback = [...review.issues.map((i) => `(${i.severity}) ${i.detail}`), ...mechanical];
              this.addStep(task.id, 'draft', { feedback, previousDraft: draft }, [step.id]);
            } else {
              this.requestFinalApproval(task.id, { ...review, mechanical }, draft, checks);
            }
          },
        };
      }
      case 'finalize':
        return this.finalize(task, input.approvalId);
      default:
        throw new StepFailure(`unknown stage ${step.stage}`, false);
    }
  }

  private requestFinalApproval(taskId: number, review: (Review & { mechanical: string[] }) | null, draft: string, checks: ReturnType<typeof checkDraft>): void {
    const label = taskLabel(taskId);
    const payload = {
      draftPath: path.relative(this.cfg.rootDir, path.join(this.cfg.stagingDir, label, 'draft.md')),
      reviewVerdict: review?.verdict ?? 'not reviewed (solo mode)',
      issues: review?.issues ?? [],
      mechanical: review?.mechanical ?? [],
      criteria: review?.criteria ?? [],
      summary: review?.summary ?? draft.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 400) ?? '',
      proposedDecisions: review?.proposed_decisions ?? [],
      checks,
      draftSha256: createHash('sha256').update(draft).digest('hex'),
    };
    this.db.prepare(`INSERT INTO approvals (task_id, kind, status, payload_json, created_at) VALUES (?, 'final_report', 'pending', ?, ?)`).run(taskId, JSON.stringify(payload), nowIso());
    this.db.prepare(`UPDATE tasks SET stage='approval', assigned_agent='commander', updated_at=? WHERE id=?`).run(nowIso(), taskId);
    logEvent(this.db, { taskId, agent: 'commander', type: 'approval_requested', message: `${label} report is ready for your approval (review: ${payload.reviewVerdict}).` });
  }

  private finalize(task: TaskRow, approvalId: number): StageOutcome {
    const label = taskLabel(task.id);
    const approval = this.db.prepare(`SELECT * FROM approvals WHERE id=? AND task_id=? AND status='approved'`).get(approvalId, task.id) as any;
    if (!approval) throw new StepFailure('finalize called without an approved report', false);
    const payload = JSON.parse(approval.payload_json);
    const draftFile = path.join(this.cfg.rootDir, payload.draftPath);
    if (!existsSync(draftFile)) throw new StepFailure(`approved draft is missing: ${payload.draftPath}`, false);
    const draft = readFileSync(draftFile, 'utf8');
    if (createHash('sha256').update(draft).digest('hex') !== payload.draftSha256) {
      throw new StepFailure('the draft in staging changed after it was approved; refusing to publish an unapproved version', false);
    }
    const sources = this.sourcesFor(task.id);
    const approvedAt = approval.decided_at as string;
    const report = finalReport({ taskLabel: label, title: task.title, draft, sources, approvedAt, reviewVerdict: payload.reviewVerdict });
    const day = stationDay(this.cfg);
    const base = `${day}-${label.toLowerCase()}-${slugify(task.title).slice(0, 50) || 'report'}`;
    mkdirSync(this.cfg.outputsDir, { recursive: true });
    const outPath = path.join(this.cfg.outputsDir, `${base}.md`);
    writeFileSync(outPath, report);
    writeFileSync(
      path.join(this.cfg.outputsDir, `${base}.sources.json`),
      JSON.stringify(sources.map(({ content, ...meta }) => ({ ...meta, chars: content.length })), null, 2),
    );
    const rel = path.relative(this.cfg.rootDir, outPath);
    return {
      output: { outputPath: rel },
      summary: `Report saved to ${rel}.`,
      next: () => {
        this.db.prepare(`UPDATE tasks SET status='completed', output_path=?, completed_at=?, updated_at=? WHERE id=?`).run(rel, nowIso(), nowIso(), task.id);
        const t = this.getTask(task.id)!;
        recordCompletion(this.cfg, {
          taskLabel: label, title: t.title, project: t.project, outputRelPath: rel, sourceCount: sources.length,
          tokens: t.tokens_total, summary: payload.summary ?? '', decisions: payload.keepDecisions ?? [],
        });
        logEvent(this.db, { taskId: task.id, agent: 'commander', type: 'task_completed', message: `${label} completed. Report: ${rel}. Memory updated (daily note${t.project ? ', project note' : ''}${(payload.keepDecisions ?? []).length ? ', decisions' : ''}).` });
      },
    };
  }
}

interface StageOutcome {
  output: unknown;
  raw?: string;
  summary?: string;
  next?: () => void;
}

export function roleName(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}
