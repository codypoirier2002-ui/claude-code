// A tiny VRM 1.0 mannequin built in code, for tests and visual checks of
// src/xr/avatar.ts: a T-posed humanoid skeleton facing +Z with an unskinned box
// on each bone (so posing the bones visibly moves the boxes), a nose that shows
// which way she faces, and a few expression presets with no binds.

type Vec3 = [number, number, number];

interface BoneSpec {
  name: string;
  parent: string | null;
  t: Vec3;
  /** The box on this bone: centre (bone-local) and size. */
  box?: { c: Vec3; s: Vec3; mat: number };
}

const BONES: BoneSpec[] = [
  { name: "hips", parent: null, t: [0, 0.92, 0], box: { c: [0, 0, 0], s: [0.3, 0.14, 0.18], mat: 1 } },
  { name: "spine", parent: "hips", t: [0, 0.1, 0], box: { c: [0, 0.08, 0], s: [0.28, 0.18, 0.17], mat: 1 } },
  { name: "chest", parent: "spine", t: [0, 0.17, 0], box: { c: [0, 0.1, 0], s: [0.34, 0.22, 0.19], mat: 1 } },
  { name: "neck", parent: "chest", t: [0, 0.23, 0], box: { c: [0, 0.04, 0], s: [0.08, 0.09, 0.08], mat: 0 } },
  { name: "head", parent: "neck", t: [0, 0.08, 0], box: { c: [0, 0.11, 0], s: [0.19, 0.24, 0.21], mat: 0 } },
  { name: "nose", parent: "head", t: [0, 0.09, 0.11], box: { c: [0, 0, 0.02], s: [0.035, 0.05, 0.05], mat: 2 } },
  { name: "leftUpperArm", parent: "chest", t: [0.19, 0.19, 0], box: { c: [0.13, 0, 0], s: [0.26, 0.07, 0.07], mat: 1 } },
  { name: "leftLowerArm", parent: "leftUpperArm", t: [0.26, 0, 0], box: { c: [0.12, 0, 0], s: [0.24, 0.06, 0.06], mat: 0 } },
  { name: "leftHand", parent: "leftLowerArm", t: [0.24, 0, 0], box: { c: [0.06, 0, 0], s: [0.12, 0.03, 0.07], mat: 0 } },
  { name: "rightUpperArm", parent: "chest", t: [-0.19, 0.19, 0], box: { c: [-0.13, 0, 0], s: [0.26, 0.07, 0.07], mat: 1 } },
  { name: "rightLowerArm", parent: "rightUpperArm", t: [-0.26, 0, 0], box: { c: [-0.12, 0, 0], s: [0.24, 0.06, 0.06], mat: 0 } },
  { name: "rightHand", parent: "rightLowerArm", t: [-0.24, 0, 0], box: { c: [-0.06, 0, 0], s: [0.12, 0.03, 0.07], mat: 2 } },
  { name: "leftUpperLeg", parent: "hips", t: [0.09, -0.06, 0], box: { c: [0, -0.2, 0], s: [0.1, 0.4, 0.1], mat: 1 } },
  { name: "leftLowerLeg", parent: "leftUpperLeg", t: [0, -0.4, 0], box: { c: [0, -0.2, 0], s: [0.08, 0.4, 0.08], mat: 0 } },
  { name: "leftFoot", parent: "leftLowerLeg", t: [0, -0.42, 0], box: { c: [0, -0.02, 0.04], s: [0.08, 0.04, 0.18], mat: 1 } },
  { name: "rightUpperLeg", parent: "hips", t: [-0.09, -0.06, 0], box: { c: [0, -0.2, 0], s: [0.1, 0.4, 0.1], mat: 1 } },
  { name: "rightLowerLeg", parent: "rightUpperLeg", t: [0, -0.4, 0], box: { c: [0, -0.2, 0], s: [0.08, 0.4, 0.08], mat: 0 } },
  { name: "rightFoot", parent: "rightLowerLeg", t: [0, -0.42, 0], box: { c: [0, -0.02, 0.04], s: [0.08, 0.04, 0.18], mat: 1 } },
];

