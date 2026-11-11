import { describe, expect, it } from 'vitest';
import { QUERY_FIELDS } from '../src/core/graph';
import {
  analyzeIssue,
  EMPTY_GRAPH,
  loadGraphContext,
  loadIssueFacts,
  MAX_SCAN_LIMIT,
  normalizeIssueKey,
  normalizeProjectKey,
  scanJql,
  scanProject,
} from '../src/service';
import { fakeGraph, fakeJira } from './fakes';
import { CONFLUENCE_LINK, comment, doc, jiraIssue, paragraph, text } from './fixtures';

const CLOUD = '11111111-2222-3333-4444-555555555555';
const connection = (field: string, nodes: unknown[]) => ({ data: { [field]: { edges: nodes.map((node) => ({ node })) } } });

describe('key normalization', () => {
  it('accepts and upper-cases valid keys only', () => {
    expect(normalizeIssueKey(' kan-12 ')).toBe('KAN-12');
    expect(normalizeIssueKey('KAN_2-7')).toBe('KAN_2-7');
    expect(normalizeIssueKey('KAN-0')).toBeUndefined();
    expect(normalizeIssueKey('12-KAN')).toBeUndefined();
    expect(normalizeIssueKey('KAN-12; DROP')).toBeUndefined();
    expect(normalizeIssueKey(12)).toBeUndefined();
    expect(normalizeProjectKey('kan')).toBe('KAN');
    expect(normalizeProjectKey('KAN" OR 1=1')).toBeUndefined();
  });
});

describe('loadIssueFacts', () => {
  it('loads links and comments, and degrades when they fail', async () => {
    const jira = fakeJira({
      issues: { 'KAN-12': jiraIssue() },
      remoteLinks: { 'KAN-12': new Error('boom') },
      comments: { 'KAN-12': [comment('Ben Ode', 'Looks good', '2026-11-02')] },
    });
    const facts = await loadIssueFacts(jira, 'KAN-12');
    expect(facts.remoteLinksLoaded).toBe(false);
    expect(facts.commentsLoaded).toBe(true);
    expect(facts.comments).toHaveLength(1);
  });

  it('surfaces a missing work item as a Jira error', async () => {
    await expect(loadIssueFacts(fakeJira({}), 'KAN-99')).rejects.toThrow('was not found');
  });
});

describe('loadGraphContext', () => {
  const baseFacts = async () =>
    loadIssueFacts(fakeJira({ issues: { 'KAN-12': jiraIssue() }, remoteLinks: { 'KAN-12': [CONFLUENCE_LINK] } }), 'KAN-12');

  it('returns the empty context without a client or a cloud ID', async () => {
    const facts = await baseFacts();
    expect(await loadGraphContext(undefined, facts, CLOUD)).toBe(EMPTY_GRAPH);
    expect(await loadGraphContext(fakeGraph({}), facts, undefined)).toBe(EMPTY_GRAPH);
  });

  it('queries goals, pull requests, teams and the linked page with the right ARIs', async () => {
    const facts = await baseFacts();
    const graph = fakeGraph({
      workItemGoals: connection(QUERY_FIELDS.workItemGoals, [{ name: 'Pass the SOC 2 audit' }]),
      pageOwners: connection(QUERY_FIELDS.pageOwners, [{ accountId: 'acc-eve', name: 'Eve Moss' }]),
      spaceTeams: connection(QUERY_FIELDS.spaceTeams, [{ displayName: 'Compliance squad' }]),
    });
    const context = await loadGraphContext(graph, facts, CLOUD);
    expect(context.available).toBe(true);
    expect(context.sourcesWithData).toBe(3);
    expect(context.note).toBe('3 of 5 sources returned context.');
    expect(context.goals).toEqual([{ name: 'Pass the SOC 2 audit' }]);
    expect(context.teams).toEqual([{ name: 'Compliance squad' }]);
    expect(context.pagePeople).toEqual([
      { pageId: '98765', pageTitle: 'Audit log export spec', owners: [{ accountId: 'acc-eve', name: 'Eve Moss' }], contributors: [] },
    ]);
    const variables = Object.fromEntries(graph.calls.map((call) => [call.name, call.variables]));
    expect(variables.workItemGoals).toEqual({ id: `ari:cloud:jira:${CLOUD}:issue/10012` });
    expect(variables.workItemPullRequests).toEqual({ id: `ari:cloud:jira:${CLOUD}:issue/10012` });
    expect(variables.spaceTeams).toEqual({ spaceAri: `ari:cloud:jira:${CLOUD}:project/10000` });
    expect(variables.pageOwners).toEqual({ id: `ari:cloud:confluence:${CLOUD}:page/98765` });
  });

  it('counts failed queries without throwing', async () => {
    const facts = await baseFacts();
    const graph = fakeGraph({
      workItemGoals: new Error('network'),
      workItemPullRequests: { errors: [{ message: 'Cannot query field' }] },
      spaceTeams: new Error('network'),
      pageOwners: new Error('network'),
      pageContributors: new Error('network'),
    });
    const context = await loadGraphContext(graph, facts, CLOUD);
    expect(context.available).toBe(false);
    expect(context.note).toBe('unavailable on this site (requests failed).');
    expect(context.goals).toEqual([]);
  });

  it('keeps partial data that arrives with errors', async () => {
    const facts = await baseFacts();
    const graph = fakeGraph({
      workItemGoals: {
        ...connection(QUERY_FIELDS.workItemGoals, [{ name: 'Goal A' }]),
        errors: [{ message: 'one node could not be resolved' }],
      },
    });
    const context = await loadGraphContext(graph, facts, CLOUD);
    expect(context.goals).toEqual([{ name: 'Goal A' }]);
    expect(context.available).toBe(true);
  });
});

