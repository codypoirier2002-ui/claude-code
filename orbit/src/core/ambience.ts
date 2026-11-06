// Soundscapes (§8.9): one 30 s Opus loop per scene at ambience/{id}.ogg, each
// decoded once and cached, played through a looping AudioBufferSourceNode
// (gapless) from a random offset, crossfaded on a scene change. A master gain,
// re-read every 200 ms, follows the volume setting and ducks while she speaks
// or listens. The AudioContext, fetch and the timer are injected so the whole
// thing runs against fakes in the tests.

import type { AmbienceMode } from "./settings";

/** How often the master gain and the play rules are re-read. */
export const AMBIENCE_TICK_MS = 200;
/** The master gain is volume × .6 … */
export const AMBIENCE_BASE = 0.6;
/** … × .35 while she speaks … */
export const DUCK_SPEAKING = 0.35;
/** … × .12 while she listens, so the mic isn't fooled. */
export const DUCK_LISTENING = 0.12;
/** Gain changes smaller than this are not scheduled (§14). */
export const GAIN_EPSILON = 0.005;
/** Crossfade: the old track fades with this time constant … */
export const FADE_OUT_TC = 0.6;
/** … and stops this long after the fade starts. */
export const STOP_AFTER_S = 3.5;
/** The new track fades in with this time constant. */
export const FADE_IN_TC = 0.9;
/** Time constant for master-gain moves (volume and ducking). */
export const MASTER_TC = 0.15;

/** The master gain for a volume (0–1) and her voice state. Listening ducks harder than speaking. */
export function ambienceGain(volume: number, speaking: boolean, listening: boolean): number {
  const v = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
  const duck = listening ? DUCK_LISTENING : speaking ? DUCK_SPEAKING : 1;
  return v * AMBIENCE_BASE * duck;
}

/** Where the app is: the 2D shell, an immersive-vr session (or the desktop preview), or passthrough. */
export type AmbiencePlace = "2d" | "vr" | "ar";

/**
 * Whether a soundscape plays: "vr" only during an immersive-vr session,
 * "always" in the 2D app too, never in passthrough. (The 2D app's first-tap
 * rule is the AudioContext itself: it exists only after a tap.)
 */
export function ambienceAllowed(mode: AmbienceMode, place: AmbiencePlace): boolean {
  if (place === "ar" || mode === "off") return false;
  if (mode === "vr") return place === "vr";
  return true;
}

export interface AmbienceInput {
  sceneId: string;
  mode: AmbienceMode;
  volume: number;
  place: AmbiencePlace;
  /** Her voice is playing. */
  speaking: boolean;
  /** The mic is open. */
  listening: boolean;
}

/** The parts of an AudioContext the soundscape uses. */
export type AmbienceAudioContext = Pick<AudioContext, "currentTime" | "destination" | "createGain" | "createBufferSource" | "decodeAudioData">;

export interface AmbienceDeps {
  /** The app's AudioContext if one exists (it is created inside a tap); null means stay quiet. */
  context(): AmbienceAudioContext | null;
  /** The current settings, place and voice state, read every tick. */
  read(): AmbienceInput;
  /** The URL of a scene's loop. */
  url(sceneId: string): string;
  /** Fetch a file's bytes; rejects on a network or HTTP error. */
  fetchBytes(url: string): Promise<ArrayBuffer>;
  /** Run fn every ms milliseconds; returns a cancel function. */
  every(ms: number, fn: () => void): () => void;
  /** 0–1, for the start offset. */
  random?(): number;
}

interface Track {
  id: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export interface Ambience {
  /** Start the 200 ms loop. */
  start(): void;
  /** One pass of the loop (the timer calls this). */
  tick(): void;
  /** The scene whose loop is playing or loading, or null when quiet. */
  playing(): string | null;
  /** Fade out and stop the loop. */
  stop(): void;
}

export function createAmbience(deps: AmbienceDeps): Ambience {
  const random = deps.random ?? Math.random;
  const buffers = new Map<string, Promise<AudioBuffer>>();
  let master: GainNode | null = null;
  let masterCtx: AmbienceAudioContext | null = null;
  let scheduled = 0;
  let wanted: string | null = null;
  let track: Track | null = null;
  let cancel: (() => void) | null = null;

  /** Decoded once per scene; a failed file stays failed (no retry every 200 ms). */
  function buffer(ctx: AmbienceAudioContext, id: string): Promise<AudioBuffer> {
    let p = buffers.get(id);
    if (!p) {
      p = deps.fetchBytes(deps.url(id)).then((bytes) => ctx.decodeAudioData(bytes));
      p.catch(() => {});
      buffers.set(id, p);
    }
    return p;
  }

  function fadeOut(ctx: AmbienceAudioContext, t: Track): void {
    const now = ctx.currentTime;
    t.gain.gain.setTargetAtTime(0, now, FADE_OUT_TC);
    try {
      t.source.stop(now + STOP_AFTER_S);
    } catch {
      // Already stopped.
    }
  }

  async function begin(ctx: AmbienceAudioContext, out: GainNode, id: string): Promise<void> {
    let buf: AudioBuffer;
    try {
      buf = await buffer(ctx, id);
    } catch {
      return; // A missing loop just means silence for that scene.
    }
    if (wanted !== id || track) return;
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(out);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
    const now = ctx.currentTime;
    gain.gain.setTargetAtTime(1, now, FADE_IN_TC);
    source.start(now, random() * buf.duration);
    track = { id, source, gain };
  }

  function switchTo(ctx: AmbienceAudioContext, out: GainNode, id: string | null): void {
    wanted = id;
    if (track) fadeOut(ctx, track);
    track = null;
    if (id) void begin(ctx, out, id);
  }

  function tick(): void {
    const ctx = deps.context();
    if (!ctx) return;
    if (!master || masterCtx !== ctx) {
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
      masterCtx = ctx;
      scheduled = 0;
    }
    const s = deps.read();
    const id = ambienceAllowed(s.mode, s.place) ? s.sceneId : null;
    if (id !== wanted) switchTo(ctx, master, id);
    const g = ambienceGain(s.volume, s.speaking, s.listening);
    if (Math.abs(g - scheduled) > GAIN_EPSILON) {
      master.gain.setTargetAtTime(g, ctx.currentTime, MASTER_TC);
      scheduled = g;
    }
  }

  return {
    start(): void {
      if (cancel) return;
      cancel = deps.every(AMBIENCE_TICK_MS, tick);
      tick();
    },
    tick,
    playing: () => wanted,
    stop(): void {
      cancel?.();
      cancel = null;
      if (masterCtx && master) switchTo(masterCtx, master, null);
    },
  };
}
