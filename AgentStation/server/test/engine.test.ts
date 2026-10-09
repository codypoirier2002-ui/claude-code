import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tempStation, ScriptedRunner, makeEngine, until, hang, usage, REPLIES } from './helpers.ts';
import { setSetting } from '../src/db.ts';
import { GatewayError } from '../src/openclaw.ts';

const status = (db: any, id: number) => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as { status: string }).status;
const pendingApproval = (db: any, taskId: number, kind = 'final_report') =>
  db.prepare(`SELECT id FROM approvals WHERE task_id=? AND kind=? AND status='pending'`).get(taskId, kind) as { id: number } | undefined;

test('full team workflow: plan → fetch → research → draft → review → approval → complete', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  const { engine, db } = makeEngine(cfg, runner);
  const { task } = engine.createTask({ description: 'Compare alpha and beta libraries', project: 'Libs', idempotencyKey: 'k1' });
  await until(engine, () => status(db, task.id) === 'awaiting_approval');
  assert.deepEqual(runner.calls.map((c) => c.stage), ['PLAN', 'RESEARCH', 'DRAFT', 'REVIEW']);
  assert.deepEqual(runner.calls.map((c) => c.agentId), ['station-commander', 'station-researcher', 'station-writer', 'station-reviewer']);

  const research = JSON.parse((db.prepare(`SELECT output_json FROM steps WHERE stage='research'`).get() as any).output_json);
  assert.deepEqual(research.findings.map((f: any) => f.verified), [true, true, false], 'invented quote is flagged unverified');

  engine.decideApproval(pendingApproval(db, task.id)!.id, { decision: 'approve', keepDecisions: ['Prefer alpha for async work'] });
  await until(engine, () => status(db, task.id) === 'completed');
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id) as any;
  const report = readFileSync(path.join(cfg.rootDir, t.output_path), 'utf8');
  assert.match(report, /## Sources/);
  assert.match(report, /\*\*S1\*\*: \[Source 1\]\(https:\/\/example\.org\/s1\)/);
  assert.equal(t.tokens_total, 4000);
  assert.match(readFileSync(path.join(cfg.memoryDir, 'decisions.md'), 'utf8'), /Prefer alpha for async work \(T-0001, approved by operator\)/);
  assert.match(readFileSync(path.join(cfg.memoryDir, 'projects', 'libs.md'), 'utf8'), /Compare alpha and beta/);
});

test('duplicate protection: same idempotency key, double approval, late results', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  const { engine, db } = makeEngine(cfg, runner);
  const a = engine.createTask({ description: 'Compare alpha and beta libraries', idempotencyKey: 'same' });
  const b = engine.createTask({ description: 'Compare alpha and beta libraries', idempotencyKey: 'same' });
  assert.equal(a.task.id, b.task.id);
  assert.equal(b.created, false);
  await until(engine, () => status(db, a.task.id) === 'awaiting_approval');
  const ap = pendingApproval(db, a.task.id)!.id;
  engine.decideApproval(ap, { decision: 'approve' });
  assert.throws(() => engine.decideApproval(ap, { decision: 'approve' }), /already approved/);
  await until(engine, () => status(db, a.task.id) === 'completed');
  assert.equal(db.prepare(`SELECT count(*) AS n FROM steps WHERE stage='finalize'`).get()!.n, 1);
  assert.equal(readdirSync(cfg.outputsDir).filter((f) => f.endsWith('.md')).length, 1);
});

