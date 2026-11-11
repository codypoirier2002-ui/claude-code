/**
 * Heuristics that read a work item's text the way a reviewer would.
 *
 * They work on the plain-text rendering from `adf.ts`: one block per line, with
 * list markers ("- ", "1. ", "- [ ] ") kept, so structure survives.
 */
import type { CommentFact } from './types';
import { firstQuestion, oneLine, truncate, wordCount } from './text';

export interface AcceptanceEvidence {
  found: boolean;
  source?: 'field' | 'heading' | 'gherkin' | 'checklist';
  /** Number of criteria, scenarios or checklist items found. */
  count: number;
}

const LIST_LINE = /^(?:[-*•]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;
const CHECKLIST_LINE = /^[-*•]\s+\[[ xX]\]\s+\S/;
const ORDERED_LINE = /^\d+[.)]\s+\S/;
const AC_HEADING =
  /^(?:#+\s*)?(?:acceptance criteria|acceptance tests?|definition of done|success criteria|done (?:when|criteria)|ac\s*:)/i;
const GIVEN_LINE = /^(?:[-*•]\s+|\d+[.)]\s+)?(?:\*\*)?given\b/i;
const THEN_LINE = /^(?:[-*•]\s+|\d+[.)]\s+)?(?:\*\*)?(?:then|and then)\b/i;
const STEPS_HEADING =
  /(?:steps to reproduce|reproduction steps|repro(?:duction)? steps|how to reproduce|to reproduce\b|^steps\s*:?$)/i;
const EXPECTED = /\bexpected\b/i;
const ACTUAL = /\b(?:actual(?:ly)?|instead|currently)\b/i;
const PLACEHOLDER = /\b(?:tbd|tbc|todo|fixme|wip|xxx|placeholder)\b|\?\?|^untitled\b/i;
const OPEN_MARKER = /\b(?:tbd|tbc|to be (?:decided|confirmed|defined)|open questions?|unclear)\b/i;

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Finds acceptance criteria in a dedicated field or in the description. */
export function findAcceptanceCriteria(descriptionText: string, fieldText?: string): AcceptanceEvidence {
  if (fieldText && wordCount(fieldText) >= 3) {
    const items = lines(fieldText);
    return { found: true, source: 'field', count: Math.max(items.length, 1) };
  }

  const all = lines(descriptionText);
  const headingIndex = all.findIndex((line) => AC_HEADING.test(line));
  if (headingIndex >= 0) {
    const heading = all[headingIndex];
    const afterColon = heading.includes(':') ? heading.slice(heading.indexOf(':') + 1).trim() : '';
    let count = wordCount(afterColon) >= 2 ? 1 : 0;
    for (const line of all.slice(headingIndex + 1)) {
      if (LIST_LINE.test(line)) {
        count += 1;
        continue;
      }
      // A plain paragraph straight after the heading counts once; the section ends at the next prose block.
      if (count === 0 && wordCount(line) >= 3) count = 1;
      break;
    }
    if (count > 0) return { found: true, source: 'heading', count };
  }

  const givens = all.filter((line) => GIVEN_LINE.test(line)).length;
  const thens = all.filter((line) => THEN_LINE.test(line)).length;
  const scenarios = Math.min(givens, thens);
  if (scenarios > 0) return { found: true, source: 'gherkin', count: scenarios };

  const checklist = all.filter((line) => CHECKLIST_LINE.test(line)).length;
  if (checklist >= 2) return { found: true, source: 'checklist', count: checklist };

  return { found: false, count: 0 };
}

export interface ReproEvidence {
  hasSteps: boolean;
  stepCount: number;
  hasExpected: boolean;
  hasActual: boolean;
}

/** Looks for steps to reproduce and expected-versus-actual results in a bug. */
export function findReproSteps(descriptionText: string): ReproEvidence {
  const all = lines(descriptionText);
  const headingIndex = all.findIndex((line) => STEPS_HEADING.test(line));
  let stepCount = 0;
  if (headingIndex >= 0) {
    for (const line of all.slice(headingIndex + 1)) {
      if (!LIST_LINE.test(line)) break;
      stepCount += 1;
    }
  }
  if (stepCount === 0) stepCount = all.filter((line) => ORDERED_LINE.test(line)).length;
  const hasSteps = stepCount >= 2 || (headingIndex >= 0 && stepCount >= 1);
  return {
    hasSteps,
    stepCount,
    hasExpected: EXPECTED.test(descriptionText),
    hasActual: ACTUAL.test(descriptionText),
  };
}

/** True when the title still contains a placeholder such as "TBD". */
export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}

export interface OpenQuestion {
  source: 'comment' | 'description';
  text: string;
  author?: string;
}

/**
 * Finds a question that is probably still open: a "?" in the latest comment, or
 * a "TBD"-style marker in the description.
 */
export function findOpenQuestion(descriptionText: string, comments: CommentFact[]): OpenQuestion | undefined {
  const latest = comments[0];
  if (latest) {
    const question = firstQuestion(latest.text);
    if (question) return { source: 'comment', text: truncate(question, 160), author: latest.author.name };
  }
  const marker = lines(descriptionText).find((line) => OPEN_MARKER.test(line));
  if (marker) return { source: 'description', text: truncate(oneLine(marker), 160) };
  return undefined;
}
