import { describe, expect, it } from "vitest";
import { MODES } from "../src/core/modes";
import type { Timer } from "../src/core/workspace";
import { orbLevel, orbMood } from "../src/xr/orb";
import {
  KB_SYMBOLS,
  PANEL_TEXT,
  applyKey,
  buttonLabels,
  cutLabel,
  emptyText,
  hitAt,
  modelLine,
  promptLabels,
  statusLine,
  streamSignature,
  timerLine,
  uvToPixel,
  type KbState,
} from "../src/xr/panelModel";

const idleVoice = { state: "off" as const, heard: "" };
const quiet = { busy: false, status: "", error: undefined };

describe("VR panel model (§8.3)", () => {
  it("cuts prompt labels over 22 characters to 21 plus an ellipsis", () => {
    expect(cutLabel("Brief me on my day")).toBe("Brief me on my day");
    expect(cutLabel("x".repeat(22))).toBe("x".repeat(22));
    expect(cutLabel("Plan my evening around a 30 minute workout")).toBe("Plan my evening aroun…");
    expect(Array.from(cutLabel("y".repeat(40)))).toHaveLength(22);
  });

  it("uses follow-ups first, then the mode's quick prompts", () => {
    expect(promptLabels({ suggestions: [], modeId: "everyday" })).toEqual(MODES[0].quickPrompts);
    expect(promptLabels({ suggestions: ["A", "B", "C", "D"], modeId: "everyday" })).toEqual(["A", "B", "C"]);
    expect(promptLabels({ suggestions: ["A"], modeId: "everyday" })).toEqual(["A", ...MODES[0].quickPrompts.slice(0, 2)]);
  });

  it("shows the model line", () => {
    expect(modelLine({ busy: false, model: "" }, { model: "auto" })).toBe("◆ Auto: Haiku · Opus · Fable");
    expect(modelLine({ busy: false, model: "" }, { model: "claude-opus-5-5" })).toBe("◆ Claude Opus 5.5");
    expect(modelLine({ busy: true, model: "claude-opus-5-5" }, { model: "auto" })).toBe("◆ Opus is answering");
    expect(modelLine({ busy: true, model: "" }, { model: "auto" })).toBe("◆ Haiku is answering");
  });

  it("shows the soonest timer, or a reminder, plus +N", () => {
    const now = 1_000_000;
    const timer: Timer = { id: "t", label: "Tea", endsAt: now + 65_000, durationMs: 1, done: false };
    expect(timerLine([], now)).toBe("");
    expect(timerLine([timer], now)).toBe("⏱ Tea 1:05");
    expect(timerLine([timer, { ...timer, id: "u" }, { ...timer, id: "v" }], now)).toBe("⏱ Tea 1:05  +2");
    const rem: Timer = { ...timer, at: "19:05" };
    expect(timerLine([rem], now)).toMatch(/^🔔 Tea /);
  });

  it("orders the status line: voice, message, live status, error", () => {
    expect(statusLine(quiet, { state: "listening", heard: "" }, "msg")?.text).toBe(PANEL_TEXT.listening);
    expect(statusLine(quiet, { state: "transcribing", heard: "" }, null)?.text).toBe("Got it…");
    expect(statusLine(quiet, { state: "thinking", heard: "" }, null)?.text).toBe("Thinking…");
    expect(statusLine(quiet, { state: "thinking", heard: "what time is it" }, null)?.text).toBe("You: “what time is it”");
    expect(statusLine(quiet, { state: "speaking", heard: "x" }, null)?.text).toBe("Speaking… (press the orb to interrupt)");
    expect(statusLine({ ...quiet, busy: true }, idleVoice, null)?.text).toBe("Replying…");
    expect(statusLine({ ...quiet, busy: true, status: "Searching the web…" }, idleVoice, null)?.text).toBe("Searching the web…");
    expect(statusLine({ ...quiet, busy: true }, idleVoice, PANEL_TEXT.stillAnswering)?.text).toBe(PANEL_TEXT.stillAnswering);
    const err = statusLine({ ...quiet, error: { message: "Rate limited.", canRetry: true } }, idleVoice, null);
    expect(err).toEqual({ text: "Rate limited.", tone: "error" });
    expect(statusLine(quiet, idleVoice, null)).toBeNull();
  });

  it("labels the two button rows", () => {
    const base = { voiceOn: false, voiceReady: true, keysOpen: false, busy: false, speakReplies: false };
    expect(buttonLabels(base)).toEqual({ talk: "🎙 Talk", type: "⌨ Type", think: "🧠 Think harder", aloud: "🔈 Silent" });
    expect(buttonLabels({ ...base, voiceReady: false }).talk).toBe("🎙 Talk (setup)");
    expect(buttonLabels({ ...base, voiceOn: true }).talk).toBe("■ End voice");
    expect(buttonLabels({ ...base, keysOpen: true, busy: true, speakReplies: true })).toMatchObject({
      type: "⌨ Hide keys",
      think: "■ Stop",
      aloud: "🔊 Aloud",
    });
  });

  it("has the empty states", () => {
    expect(emptyText("Callie", "Questions, plans, reminders", true, false)).toBe(
      "Add your Claude API key first: Exit VR, then Settings.",
    );
    expect(emptyText("Callie", "Questions, plans, reminders", true, true)).toBe(
      "Hi, I'm Callie! Questions, plans, reminders. Press Talk and just speak, press Type for the keyboard, or pick a suggestion.",
    );
    expect(emptyText("Callie", "Questions", false, true)).toMatch(
      / \(To talk out loud, exit VR and add an ElevenLabs key in Settings → Voice\.\)$/,
    );
  });

  it("maps UV to pixels and finds hit rectangles", () => {
    expect(uvToPixel(0, 1, 1280, 1600)).toEqual({ x: 0, y: 0 });
    expect(uvToPixel(0.5, 0.25, 1280, 1600)).toEqual({ x: 640, y: 1200 });
    const rects = [{ id: "a", x: 0, y: 0, w: 10, h: 10 }, { id: "b", x: 5, y: 5, w: 10, h: 10 }];
    expect(hitAt(rects, 7, 7)?.id).toBe("b");
    expect(hitAt(rects, 2, 2)?.id).toBe("a");
    expect(hitAt(rects, 30, 30)).toBeNull();
  });

  it("redraws a stream only when text length, status, actions or model change", () => {
    const a = { text: "Hello", status: "", actions: [], model: "claude-haiku-5-5" };
    expect(streamSignature(a)).toBe(streamSignature({ ...a, text: "World" }));
    expect(streamSignature(a)).not.toBe(streamSignature({ ...a, text: "Hello!" }));
    expect(streamSignature(a)).not.toBe(streamSignature({ ...a, actions: ["🔎 Searched the web"] }));
  });
});

