// The chat header (§6.3): who she is with the live status line, the mode
// heading, and the chips.

import { audioContext } from "../core/audioContext";
import { modeById } from "../core/modes";
import { assistantName } from "../core/settings";
import type { AppCtx } from "./context";
import { h } from "./dom";
import type { XrMode } from "./hooks";

export const FACE_SRC = "character/face.webp";

/** The live status line (§6.3). */
export function headerStatus(opts: { speaking: boolean; busy: boolean; text: string; modeName: string }): string {
  if (opts.speaking) return "speaking…";
  if (opts.busy) return opts.text ? "typing…" : "thinking…";
  return `${opts.modeName} mode`;
}

export function createHeader(ctx: AppCtx) {
  const el = h("header", { class: "chat-head" });
  let statusEl: HTMLElement | null = null;
  let whoEl: HTMLElement | null = null;

  function enterXr(mode: XrMode): void {
    audioContext(); // inside the tap (§5.2)
    void Promise.resolve()
      .then(() => ctx.xr.enter(mode))
      .catch(() => {
        // Phase 5 decides what a refused session shows; never an unhandled rejection.
      });
  }

  function toggleChip(label: string, on: boolean, title: string, onClick: () => void): HTMLElement {
    return h(
      "button",
      { type: "button", class: ["chip", "toggle", on && "on"], "aria-pressed": on ? "true" : "false", title, onClick },
      h("span", { class: "dot", "aria-hidden": "true" }),
      label,
    );
  }

  function renderStatus(): void {
    if (!statusEl || !whoEl) return;
    const st = ctx.assistant.getState();
    const speaking = ctx.voice.isSpeaking();
    statusEl.textContent = headerStatus({
      speaking,
      busy: st.busy,
      text: st.text,
      modeName: modeById(st.modeId).name,
    });
    whoEl.classList.toggle("live", st.busy || speaking);
  }

  function render(): void {
    const s = ctx.getSettings();
    const name = assistantName(s);
    const mode = modeById(ctx.assistant.getState().modeId);

    statusEl = h("span", { class: "who-status", "aria-live": "polite" });
    whoEl = h(
      "button",
      { type: "button", class: "who", title: `Talk to ${name}`, onClick: () => ctx.voice.startTalk() },
      h(
        "span",
        { class: "who-face" },
        h("img", { src: FACE_SRC, alt: "", width: "46", height: "46", decoding: "async" }),
        h("span", { class: "online", "aria-hidden": "true" }),
      ),
      h("span", { class: "who-text" }, h("span", { class: "who-name" }, name), statusEl),
    );

    const heading = h(
      "div",
      { class: "mode-heading" },
      h("div", { class: "mode-heading-name" }, `${mode.icon} ${mode.name}`),
      h("div", { class: "mode-heading-blurb" }, mode.blurb),
    );

    const chips = h(
      "div",
      { class: "chips" },
      h(
        "button",
        { type: "button", class: "chip talk", title: `Talk to ${name} hands-free`, onClick: () => ctx.voice.startTalk() },
        h("span", { class: "pulse-dot", "aria-hidden": "true" }),
        "Talk",
      ),
      toggleChip("Web", s.webSearch, "Let her search the web", () => ctx.updateSettings({ webSearch: !ctx.getSettings().webSearch })),
      toggleChip("Read aloud", s.speakReplies, "Read her replies out loud", () => {
        const on = !ctx.getSettings().speakReplies;
        ctx.updateSettings({ speakReplies: on });
        if (!on) ctx.voice.stop();
      }),
      h(
        "button",
        {
          type: "button",
          class: "chip",
          onClick: () => {
            ctx.voice.stop();
            ctx.assistant.newChat();
            ctx.requestRender("messages", "composer");
          },
        },
        "New chat",
      ),
      ctx.xr.supported.vr &&
        h("button", { type: "button", class: "chip xr", onClick: () => enterXr("immersive-vr") }, "Enter VR"),
      ctx.xr.supported.ar &&
        h("button", { type: "button", class: "chip xr", onClick: () => enterXr("immersive-ar") }, "Passthrough"),
      h("button", { type: "button", class: "chip today", onClick: () => ctx.toggleDrawer(), "aria-controls": "side-panel" }, "Today"),
    );

    el.replaceChildren(whoEl, heading, chips);
    renderStatus();
  }

  return { el, render, renderStatus };
}
