// Motion math for Callie's face and body (§7.2) and the wave detector (§8.5).
// Everything here is pure or a small state machine whose random source is
// injected, so it is unit-tested without a DOM or a renderer. The numbers are
// tuned values: change them only with a reason.

export type Mood = "idle" | "listening" | "thinking" | "speaking";

/** Returns a number in [0, 1), like Math.random. */
export type RandomSource = () => number;

// ---- Basics ----------------------------------------------------------------

/** Clamps to 0-1. NaN and anything below 0 become 0. */
export function clamp01(x: number): number {
  if (!(x > 0)) return 0;
  return x > 1 ? 1 : x;
}

/** Eases `c` toward `g` at rate `k` per second; independent of the frame rate. */
export function approach(c: number, g: number, dt: number, k: number): number {
  return c + (g - c) * (1 - Math.exp(-k * dt));
}

// ---- Visemes ---------------------------------------------------------------

export interface Visemes {
  aa: number;
  ih: number;
  ou: number;
  ee: number;
  oh: number;
}

/** Below this audio level her mouth stays shut. */
export const VISEME_FLOOR = 0.03;
/** How fast the mouth opens above the floor. */
export const VISEME_GAIN = 2.2;

/**
 * Mouth shapes for an audio level (0-1) at time `t` seconds. The level opens
 * the mouth; two slow oscillators mix the shapes so the lips keep moving.
 */
export function visemesFor(level: number, t: number): Visemes {
  const open = clamp01((level - VISEME_FLOOR) * VISEME_GAIN);
  const a = (Math.sin(7.3 * t) + 1) / 2;
  const b = (Math.sin(4.1 * t + 1.7) + 1) / 2;
  return {
    aa: open * (0.55 + 0.45 * a),
    ih: 0.25 * open * a * (1 - b),
    ou: 0.3 * open * (1 - a) * (1 - b),
    ee: 0.35 * open * (1 - b),
    oh: 0.5 * open * (1 - a) * b,
  };
}

// ---- Blinker ---------------------------------------------------------------

/** One blink lasts this long, in seconds. */
export const BLINK_SECONDS = 0.16;
/** The weight rises over this share of the blink and falls over the rest. */
export const BLINK_RISE = 0.4;
/** The first blink comes after 1-4 s. */
export const FIRST_BLINK_RANGE: readonly [number, number] = [1, 4];
/** After that, one blink every 2-6 s. */
export const NEXT_BLINK_RANGE: readonly [number, number] = [2, 6];
/** The share of blinks that get a double. */
export const DOUBLE_BLINK_CHANCE = 0.15;
/** A double's second blink starts this long after the first one ends, in seconds. */
export const DOUBLE_BLINK_GAP = 0.12;

/** A very long frame (a hidden tab coming back) is cut to this, so the state machine cannot spin. */
const MAX_BLINK_STEP = 60;

/**
 * Blink timing. `update(dt)` returns the eyelid weight (0 open, 1 closed).
 *
 * The random source is drawn in a fixed order: once in the constructor (the
 * first delay), then when a blink ends, once to decide on a double and, if
 * there is none, once more for the wait until the next blink. The second blink
 * of a double never rolls for another double and only draws the wait.
 */
export class Blinker {
  /** Seconds until the next blink starts (meaningful between blinks). */
  private wait: number;
  /** Seconds into the current blink, or -1 between blinks. */
  private elapsed = -1;
  /** True while the current blink is the second of a double. */
  private second = false;

  constructor(private readonly random: RandomSource = Math.random) {
    this.wait = FIRST_BLINK_RANGE[0] + (FIRST_BLINK_RANGE[1] - FIRST_BLINK_RANGE[0]) * random();
  }

  update(dt: number): number {
    if (dt > 0) this.advance(Math.min(dt, MAX_BLINK_STEP));
    return this.weight();
  }