describe("VR keyboard (§8.4)", () => {
  const empty: KbState = { text: "", shift: false, layer: "letters" };

  it("has one-shot shift", () => {
    let s = applyKey(empty, { kind: "shift" });
    s = applyKey(s, { kind: "char", char: "h" });
    s = applyKey(s, { kind: "char", char: "i" });
    expect(s).toEqual({ text: "Hi", shift: false, layer: "letters" });
  });

  it("switches layers, spaces and deletes by code point", () => {
    let s = applyKey(empty, { kind: "layer" });
    expect(s.layer).toBe("symbols");
    s = applyKey({ ...s, text: "a€" }, { kind: "backspace" });
    expect(s.text).toBe("a");
    expect(applyKey(s, { kind: "space" }).text).toBe("a ");
    expect(applyKey(s, { kind: "layer" }).layer).toBe("letters");
  });

  it("has the symbol rows as written", () => {
    expect(KB_SYMBOLS.map((r) => Array.from(r).length)).toEqual([10, 10, 9, 10]);
  });
});

describe("orb mood in VR (§8.10)", () => {
  it("maps voice and busy state to a mood", () => {
    expect(orbMood({ voiceState: "listening", ttsPlaying: true, busy: true })).toBe("listening");
    expect(orbMood({ voiceState: "speaking", ttsPlaying: false, busy: false })).toBe("speaking");
    expect(orbMood({ voiceState: "off", ttsPlaying: true, busy: true })).toBe("speaking");
    expect(orbMood({ voiceState: "transcribing", ttsPlaying: false, busy: false })).toBe("thinking");
    expect(orbMood({ voiceState: "off", ttsPlaying: false, busy: true })).toBe("thinking");
    expect(orbMood({ voiceState: "off", ttsPlaying: false, busy: false })).toBe("idle");
  });

  it("uses the mic level, or her voice when the mic is quiet", () => {
    expect(orbLevel(0.4, 0.9)).toBe(0.4);
    expect(orbLevel(0, 0.9)).toBe(0.9);
  });
});
