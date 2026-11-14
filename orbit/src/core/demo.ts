// Demo builds (§21): `VITE_ORBIT_DEMO=1` at build time, for a hosted link that
// works without keys. A visitor who has entered no Claude key and no proxy of
// their own talks to Claude through the host's same-origin proxy at
// /api/claude; one with no ElevenLabs key talks to ElevenLabs through
// /api/eleven?path=<path and query>. The host's keys stay server-side
// (api/claude/v1/messages.ts and api/eleven.ts), behind a model allowlist,
// size caps and a per-IP limit. A key the visitor enters always wins, for that
// service. Ordinary builds never take these paths.

import type { Settings } from "./settings";

/** Set at build time: `VITE_ORBIT_DEMO=1 npm run build`. */
export const DEMO_BUILD: boolean = import.meta.env.VITE_ORBIT_DEMO === "1";

export const DEMO_CLAUDE_PATH = "/api/claude";
export const DEMO_ELEVEN_PATH = "/api/eleven";
/** The demo server takes at most 1,200 characters of speech per call; the speaker splits below that. */
export const DEMO_SPEECH_MAX_CHARS = 1000;
/** The demo server runs Haiku and Opus. Fable requests run on Opus. */
export const DEMO_TOP_MODEL = "claude-opus-5-5";

/** True when Claude calls go through the host's demo server: a demo build and no key or proxy of the visitor's own. */
export function usesDemoServer(s: Pick<Settings, "apiKey" | "baseURL">, demo = DEMO_BUILD): boolean {
  return demo && s.apiKey.trim() === "" && s.baseURL.trim() === "";
}

export interface ClaudeTarget {
  apiKey: string;
  baseURL: string;
  /** The call goes to the host's demo server. */
  demo: boolean;
}

/** This page's origin, read only when needed (tests have no `location`). */
function pageOrigin(): string {
  return typeof location === "undefined" ? "" : location.origin;
}

/**
 * Where Claude calls go: the visitor's key or proxy as entered, else (demo
 * builds) the host's proxy. The SDK wants an absolute base URL, so the
 * same-origin path is made absolute with this page's origin.
 */
export function claudeTarget(
  s: Pick<Settings, "apiKey" | "baseURL">,
  demo = DEMO_BUILD,
  origin: () => string = pageOrigin,
): ClaudeTarget {
  if (!usesDemoServer(s, demo)) return { apiKey: s.apiKey.trim(), baseURL: s.baseURL.trim(), demo: false };
  return { apiKey: "", baseURL: `${origin()}${DEMO_CLAUDE_PATH}`, demo: true };
}

/** The model a demo-server call asks for: Fable runs on Opus there; Haiku and Opus as they are. */
export function demoModel(model: string): string {
  return model.startsWith("claude-fable") ? DEMO_TOP_MODEL : model;
}

export interface ElevenRoute {
  url: string;
  /** Send the visitor's key in `xi-api-key` (direct calls only). */
  sendKey: boolean;
}

/**
 * Where an ElevenLabs call goes. With a key, or in an ordinary build, straight
 * to ElevenLabs with the key, exactly as before. In a demo build with no key,
 * to the host's proxy, which adds its own key: `path` (with its query) rides
 * along URL-encoded.
 */
export function elevenRoute(base: string, path: string, key: string, demo = DEMO_BUILD): ElevenRoute {
  if (key || !demo) return { url: base + path, sendKey: true };
  return { url: `${DEMO_ELEVEN_PATH}?path=${encodeURIComponent(path)}`, sendKey: false };
}

/**
 * Cuts speech longer than `max` characters into pieces at the last sentence
 * end, else comma, else space before the limit (a hard cut only when a run of
 * text has none). The demo server refuses longer speech.
 */
export function splitSpeech(text: string, max: number): string[] {
  if (!(max > 0) || text.length <= max) return text ? [text] : [];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    let cut = -1;
    for (const re of [/[.!?…][)"'”’]?\s/g, /[,;:]\s/g, /\s/g]) {
      let m: RegExpExecArray | null;
      let last = -1;
      while ((m = re.exec(head))) last = m.index + m[0].length;
      if (last > max / 3) {
        cut = last;
        break;
      }
    }
    if (cut < 0) cut = max;
    const piece = rest.slice(0, cut).trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}
