import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { loadMemory, memoryBlockFor, recordCompletion, newestDecisions } from '../src/memory.ts';

function tempStation() {
  const root = mkdtempSync(path.join(tmpdir(), 'station-'));
  const real = path.resolve(import.meta.dirname, '..', '..');
  cpSync(path.join(real, 'config'), path.join(root, 'config'), { recursive: true });
  cpSync(path.join(real, 'memory'), path.join(root, 'memory'), { recursive: true });
  mkdirSync(path.join(root, 'outputs'));
  return loadConfig({ STATION_ROOT: root, STATION_DATA_DIR: path.join(root, 'data') });
}

test('schema migrates once and survives reopen', () => {
  const cfg = tempStation();
  const db = openDb(cfg.dbPath);
  db.prepare(
    `INSERT INTO tasks (title, description, request_json, status, created_at, updated_at) VALUES ('t','d','{}','queued','x','x')`,
  ).run();
  db.close();
  const db2 = openDb(cfg.dbPath);
  const row = db2.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number };
  assert.equal(row.n, 1);
  assert.throws(() =>
    db2.prepare(`INSERT INTO tasks (title, description, request_json, status, created_at, updated_at) VALUES ('t','d','{}','bogus','x','x')`).run(),
  );
});

test('memory: role-specific reads and approved writes', () => {
  const cfg = tempStation();
  const snap = loadMemory(cfg, 'Python Tooling');
  assert.match(memoryBlockFor('commander', snap), /Recent decisions/);
  assert.match(memoryBlockFor('commander', snap), /projects\/python-tooling\.md/);
  assert.doesNotMatch(memoryBlockFor('researcher', snap), /Goals/);
  assert.match(memoryBlockFor('researcher', snap), /Rules/);
  assert.equal(snap.sha256.length, 64);

  recordCompletion(cfg, {
    taskLabel: 'T-0001',
    title: 'Compare HTTP clients',
    project: 'Python Tooling',
    outputRelPath: 'outputs/2026-10-09-t-0001.md',
    sourceCount: 3,
    tokens: 1234,
    summary: '# injected heading\nhttpx supports HTTP/2.',
    decisions: ['Prefer httpx for new async code'],
  });
  const after = loadMemory(cfg, 'Python Tooling');
  assert.notEqual(after.sha256, snap.sha256, 'snapshot hash changes when memory changes');
  assert.match(after.decisions, /Prefer httpx for new async code \(T-0001, approved by operator\)/);
  assert.match(after.project ?? '', /Compare HTTP clients/);
  const daily = readFileSync(path.join(cfg.memoryDir, 'daily', `${new Date().toISOString().slice(0, 10)}.md`), 'utf8');
  assert.match(daily, /T-0001 \*\*Compare HTTP clients\*\*: completed/);
  assert.doesNotMatch(daily, /\n# injected/, 'agent text cannot inject headings');
});

test('newestDecisions keeps only the last N entries with continuations', () => {
  const text = '# D\n\n- a\n  more a\n- b\n- c\n';
  assert.equal(newestDecisions(text, 2), '- b\n- c');
  assert.equal(newestDecisions(text, 5), '- a\n  more a\n- b\n- c');
});
