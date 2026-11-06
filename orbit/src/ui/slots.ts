// Where she appears (§7.3). Each slot is one stable element that the shell
// moves around (the welcome is rebuilt, the slot node is re-inserted), so
// whatever is mounted inside survives re-renders. Phase 3 fills every slot
// with the §6.10 CSS orb; phase 7 mounts the animated character or the VRM
// renderer with slot.mount(...) and can go back with slot.mountOrb().

import { h } from "./dom";

export type SlotKind = "hero" | "sidebar" | "voice";

/** Frame-rate hints from §7.3: [idle, speaking]. */
export const SLOT_FPS: Readonly<Record<SlotKind, readonly [number, number]>> = Object.freeze({
  hero: [20, 30],
  sidebar: [15, 30],
  voice: [30, 30],
});

export interface Mountable {
  el: HTMLElement;
  dispose?: () => void;
}

export interface CharacterSlot {
  readonly kind: SlotKind;
  /** The stable container. Has class `slot slot-{kind}` and `slot-orb` while the orb shows. */
  readonly el: HTMLElement;
  /** What is mounted now: "orb" or "custom". */
  readonly content: "orb" | "custom";
  /** Replace the content (disposing the previous one) with a character, VRM view or anything else. */
  mount(content: Mountable): void;
  /** Back to the CSS orb. */
  mountOrb(): void;
  /** True when the slot is in the document and not hidden by CSS (cheap check for render loops). */
  isVisible(): boolean;
}

function orb(): HTMLElement {
  return h("div", { class: "orb", "aria-hidden": "true" }, h("div", { class: "orb-core" }));
}

export function createSlot(kind: SlotKind): CharacterSlot {
  const el = h("div", { class: `slot slot-${kind} slot-orb` });
  let current: Mountable | null = null;
  let content: "orb" | "custom" = "orb";

  function swap(next: Mountable | null): void {
    const prev = current;
    current = next;
    el.replaceChildren(next ? next.el : orb());
    el.classList.toggle("slot-orb", !next);
    content = next ? "custom" : "orb";
    try {
      prev?.dispose?.();
    } catch {
      // A failing dispose must not leave the slot empty.
    }
  }

  swap(null);

  return {
    kind,
    el,
    get content() {
      return content;
    },
    mount: (m) => swap(m),
    mountOrb: () => swap(null),
    isVisible: () => el.isConnected && el.offsetParent !== null,
  };
}
