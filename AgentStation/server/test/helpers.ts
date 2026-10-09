// Test-only helpers: a temporary station root, a scripted agent runner, and a
// scripted source fetcher. Nothing here is used by the running server.
import { mkdtempSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type StationConfig } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import type { AgentRunner, AgentRunResult, Health, Usage } from '../src/openclaw.ts';
import type { FetchAllResult } from '../src/sources.ts';
import { createHash } from 'node:crypto';

export function tempStation(mutate?: (cfg: StationConfig) => void): StationConfig {
  const root = mkdtempSync(path.join(tmpdir(), 'station-'));
  const real = path.resolve(import.meta.dirname, '..', '..');
  cpSync(path.join(real, 'config'), path.join(root, 'config'), { recursive: true });
  cpSync(path.join(real, 'memory'), path.join(root, 'memory'), { recursive: true });
  mkdirSync(path.join(root, 'outputs'));
  mkdirSync(path.join(root, 'staging'));
  const cfg = loadConfig({ STATION_ROOT: root, STATION_DATA_DIR: path.join(root, 'data') });
  cfg.queue.pollMs = 20;
  mutate?.(cfg);
  return cfg;
}

export const SOURCE_TEXT = [
  'Alpha library supports asynchronous requests. It is released under the MIT licence.',
  'Beta library is synchronous only. Its latest version is 2.0.',
];

export async function fakeFetch(): Promise<FetchAllResult> {
  return {
    sources: SOURCE_TEXT.map((content, i) => ({
      type: 'url' as const,
      url: `https://example.org/s${i + 1}`,
      title: `Source ${i + 1}`,
      content,
      retrievedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.length,
    })),
    errors: [],
  };
}

export const usage = (total: number): Usage => ({ inputTokens: total - 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: total, costUsd: null });

export const REPLIES: Record<string, string> = {
  PLAN: JSON.stringify({
    status: 'ready', clarifying_questions: [], title: 'Compare alpha and beta', objective: 'Compare the two libraries.', audience: 'tests',
    success_criteria: ['Covers async'], required_inputs: [], source_queries: [{ source: 'pypi', query: 'alpha' }], outline: ['Summary'],
    external_actions: [], notes: '',
  }),
  RESEARCH: JSON.stringify({
    findings: [
      { id: 'F1', claim: 'Alpha is async.', source: 'S1', quote: 'Alpha library supports asynchronous requests.' },
      { id: 'F2', claim: 'Beta is sync.', source: 'S2', quote: 'Beta library is synchronous only.' },
      { id: 'F3', claim: 'Invented.', source: 'S2', quote: 'Beta library is the fastest in the world.' },
    ],
    conflicts: [], gaps: [], injection_attempts: [],
  }),
  DRAFT:
    '<<<REPORT\n# Compare alpha and beta\n\n## Summary\n\nAlpha library supports asynchronous requests, which suits async services well [S1]. Beta library is synchronous only and so needs threads for concurrency [S2].\n\n## Open questions\n\n- Performance was not measured.\nREPORT>>>',
  REVIEW: JSON.stringify({ verdict: 'pass', issues: [], criteria: [], summary: 'Alpha is async; beta is not.', proposed_decisions: ['Prefer alpha for async work'] }),
};

export type Behaviour = (stage: string, signal: AbortSignal) => Promise<AgentRunResult> | null;

export class ScriptedRunner implements AgentRunner {
  calls: { agentId: string; stage: string }[] = [];
  active = 0;
  maxActive = 0;
  behaviour: Behaviour | null = null;
  replies: Record<string, string> = { ...REPLIES };
  tokensPerCall = 1000;
  delayMs = 5;

  async health(): Promise<Health> {
    return { connected: true, ready: true, checkedAt: new Date().toISOString(), detail: 'ready' };
  }

  async run(agentId: string, input: string, opts: { signal: AbortSignal }): Promise<AgentRunResult> {
    const stage = /# Station request: (\w+)/.exec(input)?.[1] ?? '?';
    this.calls.push({ agentId, stage });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const custom = this.behaviour?.(stage, opts.signal);
      if (custom) return await custom;
      await sleep(this.delayMs, opts.signal);
      return { responseId: `r${this.calls.length}`, text: this.replies[stage] ?? '{}', usage: usage(this.tokensPerCall), status: 'completed' };
    } finally {
      this.active--;
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    });
  });
}

export const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted'))));

export function makeEngine(cfg: StationConfig, runner: AgentRunner, db?: DB) {
  const database = db ?? openDb(cfg.dbPath);
  const engine = new Engine({
    db: database,
    cfg,
    runner,
    health: () => ({ connected: true, ready: true, checkedAt: '', detail: 'ready' }),
    fetchSources: fakeFetch,
  });
  return { engine, db: database };
}

// Drive the queue by hand until a condition holds.
export async function until(engine: Engine, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await engine.tick();
    if (cond()) return;
    await sleep(15);
  }
  throw new Error('condition not reached in time');
}
