// FaceRig (§7.2): turns a mood, an audio level and the words being said into
// the eased values that drive Callie's layered portrait: the mouth, smile,
// think, wow and blink layers plus the head and body motion. Pure apart from
// the Blinker's random source, which the constructor injects for tests.

import {
  Blinker,
  approach,
  clamp01,
  moodPose,
  textMood,
  visemesFor,
  type Mood,
  type RandomSource,
} from "./avatarMotion";

// ---- Tuned values -------------------------------------------------------------

export const TALK_RATE = 22;
export const SMILE_RATE = 6;
export const THINK_RATE = 5;
export const WOW_RATE = 9;
/** Tilt and pitch ease toward the mood pose at this rate. */
export const POSE_RATE = 4;
/** A cheer smiles for this long, in seconds. */
export const CHEER_SECONDS = 1.6;
/** A new exclamation shows the wow face for this long, in seconds. */
export const WOW_SECONDS = 0.9;
/** One hop after a cheer lasts this long, in seconds. */
export const HOP_SECONDS = 0.45;
/** Once the blink layer shows it stays for at least this long, in seconds. */
export const BLINK_HOLD_SECONDS = 0.09;
/** The blink layer shows whenever the blinker weight is above this. */
export const BLINK_THRESHOLD = 0.3;
/** Text counts as a laugh when its happy score is above this. */
export const LAUGH_HAPPY = 0.5;
/** Only this many trailing characters of the text colour her face (§18). */
export const TEXT_TAIL_CHARS = 160;

export interface FaceState {
  /** Mouth-open layer opacity, 0-1. */
  talk: number;
  /** Open-mouth smile layer opacity, 0-1. */
  smile: number;
  /** Thinking layer opacity, 0-1. */
  think: number;
  /** Surprised layer opacity, 0-1. */
  wow: number;
  /** The closed-eyes layer: 1 while it shows, otherwise 0. */
  blink: number;
  /** Head tilt, eased. */
  tilt: number;
  /** Head pitch, eased. */
  pitch: number;
  /** Breathing, sin 1.7t (-1 to 1). */
  breath: number;
  /** Body sway from the mood pose. */
  sway: number;
  /** A single hop after a cheer, 0 to 1 and back to 0. */
  hop: number;
}

function countBangs(text: string): number {
  let n = 0;
  for (let i = text.indexOf("!"); i >= 0; i = text.indexOf("!", i + 1)) n++;
  return n;
}

export class FaceRig {
  private readonly blinker: Blinker;
  /** The rig's own clock, in seconds. */
  private t = 0;
  private talk = 0;
  private smile = 0;
  private think = 0;
  private wow = 0;
  private tilt = 0;
  private pitch = 0;
  /** Seconds of cheering left (smile, no blinking). */
  private cheerLeft = 0;
  /** Seconds of the current hop left. */
  private hopLeft = 0;
  /** Seconds of wow left. */
  private wowLeft = 0;
  /** Seconds the blink layer must still stay on. */
  private blinkHold = 0;
  private blinkOn = false;
  /** The "!" count and surprised score seen last frame, to spot new exclamations. */
  private bangs = 0;
  private surprised = 0;

  constructor(random: RandomSource = Math.random) {
    this.blinker = new Blinker(random);
  }

  /** Smiles for 1.6 s and hops once; blinking pauses meanwhile. A hop already under way finishes first. */
  cheer(): void {
    this.cheerLeft = CHEER_SECONDS;
    if (this.hopLeft <= 0) this.hopLeft = HOP_SECONDS;
  }

  /**
   * Advances the rig by `dt` seconds. `level` (0-1) counts only while the mood
   * is "speaking". `text` is what she is saying, read for laughs and
   * exclamations (only its last 160 characters colour her face).
   */
  update(dt: number, mood: Mood, level: number, text: string = ""): FaceState {
    const step = dt > 0 && dt < Infinity ? dt : 0;
    this.t += step;
    const t = this.t;
    this.cheerLeft = Math.max(0, this.cheerLeft - step);
    this.hopLeft = Math.max(0, this.hopLeft - step);
    this.wowLeft = Math.max(0, this.wowLeft - step);

    const lv = mood === "speaking" ? clamp01(level) : 0;
    const said = typeof text === "string" ? text : "";
    const words = textMood(said.length > TEXT_TAIL_CHARS ? said.slice(-TEXT_TAIL_CHARS) : said);

    // Mouth.
    const v = visemesFor(lv, t);
    this.talk = approach(this.talk, Math.min(1, v.aa + 0.8 * v.oh + 0.5 * v.ee), step, TALK_RATE);

    // Smile: a laugh in the words, or a cheer.
    const smiling = words.happy > LAUGH_HAPPY || this.cheerLeft > 0;
    this.smile = approach(this.smile, smiling ? 1 : 0, step, SMILE_RATE);

    // Think: eyes drift up, with a glance back now and then.
    const thinking = mood === "thinking" && Math.sin(0.9 * t) > -0.6;
    this.think = approach(this.think, thinking ? 1 : 0, step, THINK_RATE);

    // Wow: 0.9 s after each new exclamation (a new "!", or a higher surprised score).
    const bangs = countBangs(said);
    if (bangs > this.bangs || words.surprised > this.surprised) this.wowLeft = WOW_SECONDS;
    this.bangs = bangs;
    this.surprised = words.surprised;
    this.wow = approach(this.wow, this.wowLeft > 0 ? 1 : 0, step, WOW_RATE);

    // Head pose.
    const pose = moodPose(mood, t, lv);
    this.tilt = approach(this.tilt, pose.tilt, step, POSE_RATE);
    this.pitch = approach(this.pitch, pose.pitch, step, POSE_RATE);

    // Blink: on whenever the blinker weight is above .3, and then for at least
    // 90 ms, so a low frame rate cannot skip it. Suppressed while cheering.
    const weight = this.blinker.update(step);
    if (this.cheerLeft > 0) {
      this.blinkOn = false;
      this.blinkHold = 0;
    } else {
      this.blinkHold = Math.max(0, this.blinkHold - step);
      if (weight > BLINK_THRESHOLD && !this.blinkOn) this.blinkHold = BLINK_HOLD_SECONDS;
      this.blinkOn = weight > BLINK_THRESHOLD || this.blinkHold > 0;
    }

    // One hop: 0 -> 1 -> 0 over 0.45 s.
    const hop = this.hopLeft > 0 ? Math.sin(Math.PI * (1 - this.hopLeft / HOP_SECONDS)) : 0;

    return {
      talk: this.talk * (1 - 0.6 * this.smile),
      smile: this.smile * (1 - this.wow),
      think: this.think * (1 - this.talk),
      wow: this.wow,
      blink: this.blinkOn ? 1 : 0,
      tilt: this.tilt,
      pitch: this.pitch,
      breath: Math.sin(1.7 * t),
      sway: pose.sway,
      hop,
    };
  }
}
