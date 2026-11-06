// One app-wide AudioContext (§5.2). Browsers only let it start inside a user
// gesture, so call audioContext() from a tap handler (Talk, dictation, Enter
// VR, the orb) to create or resume it. The voice shell (ui/voiceShell.ts) uses it too.

type AudioContextCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function ctor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** The shared context, created on first use and resumed if suspended. Null without Web Audio. */
export function audioContext(): AudioContext | null {
  if (!ctx) {
    const C = ctor();
    if (!C) return null;
    try {
      ctx = new C();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

/** The context if one already exists; never creates one. */
export function existingAudioContext(): AudioContext | null {
  return ctx;
}

/** The two chime tones (§4.3): frequency in Hz and start offset in seconds. */
export const CHIME_TONES: readonly { freq: number; at: number }[] = [
  { freq: 880, at: 0 },
  { freq: 1320, at: 0.18 },
];

/**
 * The timer chime (§4.3): a sine at 880 Hz, then 1320 Hz 0.18 s later. Each
 * tone's gain goes 0.0001 → 0.25 in 20 ms, then back to 0.0001 by 0.6 s.
 */
export function playChime(context: AudioContext | null = audioContext()): void {
  if (!context) return;
  try {
    const t0 = context.currentTime + 0.02;
    for (const tone of CHIME_TONES) {
      const start = t0 + tone.at;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(tone.freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
      osc.connect(gain).connect(context.destination);
      osc.start(start);
      osc.stop(start + 0.62);
    }
  } catch {
    // Audio is a nicety; a broken context must never break the clock.
  }
}
