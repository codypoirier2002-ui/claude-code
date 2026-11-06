// Closeness stages (§3.5) and the daily streak (§4.5).

import { readJSON, writeJSON } from "./store";

export const STAGES = ["Just met", "Getting comfortable", "Close friends"] as const;
export type StageName = (typeof STAGES)[number];
/** Minimum score for each stage. */
export const STAGE_THRESHOLDS: readonly number[] = [0, 10, 40];

/** conversations + 2 × memories. */
export function closenessScore(conversations: number, memories: number): number {
  return conversations + 2 * memories;
}

export function stageIndex(score: number): number {
  let idx = 0;
  for (let i = 0; i < STAGE_THRESHOLDS.length; i++) if (score >= STAGE_THRESHOLDS[i]) idx = i;
  return idx;
}

export function stageName(score: number): StageName {
  return STAGES[stageIndex(score)];
}

/** The next stage's name, or undefined at the top stage. */
export function nextStageName(score: number): StageName | undefined {
  return STAGES[stageIndex(score) + 1];
}

/** Integer percent toward the next stage; 100 at the top stage. */
export function bondProgress(score: number): number {
  const idx = stageIndex(score);
  if (idx >= STAGES.length - 1) return 100;
  const lo = STAGE_THRESHOLDS[idx];
  const hi = STAGE_THRESHOLDS[idx + 1];
  const pct = Math.floor(((score - lo) / (hi - lo)) * 100);
  return Math.min(100, Math.max(0, pct));
}

// ---- Visits and streak -----------------------------------------------------

/** `orbit:visits`; dates are local YYYY-MM-DD. */
export interface Visits {
  first: string;
  last: string;
  streak: number;
  best: number;
}

const DAY_MS = 86_400_000;

/** Local calendar date as YYYY-MM-DD. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function noonOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

/** Whole days from `a` to `b` (YYYY-MM-DD), measured between local noons so DST can't shift it. */
export function dayGap(a: string, b: string): number {
  return Math.round((noonOf(b) - noonOf(a)) / DAY_MS);
}

function isVisits(v: unknown): v is Visits {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const dateOk = (x: unknown) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
  return dateOk(o.first) && dateOk(o.last) && typeof o.streak === "number" && typeof o.best === "number";
}

export function getVisits(): Visits | null {
  const v = readJSON<unknown>("visits", null);
  return isVisits(v) ? v : null;
}

/** Records a visit (called on every send). Same day: no change; next day: +1; longer gap: 1. */
export function recordVisit(today: Date): Visits {
  const t = localDateKey(today);
  const v = getVisits();
  if (!v) {
    const fresh: Visits = { first: t, last: t, streak: 1, best: 1 };
    writeJSON("visits", fresh);
    return fresh;
  }
  const gap = dayGap(v.last, t);
  // Same day, or the clock moved backwards: leave everything as it is.
  if (gap <= 0) return v;
  const streak = gap === 1 ? v.streak + 1 : 1;
  const updated: Visits = { first: v.first, last: t, streak, best: Math.max(v.best, streak) };
  writeJSON("visits", updated);
  return updated;
}

/** The streak if the last visit was today or yesterday, otherwise 0. */
export function currentStreak(today: Date): number {
  const v = getVisits();
  if (!v) return 0;
  const gap = dayGap(v.last, localDateKey(today));
  return gap === 0 || gap === 1 ? v.streak : 0;
}

/** Days since the first visit, plus 1 (0 before any visit). */
export function daysTogether(today: Date): number {
  const v = getVisits();
  if (!v) return 0;
  return Math.max(1, dayGap(v.first, localDateKey(today)) + 1);
}

export function bestStreak(): number {
  return getVisits()?.best ?? 0;
}
