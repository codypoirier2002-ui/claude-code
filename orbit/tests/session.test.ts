// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { Assistant } from "../src/core/assistant";
import { ElevenError } from "../src/core/eleven";
import {
  DICTATION_TEXT,
  GREETING_MAX_AGE_MS,
  LOOK_PHRASE,
  SESSION_TEXT,
  createDictation,
  createVoiceSession,
  getRecognitionCtor,
  statusText,
  voiceReady,
  type RecognitionLike,
  type SessionAssistant,
  type VoiceSessionDeps,
} from "../src/core/session";
import { DEFAULT_SETTINGS, type Settings } from "../src/core/settings";
import type { BargeWatchOptions, MicHandle, PreRollHandover, RecordOptions, RecordingResult, RecorderLike } from "../src/core/voice";

// ---- Fakes ----------------------------------------------------------------------------------------

const until = async (cond: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 1));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 15));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeAssistant implements SessionAssistant {
  busy = false;
  status = "";
  sends: { text: string; attachment?: { data: string } }[] = [];
  stops = 0;
  reply = deferred<void>();
  failNext = false;
  private ls = { onTextDelta: new Set<(d: string) => void>(), onTextReset: new Set<() => void>() };
  getState() {
    return { busy: this.busy, status: this.status };
  }
  async send(input: { text: string; attachment?: { data: string } }) {
    this.sends.push(input);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("boom");
    }
    this.busy = true;
    this.reply = deferred<void>();
    await this.reply.promise;
    this.busy = false;
  }
  stop() {
    this.stops++;
    this.busy = false;
    this.reply.resolve();
  }
  on(event: "onTextDelta", fn: (d: string) => void): () => void;
  on(event: "onTextReset", fn: () => void): () => void;
  on(event: "onTextDelta" | "onTextReset", fn: ((d: string) => void) | (() => void)) {
    const set = this.ls[event] as Set<typeof fn>;
    set.add(fn);
    return () => set.delete(fn);
  }
  delta(d: string) {
    for (const fn of this.ls.onTextDelta) fn(d);
  }
  get listeners() {
    return this.ls.onTextDelta.size;
  }
}

class FakeSpeaker {
  fed: string[] = [];
  flushes = 0;
  stops = 0;
  said: string[] = [];
  speakingNow = false;
  lvl = 0.3;
  private waiters: (() => void)[] = [];
  feed(d: string) {
    this.fed.push(d);
  }
  flush() {
    this.flushes++;
  }
  say(t: string) {
    this.said.push(t);
    this.speakingNow = true;
  }
  stop() {
    this.stops++;
    this.setSpeaking(false);
  }
  get speaking() {
    return this.speakingNow;
  }
  setSpeaking(v: boolean) {
    this.speakingNow = v;
    if (!v) {
      const ws = this.waiters;
      this.waiters = [];
      ws.forEach((w) => w());
    }
  }
  whenIdle() {
    return this.speakingNow ? new Promise<void>((r) => this.waiters.push(r)) : Promise.resolve();
  }
  level() {
    return this.lvl;
  }
}

interface FakeRecording {
  opts: RecordOptions;
  result: ReturnType<typeof deferred<RecordingResult>>;
  finished: boolean;
  cancelled: boolean;
}