test('approval gate: external action never runs without approval, runs exactly once after, never repeats after restart', async () => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(String(req.headers['idempotency-key']));
    req.resume();
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const target = `http://127.0.0.1:${(server.address() as any).port}/hook`;
  const cfg = tempStation((c) => (c.actions.webhookAllowlist = [target]));
  const runner = new ScriptedRunner();
  const plan = JSON.parse(REPLIES.PLAN);
  plan.external_actions = [{ kind: 'webhook_post', target, reason: 'operator asked to send the report' }];
  runner.replies.PLAN = JSON.stringify(plan);
  const { engine, db } = makeEngine(cfg, runner);
  const { task } = engine.createTask({ description: 'Compare libraries and send the report to the team hook' });
  await until(engine, () => status(db, task.id) === 'awaiting_approval');
  engine.decideApproval(pendingApproval(db, task.id)!.id, { decision: 'approve' });
  await until(engine, () => status(db, task.id) === 'completed');
  for (let i = 0; i < 5; i++) await engine.tick();
  assert.equal(hits.length, 0, 'report approval alone does not approve the external action');
  assert.equal((db.prepare('SELECT status FROM actions').get() as any).status, 'proposed');

  engine.decideApproval(pendingApproval(db, task.id, 'external_action')!.id, { decision: 'approve' });
  await until(engine, () => (db.prepare('SELECT status FROM actions').get() as any).status === 'done');
  assert.equal(hits.length, 1);

  // Restart: a new engine on the same database must not send it again.
  const again = makeEngine(cfg, runner, db).engine;
  again.recover();
  for (let i = 0; i < 5; i++) await again.tick();
  assert.equal(hits.length, 1);

  // An action caught mid-send by a crash is parked for review, not retried.
  db.prepare(`UPDATE actions SET status='executing'`).run();
  again.recover();
  for (let i = 0; i < 5; i++) await again.tick();
  assert.equal((db.prepare('SELECT status FROM actions').get() as any).status, 'needs_review');
  assert.equal(hits.length, 1);
  server.close();
});

test('external action to a destination not on the allowlist is refused even when approved', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  const plan = JSON.parse(REPLIES.PLAN);
  plan.external_actions = [{ kind: 'webhook_post', target: 'https://evil.example/hook', reason: 'x' }];
  runner.replies.PLAN = JSON.stringify(plan);
  const { engine, db } = makeEngine(cfg, runner);
  const { task } = engine.createTask({ description: 'Compare libraries and post them somewhere' });
  await until(engine, () => status(db, task.id) === 'awaiting_approval');
  engine.decideApproval(pendingApproval(db, task.id, 'external_action')!.id, { decision: 'approve' });
  engine.decideApproval(pendingApproval(db, task.id)!.id, { decision: 'approve' });
  await until(engine, () => (db.prepare('SELECT status FROM actions').get() as any).status === 'failed');
  assert.match((db.prepare('SELECT result_json FROM actions').get() as any).result_json, /not on actions.webhookAllowlist/);
});

test('timeout: bounded retry, then a useful failure', async () => {
  const cfg = tempStation((c) => (c.agents.commander.timeoutSec = 0.2));
  const runner = new ScriptedRunner();
  runner.behaviour = (stage, signal) => (stage === 'PLAN' ? hang(signal) : null);
  const { engine, db } = makeEngine(cfg, runner);
  db.exec(`UPDATE settings SET value_json = value_json`); // no-op; keeps db warm
  const { task } = engine.createTask({ description: 'This plan will hang every time' });
  // Skip the 15s backoff between attempts.
  const origTick = engine.tick.bind(engine);
  engine.tick = async () => {
    db.prepare(`UPDATE steps SET not_before = NULL WHERE status='queued'`).run();
    return origTick();
  };
  await until(engine, () => status(db, task.id) === 'failed', 8000);
  assert.equal(runner.calls.length, 2, 'exactly maxAttempts attempts');
  const t = db.prepare('SELECT error, error_detail FROM tasks WHERE id=?').get(task.id) as any;
  assert.match(t.error, /plan failed after 2 attempt\(s\): Commander timed out after 0s during plan/);
  assert.match(t.error_detail, /Retries exhausted/);
});

test('non-transient errors fail immediately without retry', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  runner.behaviour = (stage) => (stage === 'PLAN' ? Promise.reject(new GatewayError('OpenClaw invalid_request_error: unknown agent', { transient: false, httpStatus: 400 })) : null);
  const { engine, db } = makeEngine(cfg, runner);
  const { task } = engine.createTask({ description: 'Plan with a misconfigured agent id' });
  await until(engine, () => status(db, task.id) === 'failed');
  assert.equal(runner.calls.length, 1);
});

