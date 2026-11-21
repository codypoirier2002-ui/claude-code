/**
 * Orchestration shared by the issue panel, the Rovo actions and the MCP tools:
 * load the facts, enrich them from the Teamwork Graph, score them and build the
 * context pack. Clients are passed in, so tests can use fakes.
 */
import { buildContextPack } from './core/contextPack';
import { toIssueFacts, type FieldIds, type JiraIssue } from './core/facts';
import {
  confluencePageAri,
  describeGraph,
  errorSummary,
  GRAPH_SOURCES,
  isFailure,
  issueAri,
  logSafe,
  parseGoals,
  parsePullRequests,
  parseTeams,
  parseUsers,
  projectAri,
  QUERY_FIELDS,
  QUERY_SOURCES,
  type GraphQlResponse,
  type QueryName,
} from './core/graph';
import { rankPeople } from './core/people';
import { evaluateReadiness } from './core/readiness';
import type {
  GraphContext,
  GraphPagePeople,
  GraphSource,
  IssueFacts,
  PersonSuggestion,
  Readiness,
  Verdict,
} from './core/types';
import { needsUserConsent } from './platform/consent';
import type { GraphClient } from './platform/graph';
import type { JiraClient } from './platform/jira';

export interface Clients {
  jira: JiraClient;
  graph?: GraphClient;
}

export interface IssueAnalysis {
  facts: IssueFacts;
  graph: GraphContext;
  readiness: Readiness;
  people: PersonSuggestion[];
  pack: string;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,49}$/;
const MAX_COMMENTS = 5;
const MAX_LINKED_PAGES = 3;
export const DEFAULT_SCAN_LIMIT = 10;
export const MAX_SCAN_LIMIT = 25;

/** Returns the normalized work item key, or undefined when the input is not a key. */
export function normalizeIssueKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toUpperCase();
  return ISSUE_KEY.test(key) ? key : undefined;
}

/** Returns the normalized project key, or undefined when the input is not a key. */
export function normalizeProjectKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toUpperCase();
  return PROJECT_KEY.test(key) ? key : undefined;
}

export const EMPTY_GRAPH: GraphContext = {
  available: false,
  sourcesWithData: 0,
  note: 'not queried.',
  unread: [],
  goals: [],
  pullRequests: [],
  pagePeople: [],
  teams: [],
};

/**
 * Best effort: a read that fails becomes `undefined`. The consent error is the
 * exception, because Forge has to see it to set up the person's access.
 */
function optional<T>(read: Promise<T>): Promise<T | undefined> {
  return read.catch((error: unknown) => {
    if (needsUserConsent(error)) throw error;
    return undefined;
  });
}

/** Loads the work item, its remote links and its latest comments. Links and comments are best effort. */
export async function loadIssueFacts(jira: JiraClient, issueKey: string): Promise<IssueFacts> {
  const [issue, remoteLinks, comments] = await Promise.all([
    jira.getIssue(issueKey),
    optional(jira.getRemoteLinks(issueKey)),
    optional(jira.getComments(issueKey, MAX_COMMENTS)),
  ]);
  return toIssueFacts({ issue, remoteLinks, comments });
}

interface Tracker {
  ok: number;
  failed: number;
  withData: number;
  unread: Set<GraphSource>;
  /** One entry per failed query, for the log. */
  failures: string[];
}

async function runQuery(
  graph: GraphClient,
  tracker: Tracker,
  name: QueryName,
  variables: Record<string, unknown>,
): Promise<GraphQlResponse | undefined> {
  let reason: string;
  try {
    const response = await graph.query(name, variables);
    if (!isFailure(response, QUERY_FIELDS[name])) {
      tracker.ok += 1;
      return response;
    }
    reason = errorSummary(response);
  } catch (error) {
    // The consent error stops here too, on purpose. Graph reads run only after Jira has answered for
    // the same person, so the prompt could not fix a refusal here, and rethrowing it would take the
    // whole check down for the sake of an enrichment.
    reason = logSafe(error instanceof Error ? error.message : String(error));
  }
  tracker.failed += 1;
  tracker.unread.add(QUERY_SOURCES[name]);
  tracker.failures.push(`${name} (${reason})`);
  return undefined;
}

