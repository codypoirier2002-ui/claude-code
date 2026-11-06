import { beforeEach, describe, expect, it } from "vitest";
import { checkInLine, doneLine, resetFocusLines } from "../src/core/focus";

beforeEach(() => resetFocusLines(0));

describe("check-in lines", () => {
  it("cycles through the four lines with the task", () => {
    expect([1, 2, 3, 4, 5].map(() => checkInLine("my essay"))).toEqual([
      "Halfway there on my essay. You're doing great, keep going.",
      "Quick check-in: halfway done on my essay. Stay with it, I'm right here.",
      "Half time on my essay! Eyes on the prize.",
      "Psst, you're halfway on my essay. No peeking at your phone.",
      "Halfway there on my essay. You're doing great, keep going.",
    ]);
  });

  it("drops the task part when there is no task", () => {
    expect(checkInLine()).toBe("Halfway there. You're doing great, keep going.");
    expect(checkInLine("  ")).toBe("Quick check-in: halfway done. Stay with it, I'm right here.");
  });
});

describe("done lines", () => {
  it("cycles through the three lines with the task and break", () => {
    expect(doneLine("reading", 5)).toBe(
      "Time! Nice work on reading. Take 5 minutes to stretch; I started your break timer.",
    );
    expect(doneLine("reading", 1)).toBe(
      "And that's a wrap on reading. I'm proud of you. Take a minute to stretch; I started your break timer.",
    );
    expect(doneLine("reading", 0)).toBe("Done on reading! That was a solid session.");
    expect(doneLine()).toBe("Time! Nice work.");
  });

  it("omits the break part when there is none", () => {
    resetFocusLines(1);
    expect(doneLine(undefined, undefined)).toBe("And that's a wrap. I'm proud of you.");
  });
});

describe("counter", () => {
  it("is shared and goes up on every call", () => {
    resetFocusLines(2);
    expect(checkInLine()).toBe("Half time! Eyes on the prize.");
    expect(doneLine()).toBe("Time! Nice work."); // counter 3 → 3 % 3 = 0
    expect(checkInLine()).toBe("Halfway there. You're doing great, keep going."); // counter 4 → 0
  });

  it("starts somewhere in 0–3 by default", () => {
    const firsts = new Set<string>();
    for (let i = 0; i < 200; i++) {
      resetFocusLines();
      firsts.add(checkInLine());
    }
    expect(firsts.size).toBeGreaterThan(1);
    expect(firsts.size).toBeLessThanOrEqual(4);
  });
});
