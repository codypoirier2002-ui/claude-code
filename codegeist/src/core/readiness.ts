/**
 * The ready check: explainable, weighted checks that turn a work item into a
 * 0–100 score and a verdict. Every check says what it found and, when it warns
 * or fails, how to fix it.
 */
import { findAcceptanceCriteria, findOpenQuestion, findReproSteps, hasPlaceholder } from './detect';
import { humanList, plural, truncate, wordCount } from './text';
import type { Check, CheckId, GraphContext, IssueFacts, Readiness, Verdict } from './types';

export const WEIGHTS: Record<CheckId, number> = {
  'clear-title': 10,
  'enough-detail': 15,
  'done-defined': 25,
  reproducible: 25,
  unblocked: 20,
  purpose: 10,
  references: 5,
  sized: 5,
  'open-questions': 5,
  'work-in-flight': 5,
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  ready: 'Ready to start',
  almost: 'Almost ready',
  'not-ready': 'Not ready',
  blocked: 'Blocked',
};

const READY_THRESHOLD = 80;
const ALMOST_THRESHOLD = 55;
const SHORT_DESCRIPTION_WORDS = 25;
const LARGE_STORY_POINTS = 13;

type Draft = Omit<Check, 'weight' | 'source'> & { source?: Check['source'] };

function check(draft: Draft): Check {
  return { ...draft, weight: WEIGHTS[draft.id], source: draft.source ?? 'jira' };
}

function clearTitle(facts: IssueFacts): Check {
  const words = wordCount(facts.summary);
  const base = { id: 'clear-title' as const, label: 'Clear title' };
  if (words < 3) {
    return check({
      ...base,
      status: 'fail',
      detail: `The title has ${plural(words, 'word')}.`,
      fix: 'Say what changes and for whom, for example "Let admins export audit logs as CSV".',
    });
  }
  if (hasPlaceholder(facts.summary)) {
    return check({
      ...base,
      status: 'warn',
      detail: 'The title still contains a placeholder such as "TBD".',
      fix: 'Replace the placeholder with the actual change.',
    });
  }
  if (words > 25) {
    return check({
      ...base,
      status: 'warn',
      detail: `The title is long (${words} words).`,
      fix: 'Keep the title to one line and move the detail into the description.',
    });
  }
  return check({ ...base, status: 'pass', detail: `The title is specific (${words} words).` });
}

function enoughDetail(facts: IssueFacts): Check {
  const words = wordCount(facts.descriptionText);
  const base = { id: 'enough-detail' as const, label: 'Enough detail' };
  if (words === 0) {
    return check({
      ...base,
      status: facts.isSubtask ? 'warn' : 'fail',
      detail: 'There is no description.',
      fix: 'Describe the problem, who has it and any constraints, so a newcomer can start without asking.',
    });
  }
  if (words < SHORT_DESCRIPTION_WORDS) {
    return check({
      ...base,
      status: 'warn',
      detail: `The description is short (${plural(words, 'word')}).`,
      fix: 'Add the background a newcomer would need: why this matters, what is in and out of scope.',
    });
  }
  return check({ ...base, status: 'pass', detail: `The description has ${words} words.` });
}

function doneDefined(facts: IssueFacts): Check {
  const evidence = findAcceptanceCriteria(facts.descriptionText, facts.acceptanceCriteriaText);
  const label = facts.isEpic ? 'Success is defined' : 'Done is defined';
  const base = { id: 'done-defined' as const, label };
  if (evidence.found) {
    const where: Record<NonNullable<typeof evidence.source>, string> = {
      field: `in the acceptance criteria field (${plural(evidence.count, 'line')})`,
      heading: `in the description (${plural(evidence.count, 'item')})`,
      gherkin: `as ${plural(evidence.count, 'Given/When/Then scenario')}`,
      checklist: `as a checklist of ${plural(evidence.count, 'item')}`,
    };
    return check({
      ...base,
      status: 'pass',
      detail: `Acceptance criteria found ${where[evidence.source ?? 'heading']}.`,
    });
  }
  return check({
    ...base,
    status: facts.isSubtask ? 'warn' : 'fail',
    detail: 'No acceptance criteria were found.',
    fix: 'Add 2–5 testable statements under an "Acceptance criteria" heading, for example "Given…, when…, then…".',
  });
}

