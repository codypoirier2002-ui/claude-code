// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { LAURA_VOICE_ID } from "../src/core/eleven";
import {
  BargeDetector,
  EXPRESSIVE_FALLBACK_NOTICE,
  EndOfSpeechDetector,
  LAURA_NOTICE,
  MIC_CONSTRAINTS,
  MIC_DENIED,
  MIC_UNAVAILABLE,
  PreRollRecorder,
  RECORDER_TYPES,
  SentenceSplitter,
  createSpeaker,
  hasSpokenText,
  listeningLevel,
  openMic,
  pickRecorderType,
  recordUtterance,
  speakable,
  watchBargeIn,
  type RecorderLike,
  type SpeakerSettings,
  type Timers,
} from "../src/core/voice";

// ---- Fakes --------------------------------------------------------------------------

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

class FakeAnalyser {
  fftSize = 2048;
  value = 0;
  connect() {}
  disconnect() {}
  getFloatTimeDomainData(buf: Float32Array) {
    buf.fill(this.value);
  }
}

class FakeSource {
  buffer: { text: string } | null = null;
  onended: (() => void) | null = null;
  stopped = false;
  constructor(private ctx: FakeAudioContext) {}
  connect() {}
  disconnect() {}
  start() {
    this.ctx.started.push(this);
  }
  stop() {
    this.stopped = true;
  }
  end() {
    this.onended?.();
  }
}

class FakeAudioContext {
  destination = {};
  analysers: FakeAnalyser[] = [];
  started: FakeSource[] = [];
  createAnalyser() {
    const a = new FakeAnalyser();
    this.analysers.push(a);
    return a;
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  async decodeAudioData(data: ArrayBuffer) {
    return { text: new TextDecoder().decode(data) };
  }
  get played(): string[] {
    return this.started.map((s) => s.buffer!.text);
  }
  get current(): FakeSource | undefined {
    return this.started[this.started.length - 1];
  }
}

interface Req {
  url: string;
  body: Record<string, unknown>;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}

/** A fetch whose responses are decided by `auto`, or held for manual resolution. */
function fakeFetch(auto?: (req: Req) => Response | Error | undefined) {
  const reqs: Req[] = [];
  const fetch = (url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const req: Req = { url, body: JSON.parse(String(init?.body ?? "{}")), resolve, reject };
      reqs.push(req);
      const out = auto?.(req);
      if (out instanceof Error) reject(out);
      else if (out) resolve(out);
    });
  return { reqs, fetch };
}

const textOf = (req: Req): string =>
  req.body.inputs ? (req.body.inputs as { text: string }[])[0].text : String(req.body.text);
const voiceOf = (req: Req): string =>
  req.body.inputs ? (req.body.inputs as { voice_id: string }[])[0].voice_id : req.url.split("/")[5];
const ok = (req: Req) => new Response(new TextEncoder().encode(textOf(req)));
const fail = (status: number, detail: unknown) => Response.json({ detail }, { status });
const isFast = (req: Req) => req.url.includes("/text-to-speech/");

// Error bodies ElevenLabs sent for eleven_v4 on 2026-11-11 (request ids left out).
/** A chunk with no words once tags and emojis are removed: "[giggles]", "[smiles warmly]" or "😊" on its own. */
const TEXT_EMPTY = {
  type: "validation_error",
  code: "invalid_parameters",
  message: "Input at position 0 has empty text. All inputs must include non-empty text after removing speaker tags and emojis.",
  status: "input_text_empty",
  param: "text",
};
/** A model id it doesn't know. */
const MODEL_NOT_FOUND = { status: "model_not_found", message: "A model with model ID eleven_v0_probe does not exist ..." };
/** Answers like ElevenLabs: an expressive chunk with nothing left once [tags] and emojis go is refused. */
const elevenLike = (req: Req) =>
  isFast(req) || /[\p{L}\p{N}]/u.test(textOf(req).replace(/\[[^\]]*\]/g, "")) ? ok(req) : fail(400, TEXT_EMPTY);

