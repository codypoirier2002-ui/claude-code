/**
 * The context pack: one compact Markdown brief that gives a person, a Rovo
 * agent or an MCP-connected coding agent the context needed to start a work
 * item. It is deterministic, so the same inputs always produce the same pack.
 */
import { oneLine, plural, truncate } from './text';
import type { Check, GraphContext, IssueFacts, PersonSuggestion, Readiness } from './types';

export interface ContextPackOptions {
  /** Hard cap on the pack length, in characters. */
  maxChars?: number;
  /** Cap for the description section, in characters. */
  maxDescriptionChars?: number;
  /** ISO date stamped in the footer. Defaults to today. */
  generatedAt?: string;
}

const STATUS_MARK: Record<Check['status'], string> = {
  pass: '✅',
  warn: '⚠️',
  fail: '❌',
  na: '➖',
};

const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_MAX_DESCRIPTION = 2500;
const MAX_COMMENTS = 3;
const MAX_COMMENT_CHARS = 280;

function bullet(lines: string[], empty: string): string {
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join('\n') : empty;
}

function header(facts: IssueFacts): string {
  const meta = [facts.issueType, facts.statusName];
  if (facts.priority) meta.push(`Priority ${facts.priority}`);
  meta.push(`Assignee: ${facts.assignee?.name ?? 'Unassigned'}`);
  if (facts.reporter) meta.push(`Reporter: ${facts.reporter.name}`);
  const lines = [`# ${facts.key} · ${oneLine(facts.summary)}`, '', meta.join(' · ')];
  if (facts.url) lines.push(`Link: ${facts.url}`);
  if (facts.labels.length > 0) lines.push(`Labels: ${facts.labels.join(', ')}`);
  if (facts.components.length > 0) lines.push(`Components: ${facts.components.join(', ')}`);
  return lines.join('\n');
}

function readinessSection(readiness: Readiness): string {
  const gaps = readiness.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
  const passed = readiness.checks.filter((c) => c.status === 'pass').map((c) => c.label);
  const lines = gaps.map((c) => `${STATUS_MARK[c.status]} **${c.label}:** ${c.detail}${c.fix ? ` Fix: ${c.fix}` : ''}`);
  const body = [
    `## Readiness: ${readiness.score}/100 · ${readiness.verdictLabel}`,
    '',
    lines.length > 0 ? lines.join('\n') : '✅ No gaps found.',
  ];
  if (passed.length > 0) body.push('', `Passed: ${passed.join(', ')}.`);
  return body.join('\n');
}

function purposeSection(facts: IssueFacts, graph: GraphContext | null): string {
  const lines: string[] = [];
  if (facts.parent) {
    const status = facts.parent.statusName ? ` (${facts.parent.statusName})` : '';
    lines.push(`Part of ${facts.parent.issueType ?? 'parent'} ${facts.parent.key} "${oneLine(facts.parent.summary)}"${status}`);
  }
  for (const goal of (graph?.goals ?? []).filter((g) => !g.archived).slice(0, 3)) {
    const due = goal.dueDate ? `, due ${goal.dueDate.slice(0, 10)}` : '';
    lines.push(`Goal: ${goal.url ? `[${goal.name}](${goal.url})` : goal.name}${due}`);
  }
  for (const team of (graph?.teams ?? []).slice(0, 2)) {
    lines.push(`Owning team: ${team.url ? `[${team.name}](${team.url})` : team.name}`);
  }
  return `## Why it matters\n\n${bullet(lines, 'No epic, goal or team is linked.')}`;
}

function descriptionSection(facts: IssueFacts, maxChars: number): string {
  const text = facts.descriptionMarkdown.trim();
  const body = text.length === 0 ? '_No description._' : truncate(text, maxChars);
  const sections = [`## Description\n\n${body}`];
  if (facts.acceptanceCriteriaText && facts.acceptanceCriteriaText.trim().length > 0) {
    sections.push(`## Acceptance criteria\n\n${truncate(facts.acceptanceCriteriaText.trim(), 1200)}`);
  }
  return sections.join('\n\n');
}

function dependenciesSection(facts: IssueFacts): string {
  const lines = facts.links
    .slice(0, 8)
    .map((link) => {
      const flag = link.isBlocker && link.statusCategory !== 'done' ? ' **(open blocker)**' : '';
      return `${link.relation} ${link.key} "${truncate(oneLine(link.summary), 70)}" · ${link.statusName}${flag}`;
    });
  return `## Linked work\n\n${bullet(lines, 'None.')}`;
}

function docsSection(facts: IssueFacts): string {
  const lines = facts.docs.slice(0, 8).map((doc) => `[${oneLine(doc.title)}](${doc.url})`);
  return `## Linked docs\n\n${bullet(lines, 'None linked.')}`;
}

function codeSection(graph: GraphContext | null): string | undefined {
  const prs = graph?.pullRequests ?? [];
  if (prs.length === 0) return undefined;
  const lines = prs.slice(0, 5).map((pr) => `${pr.url ? `[${oneLine(pr.title)}](${pr.url})` : oneLine(pr.title)} · ${pr.status}`);
  return `## Code\n\n${bullet(lines, 'None.')}`;
}

function discussionSection(facts: IssueFacts): string | undefined {
  if (!facts.commentsLoaded) return undefined;
  const lines = facts.comments
    .slice(0, MAX_COMMENTS)
    .map((c) => `${c.created.slice(0, 10)} · ${c.author.name}: "${truncate(oneLine(c.text), MAX_COMMENT_CHARS)}"`);
  return `## Recent discussion (newest first)\n\n${bullet(lines, 'No comments.')}`;
}

function peopleSection(people: PersonSuggestion[]): string {
  const lines = people.map((p, i) => `${i + 1}. ${p.name}: ${p.reasons.join('; ')}`);
  return `## People to ask\n\n${lines.length > 0 ? lines.join('\n') : 'No one is connected to this work item yet.'}`;
}

function footer(graph: GraphContext | null, generatedAt: string): string {
  const graphNote = graph ? ` Teamwork Graph: ${graph.note}` : '';
  return `---\nGenerated by Groundwork on ${generatedAt}, a read-only snapshot.${graphNote}`;
}

/** Builds the Markdown context pack for one work item. */
export function buildContextPack(
  facts: IssueFacts,
  readiness: Readiness,
  graph: GraphContext | null,
  people: PersonSuggestion[],
  options: ContextPackOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const generatedAt = options.generatedAt ?? new Date().toISOString().slice(0, 10);
  const build = (descriptionChars: number): string =>
    [
      header(facts),
      readinessSection(readiness),
      purposeSection(facts, graph),
      descriptionSection(facts, descriptionChars),
      dependenciesSection(facts),
      docsSection(facts),
      codeSection(graph),
      discussionSection(facts),
      peopleSection(people),
      footer(graph, generatedAt),
    ]
      .filter((section): section is string => section !== undefined)
      .join('\n\n');

  let descriptionChars = options.maxDescriptionChars ?? DEFAULT_MAX_DESCRIPTION;
  let pack = build(descriptionChars);
  // Give back description space first, because it is the largest and least structured section.
  while (pack.length > maxChars && descriptionChars > 300) {
    descriptionChars = Math.max(300, descriptionChars - (pack.length - maxChars) - 50);
    pack = build(descriptionChars);
  }
  if (pack.length > maxChars) {
    const note = `\n\n_(Context pack truncated to ${plural(maxChars, 'character')}.)_`;
    pack = truncate(pack, maxChars - note.length) + note;
  }
  return pack;
}