function harness(over: Partial<VoiceSessionDeps> = {}, settings: Partial<Settings> = {}) {
  const s: Settings = { ...DEFAULT_SETTINGS, elevenLabsKey: "sk_k", ...settings };
  const assistant = new FakeAssistant();
  const speaker = new FakeSpeaker();
  const recordings: FakeRecording[] = [];
  const transcripts: ReturnType<typeof deferred<string>>[] = [];
  const watchers: { opts: BargeWatchOptions; stopped: boolean }[] = [];
  const mics: { closed: boolean }[] = [];
  const toasts: string[] = [];
  let settingsOpened = 0;
  const session = createVoiceSession({
    getSettings: () => s,
    assistant,
    speaker,
    audioContext: () => ({}) as AudioContext,
    openMic: async () => {
      const m = { closed: false };
      mics.push(m);
      return { stream: {} as MediaStream, rms: () => 0, close: () => (m.closed = true) } satisfies MicHandle;
    },
    record: (_mic, opts) => {
      const rec: FakeRecording = { opts, result: deferred<RecordingResult>(), finished: false, cancelled: false };
      recordings.push(rec);
      return {
        promise: rec.result.promise,
        finish: () => {
          rec.finished = true;
          rec.result.resolve({ blob: new Blob(["a"]), reason: "manual" });
        },
        cancel: () => {
          rec.cancelled = true;
          rec.result.resolve({ blob: null, reason: "cancelled" });
        },
      };
    },
    transcribe: () => {
      const d = deferred<string>();
      transcripts.push(d);
      return d.promise;
    },
    watchBargeIn: (_mic, opts) => {
      const w = { opts, stopped: false };
      watchers.push(w);
      return { stop: () => (w.stopped = true) };
    },
    recognition: null,
    notify: (m) => toasts.push(m),
    openVoiceSettings: () => settingsOpened++,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    pollMs: 5,
    ...over,
  });
  const states: string[] = [];
  session.subscribe((st) => {
    if (states[states.length - 1] !== st.state) states.push(st.state);
  });
  const speech = () => ({ blob: new Blob(["voice"], { type: "audio/webm" }), reason: "speech-ended" as const });
  return { s, assistant, speaker, recordings, transcripts, watchers, mics, toasts, session, states, speech, opened: () => settingsOpened };
}

// ---- Tests ---------------------------------------------------------------------------------------------

describe("statusText and voiceReady", () => {
  it("has the overlay lines", () => {
    const base = { message: null, greeting: false, status: "" };
    expect(statusText({ ...base, state: "off" })).toBe("Paused. Tap to talk.");
    expect(statusText({ ...base, state: "listening" })).toBe("Listening… tap when you're done");
    expect(statusText({ ...base, state: "transcribing" })).toBe("Got it…");
    expect(statusText({ ...base, state: "thinking" })).toBe("Thinking…");
    expect(statusText({ ...base, state: "thinking", status: "Searching the web…" })).toBe("Searching the web…");
    expect(statusText({ ...base, state: "speaking" })).toBe("Tap to interrupt");
    expect(statusText({ ...base, state: "speaking", greeting: true })).toBe("Saying hi…");
    expect(statusText({ ...base, state: "off", message: SESSION_TEXT.didntCatch })).toBe("Didn't catch that. Tap the orb to try again.");
  });

  it("voice is ready with a key or browser recognition", () => {
    expect(voiceReady({ elevenLabsKey: "sk" }, false)).toBe(true);
    expect(voiceReady({ elevenLabsKey: " " }, true)).toBe(true);
    expect(voiceReady({ elevenLabsKey: "" }, false)).toBe(false);
    expect(getRecognitionCtor({})).toBeNull();
    class W {}
    expect(getRecognitionCtor({ webkitSpeechRecognition: W })).toBe(W);
  });

  it("matches look phrases", () => {
    for (const t of ["Look at this", "what's that?", "What are these", "can you see it", "what am I holding", "take a look"]) {
      expect(LOOK_PHRASE.test(t)).toBe(true);
    }
    expect(LOOK_PHRASE.test("what time is it")).toBe(false);
  });

  it("the real Assistant satisfies SessionAssistant", () => {
    const check = (a: Assistant): SessionAssistant => a;
    expect(typeof check).toBe("function");
  });
});

