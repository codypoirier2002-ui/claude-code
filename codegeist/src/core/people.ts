/**
 * "People to ask": ranks everyone connected to a work item by how much context
 * they are likely to hold, and keeps the evidence so the ranking is explainable.
 */
import { truncate } from './text';
import type { GraphContext, IssueFacts, PersonRef, PersonSuggestion } from './types';

const POINTS = {
  reporter: 3,
  pageOwner: 3,
  assignee: 2,
  mentioned: 2,
  commentPerItem: 1,
  commentMax: 3,
  pageContributor: 1,
} as const;

function personKey(person: PersonRef): string {
  return person.accountId ? `id:${person.accountId}` : `name:${person.name.trim().toLowerCase()}`;
}

class Tally {
  private readonly people = new Map<string, PersonSuggestion>();

  add(person: PersonRef | undefined, points: number, reason: string): void {
    if (!person || person.name.trim().length === 0) return;
    const key = personKey(person);
    const existing = this.people.get(key);
    if (existing) {
      existing.score += points;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (!existing.accountId && person.accountId) existing.accountId = person.accountId;
      return;
    }
    this.people.set(key, { ...person, score: points, reasons: [reason] });
  }

  ranked(limit: number): PersonSuggestion[] {
    return [...this.people.values()]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
}

/** Ranks the people who can answer questions about this work item. */
export function rankPeople(facts: IssueFacts, graph: GraphContext | null, limit = 5): PersonSuggestion[] {
  const tally = new Tally();
  tally.add(facts.reporter, POINTS.reporter, 'Reported this work item');
  tally.add(facts.assignee, POINTS.assignee, 'Assigned to it');
  for (const person of facts.mentions) {
    tally.add(person, POINTS.mentioned, 'Mentioned in the description');
  }

  const commentCounts = new Map<string, { person: PersonRef; count: number }>();
  for (const comment of facts.comments) {
    const key = personKey(comment.author);
    const entry = commentCounts.get(key) ?? { person: comment.author, count: 0 };
    entry.count += 1;
    commentCounts.set(key, entry);
  }
  for (const { person, count } of commentCounts.values()) {
    const points = Math.min(count * POINTS.commentPerItem, POINTS.commentMax);
    tally.add(person, points, count === 1 ? 'Commented recently' : `Commented ${count} times recently`);
  }

  for (const page of graph?.pagePeople ?? []) {
    const title = `"${truncate(page.pageTitle, 40)}"`;
    for (const owner of page.owners) tally.add(owner, POINTS.pageOwner, `Owns the linked page ${title}`);
    for (const contributor of page.contributors) {
      tally.add(contributor, POINTS.pageContributor, `Contributed to ${title}`);
    }
  }

  return tally.ranked(limit);
}
