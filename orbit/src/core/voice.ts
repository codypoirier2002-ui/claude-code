// Voice output and input (§5.2, §5.4, §5.5): the sentence splitter, the
// speaker with its fallbacks, the mic, the recorder with end-of-speech
// detection, barge-in and the pre-roll recorder. Every browser dependency is
// injected; the AudioContext factory is always supplied by the caller (it must
// be created or resumed inside a user tap).

import {
  ElevenError,
  LAURA_VOICE_ID,
  PREVIOUS_TEXT_CHARS,
  createElevenClient,
  type ElevenClient,
  type FetchLike,
} from "./eleven";
import { DEMO_BUILD, DEMO_SPEECH_MAX_CHARS, splitSpeech } from "./demo";
import { hasVoiceKey, type Settings } from "./settings";
import { stripAudioTags } from "./tags";

// ---- Product copy ------------------------------------------------------------

export const EXPRESSIVE_FALLBACK_NOTICE =
  "Expressive voice isn't available on this ElevenLabs account, so Orbit is using the fast voice.";
export const LAURA_NOTICE =
  "Her chosen voice isn't available to your ElevenLabs account from apps (free plans only get the built-in voices), so she's using Laura, a free voice, for now. On a paid plan, add the voice under Voices on elevenlabs.io, or pick another voice in Settings.";
export const MIC_UNAVAILABLE = "This browser can't use the microphone.";
export const MIC_DENIED = "Microphone permission was denied. Allow it in the browser's site settings.";

// ---- Tuned values --------------------------------------------------------------

export const SYNTH_RATE = 1.05;
export const SPEAKER_FFT = 1024;
export const SPEAKER_LEVEL_GAIN = 5;
export const LISTEN_LEVEL_GAIN = 6;
export const RECORDER_TIMESLICE_MS = 250;
export const EOS_TICK_MS = 50;
export const EOS_LEARN_MS = 300;
export const BARGE_TICK_MS = 40;
export const PREROLL_SEGMENT_MS = 1500;
export const RECORDER_TYPES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

// ---- Text ----------------------------------------------------------------------

const CLOSED_FENCE = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n(?:[\s\S]*?\n)?[ \t]{0,3}\2[ \t]*(?=\n|$)/g;
const OPEN_FENCE_TAIL = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[\s\S]*$/;
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/gm;

/**
 * Text as it should be heard (§5.2): tags stripped unless kept, closed code
 * fences replaced with " (code omitted) ", markdown emphasis, backticks and
 * line-start bullets removed, links reduced to their label, whitespace collapsed.
 */