function setup(opts: { settings?: Partial<SpeakerSettings>; auto?: (req: Req) => Response | Error | undefined } = {}) {
  const settings: SpeakerSettings = { elevenLabsKey: "sk_k", voiceId: "chosen", voiceSpeed: 1.1, expressiveVoice: true, ...opts.settings };
  const ctx = new FakeAudioContext();
  const { reqs, fetch } = fakeFetch(opts.auto);
  const notices: string[] = [];
  const errors: string[] = [];
  const speaker = createSpeaker({
    audioContext: () => ctx as unknown as AudioContext,
    getSettings: () => settings,
    fetch,
    speechSynthesis: null,
    notify: (m) => notices.push(m),
    onError: (m) => errors.push(m),
  });
  /** Ends whatever is playing and lets the queue advance. */
  const endCurrent = async () => {
    ctx.current?.end();
    await flush();
  };
  return { settings, ctx, reqs, speaker, notices, errors, endCurrent };
}

const S1 = "This is the very first sentence of the reply, and it is long.";
const S2 = "Here comes the second sentence, which is also quite long now.";
const S3 = "And finally a third sentence that is long enough to be cut off.";

// ---- Text --------------------------------------------------------------------------------

describe("speakable", () => {
  it("strips tags unless kept", () => {
    expect(speakable("[giggles] Hi there!")).toBe("Hi there!");
    expect(speakable("[giggles] Hi there!", true)).toBe("[giggles] Hi there!");
  });

  it("omits closed code fences and removes markdown", () => {
    expect(speakable("Try this:\n```js\nconst a = 1;\n```\nDone.")).toBe("Try this: (code omitted) Done.");
    expect(speakable("**Bold** and __under__ and `code`.")).toBe("Bold and under and code.");
    expect(speakable("- one\n* two\n+ three")).toBe("one two three");
    expect(speakable("See [the docs](https://x.dev/a) now.")).toBe("See the docs now.");
    expect(speakable("  lots \n\n of\tspace  ")).toBe("lots of space");
    expect(speakable("arr[i] stays")).toBe("arr[i] stays");
  });
});

describe("hasSpokenText", () => {
  it("is false with no letter or digit outside square brackets (ElevenLabs refuses that: input_text_empty)", () => {
    for (const t of ["", "  ", "[giggles]", "[giggles] [short pause]", "[smiles warmly]", "😊", "[giggles] 👍🏽", "🇨🇦", "…!"]) {
      expect(hasSpokenText(t), JSON.stringify(t)).toBe(false);
    }
  });

  it("is true with words or numbers, tags or not", () => {
    for (const t of ["Hi.", "[giggles] Hi.", "You've got this! [giggles]", "6:29 PM", "25", "Ça va ?", "好的"]) {
      expect(hasSpokenText(t), JSON.stringify(t)).toBe(true);
    }
  });
});

describe("SentenceSplitter", () => {
  it("cuts at the first sentence end at or after 60 characters", () => {
    const s = new SentenceSplitter();
    expect(s.feed("Short one. Another short one. ")).toEqual([]);
    const out = s.feed("And this makes it long enough now. Rest");
    expect(out).toEqual(["Short one. Another short one. And this makes it long enough now."]);
    expect(out[0].length).toBeGreaterThanOrEqual(60);
    expect(s.flush()).toEqual(["Rest"]);
    expect(s.flush()).toEqual([]);
  });

  it("needs whitespace after the punctuation, or a blank line", () => {
    const s = new SentenceSplitter(10);
    expect(s.feed("Version 1.5 is out")).toEqual([]);
    expect(s.feed(" today.")).toEqual([]);
    expect(s.feed("\n\nNext")).toEqual(["Version 1.5 is out today."]);
  });

  it("never cuts inside an open code fence", () => {
    const s = new SentenceSplitter(10);
    expect(s.feed("Here is the code for you:\n```py\nprint('hi'). x = 1. y = 2. z = 3. more more more.\n")).toEqual([]);
    const out = s.feed("```\n\nThat prints hi. Done");
    expect(out).toEqual(["Here is the code for you: (code omitted)", "That prints hi."]);
    expect(s.flush()).toEqual(["Done"]);
  });

  it("emits chunks with tags kept", () => {
    const s = new SentenceSplitter();
    expect(s.feed("[giggles] " + S1 + " Next")).toEqual(["[giggles] " + S1]);
  });
});

// ---- End of speech ------------------------------------------------------------------------