describe("the hands-free loop", () => {
  it("listens, transcribes, asks, speaks, then listens again", async () => {
    const h = harness();
    void h.session.start();
    await until(() => h.recordings.length === 1);
    expect(h.session.state).toBe("listening");
    h.recordings[0].result.resolve(h.speech());
    await until(() => h.transcripts.length === 1);
    expect(h.session.state).toBe("transcribing");
    h.transcripts[0].resolve("  what's the weather  ");
    await until(() => h.assistant.sends.length === 1);
    expect(h.assistant.sends[0]).toEqual({ text: "what's the weather" });
    expect(h.session.state).toBe("thinking");
    expect(h.session.heard).toBe("what's the weather");

    h.assistant.delta("It's sunny.");
    expect(h.speaker.fed).toEqual(["It's sunny."]);
    h.speaker.setSpeaking(true);
    await until(() => h.session.state === "speaking");
    expect(h.watchers).toHaveLength(1);
    expect(h.session.level()).toBe(0.3);

    h.assistant.reply.resolve(); // reply finished streaming
    await settle();
    expect(h.speaker.flushes).toBe(1);
    expect(h.recordings).toHaveLength(1); // still speaking: wait
    h.speaker.setSpeaking(false);
    await until(() => h.recordings.length === 2);
    expect(h.session.state).toBe("listening");
    expect(h.watchers[0].stopped).toBe(true);
    expect(h.assistant.listeners).toBe(0);
    expect(h.states).toEqual(["listening", "transcribing", "thinking", "speaking", "listening"]);
  });

  it("a null recording goes off, shown as Paused", async () => {
    const h = harness();
    void h.session.start();
    await until(() => h.recordings.length === 1);
    h.recordings[0].result.resolve({ blob: null, reason: "no-speech" });
    await until(() => h.session.state === "off");
    expect(statusText(h.session.getState())).toBe("Paused. Tap to talk.");
    expect(h.mics[0].closed).toBe(true);
  });

  it("an empty transcript says it didn't catch that and goes off", async () => {
    const h = harness();
    void h.session.start();
    await until(() => h.recordings.length === 1);
    h.recordings[0].result.resolve(h.speech());
    await until(() => h.transcripts.length === 1);
    h.transcripts[0].resolve("   ");
    await until(() => h.session.state === "off");
    expect(h.session.getState().message).toBe("Didn't catch that. Tap the orb to try again.");
    expect(h.assistant.sends).toHaveLength(0);
  });

  it("errors show their message, or the generic one, and go off", async () => {
    const h = harness();
    void h.session.start();
    await until(() => h.recordings.length === 1);
    h.recordings[0].result.resolve(h.speech());
    await until(() => h.transcripts.length === 1);
    h.transcripts[0].reject(ElevenError.from(429, {}, "transcription"));
    await until(() => h.session.state === "off");
    expect(h.session.getState().message).toBe("ElevenLabs is busy right now. Try again in a moment.");

    const g = harness({ openMic: () => Promise.reject("weird") });
    await g.session.start();
    expect(g.session.state).toBe("off");
    expect(g.session.getState().message).toBe("Voice input failed. Try again.");
  });

  it("without a key or recognition it toasts and opens Settings", async () => {
    const h = harness({}, { elevenLabsKey: "" });
    await h.session.start();
    expect(h.toasts).toEqual(["Voice needs an ElevenLabs key (Quest Browser has no built-in speech recognition)."]);
    expect(h.opened()).toBe(1);
    expect(h.session.state).toBe("off");
  });
});

describe("tap", () => {
  async function toThinking() {
    const h = harness();
    void h.session.tap(); // off → start
    await until(() => h.recordings.length === 1);
    h.session.tap(); // listening → send now
    expect(h.recordings[0].finished).toBe(true);
    await until(() => h.transcripts.length === 1);
    h.transcripts[0].resolve("hello");
    await until(() => h.assistant.sends.length === 1);
    return h;
  }

  it("off → start, listening → send now", async () => {
    const h = await toThinking();
    expect(h.session.state).toBe("thinking");
  });

  it("thinking → interrupt and listen", async () => {
    const h = await toThinking();
    const stops = h.assistant.stops;
    h.session.tap();
    expect(h.assistant.stops).toBe(stops + 1);
    expect(h.speaker.stops).toBeGreaterThan(0);
    await until(() => h.recordings.length === 2);
    expect(h.session.state).toBe("listening");
    expect(h.mics).toHaveLength(1); // the mic stays open
  });

  it("speaking → interrupt and listen", async () => {
    const h = await toThinking();
    h.speaker.setSpeaking(true);
    await until(() => h.session.state === "speaking");
    h.session.tap();
    expect(h.speaker.speaking).toBe(false);
    await until(() => h.recordings.length === 2);
    expect(h.watchers[0].stopped).toBe(true);
    // The old reply finishing later doesn't disturb the new turn.
    h.assistant.reply.resolve();
    await settle();
    expect(h.session.state).toBe("listening");
    expect(h.recordings).toHaveLength(2);
  });
});

