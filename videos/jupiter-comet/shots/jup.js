// Shared props for the Shoemaker-Levy 9 shots (artist's reenactment, not to scale).
import { story, PALETTE, THREE } from '/scenes/story-kit.js';
export { story, PALETTE, THREE };
// Banded toon Jupiter (vertex colors by latitude) with a Great Red Spot.
export function jupiter(k, radius = 2.2) {
  const g = new THREE.Group();
  const geo = new THREE.SphereGeometry(radius, 64, 48);
  const bands = ['#f3d9b1', '#d9985a', '#f6e4c4', '#b9703f', '#efd0a0', '#c98550', '#f3d9b1', '#d9985a'];
  const cols = [];
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const lat = Math.asin(p.getY(i) / radius);
    const b = Math.floor(((lat / Math.PI) + 0.5) * bands.length * 1.5) % bands.length;
    const c = new THREE.Color(bands[b]); cols.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const ball = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ vertexColors: true }));
  g.add(ball);
  const spot = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.2, 24, 16), k.toon("#d1452f"));
  spot.scale.set(1.4, 0.9, 0.06); spot.position.set(radius * 0.5, -radius * 0.3, radius * 0.8); spot.lookAt(0, 0, 0);
  ball.add(spot);
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.06, 48, 32), new THREE.MeshBasicMaterial({ color: '#ffb36b', transparent: true, opacity: 0.14 }));
  g.add(atmo);
  g.userData = { ball, atmo, radius };
  return g;
}
// Comet fragment: icy blue-white lump with a glowing tail that points away from motion (+x trail).
export function fragment(k, size = 0.22, tail = 1.4) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(size, 1), k.toon('#e8f6ff', { emissive: new THREE.Color('#7fd6ff'), emissiveIntensity: 0.8 })));
  const t = new THREE.Mesh(new THREE.ConeGeometry(size * 0.9, tail, 12, 1, true), new THREE.MeshBasicMaterial({ color: '#8fe0ff', transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
  t.rotation.z = -Math.PI / 2; t.position.x = tail / 2;
  g.add(t);
  return g;
}
