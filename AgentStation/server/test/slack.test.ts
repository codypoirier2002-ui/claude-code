import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, chmodSync } from 'node:fs';
import { tempStation, ScriptedRunner, makeEngine, until, REPLIES } from './helpers.ts';
import { prepareSlackPost, resolveAction } from '../src/actions.ts';
import { slackMessage, slackWebhook, SLACK_MAX_CHARS } from '../src/slack.ts';
import { buildState } from '../src/state.ts';
import type { StationConfig } from '../src/config.ts';
import type { DB } from '../src/db.ts';
import type { Engine } from '../src/engine.ts';

// Built from parts and shorter than a real token, so it is plainly not a credential.
const SECRET = ['test', 'secret', 'not', 'real', '1234'].join('');
const HOOK = `https://hooks.slack.com/services/T000/B000/${SECRET}`;

const status = (db: DB, id: number) => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as { status: string }).status;
const pending = (db: DB, taskId: number, kind = 'final_report') =>
  db.prepare(`SELECT id, payload_json FROM approvals WHERE task_id=? AND kind=? AND status='pending'`).get(taskId, kind) as { id: number; payload_json: string } | undefined;
const action = (db: DB, id: number) => db.prepare('SELECT * FROM actions WHERE id=?').get(id) as any;

function setHook(cfg: StationConfig, url: string | null, mode = 0o600) {
  writeFileSync(cfg.secretsFile, `STATION_ADMIN_TOKEN=x\n${url ? `SLACK_WEBHOOK_URL=${url}\n` : ''}`);
  chmodSync(cfg.secretsFile, mode);
}

