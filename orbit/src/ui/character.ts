// Callie's animated 2D character (§7.3): six stacked WebP layers (§7.1) whose
// opacities and shared transform come from FaceRig every frame. One instance per
// place she appears (the welcome hero, the sidebar portrait, the voice overlay).
// The loop honours a frame-rate cap and does no work while the page is hidden,
// during VR (body.in-xr), or while its slot is not on screen; during VR and in a
// hidden tab it stops scheduling frames altogether (§14). No three.js here.

import { type Mood, type RandomSource } from "../core/avatarMotion";
import { FaceRig, type FaceState } from "../core/faceRig";
import { SLOT_FPS, type CharacterSlot, type Mountable, type SlotKind } from "./slots";

/** The layers in stacking order, bottom first (§7.3). */
export const CHARACTER_LAYERS = ["base", "think", "wow", "smile", "talk", "blink"] as const;
export type CharacterLayer = (typeof CHARACTER_LAYERS)[number];

/** The layer files, relative to the app base (§7.1). */
export function layerSrc(layer: CharacterLayer): string {
  return `character/${layer}.webp`;
}

/** The rig turns and scales about this point: 50% across, 85% down (§7.3). */
export const RIG_ORIGIN = "50% 85%";

/** The rig overscans the box sideways (see createCharacter). */
export const RIG_INSET = "0 -4%";

/** The rig's bottom fade (see createCharacter). */
export const RIG_MASK = "linear-gradient(180deg, #000 80%, transparent 97%)";

/** A frame longer than this (a tab coming back) is cut to it, in seconds. */
const MAX_DT = 0.1;
/** While the slot is off screen the loop checks back this often, in ms. */
const OFFSCREEN_POLL_MS = 250;

/** The body class the shell sets while an immersive session runs. */
export const IN_XR_CLASS = "in-xr";

/** Layer opacities for a FaceRig state: blink is 0 or 1, base is always 1. */
export function layerOpacities(f: FaceState): Record<CharacterLayer, number> {
  return {
    base: 1,
    think: clamp(f.think),
    wow: clamp(f.wow),
    smile: clamp(f.smile),
    talk: clamp(f.talk),
    blink: f.blink > 0.5 ? 1 : 0,
  };
}

/**
 * The rig's CSS transform (§7.3):
 * translateY((breath·.35 + pitch·6 − hop·3)%) rotate((tilt° × .6 + sway × 20)deg) scale(1 + breath·.004 + hop·.01).
 * tilt is in radians, so it is turned into degrees first.
 */
export function rigTransform(f: FaceState): string {
  const ty = f.breath * 0.35 + f.pitch * 6 - f.hop * 3;
  const deg = ((f.tilt * 180) / Math.PI) * 0.6 + f.sway * 20;
  const scale = 1 + f.breath * 0.004 + f.hop * 0.01;
  return `translateY(${fmt(ty)}%) rotate(${fmt(deg)}deg) scale(${fmt(scale, 5)})`;
}

/** The frame-rate cap for a mood: [idle, speaking] pairs use the second while she speaks. */
export function fpsFor(fps: number | readonly [number, number] | undefined, mood: Mood): number {
  if (fps === undefined) return 0;
  if (typeof fps === "number") return fps > 0 ? fps : 0;
  const v = mood === "speaking" ? fps[1] : fps[0];
  return v > 0 ? v : 0;
}

/** Why the loop is not drawing right now, or null when it should draw. */
export function pauseReason(doc: Document, visible: boolean): "hidden" | "xr" | "offscreen" | null {
  if (doc.hidden) return "hidden";
  if (doc.body?.classList.contains(IN_XR_CLASS)) return "xr";
  if (!visible) return "offscreen";
  return null;
}

function clamp(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0;
}

function fmt(x: number, digits = 3): string {
  const v = Number(x.toFixed(digits));
  return Object.is(v, -0) ? "0" : String(v);
}

// ---- Shared images ---------------------------------------------------------------

let preload: Promise<void> | null = null;
const shared: HTMLImageElement[] = [];

