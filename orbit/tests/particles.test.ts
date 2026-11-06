import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  PARTICLE_POOL,
  createParticles,
  fireflyState,
  moteSpeed,
  moteState,
  particlePool,
  particleState,
  pointSizePx,
  rainSpeed,
  rainState,
  rawRgb,
} from "../src/xr/particles";

const seeds = Array.from({ length: 50 }, (_, i) => (i + 0.5) / 50);
const times = [0, 0.37, 1, 5.5, 33, 240, 3600];

describe("particle pool (§8.8)", () => {
  it("holds 900 points in a 1.2–7 m ring, 0–4 m high, each with a seed", () => {
    const { positions, seeds: s } = particlePool();
    expect(positions.length).toBe(PARTICLE_POOL * 3);
    expect(s.length).toBe(900);
    for (let i = 0; i < PARTICLE_POOL; i++) {
      const r = Math.hypot(positions[i * 3], positions[i * 3 + 2]);
      expect(r).toBeGreaterThanOrEqual(1.2 - 1e-5);
      expect(r).toBeLessThanOrEqual(7 + 1e-5);
      expect(positions[i * 3 + 1]).toBeGreaterThanOrEqual(0);
      expect(positions[i * 3 + 1]).toBeLessThan(4);
      expect(s[i]).toBeGreaterThanOrEqual(0);
      expect(s[i]).toBeLessThan(1);
    }
  });

  it("only updates kind, colour and draw count on a scene change", () => {
    const p = createParticles();
    const geo = p.points.geometry;
    const positions = geo.getAttribute("position");
    const mat = p.points.material as THREE.ShaderMaterial;
    p.setScene({ kind: "rain", color: 0xd8c8ff, count: 700 });
    expect(geo.drawRange.count).toBe(700);
    expect(mat.uniforms.uKind.value).toBe(2);
    p.setScene({ kind: "fireflies", color: 0xd8ff8a, count: 90 });
    expect(geo.drawRange.count).toBe(90);
    expect(mat.uniforms.uKind.value).toBe(0);
    expect(mat.uniforms.uColor.value.toArray()).toEqual(rawRgb(0xd8ff8a));
    expect(geo.getAttribute("position")).toBe(positions);
    p.setScene({ kind: "motes", color: 0xfff4d0, count: 5000 });
    expect(geo.drawRange.count).toBe(900);
    expect(mat.depthWrite).toBe(false);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    p.dispose();
  });

  it("keeps colours as raw sRGB", () => {
    expect(rawRgb(0xff8000)).toEqual([1, 128 / 255, 0]);
  });
});

describe("point size", () => {
  it("is clamp(size × 700 / −z, 1, 48) px", () => {
    expect(pointSizePx(0.05, -1)).toBeCloseTo(35);
    expect(pointSizePx(0.05, -0.5)).toBe(48);
    expect(pointSizePx(0.018, -20)).toBe(1);
    expect(pointSizePx(0.038, -7)).toBeCloseTo(3.8);
  });
});

describe("fireflies", () => {
  it("hover 0.3–2.5 m in lazy loops of at most ±0.6 m", () => {
    for (const s of seeds) {
      for (const t of times) {
        const f = fireflyState({ x: 3, y: s * 4, z: -2 }, s, t);
        expect(f.y).toBeGreaterThanOrEqual(0.3);
        expect(f.y).toBeLessThanOrEqual(2.5);
        expect(Math.abs(f.x - 3)).toBeLessThanOrEqual(0.6 + 1e-9);
        expect(Math.abs(f.z + 2)).toBeLessThanOrEqual(0.6 + 1e-9);
        expect(f.size).toBe(0.05);
      }
    }
  });

  it("blink as max(0, sin(t(.8 + s) + 40s))^6", () => {
    const s = 0.3;
    for (const t of times) {
      const expected = Math.pow(Math.max(0, Math.sin(t * (0.8 + s) + 40 * s)), 6);
      expect(fireflyState({ x: 0, y: 1, z: 0 }, s, t).brightness).toBeCloseTo(expected, 12);
    }
    // Dark while the sine is negative.
    const tDark = (1.5 * Math.PI - 40 * s + 2 * Math.PI * 10) / (0.8 + s);
    expect(fireflyState({ x: 0, y: 1, z: 0 }, s, tDark).brightness).toBe(0);
  });
});

