// The VR panel (§8.3): a 1280×1600 canvas on a 0.9×1.125 m plane. It redraws
// only when something marked it dirty; while a reply streams, at most every
// 100 ms and only when the text length, status, actions or model changed.
// Each redraw re-uploads ~8 MB, so the texture is never re-uploaded per frame.

import * as THREE from "three";
import { modelsLabel } from "../core/assistant";
import { MODES, modeById } from "../core/modes";
import { assistantName, isConfigured } from "../core/settings";
import { stripAudioTags } from "../core/tags";
import { buildRows, type Row } from "../ui/chat";
import { markdownToPlain } from "../ui/markdown";
import type { XrHost } from "./bridge";
import {
  MESSAGE_MS,
  PAGE_ROWS,
  PANEL_H,
  PANEL_TEXT,
  PANEL_W,
  ROW_H,
  VISIBLE_ROWS,
  buttonLabels,
  chevronPoints,
  cutLabel,
  emptyText,
  hitAt,
  modelLine,
  promptLabels,
  sceneMessage,
  scrollBy,
  scrollLayout,
  scrollable,
  statusLine,
  streamSignature,
  timerLine,
  uvToPixel,
  type HitRect,
  type Rect,
} from "./panelModel";

export const PANEL_SIZE = { w: 0.9, h: 1.125 } as const;
/** Conversation geometry (§8.3): 17 visible rows of 50 px (in panelModel); the last 14 turns. */
export { ROW_H, VISIBLE_ROWS };
export const MAX_TURNS = 14;
/** Streaming redraws at most this often. */
const STREAM_GAP_MS = 100;

