// Story kit: build vibrant, stylized 3D reenactments of real events (toon-shaded props, keyframed animation,
// camera moves, particles, year badges) with a post-production pass (bloom, color grade, vignette, grain).
//
// A story scene is a custom .html page next to the script (see scenes/3d/story-example.html):
//
//   import { story } from '/scenes/story-kit.js';
//   const k = await story({ sky: ['#ffb07c', '#5b2a86'], bloom: 0.8 });
//   const ship = k.add(k.rocket({ color: '#ff5d73' }), [0, -2, 0]);
//   k.keys(ship.position, [[0, [0, -2, 0]], [2.5, [0, 3, 0]]]);          // [time, value] pairs, eased
//   k.camera([[0, { pos: [0, 0, 9], look: [0, 0, 0] }], [3, { pos: [3, 2, 7], look: [0, 1, 0] }]]);
//   k.badge('1969', 0.2);                                                   // year badge popping in at t = 0.2 s
//   k.done();                                                               // sets renderFrame and sceneReady
//
// Everything is driven by t, so motion.js can render frames deterministically.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { P, W, H, ZONE, rng, clamp, easeInOutCubic, easeOutBack } from '/scenes/common.js';
import { loadModel } from '/scenes/three-common.js';

export { THREE };

// Bright, saturated palette that reads well on a phone.
export const PALETTE = {
  coral: '#ff5d73', sun: '#ffd166', mint: '#06d6a0', sky: '#4cc9f0', violet: '#7b5cff', pink: '#ff8fd8',
  orange: '#ff9f1c', ink: '#1b1f3b', cream: '#fff4e0', mars: '#e4572e', earth: '#2d9cdb', steel: '#c9d6ea',
};

