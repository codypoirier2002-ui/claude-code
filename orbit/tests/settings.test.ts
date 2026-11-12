// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  EFFORTS,
  MODELS,
  VOICE_PRESETS,
  assistantName,
  getSettings,
  hasVoiceKey,
  isConfigured,
  loadSettings,
  migrateSettings,
  onSettings,
  updateSettings,
} from "../src/core/settings";

const CALLIE = "7YaUDeaStRuoYg3FKsmU";
const OLD_VOICE = "JBFqnCBsd6RMkjVDRZzb";
const AMELIA = "ZF6FPAbjXT4488VcRRnw";

beforeEach(() => {
  localStorage.clear();
  loadSettings();
});

describe("defaults and constants", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      version: 4,
      apiKey: "",
      baseURL: "",
      model: "auto",
      effort: "medium",
      webSearch: true,
      speakReplies: false,
      modeId: "everyday",
      elevenLabsKey: "",
      voiceId: CALLIE,
      voiceSpeed: 1.1,
      bargeIn: true,
      expressiveVoice: true,
      lookOnRequest: false,
      suggestReplies: true,
      environmentId: "clock",
      personalityId: "cheeky",
      assistantName: "Callie",
      showCharacter: true,
      voiceCardDismissed: false,
      ambience: "vr",
      ambienceVolume: 0.5,
      startInVR: true,
    });
  });

  it("lists voices, models and efforts", () => {
    expect(VOICE_PRESETS.map((v) => v.name)).toEqual(["Callie", "Marissa", "Amelia", "Charlotte", "Ivanna", "Vanessa"]);
    expect(VOICE_PRESETS[0]).toEqual({ id: CALLIE, name: "Callie", note: "American, sweet & witty" });
    expect(MODELS.map((m) => m.id)).toEqual(["auto", "claude-haiku-5-5", "claude-opus-5-5", "claude-fable-5-1"]);
    expect(MODELS[0].label).toBe("Auto: Haiku chats, Opus thinks, Fable for tough ones");
    expect(EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("loads defaults when nothing or junk is saved", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    localStorage.setItem("orbit:settings", "{broken");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });
});

describe("migrateSettings", () => {
  it("merges saved values over the defaults and sets version 4", () => {
    const s = migrateSettings({ version: 4, apiKey: "k", webSearch: false });
    expect(s.apiKey).toBe("k");
    expect(s.webSearch).toBe(false);
    expect(s.bargeIn).toBe(true);
    expect(s.version).toBe(4);
  });

  it("below 2: a missing model or Opus becomes auto, and effort becomes medium", () => {
    expect(migrateSettings({ version: 1, effort: "high" })).toMatchObject({ model: "auto", effort: "medium" });
    expect(migrateSettings({ version: 1, model: "claude-opus-5-5", effort: "max" })).toMatchObject({
      model: "auto",
      effort: "medium",
    });
    expect(migrateSettings({ version: 1, model: "claude-haiku-5-5" }).model).toBe("claude-haiku-5-5");
    // No version at all counts as below 2.
    expect(migrateSettings({ model: "claude-opus-5-5", effort: "low" })).toMatchObject({ model: "auto", effort: "medium" });
  });

  it("2 and up keep a pinned Opus and the saved effort", () => {
    expect(migrateSettings({ version: 2, model: "claude-opus-5-5", effort: "high" })).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
    });
  });

  it("below 3: a missing voice or the old default becomes Callie", () => {
    expect(migrateSettings({ version: 2 }).voiceId).toBe(CALLIE);
    expect(migrateSettings({ version: 2, voiceId: OLD_VOICE }).voiceId).toBe(CALLIE);
    expect(migrateSettings({ version: 2, voiceId: "L0yTtpRXzdyzQlzALhgD" }).voiceId).toBe("L0yTtpRXzdyzQlzALhgD");
    expect(migrateSettings({ version: 2, voiceId: AMELIA }).voiceId).toBe(AMELIA);
    expect(migrateSettings({ version: 3, voiceId: OLD_VOICE }).voiceId).toBe(OLD_VOICE);
  });

  it("exactly 3 with Amelia becomes Callie", () => {
    expect(migrateSettings({ version: 3, voiceId: AMELIA }).voiceId).toBe(CALLIE);
    expect(migrateSettings({ version: 4, voiceId: AMELIA }).voiceId).toBe(AMELIA);
  });

  it("always clamps the speed to 0.7–1.2 and fills a missing one with 1.1", () => {
    expect(migrateSettings({ version: 4, voiceSpeed: 2 }).voiceSpeed).toBe(1.2);
    expect(migrateSettings({ version: 4, voiceSpeed: 0.1 }).voiceSpeed).toBe(0.7);
    expect(migrateSettings({ version: 4, voiceSpeed: 0.9 }).voiceSpeed).toBe(0.9);
    expect(migrateSettings({ version: 4 }).voiceSpeed).toBe(1.1);
    expect(migrateSettings({ version: 4, voiceSpeed: "fast" }).voiceSpeed).toBe(1.1);
    expect(migrateSettings({ version: 4, voiceSpeed: null }).voiceSpeed).toBe(1.1);
  });

  it("always turns an unknown model into auto", () => {
    expect(migrateSettings({ version: 4, model: "claude-3-opus" }).model).toBe("auto");
    expect(migrateSettings({ version: 4, model: "claude-fable-5-1" }).model).toBe("claude-fable-5-1");
  });

  it("always sets the version to 4", () => {
    expect(migrateSettings({ version: 1 }).version).toBe(4);
    expect(migrateSettings({ version: 9 }).version).toBe(4);
  });

  it("does not mutate its input", () => {
    const raw = { version: 1, model: "claude-opus-5-5", voiceSpeed: 5 };
    migrateSettings(raw);
    expect(raw).toEqual({ version: 1, model: "claude-opus-5-5", voiceSpeed: 5 });
  });

  it("migrates on load from orbit:settings", () => {
    localStorage.setItem("orbit:settings", JSON.stringify({ version: 3, voiceId: AMELIA, apiKey: "sk-test" }));
    const s = loadSettings();
    expect(s.voiceId).toBe(CALLIE);
    expect(s.apiKey).toBe("sk-test");
    expect(getSettings()).toBe(s);
  });
});

