// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistant, type ApiMessage, type ClientLike, type StreamEvent } from "../src/core/assistant";
import {
  DEMO_BUILD,
  DEMO_SPEECH_MAX_CHARS,
  claudeTarget,
  demoModel,
  elevenRoute,
  splitSpeech,
  usesDemoServer,
} from "../src/core/demo";
import { ELEVEN_BASE, createElevenClient } from "../src/core/eleven";
import { DEFAULT_SETTINGS, hasVoiceKey, isConfigured, type Settings } from "../src/core/settings";
import { SentenceSplitter } from "../src/core/voice";
import { createWorkspace } from "../src/core/workspace";
import { PANEL_TEXT, modelLine } from "../src/xr/panelModel";

const ORIGIN = "https://orbit-demo.example";
const none = { apiKey: "", baseURL: "" };

describe("demo builds (§21): where calls go", () => {
  it("is off in the test build, so ordinary behaviour is what the other suites check", () => {
    expect(DEMO_BUILD).toBe(false);
    expect(isConfigured(none)).toBe(false);
    expect(hasVoiceKey({ elevenLabsKey: "" })).toBe(false);
  });

  it("counts the demo server as configured, for Claude and for voice", () => {
    expect(isConfigured(none, true)).toBe(true);
    expect(hasVoiceKey({ elevenLabsKey: "" }, true)).toBe(true);
    expect(isConfigured({ apiKey: " k ", baseURL: "" }, false)).toBe(true);
  });

  it("sends Claude calls to the visitor's own key or proxy when there is one", () => {
    expect(claudeTarget({ apiKey: " sk-mine ", baseURL: "" }, true, () => ORIGIN)).toEqual({ apiKey: "sk-mine", baseURL: "", demo: false });
    expect(claudeTarget({ apiKey: "", baseURL: " https://my.proxy " }, true, () => ORIGIN)).toEqual({
      apiKey: "",
      baseURL: "https://my.proxy",
      demo: false,
    });
    expect(usesDemoServer({ apiKey: "x", baseURL: "" }, true)).toBe(false);
  });

  it("sends keyless Claude calls in a demo build to the same-origin proxy, as an absolute URL", () => {
    expect(claudeTarget(none, true, () => ORIGIN)).toEqual({ apiKey: "", baseURL: `${ORIGIN}/api/claude`, demo: true });
    expect(usesDemoServer(none, true)).toBe(true);
  });

  it("leaves ordinary builds exactly as before, even with no key", () => {
    expect(claudeTarget(none, false, () => ORIGIN)).toEqual({ apiKey: "", baseURL: "", demo: false });
    expect(usesDemoServer(none, false)).toBe(false);
  });

  it("runs Fable on Opus on the demo server", () => {
    expect(demoModel("claude-fable-5-1")).toBe("claude-opus-5-5");
    expect(demoModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(demoModel("claude-haiku-5-5")).toBe("claude-haiku-5-5");
  });

  it("routes ElevenLabs by key: direct with one (or in ordinary builds), the proxy without one in a demo", () => {
    const path = "/v1/text-to-speech/abc/stream?output_format=mp3_44100_128";
    expect(elevenRoute(ELEVEN_BASE, path, "sk_1", true)).toEqual({ url: ELEVEN_BASE + path, sendKey: true });
    expect(elevenRoute(ELEVEN_BASE, path, "", false)).toEqual({ url: ELEVEN_BASE + path, sendKey: true });
    expect(elevenRoute(ELEVEN_BASE, path, "", true)).toEqual({ url: `/api/eleven?path=${encodeURIComponent(path)}`, sendKey: false });
  });
});

describe("the ElevenLabs client in a demo build", () => {
  function client(key: string, demo: boolean) {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ voices: [{ voice_id: "v", name: "V" }] })));
    return { fetch, eleven: createElevenClient({ getKey: () => key, fetch, demo }) };
  }

  it("calls the proxy with no key header when there is no key", async () => {
    const { fetch, eleven } = client("", true);
    await eleven.listVoices();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/eleven?path=%2Fv1%2Fvoices");
    expect(new Headers(init?.headers).has("xi-api-key")).toBe(false);
  });

  it("calls ElevenLabs directly with the visitor's key", async () => {
    const { fetch, eleven } = client(" sk_mine ", true);
    await eleven.listVoices();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${ELEVEN_BASE}/v1/voices`);
    expect(new Headers(init?.headers).get("xi-api-key")).toBe("sk_mine");
  });

  it("is unchanged in an ordinary build with no key", async () => {
    const { fetch, eleven } = client("", false);
    await eleven.listVoices();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${ELEVEN_BASE}/v1/voices`);
    expect(new Headers(init?.headers).get("xi-api-key")).toBe("");
  });

  it("encodes the speech path and its query for the proxy", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new ArrayBuffer(4)));
    const eleven = createElevenClient({ getKey: () => "", fetch, demo: true });
    await eleven.synthesizeFast("Hello there.", "7YaUDeaStRuoYg3FKsmU", 1.1);
    const url = fetch.mock.calls[0][0];
    expect(url.startsWith("/api/eleven?path=")).toBe(true);
    expect(decodeURIComponent(url.slice("/api/eleven?path=".length))).toBe(
      "/v1/text-to-speech/7YaUDeaStRuoYg3FKsmU/stream?output_format=mp3_44100_128",
    );
  });
});