describe("EndOfSpeechDetector", () => {
  function run(det: EndOfSpeechDetector, level: (t: number) => number, until = 60000) {
    for (let t = 0; t <= until; t += 50) {
      const r = det.push(level(t), t);
      if (r) return { reason: r, t };
    }
    return null;
  }

  it("ends the turn 1 s after speech that ran 500–2500 ms", () => {
    const det = new EndOfSpeechDetector({ silenceMs: 1000, noSpeechMs: 3000, maxMs: 10000 });
    const r = run(det, (t) => (t >= 500 && t <= 2500 ? 0.2 : 0.004));
    expect(r?.reason).toBe("speech-ended");
    expect(r!.t).toBeGreaterThanOrEqual(3450);
    expect(r!.t).toBeLessThanOrEqual(3600);
  });

  it("gives up with no-speech, and stops at max", () => {
    const quiet = new EndOfSpeechDetector({ silenceMs: 1000, noSpeechMs: 3000, maxMs: 10000 });
    expect(run(quiet, () => 0.004)).toEqual({ reason: "no-speech", t: 3000 });
    const chatty = new EndOfSpeechDetector({ silenceMs: 1000, noSpeechMs: 3000, maxMs: 10000 });
    expect(run(chatty, (t) => (t < 300 ? 0.004 : 0.3))).toEqual({ reason: "max", t: 10000 });
  });

  it("uses the §5.4 defaults and threshold", () => {
    const d = new EndOfSpeechDetector();
    expect(d.opts).toEqual({ silenceMs: 1300, noSpeechMs: 9000, maxMs: 30000, minLevel: 0.02 });
    const learn = (noise: number) => {
      const det = new EndOfSpeechDetector();
      for (let t = 0; t <= 300; t += 50) det.push(noise, t);
      return det.threshold;
    };
    expect(learn(0.001)).toBe(0.02);
    expect(learn(0.01)).toBeCloseTo(0.03);
    expect(learn(0.05)).toBe(0.08);
  });

  it("starts already speaking when handed over from barge-in", () => {
    const det = new EndOfSpeechDetector({ silenceMs: 1000 }, { alreadySpeaking: true, noiseFloor: 0.01 });
    expect(det.speechHeard).toBe(true);
    const r = run(det, (t) => (t < 400 ? 0.2 : 0.001));
    expect(r?.reason).toBe("speech-ended");
    expect(r!.t).toBe(1350);
  });

  it("listening level is min(1, RMS × 6)", () => {
    expect(listeningLevel(0.1)).toBeCloseTo(0.6);
    expect(listeningLevel(0.5)).toBe(1);
  });
});

// ---- Barge-in -------------------------------------------------------------------------------

describe("BargeDetector", () => {
  function run(det: BargeDetector, mic: (t: number) => number, her: (t: number) => number, until = 5000) {
    for (let t = 0; t <= until; t += 40) if (det.push(mic(t), her(t), t)) return t;
    return null;
  }

  it("her echo at .06 while she speaks at .2 never triggers", () => {
    expect(run(new BargeDetector(), () => 0.06, () => 0.2)).toBeNull();
    // Even with a silent learning window, at full speaker level (RMS .2) the leak lifts the bar.
    expect(run(new BargeDetector(), (t) => (t < 250 ? 0.005 : 0.06), () => 1)).toBeNull();
  });

  it("a four-sample cough doesn't trigger", () => {
    const cough = (t: number) => (t >= 1000 && t < 1160 ? 0.4 : 0.01);
    expect(run(new BargeDetector(), cough, () => 0.1)).toBeNull();
  });

  it("steady talking at .15 over her at .1 triggers exactly 280 ms in", () => {
    const start = 1000;
    const t = run(new BargeDetector(), (x) => (x >= start ? 0.15 : 0.02), () => 0.1);
    expect(t).toBe(start + 280);
  });

  it("learns the noise and computes the bar", () => {
    const det = new BargeDetector();
    expect(det.opts).toEqual({ minLevel: 0.045, leak: 0.35, holdMs: 280, learnMs: 250 });
    for (let t = 0; t < 250; t += 40) det.push(0.03, 0, t);
    det.push(0, 0, 250);
    expect(det.noise).toBeCloseTo(0.03);
    expect(det.bar(0)).toBeCloseTo(0.075);
    expect(det.bar(0.5)).toBeCloseTo(0.075 + 0.1 * 0.35);
  });
});

// ---- Recorders --------------------------------------------------------------------------------

class FakeRecorder implements RecorderLike {
  static made: FakeRecorder[] = [];
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  starts = 0;
  constructor() {
    FakeRecorder.made.push(this);
  }
  start(slice?: number) {
    expect(slice).toBe(250);
    this.state = "recording";
    this.starts++;
  }
  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text], { type: "audio/webm" }) });
  }
  stop() {
    this.state = "inactive";
    this.emit("tail");
    this.onstop?.();
  }
}