describe("barge-in", () => {
  it("cuts her off and hands the live recorder to the next recording", async () => {
    const h = harness();
    void h.session.start();
    await until(() => h.recordings.length === 1);
    h.recordings[0].result.resolve(h.speech());
    await until(() => h.transcripts.length === 1);
    h.transcripts[0].resolve("tell me a story");
    await until(() => h.assistant.sends.length === 1);
    h.speaker.setSpeaking(true);
    await until(() => h.watchers.length === 1);
    expect(h.watchers[0].opts.speakerLevel()).toBe(0.3);

    const recorder = { state: "recording" } as RecorderLike;
    const handover: PreRollHandover = { recorder, chunks: [new Blob(["pre"])] };
    h.watchers[0].opts.onBarge(handover, 0.012);
    expect(h.assistant.stops).toBe(1);
    expect(h.speaker.speaking).toBe(false);
    await until(() => h.recordings.length === 2);
    expect(h.recordings[1].opts).toMatchObject({ alreadySpeaking: true, noiseFloor: 0.012, recorder, chunks: handover.chunks });
  });

  it("is off without the setting", async () => {
    const h = harness({}, { bargeIn: false });
    void h.session.start();
    await until(() => h.recordings.length === 1);
    h.recordings[0].result.resolve(h.speech());
    await until(() => h.transcripts.length === 1);
    h.transcripts[0].resolve("hi");
    await until(() => h.assistant.sends.length === 1);
    h.speaker.setSpeaking(true);
    await until(() => h.session.state === "speaking");
    await settle();
    expect(h.watchers).toHaveLength(0);
  });
});

describe("greeting", () => {
  it("says a fresh unspoken greeting first, then listens", async () => {
    const now = 1_000_000_000;
    const h = harness({ now: () => now, takeGreeting: () => ({ text: "Morning! [giggles]", at: now - 60_000 }) });
    void h.session.start();
    await until(() => h.speaker.said.length === 1);
    expect(h.speaker.said).toEqual(["Morning! [giggles]"]);
    expect(statusText(h.session.getState())).toBe("Saying hi…");
    await settle();
    expect(h.recordings).toHaveLength(0);
    h.speaker.setSpeaking(false);
    await until(() => h.recordings.length === 1);
    expect(h.session.getState().greeting).toBe(false);
  });

  it("skips a greeting older than 15 minutes", async () => {
    const now = 1_000_000_000;
    const h = harness({ now: () => now, takeGreeting: () => ({ text: "Old hi", at: now - GREETING_MAX_AGE_MS - 1 }) });
    void h.session.start();
    await until(() => h.recordings.length === 1);
    expect(h.speaker.said).toEqual([]);
  });
});

