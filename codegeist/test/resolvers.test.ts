import { NeedsAuthenticationError } from '@forge/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPanelModel, type PanelError, type PanelModel } from '../src/resolvers';
import { QUERY_FIELDS } from '../src/core/graph';
import { fakeGraph, fakeJira } from './fakes';
import { CONFLUENCE_LINK, jiraIssue } from './fixtures';

const CLOUD = '11111111-2222-3333-4444-555555555555';
const connection = (field: string, nodes: unknown[]) => ({ data: { [field]: { edges: nodes.map((node) => ({ node })) } } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildPanelModel', () => {
  it('returns everything the panel renders in one response', async () => {
    const clients = () => ({
      jira: fakeJira({ issues: { 'KAN-12': jiraIssue() }, remoteLinks: { 'KAN-12': [CONFLUENCE_LINK] } }),
      graph: fakeGraph({
        pageOwners: connection(QUERY_FIELDS.pageOwners, [{ accountId: 'acc-eve', name: 'Eve Moss' }]),
        spaceTeams: connection(QUERY_FIELDS.spaceTeams, [{ displayName: 'Compliance squad' }]),
      }),
    });
    const model = (await buildPanelModel({ cloudId: CLOUD, extension: { issue: { key: 'KAN-12' } } }, clients)) as PanelModel;
    expect(model).toMatchObject({ issueKey: 'KAN-12', verdict: 'ready', verdictLabel: 'Ready to start' });
    expect(model.checks).toHaveLength(9);
    expect(model.people.length).toBeLessThanOrEqual(3);
    expect(model.people.map((p) => p.name)).toEqual(['Ana Silva', 'Eve Moss']);
    expect(model.graph).toEqual({
      available: true,
      note: '2 of 5 sources returned context.',
      gap: '',
      goals: 0,
      pullRequests: 0,
      pageOwners: 1,
      teams: 1,
    });
    expect(model.pack).toContain('Owning team: Compliance squad');
    // The resolver result crosses the bridge as JSON.
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });

  it('tells the panel what the graph did not answer for', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const clients = () => ({
      jira: fakeJira({ issues: { 'KAN-12': jiraIssue() }, remoteLinks: { 'KAN-12': [CONFLUENCE_LINK] } }),
      graph: fakeGraph({
        workItemPullRequests: { errors: [{ message: 'RATE_LIMIT_EXCEEDED' }] },
        spaceTeams: connection(QUERY_FIELDS.spaceTeams, [{ displayName: 'Compliance squad' }]),
      }),
    });
    const model = (await buildPanelModel({ cloudId: CLOUD, extension: { issue: { key: 'KAN-12' } } }, clients)) as PanelModel;
    expect(model.graph.teams).toBe(1);
    expect(model.graph.gap).toBe('Could not read pull requests this time; check again in a moment.');
    expect(model.checks.find((c) => c.id === 'work-in-flight')?.status).toBe('na');
  });

  it("lets the consent error out, so Forge can set up the person's access", async () => {
    // What a person hits before their access is set up: the first Jira read as the user is refused.
    const consent = new NeedsAuthenticationError('Authentication Required', 'atlassian-token-service-key');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const clients = () => ({ jira: { ...fakeJira({}), getIssue: () => Promise.reject(consent) } });
    await expect(buildPanelModel({ cloudId: CLOUD, extension: { issue: { key: 'KAN-12' } } }, clients)).rejects.toBe(consent);
    expect(error).not.toHaveBeenCalled();
  });

  it('asks for a work item when the panel has no issue context', async () => {
    expect(await buildPanelModel({}, () => ({ jira: fakeJira({}) }))).toEqual({
      error: 'Open a work item to run the ready check.',
    });
  });

  it('shows Jira errors as they are and hides unexpected ones', async () => {
    const missing = (await buildPanelModel({ extension: { issue: { key: 'KAN-404' } } }, () => ({ jira: fakeJira({}) }))) as PanelError;
    expect(missing.error).toContain('was not found');

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = (await buildPanelModel({ extension: { issue: { key: 'KAN-1' } } }, () => ({
      jira: {
        ...fakeJira({}),
        getIssue: () => Promise.reject(new Error('socket hang up')),
      },
    }))) as PanelError;
    expect(broken.error).toBe('Groundwork could not load this work item. Refresh to try again.');
  });
});
