// Seams between the 2D shell and the layers it drives. The shell calls these; phase 4 (voice) and phase 5
// (VR) replace the defaults with Object.assign on the exported objects, so no
// caller has to change.

/** The voice layer (§5). Phase 4 registers the real speaker, session and dictation (ui/voiceShell.ts). */
export interface VoiceHooks {
  /** Queue a line after whatever is playing (the clock's timer, reminder and focus lines). */
  speak(text: string): void;
  /** Stop, then speak the whole text (🔊 Read). */
  say(text: string): void;
  /** Something can speak: an ElevenLabs key or the browser's speechSynthesis. */
  canSpeak(): boolean;
  /** Stop any speech (Read aloud off, mode switch, New chat, Erase all). */
  stop(): void;
  /** Her voice is playing right now ("speaking…" in the header). */
  isSpeaking(): boolean;
  /** The hands-free voice overlay is open. */
  inVoiceMode(): boolean;
  /** "Talk", the header face and the hero: open hands-free voice mode. */
  startTalk(): void;
  /** 🎙 in the composer. */
  startDictation(): void;
  /** True while 🎙 is recording (it pulses red). */
  isDictating(): boolean;
  /** True while a dictation is being transcribed (placeholder "Transcribing…"). */
  isTranscribing(): boolean;
}

/** The XR bridge (§4.3, §6.3). main.ts fills it in from the VR module (src/xr/bridge.ts has the module side). */
export type XrMode = "immersive-vr" | "immersive-ar";

export interface XrBridge {
  /** What navigator.xr reported; the header shows "Enter VR" / "Passthrough" only when true. */
  supported: { vr: boolean; ar: boolean };
  /** An immersive session is running. */
  active: boolean;
  /** "Enter VR" (immersive-vr) or "Passthrough" (immersive-ar). Called inside the tap. */
  enter(mode: XrMode): void | Promise<void>;
  /** Called at the end of every one-second clock tick (§4.3 step 7). */
  tick(): void;
  /** A message on the VR panel ("🎯 …", "🎉 …", reminders). */
  notify(text: string): void;
  /** The finished-focus celebration in VR. */
  celebrate(): void;
}
