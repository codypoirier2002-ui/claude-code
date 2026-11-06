// The orb (§8.10): a noise-displaced icosphere with a two-colour Fresnel
// shader, an additive billboard glow 6r across and 160 orbiting motes (one draw
// call). It swells with the audio level and eases between four moods over about
// a third of a second. mountOrbView() renders it on its own in a 2D container.

import * as THREE from "three";
import type { OrbMood } from "./bridge";

export type { OrbMood };

export const ORB_RADIUS = 0.11;
export const ORB_DETAIL = 24;
export const MOTE_COUNT = 160;

export interface MoodLook {
  warm: string;
  cool: string;
  speed: number;
  bumps: number;
}

/** §8.10, exactly. */
export const MOODS: Readonly<Record<OrbMood, MoodLook>> = Object.freeze({
  idle: { warm: "#ffb547", cool: "#7fd8c4", speed: 0.35, bumps: 0.06 },
  listening: { warm: "#9ff5e2", cool: "#3fb8ff", speed: 0.6, bumps: 0.08 },
  thinking: { warm: "#ffc46b", cool: "#b48cff", speed: 1.6, bumps: 0.12 },
  speaking: { warm: "#ffd28a", cool: "#ff8a5c", speed: 0.9, bumps: 0.1 },
});

/** Easing rate per second: ~95% of the way in 1/3 s. */
const MOOD_RATE = 9;

/** The §8.10 "In VR" mapping. */
export function orbMood(v: { voiceState: string; ttsPlaying: boolean; busy: boolean }): OrbMood {
  if (v.voiceState === "listening") return "listening";
  if (v.voiceState === "speaking" || v.ttsPlaying) return "speaking";
  if (v.voiceState === "transcribing" || v.voiceState === "thinking" || v.busy) return "thinking";
  return "idle";
}

/** The mic level, or her voice's level when the mic is quiet. */
export function orbLevel(micLevel: number, ttsLevel: number): number {
  return micLevel > 0.02 ? micLevel : ttsLevel;
}

// Ashima/Stefan Gustavson 3D simplex noise (MIT).
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const BODY_VERT = /* glsl */ `
uniform float uTime;
uniform float uBumps;
varying vec3 vNormal;
varying vec3 vView;
varying float vNoise;
${NOISE}
void main() {
  vec3 n = normalize(normal);
  float k = snoise(n * 1.8 + vec3(0.0, uTime, 0.0)) * 0.7 + snoise(n * 3.6 - vec3(uTime * 0.7)) * 0.3;
  vNoise = k;
  vec3 p = position * (1.0 + uBumps * k);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNormal = normalize(normalMatrix * n);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const BODY_FRAG = /* glsl */ `
uniform vec3 uWarm;
uniform vec3 uCool;
uniform float uLevel;
varying vec3 vNormal;
varying vec3 vView;
varying float vNoise;
void main() {
  vec3 n = normalize(vNormal);
  float f = 1.0 - max(dot(n, normalize(vView)), 0.0);
  float fres = pow(f, 1.5);
  vec3 c = mix(uWarm, uCool, smoothstep(0.12, 0.95, fres + 0.16 * vNoise));
  // a soft inner light, a little brighter from above, and a cool rim
  c *= 0.72 + 0.4 * pow(1.0 - f, 1.4) + 0.12 * n.y + 0.25 * uLevel;
  c += uCool * pow(f, 3.0) * 0.55;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

const GLOW_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // A billboard that faces the eye's position (not the screen), so it stays
  // concentric with the sphere under wide-angle perspective.
  vec3 c = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float s = length(modelMatrix[0].xyz);
  vec3 toEye = normalize(cameraPosition - c);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toEye));
  vec3 up = cross(toEye, right);
  vec3 w = c + (right * position.x + up * position.y) * s;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const GLOW_FRAG = /* glsl */ `
uniform vec3 uWarm;
uniform vec3 uCool;
uniform float uLevel;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(max(1.0 - d, 0.0), 2.2) * (0.45 + 0.4 * uLevel);
  vec3 c = mix(uWarm, uCool, smoothstep(0.1, 0.9, d));
  gl_FragColor = vec4(c, a); // additive: adds c * a
  #include <colorspace_fragment>
}`;

const MOTE_VERT = /* glsl */ `
attribute vec3 aOrbit; // radius factor, speed, phase
attribute float aTilt;
uniform float uTime;
uniform float uRadius;
uniform float uPx;
uniform float uLevel;
varying float vA;
void main() {
  float r = uRadius * aOrbit.x * (1.0 + 0.25 * uLevel);
  float ang = aOrbit.z + uTime * aOrbit.y;
  vec3 p = vec3(cos(ang) * r, sin(ang * 1.7 + aTilt * 6.0) * r * 0.18, sin(ang) * r);
  float ct = cos(aTilt), st = sin(aTilt);
  p = vec3(p.x, p.y * ct - p.z * st, p.y * st + p.z * ct);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vA = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 2.0 + aOrbit.z * 9.0));
  gl_PointSize = clamp(uPx * 0.006 / -mv.z, 1.0, 12.0);
  gl_Position = projectionMatrix * mv;
}`;

const MOTE_FRAG = /* glsl */ `
uniform vec3 uWarm;
varying float vA;
void main() {
  float a = vA * smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(uWarm, vec3(1.0), 0.35) * a, a);
  #include <colorspace_fragment>
}`;

export interface Orb {
  /** Add this to the rig; move it to place the orb. */
  group: THREE.Group;
  /** An invisible sphere a little bigger than the orb, for raycasts. */
  hitTarget: THREE.Mesh;
  /** Every frame. dt in seconds (already clamped by the caller). */
  update(dt: number, mood: OrbMood, level: number): void;
  /** Motes' point size scale: roughly the render target height in px. */
  setPixelScale(px: number): void;
  /** A short swell (the celebration, alongside her cheer). */
  pulse(): void;
  dispose(): void;
}

