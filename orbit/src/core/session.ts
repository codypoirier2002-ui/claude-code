// The hands-free voice session (§5.6): listen → transcribe → ask → speak →
// listen, with tap controls, barge-in, the greeting, the browser
// SpeechRecognition fallback and composer dictation. A token cancels stale
// async work: it is checked after every await.

import { ElevenError, createElevenClient, type FetchLike } from "./eleven";
import { hasVoiceKey, type Settings } from "./settings";
import {
  MIC_DENIED,
  MIC_UNAVAILABLE,
  openMic as defaultOpenMic,
  recordUtterance,
  watchBargeIn as defaultWatchBargeIn,
  type BargeWatchOptions,
  type BargeWatcher,
  type MicHandle,
  type PreRollHandover,
  type RecordOptions,
  type RecordingHandle,
  type Speaker,
  type Timers,
} from "./voice";

// ---- Product copy ----------------------------------------------------------------

export const SESSION_TEXT = Object.freeze({
  off: "Paused. Tap to talk.",
  listening: "Listening… tap when you're done",
  transcribing: "Got it…",
  thinking: "Thinking…",
  speaking: "Tap to interrupt",
  greeting: "Saying hi…",
  didntCatch: "Didn't catch that. Tap the orb to try again.",
  failed: "Voice input failed. Try again.",
  needsKey: "Voice needs an ElevenLabs key (Quest Browser has no built-in speech recognition).",
});

export const DICTATION_TEXT = Object.freeze({
  /** Toast when recording with a key. */
  listeningKey: "Listening… tap the mic again when you're done.",
  /** Composer placeholder while transcribing. */
  transcribing: "Transcribing…",
  /** Toast with browser recognition (no key). */
  listening: "Listening…",
  failed: "Dictation failed.",
});

