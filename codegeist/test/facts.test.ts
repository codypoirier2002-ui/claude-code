import { describe, expect, it } from 'vitest';
import { confluencePageId, findFieldIds, titleFromUrl, toIssueFacts } from '../src/core/facts';
import { CONFLUENCE_LINK, comment, doc, jiraIssue, paragraph, text } from './fixtures';

describe('toIssueFacts', () => {
  it('normalizes the core fields', () => {
    const facts = toIssueFacts({ issue: jiraIssue(), remoteLinks: [], comments: [] });
    expect(facts).toMatchObject({
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
      storyPoints: 3,
      parent: { key: 'KAN-1', summary: 'Compliance reporting', issueType: 'Epic', statusName: 'In Progress' },
      labels: ['compliance'],
      url: 'https://example.atlassian.net/browse/KAN-12',
      commentsLoaded: true,
      remoteLinksLoaded: true,
    });
    expect(facts.assignee).toBeUndefined();
    expect(facts.descriptionText).toContain('Acceptance criteria\n- Admins can export');
    expect(facts.descriptionMarkdown).toContain('## Acceptance criteria');
  });

  it('reads issue links from this work item’s point of view', () => {
    const facts = toIssueFacts({
      issue: jiraIssue({
        issuelinks: [
          {
            type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
            inwardIssue: { key: 'KAN-3', fields: { summary: 'Audit table', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } } },
          },
          {
            type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
            outwardIssue: { key: 'KAN-20', fields: { summary: 'Reports', status: { name: 'To Do', statusCategory: { key: 'new' } } } },
          },
          { type: { name: 'Relates' }, outwardIssue: { key: 'KAN-9' } },
          { type: { name: 'Blocks' } },
        ],
      }),
    });
    expect(facts.links).toEqual([
      { key: 'KAN-3', summary: 'Audit table', statusName: 'In Progress', statusCategory: 'indeterminate', relation: 'is blocked by', isBlocker: true },
      { key: 'KAN-20', summary: 'Reports', statusName: 'To Do', statusCategory: 'new', relation: 'blocks', isBlocker: false },
      { key: 'KAN-9', summary: '', statusName: 'Unknown', statusCategory: 'unknown', relation: 'Relates', isBlocker: false },
    ]);
  });

  it('turns remote links and description links into docs without duplicates', () => {
    const description = doc(
      paragraph(
        text('Spec: https://example.atlassian.net/wiki/spaces/ENG/pages/98765/Audit+log+export+spec and '),
        text('design', [{ type: 'link', attrs: { href: 'https://figma.example/file/abc' } }]),
        text(' and KAN-3 at https://example.atlassian.net/browse/KAN-3'),
      ),
    );
    const facts = toIssueFacts({
      issue: jiraIssue({ description }),
      remoteLinks: [CONFLUENCE_LINK, { object: { url: 'https://github.example/org/repo/issues/7', title: 'Upstream issue' } }],
    });
    expect(facts.docs).toEqual([
      {
        title: 'Audit log export spec',
        url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/98765/Audit+log+export+spec',
        kind: 'confluence',
        confluencePageId: '98765',
        source: 'remote-link',
      },
      { title: 'Upstream issue', url: 'https://github.example/org/repo/issues/7', kind: 'web', source: 'remote-link' },
      { title: 'figma.example/file/abc', url: 'https://figma.example/file/abc', kind: 'web', source: 'description' },
    ]);
  });

  it('names Confluence links without a readable title by page ID', () => {
    const facts = toIssueFacts({
      issue: jiraIssue({ description: null }),
      remoteLinks: [
        {
          globalId: 'appId=7d1f&pageId=555',
          application: { type: 'com.atlassian.confluence' },
          object: { url: 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=555', title: 'Wiki Page' },
        },
      ],
    });
    expect(facts.docs[0]).toMatchObject({ title: 'Confluence page 555', confluencePageId: '555', kind: 'confluence' });
  });

  it('reads comments, mentions and a dedicated acceptance criteria field', () => {
    const facts = toIssueFacts({
      issue: jiraIssue(
        {
          description: doc(paragraph({ type: 'mention', attrs: { id: 'acc-ben', text: '@Ben Ode' } }, text(' owns the API.'))),
          customfield_10050: doc(paragraph(text('Admins can export a CSV file for any date range'))),
        },
        { names: { customfield_10016: 'Story Points', customfield_10050: 'Acceptance Criteria' } },
      ),
      comments: [comment('Ben Ode', 'Which date format?', '2026-11-02T09:00:00.000+0000')],
    });
    expect(facts.mentions).toEqual([{ accountId: 'acc-ben', name: 'Ben Ode' }]);
    expect(facts.acceptanceCriteriaText).toBe('Admins can export a CSV file for any date range');
    expect(facts.comments).toEqual([
      { author: { accountId: 'acc-Ben Ode', name: 'Ben Ode' }, created: '2026-11-02T09:00:00.000+0000', text: 'Which date format?' },
    ]);
  });

  it('detects bugs, sub-tasks and epics', () => {
    expect(toIssueFacts({ issue: jiraIssue({ issuetype: { name: 'Bug' } }) }).isBug).toBe(true);
    expect(toIssueFacts({ issue: jiraIssue({ issuetype: { name: 'Sub-task', subtask: true, hierarchyLevel: -1 } }) }).isSubtask).toBe(true);
    expect(toIssueFacts({ issue: jiraIssue({ issuetype: { name: 'Epic', hierarchyLevel: 1 } }) }).isEpic).toBe(true);
  });

  it('marks comments and remote links as not loaded in project scans', () => {
    const facts = toIssueFacts({ issue: jiraIssue() });
    expect(facts.commentsLoaded).toBe(false);
    expect(facts.remoteLinksLoaded).toBe(false);
    expect(facts.comments).toEqual([]);
  });

  it('survives an almost empty payload', () => {
    const facts = toIssueFacts({ issue: { key: 'ABC-1' } });
    expect(facts).toMatchObject({ key: 'ABC-1', summary: '', issueType: 'Work item', projectKey: 'ABC', statusCategory: 'unknown' });
    expect(facts.url).toBeUndefined();
  });
});

describe('findFieldIds', () => {
  it('finds story points and acceptance criteria fields by name', () => {
    expect(
      findFieldIds({ summary: 'Summary', customfield_10016: 'Story point estimate', customfield_10050: 'Acceptance criteria' }),
    ).toEqual({ storyPoints: 'customfield_10016', acceptanceCriteria: 'customfield_10050' });
    expect(findFieldIds(undefined)).toEqual({});
  });
});

describe('confluencePageId and titleFromUrl', () => {
  it('extracts page IDs from URLs and global IDs', () => {
    expect(confluencePageId('https://x.atlassian.net/wiki/spaces/A/pages/123/Title')).toBe('123');
    expect(confluencePageId(undefined, 'appId=1&pageId=456')).toBe('456');
    expect(confluencePageId('https://x.atlassian.net/wiki/x/AbCd')).toBeUndefined();
  });

  it('builds readable titles', () => {
    expect(titleFromUrl('https://x.atlassian.net/wiki/spaces/A/pages/123/Audit+log+spec')).toBe('Audit log spec');
    expect(titleFromUrl('https://docs.example.com/guide/')).toBe('docs.example.com/guide');
    expect(titleFromUrl('not a url')).toBe('not a url');
  });
});