test('cancellation aborts the running agent call and discards late results', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  let aborted = false;
  runner.behaviour = (stage, signal) =>
    stage === 'RESEARCH'
      ? hang(signal).catch((e) => {
          aborted = true;
          throw e;
        })
      : null;
  const { engine, db } = makeEngine(cfg, runner);
  const { task } = engine.createTask({ description: 'Cancel me during research' });
  await until(engine, () => (db.prepare(`SELECT status FROM steps WHERE stage='research'`).get() as any)?.status === 'running');
  engine.cancelTask(task.id);
  await until(engine, () => aborted);
  assert.equal(status(db, task.id), 'cancelled');
  for (let i = 0; i < 5; i++) await engine.tick();
  assert.equal(db.prepare(`SELECT count(*) AS n FROM steps WHERE task_id=? AND stage='draft'`).get(task.id)!.n, 0, 'no further stages after cancel');
});

test('restart: an interrupted step is requeued and the task still completes', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  runner.behaviour = (stage, signal) => (stage === 'DRAFT' ? hang(signal) : null);
  const first = makeEngine(cfg, runner);
  const { task } = first.engine.createTask({ description: 'Survive a restart mid-draft' });
  await until(first.engine, () => (first.db.prepare(`SELECT status FROM steps WHERE stage='draft'`).get() as any)?.status === 'running');
  // Simulate a crash: the process dies, the row still says running.
  first.db.close();

  runner.behaviour = null;
  const second = makeEngine(cfg, runner);
  second.engine.recover();
  assert.equal((second.db.prepare(`SELECT status FROM steps WHERE stage='draft'`).get() as any).status, 'queued');
  await until(second.engine, () => status(second.db, task.id) === 'awaiting_approval');
  const plans = second.db.prepare(`SELECT count(*) AS n FROM steps WHERE stage='plan'`).get()!.n;
  assert.equal(plans, 1, 'completed stages are not re-run after restart');
});

test('daily token cap blocks new agent work with a clear reason', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  runner.tokensPerCall = 30_000;
  const { engine, db } = makeEngine(cfg, runner);
  setSetting(db, 'limits', { dailyTokenCap: 50_000, perTaskTokenCap: 400_000, dailyUsdLimit: 5 });
  const { task } = engine.createTask({ description: 'Use up the token budget quickly' });
  await until(engine, () => (db.prepare(`SELECT status FROM steps WHERE stage='research'`).get() as any)?.status === 'completed');
  for (let i = 0; i < 10; i++) {
    await engine.tick();
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(runner.calls.length, 2, 'no third call once 60k ≥ 50k cap');
  assert.equal(status(db, task.id), 'queued');
  const block = (db.prepare(`SELECT value_json FROM settings WHERE key='queue_block'`).get() as any).value_json;
  assert.match(block, /Daily token cap reached: 60,000 of 50,000 tokens/);
  setSetting(db, 'limits', { dailyTokenCap: 1_000_000, perTaskTokenCap: 400_000, dailyUsdLimit: 5 });
  await until(engine, () => status(db, task.id) === 'awaiting_approval');
});

test('at most two agent calls run at once', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  runner.delayMs = 40;
  const { engine, db } = makeEngine(cfg, runner);
  const ids = [1, 2, 3, 4].map((i) => engine.createTask({ description: `Parallel task number ${i}` }).task.id);
  await until(engine, () => ids.every((id) => status(db, id) === 'awaiting_approval'), 10000);
  assert.equal(runner.maxActive, 2);
});

test('task dependencies: waits for the dependency; fails if it is cancelled', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  const { engine, db } = makeEngine(cfg, runner);
  const a = engine.createTask({ description: 'First task in the chain' }).task.id;
  const b = engine.createTask({ description: 'Second task depends on first', dependsOn: [a] }).task.id;
  await until(engine, () => status(db, a) === 'awaiting_approval');
  assert.equal(db.prepare(`SELECT count(*) AS n FROM steps WHERE task_id=? AND status='completed'`).get(b)!.n, 0);
  engine.cancelTask(a);
  await until(engine, () => status(db, b) === 'failed');
  assert.match((db.prepare('SELECT error FROM tasks WHERE id=?').get(b) as any).error, /Dependency T-0001 cancelled/);
});

