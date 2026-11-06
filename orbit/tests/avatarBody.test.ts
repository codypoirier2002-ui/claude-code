import { IDBFactory } from "fake-indexeddb";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { saveAvatar } from "../src/core/blobstore";
import type { FaceState } from "../src/core/faceRig";
import {
  FALLBACK_HEIGHT,
  NOT_VRM_MESSAGE,
  TURN_LIMIT,
  VIEW_EYE,
  VIEW_FOV,
  WAVE_PULLBACK,
  WAVE_SECONDS,
  bodyScale,
  bodyYawTarget,
  createAvatarBody,
  easeExpressions,
  expressionTargets,
  loadStoredBody,
  parseVrm,
  restPose,
  validateVrm,
  viewCamera,
  waveEnvelope,
  wavePose,
} from "../src/xr/avatar";
import { HIT_RADIUS, SPARK_OFFSET, faceYaw } from "../src/xr/portrait";
import { mannequinVrm } from "./helpers/mannequinVrm";

const REST: FaceState = { talk: 0, smile: 0, think: 0, wow: 0, blink: 0, tilt: 0, pitch: 0, breath: 0, sway: 0, hop: 0 };
const SPOT = { x: -1.05, z: -1.15 };
const EYE = new THREE.Vector3(0, 1.6, 0);

describe("pure parts", () => {
  it("scales a body only when its height is out of 0.8–2.3 m", () => {
    expect(bodyScale(1.55)).toBe(1);
    expect(bodyScale(0.8)).toBe(1);
    expect(bodyScale(2.3)).toBe(1);
    expect(bodyScale(160)).toBeCloseTo(0.01);
    expect(bodyScale(0.4) * 0.4).toBeCloseTo(FALLBACK_HEIGHT);
    expect(bodyScale(0)).toBe(1);
    expect(bodyScale(NaN)).toBe(1);
  });

  it("turns toward the viewer within ±0.6 rad of facing the user's spot", () => {
    const base = faceYaw(SPOT, { x: 0, z: 0 });
    expect(bodyYawTarget(SPOT, { x: 0, z: 0 })).toBeCloseTo(base);
    const near = { x: 0.2, z: 0 };
    expect(bodyYawTarget(SPOT, near)).toBeCloseTo(faceYaw(SPOT, near));
    expect(bodyYawTarget(SPOT, { x: -3, z: 0 })).toBeCloseTo(base - TURN_LIMIT);
    expect(bodyYawTarget(SPOT, { x: 3, z: -3 })).toBeCloseTo(base + TURN_LIMIT);
  });

  it("brings the arms down from the T-pose and maps FaceState onto spine, neck and head", () => {
    const p = restPose({ ...REST, breath: 1, tilt: 0.1, pitch: 0.05, sway: 0.02 }, Math.PI / 3.2);
    expect(p.leftUpperArm!.z).toBeCloseTo(-1.22 + 0.012);
    expect(p.rightUpperArm!.z).toBeCloseTo(1.22 - 0.012);
    expect(p.leftLowerArm!.y).toBe(-0.25);
    expect(p.rightLowerArm!.y).toBe(0.25);
    expect(p.leftHand!.z).toBe(0.05);
    expect(p.rightHand!.z).toBe(-0.05);
    expect(p.chest!.x).toBeCloseTo(0.012);
    expect(p.neck!.x! + p.head!.x!).toBeCloseTo(0.05);
    expect(p.neck!.z! + p.head!.z!).toBeCloseTo(-0.1);
    expect(p.spine!.z).toBeCloseTo(-0.012);
  });

  it("waves the right hand for 2.2 s and leaves the left arm alone", () => {
    expect(waveEnvelope(0)).toBe(0);
    expect(waveEnvelope(1.1)).toBe(1);
    expect(waveEnvelope(WAVE_SECONDS)).toBe(0);
    expect(waveEnvelope(-1)).toBe(0);
    const rest = restPose(REST, 0);
    const mid = wavePose(1.1, rest);
    expect(mid.leftUpperArm).toEqual(rest.leftUpperArm);
    expect(mid.rightUpperArm!.z).toBeCloseTo(0.5);
    expect(mid.rightLowerArm!.z!).toBeLessThan(-2);
    expect(wavePose(WAVE_SECONDS + 0.1, rest)).toBe(rest);
  });

  it("builds expression targets: mood, words, visemes, blink", () => {
    const idle = expressionTargets("idle", 1, 0, "", REST);
    expect(idle).toMatchObject({ happy: 0.2, relaxed: 0.25, surprised: 0, aa: 0, oh: 0, blink: 0 });
    const talking = expressionTargets("speaking", 0.8, 0.3, "", REST);
    expect(talking.aa).toBeGreaterThan(0.5);
    expect(talking.happy).toBeLessThan(0.3); // happy is reduced while she talks
    const laugh = expressionTargets("idle", 0, 0, "haha", { ...REST, blink: 1, smile: 1 });
    expect(laugh.happy).toBe(1);
    expect(laugh.relaxed).toBe(0);
    expect(laugh.blink).toBeCloseTo(0.3); // blink is reduced while she smiles
    expect(expressionTargets("idle", 0, 0, "", { ...REST, blink: 1 }).blink).toBeCloseTo(0.86);
    expect(expressionTargets("speaking", 0, 0, "whoa", REST).surprised).toBe(0.35);
    // Only the last 160 characters colour her face.
    expect(expressionTargets("idle", 0, 0, "haha " + "x".repeat(200), REST).happy).toBe(0.2);
  });

  it("eases visemes faster than moods", () => {
    const zero = expressionTargets("thinking", 0, 0, "", REST);
    const target = { ...zero, aa: 1, happy: 1 };
    const next = easeExpressions({ ...zero, aa: 0, happy: 0 }, target, 0.05);
    expect(next.aa).toBeGreaterThan(next.happy);
    expect(next.aa).toBeCloseTo(1 - Math.exp(-22 * 0.05));
  });

  it("frames head and shoulders from 0.93 × her height, and pulls back while waving", () => {
    const c = viewCamera(1.6);
    expect(c.y).toBeCloseTo(VIEW_EYE * 1.6);
    const half = Math.tan((VIEW_FOV * Math.PI) / 360) * c.z;
    expect(2 * half).toBeCloseTo(0.36 * 1.6);
    const w = viewCamera(1.6, 1);
    expect(w.z).toBeCloseTo(c.z * (1 + WAVE_PULLBACK));
    expect(w.lookY).toBe(c.lookY);
  });
});

