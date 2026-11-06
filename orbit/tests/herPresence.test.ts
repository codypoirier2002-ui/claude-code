import { describe, expect, it } from "vitest";
import { GREETING_MAX_AGE_MS } from "../src/core/session";
import { GREET_DELAY_MS, HELLO_LINES, PREVIEW_WAVE_MS, greetingFresh, herText } from "../src/xr/immersive";
import { SPARK_SCALE } from "../src/xr/portrait";

const turn = (role: "user" | "assistant", text: string) => ({ role, text, actions: [], models: [], index: 0 });

describe("her in VR (§8.2, §8.5)", () => {
  it("uses the tuned timings, the spark scale and the four hello lines", () => {
    expect(GREET_DELAY_MS).toBe(1200);
    expect(PREVIEW_WAVE_MS).toBe(3000);
    expect(SPARK_SCALE).toBe(0.35);
    expect([...HELLO_LINES]).toEqual(["Hi!", "Hey, you!", "Oh, hi there!", "Hiya!"]);
  });

  it("reads the streaming reply, else the last reply while her voice plays", () => {
    const turns = [turn("user", "hi"), turn("assistant", "Haha, hello!")];
    expect(herText({ text: "Streaming…", turns }, { speaking: false })).toBe("Streaming…");
    expect(herText({ text: "", turns }, { speaking: true })).toBe("Haha, hello!");
    expect(herText({ text: "", turns }, { speaking: false })).toBe("");
    expect(herText({ text: "", turns: [turn("user", "hi")] }, { speaking: true })).toBe("");
  });

  it("greets only while this visit's greeting is fresh", () => {
    const now = 1_000_000_000;
    expect(greetingFresh({ greeting: null }, now)).toBe(false);
    expect(greetingFresh({ greeting: { text: "Hey you!", at: now - 1000 } }, now)).toBe(true);
    expect(greetingFresh({ greeting: { text: "  ", at: now } }, now)).toBe(false);
    expect(greetingFresh({ greeting: { text: "Hey you!", at: now - GREETING_MAX_AGE_MS } }, now)).toBe(false);
  });
});