// Post: saturation/contrast grade, warm/cool split toning, vignette and animated film grain in one pass.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, time: { value: 0 }, saturation: { value: 1.25 }, contrast: { value: 1.08 },
    vignette: { value: 0.45 }, grain: { value: 0.045 }, warm: { value: new THREE.Color('#ffb36b') }, cool: { value: new THREE.Color('#5b7cff') },
    tone: { value: 0.08 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time, saturation, contrast, vignette, grain, tone; uniform vec3 warm, cool;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(vec3(l), c.rgb, saturation);
      c.rgb = (c.rgb - 0.5) * contrast + 0.5;
      c.rgb += tone * mix(cool, warm, smoothstep(0.2, 0.8, l)) - tone * 0.5;
      vec2 d = vUv - 0.5; d.x *= 0.5625;
      c.rgb *= 1.0 - vignette * smoothstep(0.25, 0.75, length(d) * 1.4);
      c.rgb += (hash(vUv * vec2(1080.0, 1920.0) + time * 60.0) - 0.5) * grain;
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
    }`,
};

function toon(color, opts = {}) {
  return new THREE.MeshToonMaterial({ color: new THREE.Color(color), ...opts });
}

// Linear interpolation of numbers, arrays and colors.
function mixValue(a, b, k) {
  if (typeof a === 'number') return a + (b - a) * k;
  if (Array.isArray(a)) return a.map((v, i) => v + (b[i] - v) * k);
  return a;
}

function sample(keys, t, ease) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, e] = keys[i];
    const [t0, v0] = keys[i - 1];
    if (t <= t1) return mixValue(v0, v1, (e || ease)(clamp((t - t0) / Math.max(1e-6, t1 - t0))));
  }
  return keys[keys.length - 1][1];
}

export async function story(opts = {}) {
  const sky = opts.sky || P.sky || ['#ffb07c', '#5b2a86'];
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 1.05;
  document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Gradient sky on a big inverted sphere.
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color(sky[0]) }, bottom: { value: new THREE.Color(sky[1]) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top, bottom; varying vec3 vP; void main(){ gl_FragColor = vec4(mix(bottom, top, smoothstep(-0.4, 0.6, vP.y)), 1.0); }',
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), skyMat));
  if (opts.fog) scene.fog = new THREE.Fog(new THREE.Color(opts.fog), 20, 90);

  const camera = new THREE.PerspectiveCamera(opts.fov ?? 40, W / H, 0.05, 1000);
  // Keep the action in the upper part of the frame, above the caption band.
  camera.setViewOffset(W, H, 0, (0.5 - (opts.frameY ?? P.frameY ?? 0.32)) * H, W, H);
  camera.position.set(0, 0, 10);

  const key = new THREE.DirectionalLight(0xffffff, opts.light ?? 2.6);
  key.position.set(5, 8, 6);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(new THREE.Color(sky[0]), new THREE.Color(sky[1]), 0.9));
  const rim = new THREE.DirectionalLight(new THREE.Color(PALETTE.sky), 1.2);
  rim.position.set(-6, 2, -5);
  scene.add(rim);

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(1);
  composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  if ((opts.bloom ?? 0.7) > 0) composer.addPass(new UnrealBloomPass(new THREE.Vector2(W / 4, H / 4), opts.bloom ?? 0.7, 0.6, opts.bloomThreshold ?? 0.72));
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  Object.assign(grade.uniforms.saturation, { value: opts.saturation ?? 1.25 });
  Object.assign(grade.uniforms.vignette, { value: opts.vignette ?? 0.45 });
  Object.assign(grade.uniforms.grain, { value: opts.grain ?? 0.045 });
  composer.addPass(grade);

  const tracks = [];
  const updaters = [];
  const overlays = [];
  let camKeys = null;
  const r = rng(opts.seed ?? P.seed ?? 11);

  const k = {
    THREE, scene, camera, renderer, PALETTE, rng: r, toon,
    add(obj, pos) {
      if (pos) obj.position.set(...pos);
      scene.add(obj);
      return obj;
    },
    // Animate any Vector3/Euler/Color-like target (or a {value} holder) through [time, value, ease?] keys.
    keys(target, keys, ease = easeInOutCubic) {
      tracks.push((t) => {
        const v = sample(keys, t, ease);
        if (target.isColor) target.set(v);
        else if (Array.isArray(v)) target.set(...v);
        else if ('value' in target) target.value = v;
      });
      return target;
    },
    // Visible from t0 to t1 (with a quick scale pop in and out).
    show(obj, t0, t1 = Infinity, pop = 0.25) {
      const base = obj.scale.clone();
      tracks.push((t) => {
        const a = clamp((t - t0) / pop), b = clamp((t1 - t) / pop);
        const s = t1 === Infinity ? easeOutBack(a) : Math.min(easeOutBack(a), easeInOutCubic(b));
        obj.visible = t >= t0 && t <= t1;
        obj.scale.copy(base).multiplyScalar(Math.max(0.0001, s));
      });
      return obj;
    },
    camera(keys, ease = easeInOutCubic) {
      camKeys = { keys: keys.map(([t, v, e]) => [t, [...v.pos, ...(v.look || [0, 0, 0])], e]), ease };
    },
    every(fn) { updaters.push(fn); },

    // ---- Props (all toon-shaded, chunky and readable at phone size) ----
    rocket({ color = PALETTE.coral, body = PALETTE.cream, scale = 1, flame = true } = {}) {
      const g = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 2.4, 24), toon(body));
      g.add(hull);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.9, 24), toon(color));
      nose.position.y = 1.65; g.add(nose);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.51, 0.51, 0.22, 24), toon(color));
      band.position.y = -0.3; g.add(band);
      const win = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), toon(PALETTE.sky, { emissive: new THREE.Color(PALETTE.sky), emissiveIntensity: 0.4 }));
      win.position.set(0, 0.5, 0.42); g.add(win);
      for (let i = 0; i < 3; i++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, 0.5), toon(color));
        const a = (i / 3) * Math.PI * 2;
        fin.position.set(Math.sin(a) * 0.5, -1.0, Math.cos(a) * 0.5);
        fin.rotation.y = a;
        g.add(fin);
      }
      if (flame) {
        const f = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.1, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.sun) }));
        f.rotation.x = Math.PI; f.position.y = -1.75; g.add(f);
        g.userData.flame = f;
        updaters.push((t) => { f.scale.set(1, 0.8 + 0.35 * Math.sin(t * 40) * Math.sin(t * 17), 1); });
      }
      g.scale.setScalar(scale);
      return g;
    },
    planet({ color = PALETTE.earth, radius = 1.5, rings = null, spots = 0, spotColor = '#ffffff' } = {}) {
      const g = new THREE.Group();
      const ball = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), toon(color));
      g.add(ball);
      for (let i = 0; i < spots; i++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(radius * (0.12 + r() * 0.15), 16, 12), toon(spotColor));
        const u = r() * 2 - 1, th = r() * Math.PI * 2, q = Math.sqrt(1 - u * u);
        s.position.set(q * Math.cos(th), u, q * Math.sin(th)).multiplyScalar(radius * 0.9);
        s.scale.z = 0.4; s.lookAt(0, 0, 0);
        ball.add(s);
      }
      if (rings) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 1.35, radius * 2.1, 64), new THREE.MeshToonMaterial({ color: new THREE.Color(rings), side: THREE.DoubleSide }));
        ring.rotation.x = Math.PI / 2.3; g.add(ring);
      }
      g.userData.ball = ball;
      return g;
    },
    // A friendly low-poly figure (scientist, astronaut, crowd). Pass accessories: 'helmet', 'labcoat', 'hat'.
    figure({ color = PALETTE.violet, skin = '#ffcfa8', scale = 1, helmet = false, coat = false } = {}) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.6, 6, 12), toon(coat ? '#ffffff' : color));
      body.position.y = 0.75; g.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 20, 16), toon(skin));
      head.position.y = 1.45; g.add(head);
      for (const x of [-0.09, 0.09]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), toon(PALETTE.ink));
        eye.position.set(x, 1.48, 0.24); g.add(eye);
      }
      if (helmet) {
        const h = new THREE.Mesh(new THREE.SphereGeometry(0.38, 20, 16), new THREE.MeshPhysicalMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.35, roughness: 0.05 }));
        h.position.y = 1.45; g.add(h);
      }
      const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.45, 4, 8), toon(coat ? '#ffffff' : color));
      armL.position.set(-0.42, 0.85, 0); g.add(armL);
      const armR = armL.clone(); armR.position.x = 0.42; g.add(armR);
      for (const x of [-0.15, 0.15]) {
        const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.35, 4, 8), toon(PALETTE.ink));
        leg.position.set(x, 0.22, 0); g.add(leg);
      }
      g.userData = { armL, armR, head };
      g.scale.setScalar(scale);
      return g;
    },
    // Wave/cheer: swings the figure's arms.
    wave(fig, t0 = 0, t1 = Infinity, speed = 10) {
      updaters.push((t) => {
        const on = t >= t0 && t <= t1 ? 1 : 0;
        fig.userData.armR.rotation.z = on * (1.9 + 0.5 * Math.sin(t * speed));
        fig.userData.armL.rotation.z = on * -(1.9 + 0.5 * Math.sin(t * speed + 1));
      });
    },
    box({ size = [1, 1, 1], color = PALETTE.steel, radius = 0.08 } = {}) {
      return new THREE.Mesh(new RoundedBoxGeometry(...size, 3, radius), toon(color));
    },
    ground({ color = '#7bd389', size = 60 } = {}) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(size, 48), toon(color));
      m.rotation.x = -Math.PI / 2;
      return m;
    },
    cloud({ color = '#ffffff', scale = 1 } = {}) {
      const g = new THREE.Group();
      for (let i = 0; i < 5; i++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.5 + r() * 0.4, 16, 12), toon(color));
        s.position.set((i - 2) * 0.55, r() * 0.3, r() * 0.3);
        g.add(s);
      }
      g.scale.setScalar(scale);
      return g;
    },
    stars(count = 600) {
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const u = r() * 2 - 1, th = r() * Math.PI * 2, q = Math.sqrt(1 - u * u);
        pos.set([q * Math.cos(th) * 150, u * 150, q * Math.sin(th) * 150], i * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false }));
    },
    // Glowing 3D text label as a sprite (stays facing the camera).
    label(text, { color = '#ffffff', size = 0.6, bg = 'rgba(27,31,59,0.85)' } = {}) {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      ctx.font = 'bold 96px "DejaVu Sans", Arial, sans-serif';
      const w = Math.ceil(ctx.measureText(text).width) + 80;
      c.width = w; c.height = 150;
      ctx.font = 'bold 96px "DejaVu Sans", Arial, sans-serif';
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.roundRect(0, 0, w, 150, 40); ctx.fill();
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, 80);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, toneMapped: false }));
      s.scale.set((size * w) / 150, size, 1);
      s.renderOrder = 10;
      return s;
    },
    // Particle burst (explosion, confetti, sparks) starting at t0 from a point.
    burst(at, t0, { count = 160, colors = [PALETTE.sun, PALETTE.coral, PALETTE.orange, '#ffffff'], speed = 4, life = 1.6, size = 0.12, gravity = -2 } = {}) {
      const geo = new THREE.SphereGeometry(size, 6, 4);
      const parts = [];
      const g = new THREE.Group();
      for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(colors[i % colors.length]), transparent: true }));
        const u = r() * 2 - 1, th = r() * Math.PI * 2, q = Math.sqrt(1 - u * u), sp = speed * (0.4 + r() * 0.8);
        parts.push({ m, v: [q * Math.cos(th) * sp, u * sp, q * Math.sin(th) * sp] });
        g.add(m);
      }
      g.position.set(...at);
      scene.add(g);
      updaters.push((t) => {
        const dt = t - t0;
        g.visible = dt >= 0 && dt <= life;
        if (!g.visible) return;
        for (const p of parts) {
          p.m.position.set(p.v[0] * dt, p.v[1] * dt + 0.5 * gravity * dt * dt, p.v[2] * dt);
          p.m.material.opacity = 1 - dt / life;
        }
      });
      return g;
    },
    async model(src, size = 1) { return (await loadModel(src, size)).object; },

    // ---- 2D overlays (drawn over the render, in the top zone, clear of captions) ----
    // Big year badge ("1969") that pops in at t0, with an optional place line. It sits in the low zone, under the
    // captions, so it never covers the action or the beat headline.
    badge(year, t0 = 0.15, sub = '') {
      const d = document.createElement('div');
      d.innerHTML = `<div style="font:900 120px 'DejaVu Sans',Arial,sans-serif;letter-spacing:4px">${year}</div>` + (sub ? `<div style="font:700 44px 'DejaVu Sans',Arial,sans-serif;margin-top:-6px">${sub}</div>` : '');
      d.style.cssText = `position:absolute;left:0;right:0;top:${ZONE.low[0] + 10}px;text-align:center;color:${PALETTE.sun};-webkit-text-stroke:3px ${PALETTE.ink};paint-order:stroke fill;text-shadow:0 8px 0 ${PALETTE.ink},0 0 40px rgba(255,209,102,.6);opacity:0`;
      document.body.appendChild(d);
      overlays.push((t) => {
        const a = clamp((t - t0) / 0.35);
        d.style.opacity = a;
        d.style.transform = `scale(${0.6 + 0.4 * easeOutBack(a)}) rotate(${(1 - a) * -8}deg)`;
      });
      return d;
    },
    // Quick white flash at t0 (for impacts, launches, "eureka" moments).
    flash(t0, len = 0.35) {
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none';
      document.body.appendChild(d);
      overlays.push((t) => { d.style.opacity = t >= t0 ? Math.max(0, 1 - (t - t0) / len) * 0.85 : 0; });
    },
    // Camera shake between t0 and t1.
    shake(t0, t1, amount = 0.15) {
      updaters.push((t) => {
        if (t < t0 || t > t1) return;
        const f = 1 - (t - t0) / (t1 - t0);
        camera.position.x += Math.sin(t * 73) * amount * f;
        camera.position.y += Math.cos(t * 59) * amount * f;
      });
    },

    render(t) {
      for (const fn of tracks) fn(t);
      if (camKeys) {
        const v = sample(camKeys.keys, t, camKeys.ease);
        camera.position.set(v[0], v[1], v[2]);
        camera.lookAt(v[3], v[4], v[5]);
      }
      for (const fn of updaters) fn(t);
      for (const fn of overlays) fn(t);
      grade.uniforms.time.value = t;
      composer.render();
    },
    done() {
      window.renderFrame = (t) => k.render(t);
      k.render(0);
      window.sceneReady = true;
    },
  };
  return k;
}
