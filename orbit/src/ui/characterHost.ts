// Who fills the three character slots (§7.3, §7.4): her animated 2D face, her
// VRM head-and-shoulders view, or the CSS orb. One rebuild() decides for all
// three; it runs at start-up, when "Her body" loads or removes a VRM, when
// "Show her animated face" changes, on entering and leaving VR, and when the tab
// is hidden or shown again (every view is torn down while VR runs and while the
// tab is hidden, §14). three.js and three-vrm load only when a VRM
// is stored, through the injected importer, so they stay out of the main bundle.

import type { Mood } from "../core/avatarMotion";
import type { AvatarRecord } from "../core/blobstore";
import type { Settings } from "../core/settings";
import { characterForSlot, preloadCharacter } from "./character";
import type { CharacterSlot, Mountable } from "./slots";

/** The slice of src/xr/avatar.ts this module uses (its module type, kept structural). */
export interface AvatarViewModule {
  AVATAR_VIEW_FPS: { sidebar: readonly [number, number]; voice: undefined };
  mountAvatarView(
    container: HTMLElement | null,
    opts: {
      data: ArrayBuffer;
      getMood: () => Mood;
      getLevel: () => number;
      getText?: () => string;
      fps?: number | readonly [number, number];
      isVisible?: () => boolean;
    },
  ): Mountable & { readonly ready: Promise<void>; wave(): void; cheer(): void; dispose(): void };
}