function reproducible(facts: IssueFacts): Check {
  const evidence = findReproSteps(facts.descriptionText);
  const base = { id: 'reproducible' as const, label: 'Reproducible' };
  const hasResults = evidence.hasExpected && evidence.hasActual;
  if (evidence.hasSteps && hasResults) {
    return check({
      ...base,
      status: 'pass',
      detail: `${plural(evidence.stepCount, 'step')} to reproduce, with expected and actual results.`,
    });
  }
  if (evidence.hasSteps || hasResults) {
    const missing = evidence.hasSteps ? 'expected and actual results' : 'steps to reproduce';
    return check({
      ...base,
      status: 'warn',
      detail: `The bug report is missing ${missing}.`,
      fix: evidence.hasSteps
        ? 'Add "Expected:" and "Actual:" lines after the steps.'
        : 'Add numbered steps that reproduce the bug from a clean start.',
    });
  }
  return check({
    ...base,
    status: 'fail',
    detail: 'There are no steps to reproduce and no expected or actual results.',
    fix: 'Add numbered steps to reproduce, then "Expected:" and "Actual:" lines.',
  });
}

function unblocked(facts: IssueFacts, mode: Readiness['mode']): Check {
  const base = { id: 'unblocked' as const, label: 'No open blockers' };
  const blockers = facts.links.filter((link) => link.isBlocker);
  const open = blockers.filter((link) => link.statusCategory !== 'done');
  if (open.length > 0) {
    const list = open.slice(0, 3).map((link) => `${link.key} (${link.statusName})`);
    const more = open.length > 3 ? ` and ${open.length - 3} more` : '';
    return check({
      ...base,
      status: 'fail',
      detail: `Blocked by ${humanList(list)}${more}.`,
      fix: 'Resolve the blockers first, or split out the part that is not blocked.',
    });
  }
  if (blockers.length > 0) {
    const detail = blockers.length === 1 ? 'The only blocker is done.' : `All ${blockers.length} blockers are done.`;
    return check({ ...base, status: 'pass', detail });
  }
  const detail = mode === 'lite' ? 'No blocking links in the work item fields.' : 'No blocking links.';
  return check({ ...base, status: 'pass', detail });
}

function purpose(facts: IssueFacts, graph: GraphContext | null): Check {
  const base = { id: 'purpose' as const, label: 'Purpose is clear' };
  const goals = (graph?.goals ?? []).filter((goal) => !goal.archived);
  const reasons: string[] = [];
  if (facts.parent && !facts.isEpic) {
    reasons.push(`part of ${facts.parent.key} "${truncate(facts.parent.summary, 60)}"`);
  }
  if (goals.length > 0) {
    reasons.push(`contributes to goal "${truncate(goals[0].name, 60)}"`);
  }
  if (reasons.length > 0) {
    const sentence = humanList(reasons);
    return check({
      ...base,
      status: 'pass',
      detail: `${sentence[0].toUpperCase()}${sentence.slice(1)}.`,
      source: goals.length > 0 && !facts.parent ? 'graph' : 'jira',
    });
  }
  return check({
    ...base,
    status: 'warn',
    detail: facts.isEpic ? 'The epic is not linked to a goal.' : 'Not linked to an epic, parent or goal.',
    fix: facts.isEpic
      ? 'Link the epic to the goal it moves, so everyone below it knows why it matters.'
      : 'Link it to its epic or goal so people know why it matters.',
  });
}

function references(facts: IssueFacts): Check {
  const base = { id: 'references' as const, label: 'Reference material' };
  if (facts.docs.length > 0) {
    const titles = facts.docs.slice(0, 2).map((doc) => `"${truncate(doc.title, 40)}"`);
    const more = facts.docs.length > 2 ? ` and ${facts.docs.length - 2} more` : '';
    return check({
      ...base,
      status: 'pass',
      detail: `${plural(facts.docs.length, 'linked doc')}: ${humanList(titles)}${more}.`,
    });
  }
  if (!facts.remoteLinksLoaded) {
    return check({ ...base, status: 'na', detail: 'Not checked in a project scan.' });
  }
  return check({
    ...base,
    status: 'warn',
    detail: 'No spec, design or doc is linked.',
    fix: 'Link the Confluence page or design that explains the details.',
  });
}

