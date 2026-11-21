import { FetchError, NeedsAuthenticationError, ProxyRequestError } from '@forge/api';
import { describe, expect, it } from 'vitest';
import { QUERY_FIELDS, type GraphQlResponse, type QueryName } from '../src/core/graph';
import type { GraphClient } from '../src/platform/graph';
import { DEFAULT_RETRY, isTransientError, waitBefore, withRetry, type RetryPolicy } from '../src/platform/retry';
import { fakeGraph } from './fakes';

const FIELD = QUERY_FIELDS.workItemGoals;
const GOALS: GraphQlResponse = { data: { [FIELD]: { edges: [{ node: { name: 'Pass the SOC 2 audit' } }] } } };
const TEAMS: GraphQlResponse = { data: { [QUERY_FIELDS.spaceTeams]: { edges: [] } } };
// What a Forge demo site answered for about 70% of identical reads in November 2026.
const REFUSED: GraphQlResponse = {
  data: null,
  errors: [
    { message: 'User is not permitted to query this organization', extensions: { classification: 'ValidationError' } },
    { message: "The field at path '/graphStore/cypherQueryV2' was declared as a non null type", extensions: { classification: 'NullValueInNonNullableField' } },
  ],
};
const RATE_LIMITED: GraphQlResponse = { errors: [{ message: 'RATE_LIMIT_EXCEEDED' }] };
const UNKNOWN_FIELD: GraphQlResponse = {
  errors: [{ message: "Field 'dueDateEndedAt' in type 'AtlassianGoal' is undefined", extensions: { classification: 'ValidationError' } }],
};

