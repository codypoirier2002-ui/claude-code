// The clock sky (§8.6): five looks and the keyframes that blend between them.
// skyFor(hour) is pure. The renderer calls it every 30 s and feeds the result
// to the sky shader and the stars.

export type Rgb = readonly [r: number, g: number, b: number];

/** One sky look: the gradient colours (0-1 RGB) and how strong the aurora and the stars are. */
export interface SkyLook {
  readonly top: Rgb;
  readonly mid: Rgb;
  readonly horizon: Rgb;
  readonly aurora: number;
  readonly stars: number;
}

export type LookName = "NIGHT" | "DAWN" | "DAY" | "GOLDEN" | "DUSK";

function look(top: Rgb, mid: Rgb, horizon: Rgb, aurora: number, stars: number): SkyLook {
  return Object.freeze({
    top: Object.freeze(top) as Rgb,
    mid: Object.freeze(mid) as Rgb,
    horizon: Object.freeze(horizon) as Rgb,
    aurora,
    stars,
  });
}

export const LOOKS: Readonly<Record<LookName, SkyLook>> = Object.freeze({
  NIGHT: look([0.02, 0.035, 0.08], [0.06, 0.07, 0.14], [0.32, 0.18, 0.12], 1, 1),
  DAWN: look([0.16, 0.2, 0.36], [0.42, 0.36, 0.5], [0.95, 0.58, 0.42], 0.15, 0.25),
  DAY: look([0.2, 0.42, 0.72], [0.42, 0.62, 0.86], [0.74, 0.84, 0.92], 0, 0),
  GOLDEN: look([0.22, 0.32, 0.56], [0.6, 0.5, 0.52], [1, 0.62, 0.3], 0, 0),
  DUSK: look([0.06, 0.07, 0.18], [0.24, 0.16, 0.3], [0.78, 0.36, 0.26], 0.4, 0.6),
});

/** [hour, look] pairs. The sky eases from each look to the next between their hours. */
export const KEYFRAMES: readonly (readonly [hour: number, look: SkyLook])[] = Object.freeze(
  (
    [
      [0, LOOKS.NIGHT],
      [5, LOOKS.NIGHT],
      [6.5, LOOKS.DAWN],
      [9, LOOKS.DAY],
      [16.5, LOOKS.DAY],
      [18.5, LOOKS.GOLDEN],
      [20, LOOKS.DUSK],
      [21.5, LOOKS.NIGHT],
      [24, LOOKS.NIGHT],
    ] as const
  ).map((pair) => Object.freeze(pair)),
);

/** What skyFor returns: fresh values the caller may keep or change. */
export interface SkyColors {
  top: [number, number, number];
  mid: [number, number, number];
  horizon: [number, number, number];
  aurora: number;
  stars: number;
}

function smooth(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** a at s = 0 and b at s = 1, both exactly. */
function mix(a: number, b: number, s: number): number {
  return a * (1 - s) + b * s;
}

function mixRgb(a: Rgb, b: Rgb, s: number): [number, number, number] {
  return [mix(a[0], b[0], s), mix(a[1], b[1], s), mix(a[2], b[2], s)];
}

/** The hour wrapped into [0, 24). Anything that is not a finite number reads as midnight. */
function wrapHour(hour: number): number {
  if (!Number.isFinite(hour)) return 0;
  const h = hour % 24;
  return h < 0 ? h + 24 : h;
}

/**
 * The sky for a time of day, `hour` being the local hour as a fraction (18.5 is
 * 6:30 pm). It smoothsteps between the two neighbouring keyframes and wraps at
 * 24, so 24 is the same as 0.
 */
export function skyFor(hour: number): SkyColors {
  const h = wrapHour(hour);
  let i = 0;
  while (i < KEYFRAMES.length - 2 && h >= KEYFRAMES[i + 1][0]) i++;
  const [h0, a] = KEYFRAMES[i];
  const [h1, b] = KEYFRAMES[i + 1];
  // Between two keyframes with the same look nothing changes, so copy it exactly.
  const s = a === b ? 0 : smooth((h - h0) / (h1 - h0));
  return {
    top: mixRgb(a.top, b.top, s),
    mid: mixRgb(a.mid, b.mid, s),
    horizon: mixRgb(a.horizon, b.horizon, s),
    aurora: mix(a.aurora, b.aurora, s),
    stars: mix(a.stars, b.stars, s),
  };
}
