// Scene particles (§8.8): one fixed pool of 900 points, one draw call. The pool
// is built once; a scene change only updates the kind, the colour and the draw
// count. The motion runs in the vertex shader; the exported pure functions
// mirror it exactly so the formulas can be unit-tested.

import * as THREE from "three";
import type { ParticleKind } from "../core/environments";

export const PARTICLE_POOL = 900;
export const RING_INNER = 1.2;
export const RING_OUTER = 7;
export const PARTICLE_CEILING = 4;
/** Point size in px = clamp(size × 700 / −z, 1, 48). */
export const POINT_SCALE = 700;
export const POINT_MIN_PX = 1;
export const POINT_MAX_PX = 48;

const TAU = Math.PI * 2;
const KIND_INDEX: Record<ParticleKind, number> = { fireflies: 0, motes: 1, rain: 2 };

export interface ParticleBase {
  x: number;
  y: number;
  z: number;
}

export interface ParticleState extends ParticleBase {
  /** 0–1: the alpha the point is drawn with. */
  brightness: number;
  /** World-space size in metres, before the pixel conversion. */
  size: number;
}

const fract = (x: number): number => x - Math.floor(x);
/** GLSL mod(): always in [0, m). */
const mod = (x: number, m: number): number => x - m * Math.floor(x / m);
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Fireflies hover between 0.3 and 2.5 m. */
export const FIREFLY_LOW = 0.3;
export const FIREFLY_HIGH = 2.5;
/** Their lazy loops reach ±0.6 m. */
export const FIREFLY_LOOP = 0.6;
/** Motes drift ±0.3 m. */
export const MOTE_DRIFT = 0.3;

/** Fireflies: hover 0.3–2.5 m in lazy ±0.6 m loops; blink max(0, sin(t(.8 + s) + 40s))^6; size .05. */
export function fireflyState(base: ParticleBase, s: number, t: number): ParticleState {
  const hover = FIREFLY_LOW + (FIREFLY_HIGH - FIREFLY_LOW) * (base.y / PARTICLE_CEILING);
  return {
    x: base.x + FIREFLY_LOOP * Math.sin(t * (0.21 + 0.17 * s) + TAU * s),
    y: clamp(hover + 0.25 * Math.sin(t * (0.29 + 0.2 * s) + 17 * s), FIREFLY_LOW, FIREFLY_HIGH),
    z: base.z + FIREFLY_LOOP * Math.sin(t * (0.17 + 0.13 * s) + 11 * s + 1.5708),
    brightness: Math.pow(Math.max(0, Math.sin(t * (0.8 + s) + 40 * s)), 6),
    size: 0.05,
  };
}

/** A mote's rise speed: .03–.08 m/s. */
export function moteSpeed(s: number): number {
  return 0.03 + 0.05 * fract(s * 7.13);
}

/**
 * Motes: rise .03–.08 m/s, wrapping at 4 m, drifting ±0.3 m; twinkle
 * .35 + .65(.5 + .5 sin(.9t + 50s))³, faded near the floor and the ceiling; size .018–.038.
 */
export function moteState(base: ParticleBase, s: number, t: number): ParticleState {
  const y = mod(base.y + moteSpeed(s) * t, PARTICLE_CEILING);
  const tw = 0.5 + 0.5 * Math.sin(0.9 * t + 50 * s);
  const fade = smoothstep(0, 0.35, y) * (1 - smoothstep(PARTICLE_CEILING - 0.5, PARTICLE_CEILING, y));
  return {
    x: base.x + MOTE_DRIFT * Math.sin(0.23 * t + TAU * s),
    y,
    z: base.z + MOTE_DRIFT * Math.cos(0.19 * t + 9.1 * s),
    brightness: (0.35 + 0.65 * tw * tw * tw) * fade,
    size: 0.018 + 0.02 * fract(s * 3.71),
  };
}

/** A raindrop's fall speed: 6–8 m/s. */
export function rainSpeed(s: number): number {
  return 6 + 2 * fract(s * 5.17);
}

/** Rain: falls 6–8 m/s, wrapping from the floor back to 4 m; thin streaks at alpha .5; size .05. */
export function rainState(base: ParticleBase, s: number, t: number): ParticleState {
  return { x: base.x, y: mod(base.y - rainSpeed(s) * t, PARTICLE_CEILING), z: base.z, brightness: 0.5, size: 0.05 };
}

export function particleState(kind: ParticleKind, base: ParticleBase, s: number, t: number): ParticleState {
  if (kind === "fireflies") return fireflyState(base, s, t);
  if (kind === "rain") return rainState(base, s, t);
  return moteState(base, s, t);
}

