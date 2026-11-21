/**
 * Teamwork Graph queries and response parsing (pure, no network).
 *
 * Groundwork only uses curated queries, which need no registration step. Each
 * query is sent on its own and selects as few fields as possible, so a schema
 * change or a withheld scope breaks one enrichment instead of the whole panel.
 * Query names and arguments follow the curated-query catalog, and field names
 * the object-type reference (both checked on 2026-11-21):
 * https://developer.atlassian.com/platform/teamwork-graph/curated-queries/
 * https://developer.atlassian.com/platform/teamwork-graph/api-reference/object-types/overview/
 */
import { humanList, oneLine, truncate } from './text';
import type { GraphGoal, GraphPullRequest, GraphSource, GraphTeam, PersonRef } from './types';

/** Curated queries cap `first` at 25. */
export const MAX_FIRST = 25;

export const issueAri = (cloudId: string, issueId: string): string => `ari:cloud:jira:${cloudId}:issue/${issueId}`;
export const projectAri = (cloudId: string, projectId: string): string =>
  `ari:cloud:jira:${cloudId}:project/${projectId}`;
export const confluencePageAri = (cloudId: string, pageId: string): string =>
  `ari:cloud:confluence:${cloudId}:page/${pageId}`;

export const QUERIES = {
  workItemGoals: `query groundwork_workItemGoals($id: ID!) {
  jiraWorkItemGoals(id: $id, first: 10) {
    edges { node { __typename ... on AtlassianGoal { id name key url archived dueDateEndedAt } } }
  }
}`,
  workItemPullRequests: `query groundwork_workItemPullRequests($id: ID!) {
  jiraWorkItemLinkedExternalPullRequests(id: $id, first: 10) {
    edges { node { __typename ... on ExternalPullRequest { id title displayName status url lastUpdatedAt } } }
  }
}`,
  pageOwners: `query groundwork_pageOwners($id: ID!) {
  confluencePageOwners(id: $id, first: 5) {
    edges { node { __typename ... on AtlassianUser { id accountId name } } }
  }
}`,
  pageContributors: `query groundwork_pageContributors($id: ID!) {
  confluencePageContributors(id: $id, first: 10) {
    edges { node { __typename ... on AtlassianUser { id accountId name } } }
  }
}`,
  spaceTeams: `query groundwork_spaceTeams($spaceAri: ID!) {
  atlassianTeamsBySpace(spaceAri: $spaceAri, first: 5) {
    edges { node { __typename ... on AtlassianTeam { id displayName profileUrl } } }
  }
}`,
} as const;

export type QueryName = keyof typeof QUERIES;

/** The top-level GraphQL field each query reads. */
export const QUERY_FIELDS: Record<QueryName, string> = {
  workItemGoals: 'jiraWorkItemGoals',
  workItemPullRequests: 'jiraWorkItemLinkedExternalPullRequests',
  pageOwners: 'confluencePageOwners',
  pageContributors: 'confluencePageContributors',
  spaceTeams: 'atlassianTeamsBySpace',
};

/** The context each query contributes to. Page owners and contributors count as one source. */
export const QUERY_SOURCES: Record<QueryName, GraphSource> = {
  workItemGoals: 'goals',
  workItemPullRequests: 'pullRequests',
  pageOwners: 'pagePeople',
  pageContributors: 'pagePeople',
  spaceTeams: 'teams',
};

/** Every source, in the order Groundwork names them. */
export const GRAPH_SOURCES: readonly GraphSource[] = ['goals', 'pullRequests', 'pagePeople', 'teams'];

const SOURCE_LABELS: Record<GraphSource, string> = {
  goals: 'goals',
  pullRequests: 'pull requests',
  pagePeople: 'page owners',
  teams: 'teams',
};

export interface GraphQlError {
  message?: string;
  extensions?: { classification?: unknown; statusCode?: unknown } | null;
}

export interface GraphQlResponse {
  data?: Record<string, unknown> | null;
  errors?: GraphQlError[];
}

type Node = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Returns the edge nodes of a connection field, ignoring malformed entries. */
export function nodesOf(response: GraphQlResponse, field: string): Node[] {
  const connection = response.data?.[field];
  if (typeof connection !== 'object' || connection === null) return [];
  const edges = (connection as { edges?: unknown }).edges;
  if (!Array.isArray(edges)) return [];
  return edges
    .map((edge) => (typeof edge === 'object' && edge !== null ? (edge as { node?: unknown }).node : undefined))
    .filter((node): node is Node => typeof node === 'object' && node !== null);
}