describe("updateSettings and onSettings", () => {
  it("shallow merges, saves and notifies until unsubscribed", () => {
    const fn = vi.fn();
    const off = onSettings(fn);
    const s = updateSettings({ modeId: "tutor", webSearch: false });
    expect(s.modeId).toBe("tutor");
    expect(s.bargeIn).toBe(true);
    expect(getSettings()).toBe(s);
    expect(JSON.parse(localStorage.getItem("orbit:settings")!)).toMatchObject({ modeId: "tutor", webSearch: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(s);
    off();
    updateSettings({ modeId: "play" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps the change in memory when saving fails", () => {
    const fail = () => {
      throw new Error("QuotaExceededError");
    };
    vi.stubGlobal("localStorage", { getItem: fail, setItem: fail, removeItem: fail });
    try {
      const s = updateSettings({ assistantName: "Nova" });
      expect(s.assistantName).toBe("Nova");
      expect(getSettings().assistantName).toBe("Nova");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(localStorage.getItem("orbit:settings")).toBeNull();
  });
});

describe("helpers", () => {
  it("cleans the assistant name and falls back to Callie", () => {
    expect(assistantName({ assistantName: "Nova" })).toBe("Nova");
    expect(assistantName({ assistantName: '  <Ms.>  "Nova"  [the]\n{great} `one` ' })).toBe("Ms. Nova the great one");
    expect(assistantName({ assistantName: "A".repeat(40) })).toBe("A".repeat(24));
    expect(assistantName({ assistantName: "" })).toBe("Callie");
    expect(assistantName({ assistantName: "  <>[]{}  " })).toBe("Callie");
    expect(assistantName({ assistantName: 42 as unknown as string })).toBe("Callie");
  });

  it("isConfigured needs an API key or a proxy URL", () => {
    expect(isConfigured(DEFAULT_SETTINGS)).toBe(false);
    expect(isConfigured({ ...DEFAULT_SETTINGS, apiKey: "sk" })).toBe(true);
    expect(isConfigured({ ...DEFAULT_SETTINGS, baseURL: "https://proxy.example" })).toBe(true);
    expect(isConfigured({ ...DEFAULT_SETTINGS, apiKey: "   " })).toBe(false);
  });

  it("hasVoiceKey needs an ElevenLabs key", () => {
    expect(hasVoiceKey(DEFAULT_SETTINGS)).toBe(false);
    expect(hasVoiceKey({ ...DEFAULT_SETTINGS, elevenLabsKey: "el" })).toBe(true);
  });
});
