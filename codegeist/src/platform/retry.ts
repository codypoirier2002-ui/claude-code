/**
 * Sends a Teamwork Graph query again when it failed in a way that can pass a
 * moment later.
 *
 * The graph API is in Preview. Rate limits and gateway errors come and go, and
 * some sites refuse a share of identical reads with "User is not permitted to
 * query this organization" while answering the rest in the same second. A
 * single try would turn each of those into missing context.
 *
 * The same errors can also be lasting, so retries have to earn their cost:
 * a query gets only a few tries until some query of the same load has answered,
 * a rate limit slows every query down, and nothing is retried once another try
 * would not fit in the time budget.
 */
import { isFailure, isRateLimited, isTransient, QUERY_FIELDS, type GraphQlResponse } from '../core/graph';
import type { GraphClient } from './graph';

export interface RetryPolicy {
  /** Tries per query, including the first. */
  attempts: number;
  /**
   * Tries per query while no query of the same load has answered. More are
   * spent only once one has, which shows that the failures are passing ones.
   */
  attemptsBeforeAnswer: number;
  /** Retrying stops once another try, as long as the last one, would end after this many milliseconds. */
  budgetMs: number;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Returns a number from 0 up to 1, used to spread retries apart. */
  random(): number;
}

/**
 * Up to eight tries inside six seconds. At a 70% failure rate that leaves 6% to
 * 9% of queries unanswered, fewer the more queries a load sends. A graph that
 * answers nothing costs three tries a query and about a second, and a load
 * stays well inside Forge's 25-second limit and the roughly 20 seconds Rovo
 * waits for an action.
 */
export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 8,
  attemptsBeforeAnswer: 3,
  budgetMs: 6000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  random: () => Math.random(),
};

const FIRST_WAIT_MS = 100;
const MAX_WAIT_MS = 800;
const JITTER_MS = 100;
/** After a rate limit: two more tries at most, a second and then two seconds apart. */
const RATE_LIMIT_WAITS_MS = [1000, 2000];
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const NETWORK_FAULT = /socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|network|fetch failed|tim(?:ed?)?[ -]?out/i;

/** The wait before the try that follows try number `attempt` (1 for the first). */
export function waitBefore(attempt: number, random: () => number): number {
  return Math.min(FIRST_WAIT_MS * 2 ** (attempt - 1), MAX_WAIT_MS) + Math.floor(random() * JITTER_MS);
}

interface Thrown {
  name?: unknown;
  message?: unknown;
  status?: unknown;
}

function proxyStatus(error: unknown): number | undefined {
  const { name, status } = (typeof error === 'object' && error !== null ? error : {}) as Thrown;
  return name === 'PROXY_ERR' && typeof status === 'number' ? status : undefined;
}

/**
 * True for a thrown error worth another try: a network fault, or a rate-limit
 * or gateway answer from Forge's proxy. Everything else, the consent error
 * included, would fail the same way again.
 */
export function isTransientError(error: unknown): boolean {
  const { name, message } = (typeof error === 'object' && error !== null ? error : {}) as Thrown;
  if (name === 'FUNCTION_FETCH_ERR') return true;
  if (name === 'PROXY_ERR') return RETRY_STATUS.has(proxyStatus(error) ?? 0);
  return typeof message === 'string' && NETWORK_FAULT.test(message);
}

type Outcome = { response: GraphQlResponse } | { error: unknown };

/**
 * Wraps a graph client so transient failures are tried again. The caller gets
 * the last answer, or the last error, exactly as a single try would give it.
 *
 * Create one wrapper per panel load or action: what its queries learn about the
 * graph (it answers, it is rate limiting) is shared between them.
 */
export function withRetry(client: GraphClient, policy: RetryPolicy = DEFAULT_RETRY): GraphClient {
  let answered = false;
  let rateLimited = false;
  return {
    async query(name, variables) {
      const startedAt = policy.now();
      for (let attempt = 1; ; attempt += 1) {
        const calledAt = policy.now();
        const outcome: Outcome = await client.query(name, variables).then(
          (response) => ({ response }),
          (error: unknown) => ({ error }),
        );
        const give = (): GraphQlResponse => {
          if ('error' in outcome) throw outcome.error;
          return outcome.response;
        };

        let transient: boolean;
        if ('error' in outcome) {
          transient = isTransientError(outcome.error);
          rateLimited ||= proxyStatus(outcome.error) === 429;
        } else if (!isFailure(outcome.response, QUERY_FIELDS[name])) {
          answered = true;
          return outcome.response;
        } else {
          transient = isTransient(outcome.response);
          rateLimited ||= isRateLimited(outcome.response);
        }
        if (!transient || attempt >= policy.attempts) return give();

        // Once any query is rate limited, every query slows down and gives up sooner.
        if (rateLimited && attempt > RATE_LIMIT_WAITS_MS.length) return give();
        const wait = rateLimited ? RATE_LIMIT_WAITS_MS[attempt - 1] : waitBefore(attempt, policy.random);
        // Count the next try as taking as long as this one did, so slow failures are not repeated.
        const finishedAt = policy.now();
        if (finishedAt - startedAt + wait + (finishedAt - calledAt) > policy.budgetMs) return give();

        await policy.sleep(wait);
        // Nothing has answered by now: the failure looks lasting, so stop early.
        if (!answered && !rateLimited && attempt >= policy.attemptsBeforeAnswer) return give();
      }
    },
  };
}