export function parseGoals(response: GraphQlResponse): GraphGoal[] {
  return nodesOf(response, QUERY_FIELDS.workItemGoals)
    .filter((node) => str(node.name))
    .map((node) => ({
      name: str(node.name) ?? '',
      ...(str(node.key) ? { key: str(node.key) } : {}),
      ...(str(node.url) ? { url: str(node.url) } : {}),
      ...(typeof node.archived === 'boolean' ? { archived: node.archived } : {}),
      ...(str(node.dueDateEndedAt) ? { dueDate: str(node.dueDateEndedAt) } : {}),
    }));
}

export function parsePullRequests(response: GraphQlResponse): GraphPullRequest[] {
  return nodesOf(response, QUERY_FIELDS.workItemPullRequests)
    .filter((node) => str(node.title) ?? str(node.displayName))
    .map((node) => ({
      title: str(node.title) ?? str(node.displayName) ?? '',
      status: str(node.status) ?? 'UNKNOWN',
      ...(str(node.url) ? { url: str(node.url) } : {}),
      ...(str(node.lastUpdatedAt) ? { updatedAt: str(node.lastUpdatedAt) } : {}),
    }));
}

export function parseUsers(response: GraphQlResponse, field: string): PersonRef[] {
  return nodesOf(response, field)
    .filter((node) => str(node.name))
    .map((node) => {
      const accountId = str(node.accountId);
      return accountId ? { accountId, name: str(node.name) ?? '' } : { name: str(node.name) ?? '' };
    });
}

export function parseTeams(response: GraphQlResponse): GraphTeam[] {
  return nodesOf(response, QUERY_FIELDS.spaceTeams)
    .filter((node) => str(node.displayName))
    .map((node) => ({
      name: str(node.displayName) ?? '',
      ...(str(node.profileUrl) ? { url: str(node.profileUrl) } : {}),
    }));
}

/** True when the response has GraphQL errors (for example, an unknown field or a denied request). */
export function hasErrors(response: GraphQlResponse): boolean {
  return Array.isArray(response.errors) && response.errors.length > 0;
}

/**
 * True when a query came back with errors and nothing under its field. The
 * graph answers HTTP 200 either way, so the status code cannot tell. Errors
 * beside usable data (one node that could not be resolved) are not a failure.
 */
export function isFailure(response: GraphQlResponse, field: string): boolean {
  return hasErrors(response) && !response.data?.[field];
}

function errorText(error: GraphQlError): string {
  const classification = error.extensions?.classification;
  const label = typeof classification === 'string' && classification.length > 0 ? classification : 'error';
  return `${label}: ${typeof error.message === 'string' ? error.message : 'no message'}`;
}

/** The first error on one line, for logs. It never includes the query variables. */
export function errorSummary(response: GraphQlResponse): string {
  const first = response.errors?.[0];
  return first ? truncate(oneLine(errorText(first)), 160) : 'no data';
}

/**
 * Failures that can pass unchanged a moment later: rate limits, gateway errors
 * and timeouts, and the refusal some sites give a share of identical reads.
 */
const TRANSIENT_TEXT =
  /not permitted to query this organization|rate.?limit|throttl|too many requests|tim(?:ed?)?[ -]?out|\bHTTP (?:429|502|503|504)\b/i;
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);

/** True when a failed query is worth sending again as it is. */
export function isTransient(response: GraphQlResponse): boolean {
  return (response.errors ?? []).some(
    (error) =>
      TRANSIENT_TEXT.test(errorText(error)) ||
      (typeof error.extensions?.statusCode === 'number' && TRANSIENT_STATUS.has(error.extensions.statusCode)),
  );
}

/** One sentence naming the sources the graph did not answer for, or an empty string. */
export function describeUnread(unread: GraphSource[]): string {
  const names = GRAPH_SOURCES.filter((source) => unread.includes(source)).map((source) => SOURCE_LABELS[source]);
  if (names.length === 0) return '';
  return `Could not read ${humanList(names)} this time; check again in a moment.`;
}

/** A short, user-facing line describing what the graph returned. */
export function describeGraph(ok: number, failed: number, withData: number, unread: GraphSource[] = []): string {
  if (ok === 0 && failed === 0) return 'not queried.';
  if (ok === 0) return 'unavailable on this site (requests failed).';
  const gap = describeUnread(unread);
  if (gap) {
    const found = withData === 0 ? 'nothing linked in the sources that answered.' : `${withData} of ${ok + failed} sources returned context.`;
    return `${found} ${gap}`;
  }
  if (withData === 0) {
    return 'no linked goals, pull requests, page owners or teams found. Either nothing is linked yet or the app was not granted its graph scopes.';
  }
  return `${withData} of ${ok + failed} sources returned context.`;
}
