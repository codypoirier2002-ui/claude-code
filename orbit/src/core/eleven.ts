// ElevenLabs client (§5.1) and error handling (§5.3). Every call goes straight
// from the browser to https://api.elevenlabs.io with the user's key in the
// xi-api-key header; in a demo build with no key it goes to the host's
// same-origin proxy instead (§21, ./demo). All browser dependencies are
// injectable for tests.

import { DEMO_BUILD, elevenRoute } from "./demo";
import { stripAudioTags } from "./tags";

export const ELEVEN_BASE = "https://api.elevenlabs.io";
export const OUTPUT_FORMAT = "mp3_44100_128";
export const STT_MODEL = "scribe_v2";
export const FAST_MODEL = "eleven_flash_v2_5";
export const EXPRESSIVE_MODEL = "eleven_v4";
/** Laura, a premade voice every plan can use from apps (§5.2). */
export const LAURA_VOICE_ID = "FGY2WhTYpPnrIDTdsKH5";
/** previous_text carries the last 100 characters of the previous chunk. */
export const PREVIOUS_TEXT_CHARS = 100;

export type ElevenErrorKind =
  | "invalid_key"
  | "missing_permission"
  | "quota"
  | "voice_unavailable"
  | "rate_limit"
  | "other";

/** Which call failed; names the feature in the "other" message. */
export type ElevenFeature = "transcription" | "voices" | "speech";

export interface ElevenErrorInfo {
  kind: ElevenErrorKind;
  /** Human-readable detail from the body ("" when there is none). */
  detail: string;
  /** The permission name captured for missing_permission, e.g. "speech_to_text". */
  permission?: string;
  /**
   * ElevenLabs' own error status from the body (`detail.status`), e.g.
   * "input_text_empty" or "model_not_found", when it sends one. Not the body's
   * `code` ("invalid_parameters"), which is broader.
   */
  detailStatus?: string;
}

