import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createHandJoints, DEFAULT_JOINT_RADIUS, HAND_JOINTS, type JointLike } from "../src/xr/hands";
import { ORB_RADIUS, SPARK_HIT_BOOST, createOrb } from "../src/xr/orb";
import {
  GUTTER_GAP,
  GUTTER_W,
  PAGE_ROWS,
  PANEL_TEXT,
  ROW_H,
  VISIBLE_ROWS,
  chevronPoints,
  hitAt,
  scrollBy,
  scrollLayout,
  scrollable,
  type Rect,
} from "../src/xr/panelModel";
import { SPARK_SCALE } from "../src/xr/portrait";

const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

describe("conversation scrolling (§8.3, hands-first)", () => {
  const total = 40;
  const maxTop = total - VISIBLE_ROWS;

  it("pages by all but three rows", () => {
    expect(PAGE_ROWS).toBe(VISIBLE_ROWS - 3);
  });

  it("does nothing when everything fits or the step is zero", () => {
    expect(scrollBy({ top: 0, pinned: true, total: VISIBLE_ROWS }, -1)).toBeNull();
    expect(scrollBy({ top: 0, pinned: true, total: 3 }, PAGE_ROWS)).toBeNull();
    expect(scrollBy({ top: 5, pinned: false, total }, 0)).toBeNull();
    expect(scrollBy({ top: 5, pinned: false, total }, 0.4)).toBeNull();
  });

  it("steps one row for the thumbstick and wheel, starting from the pinned bottom", () => {
    expect(scrollBy({ top: 0, pinned: true, total }, -1)).toEqual({ top: maxTop - 1, pinned: false });
    expect(scrollBy({ top: maxTop - 1, pinned: false, total }, 1)).toEqual({ top: maxTop, pinned: true });
    expect(scrollBy({ top: 7, pinned: false, total }, -1)).toEqual({ top: 6, pinned: false });
  });

  it("pages a whole chevron step and clamps at both ends", () => {
    expect(scrollBy({ top: 0, pinned: true, total }, -PAGE_ROWS)).toEqual({ top: maxTop - PAGE_ROWS, pinned: false });
    expect(scrollBy({ top: 3, pinned: false, total }, -PAGE_ROWS)).toEqual({ top: 0, pinned: false });
    expect(scrollBy({ top: 0, pinned: false, total }, PAGE_ROWS)).toEqual({ top: PAGE_ROWS, pinned: false });
    expect(scrollBy({ top: maxTop - 2, pinned: false, total }, PAGE_ROWS)).toEqual({ top: maxTop, pinned: true });
  });

  it("moves by the row count, not just its sign", () => {
    expect(scrollBy({ top: 10, pinned: false, total }, -4)).toEqual({ top: 6, pinned: false });
    expect(scrollBy({ top: 10, pinned: false, total }, 2.9)).toEqual({ top: 12, pinned: false });
  });

  it("clamps a stale top before moving", () => {
    expect(scrollBy({ top: 999, pinned: false, total }, -1)).toEqual({ top: maxTop - 1, pinned: false });
    expect(scrollBy({ top: -5, pinned: false, total }, 1)).toEqual({ top: 1, pinned: false });
  });

  it("says which chevrons have somewhere to go", () => {
    expect(scrollable({ top: 0, pinned: true, total: VISIBLE_ROWS })).toEqual({ up: false, down: false });
    expect(scrollable({ top: 0, pinned: true, total })).toEqual({ up: true, down: false });
    expect(scrollable({ top: 0, pinned: false, total })).toEqual({ up: false, down: true });
    expect(scrollable({ top: 9, pinned: false, total })).toEqual({ up: true, down: true });
  });
});

