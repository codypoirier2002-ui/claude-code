// The clock sky, the stars and the floor (§8.6, scene "Follows the clock").
// All three stay fixed in world space. Uniforms come from core/sky.ts's
// skyFor(hour) and refresh only every 30 s (§14); the per-frame work is a time
// uniform. Panorama scenes run their shader on the same sphere through
// setPanoramaMaterial() and hides the stars and floor through showClock(false).

import * as THREE from "three";
import { skyFor, type SkyColors } from "../core/sky";

export const SKY_RADIUS = 60;
export const STAR_COUNT = 1400;
export const STAR_RADIUS = 50;
export const FLOOR_RADIUS = 14;
/** How often the sky colours follow the clock (§8.6). */
export const SKY_REFRESH_S = 30;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Output is raw sRGB: the look colours are display colours.
const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform float uAurora;
uniform float uTime;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float up = max(y, 0.0);
  // horizon -> mid -> top by height
  vec3 c = mix(uHorizon, uMid, smoothstep(0.0, 0.22, up));
  c = mix(c, uTop, smoothstep(0.18, 0.8, up));
  // the aurora band
  float wave = 0.08 * (0.5 * sin(3.0 * d.x + 0.05 * uTime) + 0.5 * sin(4.0 * d.z - 0.07 * uTime));
  float band = smoothstep(0.15, 0.0, abs(y - 0.35 - wave));
  c += vec3(0.12, 0.42, 0.36) * 0.35 * uAurora * band;
  // darker below the horizon
  c *= mix(1.0, 0.22, smoothstep(0.0, -0.25, y));
  gl_FragColor = vec4(c, 1.0);
}`;

const STAR_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uStars;
uniform float uScale;
varying float vAlpha;
void main() {
  float tw = 0.55 + 0.45 * sin(uTime * (0.8 + 2.2 * aSeed) + aSeed * 61.0);
  vAlpha = uStars * tw * (0.55 + 0.45 * fract(aSeed * 7.31));
  gl_PointSize = (1.6 + 2.4 * fract(aSeed * 3.77)) * uScale;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const STAR_FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float a = vAlpha * smoothstep(0.5, 0.1, length(p));
  if (a < 0.003) discard;
  gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * a, a);
}`;

const FLOOR_VERT = /* glsl */ `
varying vec2 vXZ;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vXZ = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FLOOR_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uGlow;
uniform vec3 uBase;
varying vec2 vXZ;
void main() {
  float r = length(vXZ);
  float aa = max(fwidth(r), 1e-4);
  // warm glow near the user, gone by 9 m
  float glow = 1.0 - smoothstep(0.0, 9.0, r);
  glow *= glow;
  // thin rings every metre, expanding at 5 cm/s
  float ph = fract(r - 0.05 * uTime);
  float dr = min(ph, 1.0 - ph);
  float ring = (1.0 - smoothstep(0.0, aa * 1.5 + 0.004, dr)) * (1.0 - smoothstep(1.0, 11.0, r));
  // faint grid dots every half metre
  vec2 g = (fract(vXZ * 2.0 + 0.5) - 0.5) * 0.5;
  float gaa = max(fwidth(vXZ.x), 1e-4);
  float dots = (1.0 - smoothstep(0.006, 0.006 + gaa * 1.5, length(g))) * (1.0 - smoothstep(2.0, 10.0, r));
  vec3 c = uBase + uGlow * (0.20 * glow + 0.22 * ring) + vec3(0.9, 0.85, 0.75) * 0.12 * dots;
  float edge = 1.0 - smoothstep(FLOOR_R - 4.0, FLOOR_R, r);
  float a = edge * (0.82 + 0.18 * glow);
  gl_FragColor = vec4(c, a);
}`;

export interface ClockSky {
  /** The inside-out sphere. Panorama scenes swap its material for the panorama shader. */
  sphere: THREE.Mesh;
  stars: THREE.Points;
  floor: THREE.Mesh;
  /** Everything above, for adding to the scene. */
  group: THREE.Group;
  /** Every frame: time uniforms, and the colours every 30 s. */
  update(time: number, now?: number): void;
  /** The hour the sky follows: the override, or the local clock. */
  hour(now?: number): number;
  /** Re-read skyFor right away (after an hour override changes). */
  refresh(now?: number): void;
  setHourOverride(hour: number | null): void;
  /** A panorama material on the sphere, or null for the clock sky. */
  setPanoramaMaterial(material: THREE.Material | null): void;
  /** The clock look (stars, floor, sphere at the origin) or the panorama look (sphere at y 1.6, no stars or floor). */
  showClock(on: boolean): void;
  /** Passthrough hides the whole environment. */
  setVisible(on: boolean): void;
  /** Point size scale (XR eye buffers are bigger than the preview canvas). */
  setStarScale(scale: number): void;
  current(): SkyColors;
  dispose(): void;
}