export interface CharacterHostDeps {
  slots: { hero: CharacterSlot; sidebar: CharacterSlot; voice: CharacterSlot };
  getSettings: () => Pick<Settings, "showCharacter">;
  getMood: () => Mood;
  getLevel: () => number;
  getText: () => string;
  /** True while an immersive session (or the preview) runs. */
  inXr: () => boolean;
  /** The stored VRM (blobstore.loadAvatar). Never rejects. */
  loadAvatar: () => Promise<AvatarRecord | null>;
  /** import("../xr/avatar"). */
  importAvatar: () => Promise<AvatarViewModule>;
  /** The tab is hidden. Defaults to document.visibilityState. */
  isHidden?: () => boolean;
  /** Calls `fn` when the tab is hidden or shown; returns an unsubscribe. Defaults to visibilitychange on document. */
  onVisibilityChange?: (fn: () => void) => () => void;
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function onDocumentVisibility(fn: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", fn);
  return () => document.removeEventListener("visibilitychange", fn);
}

/** What each slot shows. */
export type SlotPlan = "orb" | "face" | "body";

/**
 * §7.3 "Fallbacks": the orb everywhere in VR or with the animated face off; with
 * a VRM stored, the body in the sidebar and voice overlay and the orb in the
 * hero; otherwise her 2D face in all three.
 */
export function planSlots(opts: { inXr: boolean; showCharacter: boolean; hasBody: boolean }): {
  hero: SlotPlan;
  sidebar: SlotPlan;
  voice: SlotPlan;
} {
  if (opts.inXr) return { hero: "orb", sidebar: "orb", voice: "orb" };
  if (opts.hasBody) return { hero: "orb", sidebar: "body", voice: "body" };
  if (!opts.showCharacter) return { hero: "orb", sidebar: "orb", voice: "orb" };
  return { hero: "face", sidebar: "face", voice: "face" };
}

export type CharacterHost = ReturnType<typeof createCharacterHost>;

export function createCharacterHost(deps: CharacterHostDeps) {
  const { slots } = deps;
  /** Live views, for cheer(). */
  const views = new Map<CharacterSlot, { cheer(): void; wave(): void }>();
  /** The stored body, read once and again whenever "Her body" changes it. */
  let record: Promise<AvatarRecord | null> | null = null;
  /** Each rebuild bumps this, so a slow VRM load from an earlier one never lands. */
  let generation = 0;

  const getters = { getMood: deps.getMood, getLevel: deps.getLevel, getText: deps.getText };
  const isHidden = deps.isHidden ?? documentHidden;
  /** Whether the last rebuild tore the views down for a hidden tab. */
  let tornDownForHidden = false;

  function orb(slot: CharacterSlot): void {
    views.delete(slot);
    if (slot.content !== "orb") slot.mountOrb();
  }

  function face(slot: CharacterSlot): void {
    views.delete(slot);
    views.set(slot, characterForSlot(slot, getters));
  }

  function body(slot: CharacterSlot, mod: AvatarViewModule, data: ArrayBuffer, gen: number): Promise<void> {
    const view = mod.mountAvatarView(null, {
      data,
      ...getters,
      fps: slot.kind === "sidebar" ? mod.AVATAR_VIEW_FPS.sidebar : mod.AVATAR_VIEW_FPS.voice,
      isVisible: () => slot.isVisible(),
    });
    slot.mount({ el: view.el, dispose: view.dispose });
    views.set(slot, view);
    return view.ready.catch(() => {
      // The file no longer loads: the orb stands in (a rebuild may already have replaced her).
      if (gen === generation && views.get(slot) === view) orb(slot);
    });
  }

  /**
   * Rebuilds every slot. `reloadBody` re-reads the stored VRM (after "Her body"
   * loads or removes one). Resolves once every view is mounted (a VRM view may
   * still be loading; it falls back to the orb on its own).
   */
  async function rebuild(opts: { reloadBody?: boolean } = {}): Promise<void> {
    const gen = ++generation;
    if (opts.reloadBody || !record) record = deps.loadAvatar();
    const inXr = deps.inXr();
    const hidden = isHidden();
    tornDownForHidden = hidden && !inXr;
    const showCharacter = deps.getSettings().showCharacter;
    if (inXr || hidden) {
      // Tear everything down at once (VR, or a hidden tab); the stored body is not needed for that.
      for (const slot of Object.values(slots)) orb(slot);
      return;
    }
    const stored = await record;
    if (gen !== generation) return;
    const plan = planSlots({ inXr, showCharacter, hasBody: stored !== null });
    if (plan.hero === "face") void preloadCharacter();

    let mod: AvatarViewModule | null = null;
    if (stored && (plan.sidebar === "body" || plan.voice === "body")) {
      try {
        mod = await deps.importAvatar();
      } catch {
        mod = null; // offline and never cached: no body, so her face (or the orb)
      }
      if (gen !== generation) return;
    }

    for (const slot of [slots.hero, slots.sidebar, slots.voice]) {
      let p = plan[slot.kind];
      if (p === "body" && !mod) p = showCharacter ? "face" : "orb";
      if (p === "orb") orb(slot);
      else if (p === "face") face(slot);
      else if (mod && stored) void body(slot, mod, stored.data, gen);
    }
  }

  // Hidden tab: tear the views down; visible again: rebuild them (§14). In VR
  // they are already down and the session's exit rebuilds them.
  const stopWatching = (deps.onVisibilityChange ?? onDocumentVisibility)(() => {
    if (deps.inXr()) return;
    const hidden = isHidden();
    if (hidden === tornDownForHidden) return;
    void rebuild();
  });

  return {
    rebuild,
    /** Stops following the tab's visibility. */
    dispose: stopWatching,
    /** A finished focus session (§7.2): every live view smiles and hops. */
    cheer(): void {
      for (const v of views.values()) v.cheer();
    },
    /** What each slot shows now (tests and the console). */
    kinds(): Record<"hero" | "sidebar" | "voice", SlotPlan> {
      const kind = (slot: CharacterSlot): SlotPlan => {
        if (slot.content === "orb") return "orb";
        return slot.el.querySelector(".avatar-view") ? "body" : "face";
      };
      return { hero: kind(slots.hero), sidebar: kind(slots.sidebar), voice: kind(slots.voice) };
    },
  };
}