function manualTimers(): Timers & { advance(ms: number): void; time: number } {
  let fn: (() => void) | null = null;
  let every = 0;
  const t = {
    time: 0,
    setInterval: (f: () => void, ms: number) => {
      fn = f;
      every = ms;
      return 1;
    },
    clearInterval: () => {
      fn = null;
    },
    now: () => t.time,
    advance(ms: number) {
      for (let x = 0; x < ms; x += every) {
        t.time += every;
        fn?.();
      }
    },
  };
  return t;
}

const stream = {} as MediaStream;

describe("recordUtterance", () => {
  it("records until speech ends and keeps the audio", async () => {
    const timers = manualTimers();
    let level = 0.004;
    const levels: number[] = [];
    const h = recordUtterance({ stream, rms: () => level }, {
      createRecorder: () => new FakeRecorder(),
      mimeType: "audio/webm",
      timers,
      onLevel: (l) => levels.push(l),
      settings: { silenceMs: 1000 },
    });
    timers.advance(500);
    level = 0.2;
    timers.advance(1000);
    level = 0.004;
    timers.advance(1100);
    const r = await h.promise;
    expect(r.reason).toBe("speech-ended");
    expect(r.blob).not.toBeNull();
    expect(await r.blob!.text()).toBe("tail");
    expect(Math.max(...levels)).toBeCloseTo(1);
  });

  it("discards on no-speech and cancel, keeps on finish", async () => {
    const t1 = manualTimers();
    const h1 = recordUtterance({ stream, rms: () => 0 }, { createRecorder: () => new FakeRecorder(), timers: t1, settings: { noSpeechMs: 1000 } });
    t1.advance(1000);
    expect(await h1.promise).toEqual({ blob: null, reason: "no-speech" });

    const h2 = recordUtterance({ stream, rms: () => 0 }, { createRecorder: () => new FakeRecorder(), timers: manualTimers() });
    h2.cancel();
    expect(await h2.promise).toEqual({ blob: null, reason: "cancelled" });

    const h3 = recordUtterance({ stream, rms: () => 0 }, { createRecorder: () => new FakeRecorder(), timers: manualTimers() });
    h3.finish();
    const r3 = await h3.promise;
    expect(r3.reason).toBe("manual");
    expect(r3.blob).not.toBeNull();
  });

  it("continues a handed-over recorder without restarting it", async () => {
    const rec = new FakeRecorder();
    rec.start(250);
    const chunks = [new Blob(["head-"])];
    const h = recordUtterance({ stream, rms: () => 0 }, { recorder: rec, chunks, alreadySpeaking: true, timers: manualTimers() });
    rec.emit("more-");
    h.finish();
    const r = await h.promise;
    expect(rec.starts).toBe(1);
    expect(await r.blob!.text()).toBe("head-more-tail");
  });
});

describe("pre-roll and the barge watcher", () => {
  it("restarts a fresh segment every 1.5 s while quiet, never while loud", () => {
    FakeRecorder.made = [];
    const pre = new PreRollRecorder(stream, () => new FakeRecorder(), "audio/webm");
    pre.start(0);
    pre.tick(1000, true);
    expect(FakeRecorder.made).toHaveLength(1);
    pre.tick(1500, true);
    expect(FakeRecorder.made).toHaveLength(2);
    expect(FakeRecorder.made[0].state).toBe("inactive");
    pre.tick(3200, false);
    expect(FakeRecorder.made).toHaveLength(2);
    const h = pre.handOver();
    expect(h?.recorder).toBe(FakeRecorder.made[1]);
    expect(h?.recorder.state).toBe("recording");
    pre.tick(9000, true);
    expect(FakeRecorder.made).toHaveLength(2);
  });

  it("hands the live recorder over on a cut-in", () => {
    FakeRecorder.made = [];
    const timers = manualTimers();
    let mic = 0.01;
    const got: { rec: unknown; noise: number }[] = [];
    watchBargeIn({ stream, rms: () => mic }, {
      speakerLevel: () => 0.1,
      onBarge: (h, noise) => got.push({ rec: h?.recorder, noise }),
      createRecorder: () => new FakeRecorder(),
      mimeType: "audio/webm",
      timers,
    });
    timers.advance(2000);
    expect(FakeRecorder.made.length).toBeGreaterThan(1); // quiet: segments restarted
    mic = 0.2;
    timers.advance(400);
    expect(got).toHaveLength(1);
    expect(got[0].rec).toBe(FakeRecorder.made[FakeRecorder.made.length - 1]);
    expect((got[0].rec as FakeRecorder).state).toBe("recording");
    expect(got[0].noise).toBeCloseTo(0.01);
  });
});

