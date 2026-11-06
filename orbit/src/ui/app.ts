// The 2D shell (§6): builds the layout, owns the render scheduler and wires
// state changes to the parts that show them.

import type { Assistant } from "../core/assistant";
import { environmentById } from "../core/environments";
import { onSettings, type Settings } from "../core/settings";
import type { Workspace } from "../core/workspace";
import { createConversation } from "./chat";
import { createComposer } from "./composer";
import { VOICE_NEEDS_KEY, type AppCtx, type RenderPart, type SettingsSection } from "./context";
import { h } from "./dom";
import { createHeader } from "./header";
import type { VoiceHooks, XrBridge } from "./hooks";
import { createRail } from "./rail";
import { createSettingsDialog } from "./settingsDialog";
import { createSidePanel } from "./sidePanel";
import { createSlot } from "./slots";
import { toast, toastElement } from "./toast";

export interface AppDeps {
  root: HTMLElement;
  assistant: Assistant;
  workspace: Workspace;
  voice: VoiceHooks;
  xr: XrBridge;
  getSettings: () => Settings;
  updateSettings: (patch: Partial<Settings>) => Settings;
}

export type App = ReturnType<typeof createApp>;

/** The absolute `url(...)` for --scene. A relative URL in a custom property would resolve against the stylesheet. */
export function sceneUrl(thumb: string, base: string): string {
  return `url("${new URL(thumb, base).href}")`;
}

export function createApp(deps: AppDeps) {
  const { root, assistant, workspace, voice, xr } = deps;
  const slots = { hero: createSlot("hero"), sidebar: createSlot("sidebar") };
  const pending = new Set<RenderPart>();
  let frame = 0;

  // ---- Context handed to every part ----
  const composerApi = {
    focus: () => composer.focus(),
    restore: (text: string, a?: { data: string }) => composer.restore(text, a),
    clearIfDraft: (text: string) => composer.clearIfDraft(text),
  };
  const ctx: AppCtx = {
    assistant,
    workspace,
    voice,
    xr,
    getSettings: deps.getSettings,
    updateSettings: deps.updateSettings,
    toast,
    openSettings: (section?: SettingsSection) => {
      toggleDrawer(false);
      settings.open(section);
    },
    requestRender,
    toggleDrawer,
    slots,
    composer: composerApi,
    needVoiceKey: () => {
      toast(VOICE_NEEDS_KEY);
      settings.open("voice");
    },
  };

  const rail = createRail(ctx);
  const header = createHeader(ctx);
  const side = createSidePanel(ctx);
  const conversation = createConversation(ctx);
  const composer = createComposer(ctx);
  const settings = createSettingsDialog(ctx);

  // ---- Layout ----
  const chat = h(
    "main",
    { class: "chat" },
    header.el,
    conversation.banner,
    conversation.list,
    conversation.errorBar,
    composer.el,
  );
  const scrim = h("div", { class: "scrim", "aria-hidden": "true", onClick: () => toggleDrawer(false) });
  const grid = h("div", { class: "app" }, rail.el, chat, side.el);
  /** Phase 4 mounts the voice overlay (§6.7) here, outside the grid. */
  const overlayRoot = h("div", { class: "voice-overlay-root" });
  root.replaceChildren(grid, scrim, overlayRoot, toastElement(), settings.el);

  function toggleDrawer(force?: boolean): void {
    const open = force ?? !grid.classList.contains("drawer-open");
    grid.classList.toggle("drawer-open", open);
    scrim.classList.toggle("show", open);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && grid.classList.contains("drawer-open") && !settings.el.open) toggleDrawer(false);
  });

  function renderBackdrop(): void {
    const env = environmentById(deps.getSettings().environmentId);
    chat.classList.toggle("scene-clock", !env.thumb);
    if (env.thumb) chat.style.setProperty("--scene", sceneUrl(env.thumb, document.baseURI));
    else chat.style.removeProperty("--scene");
  }

  // ---- The scheduler: one requestAnimationFrame per burst of changes ----
  function flush(): void {
    frame = 0;
    const parts = new Set(pending);
    pending.clear();
    if (parts.has("backdrop")) renderBackdrop();
    if (parts.has("rail")) rail.render();
    if (parts.has("header")) header.render();
    else if (parts.has("status")) header.renderStatus();
    if (parts.has("side")) side.render();
    if (parts.has("messages")) conversation.render();
    if (parts.has("composer")) composer.render();
    if (parts.has("overlay")) overlayRenderers.forEach((fn) => fn());
  }

  function requestRender(...parts: RenderPart[]): void {
    for (const p of parts) pending.add(p);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  const ALL: RenderPart[] = ["backdrop", "rail", "header", "side", "messages", "composer", "overlay"];
  const overlayRenderers = new Set<() => void>();

  // Streaming: only the messages, the composer, the header status and the overlay.
  assistant.on("onChange", () => requestRender("messages", "composer", "status", "overlay"));
  workspace.subscribe(() => requestRender("side"));
  onSettings(() => requestRender(...ALL));

  // First paint synchronously so there is no empty frame.
  pending.clear();
  for (const p of ALL) pending.add(p);
  flush();

  return {
    ctx,
    slots,
    overlayRoot,
    /** Phase 4's voice overlay registers here to re-render with the messages. */
    onOverlayRender(fn: () => void): () => void {
      overlayRenderers.add(fn);
      return () => overlayRenderers.delete(fn);
    },
    requestRender,
    renderAll: () => requestRender(...ALL),
    /** The clock's step 1. */
    updateCountdowns: () => side.updateCountdowns(),
    openSettings: ctx.openSettings,
    composer,
    conversation,
    toggleDrawer,
  };
}