/** Reads goals, pull requests, page owners and teams from the Teamwork Graph. Never throws. */
export async function loadGraphContext(
  graph: GraphClient | undefined,
  facts: IssueFacts,
  cloudId: string | undefined,
): Promise<GraphContext> {
  if (!graph || !cloudId || !facts.id) return EMPTY_GRAPH;
  const tracker: Tracker = { ok: 0, failed: 0, withData: 0, unread: new Set(), failures: [] };
  const count = <T>(items: T[]): T[] => {
    if (items.length > 0) tracker.withData += 1;
    return items;
  };
  const itemAri = issueAri(cloudId, facts.id);
  const pages = facts.docs.filter((doc) => doc.confluencePageId).slice(0, MAX_LINKED_PAGES);

  const [goals, pullRequests, teams, pagePeople] = await Promise.all([
    runQuery(graph, tracker, 'workItemGoals', { id: itemAri }).then((r) => count(r ? parseGoals(r) : [])),
    runQuery(graph, tracker, 'workItemPullRequests', { id: itemAri }).then((r) =>
      count(r ? parsePullRequests(r) : []),
    ),
    facts.projectId
      ? runQuery(graph, tracker, 'spaceTeams', { spaceAri: projectAri(cloudId, facts.projectId) }).then((r) =>
          count(r ? parseTeams(r) : []),
        )
      : Promise.resolve([]),
    Promise.all(
      pages.map(async (doc): Promise<GraphPagePeople> => {
        const pageAri = confluencePageAri(cloudId, doc.confluencePageId ?? '');
        const [owners, contributors] = await Promise.all([
          runQuery(graph, tracker, 'pageOwners', { id: pageAri }).then((r) =>
            count(r ? parseUsers(r, QUERY_FIELDS.pageOwners) : []),
          ),
          runQuery(graph, tracker, 'pageContributors', { id: pageAri }).then((r) =>
            count(r ? parseUsers(r, QUERY_FIELDS.pageContributors) : []),
          ),
        ]);
        return { pageId: doc.confluencePageId ?? '', pageTitle: doc.title, owners, contributors };
      }),
    ),
  ]);

  const unread = GRAPH_SOURCES.filter((source) => tracker.unread.has(source));
  if (tracker.failures.length > 0) {
    // Query names and error text only. `logSafe` has removed any ARI or ID the server echoed.
    const total = tracker.ok + tracker.failed;
    console.error(`Groundwork: ${tracker.failed} of ${total} Teamwork Graph queries failed: ${tracker.failures.sort().join('; ')}`);
  }

  return {
    available: tracker.ok > 0,
    sourcesWithData: tracker.withData,
    note: describeGraph(tracker.ok, tracker.failed, tracker.withData, unread),
    unread,
    goals,
    pullRequests,
    pagePeople: pagePeople.filter((p) => p.owners.length > 0 || p.contributors.length > 0),
    teams,
  };
}

/** The full analysis behind the panel, the readiness action and the context pack. */
export async function analyzeIssue(
  clients: Clients,
  issueKey: string,
  cloudId: string | undefined,
  generatedAt?: string,
): Promise<IssueAnalysis> {
  const facts = await loadIssueFacts(clients.jira, issueKey);
  const graph = await loadGraphContext(clients.graph, facts, cloudId);
  const readiness = evaluateReadiness(facts, graph, 'full');
  const people = rankPeople(facts, graph);
  const pack = buildContextPack(facts, readiness, graph, people, generatedAt ? { generatedAt } : {});
  return { facts, graph, readiness, people, pack };
}

export interface ScanItem {
  key: string;
  summary: string;
  issueType: string;
  statusName: string;
  url?: string;
  score: number;
  verdict: Verdict;
  verdictLabel: string;
  topGap?: string;
}

export interface ProjectScan {
  projectKey: string;
  scanned: number;
  readyCount: number;
  items: ScanItem[];
}

const SCAN_FIELDS = [
  'summary',
  'description',
  'issuetype',
  'status',
  'priority',
  'project',
  'assignee',
  'reporter',
  'labels',
  'components',
  'parent',
  'issuelinks',
  'timeoriginalestimate',
  'created',
  'updated',
];

const VERDICT_ORDER: Record<Verdict, number> = { ready: 0, almost: 1, 'not-ready': 2, blocked: 3 };

/** Builds the JQL for a project scan. The key must already be validated. */
export function scanJql(projectKey: string): string {
  return `project = "${projectKey}" AND statusCategory = "To Do" ORDER BY priority DESC, updated DESC`;
}

/** Ranks a project's to-do work by readiness, using one search request ("lite" checks). */
export async function scanProject(jira: JiraClient, projectKey: string, limit: number): Promise<ProjectScan> {
  const max = Math.min(Math.max(Math.trunc(limit) || DEFAULT_SCAN_LIMIT, 1), MAX_SCAN_LIMIT);
  const fieldIds: FieldIds = (await optional(jira.getFieldIds())) ?? {};
  const fields = [...SCAN_FIELDS, fieldIds.storyPoints, fieldIds.acceptanceCriteria].filter(
    (field): field is string => typeof field === 'string',
  );
  const issues: JiraIssue[] = await jira.searchIssues(scanJql(projectKey), fields, max);
  const items = issues.map((issue): ScanItem => {
    const facts = toIssueFacts({ issue, fieldIds });
    const readiness = evaluateReadiness(facts, null, 'lite');
    return {
      key: facts.key,
      summary: facts.summary,
      issueType: facts.issueType,
      statusName: facts.statusName,
      ...(facts.url ? { url: facts.url } : {}),
      score: readiness.score,
      verdict: readiness.verdict,
      verdictLabel: readiness.verdictLabel,
      ...(readiness.gaps[0] ? { topGap: readiness.gaps[0] } : {}),
    };
  });
  items.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || b.score - a.score);
  return {
    projectKey,
    scanned: items.length,
    readyCount: items.filter((item) => item.verdict === 'ready').length,
    items,
  };
}
