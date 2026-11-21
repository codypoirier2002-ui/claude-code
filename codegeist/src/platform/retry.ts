/**
 * Sends a Teamwork Graph query again when it failed in a way that can pass a
 * moment later.
 *
 * The graph API is in Preview. Rate limits and gateway errors come and go, and
 * some sites refuse a share of identical reads with "User is not permitted to
 * query this organization" while answering the rest in the same second. A
 * single try would turn each of those into missing context.
 */
import { isFailure, isTransient, QUERY_FIELDS, type GraphQlResponse } from '../core/graph';
import { needsUserConsent } from './consent';
import type { GraphClient } from './graph';

export interface RetryPolicy {
  /** Tries per query, including the first. */
  attempts: number;
  /** No new try starts once it would begin this many milliseconds after the first. */
  budgetMs: number;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Returns a number from 0 up to 1, used to spread retries apart. */
  random(): number;
}

/**
 * Eight tries inside six seconds. At a 70% failure rate that leaves about 6% of
 * queries unanswered, and it keeps a panel load well inside Forge's 25-second
 * limit and the roughly 20 seconds Rovo waits for an action.
 */
export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 8,
  budgetMs: 6000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  random: () => Math.random(),
};

const FIRST_WAIT_MS = 100;
const MAX_WAIT_MS = 800;
const JITTER_MS = 100;

/** The wait before the try that follows try number `attempt` (1 for the first). */
export function waitBefore(attempt: number, random: () => number): number {
  return Math.min(FIRST_WAIT_MS * 2 ** (attempt - 1), MAX_WAIT_MS) + Math.floor(random() * JITTER_MS);
}

type Outcome = { response: GraphQlResponse } | { error: unknown };

/**
 * Wraps a graph client so transient failures are tried again. The caller gets
 * the last answer, or the last error, exactly as a single try would give it.
 */
export function withRetry(client: GraphClient, policy: RetryPolicy = DEFAULT_RETRY): GraphClient {
  return {
    async query(name, variables) {
      const startedAt = policy.now();
      for (let attempt = 1; ; attempt += 1) {
        const outcome: Outcome = await client.query(name, variables).then(
          (response) => ({ response }),
          (error: unknown) => ({ error }),
        );
        const wait = waitBefore(attempt, policy.random);
        const spent = attempt >= policy.attempts || policy.now() - startedAt + wait > policy.budgetMs;
        if ('error' in outcome) {
          // A missing consent is not a fault to retry. The caller decides what to do with it.
          if (spent || needsUserConsent(outcome.error)) throw outcome.error;
        } else if (spent || !isFailure(outcome.response, QUERY_FIELDS[name]) || !isTransient(outcome.response)) {
          return outcome.response;
        }
        await policy.sleep(wait);
      }
    },
  };
}
