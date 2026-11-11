import { describe, expect, it } from 'vitest';
import {
  confluencePageAri,
  describeGraph,
  hasErrors,
  issueAri,
  MAX_FIRST,
  nodesOf,
  parseGoals,
  parsePullRequests,
  parseTeams,
  parseUsers,
  projectAri,
  QUERIES,
  QUERY_FIELDS,
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

describe('describeGraph', () => {
  it('explains each outcome in plain language', () => {
    expect(describeGraph(0, 0, 0)).toBe('not queried.');
    expect(describeGraph(0, 4, 0)).toBe('unavailable on this site (requests failed).');
    expect(describeGraph(5, 0, 0)).toContain('not granted its graph scopes');
    expect(describeGraph(4, 1, 2)).toBe('2 of 5 sources returned context.');
  });
});
