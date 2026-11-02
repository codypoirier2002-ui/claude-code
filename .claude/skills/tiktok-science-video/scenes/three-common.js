// three.js helpers for 3D scenes. Import with an import map that maps "three" to /lib/three/build/three.module.js
// and "three/addons/" to /lib/three/examples/jsm/ (see any scene in 3d/).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { P, W, H, rng, asset } from '/scenes/common.js';

export { THREE };

export function setup({ fov = 35, frameY = P.frameY ?? 0.3 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = P.exposure ?? 1.1;
  document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(P.bg || '#02030a');
  const camera = new THREE.PerspectiveCamera(fov, W / H, 0.01, 2000);
  // Put the subject's center at frameY of the screen height (default about a third down, above the caption band).
  camera.setViewOffset(W, H, 0, (0.5 - frameY) * H, W, H);
  return { renderer, scene, camera };
}

// A deterministic star field on a large sphere around the scene.
export function stars(scene, { count = 2500, radius = 400, seed = P.seed || 3 } = {}) {
  const r = rng(seed);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    pos.set([radius * s * Math.cos(th), radius * u, radius * s * Math.sin(th)], i * 3);
    const b = 0.5 + r() * 0.5;
    col.set([b, b, b * (0.9 + r() * 0.1)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true }));
  scene.add(pts);
  return pts;
}

// Sunlight from a direction plus a little fill, so the night side stays readable but dark.
export function lights(scene, dir = P.sunDir || [5, 2, 4]) {
  const sun = new THREE.DirectionalLight(0xffffff, P.sunIntensity ?? 3.2);
  sun.position.set(...dir);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x8899bb, P.ambient ?? 0.12));
  scene.add(new THREE.HemisphereLight(0x9bb4ff, 0x0a0a12, 0.15));
  return sun;
}

// Loads a .glb/.gltf, centers it at the origin and scales it so its largest half-extent is `size`
// (a planet model then has radius `size`, matching the atmosphere and orbit math).
export async function loadModel(src, size = 1) {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('/lib/three/examples/jsm/libs/draco/gltf/');
  loader.setDRACOLoader(draco);
  const gltf = await loader.loadAsync(asset(src));
  const root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const ext = box.getSize(new THREE.Vector3());
  root.position.sub(center);
  const pivot = new THREE.Group();
  pivot.add(root);
  pivot.scale.setScalar(size / (Math.max(ext.x, ext.y, ext.z) / 2 || 1));
  return { object: pivot, gltf };
}

export async function loadTexture(src) {
  const tex = await new THREE.TextureLoader().loadAsync(asset(src));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Fresnel rim glow just outside a sphere of radius r: a cheap, convincing atmosphere.
export function atmosphere(r = 1, color = P.atmosphere || '#5fb8ff', strength = P.atmosphereStrength ?? 1.0) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { c: { value: new THREE.Color(color) }, s: { value: strength } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
    fragmentShader: 'uniform vec3 c; uniform float s; varying vec3 vN; varying vec3 vV; void main(){ float d = abs(dot(vN, vV)); float f = pow(1.0 - d, 4.0); gl_FragColor = vec4(c, clamp(f * s, 0.0, 1.0)); }',
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r * 1.08, 96, 64), mat);
  return mesh;
}

// Soft round glow texture for sprites (a plain sprite renders as a square).
let glowTex;
export function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

// DOM label overlay (captured in the screenshot). y is in canvas pixels.
export function label(str, y, { size = 52, color = '#ffffff' } = {}) {
  if (!str) return null;
  const d = document.createElement('div');
  d.textContent = str;
  d.style.cssText = `position:absolute;left:0;right:0;top:${y}px;text-align:center;font:bold ${size}px "DejaVu Sans",Arial,sans-serif;color:${color};-webkit-text-stroke:2px rgba(0,0,0,.8);paint-order:stroke fill;text-shadow:0 0 18px rgba(0,0,0,.9);opacity:0;transform:translateY(-50%)`;
  document.body.appendChild(d);
  return d;
}
