/**
 * Rovo action handlers. The same three actions back the Groundwork agent, the
 * `ready-check` skill and the `rovo:mcp` tools, so every surface gives the same
 * answer. Handlers never throw: problems come back as `{ error }`, which an
 * agent can relay in plain language.
 */
import { plural } from './core/text';
import { createGraphClient } from './platform/graph';
import { createJiraClient, JiraError } from './platform/jira';
import {
  analyzeIssue,
  DEFAULT_SCAN_LIMIT,
  normalizeIssueKey,
  normalizeProjectKey,
  scanProject,
  type Clients,
  type IssueAnalysis,
  type ProjectScan,
} from './service';

/** Atlassian-app context that Rovo adds to an action payload when the user is on a work item. */
export interface ActionProductContext {
  cloudId?: string;
  moduleKey?: string;
  jira?: {
    issueKey?: unknown;
    projectKey?: unknown;
    url?: unknown;
  };
}

export interface ActionPayload {
  issueKey?: unknown;
  projectKey?: unknown;
  limit?: unknown;
  context?: ActionProductContext;
}

export interface InvocationContext {
  cloudId?: string;
  installContext?: string;
}

export interface ActionError {
  error: string;
}

export type ClientFactory = () => Clients;

const defaultClients: ClientFactory = () => ({ jira: createJiraClient(), graph: createGraphClient() });

const MISSING_ISSUE =
  'Tell me which work item to use, for example "KAN-12". I could not find a work item key in the request or the page you are on.';
const MISSING_PROJECT =
  'Tell me which project to scan, for example "KAN". I could not find a project key in the request or the page you are on.';

function keyFromUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const match = url.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/) ?? url.match(/selectedIssue=([A-Za-z][A-Za-z0-9_]*-\d+)/);
  return match ? normalizeIssueKey(match[1]) : undefined;
}

/** Picks the work item key from the action input first, then from the page the user is on. */
export function resolveIssueKey(payload: ActionPayload): string | undefined {
  return (
    normalizeIssueKey(payload.issueKey) ??
    normalizeIssueKey(payload.context?.jira?.issueKey) ??
    keyFromUrl(payload.context?.jira?.url)
  );
}

/** Picks the project key from the input, the page, or the prefix of the work item key. */
export function resolveProjectKey(payload: ActionPayload): string | undefined {
  const fromIssue = resolveIssueKey(payload)?.split('-')[0];
  return (
    normalizeProjectKey(payload.projectKey) ?? normalizeProjectKey(payload.context?.jira?.projectKey) ?? fromIssue
  );
}

/** Finds the site's cloud ID, which the Teamwork Graph needs to build ARIs. */
export function resolveCloudId(payload: ActionPayload, context?: InvocationContext): string | undefined {
  const fromInstall = context?.installContext?.match(/site\/([0-9a-fA-F-]{36})/)?.[1];
  return payload.context?.cloudId ?? context?.cloudId ?? fromInstall;
}

function toMessage(error: unknown): string {
  if (error instanceof JiraError) return error.message;
  console.error('Groundwork action failed', error instanceof Error ? error.message : String(error));
  return 'Groundwork could not read this work item right now. Try again, and check that the app is installed on this site.';
}

export interface ReadinessResult {
  issueKey: string;
  summary: string;
  url?: string;
  score: number;
  verdict: string;
  verdictLabel: string;
  gaps: { check: string; status: string; finding: string; fix?: string }[];
  passed: string[];
  notChecked: string[];
  peopleToAsk: { name: string; why: string }[];
  teamworkGraph: string;
  nextStep: string;
}

export function toReadinessResult(analysis: IssueAnalysis): ReadinessResult {
  const { facts, readiness, people, graph } = analysis;
  const gaps = readiness.checks
    .filter((c) => c.status === 'fail' || c.status === 'warn')
    .map((c) => ({ check: c.label, status: c.status, finding: c.detail, ...(c.fix ? { fix: c.fix } : {}) }));
  const nextStep =
    readiness.verdict === 'ready'
      ? 'It is ready. Use get-context-pack to hand it to a person or a coding agent.'
      : readiness.verdict === 'blocked'
        ? 'Resolve the open blockers first. Fixing the other gaps can happen in parallel.'
        : `Close the ${gaps.length === 1 ? 'gap' : `${gaps.length} gaps`} above, starting with the first, then check again.`;
  return {
    issueKey: facts.key,
    summary: facts.summary,
    ...(facts.url ? { url: facts.url } : {}),
    score: readiness.score,
    verdict: readiness.verdict,
    verdictLabel: readiness.verdictLabel,
    gaps,
    passed: readiness.checks.filter((c) => c.status === 'pass').map((c) => c.label),
    notChecked: readiness.checks.filter((c) => c.status === 'na').map((c) => c.label),
    peopleToAsk: people.slice(0, 3).map((p) => ({ name: p.name, why: p.reasons.join('; ') })),
    teamworkGraph: graph.note,
    nextStep,
  };
}

export interface ContextPackResult {
  issueKey: string;
  score: number;
  verdictLabel: string;
  contextPack: string;
}

export interface ReadyIssuesResult extends ProjectScan {
  note: string;
}

/** `check-issue-readiness`: scores one work item and explains each gap. */
export async function checkIssueReadiness(
  payload: ActionPayload,
  context?: InvocationContext,
  clients: ClientFactory = defaultClients,
): Promise<ReadinessResult | ActionError> {
  const issueKey = resolveIssueKey(payload ?? {});
  if (!issueKey) return { error: MISSING_ISSUE };
  try {
    const analysis = await analyzeIssue(clients(), issueKey, resolveCloudId(payload ?? {}, context));
    return toReadinessResult(analysis);
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/** `get-context-pack`: the Markdown brief for a person or a coding agent. */
export async function getContextPack(
  payload: ActionPayload,
  context?: InvocationContext,
  clients: ClientFactory = defaultClients,
): Promise<ContextPackResult | ActionError> {
  const issueKey = resolveIssueKey(payload ?? {});
  if (!issueKey) return { error: MISSING_ISSUE };
  try {
    const analysis = await analyzeIssue(clients(), issueKey, resolveCloudId(payload ?? {}, context));
    return {
      issueKey: analysis.facts.key,
      score: analysis.readiness.score,
      verdictLabel: analysis.readiness.verdictLabel,
      contextPack: analysis.pack,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/** `list-ready-issues`: ranks a project's to-do work by readiness. */
export async function listReadyIssues(
  payload: ActionPayload,
  _context?: InvocationContext,
  clients: ClientFactory = defaultClients,
): Promise<ReadyIssuesResult | ActionError> {
  const projectKey = resolveProjectKey(payload ?? {});
  if (!projectKey) return { error: MISSING_PROJECT };
  const limit = typeof payload?.limit === 'number' ? payload.limit : Number(payload?.limit ?? DEFAULT_SCAN_LIMIT);
  try {
    const scan = await scanProject(clients().jira, projectKey, Number.isFinite(limit) ? limit : DEFAULT_SCAN_LIMIT);
    const note =
      scan.scanned === 0
        ? `No to-do work items found in ${projectKey}.`
        : `Scanned ${plural(scan.scanned, 'to-do work item')} in ${projectKey}; ${scan.readyCount} ready to start. ` +
          'Project scans skip comments, remote links and the Teamwork Graph; check one item for the full picture.';
    return { ...scan, note };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