describe("loading", () => {
  it("rejects files that are not VRM", async () => {
    await expect(parseVrm(new TextEncoder().encode("not a model").buffer as ArrayBuffer)).rejects.toThrow(NOT_VRM_MESSAGE);
    const plain = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [0] }], scene: 0, nodes: [{ name: "x" }] }));
    await expect(validateVrm(plain.buffer as ArrayBuffer)).rejects.toThrow(NOT_VRM_MESSAGE);
  });

  it("parses a VRM 1.0 file and turns off frustum culling everywhere", async () => {
    const vrm = await parseVrm(mannequinVrm());
    let culled = 0;
    vrm.scene.traverse((o) => {
      if (o.frustumCulled) culled++;
    });
    expect(culled).toBe(0);
    expect(vrm.humanoid.getNormalizedBoneNode("head")).not.toBeNull();
    await expect(validateVrm(mannequinVrm())).resolves.toBeUndefined();
  });

  it("loads the stored body from IndexedDB, and null when there is none or it is broken", async () => {
    const idb = new IDBFactory();
    expect(await loadStoredBody({ idb })).toBeNull();
    await saveAvatar("callie.vrm", mannequinVrm(), idb);
    const got = await loadStoredBody({ idb, spot: SPOT });
    expect(got?.name).toBe("callie.vrm");
    expect(got?.body.group.position.x).toBe(SPOT.x);
    got?.body.dispose();
    await saveAvatar("broken.vrm", new ArrayBuffer(16), idb);
    expect(await loadStoredBody({ idb })).toBeNull();
  });
});

