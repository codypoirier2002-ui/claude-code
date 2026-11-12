// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mood, RandomSource } from "../src/core/avatarMotion";
import { FaceRig, type FaceState } from "../src/core/faceRig";
import {
  CHARACTER_LAYERS,
  IN_XR_CLASS,
  RIG_ORIGIN,
  characterForSlot,
  createCharacter,
  fpsFor,
  layerOpacities,
  layerSrc,
  mountCharacter,
  pauseReason,
  rigTransform,
} from "../src/ui/character";
import { SLOT_FPS, createSlot } from "../src/ui/slots";

/** A seeded random source (mulberry32). */
function seeded(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REST: FaceState = { talk: 0, smile: 0, think: 0, wow: 0, blink: 0, tilt: 0, pitch: 0, breath: 0, sway: 0, hop: 0 };

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  setHidden(false);
  document.body.className = "";
  document.body.replaceChildren();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pure parts", () => {
  it("maps a scripted FaceState to layer opacities, blink as 0 or 1", () => {
    const o = layerOpacities({ ...REST, talk: 0.42, smile: 0.3, think: 0.7, wow: 1.2, blink: 1 });
    expect(o).toEqual({ base: 1, think: 0.7, wow: 1, smile: 0.3, talk: 0.42, blink: 1 });
    expect(layerOpacities({ ...REST, blink: 0.4, talk: -0.2 })).toMatchObject({ blink: 0, talk: 0 });
  });

  it("builds the §7.3 rig transform (tilt in radians, shown in degrees × .6)", () => {
    expect(rigTransform(REST)).toBe("translateY(0%) rotate(0deg) scale(1)");
    const tilt = 0.12; // listening
    const f: FaceState = { ...REST, breath: 1, pitch: 0.04, hop: 0.5, tilt, sway: 0.025 };
    // ty = .35 + .24 − 1.5; deg = 6.8755 × .6 + .5; scale = 1 + .004 + .005
    expect(rigTransform(f)).toBe("translateY(-0.91%) rotate(4.625deg) scale(1.009)");
  });

  it("picks the idle or speaking frame rate from a slot pair", () => {
    expect(fpsFor(SLOT_FPS.hero, "idle")).toBe(20);
    expect(fpsFor(SLOT_FPS.hero, "speaking")).toBe(30);
    expect(fpsFor(SLOT_FPS.sidebar, "thinking")).toBe(15);
    expect(fpsFor(SLOT_FPS.voice, "listening")).toBe(30);
    expect(fpsFor(24, "speaking")).toBe(24);
    expect(fpsFor(undefined, "idle")).toBe(0);
  });

  it("pauses for a hidden page, VR and an off-screen slot", () => {
    expect(pauseReason(document, true)).toBeNull();
    expect(pauseReason(document, false)).toBe("offscreen");
    document.body.classList.add(IN_XR_CLASS);
    expect(pauseReason(document, true)).toBe("xr");
    setHidden(true);
    expect(pauseReason(document, true)).toBe("hidden");
  });
});

