// The rail (§6.2): brand, the sidebar portrait, the seven modes and Settings.

import { MODES } from "../core/modes";
import { assistantName } from "../core/settings";
import type { AppCtx } from "./context";
import { h } from "./dom";

export function createRail(ctx: AppCtx) {
  const el = h("nav", { class: "rail", "aria-label": "Modes" });

  function switchMode(id: string): void {
    const { assistant, voice } = ctx;
    assistant.stop();
    voice.stop();
    assistant.setMode(id);
    ctx.toggleDrawer(false);
    ctx.requestRender("rail", "header", "messages", "composer");
  }

  function render(): void {
    const s = ctx.getSettings();
    const name = assistantName(s);
    const active = ctx.assistant.getState().modeId;

    const brand = h(
      "div",
      { class: "brand" },
      h("span", { class: "brand-mark", "aria-hidden": "true" }),
      h("span", { class: "brand-name" }, "Orbit"),
    );

    const portrait = h(
      "button",
      {
        type: "button",
        class: "portrait",
        title: `Talk to ${name}`,
        "aria-label": `Talk to ${name}`,
        onClick: () => ctx.voice.startTalk(),
      },
      ctx.slots.sidebar.el,
    );

    const modes = h(
      "div",
      { class: "modes", role: "list" },
      MODES.map((m) =>
        h(
          "button",
          {
            type: "button",
            role: "listitem",
            class: ["mode", m.id === active && "active"],
            "aria-current": m.id === active ? "true" : null,
            title: `${m.name}: ${m.blurb}`,
            onClick: () => {
              if (m.id !== ctx.assistant.getState().modeId) switchMode(m.id);
              else ctx.toggleDrawer(false);
            },
          },
          h("span", { class: "mode-icon", "aria-hidden": "true" }, m.icon),
          h("span", { class: "mode-text" }, h("span", { class: "mode-name" }, m.name), h("span", { class: "mode-blurb" }, m.blurb)),
        ),
      ),
    );

    const settings = h(
      "button",
      { type: "button", class: "rail-settings", onClick: () => ctx.openSettings(), "aria-label": "Settings" },
      h("span", { "aria-hidden": "true" }, "⚙"),
      h("span", { class: "rail-settings-label" }, " Settings"),
    );

    el.replaceChildren(brand, portrait, modes, settings);
  }

  return { el, render };
}
