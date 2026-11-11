import { describe, expect, it } from 'vitest';
import { rankPeople } from '../src/core/people';
import { facts, graphContext } from './fixtures';

describe('rankPeople', () => {
  it('ranks by evidence and explains each person', () => {
    const people = rankPeople(
      facts({
        assignee: { accountId: 'acc-cho', name: 'Cho Lee' },
        mentions: [{ accountId: 'acc-ben', name: 'Ben Ode' }],
        comments: [
          { author: { accountId: 'acc-ben', name: 'Ben Ode' }, created: '2026-11-03', text: 'ok' },
          { author: { accountId: 'acc-ben', name: 'Ben Ode' }, created: '2026-11-02', text: 'hm' },
          { author: { accountId: 'acc-dee', name: 'Dee Park' }, created: '2026-11-01', text: 'fine' },
        ],
      }),
      graphContext({
        pagePeople: [
          {
            pageId: '98765',
            pageTitle: 'Audit log export spec',
            owners: [{ accountId: 'acc-eve', name: 'Eve Moss' }],
            contributors: [{ accountId: 'acc-ben', name: 'Ben Ode' }],
          },
        ],
      }),
    );
    expect(people.map((p) => [p.name, p.score])).toEqual([
      ['Ben Ode', 5],
      ['Ana Silva', 3],
      ['Eve Moss', 3],
      ['Cho Lee', 2],
      ['Dee Park', 1],
    ]);
    expect(people[0].reasons).toEqual([
      'Mentioned in the description',
      'Commented 2 times recently',
      'Contributed to "Audit log export spec"',
    ]);
    expect(people[2].reasons).toEqual(['Owns the linked page "Audit log export spec"']);
  });

  it('merges the same person and caps comment points', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      author: { accountId: 'acc-reporter', name: 'Ana Silva' },
      created: `2026-11-0${i + 1}`,
      text: 'note',
    }));
    const [first] = rankPeople(facts({ comments: many }), null);
    expect(first).toMatchObject({ name: 'Ana Silva', score: 6 });
    expect(first.reasons).toEqual(['Reported this work item', 'Commented 6 times recently']);
  });

  it('de-duplicates people without account IDs by name and respects the limit', () => {
    const people = rankPeople(
      facts({
        reporter: { name: 'Pat Doe' },
        assignee: { name: 'pat doe' },
        mentions: Array.from({ length: 8 }, (_, i) => ({ accountId: `m${i}`, name: `Person ${i}` })),
      }),
      null,
      3,
    );
    expect(people).toHaveLength(3);
    expect(people[0]).toMatchObject({ name: 'Pat Doe', score: 5 });
  });
});