describe('analyzeIssue', () => {
  it('produces readiness, people and a context pack from one call', async () => {
    const jira = fakeJira({
      issues: { 'KAN-12': jiraIssue() },
      remoteLinks: { 'KAN-12': [CONFLUENCE_LINK] },
      comments: { 'KAN-12': [comment('Ben Ode', 'Which date format should the export use?', '2026-11-02')] },
    });
    const analysis = await analyzeIssue({ jira, graph: fakeGraph({}) }, 'KAN-12', CLOUD, '2026-11-11');
    expect(analysis.readiness.verdict).toBe('ready');
    expect(analysis.readiness.gaps).toEqual(['No open questions']);
    expect(analysis.people.map((p) => p.name)).toEqual(['Ana Silva', 'Ben Ode']);
    expect(analysis.pack).toContain('# KAN-12 · Let admins export audit logs as CSV');
    expect(analysis.pack).toContain('Generated by Groundwork on 2026-11-11');
  });
});

describe('scanProject', () => {
  // Pass `undefined` as the description to keep the fixture's ready description.
  const issue = (key: string, summary: string, description: unknown, links: unknown[] = []) =>
    jiraIssue(
      { summary, ...(description === undefined ? {} : { description }), issuelinks: links as never },
      { key, id: key.split('-')[1] },
    );

  it('ranks to-do work by readiness with a single search', async () => {
    const jira = fakeJira({
      fieldIds: { storyPoints: 'customfield_10016' },
      search: [
        issue('KAN-2', 'Fix', null),
        issue('KAN-3', 'Let admins export audit logs as CSV', undefined),
        issue('KAN-4', 'Show the audit log retention period', undefined, [
          {
            type: { inward: 'is blocked by', outward: 'blocks' },
            inwardIssue: { key: 'KAN-9', fields: { summary: 'Retention policy', status: { name: 'To Do', statusCategory: { key: 'new' } } } },
          },
        ]),
      ],
    });
    const scan = await scanProject(jira, 'KAN', 10);
    expect(jira.searches).toHaveLength(1);
    expect(jira.searches[0].jql).toBe(scanJql('KAN'));
    expect(jira.searches[0].fields).toContain('customfield_10016');
    expect(scan.items.map((item) => [item.key, item.verdict])).toEqual([
      ['KAN-3', 'ready'],
      ['KAN-2', 'not-ready'],
      ['KAN-4', 'blocked'],
    ]);
    expect(scan.readyCount).toBe(1);
    expect(scan.items[1].topGap).toBe('Done is defined');
  });

  it('clamps the limit and survives a failing field lookup', async () => {
    const jira = fakeJira({ fieldIds: new Error('forbidden'), search: [] });
    await scanProject(jira, 'KAN', 500);
    await scanProject(jira, 'KAN', 0);
    expect(jira.searches.map((s) => s.max)).toEqual([MAX_SCAN_LIMIT, 10]);
  });

  it('builds safe JQL from a validated key', () => {
    expect(scanJql('KAN')).toBe('project = "KAN" AND statusCategory = "To Do" ORDER BY priority DESC, updated DESC');
  });
});

describe('fixtures sanity', () => {
  it('uses ADF helpers that produce valid documents', () => {
    expect(doc(paragraph(text('x')))).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] });
  });
});
