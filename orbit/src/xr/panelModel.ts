// The VR panel's words and rules (§8.3, §8.4): pure functions with no three.js
// and no canvas, so they can be unit-tested. panel.ts and keyboard.ts draw
// what these return.

import type { AssistantState } from "../core/assistant";
import { modeById } from "../core/modes";
import { labelOf, modelForRun, shortLabel } from "../core/routing";
import type { Settings } from "../core/settings";
import type { Timer } from "../core/workspace";
import { formatRemaining } from "../ui/dom";
import { formatReminder } from "../ui/format";
import type { XrVoiceView } from "./bridge";

export const PANEL_W = 1280;
export const PANEL_H = 1600;
export const KB_W = 1280;
export const KB_H = 560;

/** Product copy, verbatim from §8.3–8.4. */
export const PANEL_TEXT = Object.freeze({
  autoModels: "◆ Auto: Haiku · Opus · Fable",
  listening: "Listening… (point at the orb and press to send now)",
  gotIt: "Got it…",
  thinking: "Thinking…",
  speaking: "Speaking… (press the orb to interrupt)",
  replying: "Replying…",
  talk: "🎙 Talk",
  talkSetup: "🎙 Talk (setup)",
  endVoice: "■ End voice",
  type: "⌨ Type",
  hideKeys: "⌨ Hide keys",
  thinkHarder: "🧠 Think harder",
  stop: "■ Stop",
  silent: "🔈 Silent",
  aloud: "🔊 Aloud",
  recenter: "⟲ Recenter",
  scene: "🌅 Scene",
  exit: "Exit VR",
  footer: "A/X to talk · Thumbstick to scroll · Trigger or pinch to press",
  noKey: "Add your Claude API key first: Exit VR, then Settings.",
  voiceAside: " (To talk out loud, exit VR and add an ElevenLabs key in Settings → Voice.)",
  needVoiceKey: "Voice needs an ElevenLabs key: Exit VR → Settings → Voice.",
  stillAnswering: "Still answering. Press Stop or wait a moment.",
});

export const KB_TEXT = Object.freeze({
  placeholder: "Type a message…",
  busy: "Still answering. Press Stop or wait, then Send.",
  noKey: "Couldn't send. Add your Claude key in Settings.",
  shift: "⇧",
  symbols: "#+=",
  letters: "ABC",
  space: "space",
  backspace: "⌫",
  send: "Send ➤",
});

/** How long a panel or keyboard message shows (§8.3). */
export const MESSAGE_MS = 6000;

export const sceneMessage = (name: string): string => `Scene: ${name}`;

/** The empty conversation (§8.3). */
export function emptyText(name: string, blurb: string, voiceReady: boolean, configured: boolean): string {
  if (!configured) return PANEL_TEXT.noKey;
  const base = `Hi, I'm ${name}! ${blurb}. Press Talk and just speak, press Type for the keyboard, or pick a suggestion.`;
  return voiceReady ? base : base + PANEL_TEXT.voiceAside;
}

/** Labels over 22 characters are cut to 21 plus "…" (counted in code points). */
export function cutLabel(label: string, max = 22): string {
  const chars = Array.from(label);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : label;
}

/** Three prompt buttons: her follow-ups first, then the mode's quick prompts. */
export function promptLabels(state: Pick<AssistantState, "suggestions" | "modeId">): string[] {
  const out = state.suggestions.filter((s) => s.trim()).slice(0, 3);
  for (const q of modeById(state.modeId).quickPrompts) {
    if (out.length >= 3) break;
    if (!out.includes(q)) out.push(q);
  }
  return out;
}

/** The violet half of the status strip. */
export function modelLine(state: Pick<AssistantState, "busy" | "model">, settings: Pick<Settings, "model">): string {
  if (state.busy) return `◆ ${shortLabel(state.model || modelForRun(settings))} is answering`;
  return settings.model === "auto" ? PANEL_TEXT.autoModels : `◆ ${labelOf(settings.model)}`;
}

/** The mint half: the soonest timer or reminder, plus "+N" when there are more. */
export function timerLine(running: readonly Timer[], now: number): string {
  const t = running[0];
  if (!t) return "";
  const head = t.at !== undefined
    ? `🔔 ${t.label} ${formatReminder(t.endsAt, now, t.daily)}`
    : `⏱ ${t.label} ${formatRemaining(t.endsAt - now)}`;
  return running.length > 1 ? `${head}  +${running.length - 1}` : head;
}