describe("mic and recorder type", () => {
  const ctx = () => new FakeAudioContext() as unknown as AudioContext;

  it("asks for echo cancellation, noise suppression and AGC", async () => {
    let asked: MediaStreamConstraints | undefined;
    const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
    const mic = await openMic({
      audioContext: ctx,
      mediaDevices: { getUserMedia: async (c?: MediaStreamConstraints) => { asked = c; return { getTracks: () => tracks } as unknown as MediaStream; } },
    });
    expect(asked).toEqual(MIC_CONSTRAINTS);
    expect(asked?.audio).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    mic.close();
    expect(tracks[0].stopped).toBe(true);
  });

  it("reports the two mic errors", async () => {
    await expect(openMic({ audioContext: ctx, mediaDevices: null })).rejects.toThrow(MIC_UNAVAILABLE);
    const denied = Object.assign(new Error("no"), { name: "NotAllowedError" });
    await expect(openMic({ audioContext: ctx, mediaDevices: { getUserMedia: () => Promise.reject(denied) } })).rejects.toThrow(MIC_DENIED);
  });

  it("picks the first supported type", () => {
    expect(RECORDER_TYPES).toEqual(["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]);
    expect(pickRecorderType((t) => t === "audio/mp4" || t === "audio/ogg;codecs=opus")).toBe("audio/mp4");
    expect(pickRecorderType(() => false)).toBe("");
  });
});

// ---- Speaker ---------------------------------------------------------------------------------------

describe("speaker", () => {
  it("starts every request at once and plays strictly in order", async () => {
    const { ctx, reqs, speaker, endCurrent } = setup();
    speaker.feed(`${S1} ${S2} ${S3} `);
    await flush();
    expect(reqs).toHaveLength(3); // pipelined: all requested before anything played
    expect(speaker.speaking).toBe(true);
    reqs[2].resolve(ok(reqs[2]));
    reqs[1].resolve(ok(reqs[1]));
    await flush();
    expect(ctx.played).toEqual([]);
    reqs[0].resolve(ok(reqs[0]));
    await flush();
    expect(ctx.played).toEqual([S1]);
    await endCurrent();
    expect(ctx.played).toEqual([S1, S2]);
    await endCurrent();
    await endCurrent();
    expect(ctx.played).toEqual([S1, S2, S3]);
    expect(speaker.speaking).toBe(false);
  });

  it("sends previous_text (last 100 plain chars) and keeps tags for the expressive voice", async () => {
    const { reqs, speaker } = setup({ auto: ok });
    speaker.feed(`[giggles] ${S1} ${S2} `);
    await flush();
    expect(reqs[0].body).toEqual({ inputs: [{ text: `[giggles] ${S1}`, voice_id: "chosen" }], model_id: "eleven_v4" });
    expect(reqs[1].body.settings).toEqual({ previous_text: S1 });
  });

  it("never sends the tag left after her last sentence on its own (the 2026-11-11 demo reply)", async () => {
    // Her answer in the contest take, with the one tag the panel couldn't show: the cut after
    // "this!" left "[giggles]" alone for flush(), and ElevenLabs refused it twice with a 400.
    const { reqs, speaker, notices, errors } = setup({ auto: elevenLike });
    speaker.feed(
      "Your 25-minute focus session for your essay is running and ends at **6:29 PM**. " +
        "I'll check in halfway, then a 5-minute break starts. You've got this! [giggles]",
    );
    speaker.flush();
    await flush();
    expect(reqs.map(textOf)).toEqual([
      "Your 25-minute focus session for your essay is running and ends at 6:29 PM.",
      "I'll check in halfway, then a 5-minute break starts. You've got this!",
    ]);
    expect(reqs.some(isFast)).toBe(false);
    expect(notices).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("skips any chunk with nothing to say: a listed or unlisted tag, or an emoji, on its own", async () => {
    const { reqs, speaker, ctx, endCurrent } = setup({ auto: elevenLike });
    for (const text of ["[giggles]", "[smiles warmly]", "😊", "[sighs] 👍🏽"]) speaker.announce(text);
    await flush();
    expect(reqs).toEqual([]);
    expect(speaker.speaking).toBe(false);
    speaker.announce("[giggles] Your timer is done.");
    await flush();
    expect(reqs.map(textOf)).toEqual(["[giggles] Your timer is done."]);
    await endCurrent();
    expect(ctx.played).toEqual(["[giggles] Your timer is done."]);
  });

  it("level is min(1, RMS × 5) from one shared analyser while playing", async () => {
    const { ctx, speaker, endCurrent } = setup({ auto: ok });
    expect(speaker.level()).toBe(0);
    speaker.announce("Your timer is done.");
    await flush();
    expect(ctx.analysers).toHaveLength(1);
    expect(ctx.analysers[0].fftSize).toBe(1024);
    ctx.analysers[0].value = 0.1;
    expect(speaker.level()).toBeCloseTo(0.5);
    ctx.analysers[0].value = 0.5;
    expect(speaker.level()).toBe(1);
    await endCurrent();
    expect(speaker.level()).toBe(0);
    speaker.announce("Again.");
    await flush();
    expect(ctx.analysers).toHaveLength(1);
  });

  it("stop releases whenIdle waiters and stops the source", async () => {
    const { ctx, speaker } = setup({ auto: ok });
    speaker.say(`${S1} ${S2}`);
    await flush();
    let released = false;
    const idle = speaker.whenIdle().then(() => (released = true));
    expect(released).toBe(false);
    speaker.stop();
    await idle;
    expect(released).toBe(true);
    expect(ctx.started[0].stopped).toBe(true);
    expect(speaker.speaking).toBe(false);
    await expect(speaker.whenIdle()).resolves.toBeUndefined();
  });

  it("whenIdle resolves when the queue drains", async () => {
    const { speaker, endCurrent } = setup({ auto: ok });
    speaker.say("Hello there.");
    await flush();
    let done = false;
    void speaker.whenIdle().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    await endCurrent();
    expect(done).toBe(true);
  });

  it("an old reply's audio never plays after stop (generation guard)", async () => {
    const { ctx, reqs, speaker } = setup();
    speaker.feed(`${S1} `);
    speaker.flush();
    await flush();
    speaker.stop();
    speaker.feed(`${S2} `);
    speaker.flush();
    await flush();
    expect(reqs).toHaveLength(2);
    reqs[0].resolve(ok(reqs[0]));
    await flush();
    expect(ctx.played).toEqual([]);
    reqs[1].resolve(ok(reqs[1]));
    await flush();
    expect(ctx.played).toEqual([S2]);
  });

  it("say() replaces whatever was playing", async () => {
    const { ctx, speaker } = setup({ auto: ok });
    speaker.announce("First thing.");
    await flush();
    speaker.say("Second thing.");
    await flush();
    expect(ctx.started[0].stopped).toBe(true);
    expect(ctx.played).toEqual(["First thing.", "Second thing."]);
  });

  describe("fallbacks", () => {
    it("retries once without previous_text on 400/422 and stops sending it", async () => {
      const { reqs, speaker, notices, ctx, endCurrent } = setup({
        auto: (req) => (req.body.settings ? fail(422, [{ msg: "previous_text invalid" }]) : ok(req)),
      });
      speaker.feed(`${S1} ${S2} ${S3} `);
      await flush();
      const expressive = reqs.filter((r) => !isFast(r));
      expect(expressive).toHaveLength(reqs.length);
      // S2 and S3 were both in flight with previous_text; each is retried once without it.
      expect(reqs.filter((r) => r.body.settings)).toHaveLength(2);
      expect(reqs).toHaveLength(5);
      expect(notices).toEqual([]);
      await endCurrent();
      await endCurrent();
      expect(ctx.played).toEqual([S1, S2, S3]);
      speaker.feed("One more sentence that is long enough to be its own chunk here. ");
      await flush();
      expect(reqs).toHaveLength(6);
      expect(reqs[5].body.settings).toBeUndefined(); // stopped sending it for the session
    });

    it("switches to the fast voice for the session on 403, with a one-time notice", async () => {
      const { reqs, speaker, notices, ctx, endCurrent } = setup({
        auto: (req) => (isFast(req) ? ok(req) : fail(403, { status: "forbidden", message: "Model not allowed" })),
      });
      speaker.feed(`[sighs] ${S1} ${S2} `);
      await flush();
      expect(notices).toEqual([EXPRESSIVE_FALLBACK_NOTICE]);
      speaker.feed(`${S3} `);
      speaker.flush();
      await flush();
      const last = reqs[reqs.length - 1];
      expect(isFast(last)).toBe(true); // straight to fast now
      expect(reqs.filter((r) => !isFast(r))).toHaveLength(2);
      expect(reqs.find(isFast)?.body.text).toBe(S1); // tags stripped for the fast voice
      await endCurrent();
      await endCurrent();
      expect(ctx.played).toEqual([S1, S2, S3]);
      expect(notices).toHaveLength(1);
    });

    it("sends just that chunk with the fast voice on a 400 about the chunk itself, with no notice", async () => {
      const { reqs, speaker, notices, errors, ctx, endCurrent } = setup({
        auto: (req) => (!isFast(req) && textOf(req) === S2 ? fail(400, TEXT_EMPTY) : ok(req)),
      });
      speaker.feed(`${S1} ${S2} ${S3} `);
      await flush();
      // S2 carried previous_text, so it was tried once more without it before the fast voice took it.
      expect(reqs.filter((r) => textOf(r) === S2).map((r) => [isFast(r), "settings" in r.body])).toEqual([
        [false, true],
        [false, false],
        [true, false],
      ]);
      expect(isFast(reqs.find((r) => textOf(r) === S3)!)).toBe(false);
      expect(notices).toEqual([]);
      expect(errors).toEqual([]);
      await endCurrent();
      await endCurrent();
      expect(ctx.played).toEqual([S1, S2, S3]);
      // Expressive voice is still on, and so is previous_text: dropping it didn't help.
      speaker.feed("One more sentence that is long enough to be its own chunk here. ");
      await flush();
      const last = reqs[reqs.length - 1];
      expect(isFast(last)).toBe(false);
      expect(last.body.settings).toEqual({ previous_text: S3 });
    });

    it("sends just that chunk with the fast voice on a 422 that names no model or permission", async () => {
      const { reqs, speaker, notices } = setup({
        auto: (req) =>
          !isFast(req) && textOf(req) === S1
            ? fail(422, [{ loc: ["body", "inputs", 0, "text"], msg: "String should have at most 2000 characters", type: "string_too_long" }])
            : ok(req),
      });
      speaker.feed(`${S1} ${S2} `);
      await flush();
      expect(reqs.map((r) => [textOf(r), isFast(r)])).toEqual([
        [S1, false],
        [S2, false],
        [S1, true],
      ]);
      expect(notices).toEqual([]);
    });

    it("switches to the fast voice for the session when a 400 says the model doesn't exist", async () => {
      const { reqs, speaker, notices } = setup({
        auto: (req) => (isFast(req) ? ok(req) : fail(400, MODEL_NOT_FOUND)),
      });
      speaker.feed(`${S1} ${S2} `);
      await flush();
      expect(notices).toEqual([EXPRESSIVE_FALLBACK_NOTICE]);
      // No retry without previous_text for S2: the model is the trouble, not the request.
      expect(reqs.filter((r) => !isFast(r)).map(textOf)).toEqual([S1, S2]);
      speaker.feed(`${S3} `);
      speaker.flush();
      await flush();
      expect(isFast(reqs[reqs.length - 1])).toBe(true);
      expect(notices).toHaveLength(1);
    });

    it("switches to the fast voice for the session when the key lacks a permission", async () => {
      const { reqs, speaker, notices } = setup({
        auto: (req) =>
          isFast(req)
            ? ok(req)
            : fail(401, {
                status: "missing_permissions",
                message: "The API key you used is missing the permission text_to_speech to execute this operation.",
              }),
      });
      speaker.feed(`${S1} `);
      speaker.flush();
      await flush();
      expect(notices).toEqual([EXPRESSIVE_FALLBACK_NOTICE]);
      speaker.feed(`${S2} `);
      speaker.flush();
      await flush();
      expect(reqs.map(isFast)).toEqual([false, true, true]);
    });

    it("decides by kind: a 401 out-of-credits error is not 'expressive unavailable'", async () => {
      const { speaker, notices, errors, reqs } = setup({
        auto: () => fail(401, { status: "quota_exceeded", message: "This request exceeds your quota." }),
      });
      speaker.feed(`${S1} ${S2} `);
      await flush();
      expect(notices).toEqual([]);
      expect(errors).toEqual(["Your ElevenLabs credits have run out for this month. They refill on your plan's renewal date."]);
      expect(reqs.some(isFast)).toBe(false);
      expect(speaker.speaking).toBe(false);
    });

    it("sends just that chunk with the fast voice on 5xx and network errors", async () => {
      let n = 0;
      const { reqs, speaker, notices, ctx, endCurrent } = setup({
        auto: (req) => {
          if (isFast(req)) return ok(req);
          n++;
          if (n === 1) return fail(503, { message: "overloaded" });
          if (n === 2) return new TypeError("Failed to fetch");
          return ok(req);
        },
      });
      speaker.feed(`${S1} ${S2} ${S3} `);
      await flush();
      expect(reqs.filter(isFast).map((r) => r.body.text).sort()).toEqual([S1, S2].sort());
      expect(reqs.filter((r) => !isFast(r))).toHaveLength(3); // S3 still went expressive
      expect(notices).toEqual([]);
      await endCurrent();
      await endCurrent();
      expect(ctx.played).toEqual([S1, S2, S3]);
    });

    it("falls back to Laura when the chosen voice isn't available, until another voice is picked", async () => {
      const { reqs, speaker, notices, settings, endCurrent } = setup({
        auto: (req) =>
          voiceOf(req) === LAURA_VOICE_ID || voiceOf(req) === "other"
            ? ok(req)
            : fail(402, { status: "payment_required", message: "Library voices need a paid plan" }),
      });
      speaker.feed(`${S1} ${S2} `);
      await flush();
      expect(notices).toEqual([LAURA_NOTICE]);
      expect(reqs.filter((r) => voiceOf(r) === LAURA_VOICE_ID)).toHaveLength(2);
      speaker.feed(`${S3} `);
      speaker.flush();
      await flush();
      expect(voiceOf(reqs[reqs.length - 1])).toBe(LAURA_VOICE_ID); // no new failing request
      await endCurrent();
      await endCurrent();
      await endCurrent();

      settings.voiceId = "other"; // picking another voice ends the fallback
      speaker.say("A new voice speaking now.");
      await flush();
      expect(voiceOf(reqs[reqs.length - 1])).toBe("other");
      expect(notices).toHaveLength(1);
    });

    it("Laura also covers the fast voice", async () => {
      const { reqs, speaker, notices } = setup({
        settings: { expressiveVoice: false },
        auto: (req) => (voiceOf(req) === LAURA_VOICE_ID ? ok(req) : fail(404, { status: "voice_not_found", message: "not found" })),
      });
      speaker.say("Hello from the fast voice.");
      await flush();
      expect(reqs.map((r) => [isFast(r), voiceOf(r)])).toEqual([[true, "chosen"], [true, LAURA_VOICE_ID]]);
      expect(notices).toEqual([LAURA_NOTICE]);
    });
  });

  it("uses speechSynthesis at 1.05 with level 0 when there is no key", async () => {
    const ctx = new FakeAudioContext();
    const spoken: { text: string; rate: number; onend: (() => void) | null }[] = [];
    let cancelled = 0;
    const speaker = createSpeaker({
      audioContext: () => ctx as unknown as AudioContext,
      getSettings: () => ({ elevenLabsKey: " ", voiceId: "v", voiceSpeed: 1, expressiveVoice: true }),
      fetch: () => Promise.reject(new Error("no network expected")),
      speechSynthesis: { speak: (u: SpeechSynthesisUtterance) => spoken.push(u as never), cancel: () => cancelled++ } as unknown as SpeechSynthesis,
      createUtterance: (text) => ({ text, rate: 1, onend: null, onerror: null }) as unknown as SpeechSynthesisUtterance,
    });
    speaker.announce("[giggles] 😊");
    expect(spoken).toEqual([]); // nothing to say
    speaker.say("[giggles] Hello there, **friend**.");
    expect(spoken.map((u) => [u.text, u.rate])).toEqual([["Hello there, friend.", 1.05]]);
    expect(speaker.speaking).toBe(true);
    expect(speaker.level()).toBe(0);
    let idle = false;
    void speaker.whenIdle().then(() => (idle = true));
    spoken[0].onend?.();
    await flush();
    expect(idle).toBe(true);
    speaker.stop();
    expect(cancelled).toBeGreaterThan(0);
  });
});
