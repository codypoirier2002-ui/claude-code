// Shared toon model of the 1940 Tacoma Narrows Bridge for the shots. Artist's reenactment, not to scale.
import { THREE, PALETTE } from '/scenes/story-kit.js';

// opts.bounce(t) -> vertical wave amplitude, opts.twist(t) -> twist angle (rad), opts.fall = {t0, ...} to drop the main span.
export function makeBridge(k, opts = {}) {
  const N = 40, X0 = -14, X1 = 14, T = 9, W = 0.85;      // deck segments, deck ends, tower x, half width
  const root = new THREE.Group();
  const steel = '#e9622e';                                  // towers/cables: warm orange so they pop on the sky
  const segs = [];
  for (let i = 0; i < N; i++) {
    const x = X0 + ((i + 0.5) * (X1 - X0)) / N;
    const g = new THREE.Group();
    g.add(k.box({ size: [0.72, 0.16, W * 2], color: '#3b4268', radius: 0.03 }));
    const strip = k.box({ size: [0.5, 0.03, 0.09], color: PALETTE.sun, radius: 0.01 }); strip.position.y = 0.1; g.add(strip);
    for (const s of [-1, 1]) { const e = k.box({ size: [0.72, 0.2, 0.08], color: '#aebbd6', radius: 0.02 }); e.position.z = s * W; g.add(e); }
    g.position.x = x; root.add(g);
    segs.push({ g, x, vy: 0, vr: 0, fallen: false, delay: 0 });
  }
  // towers
  for (const tx of [-T, T]) for (const s of [-1, 1]) {
    const leg = k.box({ size: [0.35, 6.2, 0.35], color: steel, radius: 0.08 }); leg.position.set(tx, 2.7, s * W); root.add(leg);
  }
  for (const tx of [-T, T]) for (const y of [2.2, 5.3]) { const b = k.box({ size: [0.3, 0.3, W * 2 + 0.3], color: steel, radius: 0.08 }); b.position.set(tx, y, 0); root.add(b); }
  // main cables: parabola over the main span, straight down to the anchorages
  const cy = (x) => {
    const a = Math.abs(x);
    if (a <= T) return 1.1 + (5.7 - 1.1) * (a / T) ** 2;
    return 5.7 - (5.7 - 0.5) * ((a - T) / (X1 - T));
  };
  const hangerX = []; for (let x = -T + 1; x <= T - 0.9; x += 1.15) hangerX.push(x);
  for (const s of [-1, 1]) {
    const pts = []; for (let x = X0; x <= X1; x += 0.35) pts.push(new THREE.Vector3(x, cy(x), s * W));
    root.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 120, 0.07, 8), new THREE.MeshToonMaterial({ color: new THREE.Color(PALETTE.coral) })));
  }
  const hangers = [];
  const hgeo = new THREE.CylinderGeometry(0.025, 0.025, 1, 5);
  for (const x of hangerX) for (const s of [-1, 1]) {
    const m = new THREE.Mesh(hgeo, new THREE.MeshToonMaterial({ color: new THREE.Color('#d7e0f2') }));
    root.add(m); hangers.push({ m, x, s, seg: Math.min(N - 1, Math.floor(((x - X0) / (X1 - X0)) * N)) });
  }
  // anchorage blocks
  for (const sx of [-1, 1]) { const b = k.box({ size: [1.4, 1.2, 2.2], color: '#8a93b8' }); b.position.set(sx * (X1 + 0.7), 0.1, 0); root.add(b); }
  k.add(root);

  const fall = opts.fall;
  if (fall) for (const s of segs) { if (Math.abs(s.x) < T - 1) { s.delay = fall.t0 + Math.abs(s.x) * 0.045 + (k.rng() * 0.25); s.vr = (k.rng() - 0.5) * 6; s.canFall = true; } }
  const tmp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const waterY = -7;
  k.every((t) => {
    const b = opts.bounce ? opts.bounce(t) : 0, tw = opts.twist ? opts.twist(t) : 0;
    const w = opts.vwave || 0.55;
    for (const s of segs) {
      const inMain = Math.abs(s.x) < T;
      const u = inMain ? s.x / T : 0;
      let y = inMain ? b * Math.sin((u + 1) * Math.PI * 1.0) * Math.cos(t * 5.5) : 0;
      let th = inMain ? tw * Math.sin(u * Math.PI) * Math.sin(t * 4.2) : 0;
      if (s.canFall && t > s.delay) {
        const dt = t - s.delay; s.fallen = true;
        y = -3.2 * dt * dt - 0.2 * dt; th += s.vr * dt;
        s.g.position.z = Math.sin(s.x * 3) * 0.4 * dt;
        s.g.visible = y > waterY + 0.2;
      }
      s.g.position.y = y; s.g.rotation.x = th;
    }
    for (const h of hangers) {
      const s = segs[h.seg];
      if (s.fallen || !s.g.visible) { h.m.visible = s.fallen && t < s.delay + 0.18; if (!h.m.visible) continue; }
      const top = tmp.set(h.x, cy(h.x), h.s * W);
      const th = s.g.rotation.x, y = s.g.position.y;
      const bx = h.x, by = y + h.s * W * Math.sin(th) + 0.1, bz = h.s * W * Math.cos(th);
      const a = new THREE.Vector3(bx, by, bz), d = a.clone().sub(top), len = d.length();
      h.m.position.copy(top).addScaledVector(d, 0.5); h.m.scale.set(1, Math.max(0.01, len), 1);
      h.m.quaternion.setFromUnitVectors(up, d.normalize());
    }
  });
  // wind streaks
  const streaks = [];
  const sgeo = new THREE.BoxGeometry(0.03, 0.03, 1);
  const n = opts.wind ?? 40;
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(sgeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
    m.scale.z = 1.5 + k.rng() * 1.5; root.add(m);
    streaks.push({ m, x: X0 + k.rng() * (X1 - X0), y: -0.5 + k.rng() * 5, sp: 7 + k.rng() * 6, o: k.rng() * 20 });
  }
  k.every((t) => {
    const a = opts.windAmt ? opts.windAmt(t) : 1;
    for (const s of streaks) { s.m.visible = a > 0.02; s.m.material.opacity = 0.55 * Math.min(1, a); s.m.position.set(s.x, s.y, -12 + ((s.o + t * s.sp) % 24)); }
  });
  // water + shores
  const water = k.add(k.ground({ color: opts.water || '#1f8fc9', size: 90 }), [0, waterY, 0]);
  for (const sx of [-1, 1]) { const hill = k.add(k.box({ size: [10, 9, 10], color: '#4fb26a', radius: 1.2 }), [sx * (X1 + 11), -4, -4]); }
  return { root, segs, waterY, cy };
}