type Reply = () => Response | Promise<Response>;
// Stands in for Slack: records each request and answers with the next reply.
function fakeSlack(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    const next = replies.shift() ?? (() => new Response('ok'));
    return next();
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

async function completedTask(engine: Engine, db: DB, description = 'Compare alpha and beta libraries'): Promise<number> {
  const { task } = engine.createTask({ description });
  await until(engine, () => status(db, task.id) === 'awaiting_approval');
  engine.decideApproval(pending(db, task.id)!.id, { decision: 'approve' });
  await until(engine, () => status(db, task.id) === 'completed');
  return task.id;
}

function approvePost(engine: Engine, db: DB, taskId: number) {
  const a = pending(db, taskId, 'external_action')!;
  engine.decideApproval(a.id, { decision: 'approve' });
  return JSON.parse(a.payload_json);
}

test('Slack message: untrusted text cannot mention, link, or break out; long reports are cut to fit', () => {
  const msg = slackMessage({
    taskLabel: 'T-0001',
    title: 'Tools <!channel> & @here',
    report: '---\ntask: T-0001\n---\n\n# Title\n\n## Summary\n\n**Pick alpha** [S1]. See [docs](https://example.org/a?x=1&y=2).\n- one <@U123>\n- two\n\n## Details\n\nNOT IN SLACK\n\n## Sources\n',
    sources: [{ ref: 'S1', title: 'Evil <https://evil.example|click here>', url: 'https://example.org/s1?a=1&b=2' }],
    reviewVerdict: 'pass',
    approvedAt: '2026-10-10T23:28:20.302Z',
    outputPath: 'outputs/x.md',
  });
  assert.ok(!msg.includes('<'), 'no raw angle brackets: no mentions or links can form');
  assert.match(msg, /Tools &lt;!channel&gt; &amp; @\u2060here/);
  assert.match(msg, /one &lt;@\u2060U123&gt;/);
  assert.match(msg, /Evil &lt;https:\/\/evil\.example\|click here&gt;/);
  assert.match(msg, /\*Summary\*\n\n\*Pick alpha\* \[S1\]\. See docs \(https:\/\/example\.org\/a\?x=1&amp;y=2\)\./);
  assert.match(msg, /• one/);
  assert.ok(!msg.includes('NOT IN SLACK'), 'only the first section is posted');
  assert.match(msg, /approved 2026-10-10 23:28 UTC/);

  const long = slackMessage({
    taskLabel: 'T-0002', title: 'Long', report: `# Long\n\n## Summary\n\n${`${'A sentence that goes on. '.repeat(40)}\n`.repeat(20)}`,
    sources: Array.from({ length: 8 }, (_, i) => ({ ref: `S${i + 1}`, title: 'x'.repeat(200), url: `https://example.org/${i}` })),
    reviewVerdict: 'pass', approvedAt: '2026-10-10T00:00:00Z', outputPath: 'outputs/long.md',
  });
  assert.ok(long.length <= SLACK_MAX_CHARS);
  assert.match(long, /…\n\n\*Sources\*/, 'the summary is cut, not the sources');
  assert.match(long, /S8: x{120} \(https:\/\/example\.org\/7\)\n\nFull report on the station: outputs\/long\.md/);
});

test('Slack setup status: missing, unsafe file, wrong URL, set, and Demo Mode', () => {
  const cfg = tempStation();
  assert.deepEqual(slackWebhook(cfg).status, { configured: false, hint: null, problem: null, setupFile: cfg.secretsFile });
  setHook(cfg, HOOK, 0o644);
  assert.match(slackWebhook(cfg).status.problem!, /readable by other users; run: chmod 600/);
  setHook(cfg, 'https://hooks.slack.com.evil.example/services/T000/B000/abc');
  assert.match(slackWebhook(cfg).status.problem!, /not a Slack incoming webhook URL/);
  setHook(cfg, 'https://hooks.slack.com/workflows/T000/A000/1/abc');
  assert.equal(slackWebhook(cfg).url, null);
  setHook(cfg, HOOK);
  assert.deepEqual(slackWebhook(cfg), { url: HOOK, status: { configured: true, hint: '…1234', problem: null, setupFile: cfg.secretsFile } });
  cfg.mode = 'demo';
  assert.deepEqual(slackWebhook(cfg), { url: null, status: { configured: false, hint: null, problem: 'Demo Mode never posts to Slack.', setupFile: cfg.secretsFile } });
  assert.throws(() => prepareSlackPost(null as unknown as DB, cfg, 1), /Demo Mode never posts to Slack/);
});

test('Post to Slack: nothing is sent before approval, exactly one post after, the URL never leaves the server', async () => {
  const cfg = tempStation();
  const { engine, db } = makeEngine(cfg, new ScriptedRunner());
  const taskId = await completedTask(engine, db);
  assert.throws(() => prepareSlackPost(db, cfg, taskId), /Slack is not set up\. Add SLACK_WEBHOOK_URL/);
  setHook(cfg, HOOK);
  const slack = fakeSlack();
  try {
    const actionId = prepareSlackPost(db, cfg, taskId);
    assert.throws(() => prepareSlackPost(db, cfg, taskId), /already has a Slack post waiting/);
    for (let i = 0; i < 5; i++) await engine.tick();
    assert.equal(slack.calls.length, 0, 'preparing a post sends nothing');
    assert.equal(action(db, actionId).status, 'proposed');

    const shown = approvePost(engine, db, taskId);
    assert.match(shown.text, /^\*T-0001 · Compare alpha and beta\*/);
    await until(engine, () => action(db, actionId).status === 'done');
    for (let i = 0; i < 5; i++) await engine.tick();
    assert.equal(slack.calls.length, 1);
    const [call] = slack.calls;
    assert.equal(call.url, HOOK);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.equal((call.init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.deepEqual(call.body, { text: shown.text, unfurl_links: false, unfurl_media: false }, 'exactly the approved text');
    assert.throws(() => prepareSlackPost(db, cfg, taskId), /already posted to Slack/);

    const health = { connected: true, ready: true, checkedAt: '', detail: 'ready' };
    const state = buildState(db, cfg, engine, health);
    assert.equal(state.integrations.slack.configured, true);
    assert.equal(state.integrations.slack.lastPost?.status, 'done');
    const everything = JSON.stringify([state, ...['actions', 'approvals', 'events', 'settings', 'steps'].map((t) => db.prepare(`SELECT * FROM ${t}`).all())]);
    assert.ok(!everything.includes(SECRET), 'webhook secret is not in state or the database');
  } finally {
    slack.restore();
  }
});

test('Slack refusals fail cleanly; lost answers and server errors wait for review; a changed webhook blocks the post', async () => {
  const cfg = tempStation();
  setHook(cfg, HOOK);
  const { engine, db } = makeEngine(cfg, new ScriptedRunner());
  const taskId = await completedTask(engine, db);
  const slack = fakeSlack(
    () => new Response('no_service', { status: 404 }),
    () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })),
    () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    () => new Response('ok'),
  );
  const outcome = async (want: string) => {
    const id = prepareSlackPost(db, cfg, taskId);
    approvePost(engine, db, taskId);
    await until(engine, () => action(db, id).status === want);
    return action(db, id);
  };
  try {
    const refused = await outcome('failed');
    assert.match(refused.result_json, /refused it with HTTP 404: no_service\. Nothing was sent/);
    const unreachable = await outcome('failed');
    assert.match(unreachable.result_json, /could not connect \(ECONNREFUSED\)\. Nothing was sent/);
    const lost = await outcome('needs_review');
    assert.match(lost.result_json, /timed out after 20s/);
    assert.equal(JSON.parse(lost.result_json).maybeSent, true);
    assert.throws(() => prepareSlackPost(db, cfg, taskId), /waiting \(action #\d+, needs review\)/);
    for (let i = 0; i < 3; i++) await engine.tick();
    assert.equal(slack.calls.length, 3, 'a post that may have arrived is not retried on its own');
    resolveAction(db, lost.id, 'retry');
    await until(engine, () => action(db, lost.id).status === 'done');
    assert.equal(slack.calls.length, 4);
    assert.equal(slack.calls[3].body.text, slack.calls[2].body.text, 'retry sends the same approved text');

    // Webhook swapped after approval: refused before anything is sent.
    const other = await completedTask(engine, db, 'Second report');
    const id = prepareSlackPost(db, cfg, other);
    approvePost(engine, db, other);
    setHook(cfg, `https://hooks.slack.com/services/T000/B999/${SECRET}`);
    await until(engine, () => action(db, id).status === 'failed');
    assert.match(action(db, id).result_json, /webhook changed after this post was approved/);
    assert.equal(slack.calls.length, 4);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM events').all()).includes(SECRET));
  } finally {
    slack.restore();
  }
});

test('a Slack post the Commander proposes gets its text when the report is approved, and only then can be approved', async () => {
  const cfg = tempStation();
  setHook(cfg, HOOK);
  const runner = new ScriptedRunner();
  const plan = JSON.parse(REPLIES.PLAN);
  plan.external_actions = [{ kind: 'slack_post', target: '#general', reason: 'operator asked to share it in Slack' }];
  runner.replies.PLAN = JSON.stringify(plan);
  const { engine, db } = makeEngine(cfg, runner);
  const slack = fakeSlack();
  try {
    const { task } = engine.createTask({ description: 'Compare libraries and share the result in Slack' });
    await until(engine, () => status(db, task.id) === 'awaiting_approval');
    const a = db.prepare('SELECT * FROM actions').get() as any;
    assert.equal(a.target, 'slack', 'a webhook posts to one fixed channel');
    const early = pending(db, task.id, 'external_action')!;
    assert.equal(JSON.parse(early.payload_json).text, undefined);
    assert.throws(() => engine.decideApproval(early.id, { decision: 'approve' }), /written when the report is approved/);
    assert.ok(pending(db, task.id, 'external_action'), 'refusal leaves it pending');

    engine.decideApproval(pending(db, task.id)!.id, { decision: 'approve' });
    await until(engine, () => status(db, task.id) === 'completed');
    for (let i = 0; i < 3; i++) await engine.tick();
    assert.equal(slack.calls.length, 0);
    const shown = approvePost(engine, db, task.id);
    assert.match(shown.text, /Approved research report from AgentStation/);
    await until(engine, () => action(db, a.id).status === 'done');
    assert.equal(slack.calls.length, 1);
    assert.equal(slack.calls[0].body.text, shown.text);
  } finally {
    slack.restore();
  }
});

test('approving a Slack post is refused while Slack is not set up', async () => {
  const cfg = tempStation();
  setHook(cfg, HOOK);
  const { engine, db } = makeEngine(cfg, new ScriptedRunner());
  const taskId = await completedTask(engine, db);
  const id = prepareSlackPost(db, cfg, taskId);
  setHook(cfg, null);
  assert.throws(() => approvePost(engine, db, taskId), /Slack is not set up/);
  assert.equal(action(db, id).status, 'proposed');
});

test('a generic webhook that answers 503 may have acted, so it waits for review instead of failing', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.statusCode = 503;
    res.end('busy');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const target = `http://127.0.0.1:${(server.address() as any).port}/hook`;
  const cfg = tempStation((c) => (c.actions.webhookAllowlist = [target]));
  const runner = new ScriptedRunner();
  const plan = JSON.parse(REPLIES.PLAN);
  plan.external_actions = [{ kind: 'webhook_post', target, reason: 'send it' }];
  runner.replies.PLAN = JSON.stringify(plan);
  const { engine, db } = makeEngine(cfg, runner);
  try {
    const taskId = await completedTask(engine, db);
    engine.decideApproval(pending(db, taskId, 'external_action')!.id, { decision: 'approve' });
    await until(engine, () => (db.prepare('SELECT status FROM actions').get() as any).status === 'needs_review');
    assert.match((db.prepare('SELECT result_json FROM actions').get() as any).result_json, /HTTP 503: busy/);
  } finally {
    server.close();
  }
});

test('Slack message: many long source URLs never push out the footer or cut an escape; URLs with "@" stay intact', () => {
  const longUrl = (i: number) => `https://example.org/${i}?q=${'a&b'.repeat(30)}`;
  const msg = slackMessage({
    taskLabel: 'T-0003', title: 'Long sources', report: `# T\n\n## Summary\n\n${'word&amp; '.repeat(800)}\n`,
    sources: Array.from({ length: 12 }, (_, i) => ({ ref: `S${i + 1}`, title: `Source ${i + 1}`, url: longUrl(i) })),
    reviewVerdict: 'pass', approvedAt: '2026-10-10T00:00:00Z', outputPath: 'outputs/long-sources.md',
  });
  assert.ok(msg.length <= SLACK_MAX_CHARS, `length ${msg.length}`);
  assert.match(msg, /\nFull report on the station: outputs\/long-sources\.md \(approved 2026-10-10 00:00 UTC\)\.$/);
  assert.match(msg, /…and \d+ more in the report\./);
  assert.ok(!/&[a-z]*(?![a-z;])/.test(msg.replace(/&(amp|lt|gt);/g, '')), 'no half-cut entity anywhere');
  assert.ok(msg.split('\n').filter((l) => l.startsWith('• S')).every((l) => l.includes(`(${longUrl(Number(l.slice(3, l.indexOf(':'))) - 1).replace(/&/g, '&amp;')})`)), 'listed URLs are whole');

  const at = slackMessage({
    taskLabel: 'T-0004', title: 'At signs', report: '# T\n\n## Summary\n\nRead [the post](https://medium.com/@bob/post); ping @here; mail a@b.org.\n',
    sources: [{ ref: 'S1', title: '@scope/pkg', url: 'https://www.npmjs.com/package/@scope/pkg' }],
    reviewVerdict: 'pass', approvedAt: '2026-10-10T00:00:00Z', outputPath: 'outputs/at.md',
  });
  assert.match(at, /the post \(https:\/\/medium\.com\/@bob\/post\)/);
  assert.match(at, /\(https:\/\/www\.npmjs\.com\/package\/@scope\/pkg\)/);
  assert.match(at, /ping @⁠here; mail a@b\.org/);
  assert.match(at, /S1: @⁠scope\/pkg/);
});

test('marking an unconfirmed post as done clears its old error, so the status line does not contradict itself', async () => {
  const cfg = tempStation();
  setHook(cfg, HOOK);
  const { engine, db } = makeEngine(cfg, new ScriptedRunner());
  const taskId = await completedTask(engine, db);
  const slack = fakeSlack(() => Promise.reject(new DOMException('timeout', 'TimeoutError')));
  try {
    const id = prepareSlackPost(db, cfg, taskId);
    approvePost(engine, db, taskId);
    await until(engine, () => action(db, id).status === 'needs_review');
    resolveAction(db, id, 'mark_done');
    const lastPost = buildState(db, cfg, engine, { connected: true, ready: true, checkedAt: '', detail: 'ready' }).integrations.slack.lastPost;
    assert.deepEqual([lastPost?.status, lastPost?.error], ['done', null]);
    // A send interrupted by a restart is described as interrupted, not by an older error.
    db.prepare(`UPDATE actions SET status='executing', result_json='{"error":"old","maybeSent":true}' WHERE id=?`).run(id);
    engine.recover();
    assert.equal(action(db, id).result_json, null);
  } finally {
    slack.restore();
  }
});
