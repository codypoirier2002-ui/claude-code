/**
 * Turns raw Jira REST API v3 JSON into `IssueFacts`.
 *
 * The input types are deliberately loose (everything optional), because field
 * shapes vary between sites, project types and permissions. Nothing here throws
 * on missing data; it falls back to empty values instead.
 */
import { adfToMarkdown, adfToPlainText, extractMentions, extractUrls } from './adf';
import type {
  CommentFact,
  DocLink,
  IssueFacts,
  LinkedIssue,
  ParentFact,
  PersonRef,
  StatusCategory,
} from './types';

export interface JiraUser {
  accountId?: string;
  displayName?: string;
}

export interface JiraStatus {
  name?: string;
  statusCategory?: { key?: string };
}

export interface JiraLinkedIssueRef {
  key?: string;
  fields?: { summary?: string; status?: JiraStatus };
}

export interface JiraIssueLink {
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: JiraLinkedIssueRef;
  outwardIssue?: JiraLinkedIssueRef;
}

export interface JiraIssue {
  id?: string;
  key?: string;
  self?: string;
  names?: Record<string, string>;
  fields?: Record<string, unknown> & {
    summary?: string;
    description?: unknown;
    issuetype?: { name?: string; subtask?: boolean; hierarchyLevel?: number };
    status?: JiraStatus;
    priority?: { name?: string };
    project?: { id?: string; key?: string };
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    labels?: string[];
    components?: { name?: string }[];
    parent?: { key?: string; fields?: { summary?: string; status?: JiraStatus; issuetype?: { name?: string } } };
    issuelinks?: JiraIssueLink[];
    timeoriginalestimate?: number | null;
    created?: string;
    updated?: string;
  };
}

export interface JiraRemoteLink {
  globalId?: string;
  application?: { type?: string; name?: string };
  relationship?: string;
  object?: { url?: string; title?: string };
}

export interface JiraComment {
  author?: JiraUser;
  body?: unknown;
  created?: string;
}

/** IDs of the custom fields Groundwork reads, when the site has them. */
export interface FieldIds {
  storyPoints?: string;
  acceptanceCriteria?: string;
}

const STORY_POINTS_NAME = /^(story point estimate|story points?)$/i;
const ACCEPTANCE_NAME = /acceptance criteria/i;
const BLOCKER_RELATION = /\b(is blocked by|depends on|is dependent on|requires)\b/i;
const GENERIC_TITLE = /^(wiki page|page|confluence page|link|web link)$/i;

/** Finds the custom field IDs Groundwork needs from an `id -> display name` map. */
export function findFieldIds(names: Record<string, string> | undefined): FieldIds {
  const ids: FieldIds = {};
  for (const [id, name] of Object.entries(names ?? {})) {
    if (!ids.storyPoints && STORY_POINTS_NAME.test(name.trim())) ids.storyPoints = id;
    if (!ids.acceptanceCriteria && ACCEPTANCE_NAME.test(name)) ids.acceptanceCriteria = id;
  }
  return ids;
}

function person(user: JiraUser | null | undefined): PersonRef | undefined {
  if (!user?.displayName) return undefined;
  return user.accountId ? { accountId: user.accountId, name: user.displayName } : { name: user.displayName };
}

export function statusCategory(status: JiraStatus | undefined): StatusCategory {
  const key = status?.statusCategory?.key;
  return key === 'new' || key === 'indeterminate' || key === 'done' ? key : 'unknown';
}

function linkedIssue(link: JiraIssueLink): LinkedIssue | undefined {
  const inward = link.inwardIssue;
  const other = inward ?? link.outwardIssue;
  if (!other?.key) return undefined;
  // From this work item's point of view, an `inwardIssue` reads with the type's inward phrase.
  const relation = (inward ? link.type?.inward : link.type?.outward) ?? link.type?.name ?? 'relates to';
  return {
    key: other.key,
    summary: other.fields?.summary ?? '',
    statusName: other.fields?.status?.name ?? 'Unknown',
    statusCategory: statusCategory(other.fields?.status),
    relation,
    isBlocker: BLOCKER_RELATION.test(relation),
  };
}

/** Extracts the numeric Confluence page ID from a page URL or a remote-link global ID. */
export function confluencePageId(...candidates: (string | undefined)[]): string | undefined {
  for (const value of candidates) {
    if (!value) continue;
    const match = value.match(/\/pages\/(\d+)/) ?? value.match(/[?&]pageId=(\d+)/) ?? value.match(/^.*pageId=(\d+)/);
    if (match) return match[1];
  }
  return undefined;
}

function isConfluenceUrl(url: string): boolean {
  return /\/wiki(\/|$)/.test(url) && /atlassian\.(net|com)|\/wiki\/spaces\//.test(url);
}