describe("stale-token safety", () => {
  it("a transcript arriving after stop() is dropped", async () => {
    const h = harness();
    void h.session.start();
    await until(() => h.recordings.length === 1);
    h.recordings[0].result.resolve(h.speech());
    await until(() => h.transcripts.length === 1);
    h.session.stop();
    expect(h.session.state).toBe("off");
    h.transcripts[0].resolve("too late");
    await settle();
    expect(h.assistant.sends).toHaveLength(0);
    expect(h.session.state).toBe("off");
  });

  it("a mic that opens after stop() is closed, not stored (§18)", async () => {
    const mic = deferred<MicHandle>();
    let closed = false;
    const h = harness({ openMic: () => mic.promise });
    void h.session.start();
    h.session.stop();
    mic.resolve({ stream: {} as MediaStream, rms: () => 0, close: () => (closed = true) });
    await settle();
    expect(closed).toBe(true);
    expect(h.recordings).toHaveLength(0);
  });

  it("stop() cancels the recording and closes the mic; keepAnswer leaves the reply alone", async () => {
    const h = harness();
    void h.session.start();
    await until(() => h.recordings.length === 1);
    h.session.stop();
    expect(h.recordings[0].cancelled).toBe(true);
    expect(h.mics[0].closed).toBe(true);

    const k = await (async () => {
      const x = harness();
      void x.session.start();
      await until(() => x.recordings.length === 1);
      x.recordings[0].result.resolve(x.speech());
      await until(() => x.transcripts.length === 1);
      x.transcripts[0].resolve("hi");
      await until(() => x.assistant.sends.length === 1);
      x.speaker.setSpeaking(true);
      return x;
    })();
    k.session.stop({ keepAnswer: true });
    expect(k.assistant.stops).toBe(0);
    expect(k.speaker.speaking).toBe(true);
    k.session.stop();
    expect(k.speaker.speaking).toBe(false);
  });
});

describe("ask", () => {
  it("never rejects and always flushes the speaker", async () => {
    const h = harness();
    h.assistant.failNext = true;
    await expect(h.session.ask("hello")).resolves.toBeUndefined();
    expect(h.speaker.flushes).toBe(1);
  });

  it("stops a typed reply still streaming before sending", async () => {
    const h = harness();
    h.assistant.busy = true;
    const p = h.session.ask("new question");
    expect(h.assistant.stops).toBe(1);
    await until(() => h.assistant.sends.length === 1);
    h.assistant.reply.resolve();
    await p;
  });

  it("resolves only once the reply has finished streaming", async () => {
    const h = harness();
    let done = false;
    const p = h.session.ask("hi").then(() => (done = true));
    await until(() => h.assistant.sends.length === 1);
    await settle();
    expect(done).toBe(false);
    h.assistant.reply.resolve();
    await p;
    expect(done).toBe(true);
  });

  it("takes a camera frame on a look phrase when Look-on-request is on", async () => {
    let shots = 0;
    const h = harness({ captureFrame: async () => (shots++, "JPEGDATA") }, { lookOnRequest: true });
    const p = h.session.ask("What am I holding?");
    await until(() => h.assistant.sends.length === 1);
    expect(h.assistant.sends[0]).toEqual({ text: "What am I holding?", attachment: { data: "JPEGDATA" } });
    h.assistant.reply.resolve();
    await p;

    const off = harness({ captureFrame: async () => (shots++, "X") }, { lookOnRequest: false });
    const q = off.session.ask("look at this");
    await until(() => off.assistant.sends.length === 1);
    expect(off.assistant.sends[0].attachment).toBeUndefined();
    off.assistant.reply.resolve();
    await q;
    expect(shots).toBe(1);

    const broken = harness({ captureFrame: () => Promise.reject(new Error("Couldn't open the camera.")) }, { lookOnRequest: true });
    const r = broken.session.ask("can you see this");
    await until(() => broken.assistant.sends.length === 1);
    expect(broken.toasts).toEqual(["Couldn't open the camera."]);
    broken.assistant.reply.resolve();
    await r;
  });
});

class FakeRecognition implements RecognitionLike {
  static last: FakeRecognition | null = null;
  lang = "";
  interimResults = true;
  continuous = true;
  maxAlternatives = 5;
  onresult: RecognitionLike["onresult"] = null;
  onerror: RecognitionLike["onerror"] = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.onerror?.({ error: "aborted" });
    this.onend?.();
  }
  say(text: string) {
    this.onresult?.({ results: [[{ transcript: text }]] });
    this.onend?.();
  }
}

