// @vitest-environment happy-dom
// Pin a zone with daylight saving so the DST cases mean something on any machine.
(globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env.TZ = "America/New_York";

import { beforeEach, describe, expect, it } from "vitest";
import {
  STAGES,
  bestStreak,
  bondProgress,
  closenessScore,
  currentStreak,
  dayGap,
  daysTogether,
  getVisits,
  localDateKey,
  nextStageName,
  recordVisit,
  stageIndex,
  stageName,
} from "../src/core/bond";

const day = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

beforeEach(() => localStorage.clear());

describe("closeness", () => {
  it("scores conversations + 2 × memories", () => {
    expect(closenessScore(0, 0)).toBe(0);
    expect(closenessScore(3, 4)).toBe(11);
  });

  it("maps scores to the three stages at 0 / 10 / 40", () => {
    expect(STAGES).toEqual(["Just met", "Getting comfortable", "Close friends"]);
    expect(stageIndex(0)).toBe(0);
    expect(stageIndex(9)).toBe(0);
    expect(stageIndex(10)).toBe(1);
    expect(stageIndex(39)).toBe(1);
    expect(stageIndex(40)).toBe(2);
    expect(stageIndex(500)).toBe(2);
    expect(stageName(9)).toBe("Just met");
    expect(stageName(10)).toBe("Getting comfortable");
    expect(stageName(40)).toBe("Close friends");
  });

  it("names the next stage, and nothing at the top", () => {
    expect(nextStageName(0)).toBe("Getting comfortable");
    expect(nextStageName(25)).toBe("Close friends");
    expect(nextStageName(40)).toBeUndefined();
  });

  it("reports integer progress toward the next stage", () => {
    expect(bondProgress(0)).toBe(0);
    expect(bondProgress(5)).toBe(50);
    expect(bondProgress(9)).toBe(90);
    expect(bondProgress(10)).toBe(0);
    expect(bondProgress(25)).toBe(50);
    expect(bondProgress(20)).toBe(33); // 10/30 → 33.3
    expect(bondProgress(39)).toBe(96);
    expect(bondProgress(40)).toBe(100);
    expect(bondProgress(1000)).toBe(100);
    expect(Number.isInteger(bondProgress(7))).toBe(true);
  });
});

describe("visits and streaks", () => {
  it("formats local dates and measures gaps between noons", () => {
    expect(localDateKey(day(2026, 3, 5, 0))).toBe("2026-03-05");
    expect(localDateKey(day(2026, 3, 5, 23))).toBe("2026-03-05");
    expect(dayGap("2026-01-31", "2026-02-01")).toBe(1);
    expect(dayGap("2026-03-07", "2026-03-09")).toBe(2); // across spring forward
    expect(dayGap("2026-10-31", "2026-11-02")).toBe(2); // across fall back
  });

  it("starts a streak on the first visit", () => {
    const v = recordVisit(day(2026, 5, 10));
    expect(v).toEqual({ first: "2026-05-10", last: "2026-05-10", streak: 1, best: 1 });
    expect(JSON.parse(localStorage.getItem("orbit:visits")!)).toEqual(v);
  });

  it("makes no change on the same day", () => {
    recordVisit(day(2026, 5, 10, 8));
    const before = localStorage.getItem("orbit:visits");
    recordVisit(day(2026, 5, 10, 23));
    expect(localStorage.getItem("orbit:visits")).toBe(before);
    expect(getVisits()?.streak).toBe(1);
  });

  it("counts consecutive days across a month end", () => {
    recordVisit(day(2026, 1, 30, 23));
    recordVisit(day(2026, 1, 31, 0));
    recordVisit(day(2026, 2, 1, 7));
    expect(getVisits()).toEqual({ first: "2026-01-30", last: "2026-02-01", streak: 3, best: 3 });
    // Year end too.
    localStorage.clear();
    recordVisit(day(2026, 12, 31, 22));
    recordVisit(day(2027, 1, 1, 1));
    expect(getVisits()?.streak).toBe(2);
  });

  it("counts consecutive days across the DST changes", () => {
    // Spring forward: 2026-03-08 has only 23 hours.
    recordVisit(day(2026, 3, 7, 23));
    recordVisit(day(2026, 3, 8, 0));
    recordVisit(day(2026, 3, 9, 0));
    expect(getVisits()?.streak).toBe(3);
    // Fall back: 2026-11-01 has 25 hours.
    localStorage.clear();
    recordVisit(day(2026, 10, 31, 23));
    recordVisit(day(2026, 11, 1, 23));
    recordVisit(day(2026, 11, 2, 0));
    expect(getVisits()?.streak).toBe(3);
  });

  it("resets to 1 after a gap and tracks the best streak", () => {
    recordVisit(day(2026, 5, 1));
    recordVisit(day(2026, 5, 2));
    recordVisit(day(2026, 5, 3));
    recordVisit(day(2026, 5, 6));
    expect(getVisits()).toMatchObject({ streak: 1, best: 3, first: "2026-05-01", last: "2026-05-06" });
    recordVisit(day(2026, 5, 7));
    expect(bestStreak()).toBe(3);
    recordVisit(day(2026, 5, 8));
    recordVisit(day(2026, 5, 9));
    expect(getVisits()).toMatchObject({ streak: 4, best: 4 });
    expect(bestStreak()).toBe(4);
  });

  it("current streak holds through yesterday and drops to 0 after that", () => {
    expect(currentStreak(day(2026, 5, 1))).toBe(0);
    recordVisit(day(2026, 5, 1));
    recordVisit(day(2026, 5, 2));
    expect(currentStreak(day(2026, 5, 2))).toBe(2);
    expect(currentStreak(day(2026, 5, 3, 23))).toBe(2);
    expect(currentStreak(day(2026, 5, 4, 0))).toBe(0);
  });

  it("counts days together from the first visit, inclusive", () => {
    expect(daysTogether(day(2026, 5, 1))).toBe(0);
    recordVisit(day(2026, 2, 27));
    expect(daysTogether(day(2026, 2, 27))).toBe(1);
    expect(daysTogether(day(2026, 3, 1))).toBe(3);
    expect(daysTogether(day(2026, 3, 10))).toBe(12); // across spring forward
  });

  it("ignores a malformed saved value", () => {
    localStorage.setItem("orbit:visits", '{"first":5}');
    expect(getVisits()).toBeNull();
    expect(recordVisit(day(2026, 5, 1)).streak).toBe(1);
    localStorage.setItem("orbit:visits", "not json");
    expect(currentStreak(day(2026, 5, 1))).toBe(0);
  });
});