describe("createAvatarBody", () => {
  it("measures her, keeps a sensible height, and adds a .28 m hit cylinder", async () => {
    const body = createAvatarBody(await parseVrm(mannequinVrm()), { spot: SPOT });
    expect(body.height).toBeCloseTo(1.73, 2);
    const hit = body.hitTarget.geometry as THREE.CylinderGeometry;
    expect(hit.parameters.radiusTop).toBe(HIT_RADIUS);
    expect(hit.parameters.height).toBeCloseTo(body.height);
    expect(body.hitTarget.visible).toBe(false);
    expect(body.hitTarget.position.y).toBeCloseTo(body.height / 2);

    const tiny = await parseVrm(mannequinVrm());
    tiny.scene.scale.setScalar(0.25); // a 0.43 m doll: a unit mistake
    expect(createAvatarBody(tiny).height).toBeCloseTo(FALLBACK_HEIGHT, 2);
  });

  it("stands at her spot facing the user and turns toward the viewer at rate 1.5", async () => {
    const body = createAvatarBody(await parseVrm(mannequinVrm()), { spot: SPOT });
    const turn = body.group.children[0];
    expect(turn.rotation.y).toBeCloseTo(faceYaw(SPOT, { x: 0, z: 0 }));
    const viewer = new THREE.Vector3(-3, 1.6, 0);
    body.update(0.1, "idle", 0, "", viewer);
    const first = turn.rotation.y;
    for (let i = 0; i < 400; i++) body.update(1 / 60, "idle", 0, "", viewer);
    expect(first).toBeLessThan(faceYaw(SPOT, { x: 0, z: 0 }));
    expect(turn.rotation.y).toBeCloseTo(faceYaw(SPOT, { x: 0, z: 0 }) - TURN_LIMIT, 2);
  });

  it("poses the raw bones and sets the expressions through three-vrm", async () => {
    const vrm = await parseVrm(mannequinVrm());
    const body = createAvatarBody(vrm, { random: () => 0.5 });
    for (let i = 0; i < 20; i++) body.update(1 / 30, "speaking", 0.8, "", EYE);
    expect(vrm.humanoid.getRawBoneNode("leftUpperArm")!.rotation.z).toBeCloseTo(-1.22, 1);
    expect(vrm.humanoid.getRawBoneNode("rightUpperArm")!.rotation.z).toBeCloseTo(1.22, 1);
    expect(vrm.expressionManager!.getValue("aa")!).toBeGreaterThan(0.1);
    body.group.updateMatrixWorld(true);
    const hand = vrm.humanoid.getRawBoneNode("leftHand")!.getWorldPosition(new THREE.Vector3());
    expect(hand.y).toBeLessThan(1.1); // arms down, not in the T-pose
  });

  it("waves the right hand up beside her face for 2.2 s", async () => {
    const vrm = await parseVrm(mannequinVrm());
    const body = createAvatarBody(vrm);
    const handY = () => {
      body.group.updateMatrixWorld(true);
      return vrm.humanoid.getRawBoneNode("rightHand")!.getWorldPosition(new THREE.Vector3()).y;
    };
    body.update(1 / 30, "idle", 0, "", EYE);
    const down = handY();
    body.wave();
    for (let i = 0; i < 33; i++) body.update(1 / 30, "idle", 0, "", EYE);
    expect(body.waveAmount()).toBe(1);
    expect(handY()).toBeGreaterThan(1.4);
    for (let i = 0; i < 40; i++) body.update(1 / 30, "idle", 0, "", EYE);
    expect(body.waveAmount()).toBe(0);
    expect(handY()).toBeCloseTo(down, 1);
  });

  it("puts the spark beside her head and her eyes' target on the viewer", async () => {
    const vrm = await parseVrm(mannequinVrm());
    const body = createAvatarBody(vrm, { spot: { x: 0, z: -1.5 } });
    body.update(0, "idle", 0, "", EYE);
    body.group.updateMatrixWorld(true);
    const spark = body.sparkAnchor.getWorldPosition(new THREE.Vector3());
    const head = vrm.humanoid.getRawBoneNode("head")!.getWorldPosition(new THREE.Vector3());
    expect(spark.y).toBeCloseTo(head.y + 0.04, 1);
    expect(spark.x).toBeCloseTo(SPARK_OFFSET.x, 2);
    const look = body.group.getObjectByName("avatar-look")!.getWorldPosition(new THREE.Vector3());
    expect(look.distanceTo(EYE)).toBeCloseTo(0);
  });

  it("glides to a new spot and disposes cleanly", async () => {
    const body = createAvatarBody(await parseVrm(mannequinVrm()), { spot: SPOT });
    const parent = new THREE.Group();
    parent.add(body.group);
    body.setSpot({ x: 0.5, z: -1 });
    body.update(0.2, "idle", 0, "", EYE);
    expect(body.group.position.x).toBeGreaterThan(SPOT.x);
    expect(body.group.position.x).toBeLessThan(0.5);
    body.setSpot({ x: 0.5, z: -1 }, true);
    expect(body.group.position.x).toBe(0.5);
    body.dispose();
    expect(body.group.parent).toBeNull();
  });
});