describe("the conversation gutter (§8.3)", () => {
  const area = { x: 48, y: 214, w: 1184, h: VISIBLE_ROWS * ROW_H };
  const lay = scrollLayout(area);

  it("always reserves the gutter, so text keeps one width", () => {
    expect(lay.text).toEqual({ x: area.x, y: area.y, w: area.w - GUTTER_W - GUTTER_GAP, h: area.h });
    expect(lay.text.x + lay.text.w + GUTTER_GAP).toBe(lay.up.x);
  });

  it("splits the gutter into two press halves that cover it with no overlap", () => {
    expect(lay.upHit.y).toBe(area.y);
    expect(lay.upHit.y + lay.upHit.h).toBe(lay.downHit.y);
    expect(lay.downHit.y + lay.downHit.h).toBe(area.y + area.h);
    expect(lay.upHit.x).toBe(area.x + area.w - GUTTER_W);
    expect(lay.upHit.w).toBe(GUTTER_W);
    // Each half is at least 400 px tall: about 28 cm on the 0.9 m panel.
    expect(lay.upHit.h).toBeGreaterThanOrEqual(400);
    expect(lay.downHit.h).toBeGreaterThanOrEqual(400);
  });

  it("draws each chevron inside its own half, with the track between them", () => {
    expect(inside(lay.up, lay.upHit)).toBe(true);
    expect(inside(lay.down, lay.downHit)).toBe(true);
    expect(lay.track.y).toBeGreaterThan(lay.up.y + lay.up.h);
    expect(lay.track.y + lay.track.h).toBeLessThan(lay.down.y);
    expect(lay.track.h).toBeGreaterThan(300);
  });

  it("lets a chevron win over the conversation behind it", () => {
    const hits = [
      { id: "conv", ...lay.text },
      { id: "scroll-up", ...lay.upHit },
      { id: "scroll-down", ...lay.downHit },
    ];
    expect(hitAt(hits, lay.up.x + 5, lay.up.y + 5)?.id).toBe("scroll-up");
    // Between the drawn buttons still counts, for a jittery hand ray.
    expect(hitAt(hits, lay.track.x, lay.track.y + 10)?.id).toBe("scroll-up");
    expect(hitAt(hits, lay.track.x, lay.track.y + lay.track.h - 10)?.id).toBe("scroll-down");
    expect(hitAt(hits, lay.text.x + 10, lay.text.y + 10)?.id).toBe("conv");
  });

  it("draws chevrons as paths centred in their button", () => {
    const r = { x: 100, y: 200, w: 112, h: 176 };
    const up = chevronPoints(r, "up", 44);
    const down = chevronPoints(r, "down", 44);
    expect(up).toHaveLength(3);
    expect(up[1][0]).toBe(156);
    expect(up[1][1]).toBeLessThan(up[0][1]);
    expect(down[1][1]).toBeGreaterThan(down[0][1]);
    expect(up[2][0] - up[0][0]).toBe(44);
    for (const [x, y] of [...up, ...down]) expect(inside({ x, y, w: 0, h: 0 }, r)).toBe(true);
  });

  it("puts pinch first in the footer and no longer needs a thumbstick to scroll", () => {
    expect(PANEL_TEXT.footer).toBe("Pinch or trigger to press · Arrows or thumbstick to scroll · Talk or A/X to speak");
  });
});

describe("hand joints (hands-first)", () => {
  function fakeHand(visible: number, radius?: number) {
    const hand = new THREE.Group() as THREE.Group & { joints: Record<string, JointLike> };
    hand.joints = {};
    HAND_JOINTS.forEach((name, i) => {
      hand.joints[name] = {
        visible: i < visible,
        position: new THREE.Vector3(i * 0.01, 1, -0.3),
        quaternion: new THREE.Quaternion(),
        ...(radius ? { jointRadius: radius } : {}),
      };
    });
    return hand;
  }

  it("draws one sphere per tracked joint in a single instanced mesh", () => {
    const hand = fakeHand(25, 0.011);
    const joints = createHandJoints(hand);
    expect(hand.children).toContain(joints.mesh);
    expect(joints.update()).toBe(25);
    expect(joints.mesh.count).toBe(25);
    const m = new THREE.Matrix4();
    joints.mesh.getMatrixAt(3, m);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    m.decompose(p, new THREE.Quaternion(), s);
    expect(p.x).toBeCloseTo(0.03);
    expect(s.x).toBeCloseTo(0.011);
    joints.dispose();
    expect(hand.children).not.toContain(joints.mesh);
  });

  it("skips untracked joints and uses the default radius when none is reported", () => {
    const joints = createHandJoints(fakeHand(5));
    expect(joints.update()).toBe(5);
    const m = new THREE.Matrix4();
    joints.mesh.getMatrixAt(0, m);
    const s = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    expect(s.x).toBeCloseTo(DEFAULT_JOINT_RADIUS);
  });

  it("draws nothing when hidden (passthrough) or when the hand is lost", () => {
    const hand = fakeHand(25);
    const joints = createHandJoints(hand);
    joints.mesh.visible = false;
    expect(joints.update()).toBe(0);
    joints.mesh.visible = true;
    for (const j of Object.values(hand.joints)) j.visible = false;
    expect(joints.update()).toBe(0);
    expect(joints.mesh.count).toBe(0);
  });
});

describe("the orb as a spark (§8.2)", () => {
  it("keeps a hit sphere big enough for a pinch ray beside Callie", () => {
    const orb = createOrb();
    orb.hitTarget.geometry.computeBoundingSphere();
    const base = orb.hitTarget.geometry.boundingSphere?.radius ?? 0;
    expect(base).toBeCloseTo(ORB_RADIUS * 1.25);
    const spark = base * SPARK_SCALE * SPARK_HIT_BOOST;
    expect(spark).toBeGreaterThanOrEqual(0.07);
    // Still smaller than the full-size orb's.
    expect(spark).toBeLessThan(base);
    orb.dispose();
  });
});
