/**
 * Shared types for Groundwork's core logic.
 *
 * The core is pure: it takes plain objects (already fetched from Jira and the
 * Teamwork Graph) and returns plain objects. All network access lives in
 * `src/platform`, which keeps everything in `src/core` unit-testable.
 */

export type StatusCategory = 'new' | 'indeterminate' | 'done' | 'unknown';

export interface PersonRef {
  /** Atlassian account ID, when known. Used to de-duplicate and to render avatars. */
  accountId?: string;
  name: string;
}

export interface LinkedIssue {
  key: string;
  summary: string;
  statusName: string;
  statusCategory: StatusCategory;
  /** The relationship as seen from the work item being checked, e.g. "is blocked by". */
  relation: string;
  /** True when the linked item must be finished before this one can start. */
  isBlocker: boolean;
}

export interface DocLink {
  title: string;
  url: string;
  kind: 'confluence' | 'web';
  /** Numeric Confluence content ID, when the link points at a Confluence page. */
  confluencePageId?: string;
  source: 'remote-link' | 'description';
}

export interface CommentFact {
  author: PersonRef;
  /** ISO 8601 timestamp. */
  created: string;
  text: string;
}

export interface ParentFact {
  key: string;
  summary: string;
  issueType?: string;
  statusName?: string;
}

/** Everything Groundwork knows about one Jira work item, normalized from the REST API. */
export interface IssueFacts {
  key: string;
  id: string;
  summary: string;
  issueType: string;
  isBug: boolean;
  isSubtask: boolean;
  isEpic: boolean;
  statusName: string;
  statusCategory: StatusCategory;
  priority?: string;
  projectKey: string;
  projectId: string;
  assignee?: PersonRef;
  reporter?: PersonRef;
  /** Plain-text description, used for checks. */
  descriptionText: string;
  /** Markdown description, used in the context pack. */
  descriptionMarkdown: string;
  /** Content of a dedicated "Acceptance criteria" field, when the site has one. */
  acceptanceCriteriaText?: string;
  storyPoints?: number;
  originalEstimateSeconds?: number;
  parent?: ParentFact;
  labels: string[];
  components: string[];
  links: LinkedIssue[];
  docs: DocLink[];
  /** People @-mentioned in the description. */
  mentions: PersonRef[];
  /** Newest first. Empty when comments were not loaded. */
  comments: CommentFact[];
  commentsLoaded: boolean;
  remoteLinksLoaded: boolean;
  /** Browser URL of the work item, when it can be derived. */
  url?: string;
  created?: string;
  updated?: string;
}

export interface GraphGoal {
  name: string;
  key?: string;
  url?: string;
  archived?: boolean;
  dueDate?: string;
}

export interface GraphPullRequest {
  title: string;
  status: string;
  url?: string;
  updatedAt?: string;
}

export interface GraphPagePeople {
  pageId: string;
  pageTitle: string;
  owners: PersonRef[];
  contributors: PersonRef[];
}

export interface GraphTeam {
  name: string;
  url?: string;
}

/** Context from the Teamwork Graph. Every list may be empty. */
export interface GraphContext {
  /** True when at least one graph query ran without errors. */
  available: boolean;
  /** Number of queries that returned at least one result. */
  sourcesWithData: number;
  /** One-line, user-facing explanation of the graph status. */
  note: string;
  goals: GraphGoal[];
  pullRequests: GraphPullRequest[];
  pagePeople: GraphPagePeople[];
  teams: GraphTeam[];
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'na';

export type CheckId =
  | 'clear-title'
  | 'enough-detail'
  | 'done-defined'
  | 'reproducible'
  | 'unblocked'
  | 'purpose'
  | 'references'
  | 'sized'
  | 'open-questions'
  | 'work-in-flight';

export interface Check {
  id: CheckId;
  label: string;
  status: CheckStatus;
  /** Contribution to the 0–100 score when the check applies. */
  weight: number;
  /** What Groundwork found. */
  detail: string;
  /** How to close the gap. Present for `warn` and `fail`. */
  fix?: string;
  source: 'jira' | 'graph';
}

export type Verdict = 'ready' | 'almost' | 'not-ready' | 'blocked';

export interface Readiness {
  issueKey: string;
  score: number;
  verdict: Verdict;
  verdictLabel: string;
  /** "full" reads links, remote links and comments. "lite" uses search fields only. */
  mode: 'full' | 'lite';
  checks: Check[];
  /** Labels of the checks that warned or failed, worst first. */
  gaps: string[];
}

export interface PersonSuggestion extends PersonRef {
  score: number;
  reasons: string[];
}