/** A readable title from a URL: the Confluence page slug, or host and path. */
export function titleFromUrl(url: string): string {
  const slug = url.match(/\/pages\/\d+\/([^/?#]+)/);
  if (slug) {
    try {
      return decodeURIComponent(slug[1].replace(/\+/g, ' '));
    } catch {
      return slug[1].replace(/\+/g, ' ');
    }
  }
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, '');
    return `${parsed.hostname}${path.length > 1 ? path : ''}`;
  } catch {
    return url;
  }
}

function docFromRemoteLink(link: JiraRemoteLink): DocLink | undefined {
  const url = link.object?.url;
  if (!url) return undefined;
  const isConfluence = link.application?.type === 'com.atlassian.confluence' || isConfluenceUrl(url);
  const pageId = isConfluence ? confluencePageId(url, link.globalId) : undefined;
  const rawTitle = link.object?.title?.trim() ?? '';
  let title = rawTitle;
  if (rawTitle.length === 0 || GENERIC_TITLE.test(rawTitle)) {
    const fromUrl = titleFromUrl(url);
    title = pageId && !/\/pages\/\d+\/[^/?#]+/.test(url) ? `Confluence page ${pageId}` : fromUrl;
  }
  return {
    title,
    url,
    kind: isConfluence ? 'confluence' : 'web',
    ...(pageId ? { confluencePageId: pageId } : {}),
    source: 'remote-link',
  };
}

function docsFromDescription(description: unknown, issueBase: string | undefined): DocLink[] {
  return extractUrls(description)
    .filter((url) => !/\/browse\/[A-Z][A-Z0-9_]*-\d+/i.test(url))
    .filter((url) => !(issueBase && url.startsWith(`${issueBase}/jira/`)))
    .map((url) => {
      const isConfluence = isConfluenceUrl(url);
      const pageId = isConfluence ? confluencePageId(url) : undefined;
      return {
        title: titleFromUrl(url),
        url,
        kind: isConfluence ? ('confluence' as const) : ('web' as const),
        ...(pageId ? { confluencePageId: pageId } : {}),
        source: 'description' as const,
      };
    });
}

function mergeDocs(docs: DocLink[]): DocLink[] {
  const seen = new Set<string>();
  const merged: DocLink[] = [];
  for (const doc of docs) {
    const key = doc.confluencePageId ? `page:${doc.confluencePageId}` : `url:${doc.url.replace(/\/$/, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(doc);
  }
  return merged;
}

function siteBase(self: string | undefined): string | undefined {
  if (!self) return undefined;
  try {
    return new URL(self).origin;
  } catch {
    return undefined;
  }
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parentFact(parent: NonNullable<JiraIssue['fields']>['parent']): ParentFact | undefined {
  if (!parent?.key) return undefined;
  return {
    key: parent.key,
    summary: parent.fields?.summary ?? '',
    ...(parent.fields?.issuetype?.name ? { issueType: parent.fields.issuetype.name } : {}),
    ...(parent.fields?.status?.name ? { statusName: parent.fields.status.name } : {}),
  };
}

export interface FactsInput {
  issue: JiraIssue;
  fieldIds?: FieldIds;
  /** `undefined` means remote links were not loaded (project scans). */
  remoteLinks?: JiraRemoteLink[];
  /** Newest first. `undefined` means comments were not loaded (project scans). */
  comments?: JiraComment[];
}

/** Normalizes one work item. */
export function toIssueFacts({ issue, fieldIds, remoteLinks, comments }: FactsInput): IssueFacts {
  const fields = issue.fields ?? {};
  const ids = fieldIds ?? findFieldIds(issue.names);
  const typeName = fields.issuetype?.name ?? 'Work item';
  const hierarchy = fields.issuetype?.hierarchyLevel;
  const base = siteBase(issue.self);
  const key = issue.key ?? 'UNKNOWN';

  const acceptance = ids.acceptanceCriteria ? fields[ids.acceptanceCriteria] : undefined;
  const acceptanceText = adfToPlainText(acceptance);

  const remoteDocs = (remoteLinks ?? [])
    .map(docFromRemoteLink)
    .filter((doc): doc is DocLink => doc !== undefined);

  const commentFacts: CommentFact[] = (comments ?? []).map((comment) => ({
    author: person(comment.author) ?? { name: 'Unknown user' },
    created: comment.created ?? '',
    text: adfToPlainText(comment.body),
  }));

  return {
    key,
    id: issue.id ?? '',
    summary: fields.summary ?? '',
    issueType: typeName,
    isBug: /\b(bug|defect)\b/i.test(typeName),
    isSubtask: fields.issuetype?.subtask === true || hierarchy === -1,
    isEpic: hierarchy === 1 || /^epic$/i.test(typeName),
    statusName: fields.status?.name ?? 'Unknown',
    statusCategory: statusCategory(fields.status),
    ...(fields.priority?.name ? { priority: fields.priority.name } : {}),
    projectKey: fields.project?.key ?? key.split('-')[0],
    projectId: fields.project?.id ?? '',
    ...(person(fields.assignee) ? { assignee: person(fields.assignee) } : {}),
    ...(person(fields.reporter) ? { reporter: person(fields.reporter) } : {}),
    descriptionText: adfToPlainText(fields.description),
    descriptionMarkdown: adfToMarkdown(fields.description),
    ...(acceptanceText ? { acceptanceCriteriaText: acceptanceText } : {}),
    ...(ids.storyPoints && numberField(fields[ids.storyPoints]) !== undefined
      ? { storyPoints: numberField(fields[ids.storyPoints]) }
      : {}),
    ...(numberField(fields.timeoriginalestimate) !== undefined
      ? { originalEstimateSeconds: numberField(fields.timeoriginalestimate) }
      : {}),
    ...(parentFact(fields.parent) ? { parent: parentFact(fields.parent) } : {}),
    labels: Array.isArray(fields.labels) ? fields.labels.filter((l) => typeof l === 'string') : [],
    components: (fields.components ?? []).map((c) => c.name ?? '').filter((n) => n.length > 0),
    links: (fields.issuelinks ?? []).map(linkedIssue).filter((l): l is LinkedIssue => l !== undefined),
    docs: mergeDocs([...remoteDocs, ...docsFromDescription(fields.description, base)]),
    mentions: extractMentions(fields.description),
    comments: commentFacts,
    commentsLoaded: comments !== undefined,
    remoteLinksLoaded: remoteLinks !== undefined,
    ...(base ? { url: `${base}/browse/${key}` } : {}),
    ...(fields.created ? { created: fields.created } : {}),
    ...(fields.updated ? { updated: fields.updated } : {}),
  };
}
