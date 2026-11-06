import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { FaceState } from "../src/core/faceRig";
import { CHARACTER_LAYERS, layerSrc } from "../src/ui/character";
import {
  BEAM,
  GLIDE_RATE,
  HIT_RADIUS,
  IMAGE_CENTRE_Y,
  LAYER_RENDER_ORDER,
  PIVOT_Y,
  PLANE_H,
  PLANE_W,
  RING,
  SPARK_OFFSET,
  SPARK_SCALE,
  bodyPose,
  cleanSpot,
  createPortrait,
  easeAngle,
  faceYaw,
  floatY,
  glideStep,
  glowFor,
  wrapAngle,
} from "../src/xr/portrait";

const REST: FaceState = { talk: 0, smile: 0, think: 0, wow: 0, blink: 0, tilt: 0, pitch: 0, breath: 0, sway: 0, hop: 0 };
const DEFAULT_SPOT = { x: -1.05, z: -1.15 };

function stubPortrait(spot = DEFAULT_SPOT) {
  const loaded: string[] = [];
  const textures: THREE.Texture[] = [];
  const p = createPortrait({
    spot,
    random: () => 0.5,
    loadTexture: (src) => {
      loaded.push(src);
      const t = new THREE.Texture();
      textures.push(t);
      return t;
    },
  });
  return { p, loaded, textures };
}

describe("placement maths", () => {
  it("wraps angles into (−π, π]", () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(Math.PI / 2 + 4 * Math.PI)).toBeCloseTo(Math.PI / 2);
  });

  it("faces a point: +Z is her front", () => {
    expect(faceYaw({ x: 0, z: 0 }, { x: 0, z: 1 })).toBe(0);
    expect(faceYaw({ x: 0, z: 0 }, { x: 1, z: 0 })).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(faceYaw({ x: 0, z: 0 }, { x: 0, z: -1 }))).toBeCloseTo(Math.PI);
    // From her default spot she turns to the user at the origin.
    expect(faceYaw(DEFAULT_SPOT, { x: 0, z: 0 })).toBeCloseTo(Math.atan2(1.05, 1.15));
    expect(faceYaw({ x: 1, z: 1 }, { x: 1, z: 1 })).toBe(0);
  });

  it("eases angles the short way round", () => {
    const a = easeAngle(3, -3, 0.1, 5); // 3 → −3 is 0.28 rad through π, not 6 rad back
    expect(Math.abs(a)).toBeGreaterThan(3);
    expect(easeAngle(0, 1, 100, 5)).toBeCloseTo(1);
    expect(easeAngle(0.4, 1, 0, 5)).toBeCloseTo(0.4);
  });

  it("glides with lerp(1 − e^(−3dt)) and arrives", () => {
    const f = 1 - Math.exp(-GLIDE_RATE * 0.1);
    const s = glideStep({ x: 0, z: 0 }, { x: 1, z: -2 }, 0.1);
    expect(s.x).toBeCloseTo(f);
    expect(s.z).toBeCloseTo(-2 * f);
    let p = { x: 0, z: 0 };
    for (let i = 0; i < 300; i++) p = glideStep(p, { x: 1, z: -2 }, 1 / 60);
    expect(p.x).toBeCloseTo(1, 3);
    expect(p.z).toBeCloseTo(-2, 3);
  });

  it("accepts only finite spots", () => {
    expect(cleanSpot({ x: 1, z: 2 })).toEqual({ x: 1, z: 2 });
    expect(cleanSpot({ x: NaN, z: 2 })).toBeNull();
    expect(cleanSpot({ x: "1", z: 2 })).toBeNull();
    expect(cleanSpot(null)).toBeNull();
  });
});

