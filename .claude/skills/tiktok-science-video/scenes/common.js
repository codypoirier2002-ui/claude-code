// Shared helpers for motion scenes. Every scene draws a frame from the time t alone (no requestAnimationFrame),
// so motion.js can step through frames deterministically.
//
// Layout: the canvas is 1080x1920. build.js burns captions into a band around y = 930-1250 and a headline near
// y = 230-370, so keep the key graphic in y = 400-900 ("TOP" zone) and labels in y = 1290-1650 ("LOW" zone).
// TikTok's own buttons cover the right ~15% and the description covers the bottom ~270 px.
export const P = window.PARAMS || {};
export const W = P.width || 1080;
export const H = P.height || 1920;
export const DUR = P.duration || 5;
export const ZONE = { headline: [230, 370], top: [400, 900], captions: [930, 1250], low: [1290, 1650] };
export const ACCENT = P.accent || '#ffd166';
export const FONT = P.font || '"DejaVu Sans", "Helvetica Neue", Arial, sans-serif';

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, k) => a + (b - a) * k;
// Progress of t through [start, start + len], eased.
export const prog = (t, start, len, ease = easeOutCubic) => ease(clamp((t - start) / Math.max(1e-6, len)));
export const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
export const easeInOutCubic = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
export const easeOutExpo = (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k));
export const easeOutBack = (k) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);

// Deterministic random numbers (mulberry32), so stars and particles land in the same place every render.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Formats a number with thousands separators and a fixed number of decimals.
export function fmt(n, decimals = 0) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Resolves an asset path from params: absolute URLs stay as they are; other paths are served from --base.
export const asset = (p) => (!p ? p : /^(https?:|data:|\/)/.test(p) ? p : `/base/${p}`);

// Full-size 2D canvas with a dark space backdrop and slowly drifting stars.
export function canvas2d() {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  document.body.style.cssText = 'margin:0;background:#05070d;overflow:hidden';
  document.body.appendChild(c);
  return c.getContext('2d');
}

const STARS = (() => {
  const r = rng(P.seed || 7);
  return Array.from({ length: 220 }, () => ({ x: r() * W, y: r() * H, s: 0.6 + r() * 2.2, tw: r() * 6.28, v: 4 + r() * 14 }));
})();

export function backdrop(ctx, t, { top = P.bg || '#0b1530', bottom = P.bg2 || '#03040a', stars = P.stars !== false } = {}) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (!stars) return;
  for (const s of STARS) {
    const y = (s.y + t * s.v) % H;
    ctx.globalAlpha = 0.35 + 0.35 * Math.sin(s.tw + t * 2);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(s.x, y, s.s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Centered text with a soft dark outline so it reads over any background.
export function text(ctx, str, x, y, { size = 64, color = '#ffffff', weight = 'bold', align = 'center', alpha = 1, glow = null, maxWidth = W * 0.8 } = {}) {
  if (alpha <= 0 || str == null || str === '') return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(str).width;
  if (w > maxWidth) {
    ctx.font = `${weight} ${Math.floor((size * maxWidth) / w)}px ${FONT}`;
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(6, size * 0.12);
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(str, x, y);
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = size * 0.5;
  }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), h, Math.min(r, h / 2, Math.max(0, w) / 2));
}

// Waits for every image to load and fonts to settle, then marks the scene ready for motion.js.
export async function ready(images = []) {
  await Promise.all(images.map((img) => (img.complete ? null : new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(`image failed: ${img.src}`)); }))));
  if (document.fonts) await document.fonts.ready;
  window.sceneReady = true;
}

export function loadImage(src) {
  const img = new Image();
  img.src = asset(src);
  return img;
}