describe("browser recognition fallback", () => {
  it("listens for one utterance in the browser's language", async () => {
    FakeRecognition.last = null;
    const h = harness({ recognition: FakeRecognition, language: () => "en-GB" }, { elevenLabsKey: "" });
    void h.session.start();
    await until(() => FakeRecognition.last?.started === true);
    const rec = FakeRecognition.last!;
    expect(rec.lang).toBe("en-GB");
    expect(rec.continuous).toBe(false);
    rec.say("hello computer");
    await until(() => h.assistant.sends.length === 1);
    expect(h.assistant.sends[0].text).toBe("hello computer");
    expect(h.mics).toHaveLength(0);
    h.session.stop();
  });

  it("reports recognition errors", async () => {
    FakeRecognition.last = null;
    const h = harness({ recognition: FakeRecognition }, { elevenLabsKey: "" });
    void h.session.start();
    await until(() => FakeRecognition.last?.started === true);
    FakeRecognition.last!.onerror?.({ error: "network" });
    await until(() => h.session.state === "off");
    expect(h.session.getState().message).toBe("Voice input error: network");
  });
});

describe("dictation", () => {
  function dictation(settings: Partial<Settings> = {}, over: Record<string, unknown> = {}) {
    const toasts: string[] = [];
    const phases: string[] = [];
    const texts: string[] = [];
    const recs: { result: ReturnType<typeof deferred<RecordingResult>>; finished: boolean }[] = [];
    const transcribed = deferred<string>();
    const d = createDictation({
      getSettings: () => ({ ...DEFAULT_SETTINGS, elevenLabsKey: "sk", ...settings }),
      audioContext: () => ({}) as AudioContext,
      openMic: async () => ({ stream: {} as MediaStream, rms: () => 0, close: () => undefined }),
      record: () => {
        const r = { result: deferred<RecordingResult>(), finished: false };
        recs.push(r);
        return {
          promise: r.result.promise,
          finish: () => {
            r.finished = true;
            r.result.resolve({ blob: new Blob(["x"]), reason: "manual" });
          },
          cancel: () => r.result.resolve({ blob: null, reason: "cancelled" }),
        };
      },
      transcribe: () => transcribed.promise,
      recognition: null,
      onToast: (m) => toasts.push(m),
      onPhase: (p) => phases.push(p),
      onText: (t) => texts.push(t),
      ...over,
    });
    return { d, toasts, phases, texts, recs, transcribed };
  }

  it("records, finishes early on a second tap, transcribes and appends", async () => {
    const x = dictation();
    const run = x.d.toggle();
    await until(() => x.recs.length === 1);
    expect(x.toasts).toEqual(["Listening… tap the mic again when you're done."]);
    expect(x.d.phase).toBe("listening");
    await x.d.toggle();
    expect(x.recs[0].finished).toBe(true);
    await until(() => x.d.phase === "transcribing");
    x.transcribed.resolve(" hello world ");
    await run;
    expect(x.texts).toEqual(["hello world"]);
    expect(x.phases).toEqual(["listening", "transcribing", "idle"]);
    expect(DICTATION_TEXT.transcribing).toBe("Transcribing…");
  });

  it("fails with 'Dictation failed.'", async () => {
    const x = dictation({}, { transcribe: () => Promise.reject(new TypeError("Failed to fetch")) });
    const run = x.d.toggle();
    await until(() => x.recs.length === 1);
    x.recs[0].result.resolve({ blob: new Blob(["x"]), reason: "speech-ended" });
    await run;
    expect(x.toasts[x.toasts.length - 1]).toBe("Dictation failed.");
    expect(x.d.phase).toBe("idle");
  });

  it("uses browser recognition without a key", async () => {
    FakeRecognition.last = null;
    const x = dictation({ elevenLabsKey: "" }, { recognition: FakeRecognition });
    const run = x.d.toggle();
    await until(() => FakeRecognition.last?.started === true);
    expect(x.toasts).toEqual(["Listening…"]);
    FakeRecognition.last!.say("buy milk");
    await run;
    expect(x.texts).toEqual(["buy milk"]);
  });
});
