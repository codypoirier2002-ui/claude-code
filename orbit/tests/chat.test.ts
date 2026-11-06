// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { AssistantState, DisplayTurn } from "../src/core/assistant";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { buildRows, createConversation, enteringFrom } from "../src/ui/chat";
import type { AppCtx } from "../src/ui/context";
import { createSlot } from "../src/ui/slots";
import { sceneUrl } from "../src/ui/app";

const user = (text: string, index: number, image?: string): DisplayTurn => ({
  role: "user",
  text,
  actions: [],
  models: [],
  index,
  ...(image ? { image } : {}),
});
const her = (text: string, index: number, models: string[] = [], actions: string[] = []): DisplayTurn => ({
  role: "assistant",
  text,
  actions,
  models,
  index,
});
const idle = { busy: false, text: "", actions: [], model: "", status: "" };

describe("buildRows", () => {
  it("marks her last finished reply and notes an attached image", () => {
    const rows = buildRows({ ...idle, turns: [user("look", 0, "AAAA"), her("A cat.", 1, ["claude-haiku-5-5"])] });
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows[0].image).toBe("AAAA");
    expect(rows[1].imageNote).toBe(true);
    expect(rows[1].last).toBe(true);
  });

  it("adds one live bubble while busy", () => {
    const rows = buildRows({ busy: true, text: "", actions: [], model: "claude-haiku-5-5", status: "Thinking…", turns: [user("hi", 0)] });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ live: true, status: "Thinking…", models: ["claude-haiku-5-5"] });
    expect(rows.some((r) => r.last)).toBe(false);
  });

  it("folds a run's already-stored rounds into the live bubble", () => {
    const rows = buildRows({
      busy: true,
      text: "Sure",
      actions: ["Set a timer"],
      model: "claude-opus-5-5",
      status: "",
      turns: [user("plan it", 0), her("", 1, ["claude-haiku-5-5"])],
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ live: true, text: "Sure", models: ["claude-haiku-5-5", "claude-opus-5-5"], actions: ["Set a timer"] });
  });
});

describe("enteringFrom (slide-in only for new rows)", () => {
  it("animates one or two new rows", () => {
    expect(enteringFrom(2, 4, false)).toBe(2);
    expect(enteringFrom(4, 5, false)).toBe(4);
  });
  it("skips the animation for more than two at once, a mode switch, or no change", () => {
    expect(enteringFrom(0, 6, false)).toBe(6);
    expect(enteringFrom(2, 3, true)).toBe(3);
    expect(enteringFrom(4, 4, false)).toBe(4);
    expect(enteringFrom(4, 3, false)).toBe(3);
  });
});

describe("character slots", () => {
  it("start with the orb and keep one stable element across mounts", () => {
    const slot = createSlot("hero");
    const el = slot.el;
    expect(slot.content).toBe("orb");
    expect(el.querySelector(".orb")).not.toBeNull();
    let disposed = 0;
    const face = document.createElement("div");
    slot.mount({ el: face, dispose: () => disposed++ });
    expect(slot.el).toBe(el);
    expect(slot.content).toBe("custom");
    expect(el.firstChild).toBe(face);
    expect(el.classList.contains("slot-orb")).toBe(false);
    slot.mountOrb();
    expect(disposed).toBe(1);
    expect(el.classList.contains("slot-orb")).toBe(true);
  });
});

describe("sceneUrl", () => {
  it("is absolute, so a custom property can't resolve it against the stylesheet", () => {
    expect(sceneUrl("skies/thumbs/beach.jpg", "https://orbit.example/app/index.html")).toBe(
      'url("https://orbit.example/app/skies/thumbs/beach.jpg")',
    );
  });
});

// ---- The greeting and follow-ups in the conversation (§3.8, §6.5) ----