describe("motion from FaceState", () => {
  it("rests at the pivot with no turn and no scale", () => {
    expect(bodyPose(REST)).toEqual({ y: PIVOT_Y, rotZ: -0, scale: 1 });
  });

  it("carries the 2D percentages into metres and flips CSS's axes", () => {
    const hop = bodyPose({ ...REST, hop: 1 });
    expect(hop.y - PIVOT_Y).toBeCloseTo(0.03 * PLANE_H); // up 3% of the image
    expect(hop.scale).toBeCloseTo(1.01);
    const nod = bodyPose({ ...REST, pitch: 0.1 });
    expect(nod.y - PIVOT_Y).toBeCloseTo(-0.006 * PLANE_H); // down 0.6%
    const tilt = bodyPose({ ...REST, tilt: 0.12 });
    expect(tilt.rotZ).toBeCloseTo(-(0.12 * 0.6)); // clockwise on screen = −Z
    expect(bodyPose({ ...REST, sway: 0.025 }).rotZ).toBeCloseTo(-((0.5 * Math.PI) / 180));
  });

  it("floats .012 sin 1.1t and glows per mood", () => {
    expect(floatY(Math.PI / 2 / 1.1)).toBeCloseTo(0.012);
    expect(glowFor("speaking", 0.6, 0)).toBeCloseTo(0.85);
    expect(glowFor("speaking", 3, 0)).toBeCloseTo(1.05);
    expect(glowFor("listening", 0, 0)).toBe(0.65);
    expect(glowFor("thinking", 0, Math.PI / 8)).toBeCloseTo(0.62);
    expect(glowFor("idle", 1, 1)).toBe(0.45);
  });
});

