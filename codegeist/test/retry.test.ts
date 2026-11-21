import { NeedsAuthenticationError } from '@forge/api';
import { describe, expect, it } from 'vitest';
import { QUERY_FIELDS, type GraphQlResponse } from '../src/core/graph';
import { DEFAULT_RETRY, waitBefore, withRetry, type RetryPolicy } from '../src/platform/retry';
import { fakeGraph } from './fakes';

const FIELD = QUERY_FIELDS.workItemGoals;
const GOALS: GraphQlResponse = { data: { [FIELD]: { edges: [{ node: { name: 'Pass the SOC 2 audit' } }] } } };
// What a Forge demo site answered for about 70% of identical reads in November 2026.
const REFUSED: GraphQlResponse = {
  data: null,
  errors: [
    { message: 'User is not permitted to query this organization', extensions: { classification: 'ValidationError' } },
    { message: "The field at path '/graphStore/cypherQueryV2' was declared as a non null type", extensions: { classification: 'NullValueInNonNullableField' } },
  ],
};
const UNKNOWN_FIELD: GraphQlResponse = {
  errors: [{ message: "Field 'dueDateEndedAt' in type 'AtlassianGoal' is undefined", extensions: { classification: 'ValidationError' } }],
};

/** A policy with a clock that only moves when the code sleeps, plus `callMs` for each call. */
function policy(overrides: Partial<RetryPolicy> = {}, callMs = 0) {
  const state = { clock: 0, waits: [] as number[] };
  const value: RetryPolicy = {
    attempts: 8,
    budgetMs: 6000,
    sleep: (ms) => {
      state.waits.push(ms);
      state.clock += ms;
      return Promise.resolve();
    },
    now: () => state.clock,
    random: () => 0,
    ...overrides,
  };
  const tick = () => {
    state.clock += callMs;
  };
  return { value, state, tick };
}

describe('withRetry', () => {
  it('returns a good answer at once, without waiting', async () => {
    const graph = fakeGraph({ workItemGoals: GOALS });
    const { value, state } = policy();
    expect(await withRetry(graph, value).query('workItemGoals', {})).toBe(GOALS);
    expect(graph.calls).toHaveLength(1);
    expect(state.waits).toEqual([]);
  });

  it('asks again when a site refuses a read it answers a moment later', async () => {
    const graph = fakeGraph({ workItemGoals: [REFUSED, REFUSED, REFUSED, GOALS] });
    const { value, state } = policy();
    expect(await withRetry(graph, value).query('workItemGoals', { id: 'ari' })).toBe(GOALS);
    expect(graph.calls).toHaveLength(4);
    expect(graph.calls.every((call) => call.variables.id === 'ari')).toBe(true);
    expect(state.waits).toEqual([100, 200, 400]);
  });

  it('asks again after a thrown error, a rate limit and a gateway error', async () => {
    const graph = fakeGraph({
      workItemGoals: [
        new Error('socket hang up'),
        { errors: [{ message: 'RATE_LIMIT_EXCEEDED' }] },
        { errors: [{ message: 'Teamwork Graph returned HTTP 503' }] },
        GOALS,
      ],
    });
    const { value } = policy();
    expect(await withRetry(graph, value).query('workItemGoals', {})).toBe(GOALS);
    expect(graph.calls).toHaveLength(4);
  });

  it('gives up after the allowed tries and hands back the last failure', async () => {
    const graph = fakeGraph({ workItemGoals: REFUSED });
    const { value, state } = policy({ attempts: 4 });
    expect(await withRetry(graph, value).query('workItemGoals', {})).toBe(REFUSED);
    expect(graph.calls).toHaveLength(4);
    expect(state.waits).toEqual([100, 200, 400]);
  });

  it('rethrows the last error when every try throws', async () => {
    const graph = fakeGraph({ workItemGoals: new Error('socket hang up') });
    const { value } = policy({ attempts: 3 });
    await expect(withRetry(graph, value).query('workItemGoals', {})).rejects.toThrow('socket hang up');
    expect(graph.calls).toHaveLength(3);
  });

  it('starts no new try once the time budget would be passed', async () => {
    // Each call takes 900 ms, so a 2-second budget has room for two tries: 900 + 100 + 900, then 200 more would pass it.
    const { value, state, tick } = policy({ budgetMs: 2000 }, 900);
    const graph = fakeGraph({ workItemGoals: REFUSED });
    const slow = {
      query: async (...args: Parameters<typeof graph.query>) => {
        tick();
        return graph.query(...args);
      },
    };
    expect(await withRetry(slow, value).query('workItemGoals', {})).toBe(REFUSED);
    expect(graph.calls).toHaveLength(2);
    expect(state.waits).toEqual([100]);
  });

  it('does not repeat a query the schema rejects', async () => {
    const graph = fakeGraph({ workItemGoals: UNKNOWN_FIELD });
    const { value, state } = policy();
    expect(await withRetry(graph, value).query('workItemGoals', {})).toBe(UNKNOWN_FIELD);
    expect(graph.calls).toHaveLength(1);
    expect(state.waits).toEqual([]);
  });

  it('keeps data that arrives beside an error instead of asking again', async () => {
    // A page owned by an app account comes back as a null node with a non-null error.
    const partial: GraphQlResponse = {
      data: { [QUERY_FIELDS.pageOwners]: { edges: [{ node: null }] } },
      errors: [{ message: "The field at path '/confluencePageOwners/edges[0]/node' was declared as a non null type" }],
    };
    const graph = fakeGraph({ pageOwners: partial });
    const { value } = policy();
    expect(await withRetry(graph, value).query('pageOwners', {})).toBe(partial);
    expect(graph.calls).toHaveLength(1);
  });

  it('never repeats a request that needs the person to allow access', async () => {
    const consent = new NeedsAuthenticationError('Authentication Required', 'atlassian-token-service-key');
    const graph = fakeGraph({ workItemGoals: consent });
    const { value, state } = policy();
    await expect(withRetry(graph, value).query('workItemGoals', {})).rejects.toBe(consent);
    expect(graph.calls).toHaveLength(1);
    expect(state.waits).toEqual([]);
  });
});

describe('the retry schedule', () => {
  it('doubles from 100 ms to a cap of 800 ms, plus up to 100 ms of jitter', () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => waitBefore(attempt, () => 0))).toEqual([100, 200, 400, 800, 800, 800]);
    expect(waitBefore(1, () => 0.999)).toBe(199);
  });

  it('fits every wait of the default policy inside its budget', () => {
    const waits = Array.from({ length: DEFAULT_RETRY.attempts - 1 }, (_, i) => waitBefore(i + 1, () => 0.999));
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(DEFAULT_RETRY.budgetMs);
    // Well inside the 25 seconds Forge gives a resolver and the 20 or so Rovo waits for an action.
    expect(DEFAULT_RETRY.budgetMs).toBeLessThanOrEqual(8000);
  });
});
