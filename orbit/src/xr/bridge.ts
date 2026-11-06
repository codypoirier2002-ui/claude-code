// The contract between the 2D app and the VR module (§8). Types only: main.ts
// imports this file with `import type`, so nothing here may pull three.js (or
// anything else) into the main bundle (§2 code splitting).

import type { AssistantState } from "../core/assistant";
import type { VoiceState } from "../core/session";
import type { Settings } from "../core/settings";
import type { Timer } from "../core/workspace";
import type { XrMode } from "../ui/hooks";

export type { XrMode };

/** The orb's four moods (§8.10). */
export type OrbMood = "idle" | "listening" | "thinking" | "speaking";

/** Her spot on the floor in rig space (§8.2), saved in `orbit:avatarSpot`. */
export interface AvatarSpot {
  x: number;
  z: number;
}

/** What the VR module needs to know about voice, read every frame. */
export interface XrVoiceView {
  /** The hands-free session's state. */
  state: VoiceState;
  /** The last transcript heard, for "You: “…”". */
  heard: string;
  /** Mic level 0–1 while listening, else 0. */
  micLevel: number;
  /** Her voice's level 0–1. */
  ttsLevel: number;
  /** TTS is playing (a voice reply or Read aloud). */
  speaking: boolean;
  /** Voice input is set up (an ElevenLabs key or browser recognition). */
  ready: boolean;
}

export type XrSendResult = "sent" | "busy" | "no-key";

/** The app side of the bridge: state getters and actions (main.ts implements it). */
export interface XrHost {
  // ---- State ----
  assistant(): AssistantState;
  settings(): Settings;
  /** Running timers and reminders, soonest first. */
  running(): Timer[];
  voice(): XrVoiceView;
  /** Called whenever something the panel shows may have changed. Returns an unsubscribe. */
  subscribe(fn: () => void): () => void;

  // ---- Actions ----
  /** Send a typed message or a prompt button. */
  send(text: string): XrSendResult;
  /** ■ Stop: stop the reply that is streaming. */
  stop(): void;
  /** 🧠 Think harder. */
  thinkHarder(): void;
  /** ‹ / ›: previous or next mode. False while a reply is busy (the mode can't change). */
  shiftMode(step: 1 | -1): boolean;
  /** 🎙 Talk / ■ End voice. False when voice isn't set up. */
  toggleTalk(): boolean;
  /** The orb and A/X: start voice, send early or interrupt. False when voice isn't set up. */
  tapOrb(): boolean;
  /** 🔈 Silent / 🔊 Aloud. */
  toggleAloud(): void;
  /** 🌅 Scene: cycle settings.environmentId; returns the new scene's name. */
  nextScene(): string;
  /** The immersive session (or the preview) ended: stop voice but keep the answer. */
  onExit(): void;
  /** Phase 7: she glides to a new spot (the spot is already saved). */
  onSpot?(spot: AvatarSpot): void;
}

/** Desktop preview dev parameters (§8.1). */
export interface PreviewParams {
  /** `?yaw=<deg>`: look around; 180 looks behind. */
  yaw: number;
  /** `?avatar-cam`: a close-up of her default spot. */
  avatarCam: boolean;
  /** `?kb`: open the keyboard. */
  kb: boolean;
  /** `?wave`: she waves every 3 s (phase 7; parsed now). */
  wave: boolean;
  /** `?hour=<h>`: the clock sky at that hour. */
  hour: number | null;
}

/** The VR module's face (src/xr/immersive.ts). */
export interface Immersive {
  /** Start an immersive session. Call inside the tap; rejects when the session is refused. */
  enter(mode: XrMode): Promise<void>;
  /** End the session (or the preview). */
  exit(): void;
  /** The one-second clock (§4.3 step 7). */
  tick(): void;
  /** A 6-second message on the panel. */
  notify(text: string): void;
  /** The finished-focus celebration (phase 7 makes her cheer). */
  celebrate(): void;
  isActive(): boolean;
  /** `?xr-preview`: render the VR scene in the page with the mouse as the controller. */
  preview(params: PreviewParams): void;
}

/** The shape of `import("./xr/immersive")`. */
export interface XrModule {
  createImmersive(host: XrHost): Immersive;
}