  private advance(dt: number): void {
    let left = dt;
    // A long frame may cross several state changes, so walk them one by one.
    while (left > 0) {
      if (this.elapsed < 0) {
        if (left < this.wait) {
          this.wait -= left;
          return;
        }
        left -= this.wait;
        this.wait = 0;
        this.elapsed = 0;
      } else {
        const remaining = BLINK_SECONDS - this.elapsed;
        if (left < remaining) {
          this.elapsed += left;
          return;
        }
        left -= remaining;
        this.finish();
      }
    }
  }

  private finish(): void {
    this.elapsed = -1;
    if (!this.second && this.random() < DOUBLE_BLINK_CHANCE) {
      this.second = true;
      this.wait = DOUBLE_BLINK_GAP;
    } else {
      this.second = false;
      this.wait = NEXT_BLINK_RANGE[0] + (NEXT_BLINK_RANGE[1] - NEXT_BLINK_RANGE[0]) * this.random();
    }
  }

  private weight(): number {
    if (this.elapsed <= 0) return 0;
    const p = this.elapsed / BLINK_SECONDS;
    return clamp01(p < BLINK_RISE ? p / BLINK_RISE : (1 - p) / (1 - BLINK_RISE));
  }
}

// ---- Mood expression and pose ------------------------------------------------

export interface MoodExpression {
  happy: number;
  relaxed: number;
  surprised: number;
}

const EXPRESSIONS: Readonly<Record<Mood, Readonly<MoodExpression>>> = {
  listening: { happy: 0.15, relaxed: 0.35, surprised: 0 },
  thinking: { happy: 0, relaxed: 0.15, surprised: 0.08 },
  speaking: { happy: 0.3, relaxed: 0.1, surprised: 0 },
  idle: { happy: 0.2, relaxed: 0.25, surprised: 0 },
};

/** The resting facial expression for a mood. An unknown mood reads as idle. */
export function moodExpression(mood: Mood): MoodExpression {
  return { ...(EXPRESSIONS[mood] ?? EXPRESSIONS.idle) };
}

export interface MoodPose {
  tilt: number;
  pitch: number;
  sway: number;
}

/**
 * Head tilt, head pitch and body sway for a mood at time `t` seconds. `level`
 * (0-1) only matters while speaking. An unknown mood reads as idle.
 */
export function moodPose(mood: Mood, t: number, level: number): MoodPose {
  const sway = 0.025 * Math.sin(0.9 * t);
  switch (mood) {
    case "listening":
      return { tilt: 0.12, pitch: 0.04, sway };
    case "thinking":
      return { tilt: -0.06, pitch: -0.1 + 0.02 * Math.sin(0.7 * t), sway: sway / 2 };
    case "speaking":
      return { tilt: 0.05 * Math.sin(1.8 * t), pitch: 0.02 + 0.06 * level * Math.sin(6 * t), sway };
    default:
      return { tilt: 0.03 * Math.sin(0.5 * t), pitch: 0, sway };
  }
}

// ---- Text mood ---------------------------------------------------------------

const LAUGH = /\b(ha(ha)+|hehe+|lol)\b|😂|😄|😆|\[(giggles|laughs|chuckles|playfully|excited)\]/;
const WOW = /\b(oh my|wow|whoa|no way)\b|!{2,}|\[(gasps|surprised)\]/;

export interface TextMood {
  happy: number;
  surprised: number;
}

/**
 * How the words she says should colour her face: a laugh gives happy .6,
 * otherwise any "!" gives happy .4; a wow gives surprised .35.
 */
export function textMood(text: string): TextMood {
  const t = (typeof text === "string" ? text : "").toLowerCase();
  const happy = LAUGH.test(t) ? 0.6 : t.includes("!") ? 0.4 : 0;
  const surprised = WOW.test(t) ? 0.35 : 0;
  return { happy, surprised };
}

// ---- Wave detector -----------------------------------------------------------

export interface WaveOptions {
  /** The smallest lateral swing, in metres, that counts as one side of a wave. */
  minSwing: number;
  /** How many direction reversals make a wave. */
  flips: number;
  /** All the reversals must fall inside this many milliseconds. */
  windowMs: number;
  /** After a wave, stay quiet for this many milliseconds. */
  cooldownMs: number;
  /** The hand may be at most this many metres below its highest point in the window. */
  maxDrop: number;
}

