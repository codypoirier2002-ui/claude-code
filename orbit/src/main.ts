// Orbit's entry point: the 2D shell, the wiring between the engine and the UI,
// the XR bridge and the one-second clock (§4.3). Nothing here imports three.js:
// the VR code (src/xr/) loads only through dynamic import(), and this file sees
// it only through `import type` (§2 code splitting).

import "./ui/style.css";
import { createAmbience, type AmbiencePlace } from "./core/ambience";
import { createAssistant } from "./core/assistant";
import { audioContext, existingAudioContext, playChime } from "./core/audioContext";
import { checkInLine, doneLine } from "./core/focus";
import { MODES } from "./core/modes";
import { CLOCK_ENVIRONMENT_ID, ambienceFile, nextEnvironment } from "./core/environments";
import { getRecognitionCtor, voiceReady } from "./core/session";
import { getSettings, isConfigured, loadSettings, onSettings, updateSettings } from "./core/settings";
import { readJSON, writeJSON } from "./core/store";
import { createWorkspace } from "./core/workspace";
import { createApp } from "./ui/app";
import type { VoiceHooks, XrBridge, XrMode } from "./ui/hooks";
import { toast } from "./ui/toast";
import { installVoice } from "./ui/voiceShell";
import type { Immersive, PreviewParams, XrHost, XrModule } from "./xr/bridge";

loadSettings();

const workspace = createWorkspace({
  initial: readJSON<unknown>("workspace", null),
  persist: (state) => writeJSON("workspace", state),
});

const assistant = createAssistant({ getSettings, workspace, updateSettings });

/**
 * The voice layer. installVoice() below replaces these with
 * Object.assign(voice, {...}) once the shell exists.
 */
export const voice: VoiceHooks = {
  speak: () => {},
  say: () => {},
  canSpeak: () => false,
  stop: () => {},
  isSpeaking: () => false,
  inVoiceMode: () => false,
  startTalk: () => {},
  startDictation: () => {},
  isDictating: () => false,
  isTranscribing: () => false,
};

/**
 * The XR bridge. The VR module fills in enter/tick/notify/celebrate below with
 * Object.assign(xr, {...}); `supported` and `active` are kept current here.
 */
export const xr: XrBridge = {
  supported: { vr: false, ar: false },
  active: false,
  enter: () => {},
  tick: () => {},
  notify: () => {},
  celebrate: () => {},
};

const root = document.getElementById("app");
if (!root) throw new Error("Orbit needs <div id=\"app\">.");
const app = createApp({ root, assistant, workspace, voice, xr, getSettings, updateSettings });

// ---- Voice (§5): the speaker, the hands-free session, dictation, the overlay and the card ----
const voiceShell = installVoice({ app, assistant, voice, getSettings });

/** For later phases and the console: the running app's handles. */
export const orbit = { app, assistant, workspace, voice, xr, voiceShell };
(window as unknown as { orbit?: typeof orbit }).orbit = orbit;

// ---- VR (§8): the host the XR module talks to, support detection and preloading ----
const xrHost: XrHost = {
  assistant: () => assistant.getState(),
  settings: getSettings,
  running: () => workspace.listRunning(),
  voice: () => {
    const { session, speaker } = voiceShell;
    return {
      state: session.state,
      heard: session.heard,
      micLevel: session.state === "listening" ? session.level() : 0,
      ttsLevel: speaker.level(),
      speaking: speaker.speaking,
      ready: voiceReady(getSettings(), getRecognitionCtor() !== null),
    };
  },
  subscribe(fn) {
    const offs = [
      assistant.on("onChange", () => fn()),
      voiceShell.session.subscribe(() => fn()),
      onSettings(() => fn()),
      workspace.subscribe(() => fn()),
    ];
    return () => offs.forEach((off) => off());
  },
  send(text) {
    if (!isConfigured(getSettings())) return "no-key";
    if (assistant.getState().busy) return "busy";
    void assistant.send({ text });
    return "sent";
  },
  stop: () => assistant.stop(),
  thinkHarder: () => void assistant.thinkHarder(),
  shiftMode(step) {
    if (assistant.getState().busy) return false;
    const i = Math.max(0, MODES.findIndex((m) => m.id === assistant.getState().modeId));
    voice.stop();
    return assistant.setMode(MODES[(i + step + MODES.length) % MODES.length].id);
  },
  toggleTalk() {
    const { session } = voiceShell;
    if (session.state !== "off") {
      session.stop();
      return true;
    }
    if (!xrHost.voice().ready) return false;
    audioContext(); // inside the press
    void session.start();
    return true;
  },
  tapOrb() {
    if (!xrHost.voice().ready) return false;
    audioContext();
    void voiceShell.session.tap();
    return true;
  },
  toggleAloud() {
    const on = !getSettings().speakReplies;
    updateSettings({ speakReplies: on });
    if (!on) voice.stop();
  },
  nextScene() {
    // The VR module follows the setting: panorama, lights, particles; the soundscape crossfades.
    const env = nextEnvironment(getSettings().environmentId);
    updateSettings({ environmentId: env.id });
    return env.name;
  },
  sceneFailed(message) {
    toast(message);
    updateSettings({ environmentId: CLOCK_ENVIRONMENT_ID });
  },
  onExit() {
    // Stop listening, but let an answer that is streaming or being spoken finish.
    voiceShell.session.stop({ keepAnswer: true });
    setXrActive(false, "2d");
  },
};

