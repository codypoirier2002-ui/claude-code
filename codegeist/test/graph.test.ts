import { describe, expect, it } from 'vitest';
import {
  confluencePageAri,
  describeGraph,
  describeUnread,
  errorSummary,
  GRAPH_SOURCES,
  hasErrors,
  isFailure,
  isRateLimited,
  issueAri,
  isTransient,
  logSafe,
  MAX_FIRST,
  nodesOf,
  parseGoals,
  parsePullRequests,
  parseTeams,
  parseUsers,
  projectAri,
  QUERIES,
  QUERY_FIELDS,
  QUERY_SOURCES,
} from '../src/core/graph';

const connection = (field: string, nodes: unknown[]) => ({ data: { [field]: { edges: nodes.map((node) => ({ node })) } } });

describe('ARIs', () => {
  it('follows the documented formats', () => {
    expect(issueAri('site-1', '10012')).toBe('ari:cloud:jira:site-1:issue/10012');
    expect(projectAri('site-1', '10000')).toBe('ari:cloud:jira:site-1:project/10000');
    expect(confluencePageAri('site-1', '98765')).toBe('ari:cloud:confluence:site-1:page/98765');
  });
});

describe('queries', () => {
  it('reads the field each query names and stays under the curated-query page cap', () => {
    for (const [name, query] of Object.entries(QUERIES)) {
      expect(query, name).toContain(`${QUERY_FIELDS[name as keyof typeof QUERIES]}(`);
      expect(query, name).toMatch(/^query groundwork_/);
      const first = Number(query.match(/first: (\d+)/)?.[1]);
      expect(first, name).toBeGreaterThan(0);
      expect(first, name).toBeLessThanOrEqual(MAX_FIRST);
    }
  });

  it('names each operation the way the graph requires', () => {
    // "[company]_[operation]": at least 3 and 4 characters, 100 at most. The graph answers HTTP 200 with an error otherwise.
    for (const [name, query] of Object.entries(QUERIES)) {
      const operation = query.match(/^query (\w+)\(/)?.[1] ?? '';
      expect(operation, name).toMatch(/^[a-z]{3,}_\w{4,}$/);
      expect(operation.length, name).toBeLessThanOrEqual(100);
    }
  });

  it('assigns every query to one of the sources', () => {
    for (const name of Object.keys(QUERIES)) {
      expect(GRAPH_SOURCES, name).toContain(QUERY_SOURCES[name as keyof typeof QUERIES]);
    }
  });
});

describe('parsers', () => {
  it('parses goals and drops nameless nodes', () => {
    const response = connection(QUERY_FIELDS.workItemGoals, [
      { __typename: 'AtlassianGoal', name: 'Pass the SOC 2 audit', key: 'G-1', url: 'https://g/1', archived: false, dueDateEndedAt: '2026-12-31' },
      { __typename: 'AtlassianGoal', name: '' },
      null,
    ]);
    expect(parseGoals(response)).toEqual([
      { name: 'Pass the SOC 2 audit', key: 'G-1', url: 'https://g/1', archived: false, dueDate: '2026-12-31' },
    ]);
  });

  it('parses pull requests, falling back to the display name', () => {
    const response = connection(QUERY_FIELDS.workItemPullRequests, [
      { title: 'Add CSV export', status: 'OPEN', url: 'https://git/pr/7', lastUpdatedAt: '2026-11-01' },
      { displayName: 'Fix escaping' },
    ]);
    expect(parsePullRequests(response)).toEqual([
      { title: 'Add CSV export', status: 'OPEN', url: 'https://git/pr/7', updatedAt: '2026-11-01' },
      { title: 'Fix escaping', status: 'UNKNOWN' },
    ]);
  });

  it('parses users and teams', () => {
    expect(
      parseUsers(connection(QUERY_FIELDS.pageOwners, [{ accountId: 'acc-1', name: 'Eve Moss' }, { name: 'No Id' }]), QUERY_FIELDS.pageOwners),
    ).toEqual([{ accountId: 'acc-1', name: 'Eve Moss' }, { name: 'No Id' }]);
    expect(parseTeams(connection(QUERY_FIELDS.spaceTeams, [{ displayName: 'Compliance squad', profileUrl: 'https://t/1' }]))).toEqual([
      { name: 'Compliance squad', url: 'https://t/1' },
    ]);
  });

  it('tolerates missing or malformed data', () => {
    expect(nodesOf({}, 'anything')).toEqual([]);
    expect(nodesOf({ data: null }, 'anything')).toEqual([]);
    expect(nodesOf({ data: { anything: { edges: 'nope' } } }, 'anything')).toEqual([]);
    expect(nodesOf({ data: { anything: { edges: [{}, { node: 'x' }] } } }, 'anything')).toEqual([]);
  });

  it('detects GraphQL errors', () => {
    expect(hasErrors({ errors: [{ message: 'Field not found' }] })).toBe(true);
    expect(hasErrors({ errors: [] })).toBe(false);
    expect(hasErrors({ data: {} })).toBe(false);
  });
});

describe('failures', () => {
  const field = QUERY_FIELDS.workItemGoals;
  const refused = {
    data: null,
    errors: [{ message: 'User is not permitted to query this organization', extensions: { classification: 'ValidationError' } }],
  };

  it('counts errors without data for the field as a failure, whatever the HTTP status was', () => {
    expect(isFailure(refused, field)).toBe(true);
    expect(isFailure({ errors: [{ message: 'x' }], data: { [field]: null } }, field)).toBe(true);
    expect(isFailure({ errors: [{ message: 'x' }], data: { [field]: { edges: [] } } }, field)).toBe(false);
    expect(isFailure({ data: {} }, field)).toBe(false);
  });

  it('treats refusals that pass a moment later as transient', () => {
    expect(isTransient(refused)).toBe(true);
    expect(isTransient({ errors: [{ message: 'RATE_LIMIT_EXCEEDED' }] })).toBe(true);
    expect(isTransient({ errors: [{ message: 'Too many requests' }] })).toBe(true);
    expect(isTransient({ errors: [{ message: 'Upstream request timed out' }] })).toBe(true);
    expect(isTransient({ errors: [{ message: 'Gateway Timeout' }] })).toBe(true);
    expect(isTransient({ errors: [{ message: 'Teamwork Graph returned HTTP 503' }] })).toBe(true);
    expect(isTransient({ errors: [{ message: 'Upstream failed', extensions: { statusCode: 429 } }] })).toBe(true);
    expect(isTransient({ errors: [{ message: 'first' }, { message: 'request throttled' }] })).toBe(true);
  });

  it('treats schema, naming and permission problems as permanent', () => {
    expect(isTransient({ errors: [{ message: "Field 'nope' in type 'AtlassianGoal' is undefined", extensions: { classification: 'ValidationError' } }] })).toBe(false);
    expect(isTransient({ errors: [{ message: 'You must set an operation name of the shape `[company]_[operation]`', extensions: { classification: 'DataFetchingException' } }] })).toBe(false);
    expect(isTransient({ errors: [{ message: 'Teamwork Graph returned HTTP 403' }] })).toBe(false);
    expect(isTransient({ errors: [{ message: 'Bad request', extensions: { statusCode: 400 } }] })).toBe(false);
    expect(isTransient({ errors: [{ message: "The field at path '/confluencePageOwners/edges[0]/node' was declared as a non null type" }] })).toBe(false);
    expect(isTransient({ errors: [{}] })).toBe(false);
    expect(isTransient({ data: {} })).toBe(false);
  });

  it('tells a rate limit from the other transient failures, because it needs a slower retry', () => {
    expect(isRateLimited({ errors: [{ message: 'RATE_LIMIT_EXCEEDED' }] })).toBe(true);
    expect(isRateLimited({ errors: [{ message: 'Teamwork Graph returned HTTP 429' }] })).toBe(true);
    expect(isRateLimited({ errors: [{ message: 'Upstream failed', extensions: { statusCode: 429 } }] })).toBe(true);
    expect(isRateLimited(refused)).toBe(false);
    expect(isRateLimited({ errors: [{ message: 'Teamwork Graph returned HTTP 503' }] })).toBe(false);
    expect(isRateLimited({ data: {} })).toBe(false);
  });

  it('summarizes the first error on one short line', () => {
    expect(errorSummary(refused)).toBe('ValidationError: User is not permitted to query this organization');
    expect(errorSummary({ errors: [{ message: 'line one\nline two' }] })).toBe('error: line one line two');
    expect(errorSummary({ errors: [{ message: 'x'.repeat(500) }] }).length).toBeLessThanOrEqual(160);
    expect(errorSummary({ errors: [{}] })).toBe('error: no message');
    expect(errorSummary({ data: {} })).toBe('no data');
  });

  it('removes ARIs and IDs the server echoes, so a log line cannot name a site, a person or a work item', () => {
    const cloud = '11111111-2222-3333-4444-555555555555';
    const echoed = `Entity ari:cloud:jira:${cloud}:issue/10042 could not be resolved for ari:cloud:identity::user/712020:5fb4febc-facf-d600-76a1-c699aaaaaaaa.`;
    expect(logSafe(echoed)).toBe('Entity ari:[removed] could not be resolved for ari:[removed]');
    expect(logSafe(`site ${cloud} is not ready`)).toBe('site [id] is not ready');
    expect(errorSummary({ errors: [{ message: echoed }] })).not.toContain(cloud);
    expect(errorSummary({ errors: [{ message: echoed }] })).not.toContain('10042');
  });
});

describe('describeGraph', () => {
  it('explains each outcome in plain language', () => {
    expect(describeGraph(0, 0, 0)).toBe('not queried.');
    expect(describeGraph(0, 4, 0)).toBe('unavailable on this site (requests failed).');
    expect(describeGraph(5, 0, 0)).toContain('not granted its graph scopes');
    expect(describeGraph(4, 1, 2)).toBe('2 of 5 sources returned context.');
  });

  it('names what could not be read, so an empty result is not mistaken for "nothing linked"', () => {
    expect(describeUnread([])).toBe('');
    // "May help", because the same line is shown for a failure that will not pass.
    expect(describeUnread(['pullRequests'])).toBe('Could not read pull requests this time; checking again may help.');
    // Always in the same order, whatever order the failures arrived in.
    expect(describeUnread(['teams', 'pagePeople', 'goals'])).toBe(
      'Could not read goals, page owners and teams this time; checking again may help.',
    );
    expect(describeGraph(4, 1, 2, ['pullRequests'])).toBe(
      '2 of 5 sources returned context. Could not read pull requests this time; checking again may help.',
    );
    // Empty answers from the other sources still have two possible causes, so the note keeps saying so.
    expect(describeGraph(3, 2, 0, ['goals', 'teams'])).toBe(
      'nothing found in the sources that answered (nothing linked yet, or the graph scopes were not granted). ' +
        'Could not read goals and teams this time; checking again may help.',
    );
  });
});