/** A policy whose clock moves only when the code sleeps. `slow` makes every call take `callMs` on that clock. */
function policy(overrides: Partial<RetryPolicy> = {}, callMs = 0) {
  const state = { clock: 0, waits: [] as number[] };
  const value: RetryPolicy = {
    attempts: 8,
    attemptsBeforeAnswer: 3,
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
  const slow = (client: GraphClient): GraphClient => ({
    query: async (name, variables) => {
      state.clock += callMs;
      return client.query(name, variables);
    },
  });
  return { value, state, slow };
}

const callsTo = (graph: { calls: { name: QueryName }[] }, name: QueryName) => graph.calls.filter((call) => call.name === name).length;

describe('withRetry', () => {
  it('returns a good answer at once, without waiting', async () => {
    const graph = fakeGraph({ workItemGoals: GOALS });
    const { value, state } = policy();
    expect(await withRetry(graph, value).query('workItemGoals', {})).toBe(GOALS);
    expect(graph.calls).toHaveLength(1);
    expect(state.waits).toEqual([]);
  });

  it('asks again when a site refuses a read it answers a moment later', async () => {
    const graph = fakeGraph({ workItemGoals: [REFUSED, REFUSED, GOALS] });
    const { value, state } = policy();
    expect(await withRetry(graph, value).query('workItemGoals', { id: 'ari' })).toBe(GOALS);
    expect(graph.calls).toHaveLength(3);
    expect(graph.calls.every((call) => call.variables.id === 'ari')).toBe(true);
    expect(state.waits).toEqual([100, 200]);
  });

  it('keeps trying once another query of the same load has answered', async () => {
    // An answer from any query shows the refusals are passing ones, so the full number of tries is worth it.
    const graph = fakeGraph({ spaceTeams: TEAMS, workItemGoals: [REFUSED, REFUSED, REFUSED, REFUSED, REFUSED, GOALS] });
    const { value, state } = policy();
    const retrying = withRetry(graph, value);
    expect(await retrying.query('spaceTeams', {})).toBe(TEAMS);
    expect(await retrying.query('workItemGoals', {})).toBe(GOALS);
    expect(callsTo(graph, 'workItemGoals')).toBe(6);
    expect(state.waits).toEqual([100, 200, 400, 800, 800]);
  });

  it('stops after three tries each when nothing answers, because the refusal may be lasting', async () => {
    // A person the graph always refuses: 9 queries used to mean 72 requests and a 6-second wait.
    const names: QueryName[] = ['workItemGoals', 'workItemPullRequests', 'spaceTeams', 'pageOwners', 'pageContributors'];
    const graph = fakeGraph(Object.fromEntries(names.map((name) => [name, REFUSED])));
    const { value, state } = policy({ budgetMs: 60_000 });
    const retrying = withRetry(graph, value);
    const answers = await Promise.all(names.map((name) => retrying.query(name, {})));
    expect(answers.every((answer) => answer === REFUSED)).toBe(true);
    expect(graph.calls).toHaveLength(names.length * 3);
    for (const name of names) expect(callsTo(graph, name), name).toBe(3);
    expect(Math.max(...state.waits)).toBe(400);
  });

  it('gives up after the allowed tries and hands back the last failure', async () => {
    const graph = fakeGraph({ spaceTeams: TEAMS, workItemGoals: REFUSED });
    const { value, state } = policy({ attempts: 5 });
    const retrying = withRetry(graph, value);
    await retrying.query('spaceTeams', {});
    expect(await retrying.query('workItemGoals', {})).toBe(REFUSED);
    expect(callsTo(graph, 'workItemGoals')).toBe(5);
    expect(state.waits).toEqual([100, 200, 400, 800]);
  });

  it('slows down after a rate limit and gives up sooner, for every query of the load', async () => {
    const graph = fakeGraph({ workItemGoals: RATE_LIMITED, spaceTeams: REFUSED, workItemPullRequests: TEAMS });
    const { value, state } = policy();
    const retrying = withRetry(graph, value);
    // An earlier answer would normally allow eight tries. A rate limit overrides that.
    await retrying.query('workItemPullRequests', {});
    expect(await retrying.query('workItemGoals', {})).toBe(RATE_LIMITED);
    expect(callsTo(graph, 'workItemGoals')).toBe(3);
    expect(state.waits).toEqual([1000, 2000]);
    // A sibling query that fails for another reason now backs off the same way.
    state.waits.length = 0;
    state.clock = 0;
    expect(await retrying.query('spaceTeams', {})).toBe(REFUSED);
    expect(callsTo(graph, 'spaceTeams')).toBe(3);
    expect(state.waits).toEqual([1000, 2000]);
  });

  it('asks again after a network fault or a gateway answer from the proxy', async () => {
    const graph = fakeGraph({
      workItemGoals: [new Error('socket hang up'), new FetchError('fetch failed'), new ProxyRequestError(503, 'UPSTREAM_UNAVAILABLE'), GOALS],
      spaceTeams: TEAMS,
    });
    const { value } = policy();
    const retrying = withRetry(graph, value);
    await retrying.query('spaceTeams', {});
    expect(await retrying.query('workItemGoals', {})).toBe(GOALS);
    expect(callsTo(graph, 'workItemGoals')).toBe(4);
  });

  it('rethrows at once an error that would fail the same way again', async () => {
    for (const lasting of [
      new SyntaxError('Unexpected token < in JSON at position 0'),
      new ProxyRequestError(403, 'EGRESS_DENIED'),
      new TypeError("Cannot read properties of undefined (reading 'json')"),
    ]) {
      const graph = fakeGraph({ workItemGoals: lasting });
      const { value, state } = policy();
      await expect(withRetry(graph, value).query('workItemGoals', {})).rejects.toBe(lasting);
      expect(graph.calls, lasting.name).toHaveLength(1);
      expect(state.waits).toEqual([]);
    }
  });

  it('rethrows the last error when every try throws', async () => {
    const graph = fakeGraph({ workItemGoals: new Error('socket hang up') });
    const { value } = policy();
    await expect(withRetry(graph, value).query('workItemGoals', {})).rejects.toThrow('socket hang up');
    expect(graph.calls).toHaveLength(3);
  });

  it('starts no new try that would end after the time budget', async () => {
    // Each call takes 900 ms. After the second, 1900 ms have passed, and 200 ms of waiting plus one more call would pass 2000.
    const { value, state, slow } = policy({ budgetMs: 2000 }, 900);
    const graph = fakeGraph({ workItemGoals: REFUSED });
    expect(await withRetry(slow(graph), value).query('workItemGoals', {})).toBe(REFUSED);
    expect(graph.calls).toHaveLength(2);
    expect(state.waits).toEqual([100]);
  });

  it('does not repeat a failure that took most of the budget to arrive', async () => {
    // A gateway that answers 504 after 5.5 seconds: a second try would take the load past 11 seconds.
    const { value, state, slow } = policy({}, 5500);
    const graph = fakeGraph({ workItemGoals: { errors: [{ message: 'Teamwork Graph returned HTTP 504' }] } });
    await withRetry(slow(graph), value).query('workItemGoals', {});
    expect(graph.calls).toHaveLength(1);
    expect(state.waits).toEqual([]);
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

describe('isTransientError', () => {
  it('retries network faults and the proxy rate-limit and gateway answers only', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError(new Error('connect ETIMEDOUT 10.0.0.1:443'))).toBe(true);
    expect(isTransientError(new FetchError('anything'))).toBe(true);
    expect(isTransientError(new ProxyRequestError(429, 'RATE_LIMITED'))).toBe(true);
    expect(isTransientError(new ProxyRequestError(504, 'GATEWAY_TIMEOUT'))).toBe(true);
    expect(isTransientError(new ProxyRequestError(400, 'BAD_REQUEST'))).toBe(false);
    expect(isTransientError(new NeedsAuthenticationError('Authentication Required', 'atlassian-token-service-key'))).toBe(false);
    expect(isTransientError(new SyntaxError('Unexpected end of JSON input'))).toBe(false);
    expect(isTransientError('socket hang up')).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
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
    expect(DEFAULT_RETRY.attemptsBeforeAnswer).toBeLessThan(DEFAULT_RETRY.attempts);
  });
});