export function createOrb(radius = ORB_RADIUS): Orb {
  const warm = new THREE.Color(MOODS.idle.warm);
  const cool = new THREE.Color(MOODS.idle.cool);
  const target = { warm: new THREE.Color(), cool: new THREE.Color() };
  let speed = MOODS.idle.speed;
  let bumps = MOODS.idle.bumps;
  let level = 0;
  let time = 0;
  let pulseLeft = 0;

  const shared = {
    uWarm: { value: warm },
    uCool: { value: cool },
    uLevel: { value: 0 },
  };

  const bodyUniforms = { ...shared, uTime: { value: 0 }, uBumps: { value: bumps } };
  const body = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius, ORB_DETAIL),
    new THREE.ShaderMaterial({ uniforms: bodyUniforms, vertexShader: BODY_VERT, fragmentShader: BODY_FRAG, toneMapped: false }),
  );

  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      uniforms: shared,
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  glow.scale.setScalar(radius * 6);
  glow.renderOrder = 2;
  glow.frustumCulled = false;

  // ---- 160 motes, one draw call ----
  const orbit = new Float32Array(MOTE_COUNT * 3);
  const tilt = new Float32Array(MOTE_COUNT);
  let s = 12345;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < MOTE_COUNT; i++) {
    orbit[i * 3] = 1.35 + 1.4 * rnd();
    orbit[i * 3 + 1] = (0.25 + 0.6 * rnd()) * (rnd() < 0.5 ? -1 : 1);
    orbit[i * 3 + 2] = rnd() * Math.PI * 2;
    tilt[i] = (rnd() - 0.5) * 1.6;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MOTE_COUNT * 3), 3));
  moteGeo.setAttribute("aOrbit", new THREE.BufferAttribute(orbit, 3));
  moteGeo.setAttribute("aTilt", new THREE.BufferAttribute(tilt, 1));
  const moteUniforms = { uWarm: shared.uWarm, uLevel: shared.uLevel, uTime: { value: 0 }, uRadius: { value: radius }, uPx: { value: 900 } };
  const motes = new THREE.Points(
    moteGeo,
    new THREE.ShaderMaterial({
      uniforms: moteUniforms,
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  motes.frustumCulled = false;
  motes.renderOrder = 3;

  const hitTarget = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.25, 12, 8), new THREE.MeshBasicMaterial());
  hitTarget.visible = false;
  hitTarget.name = "orb-hit";

  const swell = new THREE.Group();
  swell.add(body, glow, motes);
  const group = new THREE.Group();
  group.name = "orb";
  group.add(swell, hitTarget);

  return {
    group,
    hitTarget,
    update(dt: number, mood: OrbMood, rawLevel: number): void {
      const look = MOODS[mood];
      const k = 1 - Math.exp(-MOOD_RATE * dt);
      target.warm.set(look.warm);
      target.cool.set(look.cool);
      warm.lerp(target.warm, k);
      cool.lerp(target.cool, k);
      speed += (look.speed - speed) * k;
      bumps += (look.bumps - bumps) * k;
      pulseLeft = Math.max(0, pulseLeft - dt);
      const want = Math.min(1, Math.max(0, rawLevel) + (pulseLeft > 0 ? 0.6 * Math.sin((pulseLeft / 1.2) * Math.PI) : 0));
      // Fast attack, slower release, so the swell follows syllables without flicker.
      level += (want - level) * (1 - Math.exp(-(want > level ? 18 : 6) * dt));
      time += dt * speed;
      bodyUniforms.uTime.value = time;
      bodyUniforms.uBumps.value = bumps * (1 + 0.6 * level);
      moteUniforms.uTime.value += dt * (0.6 + speed * 0.6);
      shared.uLevel.value = level;
      swell.scale.setScalar(1 + 0.22 * level);
    },
    setPixelScale(px: number): void {
      moteUniforms.uPx.value = px;
    },
    pulse(): void {
      pulseLeft = 1.2;
    },
    dispose(): void {
      body.geometry.dispose();
      (body.material as THREE.Material).dispose();
      glow.geometry.dispose();
      (glow.material as THREE.Material).dispose();
      moteGeo.dispose();
      (motes.material as THREE.Material).dispose();
      hitTarget.geometry.dispose();
      (hitTarget.material as THREE.Material).dispose();
    },
  };
}

export interface OrbViewOptions {
  getMood: () => OrbMood;
  getLevel: () => number;
  /** Frame-rate cap; uncapped when omitted. */
  fps?: number;
}

/**
 * The orb on its own canvas inside a 2D container. Returns a teardown that stops the loop and frees the GL context.
 */
export function mountOrbView(container: HTMLElement, opts: OrbViewOptions): { dispose(): void } {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  container.append(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10);
  camera.position.set(0, 0, 1.25);
  const orb = createOrb();
  scene.add(orb.group);

  function resize(): void {
    const w = Math.max(1, container.clientWidth);
    const hgt = Math.max(1, container.clientHeight);
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
    orb.setPixelScale(hgt * renderer.getPixelRatio());
  }
  resize();
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  ro?.observe(container);

  const minGap = opts.fps ? 1000 / opts.fps : 0;
  let last = performance.now();
  let lastDraw = 0;
  let raf = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (minGap && now - lastDraw < minGap - 1) return;
    lastDraw = now;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    orb.update(dt, opts.getMood(), opts.getLevel());
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);

  return {
    dispose(): void {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      orb.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
