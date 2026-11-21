/**
 * Jira REST API v3 access, always as the current user, so Groundwork can only
 * read what that person can already see.
 */
import api, { route } from '@forge/api';
import { findFieldIds, type FieldIds, type JiraComment, type JiraIssue, type JiraRemoteLink } from '../core/facts';

export class JiraError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
  }
}

export interface JiraClient {
  getIssue(issueKey: string): Promise<JiraIssue>;
  getRemoteLinks(issueKey: string): Promise<JiraRemoteLink[]>;
  /** Newest first. */
  getComments(issueKey: string, max: number): Promise<JiraComment[]>;
  searchIssues(jql: string, fields: string[], max: number): Promise<JiraIssue[]>;
  getFieldIds(): Promise<FieldIds>;
}

interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

function explain(status: number, what: string): string {
  if (status === 404) return `${what} was not found, or you do not have permission to view it.`;
  if (status === 401 || status === 403) return `You do not have permission to view ${what}.`;
  if (status === 400) return `Jira rejected the request for ${what}.`;
  if (status === 429) return 'Jira is rate limiting requests right now. Try again in a minute.';
  return `Jira returned an error (${status}) for ${what}.`;
}

async function readJson<T>(response: ResponseLike, what: string): Promise<T> {
  if (!response.ok) throw new JiraError(explain(response.status, what), response.status);
  return (await response.json()) as T;
}

/** The Jira client used in production. */
export function createJiraClient(): JiraClient {
  const jira = api.asUser();
  return {
    async getIssue(issueKey) {
      const response = await jira.requestJira(
        route`/rest/api/3/issue/${issueKey}?expand=names&fields=*navigable,-comment,-worklog`,
        { headers: { Accept: 'application/json' } },
      );
      return readJson<JiraIssue>(response, `work item ${issueKey}`);
    },

    async getRemoteLinks(issueKey) {
      const response = await jira.requestJira(route`/rest/api/3/issue/${issueKey}/remotelink`, {
        headers: { Accept: 'application/json' },
      });
      const links = await readJson<unknown>(response, `the links of ${issueKey}`);
      return Array.isArray(links) ? (links as JiraRemoteLink[]) : [];
    },

    async getComments(issueKey, max) {
      const response = await jira.requestJira(
        route`/rest/api/3/issue/${issueKey}/comment?orderBy=-created&maxResults=${String(max)}`,
        { headers: { Accept: 'application/json' } },
      );
      const page = await readJson<{ comments?: JiraComment[] }>(response, `the comments of ${issueKey}`);
      return Array.isArray(page.comments) ? page.comments : [];
    },

    async searchIssues(jql, fields, max) {
      const response = await jira.requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jql, fields, maxResults: max }),
      });
      const page = await readJson<{ issues?: JiraIssue[] }>(response, 'the project search');
      return Array.isArray(page.issues) ? page.issues : [];
    },

    async getFieldIds() {
      const response = await jira.requestJira(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } });
      const fields = await readJson<unknown>(response, 'the field list');
      const names: Record<string, string> = {};
      if (Array.isArray(fields)) {
        for (const field of fields as { id?: unknown; name?: unknown }[]) {
          if (typeof field.id === 'string' && typeof field.name === 'string') names[field.id] = field.name;
        }
      }
      return findFieldIds(names);
    },
  };
}
