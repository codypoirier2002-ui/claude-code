/**
 * Teamwork Graph queries and response parsing (pure, no network).
 *
 * Groundwork only uses curated queries, which need no registration step. Each
 * query is sent on its own and selects as few fields as possible, so a schema
 * change or a withheld scope breaks one enrichment instead of the whole panel.
 * Field names follow the object-type reference at
 * https://developer.atlassian.com/platform/teamwork-graph/api-reference/object-types/
 */
import type { GraphGoal, GraphPullRequest, GraphTeam, PersonRef } from './types';

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

export interface GraphQlError {
  message?: string;
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

/** A short, user-facing line describing what the graph returned. */
export function describeGraph(ok: number, failed: number, withData: number): string {
  if (ok === 0 && failed === 0) return 'not queried.';
  if (ok === 0) return 'unavailable on this site (requests failed).';
  if (withData === 0) {
    return 'no linked goals, pull requests, page owners or teams found. Either nothing is linked yet or the app was not granted its graph scopes.';
  }
  return `${withData} of ${ok + failed} sources returned context.`;
}