export function speakable(text: string, keepTags = false): string {
  let t = keepTags ? text : stripAudioTags(text);
  t = t.replace(CLOSED_FENCE, "$1 (code omitted) ");
  // A fence that never closed (a reply cut off mid-code) is not read aloud either.
  t = t.replace(OPEN_FENCE_TAIL, "$1 (code omitted) ");
  t = t.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1");
  t = t.replace(/^[ \t]*(?:[-*+•])[ \t]+/gm, "");
  t = t.replace(/\*\*|__|`/g, "");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * True when a chunk has words to say: a letter or digit outside square
 * brackets. ElevenLabs drops every [tag], listed or not, and every emoji, and
 * refuses an expressive chunk with nothing left (400 input_text_empty). That is
 * what a tag after her last sentence becomes: "You've got this! [giggles]" is
 * cut after "this!", leaving "[giggles]" alone.
 */
export function hasSpokenText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replace(/\[[^\]]*\]/g, ""));
}

function insideOpenFence(head: string): boolean {
  let n = 0;
  FENCE_LINE.lastIndex = 0;
  while (FENCE_LINE.exec(head)) n++;
  return n % 2 === 1;
}

/**
 * Cuts streamed text into speakable chunks of at least `minChars`, at sentence
 * ends outside code fences. A finite `maxChars` (demo builds, §21) also splits
 * any chunk longer than that.
 */
export class SentenceSplitter {
  private buffer = "";

  constructor(
    readonly minChars = 60,
    readonly maxChars = Infinity,
  ) {}

  /** Adds text and returns the chunks that are ready (already passed through speakable(…, true)). */
  feed(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const chunk = speakable(this.buffer.slice(0, cut), true);
      this.buffer = this.buffer.slice(cut);
      if (chunk) out.push(...this.limit(chunk));
    }
    return out;
  }

  /** Emits whatever is left. */
  flush(): string[] {
    const chunk = speakable(this.buffer, true);
    this.buffer = "";
    return chunk ? this.limit(chunk) : [];
  }

  private limit(chunk: string): string[] {
    return Number.isFinite(this.maxChars) ? splitSpeech(chunk, this.maxChars) : [chunk];
  }

  clear(): void {
    this.buffer = "";
  }

  get pending(): string {
    return this.buffer;
  }

  private findCut(): number {
    const re = /[.!?](?=\s)|\n\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buffer))) {
      const end = m.index + m[0].length;
      if (end < this.minChars) continue;
      if (insideOpenFence(this.buffer.slice(0, end))) continue;
      return end;
    }
    return -1;
  }
}

// ---- Audio helpers ------------------------------------------------------------

export function rmsOf(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function analyserRms(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  return rmsOf(buf);
}

export const listeningLevel = (rms: number): number => Math.min(1, rms * LISTEN_LEVEL_GAIN);

// ---- Speaker --------------------------------------------------------------------

export type SpeakerSettings = Pick<Settings, "elevenLabsKey" | "voiceId" | "voiceSpeed" | "expressiveVoice">;

export interface SpeakerDeps {
  /** The one app-wide AudioContext (created or resumed inside a user tap). */
  audioContext: () => AudioContext;
  getSettings: () => SpeakerSettings;
  /** Defaults to an ElevenLabs client using getSettings().elevenLabsKey and `fetch`. */
  eleven?: ElevenClient;
  fetch?: FetchLike;
  /** Defaults to globalThis.speechSynthesis (null to disable). */
  speechSynthesis?: SpeechSynthesis | null;
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  /** One-time notices (the expressive and Laura fallbacks). Show as a toast. */
  notify?: (message: string) => void;
  /** A speech request failed with no fallback left; the rest of the queue is dropped. */
  onError?: (message: string, error: unknown) => void;
  /** Fires when `speaking` flips. */
  onSpeakingChange?: (speaking: boolean) => void;
}

export interface Speaker {
  feed(delta: string): void;
  flush(): void;
  announce(text: string): void;
  say(text: string): void;
  stop(): void;
  readonly speaking: boolean;
  whenIdle(): Promise<void>;
  level(): number;
}

interface Chunk {
  gen: number;
  audio: Promise<AudioBuffer | null>;
  controller: AbortController;
}

function isAbort(err: unknown): boolean {
  return (err instanceof Error || (typeof err === "object" && err !== null)) &&
    (err as { name?: string }).name === "AbortError";
}

const isElevenStatus = (err: unknown, ...codes: number[]): boolean =>
  err instanceof ElevenError && codes.includes(err.status);

/**
 * A 400 or 422 says the expressive model is out of reach only in so many
 * words: the model isn't found or available ("model_not_found", "A model with
 * model ID … does not exist"), or a permission is missing. Any other 400 or 422
 * is about the request (a chunk with no words gets "input_text_empty").
 * Matched with underscores read as spaces.
 */
const MODEL_UNAVAILABLE =
  /\bmodel\b.{0,80}?\b(?:does ?n[o']t exist|not found|not (?:available|allowed|supported|enabled)|unavailable|unsupported|no access|access denied)\b|\bpermission/i;

/** The account or key can't use the expressive model, so the fast voice takes over for the session. */
function expressiveUnavailable(err: ElevenError): boolean {
  if (err.kind === "missing_permission") return true;
  // Decided by kind too (§18): quota, bad keys and rate limits are not "unavailable".
  if (err.kind !== "other") return false;
  if (isElevenStatus(err, 403, 404)) return true;
  const said = `${err.detailStatus ?? ""} ${err.detail}`.replace(/_/g, " ");
  return isElevenStatus(err, 400, 422) && MODEL_UNAVAILABLE.test(said);
}

export function createSpeaker(deps: SpeakerDeps): Speaker {
  const eleven = deps.eleven ?? createElevenClient({ getKey: () => deps.getSettings().elevenLabsKey, fetch: deps.fetch });
  const synth = deps.speechSynthesis !== undefined
    ? deps.speechSynthesis
    : typeof globalThis.speechSynthesis !== "undefined" ? globalThis.speechSynthesis : null;
  const makeUtterance = deps.createUtterance ?? ((text: string) => new SpeechSynthesisUtterance(text));

  // The demo server refuses speech over 1,200 characters, so demo builds split below that.
  const splitter = new SentenceSplitter(60, DEMO_BUILD ? DEMO_SPEECH_MAX_CHARS : Infinity);
  let generation = 0;
  let queue: Chunk[] = [];
  let pumpGen = -1;
  let previousPlain = "";
  let synthPending = 0;

  let source: AudioBufferSourceNode | null = null;
  let endPlayback: (() => void) | null = null;
  let analyser: AnalyserNode | null = null;
  let analyserCtx: AudioContext | null = null;
  let levelBuf: Float32Array<ArrayBuffer> | null = null;

  // Session-wide fallback state (§5.2).
  let sendPreviousText = true;
  let expressiveDisabled = false;
  let expressiveNoticeShown = false;
  /** The chosen voice id that failed; Laura stands in while the setting still names it. */
  let lauraFor: string | null = null;

  let idleWaiters: (() => void)[] = [];
  let lastSpeaking = false;

  const speakingNow = () => queue.length > 0 || source !== null || synthPending > 0;

  function settle(): void {
    const now = speakingNow();
    if (now !== lastSpeaking) {
      lastSpeaking = now;
      deps.onSpeakingChange?.(now);
    }
    if (!now) releaseWaiters();
  }

  function releaseWaiters(): void {
    const ws = idleWaiters;
    idleWaiters = [];
    for (const w of ws) w();
  }

  function notify(message: string): void {
    deps.notify?.(message);
  }

  function ensureAnalyser(ctx: AudioContext): AnalyserNode {
    if (!analyser || analyserCtx !== ctx) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = SPEAKER_FFT;
      analyser.connect(ctx.destination);
      analyserCtx = ctx;
      levelBuf = new Float32Array(analyser.fftSize);
    }
    return analyser;
  }

  function currentVoice(): string {
    const chosen = deps.getSettings().voiceId;
    if (lauraFor !== null && chosen !== lauraFor) lauraFor = null; // picking another voice ends the fallback
    return lauraFor !== null ? LAURA_VOICE_ID : chosen;
  }

  /** The voice that just failed isn't available: stand in with Laura (notice once per fallback). */
  function useLaura(failedVoice: string): boolean {
    if (failedVoice === LAURA_VOICE_ID) return false;
    const chosen = deps.getSettings().voiceId;
    if (lauraFor !== chosen) {
      lauraFor = chosen;
      notify(LAURA_NOTICE);
    }
    return true;
  }

  async function fast(text: string, signal: AbortSignal): Promise<ArrayBuffer> {
    const voiceId = currentVoice();
    try {
      return await eleven.synthesizeFast(text, voiceId, deps.getSettings().voiceSpeed, signal);
    } catch (err) {
      if (err instanceof ElevenError && err.kind === "voice_unavailable" && useLaura(voiceId)) {
        return eleven.synthesizeFast(text, LAURA_VOICE_ID, deps.getSettings().voiceSpeed, signal);
      }
      throw err;
    }
  }

  /** `withPrevious` is false for the one retry without previous_text. */
  async function expressive(text: string, previous: string, signal: AbortSignal, withPrevious = true): Promise<ArrayBuffer> {
    const voiceId = currentVoice();
    const prev = withPrevious && sendPreviousText && previous ? previous : undefined;
    let data: ArrayBuffer;
    try {
      data = await eleven.synthesizeExpressive(text, voiceId, prev, signal);
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw err;
      // Network errors (fetch rejects with a TypeError): this chunk only.
      if (!(err instanceof ElevenError)) return fast(text, signal);
      if (err.kind === "voice_unavailable") {
        if (useLaura(voiceId)) return expressive(text, previous, signal, withPrevious);
        throw err;
      }
      // The account can't use the expressive model: fast voice for the rest of the session.
      if (expressiveUnavailable(err)) {
        expressiveDisabled = true;
        if (!expressiveNoticeShown) {
          expressiveNoticeShown = true;
          notify(EXPRESSIVE_FALLBACK_NOTICE);
        }
        return fast(text, signal);
      }
      if (err.kind === "other" && isElevenStatus(err, 400, 422)) {
        // ElevenLabs refused this request, not the account. It carried previous_text: retry once without.
        if (prev !== undefined) return expressive(text, previous, signal, false);
        // Something about this chunk: just this chunk goes to the fast voice, and expressive stays on.
        return fast(text, signal);
      }
      // Server trouble: just this chunk goes to the fast voice.
      if (err.status >= 500 && err.kind === "other") return fast(text, signal);
      throw err;
    }
    // The retry without previous_text worked, so previous_text was the trouble: stop sending it.
    if (!withPrevious) sendPreviousText = false;
    return data;
  }

  async function synthesize(text: string, previous: string, gen: number, signal: AbortSignal): Promise<AudioBuffer | null> {
    const s = deps.getSettings();
    const data = s.expressiveVoice && !expressiveDisabled
      ? await expressive(text, previous, signal)
      : await fast(text, signal);
    if (gen !== generation) return null;
    const ctx = deps.audioContext();
    const buffer = await ctx.decodeAudioData(data);
    if (gen !== generation) return null;
    return buffer;
  }

  function play(buffer: AudioBuffer): Promise<void> {
    const ctx = deps.audioContext();
    const node = ensureAnalyser(ctx);
    return new Promise<void>((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(node);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (source === src) source = null;
        if (endPlayback === finish) endPlayback = null;
        try {
          src.disconnect();
        } catch {
          // already disconnected
        }
        resolve();
      };
      src.onended = finish;
      source = src;
      endPlayback = finish;
      src.start();
    });
  }

  async function pump(gen: number): Promise<void> {
    if (pumpGen === gen) return;
    pumpGen = gen;
    try {
      while (gen === generation && queue.length > 0) {
        const chunk = queue[0];
        let buffer: AudioBuffer | null = null;
        let failure: unknown = null;
        try {
          buffer = await chunk.audio;
        } catch (err) {
          failure = err;
        }
        if (gen !== generation) return; // an old loop never touches a new reply's queue
        queue.shift();
        if (failure !== null && !isAbort(failure)) {
          const message = failure instanceof Error && failure.message ? failure.message : "Speech failed.";
          stop();
          deps.onError?.(message, failure);
          return;
        }
        if (buffer) {
          await play(buffer);
          if (gen !== generation) return;
        }
      }
    } finally {
      if (pumpGen === gen) pumpGen = -1;
      if (gen === generation) settle();
    }
  }

  function speakWithSynth(chunk: string): void {
    const text = stripAudioTags(chunk).trim();
    if (!synth || !text) return;
    const gen = generation;
    const u = makeUtterance(text);
    u.rate = SYNTH_RATE;
    synthPending++;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      if (gen !== generation) return;
      synthPending = Math.max(0, synthPending - 1);
      settle();
    };
    u.onend = end;
    u.onerror = end;
    synth.speak(u);
    settle();
  }

  function enqueue(chunk: string): void {
    // Nothing to say (a lone tag or emoji): ElevenLabs would refuse it, and no voice has words to read.
    if (!hasSpokenText(chunk)) return;
    if (!hasVoiceKey(deps.getSettings())) {
      speakWithSynth(chunk);
      return;
    }
    const gen = generation;
    const controller = new AbortController();
    const previous = previousPlain;
    previousPlain = stripAudioTags(chunk).slice(-PREVIOUS_TEXT_CHARS);
    const audio = synthesize(chunk, previous, gen, controller.signal);
    audio.catch(() => undefined); // handled in pump; avoid unhandled-rejection noise for dropped chunks
    queue.push({ gen, audio, controller });
    settle();
    void pump(gen);
  }

  function stop(): void {
    generation++;
    for (const c of queue) c.controller.abort();
    queue = [];
    splitter.clear();
    previousPlain = "";
    const src = source;
    const end = endPlayback;
    source = null;
    endPlayback = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // never started or already stopped
      }
    }
    end?.();
    synth?.cancel();
    synthPending = 0;
    settle();
    releaseWaiters();
  }

  return {
    feed(delta: string) {
      for (const c of splitter.feed(delta)) enqueue(c);
    },
    flush() {
      for (const c of splitter.flush()) enqueue(c);
    },
    announce(text: string) {
      enqueue(speakable(text, true));
    },
    say(text: string) {
      stop();
      for (const c of splitter.feed(text)) enqueue(c);
      for (const c of splitter.flush()) enqueue(c);
    },
    stop,
    get speaking() {
      return speakingNow();
    },
    whenIdle() {
      if (!speakingNow()) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    level() {
      if (!source || !analyser || !levelBuf) return 0;
      return Math.min(1, analyserRms(analyser, levelBuf) * SPEAKER_LEVEL_GAIN);
    },
  };
}

// ---- Microphone -------------------------------------------------------------------

export interface MicHandle {
  stream: MediaStream;
  /** RMS of the latest analyser window (fftSize 1024). */
  rms(): number;
  close(): void;
}

export interface MicDeps {
  audioContext: () => AudioContext;
  /** Defaults to navigator.mediaDevices. */
  mediaDevices?: Pick<MediaDevices, "getUserMedia"> | null;
}

export const MIC_CONSTRAINTS: MediaStreamConstraints = Object.freeze({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
}) as MediaStreamConstraints;

function defaultMediaDevices(): Pick<MediaDevices, "getUserMedia"> | null {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return nav?.mediaDevices && typeof nav.mediaDevices.getUserMedia === "function" ? nav.mediaDevices : null;
}

/** Opens the mic with echo cancellation, noise suppression and AGC, plus one analyser for levels. */
export async function openMic(deps: MicDeps): Promise<MicHandle> {
  const devices = deps.mediaDevices !== undefined ? deps.mediaDevices : defaultMediaDevices();
  if (!devices || typeof devices.getUserMedia !== "function") throw new Error(MIC_UNAVAILABLE);
  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia(MIC_CONSTRAINTS);
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? "";
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
      throw new Error(MIC_DENIED);
    }
    throw err;
  }
  const ctx = deps.audioContext();
  const node = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = SPEAKER_FFT;
  node.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let closed = false;
  return {
    stream,
    rms: () => (closed ? 0 : analyserRms(analyser, buf)),
    close() {
      if (closed) return;
      closed = true;
      try {
        node.disconnect();
      } catch {
        // ignore
      }
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

/** The first supported recorder type, or "" to let the browser choose. */
export function pickRecorderType(isTypeSupported?: (type: string) => boolean): string {
  const check = isTypeSupported ??
    (typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function"
      ? (t: string) => MediaRecorder.isTypeSupported(t)
      : () => false);
  return RECORDER_TYPES.find((t) => {
    try {
      return check(t);
    } catch {
      return false;
    }
  }) ?? "";
}

/** The slice of MediaRecorder this module uses. */
export interface RecorderLike {
  readonly state: string;
  readonly mimeType: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export type RecorderFactory = (stream: MediaStream, mimeType: string) => RecorderLike;

export const defaultRecorderFactory: RecorderFactory = (stream, mimeType) =>
  new MediaRecorder(stream, mimeType ? { mimeType } : undefined) as unknown as RecorderLike;

// ---- End-of-speech detection ------------------------------------------------------------

export interface EndOfSpeechOptions {
  silenceMs: number;
  noSpeechMs: number;
  maxMs: number;
  minLevel: number;
}

export const END_OF_SPEECH_DEFAULTS: Readonly<EndOfSpeechOptions> = Object.freeze({
  silenceMs: 1300,
  noSpeechMs: 9000,
  maxMs: 30000,
  minLevel: 0.02,
});

export type EndReason = "max" | "no-speech" | "speech-ended";

/**
 * Pure end-of-speech detector (§5.4). Feed it the mic RMS every 50 ms with the
 * elapsed time. It learns the noise over the first 300 ms; the threshold is
 * max(minLevel, min(noise × 3, 0.08)).
 */
export class EndOfSpeechDetector {
  readonly opts: EndOfSpeechOptions;
  private noiseSum = 0;
  private noiseN = 0;
  private thresholdValue: number | null = null;
  private heard = false;
  private lastSpeech = 0;

  constructor(opts: Partial<EndOfSpeechOptions> = {}, init: { alreadySpeaking?: boolean; noiseFloor?: number } = {}) {
    this.opts = { ...END_OF_SPEECH_DEFAULTS, ...opts };
    if (init.alreadySpeaking) {
      // Handed over mid-utterance from barge-in: the user is talking, so the noise can't be learned now.
      this.heard = true;
      this.lastSpeech = 0;
      this.thresholdValue = this.thresholdFor(init.noiseFloor ?? 0);
    }
  }

  private thresholdFor(noise: number): number {
    return Math.max(this.opts.minLevel, Math.min(noise * 3, 0.08));
  }

  get threshold(): number | null {
    return this.thresholdValue;
  }

  get speechHeard(): boolean {
    return this.heard;
  }

  /** Returns a result once the turn is over, else null. `t` is ms since recording started. */
  push(rms: number, t: number): EndReason | null {
    if (this.thresholdValue === null) {
      if (t < EOS_LEARN_MS) {
        this.noiseSum += rms;
        this.noiseN++;
        return t >= this.opts.maxMs ? "max" : null;
      }
      this.thresholdValue = this.thresholdFor(this.noiseN ? this.noiseSum / this.noiseN : 0);
    }
    if (rms > this.thresholdValue) {
      this.heard = true;
      this.lastSpeech = t;
    }
    if (this.heard && t - this.lastSpeech >= this.opts.silenceMs) return "speech-ended";
    if (!this.heard && t >= this.opts.noSpeechMs) return "no-speech";
    if (t >= this.opts.maxMs) return "max";
    return null;
  }
}

export type RecordReason = EndReason | "manual" | "cancelled";

export interface RecordingResult {
  blob: Blob | null;
  reason: RecordReason;
}

export interface RecordingHandle {
  promise: Promise<RecordingResult>;
  /** Stop now and keep the audio (tap to send). */
  finish(): void;
  /** Stop now and discard. */
  cancel(): void;
}

export interface Timers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  now: () => number;
}

export const defaultTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

export interface RecordOptions {
  settings?: Partial<EndOfSpeechOptions>;
  /** Handed over from barge-in: the user is already talking. */
  alreadySpeaking?: boolean;
  /** Noise level learned elsewhere (barge-in), used when alreadySpeaking. */
  noiseFloor?: number;
  /** A recorder that is already running (pre-roll handover), with its chunks so far. */
  recorder?: RecorderLike;
  chunks?: Blob[];
  createRecorder?: RecorderFactory;
  mimeType?: string;
  timers?: Timers;
  /** The listening level, min(1, RMS × 6), every tick. */
  onLevel?: (level: number) => void;
}

/** Records one utterance with end-of-speech detection; resolves {blob | null, reason}. */
export function recordUtterance(mic: Pick<MicHandle, "stream" | "rms">, opts: RecordOptions = {}): RecordingHandle {
  const timers = opts.timers ?? defaultTimers;
  const mimeType = opts.mimeType ?? pickRecorderType();
  const chunks: Blob[] = opts.chunks ?? [];
  let recorder: RecorderLike;
  try {
    recorder = opts.recorder ?? (opts.createRecorder ?? defaultRecorderFactory)(mic.stream, mimeType);
  } catch (err) {
    return { promise: Promise.reject(err), finish: () => undefined, cancel: () => undefined };
  }
  const detector = new EndOfSpeechDetector(opts.settings, { alreadySpeaking: opts.alreadySpeaking, noiseFloor: opts.noiseFloor });
  const start = timers.now();
  let interval: unknown = null;
  let ended = false;
  let resolveFn!: (r: RecordingResult) => void;
  const promise = new Promise<RecordingResult>((resolve) => (resolveFn = resolve));

  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  function end(reason: RecordReason): void {
    if (ended) return;
    ended = true;
    if (interval !== null) timers.clearInterval(interval);
    interval = null;
    opts.onLevel?.(0);
    const keep = reason === "max" || reason === "speech-ended" || reason === "manual";
    const done = () => {
      recorder.onstop = null;
      const type = recorder.mimeType || mimeType || chunks[0]?.type || "audio/webm";
      resolveFn({ blob: keep && chunks.length ? new Blob(chunks, { type }) : null, reason });
    };
    if (recorder.state === "inactive") {
      done();
      return;
    }
    recorder.onstop = done;
    try {
      recorder.stop();
    } catch {
      done();
    }
  }

  if (recorder.state === "inactive") recorder.start(RECORDER_TIMESLICE_MS);
  interval = timers.setInterval(() => {
    const rms = mic.rms();
    opts.onLevel?.(listeningLevel(rms));
    const result = detector.push(rms, timers.now() - start);
    if (result) end(result);
  }, EOS_TICK_MS);

  return { promise, finish: () => end("manual"), cancel: () => end("cancelled") };
}

// ---- Barge-in ---------------------------------------------------------------------------------

export interface BargeOptions {
  minLevel: number;
  leak: number;
  holdMs: number;
  learnMs: number;
}

export const BARGE_DEFAULTS: Readonly<BargeOptions> = Object.freeze({ minLevel: 0.045, leak: 0.35, holdMs: 280, learnMs: 250 });

/**
 * Pure barge-in detector (§5.5), fed every 40 ms with the mic RMS and her
 * speaker level (0–1). bar = max(minLevel, min(noise × 2.5, 0.1)) + herLevel × leak,
 * herLevel = speakerLevel / 5. Triggers after holdMs continuously above the bar.
 */
export class BargeDetector {
  readonly opts: BargeOptions;
  private noiseSum = 0;
  private noiseN = 0;
  private noiseValue: number | null = null;
  private aboveSince: number | null = null;
  private fired = false;

  constructor(opts: Partial<BargeOptions> = {}) {
    this.opts = { ...BARGE_DEFAULTS, ...opts };
  }

  get noise(): number {
    return this.noiseValue ?? (this.noiseN ? this.noiseSum / this.noiseN : 0);
  }

  /** True while the mic is above the bar (someone may be starting to talk). */
  get above(): boolean {
    return this.aboveSince !== null;
  }

  bar(speakerLevel: number): number {
    const herLevel = speakerLevel / SPEAKER_LEVEL_GAIN;
    return Math.max(this.opts.minLevel, Math.min(this.noise * 2.5, 0.1)) + herLevel * this.opts.leak;
  }

  /** `t` is ms since the watcher started. Returns true once, when the user cuts in. */
  push(micRms: number, speakerLevel: number, t: number): boolean {
    if (this.fired) return false;
    if (this.noiseValue === null) {
      if (t < this.opts.learnMs) {
        this.noiseSum += micRms;
        this.noiseN++;
        return false;
      }
      this.noiseValue = this.noiseN ? this.noiseSum / this.noiseN : 0;
    }
    if (micRms > this.bar(speakerLevel)) {
      if (this.aboveSince === null) this.aboveSince = t;
      if (t - this.aboveSince >= this.opts.holdMs) {
        this.fired = true;
        return true;
      }
    } else {
      this.aboveSince = null;
    }
    return false;
  }
}

export interface PreRollHandover {
  recorder: RecorderLike;
  chunks: Blob[];
}

/**
 * Rolling pre-roll (§5.5): while it's quiet, a fresh recorder segment starts
 * every 1.5 s (restart, not trim: only a recording's first chunk carries the
 * file header). On a cut-in the live recorder is handed over.
 */
export class PreRollRecorder {
  private recorder: RecorderLike | null = null;
  private chunks: Blob[] = [];
  private segmentStart = 0;
  private stopped = false;

  constructor(
    private readonly stream: MediaStream,
    private readonly createRecorder: RecorderFactory = defaultRecorderFactory,
    private readonly mimeType: string = pickRecorderType(),
    private readonly segmentMs = PREROLL_SEGMENT_MS,
  ) {}

  /** Starts the first segment at time t. */
  start(t: number): void {
    this.stopped = false;
    this.restart(t);
  }

  private restart(t: number): void {
    this.discard();
    const chunks: Blob[] = [];
    const rec = this.createRecorder(this.stream, this.mimeType);
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    rec.start(RECORDER_TIMESLICE_MS);
    this.recorder = rec;
    this.chunks = chunks;
    this.segmentStart = t;
  }

  private discard(): void {
    const old = this.recorder;
    this.recorder = null;
    this.chunks = [];
    if (old) {
      old.ondataavailable = null;
      old.onstop = null;
      try {
        if (old.state !== "inactive") old.stop();
      } catch {
        // ignore
      }
    }
  }

  /** Call every tick; restarts the segment when it's quiet and the segment is 1.5 s old. */
  tick(t: number, quiet: boolean): void {
    if (this.stopped || !this.recorder) return;
    if (quiet && t - this.segmentStart >= this.segmentMs) this.restart(t);
  }

  /** Hands the running recorder and its chunks over; the pre-roll stops owning it. */
  handOver(): PreRollHandover | null {
    if (!this.recorder) return null;
    const out = { recorder: this.recorder, chunks: this.chunks };
    this.recorder = null;
    this.chunks = [];
    this.stopped = true;
    return out;
  }

  stop(): void {
    this.stopped = true;
    this.discard();
  }

  /** For tests: how many segments have been started. */
  get active(): boolean {
    return this.recorder !== null;
  }
}

export interface BargeWatchOptions {
  speakerLevel: () => number;
  /** Called once on a cut-in with the live recorder (null if the pre-roll couldn't start) and the learned noise. */
  onBarge: (handover: PreRollHandover | null, noise: number) => void;
  createRecorder?: RecorderFactory;
  mimeType?: string;
  timers?: Timers;
  detector?: Partial<BargeOptions>;
}

export interface BargeWatcher {
  stop(): void;
}

/** Runs the barge-in detector and the pre-roll every 40 ms while she speaks. */
export function watchBargeIn(mic: Pick<MicHandle, "stream" | "rms">, opts: BargeWatchOptions): BargeWatcher {
  const timers = opts.timers ?? defaultTimers;
  const detector = new BargeDetector(opts.detector);
  const preRoll = new PreRollRecorder(mic.stream, opts.createRecorder ?? defaultRecorderFactory, opts.mimeType ?? pickRecorderType());
  const start = timers.now();
  let stopped = false;
  try {
    preRoll.start(0);
  } catch {
    // No recorder: barge-in still works, the user's first words are just lost.
  }
  const id = timers.setInterval(() => {
    if (stopped) return;
    const t = timers.now() - start;
    const fired = detector.push(mic.rms(), opts.speakerLevel(), t);
    if (fired) {
      stopped = true;
      timers.clearInterval(id);
      opts.onBarge(preRoll.handOver(), detector.noise);
      return;
    }
    try {
      preRoll.tick(t, !detector.above);
    } catch {
      // keep watching even if a segment fails to restart
    }
  }, BARGE_TICK_MS);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(id);
      preRoll.stop();
    },
  };
}