/**
 * Starts loading and decoding the six layers once per page; later calls (and
 * every character) reuse the same request. The decoded images are kept so the
 * browser's image cache keeps them warm for each new instance.
 */
export function preloadCharacter(): Promise<void> {
  if (preload) return preload;
  preload = Promise.all(
    CHARACTER_LAYERS.map((layer) => {
      const img = new Image();
      img.decoding = "async";
      img.src = layerSrc(layer);
      shared.push(img);
      return typeof img.decode === "function" ? img.decode().catch(() => undefined) : Promise.resolve();
    }),
  ).then(() => undefined);
  return preload;
}

// ---- The character ---------------------------------------------------------------

export interface CharacterOptions {
  /** Her mood each frame. Without it, the value from setMood() (idle at first). */
  getMood?: () => Mood;
  /** Her voice level 0-1 each frame. Without it, the value from setLevel(). */
  getLevel?: () => number;
  /** What she is saying, read for laughs and exclamations. Without it, setText(). */
  getText?: () => string;
  /** A fixed cap, or [idle, speaking] (SLOT_FPS); uncapped when omitted. */
  fps?: number | readonly [number, number];
  /** True while the character is on screen. Defaults to "attached and laid out". */
  isVisible?: () => boolean;
  /** FaceRig's random source (tests). */
  random?: RandomSource;
}

export interface CharacterView extends Mountable {
  /** `div.char`: mount it into a slot or any container. */
  readonly el: HTMLElement;
  setMood(mood: Mood): void;
  setLevel(level: number): void;
  setText(text: string): void;
  /** A smile and a hop (a finished focus session, a celebration). */
  cheer(): void;
  /** Her answer to a wave in 2D: she cheers (§8.5). */
  wave(): void;
  /** Stops the loop and removes the element. Safe to call twice. */
  dispose(): void;
  /** Runs one frame now if it is not paused (tests and first paint). Returns true when it drew. */
  frame(now?: number): boolean;
}

function defaultVisible(el: HTMLElement): boolean {
  return el.isConnected && el.offsetParent !== null;
}

/**
 * Builds a character. Its loop starts on the next microtask; mount `el`
 * wherever she should appear before then. Use characterForSlot() to put her in a CharacterSlot.
 */
