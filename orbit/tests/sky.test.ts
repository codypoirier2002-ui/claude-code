import { describe, expect, it } from "vitest";
import { KEYFRAMES, LOOKS, skyFor, type SkyColors, type SkyLook } from "../src/core/sky";

/** A SkyColors as plain numbers, for comparing with a look. */
function flat(s: SkyColors | SkyLook): number[] {
  return [...s.top, ...s.mid, ...s.horizon, s.aurora, s.stars];
}

function expectLook(actual: SkyColors, look: SkyLook): void {
  expect(actual).toEqual({ top: [...look.top], mid: [...look.mid], horizon: [...look.horizon], aurora: look.aurora, stars: look.stars });
}

describe("sky looks (§8.6)", () => {
  it("has the five looks with the tuned colours", () => {
    expect(Object.keys(LOOKS)).toEqual(["NIGHT", "DAWN", "DAY", "GOLDEN", "DUSK"]);
    expect(LOOKS.NIGHT).toEqual({ top: [0.02, 0.035, 0.08], mid: [0.06, 0.07, 0.14], horizon: [0.32, 0.18, 0.12], aurora: 1, stars: 1 });
    expect(LOOKS.DAWN).toEqual({ top: [0.16, 0.2, 0.36], mid: [0.42, 0.36, 0.5], horizon: [0.95, 0.58, 0.42], aurora: 0.15, stars: 0.25 });
    expect(LOOKS.DAY).toEqual({ top: [0.2, 0.42, 0.72], mid: [0.42, 0.62, 0.86], horizon: [0.74, 0.84, 0.92], aurora: 0, stars: 0 });
    expect(LOOKS.GOLDEN).toEqual({ top: [0.22, 0.32, 0.56], mid: [0.6, 0.5, 0.52], horizon: [1, 0.62, 0.3], aurora: 0, stars: 0 });
    expect(LOOKS.DUSK).toEqual({ top: [0.06, 0.07, 0.18], mid: [0.24, 0.16, 0.3], horizon: [0.78, 0.36, 0.26], aurora: 0.4, stars: 0.6 });
  });

  it("has the nine keyframes in the documented order", () => {
    expect(KEYFRAMES.map(([hour]) => hour)).toEqual([0, 5, 6.5, 9, 16.5, 18.5, 20, 21.5, 24]);
    expect(KEYFRAMES.map(([, look]) => look)).toEqual([
      LOOKS.NIGHT,
      LOOKS.NIGHT,
      LOOKS.DAWN,
      LOOKS.DAY,
      LOOKS.DAY,
      LOOKS.GOLDEN,
      LOOKS.DUSK,
      LOOKS.NIGHT,
      LOOKS.NIGHT,
    ]);
  });

  it("keeps every colour channel in 0-1", () => {
    for (const look of Object.values(LOOKS)) for (const v of flat(look)) expect(v >= 0 && v <= 1).toBe(true);
  });
});

