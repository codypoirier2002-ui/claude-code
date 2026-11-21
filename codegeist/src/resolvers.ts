/**
 * Resolver for the "Ready check" panel on the Jira work item view. One call
 * returns everything the panel shows, to keep invocations (and cost) low.
 */
import Resolver from '@forge/resolver';
import { describeUnread } from './core/graph';
import type { Check, PersonSuggestion, Verdict } from './core/types';
import { needsUserConsent } from './platform/consent';
import { createGraphClient } from './platform/graph';
import { createJiraClient, JiraError } from './platform/jira';
import { analyzeIssue, normalizeIssueKey, type Clients } from './service';

export interface PanelModel {
  issueKey: string;
  score: number;
  verdict: Verdict;
  verdictLabel: string;
  checks: Check[];
  people: PersonSuggestion[];
  graph: {
    available: boolean;
    note: string;
    /** Names what the graph did not answer for. Empty when every source was read. */
    gap: string;
    goals: number;
    pullRequests: number;
    pageOwners: number;
    teams: number;
  };
  pack: string;
}

export interface PanelError {
  error: string;
}

interface PanelRequestContext {
  cloudId?: string;
  extension?: { issue?: { key?: unknown } };
}

export async function buildPanelModel(
  context: PanelRequestContext,
  clients: () => Clients = () => ({ jira: createJiraClient(), graph: createGraphClient() }),
): Promise<PanelModel | PanelError> {
  const issueKey = normalizeIssueKey(context.extension?.issue?.key);
  if (!issueKey) return { error: 'Open a work item to run the ready check.' };
  try {
    const { readiness, people, graph, pack } = await analyzeIssue(clients(), issueKey, context.cloudId);
    return {
      issueKey,
      score: readiness.score,
      verdict: readiness.verdict,
      verdictLabel: readiness.verdictLabel,
      checks: readiness.checks,
      people: people.slice(0, 3),
      graph: {
        available: graph.available,
        note: graph.note,
        gap: describeUnread(graph.unread),
        goals: graph.goals.length,
        pullRequests: graph.pullRequests.length,
        pageOwners: graph.pagePeople.reduce((sum, page) => sum + page.owners.length, 0),
        teams: graph.teams.length,
      },
      pack,
    };
  } catch (error) {
    // Forge sets up the person's access when it sees this error, but only if it leaves the resolver.
    if (needsUserConsent(error)) throw error;
    if (error instanceof JiraError) return { error: error.message };
    console.error('Groundwork panel failed', error instanceof Error ? error.message : String(error));
    return { error: 'Groundwork could not load this work item. Refresh to try again.' };
  }
}

const resolver = new Resolver();

resolver.define('getReadyCheck', async ({ context }) => buildPanelModel(context as PanelRequestContext));

export const handler = resolver.getDefinitions();
