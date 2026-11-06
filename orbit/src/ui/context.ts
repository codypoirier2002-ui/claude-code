// What every 2D shell module gets from app.ts.

import type { Assistant, Attachment } from "../core/assistant";
import type { Settings } from "../core/settings";
import type { Workspace } from "../core/workspace";
import type { VoiceHooks, XrBridge } from "./hooks";
import type { CharacterSlot } from "./slots";

export type RenderPart = "rail" | "header" | "status" | "side" | "messages" | "composer" | "backdrop" | "overlay";

/** Settings sections openSettings can scroll to. */
export type SettingsSection = "apiKey" | "voice";

export interface AppCtx {
  assistant: Assistant;
  workspace: Workspace;
  voice: VoiceHooks;
  xr: XrBridge;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  toast(message: string): void;
  openSettings(section?: SettingsSection): void;
  /** Coalesced into one requestAnimationFrame. */
  requestRender(...parts: RenderPart[]): void;
  toggleDrawer(force?: boolean): void;
  slots: { hero: CharacterSlot; sidebar: CharacterSlot };
  /** Composer access for the conversation (Retry, failed sends) and the voice overlay. */
  composer: {
    focus(): void;
    /** Put a failed message back (text and image) unless the user already typed something. */
    restore(text: string, attachment?: Attachment): void;
    /** Clear the draft if it still holds exactly this text (Retry resends it). */
    clearIfDraft(text: string): void;
  };
  /** Voice not ready (§5.6): toast and open Settings at Voice. */
  needVoiceKey(): void;
}

export const VOICE_NEEDS_KEY = "Voice needs an ElevenLabs key (Quest Browser has no built-in speech recognition).";
