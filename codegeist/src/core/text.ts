/** Small text helpers shared by the checks and the context pack. */

const URL_PATTERN = /https?:\/\/\S+/g;

/** Counts words that contain at least one letter or digit. */
export function wordCount(text: string | undefined): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/** Shortens text to at most `max` characters, cutting at a word boundary when possible. */
export function truncate(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  if (max <= 1) return '…'.slice(0, Math.max(max, 0));
  const slice = clean.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/** Collapses all whitespace (including newlines) to single spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Removes URLs and inline code, which often contain "?" that is not a question. */
export function stripNoise(text: string): string {
  return text.replace(URL_PATTERN, ' ').replace(/`[^`]*`/g, ' ');
}

/** Returns the sentence that contains the first question mark, or undefined. */
export function firstQuestion(text: string): string | undefined {
  const clean = oneLine(stripNoise(text));
  const index = clean.indexOf('?');
  if (index < 0) return undefined;
  const before = clean.slice(0, index);
  const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '));
  const sentence = clean.slice(start < 0 ? 0 : start + 2, index + 1).trim();
  return sentence.length > 1 ? sentence : undefined;
}

/** Joins a list as "a, b and c". */
export function humanList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "1 item" / "3 items". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
