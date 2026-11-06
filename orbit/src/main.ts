// Orbit's entry point: the 2D shell, the wiring between the engine and the UI,
// the XR bridge and the one-second clock (§4.3). Nothing here imports three.js:
// phase 5 loads the VR code through dynamic import() and fills in `xr`.

import "./ui/style.css";
import { createAssistant } from "./core/assistant";
import { audioContext, existingAudioContext, playChime } from "./core/audioContext";
import { checkInLine, doneLine } from "./core/focus";
import { getSettings, loadSettings, updateSettings } from "./core/settings";
import { readJSON, writeJSON } from "./core/store";
import { createWorkspace } from "./core/workspace";
import { createApp } from "./ui/app";
import { VOICE_NEEDS_KEY } from "./ui/context";
import type { VoiceHooks, XrBridge, XrMode } from "./ui/hooks";
import { toast } from "./ui/toast";

loadSettings();

const workspace = createWorkspace({
  initial: readJSON<unknown>("workspace", null),
  persist: (state) => writeJSON("workspace", state),
});

const assistant = createAssistant({ getSettings, workspace, updateSettings });

/**
 * The voice layer. Phase 4 replaces these with Object.assign(voice, {...}) when
 * it registers the speaker; until then speaking is a no-op and Talk/🎙 explain
 * that a key is needed (§5.6).
 */
export const voice: VoiceHooks = {
  speak: () => {},
  stop: () => {},
  isSpeaking: () => false,
  inVoiceMode: () => false,
  startTalk: () => app.ctx.needVoiceKey(),
  startDictation: () => app.ctx.needVoiceKey(),
  isDictating: () => false,
};

/**
 * The XR bridge. Phase 5 replaces enter/tick/notify/celebrate (and keeps
 * `supported`/`active` current) with Object.assign(xr, {...}).
 */
export const xr: XrBridge = {
  supported: { vr: false, ar: false },
  active: false,
  enter: (_mode: XrMode) => toast("VR comes in a later build"),
  tick: () => {},
  notify: () => {},
  celebrate: () => {},
};

const root = document.getElementById("app");
if (!root) throw new Error("Orbit needs <div id=\"app\">.");
const app = createApp({ root, assistant, workspace, voice, xr, getSettings, updateSettings });

/** For later phases and the console: the running app's handles. */
export const orbit = { app, assistant, workspace, voice, xr, VOICE_NEEDS_KEY };

// ---- WebXR support: "Enter VR" and "Passthrough" show only when supported ----
type XRSystemLike = { isSessionSupported(mode: XrMode): Promise<boolean> };
const xrSystem = (navigator as Navigator & { xr?: XRSystemLike }).xr;
if (xrSystem) {
  const probe = (mode: XrMode) => xrSystem.isSessionSupported(mode).catch(() => false);
  void Promise.all([probe("immersive-vr"), probe("immersive-ar")]).then(([vr, ar]) => {
    xr.supported = { vr, ar };
    if (vr || ar) app.requestRender("header");
  });
}

// ---- Audio unlock: the chime needs a running AudioContext, which needs a tap ----
function unlockAudio(): void {
  const ctx = audioContext();
  if (ctx && ctx.state === "running") {
    window.removeEventListener("pointerdown", unlockAudio, true);
    window.removeEventListener("keydown", unlockAudio, true);
  }
}
window.addEventListener("pointerdown", unlockAudio, true);
window.addEventListener("keydown", unlockAudio, true);

// ---- The one-second clock (§4.3) ----
function clockTick(): void {
  // 1. Countdown text in place.
  app.updateCountdowns();

  // 2. Focus check-ins.
  for (const t of workspace.dueCheckIns()) {
    const line = checkInLine(t.focus?.task);
    toast(`🎯 ${line}`);
    xr.notify(`🎯 ${line}`);
    if (!voice.inVoiceMode() && !assistant.getState().busy) voice.speak(line);
  }

  // 3–6. Everything that came due.
  for (const t of workspace.tick()) {
    playChime(existingAudioContext() ?? audioContext());
    if (t.focus) {
      const line = doneLine(t.focus.task, t.focus.breakMinutes);
      toast(`🎉 ${line}`);
      xr.notify(`🎉 ${line}`);
      if (!voice.inVoiceMode()) voice.speak(line);
      if (t.focus.breakMinutes > 0) workspace.addTimer(t.focus.breakMinutes, "Break");
      xr.celebrate();
    } else if (t.at !== undefined) {
      toast(`🔔 Reminder: ${t.label}`);
      xr.notify(`🔔 Reminder: ${t.label}`);
      voice.speak(`Hey, reminder: ${t.label}.`);
    } else {
      toast(`⏰ ${t.label}: time's up`);
      xr.notify(`⏰ ${t.label}: time's up`);
      voice.speak(`${t.label}. Time's up.`);
    }
  }

  // 7.
  xr.tick();
}
setInterval(clockTick, 1000);
clockTick();

// The greeting (§3.8): at startup when configured, throttled inside the engine.
void assistant.fetchGreeting();