function sized(facts: IssueFacts): Check {
  const base = { id: 'sized' as const, label: 'Sized' };
  if (facts.isSubtask || facts.isEpic) {
    return check({ ...base, status: 'na', detail: 'Sizing is not expected for this work type.' });
  }
  if (facts.storyPoints !== undefined && facts.storyPoints > 0) {
    if (facts.storyPoints >= LARGE_STORY_POINTS) {
      return check({
        ...base,
        status: 'warn',
        detail: `Estimated at ${facts.storyPoints} points, which is large.`,
        fix: 'Consider splitting it into smaller pieces that can each be finished and reviewed.',
      });
    }
    return check({ ...base, status: 'pass', detail: `Estimated at ${plural(facts.storyPoints, 'point')}.` });
  }
  if (facts.originalEstimateSeconds !== undefined && facts.originalEstimateSeconds > 0) {
    const hours = Math.round((facts.originalEstimateSeconds / 3600) * 10) / 10;
    return check({ ...base, status: 'pass', detail: `Original estimate ${hours}h.` });
  }
  return check({
    ...base,
    status: 'warn',
    detail: 'No estimate.',
    fix: 'Add a story point or time estimate so the team can plan it.',
  });
}

function openQuestions(facts: IssueFacts): Check {
  const base = { id: 'open-questions' as const, label: 'No open questions' };
  if (!facts.commentsLoaded) {
    return check({ ...base, status: 'na', detail: 'Comments are not read in a project scan.' });
  }
  const question = findOpenQuestion(facts.descriptionText, facts.comments);
  if (question?.source === 'comment') {
    return check({
      ...base,
      status: 'warn',
      detail: `The latest comment${question.author ? ` from ${question.author}` : ''} asks: "${question.text}"`,
      fix: 'Answer it, then fold the answer into the description.',
    });
  }
  if (question?.source === 'description') {
    return check({
      ...base,
      status: 'warn',
      detail: `The description still has an open point: "${question.text}"`,
      fix: 'Decide it, or name who will decide it and by when.',
    });
  }
  return check({ ...base, status: 'pass', detail: 'No unanswered question in the description or latest comment.' });
}

function workInFlight(facts: IssueFacts, graph: GraphContext | null): Check {
  const base = { id: 'work-in-flight' as const, label: 'No duplicate work', source: 'graph' as const };
  if (!graph?.available) {
    return check({ ...base, status: 'na', detail: 'Needs the Teamwork Graph, which returned no data.' });
  }
  const open = graph.pullRequests.filter((pr) => /^(open|draft)$/i.test(pr.status));
  if (open.length > 0 && facts.statusCategory === 'new') {
    return check({
      ...base,
      status: 'warn',
      detail: `A pull request is already open: "${truncate(open[0].title, 60)}".`,
      fix: 'Talk to the author before starting, so the work is not done twice.',
    });
  }
  if (graph.pullRequests.length > 0) {
    return check({
      ...base,
      status: 'pass',
      detail: `${plural(graph.pullRequests.length, 'linked pull request')}; the work is tracked.`,
    });
  }
  return check({ ...base, status: 'pass', detail: 'No pull requests are linked yet.' });
}

function score(checks: Check[]): number {
  const applicable = checks.filter((c) => c.status !== 'na');
  const total = applicable.reduce((sum, c) => sum + c.weight, 0);
  if (total === 0) return 0;
  const earned = applicable.reduce((sum, c) => {
    if (c.status === 'pass') return sum + c.weight;
    if (c.status === 'warn') return sum + c.weight / 2;
    return sum;
  }, 0);
  return Math.round((earned / total) * 100);
}

function verdictFor(checks: Check[], value: number): Verdict {
  if (checks.some((c) => c.id === 'unblocked' && c.status === 'fail')) return 'blocked';
  if (value >= READY_THRESHOLD && !checks.some((c) => c.status === 'fail')) return 'ready';
  if (value >= ALMOST_THRESHOLD) return 'almost';
  return 'not-ready';
}

const SEVERITY = { fail: 0, warn: 1, pass: 2, na: 3 } as const;

/**
 * Runs every check for one work item.
 *
 * @param graph Teamwork Graph context, or `null` when it was not requested.
 * @param mode  "full" when links, remote links and comments were loaded; "lite" for project scans.
 */
export function evaluateReadiness(
  facts: IssueFacts,
  graph: GraphContext | null,
  mode: Readiness['mode'] = 'full',
): Readiness {
  const checks: Check[] = [
    clearTitle(facts),
    enoughDetail(facts),
    facts.isBug ? reproducible(facts) : doneDefined(facts),
    unblocked(facts, mode),
    purpose(facts, graph),
    references(facts),
    sized(facts),
    openQuestions(facts),
    workInFlight(facts, graph),
  ];
  const value = score(checks);
  const verdict = verdictFor(checks, value);
  const gaps = checks
    .filter((c) => c.status === 'fail' || c.status === 'warn')
    .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || b.weight - a.weight)
    .map((c) => c.label);
  return {
    issueKey: facts.key,
    score: value,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    mode,
    checks,
    gaps,
  };
}
