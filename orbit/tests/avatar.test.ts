import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLINK_SECONDS,
  Blinker,
  WAVE_DEFAULTS,
  WAVE_JITTER,
  WaveDetector,
  approach,
  clamp01,
  moodExpression,
  moodPose,
  textMood,
  visemesFor,
  type Mood,
  type RandomSource,
} from "../src/core/avatarMotion";
import {
  AVATAR_KEY,
  DB_NAME,
  DB_VERSION,
  STORE_NAME,
  deleteAvatar,
  loadAvatar,
  saveAvatar,
  type IDBFactoryLike,
} from "../src/core/blobstore";

// ---- Helpers -------------------------------------------------------------------------

/** A seeded random source (mulberry32), so the random-looking tests repeat exactly. */
function seeded(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random source that returns the given values in order and throws once they run out. */
function script(...values: number[]): RandomSource {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error("the random source was drawn more often than the test expects");
    return values[i++];
  };
}

/** Runs a Blinker for `steps` updates of `dt` seconds and returns the weight after each one. */
function weights(b: Blinker, steps: number, dt: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < steps; i++) out.push(b.update(dt));
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Visemes -------------------------------------------------------------------------

describe("visemesFor", () => {
  const SHAPES = ["aa", "ih", "ou", "ee", "oh"] as const;
  const times = [0, 0.05, 0.37, 1.234, 2.5, 7.77, 30.3, 123.456];

  it("keeps her mouth shut at or below the 0.03 floor", () => {
    for (const level of [-1, 0, 0.01, 0.03]) {
      for (const t of times) {
        const v = visemesFor(level, t);
        for (const k of SHAPES) expect(Math.abs(v[k])).toBe(0);
      }
    }
  });

  it("follows the five formulas, with open = (level - 0.03) x 2.2", () => {
    const level = 0.13; // open = 0.22
    const open = 0.22;
    for (const t of times) {
      const a = (Math.sin(7.3 * t) + 1) / 2;
      const b = (Math.sin(4.1 * t + 1.7) + 1) / 2;
      const v = visemesFor(level, t);
      expect(v.aa).toBeCloseTo(open * (0.55 + 0.45 * a), 12);
      expect(v.oh).toBeCloseTo(0.5 * open * (1 - a) * b, 12);
      expect(v.ee).toBeCloseTo(0.35 * open * (1 - b), 12);
      expect(v.ih).toBeCloseTo(0.25 * open * a * (1 - b), 12);
      expect(v.ou).toBeCloseTo(0.3 * open * (1 - a) * (1 - b), 12);
    }
  });

  it("has known values at t = 0 with the mouth fully open", () => {
    // sin 0 = 0, so a = 0.5; b = (sin 1.7 + 1) / 2.
    const b = (Math.sin(1.7) + 1) / 2;
    const v = visemesFor(1, 0);
    expect(v.aa).toBeCloseTo(0.775, 12);
    expect(v.oh).toBeCloseTo(0.25 * b, 12);
    expect(v.ee).toBeCloseTo(0.35 * (1 - b), 12);
    expect(v.ih).toBeCloseTo(0.125 * (1 - b), 12);
    expect(v.ou).toBeCloseTo(0.15 * (1 - b), 12);
  });

  it("opens fully from about level 0.4846 and no further", () => {
    expect(visemesFor(0.4846, 1.1)).toEqual(visemesFor(1, 1.1));
    expect(visemesFor(5, 1.1)).toEqual(visemesFor(1, 1.1));
    expect(visemesFor(0.3, 1.1).aa).toBeLessThan(visemesFor(1, 1.1).aa);
    expect(visemesFor(0.1, 1.1).aa).toBeLessThan(visemesFor(0.3, 1.1).aa);
  });

  it("makes aa the dominant shape at full open, at every moment", () => {
    for (let i = 0; i < 4000; i++) {
      const v = visemesFor(1, i * 0.0137);
      expect(v.aa).toBeGreaterThanOrEqual(0.55 - 1e-12);
      for (const k of ["ih", "ou", "ee", "oh"] as const) expect(v.aa).toBeGreaterThan(v[k]);
    }
  });

  it("swings aa between 0.55 and 1 as the first oscillator turns", () => {
    const high = visemesFor(1, Math.PI / 2 / 7.3); // sin(7.3t) = 1, so a = 1
    expect(high.aa).toBeCloseTo(1, 12);
    expect(high.oh).toBeCloseTo(0, 12);
    expect(high.ou).toBeCloseTo(0, 12);
    const low = visemesFor(1, (3 * Math.PI) / 2 / 7.3); // sin(7.3t) = -1, so a = 0
    expect(low.aa).toBeCloseTo(0.55, 12);
    expect(low.ih).toBeCloseTo(0, 12);
  });

  it("stays between 0 and 1 for any level and time", () => {
    const rand = seeded(42);
    for (let i = 0; i < 5000; i++) {
      const v = visemesFor(rand() * 3 - 0.75, rand() * 200);
      for (const k of SHAPES) {
        expect(v[k]).toBeGreaterThanOrEqual(0);
        expect(v[k]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reads a NaN level as silence", () => {
    const v = visemesFor(Number.NaN, 1);
    for (const k of SHAPES) expect(v[k]).toBe(0);
  });
});

// ---- approach and clamp01 --------------------------------------------------------------

describe("approach", () => {
  it("is c + (g - c)(1 - e^(-k dt))", () => {
    expect(approach(0, 1, 0.1, 10)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(approach(2, 4, 0.5, 2)).toBeCloseTo(2 + 2 * (1 - Math.exp(-1)), 12);
    expect(approach(5, -3, 0.25, 4)).toBeCloseTo(5 - 8 * (1 - Math.exp(-1)), 12);
    expect(approach(0, 1, 1 / 60, 22)).toBeCloseTo(1 - Math.exp(-22 / 60), 12);
  });

  it("stays put for dt = 0, rate 0 or when already at the goal", () => {
    expect(approach(0.3, 0.9, 0, 5)).toBe(0.3);
    expect(approach(0.3, 0.9, 0.1, 0)).toBe(0.3);
    expect(approach(0.7, 0.7, 0.1, 5)).toBe(0.7);
  });

  it("moves monotonically toward the goal and never overshoots it", () => {
    let up = 0;
    let down = 10;
    for (let i = 0; i < 300; i++) {
      const nextUp = approach(up, 5, 1 / 60, 6);
      const nextDown = approach(down, 5, 1 / 60, 6);
      expect(nextUp).toBeGreaterThanOrEqual(up);
      expect(nextUp).toBeLessThanOrEqual(5);
      expect(nextDown).toBeLessThanOrEqual(down);
      expect(nextDown).toBeGreaterThanOrEqual(5);
      up = nextUp;
      down = nextDown;
    }
    expect(up).toBeCloseTo(5, 6);
    expect(down).toBeCloseTo(5, 6);
  });

  it("does not depend on the frame rate: ten small steps equal one big one", () => {
    const whole = approach(0.2, 0.9, 0.1, 5);
    let stepped = 0.2;
    for (let i = 0; i < 10; i++) stepped = approach(stepped, 0.9, 0.01, 5);
    expect(stepped).toBeCloseTo(whole, 12);
  });

  it("closes more of the gap with a longer step or a higher rate", () => {
    expect(approach(0, 1, 0.2, 4)).toBeGreaterThan(approach(0, 1, 0.1, 4));
    expect(approach(0, 1, 0.1, 8)).toBeGreaterThan(approach(0, 1, 0.1, 4));
    expect(approach(0, 1, 100, 4)).toBeCloseTo(1, 12);
  });
});

describe("clamp01", () => {
  it("clamps to 0-1 and reads NaN as 0", () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(7)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

// ---- Blinker -------------------------------------------------------------------------

/** Spans [start, end] in seconds of each stretch with the lid shut; end is null if the run stopped mid-blink. */
type Span = readonly [start: number, end: number | null];

function blinkSpans(b: Blinker, seconds: number, dt = 0.001): Span[] {
  const spans: Array<[number, number | null]> = [];
  let open: [number, number | null] | null = null;
  const steps = Math.round(seconds / dt);
  for (let i = 1; i <= steps; i++) {
    const w = b.update(dt);
    const t = i * dt;
    if (w > 0 && !open) {
      open = [t, null];
      spans.push(open);
    } else if (w === 0 && open) {
      open[1] = t;
      open = null;
    }
  }
  return spans;
}

function expectSpans(actual: readonly Span[], expected: readonly Span[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach(([start, end], i) => {
    expect(actual[i][0], `blink ${i + 1} start`).toBeCloseTo(start, 2);
    if (end === null) expect(actual[i][1], `blink ${i + 1} is still under way`).toBeNull();
    else expect(actual[i][1] ?? Number.NaN, `blink ${i + 1} end`).toBeCloseTo(end, 2);
  });
}

describe("Blinker", () => {
  it("starts the first blink 1-4 s in, as the random source says", () => {
    const early = new Blinker(script(0)); // 1 s
    expect(early.update(0.999)).toBe(0);
    expect(early.update(0.002)).toBeGreaterThan(0);

    const middle = new Blinker(script(0.5)); // 2.5 s
    expect(middle.update(2.49)).toBe(0);
    expect(middle.update(0.02)).toBeGreaterThan(0);

    const late = new Blinker(script(0.999999)); // just under 4 s
    expect(late.update(3.99)).toBe(0);
    expect(late.update(0.02)).toBeGreaterThan(0);
  });

  it("starts the first blink inside 1-4 s for any seed", () => {
    const dt = 1 / 240;
    for (let seed = 1; seed <= 300; seed++) {
      const b = new Blinker(seeded(seed));
      let zeros = 0;
      while (b.update(dt) === 0) zeros++;
      const seen = (zeros + 1) * dt; // the step on which the weight first left 0
      expect(seen).toBeGreaterThanOrEqual(1);
      expect(seen).toBeLessThan(4 + dt);
    }
  });

  it("lasts 0.16 s", () => {
    expect(BLINK_SECONDS).toBe(0.16);
    const b = new Blinker(script(0, 0.5, 0.5));
    b.update(1); // lands exactly on the start of the first blink
    const dt = 0.001;
    let n = 0;
    let w: number;
    do {
      w = b.update(dt);
      n++;
    } while (w > 0);
    expect(n * dt).toBeGreaterThanOrEqual(0.159);
    expect(n * dt).toBeLessThanOrEqual(0.1621);
  });

  it("rises over the first 40% of the blink and falls over the other 60%", () => {
    const b = new Blinker(script(0, 0.5, 0.5));
    b.update(1);
    const ws = weights(b, 160, 0.001); // ws[i] is the weight (i + 1) ms into the blink
    // Rising, linearly, to the peak at 64 ms.
    expect(ws[15]).toBeCloseTo(0.25, 6); // 16 ms
    expect(ws[31]).toBeCloseTo(0.5, 6); // 32 ms
    expect(ws[47]).toBeCloseTo(0.75, 6); // 48 ms
    expect(ws[63]).toBeCloseTo(1, 6); // 64 ms: 40% of 160
    // Falling, linearly, to 0 at 160 ms.
    expect(ws[95]).toBeCloseTo(2 / 3, 6); // 96 ms
    expect(ws[111]).toBeCloseTo(0.5, 6); // 112 ms
    expect(ws[127]).toBeCloseTo(1 / 3, 6); // 128 ms
    expect(ws[143]).toBeCloseTo(1 / 6, 6); // 144 ms
    expect(ws[159]).toBeLessThan(0.001);
    // The peak is the maximum and the shape is one hump.
    const peak = ws.indexOf(Math.max(...ws));
    expect(peak).toBeGreaterThanOrEqual(62);
    expect(peak).toBeLessThanOrEqual(64);
    for (let i = 1; i <= peak; i++) expect(ws[i]).toBeGreaterThanOrEqual(ws[i - 1]);
    for (let i = peak + 1; i < ws.length; i++) expect(ws[i]).toBeLessThanOrEqual(ws[i - 1]);
  });

  it("gets a double 0.12 s after the blink ends when the random says so", () => {
    // Draws, in order: the first delay (0 -> 1 s); at the end of blink 1 the double roll (0.1, under
    // 0.15, so a double); at the end of blink 2 only the wait (0.5 -> 4 s); at the end of blink 3 the
    // roll (0.9, none) and then the wait (0 -> 2 s). Any other order lands elsewhere or runs the script dry.
    const spans = blinkSpans(new Blinker(script(0, 0.1, 0.5, 0.9, 0)), 7.7);
    expectSpans(spans, [
      [1.0, 1.16], //  the first delay
      [1.28, 1.44], // the double: 0.12 s after blink 1 ended
      [5.44, 5.6], //  the wait after a double is the long one, 4 s here
      [7.6, null], //  no double after blink 3, so 2 s later
    ]);
  });

  it("does not double when the roll is 0.15 or more", () => {
    // The roll 0.15 is not under 0.15, so the next draw (0.5 -> 4 s) is the wait.
    const spans = blinkSpans(new Blinker(script(0, 0.15, 0.5)), 5.25);
    expectSpans(spans, [
      [1.0, 1.16],
      [5.16, null],
    ]);
  });

  it("doubles when the roll is just under 0.15", () => {
    const spans = blinkSpans(new Blinker(script(0, 0.1499, 0.5)), 1.4);
    expectSpans(spans, [
      [1.0, 1.16],
      [1.28, null],
    ]);
  });

  it("never rolls for a double after a double, so there are no triples", () => {
    // After blink 2 only the wait is drawn (0.01 -> 2.04 s). A roll there would read the same 0.01
    // as a double and bring a third blink 0.12 s later.
    const spans = blinkSpans(new Blinker(script(0, 0.01, 0.01, 0.5)), 3.55);
    expectSpans(spans, [
      [1.0, 1.16],
      [1.28, 1.44],
      [3.48, null],
    ]);
  });

  it("keeps blinking every 2-6 s and doubles about 15% of the time over a long seeded run", () => {
    const dt = 1 / 30;
    const b = new Blinker(seeded(2026));
    const starts: number[] = [];
    let before = 0;
    let lowest = 1;
    let highest = 0;
    for (let i = 1; i <= 30 * 20000; i++) {
      const w = b.update(dt);
      if (w < lowest) lowest = w;
      if (w > highest) highest = w;
      if (before === 0 && w > 0) starts.push(i * dt);
      before = w;
    }
    expect(lowest).toBe(0);
    expect(highest).toBeGreaterThan(0.5);
    expect(highest).toBeLessThanOrEqual(1);
    expect(starts[0]).toBeGreaterThanOrEqual(1);
    expect(starts[0]).toBeLessThan(4 + dt);

    let doubles = 0;
    let lastWasDouble = false;
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - starts[i - 1];
      const isDouble = gap < 1;
      if (isDouble) {
        // Start to start: the 0.16 s blink plus the 0.12 s gap.
        expect(gap).toBeGreaterThan(0.28 - dt - 1e-9);
        expect(gap).toBeLessThan(0.28 + dt + 1e-9);
        expect(lastWasDouble).toBe(false);
        doubles++;
      } else {
        // Start to start: the 0.16 s blink plus a wait of 2-6 s.
        expect(gap).toBeGreaterThan(2.16 - dt - 1e-9);
        expect(gap).toBeLessThan(6.16 + dt + 1e-9);
      }
      lastWasDouble = isDouble;
    }
    // A double counts as one event, so the share is doubles over (starts - doubles).
    const share = doubles / (starts.length - doubles);
    expect(share).toBeGreaterThan(0.12);
    expect(share).toBeLessThan(0.18);
  });

  it("ignores zero, negative and NaN steps, and survives a huge one", () => {
    const b = new Blinker(script(0));
    expect(b.update(0)).toBe(0);
    expect(b.update(-5)).toBe(0);
    expect(b.update(Number.NaN)).toBe(0);
    expect(b.update(0.999)).toBe(0); // none of the above moved the clock
    expect(b.update(0.002)).toBeGreaterThan(0);

    const huge = new Blinker(seeded(3));
    for (const dt of [1e9, Number.POSITIVE_INFINITY]) {
      const w = huge.update(dt);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it("walks through every blink inside one long frame, like many short ones", () => {
    const whole = new Blinker(seeded(11));
    const parts = new Blinker(seeded(11));
    whole.update(30);
    for (let i = 0; i < 300; i++) parts.update(0.1);
    // Same schedule either way: the next ten seconds match step for step.
    for (let i = 0; i < 10000; i++) {
      expect(Math.abs(whole.update(0.001) - parts.update(0.001))).toBeLessThan(1e-6);
    }
  });
});

// ---- Mood expression and pose --------------------------------------------------------

describe("moodExpression", () => {
  it("matches the table", () => {
    expect(moodExpression("listening")).toEqual({ happy: 0.15, relaxed: 0.35, surprised: 0 });
    expect(moodExpression("thinking")).toEqual({ happy: 0, relaxed: 0.15, surprised: 0.08 });
    expect(moodExpression("speaking")).toEqual({ happy: 0.3, relaxed: 0.1, surprised: 0 });
    expect(moodExpression("idle")).toEqual({ happy: 0.2, relaxed: 0.25, surprised: 0 });
  });

  it("hands out copies and reads an unknown mood as idle", () => {
    const a = moodExpression("idle");
    a.happy = 9;
    expect(moodExpression("idle").happy).toBe(0.2);
    expect(moodExpression("sleeping" as Mood)).toEqual(moodExpression("idle"));
  });
});

describe("moodPose", () => {
  const sway = (t: number) => 0.025 * Math.sin(0.9 * t);
  const moments = [0, 1, 2.7, 10.1];

  it("leans in while listening", () => {
    for (const t of moments) {
      const p = moodPose("listening", t, 0.8);
      expect(p.tilt).toBe(0.12);
      expect(p.pitch).toBe(0.04);
      expect(p.sway).toBeCloseTo(sway(t), 12);
    }
  });

  it("tilts the other way, looks up and sways half as much while thinking", () => {
    for (const t of moments) {
      const p = moodPose("thinking", t, 0.8);
      expect(p.tilt).toBe(-0.06);
      expect(p.pitch).toBeCloseTo(-0.1 + 0.02 * Math.sin(0.7 * t), 12);
      expect(p.sway).toBeCloseTo(sway(t) / 2, 12);
    }
  });

  it("nods with the level while speaking", () => {
    for (const t of [0.3, 1, 2.7, 10.1]) {
      const p = moodPose("speaking", t, 0.5);
      expect(p.tilt).toBeCloseTo(0.05 * Math.sin(1.8 * t), 12);
      expect(p.pitch).toBeCloseTo(0.02 + 0.06 * 0.5 * Math.sin(6 * t), 12);
      expect(p.sway).toBeCloseTo(sway(t), 12);
    }
    expect(moodPose("speaking", 1, 0).pitch).toBeCloseTo(0.02, 12); // silent: no nod
    expect(moodPose("speaking", Math.PI / 12, 1).pitch).toBeCloseTo(0.08, 12); // sin 6t = 1 at full level
  });

  it("drifts a little while idle", () => {
    for (const t of moments) {
      const p = moodPose("idle", t, 0.8);
      expect(p.tilt).toBeCloseTo(0.03 * Math.sin(0.5 * t), 12);
      expect(p.pitch).toBe(0);
      expect(p.sway).toBeCloseTo(sway(t), 12);
    }
  });

  it("reads an unknown mood as idle", () => {
    expect(moodPose("sleeping" as Mood, 1.3, 0.5)).toEqual(moodPose("idle", 1.3, 0.5));
  });
});

// ---- Text mood -----------------------------------------------------------------------

describe("textMood", () => {
  it("gives happy 0.6 for a laugh", () => {
    for (const text of [
      "haha that was good",
      "Hahaha",
      "hehe, got you",
      "heheee",
      "LOL",
      "well, lol.",
      "that's funny \u{1F602}",
      "\u{1F604}",
      "\u{1F606} stop",
      "[giggles] oh dear",
      "[laughs]",
      "[chuckles] fine",
      "[playfully] maybe",
      "[excited] yes",
    ]) {
      expect(textMood(text).happy, text).toBe(0.6);
    }
  });

  it("lets a laugh win over a plain exclamation mark", () => {
    expect(textMood("hahaha!").happy).toBe(0.6);
    expect(textMood("lol!!").happy).toBe(0.6);
  });

  it("gives happy 0.4 for any exclamation mark that is not a laugh", () => {
    expect(textMood("Great!")).toEqual({ happy: 0.4, surprised: 0 });
    expect(textMood("Done! Next?")).toEqual({ happy: 0.4, surprised: 0 });
    expect(textMood("!").happy).toBe(0.4);
  });

  it("gives surprised 0.35 for a wow", () => {
    for (const text of [
      "wow",
      "Wow, nice",
      "WOW",
      "oh my goodness",
      "Oh my",
      "whoa there",
      "no way",
      "No way!",
      "[gasps]",
      "[surprised] really",
      "what!!",
      "!!",
    ]) {
      expect(textMood(text).surprised, text).toBe(0.35);
    }
  });

  it("keeps happy and surprised apart", () => {
    expect(textMood("wow")).toEqual({ happy: 0, surprised: 0.35 });
    expect(textMood("Wow!!")).toEqual({ happy: 0.4, surprised: 0.35 });
    expect(textMood("haha wow")).toEqual({ happy: 0.6, surprised: 0.35 });
    expect(textMood("lol, no way!")).toEqual({ happy: 0.6, surprised: 0.35 });
  });

  it("finds neutral text neutral", () => {
    expect(textMood("")).toEqual({ happy: 0, surprised: 0 });
    expect(textMood("The meeting is at three.")).toEqual({ happy: 0, surprised: 0 });
    expect(textMood("Here are your tasks: buy milk, call Sam.")).toEqual({ happy: 0, surprised: 0 });
  });

  it("matches whole words only", () => {
    expect(textMood("a lollipop").happy).toBe(0);
    expect(textMood("ha").happy).toBe(0);
    expect(textMood("hah").happy).toBe(0);
    expect(textMood("the wowser").surprised).toBe(0);
    expect(textMood("know way").surprised).toBe(0);
    // A hyphen ends a word, so this still counts.
    expect(textMood("whoa-ish").surprised).toBe(0.35);
  });

  it("lowercases first, and reads a non-string as empty", () => {
    expect(textMood("[GIGGLES]").happy).toBe(0.6);
    expect(textMood("[GASPS]").surprised).toBe(0.35);
    expect(textMood(undefined as unknown as string)).toEqual({ happy: 0, surprised: 0 });
  });
});

// ---- Blob store ----------------------------------------------------------------------

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer as ArrayBuffer;
}

function toArray(buffer: ArrayBuffer): number[] {
  return [...new Uint8Array(buffer)];
}

/** Narrows a loaded record, failing the test with a clear message when there is none. */
function must<T>(value: T | null): T {
  if (value === null) throw new Error("expected a stored avatar, found none");
  return value;
}

/** A fresh, empty fake IndexedDB, so no test sees another's data. */
function fresh(): IDBFactoryLike {
  return new IDBFactory();
}

interface Raw {
  version: number;
  stores: string[];
  keys: IDBValidKey[];
  value: unknown;
}

/** Looks inside the database behind the module's back. The database must exist already. */
function rawLook(idb: IDBFactoryLike): Promise<Raw> {
  return new Promise<Raw>((resolve, reject) => {
    const open = idb.open(DB_NAME);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const keys = store.getAllKeys();
      const value = store.get(AVATAR_KEY);
      tx.oncomplete = () => {
        const out: Raw = { version: db.version, stores: [...db.objectStoreNames], keys: keys.result, value: value.result };
        db.close();
        resolve(out);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

/** Writes any value under the avatar key, behind the module's back. The database must exist already. */
function rawPut(idb: IDBFactoryLike, value: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const open = idb.open(DB_NAME, DB_VERSION);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, AVATAR_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

/** Wraps a factory to count the databases the module opens and the ones it closes again. */
function counting(idb: IDBFactoryLike): { factory: IDBFactoryLike; stats: { opened: number; closed: number } } {
  const stats = { opened: 0, closed: 0 };
  const factory: IDBFactoryLike = {
    open(name, version) {
      const request = idb.open(name, version);
      request.addEventListener("success", () => {
        stats.opened++;
        const db = request.result;
        const close = db.close.bind(db);
        db.close = () => {
          stats.closed++;
          close();
        };
      });
      return request;
    },
  };
  return { factory, stats };
}

/** A factory whose every open fails. */
function brokenFactory(): IDBFactoryLike {
  return {
    open() {
      const request = { error: new Error("the database is locked") } as unknown as IDBOpenDBRequest;
      setTimeout(() => request.onerror?.(new Event("error")), 0);
      return request;
    },
  };
}

describe("avatar blob store", () => {
  it("has no avatar before one is saved", async () => {
    expect(await loadAvatar(fresh())).toBeNull();
  });

  it("saves the file and loads it back", async () => {
    const idb = fresh();
    const before = Date.now();
    await saveAvatar("callie.vrm", bytes(1, 2, 3, 250), idb);
    const after = Date.now();
    const got = must(await loadAvatar(idb));
    expect(got.name).toBe("callie.vrm");
    expect(toArray(got.data)).toEqual([1, 2, 3, 250]);
    expect(got.savedAt).toBeGreaterThanOrEqual(before);
    expect(got.savedAt).toBeLessThanOrEqual(after);
  });

  it("round-trips a multi-megabyte file byte for byte", async () => {
    const idb = fresh();
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    await saveAvatar("big.vrm", big.buffer as ArrayBuffer, idb);
    const got = must(await loadAvatar(idb));
    expect(got.data.byteLength).toBe(big.length);
    const back = new Uint8Array(got.data);
    for (const i of [0, 1, 250, 251, 1_000_003, big.length - 1]) expect(back[i]).toBe(i % 251);
  });

  it("stores a copy and hands out a copy", async () => {
    const idb = fresh();
    const source = bytes(9, 9, 9);
    await saveAvatar("a.vrm", source, idb);
    new Uint8Array(source)[0] = 0; // changing the caller's buffer afterwards changes nothing stored
    const first = must(await loadAvatar(idb));
    expect(toArray(first.data)).toEqual([9, 9, 9]);
    expect(first.data).not.toBe(source);
    new Uint8Array(first.data)[1] = 0; // nor does changing what was loaded
    expect(toArray(must(await loadAvatar(idb)).data)).toEqual([9, 9, 9]);
  });

  it("keeps one avatar: saving again replaces it", async () => {
    const idb = fresh();
    await saveAvatar("one.vrm", bytes(1), idb);
    await saveAvatar("two.vrm", bytes(2, 2), idb);
    const got = must(await loadAvatar(idb));
    expect(got.name).toBe("two.vrm");
    expect(toArray(got.data)).toEqual([2, 2]);
    expect((await rawLook(idb)).keys).toEqual([AVATAR_KEY]);
  });

  it("deletes the avatar, and a second delete is harmless", async () => {
    const idb = fresh();
    await saveAvatar("a.vrm", bytes(1, 2), idb);
    await deleteAvatar(idb);
    expect(await loadAvatar(idb)).toBeNull();
    await expect(deleteAvatar(idb)).resolves.toBeUndefined();
    expect(await loadAvatar(idb)).toBeNull();
    // And it can be saved again afterwards.
    await saveAvatar("b.vrm", bytes(3), idb);
    expect(must(await loadAvatar(idb)).name).toBe("b.vrm");
  });

  it("deleting from a database that was never written to is harmless too", async () => {
    await expect(deleteAvatar(fresh())).resolves.toBeUndefined();
  });

  it("uses the database orbit-files, the store files and the key avatar", async () => {
    expect([DB_NAME, STORE_NAME, AVATAR_KEY, DB_VERSION]).toEqual(["orbit-files", "files", "avatar", 1]);
    const idb = fresh();
    await saveAvatar("callie.vrm", bytes(5, 6), idb);
    const look = await rawLook(idb);
    expect(look.version).toBe(1);
    expect(look.stores).toEqual(["files"]);
    expect(look.keys).toEqual(["avatar"]);
    const record = look.value as { name: string; data: ArrayBuffer; savedAt: number };
    expect(Object.keys(record).sort()).toEqual(["data", "name", "savedAt"]);
    expect(record.name).toBe("callie.vrm");
    expect(toArray(record.data)).toEqual([5, 6]);
    expect(typeof record.savedAt).toBe("number");
  });

  it("closes every database it opens, once per call", async () => {
    const { factory, stats } = counting(fresh());
    await saveAvatar("a.vrm", bytes(1), factory);
    expect(stats).toEqual({ opened: 1, closed: 1 });
    await loadAvatar(factory);
    expect(stats).toEqual({ opened: 2, closed: 2 });
    await deleteAvatar(factory);
    expect(stats).toEqual({ opened: 3, closed: 3 });
    await loadAvatar(factory); // nothing stored now
    expect(stats).toEqual({ opened: 4, closed: 4 });
  });

  it("closes the database even when the write fails", async () => {
    const { factory, stats } = counting(fresh());
    // A function cannot be stored, so the put throws a DataCloneError.
    const unstorable = (() => undefined) as unknown as ArrayBuffer;
    await expect(saveAvatar("bad.vrm", unstorable, factory)).rejects.toThrow();
    expect(stats.opened).toBe(1);
    expect(stats.closed).toBe(1);
    expect(await loadAvatar(factory)).toBeNull();
  });

  it("uses the page's own indexedDB when no factory is passed", async () => {
    const idb = fresh();
    vi.stubGlobal("indexedDB", idb);
    await saveAvatar("global.vrm", bytes(7));
    expect(must(await loadAvatar()).name).toBe("global.vrm");
    expect(must(await loadAvatar(idb)).name).toBe("global.vrm"); // the same database
    await deleteAvatar();
    expect(await loadAvatar()).toBeNull();
  });

  it("copes with a browser that has no IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(saveAvatar("x.vrm", bytes(1))).rejects.toThrow(/IndexedDB/);
    expect(await loadAvatar()).toBeNull();
    await expect(deleteAvatar()).resolves.toBeUndefined();
  });

  it("copes with a browser that throws when asked for indexedDB", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get() {
        throw new Error("storage is blocked");
      },
    });
    try {
      await expect(saveAvatar("x.vrm", bytes(1))).rejects.toThrow(/IndexedDB/);
      expect(await loadAvatar()).toBeNull();
      await expect(deleteAvatar()).resolves.toBeUndefined();
    } finally {
      if (original) Object.defineProperty(globalThis, "indexedDB", original);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  });

  it("rejects a save and a delete when the database will not open, and loads nothing", async () => {
    const idb = brokenFactory();
    await expect(saveAvatar("x.vrm", bytes(1), idb)).rejects.toThrow("the database is locked");
    await expect(deleteAvatar(idb)).rejects.toThrow("the database is locked");
    expect(await loadAvatar(idb)).toBeNull();
  });

  it("reads anything stored that is not an avatar as no avatar", async () => {
    const idb = fresh();
    await saveAvatar("a.vrm", bytes(1), idb); // creates the database
    const notAvatars: unknown[] = [
      null,
      42,
      "a string",
      { name: 5, data: bytes(1), savedAt: 1 },
      { name: "a.vrm", data: "text", savedAt: 1 },
      { name: "a.vrm", data: new Uint8Array(3), savedAt: 1 },
      { name: "a.vrm" },
      { data: bytes(1) },
    ];
    for (const value of notAvatars) {
      await rawPut(idb, value);
      expect(await loadAvatar(idb), JSON.stringify(value)).toBeNull();
    }
  });

  it("reads a missing savedAt as 0", async () => {
    const idb = fresh();
    await saveAvatar("a.vrm", bytes(1), idb);
    await rawPut(idb, { name: "old.vrm", data: bytes(4, 5) });
    const got = must(await loadAvatar(idb));
    expect(got.name).toBe("old.vrm");
    expect(toArray(got.data)).toEqual([4, 5]);
    expect(got.savedAt).toBe(0);
  });
});

// ---- Wave detector -------------------------------------------------------------------

interface Sample {
  x: number;
  y: number;
  t: number;
}

interface TraceOptions {
  /** The hand's height in metres at time t (ms). Default: a steady 1.2 m. */
  y?: (t: number) => number;
  /** The time of the first sample, in ms. */
  startMs?: number;
  /** Keep sampling this long after the last waypoint, the hand held still there. */
  holdMs?: number;
}

const STEP_MS = 1000 / 60;

/**
 * A hand path sampled at 60 Hz: straight legs of `legMs` through the lateral `waypoints`
 * (metres), then held still. Times are index x 1000/60 (plus startMs), so a run repeats exactly.
 */
function trace(waypoints: readonly number[], legMs: number, o: TraceOptions = {}): Sample[] {
  const legs = waypoints.length - 1;
  const total = legs * legMs + (o.holdMs ?? 0);
  const height = o.y ?? (() => 1.2);
  const out: Sample[] = [];
  for (let i = 0; i * STEP_MS <= total + 1e-6; i++) {
    const local = i * STEP_MS;
    const leg = Math.min(Math.floor(local / legMs), legs - 1);
    const f = Math.min(1, (local - leg * legMs) / legMs);
    const t = (o.startMs ?? 0) + local;
    out.push({ x: waypoints[leg] + (waypoints[leg + 1] - waypoints[leg]) * f, y: height(t), t });
  }
  return out;
}

/** Back and forth between 0 and `swing` metres: `swings` straight legs of `legMs`, starting at 0. */
function waving(swing: number, legMs: number, swings: number, o: TraceOptions = {}): Sample[] {
  return trace(
    Array.from({ length: swings + 1 }, (_, i) => (i % 2 === 0 ? 0 : swing)),
    legMs,
    o,
  );
}

/** A hand held still at `x` from one time to another. */
function still(x: number, fromMs: number, toMs: number): Sample[] {
  return trace([x, x], toMs - fromMs, { startMs: fromMs });
}

/** Feeds the samples in order and returns the time of every sample that completed a wave. */
function feed(det: WaveDetector, samples: readonly Sample[]): number[] {
  const hits: number[] = [];
  for (const s of samples) if (det.push(s.x, s.y, s.t)) hits.push(s.t);
  return hits;
}

/** The hand sinks `rate` metres a second from 1.4 m. */
const sinking = (rate: number) => (t: number) => 1.4 - rate * (t / 1000);

describe("WaveDetector", () => {
  it("has the spec's tuned values", () => {
    expect(WAVE_DEFAULTS).toEqual({ minSwing: 0.05, flips: 3, windowMs: 1600, cooldownMs: 4000, maxDrop: 0.2 });
    expect(Object.isFrozen(WAVE_DEFAULTS)).toBe(true);
    expect(WAVE_JITTER).toBe(0.002);
    expect(new WaveDetector().options).toEqual(WAVE_DEFAULTS);
    expect(Object.isFrozen(new WaveDetector().options)).toBe(true);
  });

  describe("a wave", () => {
    it("triggers once on a 0.08 m wave of three flips inside a second", () => {
      const hits = feed(new WaveDetector(), waving(0.08, 250, 4));
      expect(hits).toHaveLength(1);
      // The third reversal is seen on the sample after the second peak, at 750 ms.
      expect(hits[0]).toBeGreaterThan(700);
      expect(hits[0]).toBeLessThan(800);
    });

    it("triggers on the sample that completes it and not before", () => {
      const det = new WaveDetector();
      const wave = waving(0.08, 250, 4);
      const firstHit = wave.findIndex((s) => det.push(s.x, s.y, s.t));
      expect(firstHit).toBe(46); // 46 x 16.7 ms = 767 ms
    });

    it("does not trigger again while the wave goes on", () => {
      expect(feed(new WaveDetector(), waving(0.08, 250, 12))).toHaveLength(1); // 3 s of waving
    });

    it("works to the left, and anywhere along the line", () => {
      expect(feed(new WaveDetector(), trace([0, -0.08, 0, -0.08, 0], 250))).toHaveLength(1);
      expect(feed(new WaveDetector(), trace([1.5, 1.58, 1.5, 1.58, 1.5], 250))).toHaveLength(1);
      expect(feed(new WaveDetector(), trace([-2, -1.92, -2, -1.92, -2], 250))).toHaveLength(1);
    });

    it("still triggers with a millimetre of noise on the hand", () => {
      const rand = seeded(7);
      const noisy = waving(0.08, 250, 4).map((s) => ({ ...s, x: s.x + (rand() * 2 - 1) * 0.001 }));
      const hits = feed(new WaveDetector(), noisy);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toBeGreaterThan(700);
      expect(hits[0]).toBeLessThan(900);
    });

    it("sees a slow wave whose every step is under 2 mm, because the drift adds up", () => {
      // 0.06 m in 600 ms is 1.7 mm a frame.
      const hits = feed(new WaveDetector(), waving(0.06, 600, 5));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toBeGreaterThan(1700);
      expect(hits[0]).toBeLessThan(2100);
    });

    it("needs each swing to be at least 5 cm", () => {
      expect(feed(new WaveDetector(), waving(0.051, 250, 6))).toHaveLength(1);
      expect(feed(new WaveDetector(), waving(0.049, 250, 6))).toEqual([]);
      expect(feed(new WaveDetector(), waving(0.02, 250, 12))).toEqual([]);
    });
  });

  describe("jitter", () => {
    it("ignores a hand that shakes by less than 2 mm", () => {
      const alternating: Sample[] = [];
      for (let i = 0; i < 600; i++) alternating.push({ x: i % 2 ? 0.0019 : 0, y: 1.2, t: i * STEP_MS });
      expect(feed(new WaveDetector(), alternating)).toEqual([]);

      const rand = seeded(5);
      const shaky: Sample[] = [];
      for (let i = 0; i < 600; i++) shaky.push({ x: (rand() * 2 - 1) * 0.0009, y: 1.2, t: i * STEP_MS });
      expect(feed(new WaveDetector(), shaky)).toEqual([]);
    });

    it("ignores jitter on a hand that is otherwise still", () => {
      // Two real swings and a flip, then the hand rests and shakes: no third flip comes of it.
      const rand = seeded(6);
      const rest = still(0.08, 760, 3000).map((s) => ({ ...s, x: s.x + (rand() * 2 - 1) * 0.0009 }));
      expect(feed(new WaveDetector(), [...trace([0, 0.08, 0, 0.08], 250), ...rest])).toEqual([]);
    });
  });

  describe("what is not a wave", () => {
    it("ignores a single swing, however long", () => {
      expect(feed(new WaveDetector(), trace([0, 0.3], 1000, { holdMs: 3000 }))).toEqual([]);
      expect(feed(new WaveDetector(), trace([0, 0.6], 200, { holdMs: 3000 }))).toEqual([]);
    });

    it("ignores one flip and two flips", () => {
      // Out and back: one reversal, at the far end.
      expect(feed(new WaveDetector(), trace([0, 0.08, 0], 250, { holdMs: 3000 }))).toEqual([]);
      // Out, back and out again: two reversals.
      expect(feed(new WaveDetector(), trace([0, 0.08, 0, 0.08], 250, { holdMs: 3000 }))).toEqual([]);
    });

    it("ignores a still hand", () => {
      expect(feed(new WaveDetector(), still(0.4, 0, 10000))).toEqual([]);
    });

    it("ignores a hand that drops while it wobbles", () => {
      // Falling at half a metre a second, it is 38 cm below its start by the third flip.
      expect(feed(new WaveDetector(), waving(0.08, 250, 8, { y: sinking(0.5) }))).toEqual([]);
    });

    it("still counts a hand that sinks slowly, or rises", () => {
      expect(feed(new WaveDetector(), waving(0.08, 250, 4, { y: sinking(0.05) }))).toHaveLength(1);
      expect(feed(new WaveDetector(), waving(0.08, 250, 4, { y: (t) => 1.2 + 0.5 * (t / 1000) }))).toHaveLength(1);
    });

    it("measures the drop from the highest point in the window, against 0.2 m", () => {
      // The hand sinks by `drop` metres by the time of the third flip at 767 ms.
      const sinksBy = (drop: number) => (t: number) => 1.4 - drop * Math.min(1, t / 766.6667);
      expect(feed(new WaveDetector(), waving(0.08, 250, 4, { y: sinksBy(0.15) }))).toHaveLength(1);
      expect(feed(new WaveDetector(), waving(0.08, 250, 4, { y: sinksBy(0.25) }))).toEqual([]);
    });

    it("needs the flips inside 1.6 s", () => {
      // Half a period of 0.7 s: three flips span 1.4 s.
      const quick = feed(new WaveDetector(), waving(0.2, 700, 4));
      expect(quick).toHaveLength(1);
      expect(quick[0]).toBeGreaterThan(2100);
      expect(quick[0]).toBeLessThan(2140);
      // Half a period of 0.9 s: any three flips span 1.8 s, so it never counts.
      expect(feed(new WaveDetector(), waving(0.2, 900, 8))).toEqual([]);
    });
  });

  describe("cooldown", () => {
    it("waits 4 s after a wave before the next one can count", () => {
      const hits = feed(new WaveDetector(), waving(0.08, 250, 36)); // 9 s of waving
      expect(hits).toHaveLength(2);
      expect(hits[1] - hits[0]).toBeGreaterThanOrEqual(4000);
    });

    it("blocks a second wave at 2-3 s and lets one through at 5-6 s", () => {
      const early = waving(0.08, 250, 4, { startMs: 2040 });
      const late = waving(0.08, 250, 4, { startMs: 4980 });
      const samples = [
        ...waving(0.08, 250, 4), //             0 - 1.0 s: a wave
        ...still(0, 1020, 2020),
        ...early, //                            2.0 - 3.0 s: a wave inside the cooldown
        ...still(0, 3060, 4960),
        ...late, //                             5.0 - 6.0 s: a wave after it
      ];
      const hits = feed(new WaveDetector(), samples);
      expect(hits).toHaveLength(2);
      expect(hits[0]).toBeGreaterThan(700);
      expect(hits[0]).toBeLessThan(800);
      expect(hits[1]).toBeGreaterThan(5700);
      expect(hits[1]).toBeLessThan(5800);
      // The wave at 2-3 s would have counted on its own.
      expect(feed(new WaveDetector(), early)).toHaveLength(1);
    });

    it("lets the next wave through right away with a cooldown of 0", () => {
      const hits = feed(new WaveDetector({ cooldownMs: 0 }), waving(0.08, 250, 16)); // 4 s
      expect(hits.length).toBeGreaterThanOrEqual(4);
      expect(hits[1] - hits[0]).toBeLessThan(1000);
    });
  });

  describe("gaps, resets and the clock", () => {
    it("keeps its progress over a short gap and forgets it over a long one", () => {
      const start = trace([0, 0.08, 0, 0.08], 250); // two flips so far, the hand at the second peak
      const turning = (t: number): Sample => ({ x: 0.08 - 0.08 / 15, y: 1.2, t }); // the third reversal
      // 750 ms of silence is inside the 1.6 s window: the third flip lands inside it.
      expect(feed(new WaveDetector(), [...start, turning(1500)])).toEqual([1500]);
      // 1750 ms of silence is not: it starts again from nothing.
      expect(feed(new WaveDetector(), [...start, turning(2500)])).toEqual([]);
    });

    it("reset() forgets the motion so far", () => {
      const wave = waving(0.08, 250, 4);
      expect(feed(new WaveDetector(), wave)).toHaveLength(1); // as a control
      const cut = wave.findIndex((s) => s.t > 600); // after two flips
      const det = new WaveDetector();
      feed(det, wave.slice(0, cut));
      det.reset();
      expect(feed(det, wave.slice(cut))).toEqual([]);
    });

    it("reset() leaves the cooldown alone", () => {
      const det = new WaveDetector();
      expect(feed(det, waving(0.08, 250, 4))).toHaveLength(1);
      det.reset();
      expect(feed(det, waving(0.08, 250, 4, { startMs: 1500 }))).toEqual([]);
    });

    it("treats a clock that goes back as a new timeline, cooldown included", () => {
      const det = new WaveDetector();
      const wave = waving(0.08, 250, 4);
      expect(feed(det, wave)).toHaveLength(1);
      expect(feed(det, wave)).toHaveLength(1); // the same times again, as in a new session
    });

    it("ignores samples that are not finite numbers", () => {
      const det = new WaveDetector();
      expect(det.push(Number.NaN, 1.2, 0)).toBe(false);
      expect(det.push(0, Number.POSITIVE_INFINITY, 0)).toBe(false);
      expect(det.push(0, 1.2, Number.NaN)).toBe(false);
      const wave = waving(0.08, 250, 4);
      const hits: number[] = [];
      wave.forEach((s, i) => {
        if (i % 7 === 3) det.push(Number.NaN, s.y, s.t); // bad samples in the middle change nothing
        if (det.push(s.x, s.y, s.t)) hits.push(s.t);
      });
      expect(hits).toHaveLength(1);
    });
  });

  describe("options", () => {
    it("takes overrides and keeps the rest", () => {
      const det = new WaveDetector({ flips: 2, maxDrop: 1 });
      expect(det.options).toEqual({ ...WAVE_DEFAULTS, flips: 2, maxDrop: 1 });
    });

    it("flips: two reversals are enough when asked", () => {
      const hits = feed(new WaveDetector({ flips: 2 }), waving(0.08, 250, 4));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toBeGreaterThan(500);
      expect(hits[0]).toBeLessThan(550);
    });

    it("minSwing: a bigger minimum asks for a bigger wave", () => {
      expect(feed(new WaveDetector({ minSwing: 0.1 }), waving(0.08, 250, 4))).toEqual([]);
      expect(feed(new WaveDetector({ minSwing: 0.1 }), waving(0.12, 250, 4))).toHaveLength(1);
    });

    it("windowMs: a shorter window asks for a quicker wave", () => {
      const slow = waving(0.1, 450, 8); // three flips span 0.9 s
      expect(feed(new WaveDetector(), slow)).toHaveLength(1);
      expect(feed(new WaveDetector({ windowMs: 800 }), slow)).toEqual([]);
    });

    it("maxDrop: a bigger allowance forgives a falling hand", () => {
      const falling = waving(0.08, 250, 4, { y: sinking(0.5) });
      expect(feed(new WaveDetector(), falling)).toEqual([]);
      expect(feed(new WaveDetector({ maxDrop: 1 }), falling)).toHaveLength(1);
    });
  });
});
