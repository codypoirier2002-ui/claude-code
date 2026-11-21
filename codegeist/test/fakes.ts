/** In-memory fakes for the Jira and Teamwork Graph clients. */
import type { FieldIds, JiraComment, JiraIssue, JiraRemoteLink } from '../src/core/facts';
import type { GraphQlResponse, QueryName } from '../src/core/graph';
import type { GraphClient } from '../src/platform/graph';
import { JiraError, type JiraClient } from '../src/platform/jira';

export interface FakeJiraData {
  issues?: Record<string, JiraIssue>;
  remoteLinks?: Record<string, JiraRemoteLink[] | Error>;
  comments?: Record<string, JiraComment[] | Error>;
  search?: JiraIssue[];
  fieldIds?: FieldIds | Error;
}

export interface FakeJira extends JiraClient {
  searches: { jql: string; fields: string[]; max: number }[];
}

export function fakeJira(data: FakeJiraData): FakeJira {
  const searches: FakeJira['searches'] = [];
  const settle = <T>(value: T | Error | undefined, fallback: T): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? fallback);
  return {
    searches,
    async getIssue(key) {
      const issue = data.issues?.[key];
      if (!issue) throw new JiraError(`work item ${key} was not found, or you do not have permission to view it.`, 404);
      return issue;
    },
    getRemoteLinks: (key) => settle(data.remoteLinks?.[key], []),
    getComments: (key) => settle(data.comments?.[key], []),
    async searchIssues(jql, fields, max) {
      searches.push({ jql, fields, max });
      return (data.search ?? []).slice(0, max);
    },
    getFieldIds: () => settle(data.fieldIds, {}),
  };
}

export interface FakeGraph extends GraphClient {
  calls: { name: QueryName; variables: Record<string, unknown> }[];
}

type Reply = GraphQlResponse | Error;

/**
 * Each query name maps to a response, an Error (thrown) or nothing (empty data).
 * A list answers one call after another, and its last entry answers every call after that.
 */
export function fakeGraph(responses: Partial<Record<QueryName, Reply | Reply[]>>): FakeGraph {
  const calls: FakeGraph['calls'] = [];
  const served = new Map<QueryName, number>();
  return {
    calls,
    async query(name, variables) {
      calls.push({ name, variables });
      const scripted = responses[name];
      let reply: Reply | undefined;
      if (Array.isArray(scripted)) {
        const index = served.get(name) ?? 0;
        served.set(name, index + 1);
        reply = scripted[Math.min(index, scripted.length - 1)];
      } else {
        reply = scripted;
      }
      if (reply instanceof Error) throw reply;
      return reply ?? { data: {} };
    },
  };
}