describe("createPortrait", () => {
  it("loads the six layers as sRGB textures on 0.62 × 0.8267 m planes, renderOrder 10–15", () => {
    const { p, loaded, textures } = stubPortrait();
    expect(loaded).toEqual(CHARACTER_LAYERS.map(layerSrc));
    expect(textures.every((t) => t.colorSpace === THREE.SRGBColorSpace)).toBe(true);
    const layers = CHARACTER_LAYERS.map((l) => p.group.getObjectByName(`portrait-${l}`) as THREE.Mesh);
    expect(layers.map((m) => m.renderOrder)).toEqual([0, 1, 2, 3, 4, 5].map((i) => LAYER_RENDER_ORDER + i));
    const g = layers[0].geometry as THREE.PlaneGeometry;
    expect(g.parameters.width).toBe(PLANE_W);
    expect(g.parameters.height).toBe(PLANE_H);
    p.group.updateMatrixWorld(true);
    expect(layers[0].getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(IMAGE_CENTRE_Y);
    expect(layers[0].parent!.position.y).toBe(PIVOT_Y);
  });

  it("builds the glow, the beam and the floor ring to size", () => {
    const { p } = stubPortrait();
    const glow = p.group.getObjectByName("portrait-glow") as THREE.Mesh;
    expect((glow.geometry as THREE.PlaneGeometry).parameters.width).toBe(1.1);
    expect((glow.material as THREE.Material).blending).toBe(THREE.AdditiveBlending);
    const beam = (p.group.getObjectByName("portrait-beam") as THREE.Mesh).geometry as THREE.CylinderGeometry;
    expect(beam.parameters).toMatchObject({ radiusTop: BEAM.radiusTop, radiusBottom: BEAM.radiusBottom, height: 1.05, openEnded: true });
    const ring = p.group.getObjectByName("portrait-ring") as THREE.Mesh;
    expect((ring.geometry as THREE.RingGeometry).parameters).toMatchObject({ innerRadius: 0.2, outerRadius: 0.23 });
    expect((ring.material as THREE.MeshBasicMaterial).color.getHexString()).toBe(RING.color.slice(1));
  });

  it("stands at her spot facing the user, with an invisible .28 m hit cylinder", () => {
    const { p } = stubPortrait();
    expect(p.group.position.x).toBe(DEFAULT_SPOT.x);
    expect(p.group.position.z).toBe(DEFAULT_SPOT.z);
    expect(p.group.children[0].rotation.y).toBeCloseTo(faceYaw(DEFAULT_SPOT, { x: 0, z: 0 }));
    expect(p.hitTarget.visible).toBe(false);
    expect((p.hitTarget.geometry as THREE.CylinderGeometry).parameters.radiusTop).toBe(HIT_RADIUS);
    expect(p.hitTarget.parent).toBe(p.group);
    // Raycasting the hit target alone (non-recursive, as immersive.ts does) finds her.
    p.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 1.2, 0), new THREE.Vector3(DEFAULT_SPOT.x, 0, DEFAULT_SPOT.z).normalize());
    expect(ray.intersectObject(p.hitTarget, false).length).toBeGreaterThan(0);
  });

  it("puts the spark anchor beside her head, on the viewer's right, turning with her", () => {
    const { p } = stubPortrait({ x: 0, z: -1.5 });
    p.group.updateMatrixWorld(true);
    const w = p.sparkAnchor.getWorldPosition(new THREE.Vector3());
    expect(w.y).toBeCloseTo(SPARK_OFFSET.y);
    // She faces the user (+Z toward the origin), so her left is the viewer's right (+X).
    expect(w.x).toBeCloseTo(SPARK_OFFSET.x);
    expect(SPARK_SCALE).toBe(0.35);
    // Turned 90°, the anchor swings round with her.
    const side = stubPortrait({ x: -1.5, z: 0 }).p;
    side.group.updateMatrixWorld(true);
    expect(side.sparkAnchor.getWorldPosition(new THREE.Vector3()).z).toBeCloseTo(-SPARK_OFFSET.x);
  });

  it("turns to the viewer's head (yaw only) and glides to a new spot", () => {
    const { p } = stubPortrait();
    const viewer = { x: 1, z: 0.5 };
    for (let i = 0; i < 240; i++) p.update(1 / 60, "idle", 0, "", viewer);
    expect(p.group.children[0].rotation.y).toBeCloseTo(faceYaw(DEFAULT_SPOT, viewer), 2);
    expect(p.group.children[0].rotation.x).toBe(0);
    p.setSpot({ x: 1, z: -1 });
    p.update(0.1, "idle", 0, "");
    expect(p.group.position.x).toBeGreaterThan(DEFAULT_SPOT.x);
    expect(p.group.position.x).toBeLessThan(1);
    p.setSpot({ x: 0.5, z: -2 }, true);
    expect(p.group.position.x).toBe(0.5);
    p.setSpot({ x: NaN, z: 0 } as never, true);
    expect(p.group.position.x).toBe(0.5);
  });

  it("drives the layer opacities and the pivot from FaceRig", () => {
    const { p } = stubPortrait();
    const talk = p.group.getObjectByName("portrait-talk") as THREE.Mesh;
    const opacity = () => (talk.material as THREE.ShaderMaterial).uniforms.uOpacity.value as number;
    for (let i = 0; i < 30; i++) p.update(1 / 30, "speaking", 0.9, "so");
    expect(opacity()).toBeGreaterThan(0.2);
    for (let i = 0; i < 30; i++) p.update(1 / 30, "idle", 0, "");
    expect(opacity()).toBeLessThan(0.05);
    const pivot = talk.parent!;
    p.cheer();
    let top = 0;
    for (let i = 0; i < 12; i++) {
      p.update(1 / 60, "idle", 0, "");
      top = Math.max(top, pivot.position.y - PIVOT_Y);
    }
    expect(top).toBeGreaterThan(0.015); // the hop
    const base = (p.group.getObjectByName("portrait-base") as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(base.uniforms.uTime.value).toBeGreaterThan(0);
  });

  it("disposes its geometries, materials and textures and leaves its parent", () => {
    const { p, textures } = stubPortrait();
    const parent = new THREE.Group();
    parent.add(p.group);
    const spies = textures.map((t) => vi.spyOn(t, "dispose"));
    const mat = vi.spyOn((p.group.getObjectByName("portrait-base") as THREE.Mesh).material as THREE.Material, "dispose");
    p.dispose();
    expect(spies.every((s) => s.mock.calls.length === 1)).toBe(true);
    expect(mat).toHaveBeenCalled();
    expect(p.group.parent).toBeNull();
  });
});