/** Point size in px for a world size at view-space depth z (negative in front of the camera). */
export function pointSizePx(size: number, viewZ: number): number {
  return clamp((size * POINT_SCALE) / -viewZ, POINT_MIN_PX, POINT_MAX_PX);
}

/** The pool: a ring 1.2–7 m around the origin (uniform by area), y 0–4 m, one seed per point. Deterministic. */
export function particlePool(count = PARTICLE_POOL, seed = 11): { positions: Float32Array; seeds: Float32Array } {
  let st = seed >>> 0;
  const rnd = () => {
    st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
    return st / 4294967296;
  };
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const r0 = RING_INNER * RING_INNER;
  const r1 = RING_OUTER * RING_OUTER;
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt(r0 + (r1 - r0) * rnd());
    const a = rnd() * TAU;
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = rnd() * PARTICLE_CEILING;
    positions[i * 3 + 2] = Math.sin(a) * r;
    seeds[i] = rnd();
  }
  return { positions, seeds };
}

const PARTICLE_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uKind;
varying float vAlpha;
const float TAU = 6.283185307179586;
void main() {
  vec3 p = position;
  float s = aSeed;
  float t = uTime;
  float size;
  if (uKind < 0.5) {
    // fireflies
    float hover = 0.3 + 2.2 * (p.y / 4.0);
    p.x += 0.6 * sin(t * (0.21 + 0.17 * s) + TAU * s);
    p.y = clamp(hover + 0.25 * sin(t * (0.29 + 0.2 * s) + 17.0 * s), 0.3, 2.5);
    p.z += 0.6 * sin(t * (0.17 + 0.13 * s) + 11.0 * s + 1.5708);
    vAlpha = pow(max(0.0, sin(t * (0.8 + s) + 40.0 * s)), 6.0);
    size = 0.05;
  } else if (uKind < 1.5) {
    // motes
    float speed = 0.03 + 0.05 * fract(s * 7.13);
    p.y = mod(p.y + speed * t, 4.0);
    p.x += 0.3 * sin(0.23 * t + TAU * s);
    p.z += 0.3 * cos(0.19 * t + 9.1 * s);
    float tw = 0.5 + 0.5 * sin(0.9 * t + 50.0 * s);
    float fade = smoothstep(0.0, 0.35, p.y) * (1.0 - smoothstep(3.5, 4.0, p.y));
    vAlpha = (0.35 + 0.65 * tw * tw * tw) * fade;
    size = 0.018 + 0.02 * fract(s * 3.71);
  } else {
    // rain
    float speed = 6.0 + 2.0 * fract(s * 5.17);
    p.y = mod(p.y - speed * t, 4.0);
    vAlpha = 0.5;
    size = 0.05;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(size * 700.0 / -mv.z, 1.0, 48.0);
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uKind;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float shape;
  if (uKind > 1.5) {
    // a thin vertical streak
    shape = (1.0 - smoothstep(0.03, 0.09, abs(p.x))) * (1.0 - smoothstep(0.3, 0.5, abs(p.y)));
  } else {
    float r = length(p);
    shape = smoothstep(0.5, 0.0, r);
    shape *= shape;
  }
  float a = vAlpha * shape;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}`;

export interface SceneParticles {
  points: THREE.Points;
  /** A scene change: only the kind, the colour and the draw count change. */
  setScene(p: { kind: ParticleKind; color: number; count: number }): void;
  update(time: number): void;
  setVisible(on: boolean): void;
  dispose(): void;
}

/** The colour as raw sRGB components: the shader outputs display colours, like the sky. */
export function rawRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

export function createParticles(): SceneParticles {
  const { positions, seeds } = particlePool();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geo.setDrawRange(0, 0);
  const uniforms = {
    uTime: { value: 0 },
    uKind: { value: KIND_INDEX.motes },
    uColor: { value: new THREE.Vector3(1, 1, 1) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const points = new THREE.Points(geo, material);
  points.name = "scene-particles";
  points.frustumCulled = false;
  points.renderOrder = -7;

  return {
    points,
    setScene({ kind, color, count }): void {
      uniforms.uKind.value = KIND_INDEX[kind];
      uniforms.uColor.value.set(...rawRgb(color));
      geo.setDrawRange(0, Math.max(0, Math.min(PARTICLE_POOL, Math.round(count))));
    },
    update(time: number): void {
      uniforms.uTime.value = time;
    },
    setVisible(on: boolean): void {
      points.visible = on;
    },
    dispose(): void {
      geo.dispose();
      material.dispose();
    },
  };
}
