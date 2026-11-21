import { describe, expect, it } from 'vitest';
import { findAcceptanceCriteria, findOpenQuestion, findReproSteps, hasPlaceholder } from '../src/core/detect';
import type { CommentFact } from '../src/core/types';

describe('findAcceptanceCriteria', () => {
  it('counts list items under an acceptance criteria heading', () => {
    const text = 'Some context here.\nAcceptance criteria\n- Admins can export\n- Non-admins cannot\nNotes about rollout follow.';
    expect(findAcceptanceCriteria(text)).toEqual({ found: true, source: 'heading', count: 2 });
  });

  it('accepts criteria written on the heading line', () => {
    expect(findAcceptanceCriteria('AC: users can export a CSV file')).toEqual({ found: true, source: 'heading', count: 1 });
  });

  it('accepts a paragraph right after a definition of done heading', () => {
    const text = 'Definition of done\nThe export is live behind a flag and documented.';
    expect(findAcceptanceCriteria(text)).toEqual({ found: true, source: 'heading', count: 1 });
  });

  it('counts Given/When/Then scenarios', () => {
    const text = 'Given an admin\nWhen they click export\nThen a CSV downloads\nGiven a viewer\nThen no button shows';
    expect(findAcceptanceCriteria(text)).toEqual({ found: true, source: 'gherkin', count: 2 });
  });

  it('accepts a checklist of two or more items', () => {
    expect(findAcceptanceCriteria('- [ ] export works\n- [x] button hidden')).toEqual({
      found: true,
      source: 'checklist',
      count: 2,
    });
  });

  it('prefers a dedicated acceptance criteria field', () => {
    expect(findAcceptanceCriteria('', 'Users can export\nAdmins only')).toEqual({ found: true, source: 'field', count: 2 });
  });

  it('ignores an empty heading and plain prose', () => {
    expect(findAcceptanceCriteria('Acceptance criteria\nTBD')).toEqual({ found: false, count: 0 });
    expect(findAcceptanceCriteria('We should make exporting nicer for everyone.')).toEqual({ found: false, count: 0 });
  });
});

describe('findReproSteps', () => {
  it('finds steps under a heading plus expected and actual results', () => {
    const text = 'Steps to reproduce\n1. Open settings\n2. Click export\nExpected: a file\nActual: a 500 error';
    expect(findReproSteps(text)).toEqual({ hasSteps: true, stepCount: 2, hasExpected: true, hasActual: true });
  });

  it('accepts an ordered list without a heading', () => {
    expect(findReproSteps('1. Open\n2. Click\n3. See error').hasSteps).toBe(true);
  });

  it('reports missing pieces', () => {
    expect(findReproSteps('It is broken, please fix')).toEqual({
      hasSteps: false,
      stepCount: 0,
      hasExpected: false,
      hasActual: false,
    });
  });
});

describe('hasPlaceholder', () => {
  it('flags placeholders but not ordinary words', () => {
    expect(hasPlaceholder('Export audit logs TBD')).toBe(true);
    expect(hasPlaceholder('Fix ?? on checkout')).toBe(true);
    expect(hasPlaceholder('Untitled task')).toBe(true);
    expect(hasPlaceholder('Add unit tests for the export')).toBe(false);
  });
});

describe('findOpenQuestion', () => {
  const comment = (text: string): CommentFact => ({ author: { name: 'Ben Ode' }, created: '2026-11-02', text });

  it('quotes the question in the latest comment', () => {
    expect(findOpenQuestion('', [comment('Looks good. Which date format should we use? Thanks')])).toEqual({
      source: 'comment',
      text: 'Which date format should we use?',
      author: 'Ben Ode',
    });
  });

  it('ignores question marks inside URLs', () => {
    expect(findOpenQuestion('', [comment('Spec is at https://example.com/page?id=1 now.')])).toBeUndefined();
  });

  it('only looks at the latest comment', () => {
    expect(findOpenQuestion('', [comment('Answered: ISO 8601.'), comment('Which format?')])).toBeUndefined();
  });

  it('flags open markers in the description', () => {
    expect(findOpenQuestion('Scope\nRetention period: TBD', [])).toEqual({
      source: 'description',
      text: 'Retention period: TBD',
    });
  });
});
