import { describe, expect, it } from 'vitest';
import {
  checkIssueReadiness,
  getContextPack,
  listReadyIssues,
  resolveCloudId,
  resolveIssueKey,
  resolveProjectKey,
  type ActionError,
  type ContextPackResult,
  type ReadinessResult,
  type ReadyIssuesResult,
} from '../src/actions';
import { fakeGraph, fakeJira, type FakeJiraData } from './fakes';
import { CONFLUENCE_LINK, jiraIssue } from './fixtures';

const clientsFor = (data: FakeJiraData) => () => ({ jira: fakeJira(data), graph: fakeGraph({}) });
const isError = (value: unknown): value is ActionError => typeof (value as ActionError).error === 'string';

describe('resolving keys from input and page context', () => {
  it('prefers the explicit input, then the page context, then the page URL', () => {
    expect(resolveIssueKey({ issueKey: 'kan-7', context: { jira: { issueKey: 'KAN-1' } } })).toBe('KAN-7');
    expect(resolveIssueKey({ issueKey: 'not a key', context: { jira: { issueKey: 'KAN-1' } } })).toBe('KAN-1');
    expect(resolveIssueKey({ context: { jira: { issueKey: 10001, url: 'https://x.atlassian.net/browse/KAN-5' } } })).toBe('KAN-5');
    expect(resolveIssueKey({ context: { jira: { url: 'https://x.atlassian.net/jira/software/projects/KAN/boards/1?selectedIssue=KAN-6' } } })).toBe('KAN-6');
    expect(resolveIssueKey({})).toBeUndefined();
  });

  it('falls back to the work item key prefix for the project', () => {
    expect(resolveProjectKey({ projectKey: 'ops' })).toBe('OPS');
    expect(resolveProjectKey({ context: { jira: { projectKey: 'KAN' } } })).toBe('KAN');
    expect(resolveProjectKey({ issueKey: 'ABC-3' })).toBe('ABC');
    expect(resolveProjectKey({})).toBeUndefined();
  });

  it('finds the cloud ID in the payload, the invocation context or the install context', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(resolveCloudId({ context: { cloudId: id } })).toBe(id);
    expect(resolveCloudId({}, { cloudId: id })).toBe(id);
    expect(resolveCloudId({}, { installContext: `ari:cloud:jira::site/${id}` })).toBe(id);
    expect(resolveCloudId({})).toBeUndefined();
  });
});

describe('check-issue-readiness', () => {
  it('returns a plain-language result an agent can relay', async () => {
    const result = await checkIssueReadiness(
      { issueKey: 'KAN-12' },
      undefined,
      clientsFor({ issues: { 'KAN-12': jiraIssue({ parent: undefined }) }, remoteLinks: { 'KAN-12': [CONFLUENCE_LINK] } }),
    );
    expect(isError(result)).toBe(false);
    const ok = result as ReadinessResult;
    expect(ok).toMatchObject({ issueKey: 'KAN-12', verdict: 'ready', verdictLabel: 'Ready to start' });
    expect(ok.gaps).toEqual([
      {
        check: 'Purpose is clear',
        status: 'warn',
        finding: 'Not linked to an epic, parent or goal.',
        fix: 'Link it to its epic or goal so people know why it matters.',
      },
    ]);
    expect(ok.passed).toContain('Done is defined');
    expect(ok.notChecked).toEqual(['No duplicate work']);
    expect(ok.peopleToAsk).toEqual([{ name: 'Ana Silva', why: 'Reported this work item' }]);
    expect(ok.nextStep).toContain('get-context-pack');
  });

  it('asks for a key when it cannot find one', async () => {
    const result = await checkIssueReadiness({}, undefined, clientsFor({}));
    expect(result).toEqual({ error: expect.stringContaining('Tell me which work item') });
  });

  it('relays Jira permission and not-found errors', async () => {
    const result = await checkIssueReadiness({ issueKey: 'KAN-404' }, undefined, clientsFor({}));
    expect(result).toEqual({ error: 'work item KAN-404 was not found, or you do not have permission to view it.' });
  });

  it('hides unexpected errors behind a friendly message', async () => {
    const broken = () => {
      throw new Error('internal detail');
    };
    const result = await checkIssueReadiness({ issueKey: 'KAN-1' }, undefined, () => ({
      jira: { ...fakeJira({}), getIssue: broken },
      graph: fakeGraph({}),
    }));
    expect(isError(result) && result.error).toContain('could not read this work item');
    expect(JSON.stringify(result)).not.toContain('internal detail');
  });
});

describe('get-context-pack', () => {
  it('returns the Markdown pack with the score', async () => {
    const result = (await getContextPack(
      { context: { jira: { issueKey: 'KAN-12' } } },
      undefined,
      clientsFor({ issues: { 'KAN-12': jiraIssue() } }),
    )) as ContextPackResult;
    expect(result.issueKey).toBe('KAN-12');
    expect(result.contextPack).toContain('## People to ask');
    expect(result.score).toBeGreaterThan(0);
  });
});

describe('list-ready-issues', () => {
  it('scans the project and adds a note about lite checks', async () => {
    const result = (await listReadyIssues(
      { projectKey: 'KAN', limit: '5' },
      undefined,
      clientsFor({ search: [jiraIssue()] }),
    )) as ReadyIssuesResult;
    expect(result.scanned).toBe(1);
    expect(result.note).toContain('Scanned 1 to-do work item in KAN; 1 ready to start.');
  });

  it('says so when the project has no to-do work', async () => {
    const result = (await listReadyIssues({ projectKey: 'KAN' }, undefined, clientsFor({ search: [] }))) as ReadyIssuesResult;
    expect(result.note).toBe('No to-do work items found in KAN.');
  });

  it('asks for a project when none can be found', async () => {
    expect(await listReadyIssues({}, undefined, clientsFor({}))).toEqual({
      error: expect.stringContaining('Tell me which project'),
    });
  });
});