describe("skyFor", () => {
  it("returns the look exactly at each keyframe hour", () => {
    expectLook(skyFor(0), LOOKS.NIGHT);
    expectLook(skyFor(5), LOOKS.NIGHT);
    expectLook(skyFor(6.5), LOOKS.DAWN);
    expectLook(skyFor(9), LOOKS.DAY);
    expectLook(skyFor(16.5), LOOKS.DAY);
    expectLook(skyFor(18.5), LOOKS.GOLDEN);
    expectLook(skyFor(20), LOOKS.DUSK);
    expectLook(skyFor(21.5), LOOKS.NIGHT);
    expectLook(skyFor(24), LOOKS.NIGHT);
  });

  it("holds a look between two keyframes of the same look", () => {
    expectLook(skyFor(2.5), LOOKS.NIGHT);
    expectLook(skyFor(12), LOOKS.DAY);
    expectLook(skyFor(16.4), LOOKS.DAY);
    expectLook(skyFor(22.7), LOOKS.NIGHT);
    expectLook(skyFor(23.999), LOOKS.NIGHT);
  });

  it("blends at the mid-point of a segment", () => {
    // 7.75 is half way from DAWN (6.5) to DAY (9); smoothstep(0.5) is 0.5.
    const mid = flat(skyFor(7.75));
    const a = flat(LOOKS.DAWN);
    const b = flat(LOOKS.DAY);
    mid.forEach((v, i) => expect(v).toBeCloseTo((a[i] + b[i]) / 2, 12));
    expect(skyFor(7.75).aurora).toBeCloseTo(0.075, 12);
    expect(skyFor(7.75).stars).toBeCloseTo(0.125, 12);
    // 19.25 is half way from GOLDEN (18.5) to DUSK (20).
    const g = flat(LOOKS.GOLDEN);
    const d = flat(LOOKS.DUSK);
    flat(skyFor(19.25)).forEach((v, i) => expect(v).toBeCloseTo((g[i] + d[i]) / 2, 12));
  });

  it("smoothsteps rather than blending linearly", () => {
    // A quarter of the way from DAWN (6.5) to DAY (9): s = smoothstep(0.25) = 0.15625, not 0.25.
    const hour = 6.5 + 0.25 * 2.5;
    const s = 0.25 * 0.25 * (3 - 2 * 0.25);
    expect(s).toBeCloseTo(0.15625, 12);
    const got = skyFor(hour);
    expect(got.top[0]).toBeCloseTo(LOOKS.DAWN.top[0] * (1 - s) + LOOKS.DAY.top[0] * s, 12);
    expect(got.horizon[2]).toBeCloseTo(LOOKS.DAWN.horizon[2] * (1 - s) + LOOKS.DAY.horizon[2] * s, 12);
    expect(got.stars).toBeCloseTo(0.25 * (1 - s), 12);
    // Slow start and slow finish: the same distance from either end moves the colour symmetrically.
    const nearStart = skyFor(6.5 + 0.1 * 2.5).top[0] - LOOKS.DAWN.top[0];
    const nearEnd = LOOKS.DAY.top[0] - skyFor(6.5 + 0.9 * 2.5).top[0];
    expect(nearStart).toBeCloseTo(nearEnd, 12);
    expect(nearStart).toBeLessThan(0.1 * (LOOKS.DAY.top[0] - LOOKS.DAWN.top[0]));
  });

  it("fades the stars and the aurora in at dusk and out at dawn", () => {
    const hours = [18.5, 19, 19.5, 20, 20.5, 21, 21.5];
    const stars = hours.map((h) => skyFor(h).stars);
    expect(stars[0]).toBe(0);
    expect(stars[stars.length - 1]).toBe(1);
    for (let i = 1; i < stars.length; i++) expect(stars[i]).toBeGreaterThan(stars[i - 1]);
    expect(skyFor(6.5).aurora).toBeCloseTo(0.15, 12);
    expect(skyFor(5.75).aurora).toBeLessThan(1);
    expect(skyFor(5.75).aurora).toBeGreaterThan(0.15);
  });

  it("wraps at 24 hours", () => {
    expect(skyFor(24)).toEqual(skyFor(0));
    expect(skyFor(25)).toEqual(skyFor(1));
    expect(skyFor(24 + 7.75)).toEqual(skyFor(7.75));
    expect(skyFor(48)).toEqual(skyFor(0));
    expect(skyFor(-1)).toEqual(skyFor(23));
    expect(skyFor(-24 + 19.25)).toEqual(skyFor(19.25));
  });

  it("reads anything that is not a finite number as midnight", () => {
    expectLook(skyFor(Number.NaN), LOOKS.NIGHT);
    expectLook(skyFor(Number.POSITIVE_INFINITY), LOOKS.NIGHT);
    expectLook(skyFor(Number.NEGATIVE_INFINITY), LOOKS.NIGHT);
  });

  it("moves smoothly through the whole day and stays inside 0-1", () => {
    let prev = flat(skyFor(0));
    for (let i = 1; i <= 24 * 60; i++) {
      const now = flat(skyFor(i / 60));
      now.forEach((v, k) => {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        // No channel jumps by more than 0.02 in a minute (the steepest ramp, dusk to night, is under 0.01).
        expect(Math.abs(v - prev[k])).toBeLessThan(0.02);
      });
      prev = now;
    }
  });

  it("returns fresh values, so changing one never touches the looks", () => {
    const a = skyFor(9);
    a.top[0] = 99;
    a.aurora = 99;
    expect(skyFor(9).top[0]).toBe(LOOKS.DAY.top[0]);
    expect(skyFor(9).aurora).toBe(0);
    expect(LOOKS.DAY.top[0]).toBe(0.2);
    expect(skyFor(9).top).not.toBe(skyFor(9).top);
  });
});