function conversationHarness(over: Partial<AssistantState> = {}) {
  let state = {
    modeId: "chat",
    suggestions: [],
    greeting: null,
    turns: [],
    lastTier: null,
    pending: null,
    hasPending: false,
    thinkHarderTarget: null,
    ...idle,
    ...over,
  } as unknown as AssistantState;
  const send = vi.fn();
  const dismissGreeting = vi.fn(() => {
    if (state.greeting) state = { ...state, greeting: { ...state.greeting, dismissed: true } };
  });
  const restore = vi.fn();
  const ctx = {
    assistant: { getState: () => state, send, dismissGreeting, thinkHarder: vi.fn(), retry: vi.fn() },
    getSettings: () => ({ ...DEFAULT_SETTINGS, apiKey: "sk-ant-test" }),
    slots: { hero: createSlot("hero") },
    voice: { startTalk: vi.fn(), canSpeak: () => false, say: vi.fn() },
    composer: { restore, clearIfDraft: vi.fn(), focus: vi.fn() },
    toast: vi.fn(),
    openSettings: vi.fn(),
    needVoiceKey: vi.fn(),
  } as unknown as AppCtx;
  const conv = createConversation(ctx);
  return {
    conv,
    send,
    dismissGreeting,
    restore,
    set(patch: Partial<AssistantState>) {
      state = { ...state, ...patch };
    },
  };
}

describe("the greeting (§3.8, §6.5)", () => {
  it("says “Hi, I'm Callie” until a greeting exists, then “Hey, it's Callie” with the banner", () => {
    const t = conversationHarness();
    t.conv.render();
    expect(t.conv.list.querySelector(".welcome h1")?.textContent).toBe("Hi, I'm Callie");
    expect(t.conv.banner.childElementCount).toBe(0);

    t.set({ greeting: { text: "[giggles] Morning! Your tea timer has 5 minutes left.", at: 1 } });
    t.conv.render();
    expect(t.conv.list.querySelector(".welcome h1")?.textContent).toBe("Hey, it's Callie");
    // Audio tags never show.
    expect(t.conv.banner.querySelector(".greeting-text")?.textContent).toBe("Morning! Your tea timer has 5 minutes left.");
  });

  it("dismisses only the banner: the welcome keeps “Hey, it's Callie”", () => {
    const t = conversationHarness({ greeting: { text: "Hi there!", at: 1 } });
    t.conv.render();
    t.conv.banner.querySelector<HTMLButtonElement>(".greeting .x")!.click();
    expect(t.dismissGreeting).toHaveBeenCalledTimes(1);
    t.conv.render();
    expect(t.conv.banner.childElementCount).toBe(0);
    expect(t.conv.list.querySelector(".welcome h1")?.textContent).toBe("Hey, it's Callie");
  });

  it("is never added to the conversation", () => {
    const t = conversationHarness({ greeting: { text: "Hi there!", at: 1 }, turns: [user("hello", 0), her("Hey!", 1)] });
    t.conv.render();
    expect([...t.conv.list.querySelectorAll(".md")].map((e) => e.textContent)).toEqual(["Hey!"]);
  });
});

describe("follow-up chips (§3.8, §6.5)", () => {
  it("sit under her last reply and send just that text, leaving the composer alone", () => {
    const t = conversationHarness({
      turns: [user("one", 0), her("first", 1), user("two", 2), her("second", 3)],
      suggestions: ["Tell me more", "Yes, do it"],
    });
    t.conv.render();
    const groups = t.conv.list.querySelectorAll(".followups");
    expect(groups).toHaveLength(1);
    const rows = t.conv.list.querySelectorAll(".her-row");
    expect(rows[rows.length - 1].querySelector(".followups")).toBe(groups[0]);
    const chips = [...groups[0].querySelectorAll<HTMLButtonElement>(".followup")];
    expect(chips.map((c) => c.textContent)).toEqual(["Tell me more", "Yes, do it"]);
    chips[1].click();
    expect(t.send).toHaveBeenCalledWith({ text: "Yes, do it" });
    expect(t.restore).not.toHaveBeenCalled();
  });

  it("disappear while a reply streams and when there are none", () => {
    const t = conversationHarness({ turns: [user("one", 0), her("first", 1)], suggestions: [] });
    t.conv.render();
    expect(t.conv.list.querySelector(".followups")).toBeNull();
    t.set({ suggestions: ["Tell me more"], busy: true, turns: [user("one", 0), her("first", 1), user("again", 2)] });
    t.conv.render();
    expect(t.conv.list.querySelector(".followups")).toBeNull();
  });
});
