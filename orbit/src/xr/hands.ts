// Hands (§8.5, hands-first). With hand tracking the headset draws nothing for
// your hands inside an immersive-vr session, so each tracked joint is drawn as
// a small sphere: one instanced mesh per hand (one draw call), refreshed every
// frame from the joint poses three.js keeps on the XRHandSpace. Unlike three's
// XRHandModelFactory this loads nothing from the network and pulls in no
// glTF loader. Passthrough hides them: there you see your real hands.

import * as THREE from "three";

/** The 25 WebXR hand joints, wrist first. */
export const HAND_JOINTS = [
  "wrist",
  "thumb-metacarpal",
  "thumb-phalanx-proximal",
  "thumb-phalanx-distal",
  "thumb-tip",
  "index-finger-metacarpal",
  "index-finger-phalanx-proximal",
  "index-finger-phalanx-intermediate",
  "index-finger-phalanx-distal",
  "index-finger-tip",
  "middle-finger-metacarpal",
  "middle-finger-phalanx-proximal",
  "middle-finger-phalanx-intermediate",
  "middle-finger-phalanx-distal",
  "middle-finger-tip",
  "ring-finger-metacarpal",
  "ring-finger-phalanx-proximal",
  "ring-finger-phalanx-intermediate",
  "ring-finger-phalanx-distal",
  "ring-finger-tip",
  "pinky-finger-metacarpal",
  "pinky-finger-phalanx-proximal",
  "pinky-finger-phalanx-intermediate",
  "pinky-finger-phalanx-distal",
  "pinky-finger-tip",
] as const satisfies readonly XRHandJoint[];

/** A joint's radius when the runtime reports none, in metres. */
export const DEFAULT_JOINT_RADIUS = 0.008;
/** Warm white, a step off the panel's text colour. */
export const HAND_COLOR = 0xffe7c4;

/** The slice of a joint the spheres read (three's XRJointSpace satisfies it). */
export interface JointLike {
  visible: boolean;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  jointRadius?: number;
}

export interface HandJoints {
  readonly mesh: THREE.InstancedMesh;
  /** Once per frame: one sphere per tracked joint. Returns how many were drawn. */
  update(): number;
  dispose(): void;
}

/**
 * Joint spheres for one hand. `hand` is the XRHandSpace from `renderer.xr.getHand(i)`:
 * its joints hold reference-space poses, so the mesh is added under it.
 */
export function createHandJoints(
  hand: THREE.Object3D & { joints: Partial<Record<string, JointLike>> },
  color = HAND_COLOR,
): HandJoints {
  const geometry = new THREE.SphereGeometry(1, 10, 8);
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, toneMapped: false });
  const mesh = new THREE.InstancedMesh(geometry, material, HAND_JOINTS.length);
  mesh.name = "hand-joints";
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  hand.add(mesh);

  const m = new THREE.Matrix4();
  const s = new THREE.Vector3();
  return {
    mesh,
    update(): number {
      let n = 0;
      if (mesh.visible) {
        for (const name of HAND_JOINTS) {
          const joint = hand.joints[name];
          if (!joint || !joint.visible) continue;
          s.setScalar(joint.jointRadius || DEFAULT_JOINT_RADIUS);
          m.compose(joint.position, joint.quaternion, s);
          mesh.setMatrixAt(n++, m);
        }
      }
      if (n !== mesh.count || n > 0) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
      }
      return n;
    },
    dispose(): void {
      hand.remove(mesh);
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