export function createCharacter(opts: CharacterOptions = {}): CharacterView {
  const doc = document;
  const win = doc.defaultView ?? window;
  void preloadCharacter();

  const el = doc.createElement("div");
  el.className = "char";
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, { position: "relative", width: "100%", height: "100%", overflow: "hidden", pointerEvents: "none" });

  const rig = doc.createElement("div");
  rig.className = "char-rig";
  // 4% wider than the box on each side, so a full tilt never shows the sides of the art.
  Object.assign(rig.style, { position: "absolute", inset: RIG_INSET, transformOrigin: RIG_ORIGIN, willChange: "transform", opacity: "0" });
  // The art is cut off at the bottom of her sweater. The tilt and the hop would
  // show that straight edge, so the rig fades out over its bottom, moving with her.
  rig.style.setProperty("mask-image", RIG_MASK);
  rig.style.setProperty("-webkit-mask-image", RIG_MASK);
  el.append(rig);

  const imgs = {} as Record<CharacterLayer, HTMLImageElement>;
  for (const layer of CHARACTER_LAYERS) {
    const img = doc.createElement("img");
    img.className = `char-layer char-${layer}`;
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    Object.assign(img.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: "cover",
      objectPosition: "50% 0",
      opacity: layer === "base" ? "1" : "0",
      userSelect: "none",
    });
    img.src = layerSrc(layer);
    imgs[layer] = img;
    rig.append(img);
  }
  // Show her only once the base is there, so a half-loaded stack never flashes.
  const reveal = () => {
    rig.style.opacity = "1";
  };
  if (imgs.base.complete && imgs.base.naturalWidth > 0) reveal();
  else imgs.base.addEventListener("load", reveal, { once: true });

  const rigFace = new FaceRig(opts.random);
  let mood: Mood = "idle";
  let level = 0;
  let text = "";
  const getMood = opts.getMood ?? (() => mood);
  const getLevel = opts.getLevel ?? (() => level);
  const getText = opts.getText ?? (() => text);
  const visible = opts.isVisible ?? (() => defaultVisible(el));

  let disposed = false;
  let raf = 0;
  let timer = 0;
  let last = -1;
  let lastDraw = -Infinity;
  const lastOpacity: Record<string, string> = {};
  let lastTransform = "";

  function apply(f: FaceState): void {
    const o = layerOpacities(f);
    for (const layer of CHARACTER_LAYERS) {
      if (layer === "base") continue;
      const v = fmt(o[layer]);
      if (lastOpacity[layer] !== v) {
        lastOpacity[layer] = v;
        imgs[layer].style.opacity = v;
      }
    }
    const tf = rigTransform(f);
    if (tf !== lastTransform) {
      lastTransform = tf;
      rig.style.transform = tf;
    }
  }

  function frame(now: number = performance.now()): boolean {
    if (disposed || pauseReason(doc, visible()) !== null) {
      last = -1;
      return false;
    }
    const m = getMood();
    const cap = fpsFor(opts.fps, m);
    if (cap > 0 && now - lastDraw < 1000 / cap - 1) return false;
    const dt = last < 0 ? 0 : Math.min(MAX_DT, Math.max(0, (now - last) / 1000));
    last = now;
    lastDraw = now;
    apply(rigFace.update(dt, m, getLevel(), getText()));
    return true;
  }

  function schedule(): void {
    if (disposed || raf || timer) return;
    const why = pauseReason(doc, visible());
    if (why === "hidden" || why === "xr") return; // resumed by the listeners below
    if (why === "offscreen") {
      last = -1;
      timer = win.setTimeout(() => {
        timer = 0;
        schedule();
      }, OFFSCREEN_POLL_MS);
      return;
    }
    raf = win.requestAnimationFrame((now) => {
      raf = 0;
      frame(now);
      schedule();
    });
  }

  function stop(): void {
    if (raf) win.cancelAnimationFrame(raf);
    if (timer) win.clearTimeout(timer);
    raf = 0;
    timer = 0;
  }

  // Hidden tabs and VR stop the loop entirely; these bring it back.
  const wake = () => {
    if (pauseReason(doc, true) !== null) {
      stop();
      last = -1;
    } else schedule();
  };
  doc.addEventListener("visibilitychange", wake);
  const bodyWatch = typeof MutationObserver !== "undefined" && doc.body ? new MutationObserver(wake) : null;
  if (bodyWatch && doc.body) bodyWatch.observe(doc.body, { attributes: true, attributeFilter: ["class"] });

  // Start on the next microtask, so the caller can mount `el` first.
  queueMicrotask(schedule);

  return {
    el,
    setMood(m: Mood) {
      mood = m;
    },
    setLevel(v: number) {
      level = Number.isFinite(v) ? v : 0;
    },
    setText(t: string) {
      text = typeof t === "string" ? t : "";
    },
    cheer() {
      rigFace.cheer();
    },
    wave() {
      rigFace.cheer();
    },
    frame,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      doc.removeEventListener("visibilitychange", wake);
      bodyWatch?.disconnect();
      imgs.base.removeEventListener("load", reveal);
      el.remove();
    },
  };
}

/**
 * §7.3's API: builds a character and appends it to `container`.
 * Returns {el, cheer, dispose} plus the setters.
 */
export function mountCharacter(container: HTMLElement, opts: CharacterOptions = {}): CharacterView {
  const view = createCharacter(opts);
  container.append(view.el);
  return view;
}

/**
 * Builds a character for a slot, with the slot's frame-rate pair (SLOT_FPS) and
 * visibility check, and mounts it there (disposing what was there before).
 */
export function characterForSlot(slot: CharacterSlot, opts: Omit<CharacterOptions, "fps" | "isVisible"> = {}): CharacterView {
  const view = createCharacter({ ...opts, fps: slotFps(slot.kind), isVisible: () => slot.isVisible() });
  slot.mount(view);
  return view;
}

/** The [idle, speaking] frame-rate pair for a slot kind. */
export function slotFps(kind: SlotKind): readonly [number, number] {
  return SLOT_FPS[kind];
}
