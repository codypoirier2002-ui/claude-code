import { describe, expect, it } from "vitest";
import {
  TIERS,
  decideEscalation,
  isHaiku,
  labelOf,
  modelForRun,
  nextTier,
  shortLabel,
  tierOf,
} from "../src/core/routing";
import { MODES, PERSONALITIES, modeById, personalityById } from "../src/core/modes";

describe("routing", () => {
  it("has the three tiers", () => {
    expect(TIERS.quick).toEqual({ tier: "quick", model: "claude-haiku-5-5", label: "Claude Haiku 5.5", short: "Haiku" });
    expect(TIERS.think).toEqual({ tier: "think", model: "claude-opus-5-5", label: "Claude Opus 5.5", short: "Opus" });
    expect(TIERS.deep).toEqual({ tier: "deep", model: "claude-fable-5-1", label: "Claude Fable 5.1", short: "Fable" });
  });

  it("maps model ids to tiers and labels; unknown counts as think", () => {
    expect(tierOf("claude-haiku-5-5")).toBe("quick");
    expect(tierOf("claude-fable-5-1")).toBe("deep");
    expect(tierOf("claude-mystery-9")).toBe("think");
    expect(labelOf("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(shortLabel("claude-fable-5-1")).toBe("Fable");
    expect(shortLabel("claude-mystery-9")).toBe("mystery-9");
  });

  it("nextTier stops at deep", () => {
    expect(nextTier("quick")).toBe("think");
    expect(nextTier("think")).toBe("deep");
    expect(nextTier("deep")).toBe("deep");
  });

  it("modelForRun: forced tier, else Haiku in Auto, else the pinned model", () => {
    expect(modelForRun({ model: "auto" })).toBe("claude-haiku-5-5");
    expect(modelForRun({ model: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    expect(modelForRun({ model: "claude-haiku-5-5" }, "deep")).toBe("claude-fable-5-1");
    expect(modelForRun({ model: "auto" }, "think")).toBe("claude-opus-5-5");
  });

  it("isHaiku", () => {
    expect(isHaiku("claude-haiku-5-5")).toBe(true);
    expect(isHaiku("claude-opus-5-5")).toBe(false);
  });

  describe("decideEscalation", () => {
    it("pinned", () => {
      expect(decideEscalation({ level: "think", reason: "x" }, "claude-haiku-5-5", false)).toEqual({
        content: "Routing is pinned to one model. Answer the user directly.",
        is_error: true,
      });
    });
    it("bad level", () => {
      for (const input of [{ level: "max" }, {}, null, "think"]) {
        expect(decideEscalation(input, "claude-haiku-5-5", true)).toEqual({
          content: "INVALID_INPUT: level must be 'think' or 'deep'.",
          is_error: true,
        });
      }
    });
    it("not above the current tier", () => {
      expect(decideEscalation({ level: "think" }, "claude-opus-5-5", true)).toEqual({
        content: "You are already Claude Opus 5.5. Answer the user directly.",
        is_error: true,
      });
      expect(decideEscalation({ level: "think" }, "claude-fable-5-1", true).content).toBe(
        "You are already Claude Fable 5.1. Answer the user directly.",
      );
      expect(decideEscalation({ level: "deep" }, "claude-fable-5-1", true).is_error).toBe(true);
    });
    it("hands off", () => {
      expect(decideEscalation({ level: "think", reason: "plan" }, "claude-haiku-5-5", true)).toEqual({
        content: "Handed off to Claude Opus 5.5. It now answers the user's latest request.",
        target: "think",
      });
      expect(decideEscalation({ level: "deep", reason: "stuck" }, "claude-opus-5-5", true)).toEqual({
        content: "Handed off to Claude Fable 5.1. It now answers the user's latest request.",
        target: "deep",
      });
    });
  });
});

describe("modes and personalities", () => {
  it("has the seven modes in order with three quick prompts each", () => {
    expect(MODES.map((m) => m.id)).toEqual(["everyday", "vr-guide", "game-coach", "fitness", "tutor", "creator", "play"]);
    expect(MODES.map((m) => m.icon).join("")).toBe("✦◎◆▲✎✺♠");
    for (const m of MODES) expect(m.quickPrompts).toHaveLength(3);
    expect(modeById("tutor").name).toBe("Tutor");
    expect(modeById("play").blurb).toBe("Games with Orbit: 20 questions, trivia, riddles");
    expect(modeById("vr-guide").quickPrompts[2]).toBe("My controller is drifting, what do I try?");
  });

  it("falls back to the first mode and personality", () => {
    expect(modeById("nope").id).toBe("everyday");
    expect(modeById(undefined).id).toBe("everyday");
    expect(personalityById("nope").id).toBe("cheeky");
    expect(PERSONALITIES.map((p) => [p.id, p.name])).toEqual([
      ["cheeky", "Sweet & cheeky"],
      ["classic", "Calm & helpful"],
      ["hype", "Hype coach"],
    ]);
    expect(personalityById("classic").stages[0]).toBe(
      "Personality: calm, warm and efficient. A friendly assistant who gets straight to the point.",
    );
  });
});