test('clarification round-trip re-plans with the operator answers', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  let first = true;
  runner.behaviour = (stage) => {
    if (stage !== 'PLAN' || !first) return null;
    first = false;
    return Promise.resolve({ responseId: 'c', status: 'completed', usage: usage(100), text: JSON.stringify({ status: 'needs_clarification', clarifying_questions: ['Which audience?'] }) });
  };
  const { engine, db } = makeEngine(cfg, runner);
  const { task } = engine.createTask({ description: 'Ambiguous research request' });
  await until(engine, () => !!pendingApproval(db, task.id, 'clarification'));
  assert.equal(status(db, task.id), 'awaiting_approval');
  assert.throws(() => engine.decideApproval(pendingApproval(db, task.id, 'clarification')!.id, { decision: 'approve', answers: [] }), /Answer every question/);
  engine.decideApproval(pendingApproval(db, task.id, 'clarification')!.id, { decision: 'approve', answers: ['Backend engineers'] });
  await until(engine, () => !!pendingApproval(db, task.id));
  const req = JSON.parse((db.prepare('SELECT request_json FROM tasks WHERE id=?').get(task.id) as any).request_json);
  assert.deepEqual(req.clarifications, [{ question: 'Which audience?', answer: 'Backend engineers' }]);
});

test('finalize refuses a draft that changed after approval', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  const { engine, db } = makeEngine(cfg, runner);
  const { task } = engine.createTask({ description: 'Tamper with the staged draft' });
  await until(engine, () => status(db, task.id) === 'awaiting_approval');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(cfg.stagingDir, 'T-0001', 'draft.md'), '# changed after approval');
  engine.decideApproval(pendingApproval(db, task.id)!.id, { decision: 'approve' });
  await until(engine, () => status(db, task.id) === 'failed');
  assert.match((db.prepare('SELECT error FROM tasks WHERE id=?').get(task.id) as any).error, /changed after it was approved/);
  assert.equal(existsSync(path.join(cfg.outputsDir)) && readdirSync(cfg.outputsDir).length, 0);
});

test('graceful shutdown requeues the running step without spending an attempt', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  runner.behaviour = (stage, signal) => (stage === 'RESEARCH' ? hang(signal) : null);
  const first = makeEngine(cfg, runner);
  const { task } = first.engine.createTask({ description: 'Stop the station cleanly mid-research' });
  await until(first.engine, () => (first.db.prepare(`SELECT status FROM steps WHERE stage='research'`).get() as any)?.status === 'running');
  await first.engine.stop();
  const row = first.db.prepare(`SELECT status, attempt FROM steps WHERE stage='research'`).get() as any;
  assert.deepEqual([row.status, row.attempt], ['queued', 0]);
  assert.equal(status(first.db, task.id), 'queued', 'task is not failed by a clean shutdown');
  runner.behaviour = null;
  const second = makeEngine(cfg, runner, first.db);
  second.engine.recover();
  await until(second.engine, () => status(second.db, task.id) === 'awaiting_approval');
});

test('retrying a failed task re-proposes actions its failure voided, not ones the operator rejected', async () => {
  const cfg = tempStation();
  const runner = new ScriptedRunner();
  const plan = JSON.parse(REPLIES.PLAN);
  plan.external_actions = [
    { kind: 'webhook_post', target: 'https://hooks.example/a', reason: 'send' },
    { kind: 'webhook_post', target: 'https://hooks.example/b', reason: 'also send' },
  ];
  runner.replies.PLAN = JSON.stringify(plan);
  let failDraft = true;
  runner.behaviour = (stage) => (stage === 'DRAFT' && failDraft ? Promise.reject(new GatewayError('bad config', { transient: false })) : null);
  const { engine, db } = makeEngine(cfg, runner);
  const { task } = engine.createTask({ description: 'Fail once, then retry' });
  await until(engine, () => db.prepare(`SELECT count(*) AS n FROM approvals WHERE kind='external_action' AND status='pending'`).get()!.n === 2);
  const b = db.prepare(`SELECT a.id FROM approvals a WHERE kind='external_action' AND json_extract(payload_json,'$.target')='https://hooks.example/b'`).get() as any;
  engine.decideApproval(b.id, { decision: 'reject' });
  await until(engine, () => status(db, task.id) === 'failed');
  failDraft = false;
  engine.retryTask(task.id);
  const pending = db.prepare(`SELECT json_extract(payload_json,'$.target') AS t FROM approvals WHERE kind='external_action' AND status='pending'`).all() as any[];
  assert.deepEqual(pending.map((p) => p.t), ['https://hooks.example/a']);
});
