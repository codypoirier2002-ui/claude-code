// Settings (§9): localStorage `orbit:settings`, schema version 4.

import { DEMO_BUILD } from "./demo";
import { readJSON, writeJSON } from "./store";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type AmbienceMode = "off" | "vr" | "always";

export interface Settings {
  version: number;
  apiKey: string;
  baseURL: string;
  model: string;
  effort: Effort;
  webSearch: boolean;
  speakReplies: boolean;
  modeId: string;
  elevenLabsKey: string;
  voiceId: string;
  voiceSpeed: number;
  bargeIn: boolean;
  expressiveVoice: boolean;
  lookOnRequest: boolean;
  suggestReplies: boolean;
  environmentId: string;
  personalityId: string;
  assistantName: string;
  showCharacter: boolean;
  voiceCardDismissed: boolean;
  ambience: AmbienceMode;
  ambienceVolume: number;
  startInVR: boolean;
}

export const SETTINGS_VERSION = 4;
export const DEFAULT_VOICE_ID = "7YaUDeaStRuoYg3FKsmU";
export const DEFAULT_ASSISTANT_NAME = "Callie";

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: SETTINGS_VERSION,
  apiKey: "",
  baseURL: "",
  model: "auto",
  effort: "medium",
  webSearch: true,
  speakReplies: false,
  modeId: "everyday",
  elevenLabsKey: "",
  voiceId: DEFAULT_VOICE_ID,
  voiceSpeed: 1.1,
  bargeIn: true,
  expressiveVoice: true,
  lookOnRequest: false,
  suggestReplies: true,
  environmentId: "clock",
  personalityId: "cheeky",
  assistantName: DEFAULT_ASSISTANT_NAME,
  showCharacter: true,
  voiceCardDismissed: false,
  ambience: "vr",
  ambienceVolume: 0.5,
  startInVR: true,
});

export interface VoicePreset {
  id: string;
  name: string;
  note: string;
}

export const VOICE_PRESETS: readonly VoicePreset[] = [
  { id: "7YaUDeaStRuoYg3FKsmU", name: "Callie", note: "American, sweet & witty" },
  { id: "L0yTtpRXzdyzQlzALhgD", name: "Marissa", note: "American, cute & excitable" },
  { id: "ZF6FPAbjXT4488VcRRnw", name: "Amelia", note: "British, young & enthusiastic" },
  { id: "6fZce9LFNG3iEITDfqZZ", name: "Charlotte", note: "British Gen Z, sweet & modern" },
  { id: "bMxLr8fP6hzNRRi9nJxU", name: "Ivanna", note: "American, cute & candid" },
  { id: "8DzKSPdgEQPaK5vKG0Rs", name: "Vanessa", note: "Californian, bubbly" },
];

export interface ModelOption {
  id: string;
  label: string;
}

export const MODELS: readonly ModelOption[] = [
  { id: "auto", label: "Auto: Haiku chats, Opus thinks, Fable for tough ones" },
  { id: "claude-haiku-5-5", label: "Always Claude Haiku 5.5 (fastest)" },
  { id: "claude-opus-5-5", label: "Always Claude Opus 5.5 (smart)" },
  { id: "claude-fable-5-1", label: "Always Claude Fable 5.1 (most capable, priciest)" },
];

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

const SPEED_MIN = 0.7;
const SPEED_MAX = 1.2;
/** The voice the version-1/2 app used as its default. */
const LEGACY_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
/** Amelia was briefly the default in version 3. */
const V3_DEFAULT_VOICE_ID = "ZF6FPAbjXT4488VcRRnw";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pure migration (§9): merge saved settings over the defaults, then apply the
 * version rules. Anything that is not an object migrates as "nothing saved".
 */
export function migrateSettings(raw: unknown): Settings {
  const saved = isRecord(raw) ? raw : {};
  const s = { ...DEFAULT_SETTINGS, ...saved } as Settings;
  const savedVersion = typeof saved.version === "number" ? saved.version : 0;

  if (savedVersion < 2) {
    if (saved.model === undefined || saved.model === "claude-opus-5-5") s.model = "auto";
    s.effort = "medium";
  }
  if (savedVersion < 3) {
    if (saved.voiceId === undefined || saved.voiceId === LEGACY_VOICE_ID) s.voiceId = DEFAULT_VOICE_ID;
  }
  if (savedVersion === 3 && saved.voiceId === V3_DEFAULT_VOICE_ID) {
    s.voiceId = DEFAULT_VOICE_ID;
  }

  const speed = typeof saved.voiceSpeed === "number" && Number.isFinite(saved.voiceSpeed)
    ? saved.voiceSpeed
    : DEFAULT_SETTINGS.voiceSpeed;
  s.voiceSpeed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));

  if (!MODELS.some((m) => m.id === s.model)) s.model = "auto";

  s.version = SETTINGS_VERSION;
  return s;
}

type Listener = (s: Settings) => void;

let current: Settings | null = null;
const listeners = new Set<Listener>();

/** Reads `orbit:settings`, migrates it and makes it current. */
export function loadSettings(): Settings {
  current = migrateSettings(readJSON<unknown>("settings", null));
  return current;
}

export function getSettings(): Settings {
  return current ?? loadSettings();
}

/** Shallow merge, save (kept in memory if the write fails), notify listeners. */
export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...getSettings(), ...patch };
  writeJSON("settings", current);
  for (const fn of [...listeners]) fn(current);
  return current;
}

export function onSettings(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Her display name: strip <>[]{}" and backticks, collapse whitespace, 24 chars, else "Callie". */
export function assistantName(s: Pick<Settings, "assistantName">): string {
  const raw = typeof s.assistantName === "string" ? s.assistantName : "";
  const cleaned = raw.replace(/[<>[\]{}"`]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
  return cleaned || DEFAULT_ASSISTANT_NAME;
}

/** Claude can be reached: a key, a proxy, or (demo builds, §21) the host's demo server. */
export function isConfigured(s: Pick<Settings, "apiKey" | "baseURL">, demo = DEMO_BUILD): boolean {
  return demo || s.apiKey.trim() !== "" || s.baseURL.trim() !== "";
}

/** ElevenLabs can be reached: a key, or (demo builds, §21) the host's demo server. */
export function hasVoiceKey(s: Pick<Settings, "elevenLabsKey">, demo = DEMO_BUILD): boolean {
  return demo || s.elevenLabsKey.trim() !== "";
}
