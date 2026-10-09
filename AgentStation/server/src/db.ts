// SQLite state store. Everything the station knows about tasks lives here so
// a restart loses nothing. Uses Node's built-in node:sqlite (no native deps).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type TaskStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
export const TASK_STATUSES: TaskStatus[] = ['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'];
export type StepStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type Stage = 'plan' | 'fetch' | 'research' | 'draft' | 'review' | 'approval' | 'finalize';

export interface TaskRow {
  id: number;
  title: string;
  description: string;
  request_json: string;
  status: TaskStatus;
  stage: Stage | null;
  assigned_agent: string | null;
  depends_on_json: string;
  project: string | null;
  output_path: string | null;
  approval_required: number;
  error: string | null;
  error_detail: string | null;
  idempotency_key: string | null;
  cancel_requested: number;
  revisions: number;
  tokens_total: number;
  cost_usd: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface StepRow {
  id: number;
  task_id: number;
  stage: Stage;
  agent: string;
  executor: 'openclaw' | 'station';
  status: StepStatus;
  depends_on_json: string;
  attempt: number;
  max_attempts: number;
  timeout_ms: number;
  input_json: string;
  output_json: string | null;
  raw_output: string | null;
  error: string | null;
  openclaw_response_id: string | null;
  usage_json: string | null;
  tokens_total: number;
  memory_sha256: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  not_before: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const SCHEMA_V1 = `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','awaiting_approval','completed','failed','cancelled')),
  stage TEXT,
  assigned_agent TEXT,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  project TEXT,
  output_path TEXT,
  approval_required INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  error_detail TEXT,
  idempotency_key TEXT UNIQUE,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  revisions INTEGER NOT NULL DEFAULT 0,
  tokens_total INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX tasks_status ON tasks(status);

CREATE TABLE steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  stage TEXT NOT NULL,
  agent TEXT NOT NULL,
  executor TEXT NOT NULL CHECK (executor IN ('openclaw','station')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  raw_output TEXT,
  error TEXT,
  openclaw_response_id TEXT,
  usage_json TEXT,
  tokens_total INTEGER NOT NULL DEFAULT 0,
  memory_sha256 TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  not_before TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX steps_status ON steps(status);
CREATE INDEX steps_task ON steps(task_id);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  ref TEXT NOT NULL,
  source_type TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content TEXT NOT NULL,
  UNIQUE (task_id, ref)
);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('final_report','external_action','clarification')),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','void')),
  payload_json TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX approvals_status ON approvals(status);

CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','executing','done','failed','rejected','needs_review')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  task_id INTEGER,
  step_id INTEGER,
  agent TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  source TEXT NOT NULL
);
CREATE INDEX usage_day ON usage(day);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER,
  agent TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX events_task ON events(task_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id_sha256 TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

const MIGRATIONS = [SCHEMA_V1];

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

export const nowIso = () => new Date().toISOString();

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as T) : fallback;
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), nowIso());
}

export const taskLabel = (id: number) => `T-${String(id).padStart(4, '0')}`;
