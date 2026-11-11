/**
 * Teamwork Graph access, as the current user. Results are permission-filtered
 * by Atlassian, so a person only ever sees graph context they could already see.
 */
import api from '@forge/api';
import { QUERIES, type GraphQlResponse, type QueryName } from '../core/graph';

export interface GraphClient {
  query(name: QueryName, variables: Record<string, unknown>): Promise<GraphQlResponse>;
}

/** The Teamwork Graph client used in production. */
export function createGraphClient(): GraphClient {
  return {
    async query(name, variables) {
      const response = await api.asUser().requestTeamworkGraph(QUERIES[name], variables);
      if (!response.ok) {
        return { errors: [{ message: `Teamwork Graph returned HTTP ${response.status}` }] };
      }
      return (await response.json()) as GraphQlResponse;
    },
  };
}