export const WAVE_DEFAULTS: Readonly<WaveOptions> = Object.freeze({
  minSwing: 0.05,
  flips: 3,
  windowMs: 1600,
  cooldownMs: 4000,
  maxDrop: 0.2,
});

/** Lateral steps smaller than this, in metres, are sensor jitter and are ignored. */
export const WAVE_JITTER = 0.002;

/**
 * Spots a wave from one hand. Feed it `push(x, y, tMs)` with the hand's lateral
 * position and height, in metres, in a frame made of the head position plus
 * the head's yaw only, and the time in milliseconds. `push` returns true on the
 * sample that completes a wave.
 *
 * A step counts only once the hand is at least WAVE_JITTER away from the last
 * position that counted, so slow drift still adds up. Each time the hand
 * reverses, the swing that just ended (from the previous turning point to this
 * one) is measured; swings of at least `minSwing` are flips. A wave is `flips`
 * flips inside `windowMs` with the hand not more than `maxDrop` below its
 * highest point in that window. Then the detector stays quiet for `cooldownMs`.
 */
export class WaveDetector {
  readonly options: Readonly<WaveOptions>;

  /** The last position that counted as movement (NaN before the first sample). */
  private x = NaN;
  /** Where the current swing began. */
  private from = 0;
  /** The current lateral direction: -1, 0 (not moving yet) or 1. */
  private dir = 0;
  private flipTimes: number[] = [];
  /** Heights seen inside the window, with their times. */
  private sampleTimes: number[] = [];
  private sampleHeights: number[] = [];
  private lastT = -Infinity;
  private quietUntil = -Infinity;

  constructor(options: Partial<WaveOptions> = {}) {
    this.options = Object.freeze({ ...WAVE_DEFAULTS, ...options });
  }

  /** Forgets the motion so far (a hand lost and found again). The cooldown stays. */
  reset(): void {
    this.x = NaN;
    this.from = 0;
    this.dir = 0;
    this.flipTimes.length = 0;
    this.sampleTimes.length = 0;
    this.sampleHeights.length = 0;
  }

  push(x: number, y: number, tMs: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(tMs)) return false;
    const { minSwing, flips, windowMs, cooldownMs, maxDrop } = this.options;

    if (tMs < this.lastT) {
      // The clock went backwards: this is a new timeline, so nothing old applies.
      this.reset();
      this.quietUntil = -Infinity;
    }
    const gap = tMs - this.lastT;
    this.lastT = tMs;
    if (tMs < this.quietUntil) return false;
    // A long silence puts every earlier sample outside the window.
    if (gap > windowMs) this.reset();

    this.sampleTimes.push(tMs);
    this.sampleHeights.push(y);
    while (this.sampleTimes.length > 0 && tMs - this.sampleTimes[0] > windowMs) {
      this.sampleTimes.shift();
      this.sampleHeights.shift();
    }

    if (Number.isNaN(this.x)) {
      this.x = x;
      return false;
    }
    const step = x - this.x;
    if (Math.abs(step) < WAVE_JITTER) return false;
    const dir = step > 0 ? 1 : -1;
    if (this.dir === 0) {
      this.dir = dir;
      this.from = this.x;
      this.x = x;
      return false;
    }
    if (dir === this.dir) {
      this.x = x;
      return false;
    }

    // The hand turned round at this.x. The swing that just ended ran from this.from to here.
    if (Math.abs(this.x - this.from) >= minSwing) this.flipTimes.push(tMs);
    this.dir = dir;
    this.from = this.x;
    this.x = x;

    while (this.flipTimes.length > 0 && tMs - this.flipTimes[0] > windowMs) this.flipTimes.shift();
    if (this.flipTimes.length < flips) return false;

    let highest = -Infinity;
    for (const h of this.sampleHeights) if (h > highest) highest = h;
    if (highest - y > maxDrop) return false;

    this.reset();
    this.quietUntil = tMs + cooldownMs;
    return true;
  }
}