/** §4.6: voice phrases that take a camera frame when Look-on-request is on. */
export const LOOK_PHRASE =
  /\b(look at (this|that|these|my)|what(?:'s| is| are) (this|that|these)|can you see|what am i (looking at|holding)|take a look)\b/i;

/** An unspoken greeting younger than this is said before the first listen. */
export const GREETING_MAX_AGE_MS = 15 * 60 * 1000;
/** The wait step re-checks at least this often (§5.6 asks for ≤ 500 ms). */
export const POLL_MS = 250;

// ---- Browser speech recognition -----------------------------------------------------------

export interface RecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

export interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((ev: RecognitionResultEvent) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type RecognitionCtor = new () => RecognitionLike;

/** SpeechRecognition or webkitSpeechRecognition, if the browser has one. */
export function getRecognitionCtor(scope: unknown = globalThis): RecognitionCtor | null {
  const w = scope as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown } | null;
  const ctor = w?.SpeechRecognition ?? w?.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as RecognitionCtor) : null;
}

/** Voice counts as ready with an ElevenLabs key or with browser recognition. */
export function voiceReady(settings: Pick<Settings, "elevenLabsKey">, hasBrowserRecognition: boolean): boolean {
  return hasVoiceKey(settings) || hasBrowserRecognition;
}

export interface RecognitionHandle {
  /** The final transcript, "" when nothing was heard. */
  promise: Promise<string>;
  finish(): void;
  cancel(): void;
}

/** Listens for one utterance. Errors reject with "Voice input error: {e.error}". */
export function recognizeOnce(Ctor: RecognitionCtor, lang: string): RecognitionHandle {
  let rec: RecognitionLike;
  try {
    rec = new Ctor();
  } catch (err) {
    return { promise: Promise.reject(err), finish: () => undefined, cancel: () => undefined };
  }
  let transcript = "";
  let settled = false;
  let resolveFn!: (t: string) => void;
  let rejectFn!: (e: Error) => void;
  const promise = new Promise<string>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const done = (t: string) => {
    if (settled) return;
    settled = true;
    resolveFn(t.trim());
  };
  rec.lang = lang;
  rec.interimResults = false;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  rec.onresult = (ev) => {
    const parts: string[] = [];
    for (let i = 0; i < ev.results.length; i++) {
      const alt = ev.results[i]?.[0];
      if (alt?.transcript) parts.push(alt.transcript);
    }
    transcript = parts.join(" ");
  };
  rec.onerror = (ev) => {
    if (settled) return;
    // Hearing nothing (or being cancelled) is an empty result, not a failure.
    if (ev.error === "no-speech" || ev.error === "aborted") {
      done("");
      return;
    }
    settled = true;
    rejectFn(new Error(`Voice input error: ${ev.error}`));
  };
  rec.onend = () => done(transcript);
  try {
    rec.start();
  } catch (err) {
    settled = true;
    rejectFn(err instanceof Error ? err : new Error(String(err)));
  }
  return {
    promise,
    finish: () => {
      try {
        rec.stop();
      } catch {
        done(transcript);
      }
    },
    cancel: () => {
      done("");
      try {
        rec.abort();
      } catch {
        // ignore
      }
    },
  };
}

function defaultLanguage(): string {
  return typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US";
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- Session ------------------------------------------------------------------------------

export type VoiceState = "off" | "listening" | "transcribing" | "thinking" | "speaking";

/** The slice of the assistant the session needs (the real Assistant satisfies it). */
export interface SessionAssistant {
  getState(): { busy: boolean; status: string };
  send(input: { text: string; attachment?: { data: string } }): Promise<void>;
  stop(): void;
  on(event: "onTextDelta", fn: (delta: string) => void): () => void;
  on(event: "onTextReset", fn: () => void): () => void;
}

export type SessionSpeaker = Pick<Speaker, "feed" | "flush" | "say" | "stop" | "speaking" | "whenIdle" | "level">;

export interface GreetingToSpeak {
  text: string;
  /** Epoch ms when it arrived. */
  at: number;
}

export interface VoiceSessionDeps {
  getSettings: () => Settings;
  assistant: SessionAssistant;
  speaker: SessionSpeaker;
  /** The app-wide AudioContext (used by the default mic). */
  audioContext: () => AudioContext;
  openMic?: () => Promise<MicHandle>;
  record?: (mic: MicHandle, opts: RecordOptions) => RecordingHandle;
  watchBargeIn?: (mic: MicHandle, opts: BargeWatchOptions) => BargeWatcher;
  /** Speech to text; defaults to ElevenLabs Scribe with the settings key. */
  transcribe?: (blob: Blob, signal: AbortSignal) => Promise<string>;
  fetch?: FetchLike;
  /** Base64 JPEG of one camera frame (§4.6). */
  captureFrame?: () => Promise<string>;
  /** Returns the greeting if it hasn't been spoken yet (and marks it spoken), else null. */
  takeGreeting?: () => GreetingToSpeak | null;
  /** Defaults to getRecognitionCtor(). Pass null to disable. */
  recognition?: RecognitionCtor | null;
  /** Defaults to navigator.language. */
  language?: () => string;
  /** Toasts. */
  notify?: (message: string) => void;
  /** Opens Settings at the Voice section. */
  openVoiceSettings?: () => void;
  /** Epoch ms. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timers?: Timers;
}

export interface VoiceSessionState {
  state: VoiceState;
  /** The last transcript heard. */
  heard: string;
  /** Shown in place of the off text: the empty-transcript line or an error. */
  message: string | null;
  /** True while the greeting is being said. */
  greeting: boolean;
  /** The assistant's live status (shown while thinking). */
  status: string;
}

/** The overlay status line (§5.6). */
export function statusText(s: Pick<VoiceSessionState, "state" | "message" | "greeting" | "status">): string {
  if (s.greeting && s.state !== "off") return SESSION_TEXT.greeting;
  switch (s.state) {
    case "off":
      return s.message ?? SESSION_TEXT.off;
    case "listening":
      return SESSION_TEXT.listening;
    case "transcribing":
      return SESSION_TEXT.transcribing;
    case "thinking":
      return s.status || SESSION_TEXT.thinking;
    case "speaking":
      return SESSION_TEXT.speaking;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : SESSION_TEXT.failed;
}

export type VoiceSession = ReturnType<typeof createVoiceSession>;

export function createVoiceSession(deps: VoiceSessionDeps) {
  const { getSettings, assistant, speaker } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = Math.min(deps.pollMs ?? POLL_MS, 500);
  const language = deps.language ?? defaultLanguage;
  const notify = (m: string) => deps.notify?.(m);
  const openMicFn = deps.openMic ?? (() => defaultOpenMic({ audioContext: deps.audioContext }));
  const record = deps.record ?? ((mic: MicHandle, opts: RecordOptions) => recordUtterance(mic, { ...opts, timers: deps.timers }));
  const watch = deps.watchBargeIn ?? ((mic: MicHandle, opts: BargeWatchOptions) => defaultWatchBargeIn(mic, { ...opts, timers: deps.timers }));
  const transcribe = deps.transcribe ??
    ((blob: Blob, signal: AbortSignal) =>
      createElevenClient({ getKey: () => getSettings().elevenLabsKey, fetch: deps.fetch }).transcribe(blob, signal));
  const recognitionCtor = () => (deps.recognition !== undefined ? deps.recognition : getRecognitionCtor());

  let token = 0;
  let state: VoiceState = "off";
  let heard = "";
  let message: string | null = null;
  let greeting = false;
  let listenLevel = 0;

  let mic: MicHandle | null = null;
  let recording: { finish(): void; cancel(): void } | null = null;
  let transcribing: AbortController | null = null;
  let barge: { token: number; watcher: BargeWatcher } | null = null;
  let handover: { pre: PreRollHandover | null; noise: number } | null = null;
  let askToken: number | null = null;

  const listeners = new Set<(s: VoiceSessionState) => void>();

  function getState(): VoiceSessionState {
    return { state, heard, message, greeting, status: assistant.getState().status };
  }

  function emit(): void {
    const s = getState();
    for (const fn of [...listeners]) fn(s);
  }

  function setState(next: VoiceState): void {
    state = next;
    if (next !== "listening") listenLevel = 0;
    emit();
  }

  function stopBarge(owner?: number): void {
    if (!barge || (owner !== undefined && barge.token !== owner)) return;
    const w = barge.watcher;
    barge = null;
    w.stop();
  }

  function dropHandover(): void {
    const h = handover;
    handover = null;
    try {
      if (h?.pre && h.pre.recorder.state !== "inactive") h.pre.recorder.stop();
    } catch {
      // ignore
    }
  }

  /** Releases the mic and every in-flight recording; `token` must already be bumped. */
  function release(): void {
    stopBarge();
    recording?.cancel();
    recording = null;
    transcribing?.abort();
    transcribing = null;
    dropHandover();
    mic?.close();
    mic = null;
    greeting = false;
    listenLevel = 0;
  }

  function goOff(my: number, msg: string | null): void {
    if (my !== token) return;
    token++;
    release();
    message = msg;
    setState("off");
  }

  function fail(my: number, err: unknown): void {
    goOff(my, errorMessage(err));
  }

  async function ensureMic(my: number): Promise<boolean> {
    if (mic) return true;
    const m = await openMicFn();
    if (my !== token) {
      m.close(); // a stale open never replaces the live handle (§18)
      return false;
    }
    mic = m;
    return true;
  }

  /** Listen → transcript. Returns null when the turn went stale or the session went off. */
  async function hear(my: number): Promise<string | null> {
    setState("listening");
    if (!hasVoiceKey(getSettings())) {
      const Ctor = recognitionCtor();
      if (!Ctor) throw new Error(SESSION_TEXT.needsKey);
      const h = recognizeOnce(Ctor, language());
      recording = h;
      const text = await h.promise;
      if (my !== token) return null;
      recording = null;
      if (!text) {
        goOff(my, SESSION_TEXT.didntCatch);
        return null;
      }
      return text;
    }

    if (!(await ensureMic(my))) return null;
    if (my !== token || !mic) return null;
    const ho = handover;
    handover = null;
    const h = record(mic, {
      ...(ho ? { alreadySpeaking: true, noiseFloor: ho.noise } : {}),
      ...(ho?.pre ? { recorder: ho.pre.recorder, chunks: ho.pre.chunks } : {}),
      onLevel: (l) => {
        if (my === token) listenLevel = l;
      },
    });
    if (my !== token) {
      h.cancel(); // check the token before storing a new recording handle (§18)
      return null;
    }
    recording = h;
    const { blob } = await h.promise;
    if (my !== token) return null;
    recording = null;
    if (!blob) {
      goOff(my, null); // shown as "Paused"
      return null;
    }

    setState("transcribing");
    const ctl = new AbortController();
    transcribing = ctl;
    const text = (await transcribe(blob, ctl.signal)).trim();
    if (my !== token) return null;
    transcribing = null;
    if (!text) {
      goOff(my, SESSION_TEXT.didntCatch);
      return null;
    }
    return text;
  }

  /**
   * Sends one voice turn (§5.6 step 2). Stops a typed reply still streaming,
   * takes a camera frame on a look phrase, streams the reply into the speaker,
   * always flushes it, resolves when the reply has finished streaming and never rejects.
   */
  async function ask(text: string, my: number = token): Promise<void> {
    const unsubs: (() => void)[] = [];
    askToken = my;
    try {
      if (assistant.getState().busy) assistant.stop();
      speaker.stop();
      let attachment: { data: string } | undefined;
      if (getSettings().lookOnRequest && deps.captureFrame && LOOK_PHRASE.test(text)) {
        try {
          const data = await deps.captureFrame();
          if (data) attachment = { data };
        } catch (err) {
          notify(errorMessage(err));
        }
        if (my !== token) return;
      }
      unsubs.push(assistant.on("onTextDelta", (d) => {
        if (my === token) speaker.feed(d);
      }));
      unsubs.push(assistant.on("onTextReset", () => {
        // A declined fallback reply is hidden from voice too: drop what's queued.
        if (my === token) speaker.stop();
      }));
      await assistant.send(attachment ? { text, attachment } : { text });
    } catch {
      // ask() never rejects; the assistant shows its own errors.
    } finally {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          // ignore
        }
      }
      if (my === token) speaker.flush();
      if (askToken === my) askToken = null;
    }
  }

  function startBarge(my: number): void {
    if (barge?.token === my || !mic) return;
    const s = getSettings();
    if (!s.bargeIn || !hasVoiceKey(s)) return;
    const watcher = watch(mic, {
      speakerLevel: () => speaker.level(),
      onBarge: (pre, noise) => onBarge(my, pre, noise),
    });
    if (my !== token) {
      watcher.stop();
      return;
    }
    stopBarge();
    barge = { token: my, watcher };
  }

  function onBarge(my: number, pre: PreRollHandover | null, noise: number): void {
    if (my !== token) {
      try {
        if (pre && pre.recorder.state !== "inactive") pre.recorder.stop();
      } catch {
        // ignore
      }
      return;
    }
    if (barge?.token === my) barge = null;
    assistant.stop();
    speaker.stop();
    greeting = false;
    const next = ++token;
    dropHandover();
    handover = { pre, noise };
    void loop(next);
  }

  /** Steps 3–4: speak with the barge-in watcher; wait while the reply streams or she speaks. */
  async function awaitReply(my: number, done: Promise<void> | null): Promise<void> {
    let finished = done === null;
    const never = new Promise<void>(() => undefined);
    const doneSignal = done ? done.then(() => {
      finished = true;
    }) : never;
    try {
      for (;;) {
        if (my !== token) return;
        const speaking = speaker.speaking;
        if (speaking) {
          if (state !== "speaking") setState("speaking");
          startBarge(my);
        } else if (finished) {
          return;
        }
        // Once the reply is done its promise is settled: leave it out, or this would spin on microtasks.
        await Promise.race([sleep(pollMs), finished ? never : doneSignal, speaking ? speaker.whenIdle() : never]);
      }
    } finally {
      stopBarge(my);
    }
  }

  async function loop(my: number): Promise<void> {
    try {
      while (my === token) {
        const text = await hear(my);
        if (text === null || my !== token) return;
        heard = text;
        setState("thinking");
        const done = ask(text, my);
        await awaitReply(my, done);
        if (my !== token) return;
      }
    } catch (err) {
      fail(my, err);
    }
  }

  async function start(): Promise<void> {
    if (state !== "off") return;
    const s = getSettings();
    if (!voiceReady(s, recognitionCtor() !== null)) {
      notify(SESSION_TEXT.needsKey);
      deps.openVoiceSettings?.();
      return;
    }
    const my = ++token;
    message = null;
    heard = "";
    try {
      if (hasVoiceKey(s)) {
        setState("listening");
        if (!(await ensureMic(my))) return;
        const g = deps.takeGreeting?.() ?? null;
        if (my !== token) return;
        if (g && g.text.trim() && now() - g.at < GREETING_MAX_AGE_MS) {
          greeting = true;
          setState("speaking");
          speaker.say(g.text);
          await awaitReply(my, null);
          if (my !== token) return;
          greeting = false;
        }
      }
      await loop(my);
    } catch (err) {
      fail(my, err);
    }
  }

  /** Interrupt whatever is happening and listen. */
  function interrupt(): void {
    stopBarge();
    recording?.cancel();
    recording = null;
    transcribing?.abort();
    transcribing = null;
    dropHandover();
    assistant.stop();
    speaker.stop();
    greeting = false;
    const next = ++token;
    void loop(next);
  }

  /** The orb: listening → send now; speaking/thinking → interrupt and listen; off → start. */
  function tap(): Promise<void> | void {
    switch (state) {
      case "off":
        return start();
      case "listening":
        recording?.finish();
        return;
      default:
        interrupt();
        return;
    }
  }

  /** Ends the session. With keepAnswer, a reply still streaming or being spoken carries on. */
  function stop(opts: { keepAnswer?: boolean } = {}): void {
    const wasAsking = askToken !== null;
    token++;
    release();
    if (!opts.keepAnswer) {
      if (wasAsking) assistant.stop();
      speaker.stop();
    }
    message = null;
    setState("off");
  }

  return {
    start,
    tap,
    stop,
    ask: (text: string) => ask(text, token),
    getState,
    subscribe(fn: (s: VoiceSessionState) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /** Orb/face level: the mic while listening, her voice while speaking. */
    level(): number {
      if (state === "listening") return listenLevel;
      if (state === "speaking") return speaker.level();
      return 0;
    },
    get state(): VoiceState {
      return state;
    },
    get heard(): string {
      return heard;
    },
  };
}

// ---- Composer dictation -------------------------------------------------------------------------------

export type DictationPhase = "idle" | "listening" | "transcribing";

export interface DictationDeps {
  getSettings: () => Settings;
  audioContext: () => AudioContext;
  openMic?: () => Promise<MicHandle>;
  record?: (mic: MicHandle, opts: RecordOptions) => RecordingHandle;
  transcribe?: (blob: Blob, signal: AbortSignal) => Promise<string>;
  fetch?: FetchLike;
  recognition?: RecognitionCtor | null;
  language?: () => string;
  timers?: Timers;
  /** Toast: DICTATION_TEXT.listeningKey / listening, or an error. */
  onToast: (message: string) => void;
  /** Show DICTATION_TEXT.transcribing as the composer placeholder while "transcribing". */
  onPhase?: (phase: DictationPhase) => void;
  /** Append to the draft. */
  onText: (text: string) => void;
  onLevel?: (level: number) => void;
}

/** Known, actionable messages pass through; everything else is "Dictation failed.". */
export function dictationError(err: unknown): string {
  if (err instanceof ElevenError) return err.message;
  if (err instanceof Error && (err.message === MIC_DENIED || err.message === MIC_UNAVAILABLE || err.message === SESSION_TEXT.needsKey)) {
    return err.message;
  }
  return DICTATION_TEXT.failed;
}

export function createDictation(deps: DictationDeps) {
  const openMicFn = deps.openMic ?? (() => defaultOpenMic({ audioContext: deps.audioContext }));
  const record = deps.record ?? ((mic: MicHandle, opts: RecordOptions) => recordUtterance(mic, { ...opts, timers: deps.timers }));
  const transcribe = deps.transcribe ??
    ((blob: Blob, signal: AbortSignal) =>
      createElevenClient({ getKey: () => deps.getSettings().elevenLabsKey, fetch: deps.fetch }).transcribe(blob, signal));
  const recognitionCtor = () => (deps.recognition !== undefined ? deps.recognition : getRecognitionCtor());
  const language = deps.language ?? defaultLanguage;

  let token = 0;
  let phase: DictationPhase = "idle";
  let handle: { finish(): void; cancel(): void } | null = null;
  let controller: AbortController | null = null;
  let mic: MicHandle | null = null;

  function setPhase(p: DictationPhase): void {
    phase = p;
    deps.onPhase?.(p);
  }

  function cleanup(): void {
    handle = null;
    controller = null;
    mic?.close();
    mic = null;
  }

  async function run(my: number): Promise<void> {
    try {
      if (hasVoiceKey(deps.getSettings())) {
        const m = await openMicFn();
        if (my !== token) {
          m.close();
          return;
        }
        mic = m;
        deps.onToast(DICTATION_TEXT.listeningKey);
        setPhase("listening");
        const h = record(m, { onLevel: (l) => my === token && deps.onLevel?.(l) });
        if (my !== token) {
          h.cancel();
          return;
        }
        handle = h;
        const { blob } = await h.promise;
        if (my !== token) return;
        handle = null;
        mic?.close();
        mic = null;
        if (!blob) return;
        setPhase("transcribing");
        const ctl = new AbortController();
        controller = ctl;
        const text = (await transcribe(blob, ctl.signal)).trim();
        if (my !== token) return;
        if (text) deps.onText(text);
        return;
      }
      const Ctor = recognitionCtor();
      if (!Ctor) throw new Error(SESSION_TEXT.needsKey);
      deps.onToast(DICTATION_TEXT.listening);
      setPhase("listening");
      const h = recognizeOnce(Ctor, language());
      handle = h;
      const text = await h.promise;
      if (my !== token) return;
      if (text) deps.onText(text);
    } catch (err) {
      if (my === token) deps.onToast(dictationError(err));
    } finally {
      if (my === token) {
        cleanup();
        setPhase("idle");
      }
    }
  }

  return {
    /** The 🎙 button: starts dictation, or finishes it early while listening. */
    toggle(): Promise<void> {
      if (phase === "listening") {
        handle?.finish();
        return Promise.resolve();
      }
      if (phase === "transcribing") return Promise.resolve();
      return run(++token);
    },
    /** Abandons dictation without inserting anything. */
    cancel(): void {
      token++;
      handle?.cancel();
      controller?.abort();
      cleanup();
      if (phase !== "idle") setPhase("idle");
    },
    get phase(): DictationPhase {
      return phase;
    },
  };
}