/** Where the app is, for the soundscape's play rules (§8.9). */
let place: AmbiencePlace = "2d";

function setXrActive(on: boolean, where: AmbiencePlace): void {
  place = on ? where : "2d";
  xr.active = on;
  document.body.classList.toggle("in-xr", on);
  app.renderAll();
}

let xrModule: Promise<XrModule> | null = null;
let immersive: Immersive | null = null;
/** Loads the VR chunk once (three.js and src/xr/) and creates the immersive controller. */
function loadImmersive(): Promise<Immersive> {
  xrModule ??= import("./xr/immersive") as Promise<XrModule>;
  return xrModule.then((m) => (immersive ??= m.createImmersive(xrHost)));
}

function startImmersive(imm: Immersive, mode: XrMode): Promise<void> {
  // Mark the app as in VR first so the 2D portraits tear down; undo it if refused.
  setXrActive(true, mode === "immersive-ar" ? "ar" : "vr");
  return imm.enter(mode).catch((err: unknown) => {
    if (!imm.isActive()) setXrActive(false, "2d");
    throw err;
  });
}

Object.assign(xr, {
  enter(mode: XrMode): Promise<void> {
    audioContext(); // inside the tap (§15.7)
    // The module is preloaded at startup, so this normally runs synchronously inside the tap.
    if (immersive) return startImmersive(immersive, mode);
    return loadImmersive().then((imm) => startImmersive(imm, mode));
  },
  tick: () => immersive?.tick(),
  notify: (text: string) => immersive?.notify(text),
  celebrate: () => immersive?.celebrate(),
} satisfies Partial<XrBridge>);

// "Enter VR" and "Passthrough" show only when supported; the module preloads
// straight away so the Enter VR click keeps its user activation (§8.1, §15.7).
type XRSystemLike = { isSessionSupported(mode: XrMode): Promise<boolean> };
const xrSystem = (navigator as Navigator & { xr?: XRSystemLike }).xr;
if (xrSystem) {
  const probe = (mode: XrMode) => xrSystem.isSessionSupported(mode).catch(() => false);
  void Promise.all([probe("immersive-vr"), probe("immersive-ar")]).then(([vr, ar]) => {
    xr.supported = { vr, ar };
    if (vr || ar) {
      app.requestRender("header");
      void loadImmersive().catch(() => {});
    }
  });
}

/** `?xr-preview` and its dev parameters (§8.1). */
function previewParams(search: string): PreviewParams | null {
  const q = new URLSearchParams(search);
  if (!q.has("xr-preview")) return null;
  const num = (k: string): number | null => {
    const raw = q.get(k);
    if (raw === null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return { yaw: num("yaw") ?? 0, avatarCam: q.has("avatar-cam"), kb: q.has("kb"), wave: q.has("wave"), hour: num("hour") };
}

const preview = previewParams(location.search);
if (preview) {
  void loadImmersive().then((imm) => {
    // The preview stands in for an immersive-vr session, soundscape included (after a click).
    setXrActive(true, "vr");
    imm.preview(preview);
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

// ---- Soundscapes (§8.9): the context exists only after a tap, which is the 2D first-tap rule ----
const ambience = createAmbience({
  context: existingAudioContext,
  read: () => {
    const s = getSettings();
    return {
      sceneId: s.environmentId,
      mode: s.ambience,
      volume: s.ambienceVolume,
      place,
      speaking: voiceShell.speaker.speaking,
      listening: voiceShell.session.state === "listening",
    };
  },
  url: (id) => new URL(ambienceFile(id), document.baseURI).href,
  fetchBytes: (url) =>
    fetch(url).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    }),
  every: (ms, fn) => {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  },
});
ambience.start();

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