/** Bones that are VRM humanoid bones (the nose is just a marker). */
const HUMAN = BONES.filter((b) => b.name !== "nose").map((b) => b.name);

function unitBox(): { pos: Float32Array; nrm: Float32Array; idx: Uint16Array } {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const faces: [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) pos.push(0.5 * n[k] + 0.5 * a * u[k] + 0.5 * b * v[k]);
      nrm.push(...n);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx) };
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

/** The mannequin as a .vrm (GLB) file. */
export function mannequinVrm(): ArrayBuffer {
  const box = unitBox();
  const posBytes = box.pos.byteLength;
  const nrmBytes = box.nrm.byteLength;
  const idxBytes = box.idx.byteLength;
  const binLength = pad4(posBytes + nrmBytes + idxBytes);
  const bin = new Uint8Array(binLength);
  bin.set(new Uint8Array(box.pos.buffer), 0);
  bin.set(new Uint8Array(box.nrm.buffer), posBytes);
  bin.set(new Uint8Array(box.idx.buffer), posBytes + nrmBytes);

  const nodes: Record<string, unknown>[] = [];
  const index = new Map<string, number>();
  for (const b of BONES) {
    index.set(b.name, nodes.length);
    nodes.push({ name: b.name, translation: b.t, children: [] as number[] });
  }
  for (const b of BONES) {
    if (b.parent) (nodes[index.get(b.parent)!].children as number[]).push(index.get(b.name)!);
    if (b.box) {
      const mi = nodes.length;
      nodes.push({ name: `${b.name}-box`, mesh: b.box.mat, translation: b.box.c, scale: b.box.s });
      (nodes[index.get(b.name)!].children as number[]).push(mi);
    }
  }
  for (const n of nodes) if (Array.isArray(n.children) && n.children.length === 0) delete n.children;

  const prim = (material: number) => ({ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material });
  const humanBones: Record<string, { node: number }> = {};
  for (const name of HUMAN) humanBones[name] = { node: index.get(name)! };
  const emptyExpr = { morphTargetBinds: [], isBinary: false };

  const json = {
    asset: { version: "2.0", generator: "orbit-tests mannequin" },
    extensionsUsed: ["VRMC_vrm"],
    scene: 0,
    scenes: [{ nodes: [index.get("hips")!] }],
    nodes,
    meshes: [{ primitives: [prim(0)] }, { primitives: [prim(1)] }, { primitives: [prim(2)] }],
    materials: [
      { name: "skin", pbrMetallicRoughness: { baseColorFactor: [0.95, 0.78, 0.66, 1], metallicFactor: 0, roughnessFactor: 0.8 } },
      { name: "sweater", pbrMetallicRoughness: { baseColorFactor: [0.93, 0.88, 0.76, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
      { name: "accent", pbrMetallicRoughness: { baseColorFactor: [1, 0.55, 0.25, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
    ],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: nrmBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes + nrmBytes, byteLength: idxBytes, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        meta: { name: "Mannequin", authors: ["orbit tests"], licenseUrl: "https://vrm.dev/licenses/1.0/" },
        humanoid: { humanBones },
        expressions: {
          preset: Object.fromEntries(["happy", "relaxed", "surprised", "aa", "ih", "ou", "ee", "oh", "blink"].map((n) => [n, emptyExpr])),
        },
      },
    },
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad4(jsonBytes.byteLength);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  u8.set(jsonBytes, 20);
  for (let i = 20 + jsonBytes.byteLength; i < 20 + jsonLength; i++) u8[i] = 0x20;
  const binStart = 20 + jsonLength;
  dv.setUint32(binStart, binLength, true);
  dv.setUint32(binStart + 4, 0x004e4942, true); // "BIN"
  u8.set(bin, binStart + 8);
  return out;
}