describe("createCharacter", () => {
  it("stacks six layers in order inside div.char > div.char-rig", () => {
    const c = createCharacter({ isVisible: () => true });
    expect(c.el.className).toBe("char");
    const rig = c.el.querySelector<HTMLElement>(".char-rig")!;
    expect(rig.style.transformOrigin).toBe(RIG_ORIGIN);
    const imgs = [...rig.querySelectorAll("img")];
    expect(imgs.map((i) => i.className)).toEqual(CHARACTER_LAYERS.map((l) => `char-layer char-${l}`));
    for (const [i, img] of imgs.entries()) {
      expect(img.getAttribute("src")).toBe(layerSrc(CHARACTER_LAYERS[i]));
      expect(img.style.objectFit).toBe("cover");
      expect(img.style.objectPosition).toBe("50% 0");
    }
    expect(imgs[0].style.opacity).toBe("1");
    expect(imgs.slice(1).every((i) => i.style.opacity === "0")).toBe(true);
    c.dispose();
  });

  it("writes FaceRig's weights to the layers frame by frame", () => {
    let mood: Mood = "speaking";
    const c = createCharacter({ isVisible: () => true, random: seeded(7), getMood: () => mood, getLevel: () => 0.8, getText: () => "haha" });
    const twin = new FaceRig(seeded(7));
    const layer = (name: string) => c.el.querySelector<HTMLElement>(`.char-${name}`)!;
    let expected = twin.update(0, mood, 0.8, "haha");
    expect(c.frame(1000)).toBe(true);
    for (let i = 1; i <= 40; i++) {
      if (i === 25) mood = "thinking";
      expect(c.frame(1000 + i * 34)).toBe(true);
      expected = twin.update(0.034, mood, 0.8, "haha");
    }
    const o = layerOpacities(expected);
    for (const name of ["think", "wow", "smile", "talk", "blink"] as const) {
      expect(Number(layer(name).style.opacity)).toBeCloseTo(o[name], 2);
    }
    expect(Number(layer("smile").style.opacity)).toBeGreaterThan(0.5); // "haha" is a laugh
    expect(c.el.querySelector<HTMLElement>(".char-rig")!.style.transform).toBe(rigTransform(expected));
    c.dispose();
  });

  it("uses the setters when no getters are given, and cheer() hops", () => {
    const c = createCharacter({ isVisible: () => true, random: seeded(3) });
    c.setMood("speaking");
    c.setLevel(1);
    c.frame(0);
    for (let i = 1; i <= 10; i++) c.frame(i * 34);
    expect(Number(c.el.querySelector<HTMLElement>(".char-talk")!.style.opacity)).toBeGreaterThan(0.3);
    c.setMood("idle");
    c.setLevel(0);
    c.cheer();
    for (let i = 11; i <= 17; i++) c.frame(i * 34);
    expect(c.el.querySelector<HTMLElement>(".char-rig")!.style.transform).toMatch(/translateY\(-/);
    c.dispose();
  });

  it("caps the frame rate: 20 fps idle and 30 while speaking for the hero", () => {
    let mood: Mood = "idle";
    const c = createCharacter({ isVisible: () => true, fps: SLOT_FPS.hero, getMood: () => mood, getLevel: () => 0 });
    expect(c.frame(0)).toBe(true);
    expect(c.frame(30)).toBe(false);
    expect(c.frame(49)).toBe(true); // 50 ms, less the 1 ms slack
    mood = "speaking";
    expect(c.frame(70)).toBe(false);
    expect(c.frame(82)).toBe(true); // 33.3 ms
    c.dispose();
  });

  it("does no work while hidden, in VR or off screen", () => {
    let visible = true;
    const c = createCharacter({ isVisible: () => visible });
    expect(c.frame(0)).toBe(true);
    visible = false;
    expect(c.frame(100)).toBe(false);
    visible = true;
    document.body.classList.add(IN_XR_CLASS);
    expect(c.frame(200)).toBe(false);
    document.body.classList.remove(IN_XR_CLASS);
    setHidden(true);
    expect(c.frame(300)).toBe(false);
    setHidden(false);
    expect(c.frame(400)).toBe(true);
    c.dispose();
  });

  it("stops scheduling frames in VR and comes back after it", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const c = createCharacter({ isVisible: () => true });
    expect(raf).not.toHaveBeenCalled(); // the loop starts on the next microtask
    await flush();
    expect(raf).toHaveBeenCalledTimes(1);
    document.body.classList.add(IN_XR_CLASS);
    await flush();
    expect(caf).toHaveBeenCalled();
    raf.mockClear();
    document.body.classList.remove(IN_XR_CLASS);
    await flush();
    expect(raf).toHaveBeenCalledTimes(1);
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    raf.mockClear();
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(raf).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it("disposes fully: no loop, no listeners, element removed, twice is safe", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 5);
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const host = document.createElement("div");
    document.body.append(host);
    const c = mountCharacter(host, { isVisible: () => true });
    expect(host.firstElementChild).toBe(c.el);
    await flush();
    c.dispose();
    c.dispose();
    expect(caf).toHaveBeenCalledWith(5);
    expect(host.childElementCount).toBe(0);
    expect(c.frame(1e6)).toBe(false);
    raf.mockClear();
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(raf).not.toHaveBeenCalled();
  });
});

describe("characterForSlot", () => {
  it("mounts into the slot with its fps pair and visibility, and the slot disposes it", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const slot = createSlot("sidebar");
    let shown = false;
    vi.spyOn(slot, "isVisible").mockImplementation(() => shown);
    const c = characterForSlot(slot, {});
    expect(slot.content).toBe("custom");
    expect(slot.el.firstElementChild).toBe(c.el);
    expect(c.frame(0)).toBe(false); // the slot is hidden
    shown = true;
    expect(c.frame(10)).toBe(true);
    expect(c.frame(60)).toBe(false); // 15 fps idle: 66 ms apart
    expect(c.frame(77)).toBe(true);
    slot.mountOrb();
    expect(c.el.isConnected).toBe(false);
    expect(c.frame(1000)).toBe(false);
  });
});
