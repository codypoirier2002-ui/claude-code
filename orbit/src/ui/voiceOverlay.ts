// The voice overlay (§6.7): full screen over a hidden layout, with the model
// chip, the tap target (the "voice" slot), the status line, what you said, her
// reply, "⌨ Type instead" and "End voice" (also Esc). Mounted in
// app.overlayRoot and redrawn through app.onOverlayRender.

import { modelsLabel, type AssistantState } from "../core/assistant";
import { audioContext } from "../core/audioContext";
import { statusText, type VoiceSessionState } from "../core/session";
import { assistantName, type Settings } from "../core/settings";
import { stripAudioTags } from "../core/tags";
import { buildRows } from "./chat";
import type { AppCtx } from "./context";
import { h } from "./dom";
import { renderMarkdown } from "./markdown";
import type { CharacterSlot } from "./slots";

export const OVERLAY_TEXT = Object.freeze({
  typeInstead: "⌨ Type instead",
  end: "End voice",
  auto: "Auto",
});

/** The slice of the voice session the overlay drives. */
export interface OverlaySession {
  tap(): Promise<void> | void;
  stop(opts?: { keepAnswer?: boolean }): void;
  getState(): VoiceSessionState;
  subscribe(fn: (s: VoiceSessionState) => void): () => void;
  level(): number;
}

/** The model chip (§6.7): the current reply's models, or "Auto" (or the pinned model) before any reply. */
export function overlayModelLabel(replyModels: readonly string[] | null, s: Pick<Settings, "model">): string {
  if (replyModels && replyModels.length) return modelsLabel(replyModels);
  return s.model === "auto" ? OVERLAY_TEXT.auto : modelsLabel([s.model]);
}

/** “what you said”, with typographic quotes; "" when nothing was heard yet. */
export function heardLine(heard: string): string {
  const t = heard.trim();
  return t ? `“${t}”` : "";
}

/** Her reply for this voice turn: the live text while busy, else the last stored reply. */
function currentReply(state: AssistantState): { text: string; models: string[] } | null {
  const rows = buildRows(state);
  const last = rows[rows.length - 1];
  if (!last || last.role !== "assistant") return null;
  return { text: last.text, models: last.models };
}

export interface VoiceOverlayDeps {
  ctx: AppCtx;
  /** app.overlayRoot */
  root: HTMLElement;
  slot: CharacterSlot;
  session: OverlaySession;
  onOverlayRender(fn: () => void): () => void;
  /** Stops her voice (used by "Type instead"). */
  stopSpeaking(): void;
  /** Called after the overlay opens or closes. */
  onToggle?(open: boolean): void;
}

export type VoiceOverlay = ReturnType<typeof createVoiceOverlay>;

export function createVoiceOverlay(deps: VoiceOverlayDeps) {
  const { ctx, root, slot, session } = deps;
  let open = false;
  let levelFrame = 0;
  let lastReplyText: string | null = null;

  const modelChip = h("span", { class: "model-chip vo-model" });
  const target = h(
    "button",
    {
      type: "button",
      class: "vo-target",
      onClick: () => {
        audioContext(); // inside the tap (§5.2)
        void Promise.resolve(session.tap()).catch(() => undefined);
      },
    },
    slot.el,
  );
  const status = h("div", { class: "vo-status", role: "status", "aria-live": "polite" });
  const heard = h("div", { class: "vo-heard" });
  const reply = h("div", { class: "vo-reply md" });
  const typeBtn = h("button", { type: "button", class: "btn ghost vo-type", onClick: () => typeInstead() }, OVERLAY_TEXT.typeInstead);
  const endBtn = h("button", { type: "button", class: "btn vo-end", onClick: () => close() }, OVERLAY_TEXT.end);

  const el = h(
    "div",
    { class: "voice-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Voice", hidden: true },
    h("div", { class: "vo-top" }, modelChip),
    target,
    status,
    heard,
    reply,
    h("div", { class: "vo-actions" }, typeBtn, endBtn),
  );
  root.append(el);

  function render(): void {
    if (!open) return;
    const s = ctx.getSettings();
    const vs = session.getState();
    const st = ctx.assistant.getState();
    const name = assistantName(s);

    el.dataset.state = vs.greeting && vs.state !== "off" ? "speaking" : vs.state;
    target.setAttribute("aria-label", vs.state === "off" ? `Talk to ${name}` : statusText(vs));

    status.textContent = statusText(vs);
    heard.textContent = heardLine(vs.heard);
    heard.hidden = !vs.heard.trim();

    // Her reply: the greeting while she says it, then this session's turns.
    let text = "";
    let models: string[] | null = null;
    if (vs.greeting && st.greeting) {
      text = st.greeting.text;
    } else if (vs.heard.trim()) {
      const r = currentReply(st);
      if (r) {
        text = r.text;
        models = r.models;
      }
    }
    modelChip.textContent = overlayModelLabel(models, s);
    if (text !== lastReplyText) {
      lastReplyText = text;
      reply.innerHTML = text ? renderMarkdown(stripAudioTags(text)) : "";
      reply.hidden = !text;
      reply.scrollTop = reply.scrollHeight;
    }
  }

  // The orb breathes with the mic while listening and with her voice while speaking.
  function levelLoop(): void {
    levelFrame = 0;
    if (!open) return;
    slot.el.style.setProperty("--level", session.level().toFixed(3));
    levelFrame = requestAnimationFrame(levelLoop);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape" || !open) return;
    if (document.querySelector("dialog[open]")) return; // Settings handles its own Esc
    e.preventDefault();
    close();
  }

  const unsubscribe = session.subscribe(() => ctx.requestRender("overlay"));
  const unrender = deps.onOverlayRender(render);

  function show(): void {
    if (open) return;
    open = true;
    lastReplyText = null;
    el.hidden = false;
    document.body.classList.add("voice-mode");
    document.addEventListener("keydown", onKey);
    render();
    target.focus({ preventScroll: true });
    if (!levelFrame) levelFrame = requestAnimationFrame(levelLoop);
    deps.onToggle?.(true);
  }

  function hide(): void {
    if (!open) return;
    open = false;
    el.hidden = true;
    document.body.classList.remove("voice-mode");
    document.removeEventListener("keydown", onKey);
    if (levelFrame) cancelAnimationFrame(levelFrame);
    levelFrame = 0;
    slot.el.style.removeProperty("--level");
    ctx.requestRender("messages", "composer", "status");
    deps.onToggle?.(false);
  }

  /** "End voice" and Esc: stop everything and leave. */
  function close(): void {
    session.stop();
    hide();
  }

  /** "⌨ Type instead": stop listening and speaking, let the answer finish, focus the composer. */
  function typeInstead(): void {
    session.stop({ keepAnswer: true });
    deps.stopSpeaking();
    hide();
    ctx.composer.focus();
  }

  return {
    el,
    open: show,
    close,
    typeInstead,
    render,
    isOpen: () => open,
    dispose(): void {
      hide();
      unsubscribe();
      unrender();
      el.remove();
    },
  };
}
