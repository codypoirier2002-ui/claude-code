// Focus lines (§4.4). One counter, starting at a random 0–3, picks the next
// line for both check-ins and finished sessions and goes up on every call.

const CHECK_INS: readonly ((t: string) => string)[] = [
  (t) => `Halfway there${t}. You're doing great, keep going.`,
  (t) => `Quick check-in: halfway done${t}. Stay with it, I'm right here.`,
  (t) => `Half time${t}! Eyes on the prize.`,
  (t) => `Psst, you're halfway${t}. No peeking at your phone.`,
];

const DONE: readonly ((t: string, b: string) => string)[] = [
  (t, b) => `Time! Nice work${t}.${b}`,
  (t, b) => `And that's a wrap${t}. I'm proud of you.${b}`,
  (t, b) => `Done${t}! That was a solid session.${b}`,
];

let counter = Math.floor(Math.random() * 4);

/** Sets the line counter (tests use this for deterministic picks). */
export function resetFocusLines(start: number = Math.floor(Math.random() * 4)): void {
  counter = start;
}

function next(): number {
  return counter++;
}

function taskPart(task?: string): string {
  const t = task?.trim();
  return t ? ` on ${t}` : "";
}

function breakPart(breakMinutes?: number): string {
  if (!breakMinutes || breakMinutes <= 0) return "";
  const span = breakMinutes === 1 ? "a minute" : `${breakMinutes} minutes`;
  return ` Take ${span} to stretch; I started your break timer.`;
}

export function checkInLine(task?: string): string {
  return CHECK_INS[next() % CHECK_INS.length](taskPart(task));
}

export function doneLine(task?: string, breakMinutes?: number): string {
  return DONE[next() % DONE.length](taskPart(task), breakPart(breakMinutes));
}
