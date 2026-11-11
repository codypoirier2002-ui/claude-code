import { describe, expect, it } from 'vitest';
import { evaluateReadiness, WEIGHTS } from '../src/core/readiness';
import type { Check, CheckId } from '../src/core/types';
import { facts, graphContext } from './fixtures';

const byId = (checks: Check[], id: CheckId): Check => {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`missing check ${id}`);
  return found;
};

describe('evaluateReadiness', () => {
  it('rates a well-prepared story as ready', () => {
    const result = evaluateReadiness(facts(), graphContext(), 'full');
    expect(result.verdict).toBe('ready');
    expect(result.verdictLabel).toBe('Ready to start');
    expect(result.score).toBe(100);
    expect(result.gaps).toEqual([]);
    expect(result.checks.map((c) => c.id)).toEqual([
      'clear-title',
      'enough-detail',
      'done-defined',
      'unblocked',
      'purpose',
      'references',
      'sized',
      'open-questions',
      'work-in-flight',
    ]);
  });

  it('explains every gap on a vague story', () => {
    const result = evaluateReadiness(
      facts({ summary: 'Fix export', descriptionText: '', parent: undefined, docs: [], storyPoints: undefined }),
      null,
      'full',
    );
    expect(result.verdict).toBe('not-ready');
    expect(byId(result.checks, 'clear-title')).toMatchObject({ status: 'fail', detail: 'The title has 2 words.' });
    expect(byId(result.checks, 'enough-detail').status).toBe('fail');
    expect(byId(result.checks, 'done-defined')).toMatchObject({ status: 'fail' });
    expect(byId(result.checks, 'done-defined').fix).toContain('Acceptance criteria');
    expect(byId(result.checks, 'purpose').status).toBe('warn');
    expect(byId(result.checks, 'references').status).toBe('warn');
    expect(byId(result.checks, 'sized').status).toBe('warn');
    expect(byId(result.checks, 'work-in-flight').status).toBe('na');
    // Failures come first, heaviest first.
    expect(result.gaps.slice(0, 3)).toEqual(['Done is defined', 'Enough detail', 'Clear title']);
    for (const check of result.checks.filter((c) => c.status === 'warn' || c.status === 'fail')) {
      expect(check.fix, check.id).toBeTruthy();
    }
  });

  it('marks open blockers as blocked whatever the score', () => {
    const result = evaluateReadiness(
      facts({
        links: [
          { key: 'KAN-3', summary: 'Audit table', statusName: 'In Progress', statusCategory: 'indeterminate', relation: 'is blocked by', isBlocker: true },
          { key: 'KAN-4', summary: 'Done blocker', statusName: 'Done', statusCategory: 'done', relation: 'is blocked by', isBlocker: true },
        ],
      }),
      null,
    );
    expect(result.verdict).toBe('blocked');
    expect(byId(result.checks, 'unblocked')).toMatchObject({ status: 'fail', detail: 'Blocked by KAN-3 (In Progress).' });
  });

  it('passes when every blocker is done', () => {
    const result = evaluateReadiness(
      facts({
        links: [{ key: 'KAN-4', summary: 'x', statusName: 'Done', statusCategory: 'done', relation: 'is blocked by', isBlocker: true }],
      }),
      null,
    );
    expect(byId(result.checks, 'unblocked')).toMatchObject({ status: 'pass', detail: 'The only blocker is done.' });
  });

  it('checks bugs for steps to reproduce instead of acceptance criteria', () => {
    const bug = facts({
      issueType: 'Bug',
      isBug: true,
      descriptionText: 'Steps to reproduce\n1. Open settings\n2. Click export\nExpected: a CSV file\nActual: a 500 error',
    });
    const result = evaluateReadiness(bug, null);
    expect(result.checks.some((c) => c.id === 'done-defined')).toBe(false);
    expect(byId(result.checks, 'reproducible')).toMatchObject({ status: 'pass' });

    const partial = evaluateReadiness(facts({ isBug: true, descriptionText: '1. Open\n2. Click' }), null);
    expect(byId(partial.checks, 'reproducible')).toMatchObject({ status: 'warn' });
    expect(byId(partial.checks, 'reproducible').fix).toContain('Expected');
  });

  it('is gentler with sub-tasks and skips sizing for them and epics', () => {
    const subtask = evaluateReadiness(facts({ isSubtask: true, descriptionText: '', storyPoints: undefined }), null);
    expect(byId(subtask.checks, 'enough-detail').status).toBe('warn');
    expect(byId(subtask.checks, 'done-defined').status).toBe('warn');
    expect(byId(subtask.checks, 'sized').status).toBe('na');

    const epic = evaluateReadiness(facts({ isEpic: true, issueType: 'Epic', parent: undefined }), null);
    expect(byId(epic.checks, 'done-defined').label).toBe('Success is defined');
    expect(byId(epic.checks, 'sized').status).toBe('na');
    expect(byId(epic.checks, 'purpose').detail).toBe('The epic is not linked to a goal.');
  });

  it('uses Teamwork Graph goals as purpose', () => {
    const result = evaluateReadiness(
      facts({ parent: undefined }),
      graphContext({ goals: [{ name: 'Pass the SOC 2 audit', url: 'https://home.example/goal/1' }] }),
    );
    expect(byId(result.checks, 'purpose')).toMatchObject({
      status: 'pass',
      detail: 'Contributes to goal "Pass the SOC 2 audit".',
      source: 'graph',
    });
  });

  it('ignores archived goals', () => {
    const result = evaluateReadiness(facts({ parent: undefined }), graphContext({ goals: [{ name: 'Old goal', archived: true }] }));
    expect(byId(result.checks, 'purpose').status).toBe('warn');
  });

  it('warns when a pull request is already open on a to-do item', () => {
    const graph = graphContext({ pullRequests: [{ title: 'Add CSV export', status: 'OPEN' }] });
    const result = evaluateReadiness(facts(), graph);
    expect(byId(result.checks, 'work-in-flight')).toMatchObject({ status: 'warn', source: 'graph' });

    const inProgress = evaluateReadiness(facts({ statusCategory: 'indeterminate' }), graph);
    expect(byId(inProgress.checks, 'work-in-flight').status).toBe('pass');
  });

  it('warns about an unanswered question in the latest comment', () => {
    const result = evaluateReadiness(
      facts({ comments: [{ author: { name: 'Ben Ode' }, created: '2026-11-02', text: 'Which timezone do we export in?' }] }),
      null,
    );
    expect(byId(result.checks, 'open-questions')).toMatchObject({
      status: 'warn',
      detail: 'The latest comment from Ben Ode asks: "Which timezone do we export in?"',
    });
  });

  it('flags large estimates', () => {
    const result = evaluateReadiness(facts({ storyPoints: 13 }), null);
    expect(byId(result.checks, 'sized').status).toBe('warn');
    const hours = evaluateReadiness(facts({ storyPoints: undefined, originalEstimateSeconds: 5400 }), null);
    expect(byId(hours.checks, 'sized')).toMatchObject({ status: 'pass', detail: 'Original estimate 1.5h.' });
  });

  it('skips checks that need comments, remote links or the graph in lite mode', () => {
    const result = evaluateReadiness(facts({ docs: [], commentsLoaded: false, remoteLinksLoaded: false }), null, 'lite');
    expect(result.mode).toBe('lite');
    expect(byId(result.checks, 'references').status).toBe('na');
    expect(byId(result.checks, 'open-questions').status).toBe('na');
    expect(byId(result.checks, 'work-in-flight').status).toBe('na');
    expect(result.score).toBe(100);
  });

  it('weights warnings at half and rescales over applicable checks', () => {
    // Only "references" warns (weight 5). Applicable weight is 100 minus work-in-flight (na) = 95.
    const result = evaluateReadiness(facts({ docs: [] }), null);
    const applicable = 100 - WEIGHTS['work-in-flight'];
    expect(result.score).toBe(Math.round(((applicable - WEIGHTS.references / 2) / applicable) * 100));
    expect(result.verdict).toBe('ready');
  });

  it('does not call an item ready while any check fails', () => {
    // A one-word title fails, while everything else passes.
    const result = evaluateReadiness(facts({ summary: 'Export' }), null);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.verdict).toBe('almost');
  });
});
