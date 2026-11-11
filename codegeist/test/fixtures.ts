/** Builders for Jira JSON and normalized facts used across the tests. */
import type { AdfNode } from '../src/core/adf';
import type { JiraComment, JiraIssue, JiraRemoteLink } from '../src/core/facts';
import type { GraphContext, IssueFacts } from '../src/core/types';

export const text = (value: string, marks?: AdfNode['marks']): AdfNode => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
export const paragraph = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
export const heading = (level: number, value: string): AdfNode => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});
export const listItem = (value: string): AdfNode => ({ type: 'listItem', content: [paragraph(text(value))] });
export const bulletList = (...items: string[]): AdfNode => ({ type: 'bulletList', content: items.map(listItem) });
export const orderedList = (...items: string[]): AdfNode => ({ type: 'orderedList', content: items.map(listItem) });
export const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', content });

export const READY_DESCRIPTION = doc(
  heading(2, 'Background'),
  paragraph(
    text(
      'Compliance officers need to hand audit logs to external auditors every quarter. Today an engineer exports them by hand from the database, which takes half a day and is error prone.',
    ),
  ),
  heading(2, 'Acceptance criteria'),
  bulletList(
    'Admins can export the audit log for a chosen date range as CSV',
    'The export includes actor, action, target and timestamp columns',
    'Non-admins do not see the export button',
  ),
);

export function jiraIssue(overrides: Partial<NonNullable<JiraIssue['fields']>> = {}, extra: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10012',
    key: 'KAN-12',
    self: 'https://example.atlassian.net/rest/api/3/issue/10012',
    names: { customfield_10016: 'Story point estimate' },
    ...extra,
    fields: {
      summary: 'Let admins export audit logs as CSV',
      description: READY_DESCRIPTION,
      issuetype: { name: 'Story', subtask: false, hierarchyLevel: 0 },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      priority: { name: 'Medium' },
      project: { id: '10000', key: 'KAN' },
      assignee: null,
      reporter: { accountId: 'acc-reporter', displayName: 'Ana Silva' },
      labels: ['compliance'],
      components: [],
      parent: {
        key: 'KAN-1',
        fields: { summary: 'Compliance reporting', status: { name: 'In Progress' }, issuetype: { name: 'Epic' } },
      },
      issuelinks: [],
      customfield_10016: 3,
      created: '2026-10-01T10:00:00.000+0000',
      updated: '2026-11-01T10:00:00.000+0000',
      ...overrides,
    },
  };
}

export const CONFLUENCE_LINK: JiraRemoteLink = {
  globalId: 'appId=7d1f&pageId=98765',
  application: { type: 'com.atlassian.confluence', name: 'Confluence' },
  relationship: 'Wiki Page',
  object: {
    url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/98765/Audit+log+export+spec',
    title: 'Wiki Page',
  },
};

export function comment(name: string, body: string, created: string, accountId = `acc-${name}`): JiraComment {
  return { author: { accountId, displayName: name }, body: doc(paragraph(text(body))), created };
}

export function graphContext(overrides: Partial<GraphContext> = {}): GraphContext {
  return {
    available: true,
    sourcesWithData: 0,
    note: '0 of 5 sources returned context.',
    goals: [],
    pullRequests: [],
    pagePeople: [],
    teams: [],
    ...overrides,
  };
}

export function facts(overrides: Partial<IssueFacts> = {}): IssueFacts {
  return {
    key: 'KAN-12',
    id: '10012',
    summary: 'Let admins export audit logs as CSV',
    issueType: 'Story',
    isBug: false,
    isSubtask: false,
    isEpic: false,
    statusName: 'To Do',
    statusCategory: 'new',
    priority: 'Medium',
    projectKey: 'KAN',
    projectId: '10000',
    reporter: { accountId: 'acc-reporter', name: 'Ana Silva' },
    descriptionText:
      'Compliance officers need to hand audit logs to external auditors every quarter. Today an engineer exports them by hand from the database, which takes half a day and is error prone.\nAcceptance criteria\n- Admins can export the audit log as CSV\n- Non-admins do not see the export button',
    descriptionMarkdown: 'Compliance officers need to hand audit logs to external auditors every quarter.',
    storyPoints: 3,
    parent: { key: 'KAN-1', summary: 'Compliance reporting', issueType: 'Epic', statusName: 'In Progress' },
    labels: [],
    components: [],
    links: [],
    docs: [
      {
        title: 'Audit log export spec',
        url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/98765/Audit+log+export+spec',
        kind: 'confluence',
        confluencePageId: '98765',
        source: 'remote-link',
      },
    ],
    mentions: [],
    comments: [],
    commentsLoaded: true,
    remoteLinksLoaded: true,
    url: 'https://example.atlassian.net/browse/KAN-12',
    ...overrides,
  };
}
