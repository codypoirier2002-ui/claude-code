// The VR keyboard (§8.4): a 1280×560 canvas on a 0.9×0.39375 m plane, hidden
// until Type. Hover repaints only the keyboard (`kbDirty ||= …`, §18), and it
// redraws only when dirty.

import * as THREE from "three";
import type { XrSendResult } from "./bridge";
import {
  KB_H,
  KB_LETTERS,
  KB_SYMBOLS,
  KB_TEXT,
  KB_W,
  MESSAGE_MS,
  applyKey,
  hitAt,
  uvToPixel,
  type HitRect,
  type KbAction,
  type KbState,
} from "./panelModel";

export const KB_SIZE = { w: 0.9, h: 0.39375 } as const;
const KEY_W = 116;
const KEY_H = 72;
const GAP = 8;
const FIELD = { x: 24, y: 22, w: KB_W - 48, h: 84 };
const ROW_Y = [122, 202, 282, 362, 442] as const;
const FONT = `"Inter", "Segoe UI", system-ui, -apple-system, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;

interface Key extends HitRect<string> {
  action: KbAction;
  label: string;
}

export interface Keyboard {
  mesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  hover(uv: THREE.Vector2 | null): void;
  press(uv: THREE.Vector2): void;
  /** A physical key in the desktop preview (KeyboardEvent.key). Returns true when used. */
  typeKey(key: string): boolean;
  /** Once per frame: redraw when dirty. */
  update(): void;
  text(): string;
  dispose(): void;
}

export function createKeyboard(opts: { send(text: string): XrSendResult; onToggle?(open: boolean): void }): Keyboard {
  const canvas = document.createElement("canvas");
  canvas.width = KB_W;
  canvas.height = KB_H;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("No 2D canvas for the VR keyboard.");
  const ctx = g;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(KB_SIZE.w, KB_SIZE.h),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }),
  );
  mesh.name = "keyboard";
  mesh.visible = false;

  let state: KbState = { text: "", shift: false, layer: "letters" };
  let keys: Key[] = layout(state);
  let hovered: string | null = null;
  let kbDirty = true;
  let msg: { text: string; until: number } | null = null;
  let msgTimer: ReturnType<typeof setTimeout> | null = null;

  function layout(s: KbState): Key[] {
    const rows = s.layer === "letters" ? KB_LETTERS : KB_SYMBOLS;
    const out: Key[] = [];
    rows.forEach((row, r) => {
      const chars = Array.from(row);
      const rowW = chars.length * KEY_W + (chars.length - 1) * GAP;
      const x0 = (KB_W - rowW) / 2;
      chars.forEach((ch, i) => {
        out.push({
          id: `k${r}-${i}`,
          x: x0 + i * (KEY_W + GAP),
          y: ROW_Y[r],
          w: KEY_W,
          h: KEY_H,
          action: { kind: "char", char: ch },
          label: s.shift ? ch.toUpperCase() : ch,
        });
      });
    });
    const bottom: [string, number, KbAction, string][] = [
      ["shift", 176, { kind: "shift" }, KB_TEXT.shift],
      ["layer", 176, { kind: "layer" }, s.layer === "letters" ? KB_TEXT.symbols : KB_TEXT.letters],
      ["space", 456, { kind: "space" }, KB_TEXT.space],
      ["backspace", 176, { kind: "backspace" }, KB_TEXT.backspace],
      ["send", 216, { kind: "send" }, KB_TEXT.send],
    ];
    const total = bottom.reduce((a, b) => a + b[1], 0) + GAP * (bottom.length - 1);
    let x = (KB_W - total) / 2;
    for (const [id, w, action, label] of bottom) {
      out.push({ id, x, y: ROW_Y[4], w, h: KEY_H, action, label });
      x += w + GAP;
    }
    return out;
  }

  function showMessage(text: string): void {
    msg = { text, until: performance.now() + MESSAGE_MS };
    kbDirty = true;
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      msgTimer = null;
      kbDirty = true;
    }, MESSAGE_MS + 20);
  }

  function act(a: KbAction): void {
    msg = null;
    if (a.kind === "send") {
      const text = state.text.trim();
      state = applyKey(state, a);
      if (text) {
        const r = opts.send(text);
        if (r === "sent") state = { ...state, text: "" };
        else showMessage(r === "busy" ? KB_TEXT.busy : KB_TEXT.noKey);
      }
    } else {
      state = applyKey(state, a);
    }
    keys = layout(state);
    kbDirty = true;
  }

  function draw(): void {
    ctx.clearRect(0, 0, KB_W, KB_H);
    ctx.beginPath();
    ctx.roundRect(6, 6, KB_W - 12, KB_H - 12, 40);
    ctx.fillStyle = "rgba(14,17,24,.94)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,.13)";
    ctx.stroke();

    // Text field with a caret, or the placeholder.
    ctx.beginPath();
    ctx.roundRect(FIELD.x, FIELD.y, FIELD.w, FIELD.h, 20);
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,181,71,.45)";
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const midY = FIELD.y + FIELD.h / 2;
    const maxW = FIELD.w - 60;
    const live = msg && performance.now() < msg.until ? msg.text : null;
    if (live) {
      ctx.font = `500 32px ${FONT}`;
      ctx.fillStyle = "#ff7a6b";
      ctx.fillText(live, FIELD.x + 26, midY);
    } else if (state.text) {
      ctx.font = `400 40px ${FONT}`;
      let shown = state.text;
      if (ctx.measureText(shown).width > maxW) {
        const chars = Array.from(shown);
        while (chars.length && ctx.measureText(`…${chars.join("")}`).width > maxW) chars.shift();
        shown = `…${chars.join("")}`;
      }
      ctx.fillStyle = "#e9edf3";
      ctx.fillText(shown, FIELD.x + 26, midY);
      const caretX = FIELD.x + 26 + ctx.measureText(shown).width + 4;
      ctx.fillStyle = "#ffb547";
      ctx.fillRect(caretX, midY - 24, 4, 48);
    } else {
      ctx.fillStyle = "#ffb547";
      ctx.fillRect(FIELD.x + 26, midY - 24, 4, 48);
      ctx.font = `400 40px ${FONT}`;
      ctx.fillStyle = "#93a0b4";
      ctx.fillText(KB_TEXT.placeholder, FIELD.x + 40, midY);
    }

    // Keys.
    ctx.textAlign = "center";
    for (const k of keys) {
      const hot = hovered === k.id;
      const special = k.action.kind !== "char";
      const on = k.action.kind === "shift" && state.shift;
      const send = k.action.kind === "send";
      ctx.beginPath();
      ctx.roundRect(k.x, k.y, k.w, k.h, 16);
      ctx.fillStyle = send
        ? hot ? "#ffc56e" : "#ffb547"
        : on ? "rgba(255,181,71,.35)"
        : hot ? "rgba(255,255,255,.2)"
        : special ? "rgba(255,255,255,.1)" : "rgba(255,255,255,.07)";
      ctx.fill();
      ctx.font = `${special ? 600 : 500} ${special && k.label.length > 3 ? 30 : 38}px ${FONT}`;
      ctx.fillStyle = send ? "#1b1406" : "#e9edf3";
      ctx.fillText(k.label, k.x + k.w / 2, k.y + k.h / 2 + 1);
    }
    texture.needsUpdate = true;
  }

  function setOpen(open: boolean): void {
    if (mesh.visible === open) return;
    mesh.visible = open;
    kbDirty = true;
    opts.onToggle?.(open);
  }

  return {
    mesh,
    canvas,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!mesh.visible),
    isOpen: () => mesh.visible,
    hover(uv: THREE.Vector2 | null): void {
      let id: string | null = null;
      if (uv && mesh.visible) {
        const p = uvToPixel(uv.x, uv.y, KB_W, KB_H);
        id = hitAt(keys, p.x, p.y)?.id ?? null;
      }
      // §18: OR the hover change into kbDirty instead of assigning it.
      kbDirty ||= id !== hovered;
      hovered = id;
    },
    press(uv: THREE.Vector2): void {
      if (!mesh.visible) return;
      const p = uvToPixel(uv.x, uv.y, KB_W, KB_H);
      const k = hitAt(keys, p.x, p.y);
      if (k) act(k.action);
    },
    typeKey(key: string): boolean {
      if (!mesh.visible) return false;
      if (key === "Backspace") act({ kind: "backspace" });
      else if (key === "Enter") act({ kind: "send" });
      else if (key === " ") act({ kind: "space" });
      else if (Array.from(key).length === 1) {
        // Physical keys bring their own case; skip the on-screen one-shot shift.
        msg = null;
        state = { ...state, text: state.text + key };
        kbDirty = true;
      } else return false;
      return true;
    },
    update(): void {
      if (!mesh.visible || !kbDirty) return;
      kbDirty = false;
      draw();
    },
    text: () => state.text,
    dispose(): void {
      if (msgTimer) clearTimeout(msgTimer);
      texture.dispose();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
  };
}
