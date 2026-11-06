// The voice wiring (§5, §6.7, §6.8): the speaker, the hands-free session,
// composer dictation, Read aloud, the voice overlay and the voice card, all
// registered on the shell's `voice` hooks with Object.assign.

import type { Assistant } from "../core/assistant";
import { audioContext } from "../core/audioContext";
import { captureFrame } from "../core/camera";
import { createDictation, createVoiceSession, getRecognitionCtor, voiceReady } from "../core/session";
import { hasVoiceKey, onSettings, type Settings } from "../core/settings";
import { createSpeaker } from "../core/voice";
import type { App } from "./app";
import type { VoiceHooks } from "./hooks";
import { createVoiceCard } from "./voiceCard";
import { createVoiceOverlay } from "./voiceOverlay";

export const NO_AUDIO = "This browser can't play audio.";

/** The app-wide AudioContext for the voice core, which needs one or an error. */
export function requireAudioContext(): AudioContext {
  const ctx = audioContext();
  if (!ctx) throw new Error(NO_AUDIO);
  return ctx;
}

export interface VoiceShellDeps {
  app: App;
  assistant: Assistant;
  voice: VoiceHooks;
  getSettings: () => Settings;
}

export function installVoice(deps: VoiceShellDeps) {
  const { app, assistant, voice, getSettings } = deps;
  const { ctx } = app;

  // ---- Speaker (§5.2) ----
  const speaker = createSpeaker({
    audioContext: requireAudioContext,
    getSettings,
    notify: (m) => ctx.toast(m),
    onError: (m) => ctx.toast(m),
    // §18: refresh the header status when her speech ends (and when it starts).
    onSpeakingChange: () => ctx.requestRender("status", "overlay"),
  });

  // ---- The hands-free session (§5.6) ----
  /** When the greeting last spoken arrived, so it is said only once. */
  let spokenGreetingAt: number | null = null;
  const session = createVoiceSession({
    getSettings,
    assistant,
    speaker,
    audioContext: requireAudioContext,
    // With Look-on-request on, a look phrase takes a camera frame and sends it with the words (§4.6).
    captureFrame: () => captureFrame(),
    takeGreeting: () => {
      const g = assistant.getState().greeting;
      if (!g || g.at === spokenGreetingAt) return null;
      spokenGreetingAt = g.at;
      return { text: g.text, at: g.at };
    },
    notify: (m) => ctx.toast(m),
    openVoiceSettings: () => ctx.openSettings("voice"),
  });

  // ---- Composer dictation (§5.6) ----
  const dictation = createDictation({
    getSettings,
    audioContext: requireAudioContext,
    onToast: (m) => ctx.toast(m),
    onPhase: () => ctx.requestRender("composer"),
    onText: (text) => {
      const draft = app.composer.getDraft().replace(/\s+$/, "");
      app.composer.setDraft(draft ? `${draft} ${text}` : text);
    },
  });

  const overlay = createVoiceOverlay({
    ctx,
    root: app.overlayRoot,
    slot: ctx.slots.voice,
    session,
    onOverlayRender: app.onOverlayRender,
    stopSpeaking: () => speaker.stop(),
  });

  const ready = () => voiceReady(getSettings(), getRecognitionCtor() !== null);

  // ---- Read aloud (§6.3): her typed replies, spoken when voice mode is off ----
  /** The reply now streaming is being read aloud (never one the voice session asked for). */
  let reading = false;
  const sessionActive = () => overlay.isOpen() || session.state !== "off";
  assistant.on("onReplyStart", () => {
    reading = getSettings().speakReplies && !sessionActive();
    if (reading) speaker.stop();
  });
  assistant.on("onTextDelta", (d) => {
    if (!reading) return;
    if (!getSettings().speakReplies || sessionActive()) {
      reading = false;
      return;
    }
    speaker.feed(d);
  });
  assistant.on("onTextReset", () => {
    if (reading) speaker.stop(); // a declined fallback reply is hidden from voice too
  });
  assistant.on("onChange", (s) => {
    if (reading && !s.busy) {
      reading = false;
      if (getSettings().speakReplies && !sessionActive()) speaker.flush();
    }
  });

  function startTalk(): void {
    if (!ready()) {
      ctx.needVoiceKey();
      return;
    }
    // Inside the tap: create or resume the AudioContext (§5.2).
    if (!audioContext()) {
      ctx.toast(NO_AUDIO);
      return;
    }
    reading = false;
    dictation.cancel();
    void session.start();
    overlay.open();
  }

  function startDictation(): void {
    if (dictation.phase === "idle" && !ready()) {
      ctx.needVoiceKey();
      return;
    }
    audioContext();
    void dictation.toggle();
  }

  const canSpeak = () => hasVoiceKey(getSettings()) || typeof globalThis.speechSynthesis !== "undefined";

  Object.assign(voice, {
    speak: (text: string) => speaker.announce(text),
    say: (text: string) => {
      audioContext();
      reading = false;
      speaker.say(text);
    },
    canSpeak,
    stop: () => {
      reading = false;
      speaker.stop();
    },
    isSpeaking: () => speaker.speaking,
    inVoiceMode: () => overlay.isOpen(),
    startTalk,
    startDictation,
    isDictating: () => dictation.phase === "listening",
    isTranscribing: () => dictation.phase === "transcribing",
  } satisfies VoiceHooks);

  // ---- The "Let {name} talk" card (§6.8) ----
  const card = createVoiceCard({ ctx, slot: app.conversation.voiceCardSlot });
  card.sync();
  onSettings(() => card.sync());
  ctx.requestRender("messages");

  return { speaker, session, dictation, overlay, card };
}