describe("speech under the demo server's cap", () => {
  const sentence = (i: number) => `This is sentence number ${i}, which says a little something.`;

  it("leaves short speech alone", () => {
    expect(splitSpeech("Hi there.", 1000)).toEqual(["Hi there."]);
    expect(splitSpeech("", 1000)).toEqual([]);
  });

  it("cuts long speech at sentence ends, losing nothing", () => {
    const text = Array.from({ length: 40 }, (_, i) => sentence(i)).join(" ");
    const parts = splitSpeech(text, 300);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300);
    for (const p of parts) expect(p.endsWith(".")).toBe(true);
    expect(parts.join(" ")).toBe(text);
  });

  it("falls back to commas, then spaces, then a hard cut", () => {
    const commas = Array.from({ length: 50 }, () => "one more clause").join(", ");
    for (const p of splitSpeech(commas, 200)) expect(p.length).toBeLessThanOrEqual(200);
    const words = Array.from({ length: 300 }, () => "word").join(" ");
    const wordParts = splitSpeech(words, 100);
    for (const p of wordParts) expect(p.length).toBeLessThanOrEqual(100);
    expect(wordParts.join(" ")).toBe(words);
    const blob = "x".repeat(2500);
    expect(splitSpeech(blob, 1000)).toEqual(["x".repeat(1000), "x".repeat(1000), "x".repeat(500)]);
  });

  it("keeps the splitter's output under the cap when given one, and unlimited otherwise", () => {
    const long = `${Array.from({ length: 200 }, () => "and then").join(" ")}.`;
    const capped = new SentenceSplitter(60, DEMO_SPEECH_MAX_CHARS);
    const out = [...capped.feed(long), ...capped.flush()];
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(DEMO_SPEECH_MAX_CHARS);
    const plain = new SentenceSplitter();
    expect([...plain.feed(long), ...plain.flush()]).toHaveLength(1);
  });

  it("stays well under the server's 1,200 characters", () => {
    expect(DEMO_SPEECH_MAX_CHARS).toBeLessThanOrEqual(1100);
  });
});

describe("the VR status strip on the demo server", () => {
  it("names only Haiku and Opus in Auto, and shows a pinned Fable as Opus", () => {
    expect(modelLine({ busy: false, model: "" }, { model: "auto" }, true)).toBe(PANEL_TEXT.autoModelsDemo);
    expect(modelLine({ busy: false, model: "" }, { model: "auto" })).toBe(PANEL_TEXT.autoModels);
    expect(modelLine({ busy: false, model: "" }, { model: "claude-fable-5-1" }, true)).toBe("◆ Claude Opus 5.5");
    expect(modelLine({ busy: true, model: "claude-fable-5-1" }, { model: "auto" }, true)).toBe("◆ Opus is answering");
    expect(modelLine({ busy: true, model: "claude-fable-5-1" }, { model: "auto" })).toBe("◆ Fable is answering");
  });
});

describe("the Claude engine in a demo build", () => {
  beforeEach(() => localStorage.clear());

  function setup(patch: Partial<Settings>) {
    const settings: Settings = { ...DEFAULT_SETTINGS, suggestReplies: false, ...patch };
    const factoryCalls: [string, string][] = [];
    const sent: Record<string, unknown>[] = [];
    const message: ApiMessage = { model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };
    const client: ClientLike = {
      beta: {
        messages: {
          stream(params) {
            sent.push(params as Record<string, unknown>);
            return {
              on(_e: "streamEvent", _fn: (e: StreamEvent) => void) {
                return this;
              },
              finalMessage: async () => structuredClone(message),
            };
          },
        },
      },
      messages: { create: async () => message },
    };
    const assistant = createAssistant({
      getSettings: () => settings,
      updateSettings: () => {},
      workspace: createWorkspace({ now: () => Date.now() }),
      clientFactory: (apiKey, baseURL) => {
        factoryCalls.push([apiKey, baseURL]);
        return client;
      },
      demo: true,
      origin: () => ORIGIN,
    });
    return { assistant, factoryCalls, sent };
  }

  it("uses the same-origin proxy with no key, and asks it for Opus instead of Fable", async () => {
    const { assistant, factoryCalls, sent } = setup({ model: "claude-fable-5-1" });
    await assistant.send({ text: "hard one" });
    expect(factoryCalls[0]).toEqual(["", `${ORIGIN}/api/claude`]);
    expect(sent[0].model).toBe("claude-opus-5-5");
  });

  it("uses the visitor's own key, and Fable, when they entered one", async () => {
    const { assistant, factoryCalls, sent } = setup({ model: "claude-fable-5-1", apiKey: "sk-own" });
    await assistant.send({ text: "hard one" });
    expect(factoryCalls[0]).toEqual(["sk-own", ""]);
    expect(sent[0].model).toBe("claude-fable-5-1");
  });
});