const FONT = `"Inter", "Segoe UI", system-ui, -apple-system, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
const C = {
  card: "rgba(14,17,24,.94)",
  border: "rgba(255,255,255,.13)",
  text: "#e9edf3",
  dim: "#93a0b4",
  accent: "#ffb547",
  accentInk: "#1b1406",
  violet: "#b48cff",
  mint: "#7fd8c4",
  blue: "#5aa9ff",
  danger: "#ff7a6b",
  line: "rgba(255,255,255,.10)",
  btn: "rgba(255,255,255,.06)",
  btnHover: "rgba(255,255,255,.14)",
  btnLine: "rgba(255,255,255,.12)",
};

// Layout (canvas px). The card fills the canvas with an 8 px margin.
const PAD = 48;
const INNER_W = PANEL_W - PAD * 2;
const L = {
  modeBtn: { y: 36, size: 88 },
  modeLine1: 60,
  modeLine2: 108,
  strip: 172,
  divider: 202,
  convTop: 214,
  status: 1102,
  prompts: 1140,
  row1: 1256,
  row2: 1372,
  btnH: 90,
  footer: 1522,
} as const;
/** The conversation: a text column plus the right gutter with the scroll chevrons (§8.3). */
const CONV = scrollLayout({ x: PAD, y: L.convTop, w: INNER_W, h: VISIBLE_ROWS * ROW_H });
/** Her lines start 4 px in; leave a little air before the gutter. */
const HER_W = CONV.text.w - 16;
/** Your lines start 30 px in, after the blue bar. */
const YOU_W = HER_W - 30;

type ButtonId =
  | "mode-prev"
  | "mode-next"
  | "prompt-0"
  | "prompt-1"
  | "prompt-2"
  | "talk"
  | "type"
  | "think"
  | "aloud"
  | "recenter"
  | "scene"
  | "exit"
  | "scroll-up"
  | "scroll-down"
  | "conv";

export interface PanelActions {
  toggleKeys(): void;
  keysOpen(): boolean;
  recenter(): void;
  exit(): void;
}

interface Line {
  kind: "head" | "her" | "you" | "gap" | "empty";
  text: string;
}

export interface Panel {
  mesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  /** Something the panel shows changed (assistant, voice, settings, timers). */
  markState(): void;
  /** Force a redraw on the next update (hover, press, scroll, message). */
  markDirty(): void;
  hover(uv: THREE.Vector2 | null): void;
  press(uv: THREE.Vector2): void;
  /** Scroll the conversation by whole rows (positive = later). */
  scroll(rows: number): void;
  /** A 6-second message. */
  message(text: string): void;
  /** Once per frame: redraw if needed. */
  update(now?: number): void;
  setAnisotropy(n: number): void;
  dispose(): void;
}

export function createPanel(host: XrHost, actions: PanelActions): Panel {
  const canvas = document.createElement("canvas");
  canvas.width = PANEL_W;
  canvas.height = PANEL_H;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("No 2D canvas for the VR panel.");
  const ctx = g;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_SIZE.w, PANEL_SIZE.h),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }),
  );
  mesh.name = "panel";

  let hits: HitRect<ButtonId>[] = [];
  let hovered: ButtonId | null = null;
  let dirty = true;
  let stateDirty = true;
  let lastDraw = -Infinity;
  let lastSig = "";
  let msg: { text: string; until: number } | null = null;
  let msgTimer: ReturnType<typeof setTimeout> | null = null;
  /** Conversation scroll: the first visible row, or pinned to the bottom. */
  let pinned = true;
  let top = 0;
  let totalRows = 0;

  const unsubscribe = host.subscribe(() => {
    stateDirty = true;
  });

  // ---- Text helpers ----
  const wrapCache = new Map<string, string[]>();
  function wrap(text: string, font: string, width: number): string[] {
    const key = `${font}|${width}|${text}`;
    const hit = wrapCache.get(key);
    if (hit) return hit;
    ctx.font = font;
    const out: string[] = [];
    for (const para of text.split("\n")) {
      if (!para.trim()) continue;
      const indent = /^\s*- /.test(para) ? "   " : "";
      let line = "";
      const fits = (t: string) => ctx.measureText(t).width <= width;
      for (const token of para.split(/(\s+)/)) {
        if (!token) continue;
        const blank = !/\S/.test(token);
        if (blank && !line.trim()) continue; // no leading spaces on a wrapped line
        if (fits(line + token)) {
          line += token;
          continue;
        }
        if (line.trim()) out.push(line.trimEnd());
        line = indent;
        if (blank) continue;
        if (fits(line + token)) {
          line += token;
          continue;
        }
        // A single word wider than the line: break it by characters.
        for (const ch of Array.from(token)) {
          if (!fits(line + ch) && line.trim()) {
            out.push(line);
            line = indent;
          }
          line += ch;
        }
      }
      if (line.trim()) out.push(line.trimEnd());
    }
    if (wrapCache.size > 400) wrapCache.clear();
    wrapCache.set(key, out);
    return out;
  }

  function fit(text: string, font: string, width: number): string {
    ctx.font = font;
    if (ctx.measureText(text).width <= width) return text;
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(`${chars.slice(0, mid).join("")}…`).width <= width) lo = mid;
      else hi = mid - 1;
    }
    return `${chars.slice(0, lo).join("").trimEnd()}…`;
  }

  function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function button(id: ButtonId, x: number, y: number, w: number, h: number, label: string, opts: { primary?: boolean; disabled?: boolean; danger?: boolean; size?: number } = {}): void {
    hits.push({ id, x, y, w, h });
    const hot = hovered === id && !opts.disabled;
    roundRect(x, y, w, h, 24);
    ctx.fillStyle = opts.primary ? (hot ? "#ffc56e" : C.accent) : hot ? C.btnHover : C.btn;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = opts.primary ? "rgba(255,255,255,.0)" : hot ? "rgba(255,181,71,.7)" : C.btnLine;
    ctx.stroke();
    const font = `650 ${opts.size ?? 32}px ${FONT}`;
    ctx.font = font;
    ctx.fillStyle = opts.primary ? C.accentInk : opts.disabled ? "rgba(233,237,243,.35)" : opts.danger ? C.danger : C.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(fit(label, font, w - 28), x + w / 2, y + h / 2 + 1);
  }

  // ---- Conversation rows ----
  function herHead(row: Row, name: string): string {
    const parts = [name];
    if (row.models.length) parts.push(modelsLabel(row.models));
    if (row.actions.length) parts.push(row.actions.join(" · "));
    return parts.join(" · ");
  }

  function conversationLines(rows: Row[], name: string): Line[] {
    const lines: Line[] = [];
    const herFont = `400 38px ${FONT}`;
    const youFont = `400 36px ${FONT}`;
    rows.forEach((row, i) => {
      if (i > 0) lines.push({ kind: "gap", text: "" });
      if (row.role === "assistant") {
        lines.push({ kind: "head", text: herHead(row, name) });
        const plain = markdownToPlain(stripAudioTags(row.text));
        const body = wrap(plain, herFont, HER_W);
        if (body.length) for (const t of body) lines.push({ kind: "her", text: t });
        else if (row.live) lines.push({ kind: "her", text: "…" });
      } else {
        const body = wrap(row.text, youFont, YOU_W);
        if (row.image) lines.push({ kind: "you", text: "🖼 Image" });
        for (const t of body) lines.push({ kind: "you", text: t });
      }
    });
    return lines;
  }

  /** A chevron button in the gutter, its arrow drawn as a path; a press counts over half the gutter. */
  function chevron(id: "scroll-up" | "scroll-down", r: Rect, hit: Rect, enabled: boolean): void {
    if (enabled) hits.push({ id, ...hit });
    const hot = enabled && hovered === id;
    roundRect(r.x, r.y, r.w, r.h, 24);
    ctx.fillStyle = hot ? C.btnHover : C.btn;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = hot ? "rgba(255,181,71,.7)" : C.btnLine;
    ctx.stroke();
    const pts = chevronPoints(r, id === "scroll-up" ? "up" : "down");
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = enabled ? (hot ? C.accent : C.text) : "rgba(233,237,243,.22)";
    ctx.stroke();
  }

  function drawConversation(lines: Line[]): void {
    const { text: area } = CONV;
    const x0 = area.x;
    const yTop = area.y;
    hits.push({ id: "conv", ...area });
    totalRows = lines.length;
    const maxTop = Math.max(0, totalRows - VISIBLE_ROWS);
    top = pinned ? maxTop : Math.min(Math.max(0, top), maxTop);
    if (top >= maxTop) pinned = true;
    const visible = lines.slice(top, top + VISIBLE_ROWS);

    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    visible.forEach((ln, i) => {
      const yMid = yTop + i * ROW_H + ROW_H / 2;
      switch (ln.kind) {
        case "head": {
          const font = `650 28px ${FONT}`;
          ctx.font = font;
          ctx.fillStyle = C.violet;
          ctx.fillText(fit(ln.text, font, HER_W), x0 + 4, yMid + 4);
          break;
        }
        case "her":
          ctx.font = `400 38px ${FONT}`;
          ctx.fillStyle = C.text;
          ctx.fillText(ln.text, x0 + 4, yMid);
          break;
        case "you":
          ctx.fillStyle = C.blue;
          ctx.fillRect(x0 + 4, yTop + i * ROW_H + 4, 6, ROW_H - 8);
          ctx.font = `400 36px ${FONT}`;
          ctx.fillStyle = "#dfe9ff";
          ctx.fillText(ln.text, x0 + 30, yMid);
          break;
        case "empty":
          ctx.font = `400 38px ${FONT}`;
          ctx.fillStyle = C.text;
          ctx.fillText(ln.text, x0 + 4, yMid);
          break;
        case "gap":
          break;
      }
    });
    ctx.restore();

    // When there's more: the chevrons (pinch-friendly) with the scrollbar between them.
    if (totalRows > VISIBLE_ROWS) {
      const can = scrollable({ top, pinned, total: totalRows });
      chevron("scroll-up", CONV.up, CONV.upHit, can.up);
      chevron("scroll-down", CONV.down, CONV.downHit, can.down);
      const t = CONV.track;
      roundRect(t.x, t.y, t.w, t.h, 4);
      ctx.fillStyle = "rgba(255,255,255,.07)";
      ctx.fill();
      const thumbH = Math.min(t.h, Math.max(40, t.h * (VISIBLE_ROWS / totalRows)));
      const thumbY = t.y + (t.h - thumbH) * (maxTop ? top / maxTop : 1);
      roundRect(t.x, thumbY, t.w, thumbH, 4);
      ctx.fillStyle = "rgba(255,255,255,.35)";
      ctx.fill();
    }
  }

  // ---- The whole panel ----
  function draw(now: number): void {
    const st = host.assistant();
    const s = host.settings();
    const v = host.voice();
    const name = assistantName(s);
    const mode = modeById(st.modeId);
    const modeIndex = Math.max(0, MODES.findIndex((m) => m.id === mode.id));
    hits = [];

    ctx.clearRect(0, 0, PANEL_W, PANEL_H);
    roundRect(8, 8, PANEL_W - 16, PANEL_H - 16, 56);
    ctx.fillStyle = C.card;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.border;
    ctx.stroke();

    // 1. Mode switcher
    button("mode-prev", PAD, L.modeBtn.y, L.modeBtn.size, L.modeBtn.size, "‹", { size: 60 });
    button("mode-next", PANEL_W - PAD - L.modeBtn.size, L.modeBtn.y, L.modeBtn.size, L.modeBtn.size, "›", { size: 60 });
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 28px ${FONT}`;
    ctx.fillStyle = C.accent;
    ctx.fillText(`${name.toUpperCase()} · ${modeIndex + 1}/${MODES.length}`, PANEL_W / 2, L.modeLine1);
    const titleFont = `750 54px ${FONT}`;
    ctx.font = titleFont;
    ctx.fillStyle = C.text;
    ctx.fillText(fit(`${mode.icon}  ${mode.name}`, titleFont, INNER_W - 2 * L.modeBtn.size - 40), PANEL_W / 2, L.modeLine2);

    // 2. Status strip
    const stripFont = `600 28px ${FONT}`;
    const right = timerLine(host.running(), Date.now());
    ctx.font = stripFont;
    const rightW = right ? ctx.measureText(right).width : 0;
    ctx.textAlign = "left";
    ctx.fillStyle = C.violet;
    ctx.fillText(fit(modelLine(st, s), stripFont, INNER_W - rightW - 30), PAD + 4, L.strip);
    if (right) {
      ctx.textAlign = "right";
      ctx.fillStyle = C.mint;
      ctx.fillText(fit(right, stripFont, INNER_W * 0.6), PANEL_W - PAD - 4, L.strip);
    }
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, L.divider, INNER_W, 2);

    // 3. Conversation, or the empty state
    const configured = isConfigured(s);
    const rows = buildRows(st);
    const live = st.busy ? rows.slice(-1) : [];
    const stored = st.busy ? rows.slice(0, -1) : rows;
    const shown = [...stored.slice(-MAX_TURNS), ...live];
    if (shown.length === 0) {
      const text = emptyText(name, mode.blurb, v.ready, configured);
      const lines = wrap(text, `400 38px ${FONT}`, HER_W).map((t): Line => ({ kind: "empty", text: t }));
      drawConversation([{ kind: "gap", text: "" }, ...lines]);
    } else {
      drawConversation(conversationLines(shown, name));
    }

    // 4. Status line
    const message = msg && now < msg.until ? msg.text : null;
    const status = statusLine(st, v, message);
    if (status) {
      const font = `500 30px ${FONT}`;
      ctx.font = font;
      ctx.textAlign = "left";
      ctx.fillStyle =
        status.tone === "error" ? C.danger : status.tone === "voice" ? C.mint : status.tone === "message" ? C.accent : C.dim;
      ctx.fillText(fit(status.text, font, INNER_W - 8), PAD + 4, L.status);
    }

    // 5. Prompt buttons
    const prompts = promptLabels(st);
    const pw = 380;
    const pgap = (INNER_W - 3 * pw) / 2;
    prompts.forEach((p, i) => {
      button(`prompt-${i}` as ButtonId, PAD + i * (pw + pgap), L.prompts, pw, L.btnH, cutLabel(p), { size: 28 });
    });

    // 6–7. Rows one and two
    const voiceOn = v.state !== "off";
    const labels = buttonLabels({
      voiceOn,
      voiceReady: v.ready,
      keysOpen: actions.keysOpen(),
      busy: st.busy,
      speakReplies: s.speakReplies,
    });
    const w3 = (INNER_W - 2 * pgap) / 3;
    button("talk", PAD, L.row1, w3, L.btnH, labels.talk, { primary: !voiceOn && v.ready, danger: voiceOn });
    button("type", PAD + (w3 + pgap), L.row1, w3, L.btnH, labels.type);
    button("think", PAD + 2 * (w3 + pgap), L.row1, w3, L.btnH, labels.think, {
      disabled: !st.busy && !st.thinkHarderTarget,
      danger: st.busy,
    });
    const gap4 = 20;
    const w4 = (INNER_W - 3 * gap4) / 4;
    button("aloud", PAD, L.row2, w4, L.btnH, labels.aloud, { size: 30 });
    button("recenter", PAD + (w4 + gap4), L.row2, w4, L.btnH, PANEL_TEXT.recenter, { size: 30 });
    button("scene", PAD + 2 * (w4 + gap4), L.row2, w4, L.btnH, PANEL_TEXT.scene, { size: 30 });
    button("exit", PAD + 3 * (w4 + gap4), L.row2, w4, L.btnH, PANEL_TEXT.exit, { size: 30 });

    // 8. Footer
    ctx.textAlign = "center";
    const footerFont = `500 25px ${FONT}`;
    ctx.font = footerFont;
    ctx.fillStyle = C.dim;
    ctx.fillText(fit(PANEL_TEXT.footer, footerFont, INNER_W), PANEL_W / 2, L.footer);

    texture.needsUpdate = true;
    lastDraw = now;
    lastSig = streamSignature(st);
  }

  function update(now = performance.now()): void {
    if (!dirty && !stateDirty) return;
    if (!dirty) {
      const st = host.assistant();
      if (st.busy) {
        // §8.3: while streaming, at most every 100 ms and only on a real change.
        if (now - lastDraw < STREAM_GAP_MS) return;
        stateDirty = false;
        if (streamSignature(st) === lastSig && !voiceChanged()) return;
      }
    }
    dirty = false;
    stateDirty = false;
    lastVoice = voiceKey();
    draw(now);
  }

  let lastVoice = "";
  const voiceKey = () => {
    const v = host.voice();
    return `${v.state}|${v.heard}`;
  };
  const voiceChanged = () => voiceKey() !== lastVoice;

  function message(text: string): void {
    msg = { text, until: performance.now() + MESSAGE_MS };
    dirty = true;
    if (msgTimer) clearTimeout(msgTimer);
    // §18: clear the message by scheduling a repaint once it expires.
    msgTimer = setTimeout(() => {
      msgTimer = null;
      dirty = true;
    }, MESSAGE_MS + 20);
  }

  function press(uv: THREE.Vector2): void {
    const p = uvToPixel(uv.x, uv.y, PANEL_W, PANEL_H);
    const hit = hitAt(hits, p.x, p.y);
    if (!hit) return;
    dirty = true;
    const st = host.assistant();
    switch (hit.id) {
      case "mode-prev":
      case "mode-next":
        if (!host.shiftMode(hit.id === "mode-next" ? 1 : -1)) message(PANEL_TEXT.stillAnswering);
        else pinned = true;
        return;
      case "prompt-0":
      case "prompt-1":
      case "prompt-2": {
        const text = promptLabels(st)[Number(hit.id.slice(-1))];
        if (!text) return;
        const r = host.send(text);
        if (r === "busy") message(PANEL_TEXT.stillAnswering);
        else if (r === "no-key") message(PANEL_TEXT.noKey);
        else pinned = true;
        return;
      }
      case "talk":
        if (!host.toggleTalk()) message(PANEL_TEXT.needVoiceKey);
        return;
      case "type":
        actions.toggleKeys();
        return;
      case "think":
        if (st.busy) host.stop();
        else if (st.thinkHarderTarget) {
          host.thinkHarder();
          pinned = true;
        }
        return;
      case "aloud":
        host.toggleAloud();
        return;
      case "recenter":
        actions.recenter();
        return;
      case "scene":
        message(sceneMessage(host.nextScene()));
        return;
      case "exit":
        actions.exit();
        return;
      case "scroll-up":
        scroll(-PAGE_ROWS);
        return;
      case "scroll-down":
        scroll(PAGE_ROWS);
        return;
      case "conv":
        return;
    }
  }

  /** Scroll by whole rows (positive = later): one row per thumbstick step or wheel notch, a page per chevron. */
  function scroll(rows: number): void {
    const next = scrollBy({ top, pinned, total: totalRows }, rows);
    if (!next) return;
    top = next.top;
    pinned = next.pinned;
    dirty = true;
  }

  return {
    mesh,
    canvas,
    markState: () => {
      stateDirty = true;
    },
    markDirty: () => {
      dirty = true;
    },
    hover(uv: THREE.Vector2 | null): void {
      let id: ButtonId | null = null;
      if (uv) {
        const p = uvToPixel(uv.x, uv.y, PANEL_W, PANEL_H);
        const hit = hitAt(hits, p.x, p.y);
        id = hit && hit.id !== "conv" ? hit.id : null;
      }
      if (id !== hovered) {
        hovered = id;
        dirty = true;
      }
    },
    press,
    scroll,
    message,
    update,
    setAnisotropy(n: number): void {
      texture.anisotropy = n;
    },
    dispose(): void {
      unsubscribe();
      if (msgTimer) clearTimeout(msgTimer);
      texture.dispose();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
  };
}