export type StatusTone = "voice" | "live" | "error" | "message";

/**
 * The status line (§8.3 item 4): the voice states, then the live status, then
 * an error, then a transient message. One change: a fresh message shows ahead
 * of the live status, because "Still answering…" is only ever said while a
 * reply is busy and would otherwise never be seen.
 */
export function statusLine(
  state: Pick<AssistantState, "busy" | "status" | "error">,
  voice: Pick<XrVoiceView, "state" | "heard">,
  message: string | null,
): { text: string; tone: StatusTone } | null {
  switch (voice.state) {
    case "listening":
      return { text: PANEL_TEXT.listening, tone: "voice" };
    case "transcribing":
      return { text: PANEL_TEXT.gotIt, tone: "voice" };
    case "thinking":
      return { text: voice.heard ? `You: “${voice.heard}”` : PANEL_TEXT.thinking, tone: "voice" };
    case "speaking":
      return { text: PANEL_TEXT.speaking, tone: "voice" };
    default:
      break;
  }
  if (message) return { text: message, tone: "message" };
  if (state.busy) return { text: state.status || PANEL_TEXT.replying, tone: "live" };
  if (state.error) return { text: state.error.message, tone: "error" };
  return null;
}

/** Row one and row two (§8.3 items 6–7). */
export function buttonLabels(opts: {
  voiceOn: boolean;
  voiceReady: boolean;
  keysOpen: boolean;
  busy: boolean;
  speakReplies: boolean;
}): { talk: string; type: string; think: string; aloud: string } {
  return {
    talk: opts.voiceOn ? PANEL_TEXT.endVoice : opts.voiceReady ? PANEL_TEXT.talk : PANEL_TEXT.talkSetup,
    type: opts.keysOpen ? PANEL_TEXT.hideKeys : PANEL_TEXT.type,
    think: opts.busy ? PANEL_TEXT.stop : PANEL_TEXT.thinkHarder,
    aloud: opts.speakReplies ? PANEL_TEXT.aloud : PANEL_TEXT.silent,
  };
}

/** A ray's UV → canvas pixels: (u·W, (1 − v)·H). */
export function uvToPixel(u: number, v: number, w: number, h: number): { x: number; y: number } {
  return { x: u * w, y: (1 - v) * h };
}

export interface HitRect<Id extends string = string> {
  id: Id;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function hitAt<T extends HitRect>(rects: readonly T[], x: number, y: number): T | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
  }
  return null;
}

/** The signature that decides whether a streaming change is worth a redraw (§8.3 Redraws). */
export function streamSignature(state: Pick<AssistantState, "text" | "status" | "actions" | "model">): string {
  return `${state.text.length}|${state.status}|${state.actions.join(",")}|${state.model}`;
}

// ---- Keyboard ----

export const KB_LETTERS: readonly string[] = ["1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm,.?"];
export const KB_SYMBOLS: readonly string[] = ["1234567890", "!@#$%&*()-", '+=/:;"_<>', "[]{}~^|\\…€"];

export type KbLayer = "letters" | "symbols";

export type KbAction =
  | { kind: "char"; char: string }
  | { kind: "shift" }
  | { kind: "layer" }
  | { kind: "space" }
  | { kind: "backspace" }
  | { kind: "send" };

export interface KbState {
  text: string;
  shift: boolean;
  layer: KbLayer;
}

/** One key press. Shift is one-shot: it switches off after the next key. */
export function applyKey(s: KbState, a: KbAction): KbState {
  switch (a.kind) {
    case "char":
      return { ...s, text: s.text + (s.shift ? a.char.toUpperCase() : a.char), shift: false };
    case "shift":
      return { ...s, shift: !s.shift };
    case "layer":
      return { ...s, layer: s.layer === "letters" ? "symbols" : "letters", shift: false };
    case "space":
      return { ...s, text: `${s.text} `, shift: false };
    case "backspace":
      return { ...s, text: Array.from(s.text).slice(0, -1).join(""), shift: false };
    case "send":
      return { ...s, shift: false };
  }
}