const FEATURE_LABEL: Record<ElevenFeature, string> = {
  transcription: "Transcription",
  voices: "Loading voices",
  speech: "Speech",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Pulls {status, message} out of an ElevenLabs error body; `detail` may be an object, a string or a list. */
function readDetail(body: unknown): { status: string; message: string } {
  if (typeof body === "string") return { status: "", message: body };
  if (!isRecord(body)) return { status: "", message: "" };
  const d = body.detail;
  if (typeof d === "string") return { status: "", message: d };
  if (isRecord(d)) return { status: str(d.status), message: str(d.message) };
  if (Array.isArray(d)) {
    const msgs = d.map((x) => (isRecord(x) ? str(x.msg) || str(x.message) : str(x))).filter(Boolean);
    return { status: "", message: msgs.join("; ") };
  }
  return { status: str(body.status), message: str(body.message) };
}

/** §5.3, ordered rules: the first match wins. A 401 is not always a bad key. */
export function classifyElevenError(status: number, body: unknown): ElevenErrorInfo {
  const { status: dStatus, message } = readDetail(body);
  const text = `${dStatus} ${message}`.toLowerCase();
  const base = { detail: message || dStatus, ...(dStatus ? { detailStatus: dStatus } : {}) };

  if (/missing_permission|missing the permission/.test(text)) {
    // Prefer the message: "missing_permission <The...>" in the status would capture "the".
    const m = /permission\s+([a-z_]+)/i.exec(message) ?? /permission\s+([a-z_]+)/i.exec(text);
    return { kind: "missing_permission", ...base, ...(m ? { permission: m[1].toLowerCase() } : {}) };
  }
  if (/quota|credits|character limit/.test(text)) return { kind: "quota", ...base };
  if (
    status === 402 ||
    /library voice|paid (plan|subscription)|upgrade your subscription|payment_required/.test(text) ||
    /voice_not_found|voice.*(not found|does not exist)/.test(text)
  ) {
    return { kind: "voice_unavailable", ...base };
  }
  if (status === 401 || /invalid_api_key|invalid api key/.test(text)) return { kind: "invalid_key", ...base };
  if (status === 429) return { kind: "rate_limit", ...base };
  return { kind: "other", ...base };
}

/** The feature named in the missing_permission message, from the captured permission name. */
export function permissionLabel(permission?: string): string {
  const p = (permission ?? "").toLowerCase();
  if (p.includes("speech_to_text")) return "Speech to Text";
  if (p.includes("text_to_speech")) return "Text to Speech";
  if (p.includes("voice")) return "Voices";
  return "this feature";
}

/** The six user-facing messages (§5.3). */
export function elevenMessage(
  kind: ElevenErrorKind,
  feature: ElevenFeature,
  status?: number,
  detail?: string,
  permission?: string,
): string {
  switch (kind) {
    case "invalid_key":
      return "ElevenLabs says this key isn't valid. Copy it again from elevenlabs.io → Developers → API keys (it starts with sk_) and paste only the key.";
    case "missing_permission":
      return `Your ElevenLabs key isn't allowed to use ${permissionLabel(permission)}. On elevenlabs.io → Developers → API keys, edit the key and set Text to Speech, Speech to Text and Voices to “Access” (or turn off “Restrict key”).`;
    case "quota":
      return "Your ElevenLabs credits have run out for this month. They refill on your plan's renewal date.";
    case "voice_unavailable":
      return "That voice needs a paid ElevenLabs plan (free plans can only use the built-in voices from apps).";
    case "rate_limit":
      return "ElevenLabs is busy right now. Try again in a moment.";
    default: {
      const head = `${FEATURE_LABEL[feature]} failed (${status ?? 0})`;
      return detail ? `${head}: ${detail}` : head;
    }
  }
}

export class ElevenError extends Error {
  readonly status: number;
  readonly kind: ElevenErrorKind;
  readonly detail: string;
  readonly permission?: string;
  readonly detailStatus?: string;
  readonly feature: ElevenFeature;

  constructor(status: number, info: ElevenErrorInfo, feature: ElevenFeature) {
    super(elevenMessage(info.kind, feature, status, info.detail, info.permission));
    this.name = "ElevenError";
    this.status = status;
    this.kind = info.kind;
    this.detail = info.detail;
    if (info.permission) this.permission = info.permission;
    if (info.detailStatus) this.detailStatus = info.detailStatus;
    this.feature = feature;
  }

  static from(status: number, body: unknown, feature: ElevenFeature): ElevenError {
    return new ElevenError(status, classifyElevenError(status, body), feature);
  }
}

/** Strips a leading `xi-api-key:` or `api key =` label, then every quote, backtick and whitespace. */
export function cleanElevenKey(raw: string): string {
  return String(raw ?? "")
    .replace(/^\s*(?:xi[-_ ]?api[-_ ]?key\s*:|api[-_ ]?key\s*=)/i, "")
    .replace(/["'`‘’“”\s]/g, "");
}

/** File name for the speech-to-text upload, matching the blob type. */
export function speechFileName(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "speech.m4a";
  if (t.includes("ogg")) return "speech.ogg";
  return "speech.webm";
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ElevenClientDeps {
  /** Returns the raw key; it is cleaned before every call. */
  getKey: () => string;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** A demo build (§21): with no key, calls go through the host's proxy. Defaults to the build flag. */
  demo?: boolean;
}

export interface Voice {
  id: string;
  name: string;
}

export interface ElevenClient {
  transcribe(blob: Blob, signal?: AbortSignal): Promise<string>;
  synthesizeFast(text: string, voiceId: string, speed: number, signal?: AbortSignal): Promise<ArrayBuffer>;
  synthesizeExpressive(text: string, voiceId: string, previousText?: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  listVoices(signal?: AbortSignal): Promise<Voice[]>;
}

export function createElevenClient(deps: ElevenClientDeps): ElevenClient {
  const doFetch: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function call(path: string, init: RequestInit, feature: ElevenFeature, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(init.headers);
    const key = cleanElevenKey(deps.getKey());
    const route = elevenRoute(ELEVEN_BASE, path, key, deps.demo ?? DEMO_BUILD);
    if (route.sendKey) headers.set("xi-api-key", key);
    const res = await doFetch(route.url, { ...init, headers, ...(signal ? { signal } : {}) });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep the raw text
      }
      throw ElevenError.from(res.status, body, feature);
    }
    return res;
  }

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify(body),
  });

  return {
    async transcribe(blob, signal) {
      const form = new FormData();
      const name = speechFileName(blob.type);
      // A File carries its name everywhere (some FormData implementations drop the filename argument).
      const file = typeof File === "function" ? new File([blob], name, { type: blob.type }) : blob;
      form.append("file", file, name);
      form.append("model_id", STT_MODEL);
      const res = await call("/v1/speech-to-text", { method: "POST", body: form }, "transcription", signal);
      const data: unknown = await res.json();
      return isRecord(data) ? str(data.text).trim() : "";
    },

    async synthesizeFast(text, voiceId, speed, signal) {
      const res = await call(
        `/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${OUTPUT_FORMAT}`,
        json({ text: stripAudioTags(text), model_id: FAST_MODEL, voice_settings: { speed } }),
        "speech",
        signal,
      );
      return res.arrayBuffer();
    },

    async synthesizeExpressive(text, voiceId, previousText, signal) {
      const body: Record<string, unknown> = { inputs: [{ text, voice_id: voiceId }], model_id: EXPRESSIVE_MODEL };
      if (previousText) body.settings = { previous_text: previousText };
      const res = await call(`/v1/text-to-dialogue/stream?output_format=${OUTPUT_FORMAT}`, json(body), "speech", signal);
      return res.arrayBuffer();
    },

    async listVoices(signal) {
      const res = await call("/v1/voices", { method: "GET" }, "voices", signal);
      const data: unknown = await res.json();
      const list = isRecord(data) && Array.isArray(data.voices) ? data.voices : [];
      return list
        .filter(isRecord)
        .map((v) => ({ id: str(v.voice_id), name: str(v.name) }))
        .filter((v) => v.id !== "");
    },
  };
}
