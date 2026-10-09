// Usage accounting and limit enforcement. Only numbers reported by the
// backend are recorded. Nothing here estimates cost.
import { getSetting, nowIso, type DB } from './db.ts';
import type { StationConfig } from './config.ts';
import type { Usage } from './openclaw.ts';
import { stationDay } from './memory.ts';

export interface Limits {
  dailyTokenCap: number;
  perTaskTokenCap: number;
  dailyUsdLimit: number;
}

export function currentLimits(db: DB, cfg: StationConfig): Limits {
  return getSetting<Limits>(db, 'limits', cfg.limits);
}

export function recordUsage(db: DB, cfg: StationConfig, r: { taskId: number; stepId: number; agent: string; usage: Usage }): void {
  const u = r.usage;
  db.prepare(
    `INSERT INTO usage (ts, day, task_id, step_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'openclaw:/v1/responses')`,
  ).run(nowIso(), stationDay(cfg), r.taskId, r.stepId, r.agent, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.totalTokens, u.costUsd);
  db.prepare('UPDATE tasks SET tokens_total = tokens_total + ? WHERE id = ?').run(u.totalTokens, r.taskId);
  if (u.costUsd !== null) {
    db.prepare('UPDATE tasks SET cost_usd = coalesce(cost_usd, 0) + ? WHERE id = ?').run(u.costUsd, r.taskId);
  }
}

export interface UsageSummary {
  day: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  callsWithoutUsage: number;
  outputChars: number;
  outputTokensNote: string;
  costUsd: number | null;
  costAvailable: boolean;
  costNote: string;
  limits: Limits;
  blocked: boolean;
  blockReason: string | null;
}

export function usageSummary(db: DB, cfg: StationConfig): UsageSummary {
  const day = stationDay(cfg);
  const row = db
    .prepare(
      `SELECT count(*) AS calls, coalesce(sum(total_tokens),0) AS tokens, coalesce(sum(input_tokens),0) AS input,
              coalesce(sum(output_tokens),0) AS output, coalesce(sum(cache_read_tokens),0) AS cread,
              coalesce(sum(cache_write_tokens),0) AS cwrite, sum(cost_usd) AS cost,
              sum(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS nocost
       FROM usage WHERE day = ?`,
    )
    .get(day) as Record<string, number | null>;
  const chars = db.prepare(`SELECT coalesce(sum(length(s.raw_output)),0) AS n FROM steps s JOIN usage u ON u.step_id = s.id WHERE u.day = ?`).get(day) as { n: number };
  const missing = db.prepare(`SELECT count(*) AS n FROM steps WHERE executor = 'openclaw' AND status = 'completed' AND usage_json IS NULL AND substr(finished_at,1,10) = ?`).get(day) as { n: number };
  const limits = currentLimits(db, cfg);
  const tokens = Number(row.tokens);
  const costAvailable = Number(row.calls) > 0 && Number(row.nocost) === 0;
  const cost = costAvailable ? Number(row.cost) : null;
  let blockReason: string | null = null;
  if (tokens >= limits.dailyTokenCap) {
    blockReason = `Daily token cap reached: ${tokens.toLocaleString('en-US')} of ${limits.dailyTokenCap.toLocaleString('en-US')} tokens used today (${day}, ${cfg.timezone}).`;
  } else if (cost !== null && cost >= limits.dailyUsdLimit) {
    blockReason = `Daily spending limit reached: $${cost.toFixed(2)} of $${limits.dailyUsdLimit.toFixed(2)}.`;
  }
  return {
    day,
    tokens,
    inputTokens: Number(row.input),
    outputTokens: Number(row.output),
    cacheReadTokens: Number(row.cread),
    cacheWriteTokens: Number(row.cwrite),
    calls: Number(row.calls),
    callsWithoutUsage: missing.n,
    outputChars: chars.n,
    outputTokensNote:
      'Output token counts are as reported by OpenClaw. On the claude-cli route they look incomplete (single-digit counts for multi-page replies), so treat totals as a lower bound. Input tokens make up nearly all of the total and are counted in full.',
    costUsd: cost,
    costAvailable,
    costNote: costAvailable
      ? 'Cost as reported by the backend.'
      : 'Cost unavailable: the Claude subscription route (claude-cli) reports tokens, not dollars. The dollar limit cannot be enforced; the daily token cap is enforced instead.',
    limits,
    blocked: blockReason !== null,
    blockReason,
  };
}