describe("motes", () => {
  it("rise .03–.08 m/s, drift at most ±0.3 m and wrap at 4 m", () => {
    for (const s of seeds) {
      expect(moteSpeed(s)).toBeGreaterThanOrEqual(0.03);
      expect(moteSpeed(s)).toBeLessThan(0.08);
      const a = moteState({ x: 0, y: 1, z: 0 }, s, 0);
      const b = moteState({ x: 0, y: 1, z: 0 }, s, 1);
      expect(b.y - a.y).toBeCloseTo(moteSpeed(s), 9);
      for (const t of times) {
        const m = moteState({ x: 0, y: 3.9, z: 0 }, s, t);
        expect(m.y).toBeGreaterThanOrEqual(0);
        expect(m.y).toBeLessThan(4);
        expect(Math.abs(m.x)).toBeLessThanOrEqual(0.3 + 1e-9);
        expect(Math.abs(m.z)).toBeLessThanOrEqual(0.3 + 1e-9);
        expect(m.size).toBeGreaterThanOrEqual(0.018);
        expect(m.size).toBeLessThanOrEqual(0.038);
        expect(m.brightness).toBeGreaterThanOrEqual(0);
        expect(m.brightness).toBeLessThanOrEqual(1);
      }
    }
    // 3.9 m plus .2 m of rise wraps to .1 m.
    const s = seeds[0];
    expect(moteState({ x: 0, y: 3.9, z: 0 }, s, 0.2 / moteSpeed(s)).y).toBeCloseTo(0.1, 6);
  });

  it("twinkle .35 + .65(.5 + .5 sin(.9t + 50s))³ mid-air, fading at the floor and ceiling", () => {
    const s = 0.61;
    const tw = 0.5 + 0.5 * Math.sin(50 * s);
    const mid = moteState({ x: 0, y: 2, z: 0 }, s, 0).brightness;
    expect(mid).toBeCloseTo(0.35 + 0.65 * tw ** 3, 12);
    expect(moteState({ x: 0, y: 0, z: 0 }, s, 0).brightness).toBe(0);
    expect(moteState({ x: 0, y: 0.1, z: 0 }, s, 0).brightness).toBeLessThan(mid);
    expect(moteState({ x: 0, y: 3.95, z: 0 }, s, 0).brightness).toBeLessThan(mid);
  });
});

describe("rain", () => {
  it("falls 6–8 m/s as streaks at alpha .5, wrapping back to the top", () => {
    for (const s of seeds) {
      expect(rainSpeed(s)).toBeGreaterThanOrEqual(6);
      expect(rainSpeed(s)).toBeLessThan(8);
      const a = rainState({ x: 1, y: 3.5, z: 1 }, s, 0);
      const b = rainState({ x: 1, y: 3.5, z: 1 }, s, 0.1);
      expect(a.y - b.y).toBeCloseTo(rainSpeed(s) * 0.1, 9);
      for (const t of times) {
        const r = rainState({ x: 1, y: 3.5, z: 1 }, s, t);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeLessThan(4);
        expect(r.brightness).toBe(0.5);
        expect(r.size).toBe(0.05);
        expect(r.x).toBe(1);
      }
    }
  });

  it("dispatches by kind", () => {
    const base = { x: 0, y: 1, z: 0 };
    expect(particleState("rain", base, 0.2, 1)).toEqual(rainState(base, 0.2, 1));
    expect(particleState("motes", base, 0.2, 1)).toEqual(moteState(base, 0.2, 1));
    expect(particleState("fireflies", base, 0.2, 1)).toEqual(fireflyState(base, 0.2, 1));
  });
});