export function localHour(now: number = Date.now()): number {
  const d = new Date(now);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

/** 1400 directions above the horizon at radius 50, each with a seed. Deterministic. */
export function starPositions(count = STAR_COUNT, radius = STAR_RADIUS, seed = 7): { positions: Float32Array; seeds: Float32Array } {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Uniform over the upper cap, kept a little above the horizon glow.
    const y = 0.04 + 0.96 * rnd();
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    positions[i * 3] = Math.cos(a) * r * radius;
    positions[i * 3 + 1] = y * radius;
    positions[i * 3 + 2] = Math.sin(a) * r * radius;
    seeds[i] = rnd();
  }
  return { positions, seeds };
}

export function createClockSky(opts: { hour?: number | null } = {}): ClockSky {
  let hourOverride = opts.hour ?? null;
  let colors = skyFor(hourOverride ?? localHour());
  let lastRefresh = -Infinity;

  const skyUniforms = {
    uTop: { value: new THREE.Vector3(...colors.top) },
    uMid: { value: new THREE.Vector3(...colors.mid) },
    uHorizon: { value: new THREE.Vector3(...colors.horizon) },
    uAurora: { value: colors.aurora },
    uTime: { value: 0 },
  };
  const clockMaterial = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
  });
  const sphere = new THREE.Mesh<THREE.SphereGeometry, THREE.Material>(new THREE.SphereGeometry(SKY_RADIUS, 48, 32), clockMaterial);
  sphere.renderOrder = -10;
  sphere.frustumCulled = false;

  // ---- Stars: one draw call ----
  const { positions, seeds } = starPositions();
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  starGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  const starUniforms = { uTime: { value: 0 }, uStars: { value: colors.stars }, uScale: { value: 1 } };
  const stars = new THREE.Points(
    starGeo,
    new THREE.ShaderMaterial({
      uniforms: starUniforms,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  stars.renderOrder = -9;
  stars.frustumCulled = false;

  // ---- Floor ----
  const floorUniforms = {
    uTime: { value: 0 },
    uGlow: { value: new THREE.Vector3(1.0, 0.68, 0.4) },
    uBase: { value: new THREE.Vector3(0.035, 0.04, 0.055) },
  };
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(FLOOR_RADIUS, 96),
    new THREE.ShaderMaterial({
      uniforms: floorUniforms,
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      defines: { FLOOR_R: FLOOR_RADIUS.toFixed(1) },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.renderOrder = -8;

  const group = new THREE.Group();
  group.name = "clock-sky";
  group.add(sphere, stars, floor);

  function apply(c: SkyColors): void {
    colors = c;
    skyUniforms.uTop.value.set(...c.top);
    skyUniforms.uMid.value.set(...c.mid);
    skyUniforms.uHorizon.value.set(...c.horizon);
    skyUniforms.uAurora.value = c.aurora;
    starUniforms.uStars.value = c.stars;
    // The floor glow warms with the horizon.
    floorUniforms.uGlow.value.set(0.55 + 0.45 * c.horizon[0], 0.45 + 0.4 * c.horizon[1], 0.3 + 0.3 * c.horizon[2]);
    // ...and the floor itself picks up a little of the sky.
    floorUniforms.uBase.value.set(0.02 + 0.09 * c.horizon[0], 0.022 + 0.09 * c.horizon[1], 0.03 + 0.09 * c.horizon[2]);
  }

  function hour(now = Date.now()): number {
    return hourOverride ?? localHour(now);
  }

  function refresh(now = Date.now()): void {
    apply(skyFor(hour(now)));
  }

  return {
    sphere,
    stars,
    floor,
    group,
    hour,
    refresh,
    update(time: number, now = Date.now()): void {
      skyUniforms.uTime.value = time;
      starUniforms.uTime.value = time;
      floorUniforms.uTime.value = time;
      if (time - lastRefresh >= SKY_REFRESH_S || time < lastRefresh) {
        lastRefresh = time;
        refresh(now);
      }
    },
    setHourOverride(h: number | null): void {
      hourOverride = h;
      refresh();
    },
    setPanoramaMaterial(material: THREE.Material | null): void {
      sphere.material = material ?? clockMaterial;
    },
    showClock(on: boolean): void {
      stars.visible = on;
      floor.visible = on;
      sphere.position.y = on ? 0 : 1.6;
    },
    setVisible(on: boolean): void {
      group.visible = on;
    },
    setStarScale(scale: number): void {
      starUniforms.uScale.value = scale;
    },
    current: () => colors,
    dispose(): void {
      sphere.geometry.dispose();
      clockMaterial.dispose();
      starGeo.dispose();
      (stars.material as THREE.Material).dispose();
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
    },
  };
}
