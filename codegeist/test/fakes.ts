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

/** Each query name maps to a response, an Error (thrown) or nothing (empty data). */
export function fakeGraph(responses: Partial<Record<QueryName, GraphQlResponse | Error>>): FakeGraph {
  const calls: FakeGraph['calls'] = [];
  return {
    calls,
    async query(name, variables) {
      calls.push({ name, variables });
      const response = responses[name];
      if (response instanceof Error) throw response;
      return response ?? { data: {} };
    },
  };
}
