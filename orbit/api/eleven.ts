// The demo server's ElevenLabs proxy (§21): /api/eleven?path=<encoded path and query>.
// A Vercel Function (Node.js runtime, Web-standard handler). Demo builds of
// Orbit (VITE_ORBIT_DEMO=1) send voice calls here when the visitor has no
// ElevenLabs key; this adds the host's key (ELEVENLABS_API_KEY, set in the
// Vercel dashboard) and streams the answer back.
//
// Only the four calls Orbit makes get through, each with its own method and
// query (src/core/eleven.ts):
//   POST /v1/speech-to-text
//   POST /v1/text-to-speech/{voice}/stream?output_format=…
//   POST /v1/text-to-dialogue/stream?output_format=…
//   GET  /v1/voices
// Guards, all best-effort speed bumps (curl can fake headers; the ElevenLabs
// account's own credit limit is the real cap): same origin only, a per-IP
// limit kept in this instance's memory, a 4 MB body and 1,200 characters of
// speech per call. ElevenLabs' own answers, errors included, pass through
// untouched (the page reacts to quota and voice errors), except a rejected
// host key, which is not the visitor's to fix.
//
// Self-contained on purpose: Vercel bundles each file under api/ on its own.

const UPSTREAM = "https://api.elevenlabs.io";

export const ELEVEN_LIMITS = Object.freeze({
  /** Request body, in bytes (audio for speech-to-text). */
  maxBody: 4 * 1024 * 1024,
  /** Characters of speech per call. */
  maxSpeech: 1200,
  /** Per IP, per instance: one spoken reply is one call per sentence or so. */
  perIp: 240,
  windowMs: 10 * 60 * 1000,
});

type Env = Record<string, string | undefined>;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProxyDeps {
  env: Env;
  fetch: FetchFn;
  now: () => number;
}

// ---- Shared guards (duplicated in api/claude/v1/messages.ts: no local imports) ----

/** Same origin: the browser says so, or the Origin header names this host. */
export function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const self = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return host.toLowerCase() === self.toLowerCase();
}

/** The caller's IP as Vercel reports it. */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return req.headers.get("x-vercel-forwarded-for")?.trim() || req.headers.get("x-real-ip")?.trim() || forwarded || "unknown";
}

/**
 * A sliding-window counter per key, in memory. Returns 0 when allowed, else
 * the seconds to wait. Keys are kept in order of last use, so past `maxKeys`
 * the least recently seen go first.
 */
export function createLimiter(limit: number, windowMs: number, maxKeys = 5000) {
  const hits = new Map<string, number[]>();
  return (key: string, now: number): number => {
    const since = now - windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > since);
    hits.delete(key);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
    }
    recent.push(now);
    hits.set(key, recent);
    for (const k of hits.keys()) {
      if (hits.size <= maxKeys) break;
      hits.delete(k);
    }
    return 0;
  };
}

/** Reads the body, or null once it passes `max` bytes. */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Only these upstream headers reach the page. Never content-encoding or content-length: fetch has decoded the body. */
const PASS_BACK = ["content-type", "request-id", "retry-after", "x-should-retry"];

export function passBack(upstream: Response): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of PASS_BACK) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

// ---- ElevenLabs ----

/** An error in ElevenLabs' shape ({detail: {status, message}}), which the page's client classifies. */
export function elevenError(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ detail: { status: code, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

export type ElevenCall = "speech-to-text" | "text-to-speech" | "text-to-dialogue" | "voices";

const OUTPUT_FORMAT = /^mp3_\d{4,5}_\d{2,3}$/;
const VOICE_ID = /^[A-Za-z0-9]{1,64}$/;

/**
 * Checks `path` (decoded from ?path=) against the four calls, after URL
 * normalization: a fixed upstream origin, exact paths, the right method and
 * only the query each call takes. Returns the upstream URL, or null.
 */
export function allowedCall(method: string, path: string | null): { call: ElevenCall; url: string } | null {
  if (!path || !path.startsWith("/") || path.startsWith("//") || /[\\\s]/.test(path)) return null;
  let url: URL;
  try {
    url = new URL(path, UPSTREAM);
  } catch {
    return null;
  }
  if (url.origin !== UPSTREAM || url.hash || url.username || url.password) return null;
  const query = [...url.searchParams.entries()];
  const noQuery = query.length === 0 && url.search === "";
  const formatOnly =
    query.length === 1 && query[0][0] === "output_format" && OUTPUT_FORMAT.test(query[0][1]) && url.search === `?output_format=${query[0][1]}`;
  const p = url.pathname;
  const tts = /^\/v1\/text-to-speech\/([^/]+)\/stream$/.exec(p);
  let call: ElevenCall | null = null;
  if (method === "POST" && p === "/v1/speech-to-text" && noQuery) call = "speech-to-text";
  else if (method === "POST" && tts && VOICE_ID.test(tts[1]) && formatOnly) call = "text-to-speech";
  else if (method === "POST" && p === "/v1/text-to-dialogue/stream" && formatOnly) call = "text-to-dialogue";
  else if (method === "GET" && p === "/v1/voices" && noQuery) call = "voices";
  return call ? { call, url: UPSTREAM + p + url.search } : null;
}

/** Characters of speech in a text-to-speech or text-to-dialogue body, the context it carries included. */
export function speechSize(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  const b = body as Record<string, unknown>;
  const len = (v: unknown) => (typeof v === "string" ? v.length : 0);
  let n = len(b.text) + len(b.previous_text) + len(b.next_text);
  if (Array.isArray(b.inputs)) for (const i of b.inputs) n += typeof i === "object" && i !== null ? len((i as Record<string, unknown>).text) : 0;
  if (typeof b.settings === "object" && b.settings !== null) {
    const s = b.settings as Record<string, unknown>;
    n += len(s.previous_text) + len(s.next_text);
  }
  return n;
}

export function createElevenProxy(deps: Partial<ProxyDeps> = {}) {
  const env = deps.env ?? ((globalThis as { process?: { env?: Env } }).process?.env ?? {});
  const doFetch: FetchFn = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const limited = createLimiter(ELEVEN_LIMITS.perIp, ELEVEN_LIMITS.windowMs);

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "GET" && req.method !== "POST") return elevenError(405, "method_not_allowed", "Use GET or POST.", { allow: "GET, POST" });
    if (!sameOrigin(req)) return elevenError(403, "forbidden", "This demo server only answers the Orbit page it is hosted with.");
    const target = allowedCall(req.method, new URL(req.url).searchParams.get("path"));
    if (!target) return elevenError(404, "not_allowed", "The demo server doesn't make that ElevenLabs call.");
    const key = env.ELEVENLABS_API_KEY?.trim();
    if (!key) return elevenError(503, "demo_not_configured", "The demo server has no ElevenLabs key set up yet.");
    const wait = limited(clientIp(req), now());
    if (wait) return elevenError(429, "too_many_requests", `The demo server is busy with you. Try again in ${wait} s.`, { "retry-after": String(wait) });

    const headers = new Headers({ "xi-api-key": key });
    const accept = req.headers.get("accept");
    if (accept) headers.set("accept", accept);
    let body: Uint8Array | undefined;
    if (req.method === "POST") {
      const raw = await readCapped(req, ELEVEN_LIMITS.maxBody);
      if (!raw) return elevenError(413, "too_large", "That is more than the demo server takes (4 MB).");
      const type = req.headers.get("content-type");
      if (type) headers.set("content-type", type);
      if (target.call === "text-to-speech" || target.call === "text-to-dialogue") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return elevenError(400, "invalid_json", "The request body isn't JSON.");
        }
        if (speechSize(parsed) > ELEVEN_LIMITS.maxSpeech) {
          return elevenError(413, "too_long", `The demo server speaks at most ${ELEVEN_LIMITS.maxSpeech} characters at a time.`);
        }
      }
      body = raw;
    }

    let upstream: Response;
    try {
      upstream = await doFetch(target.url, {
        method: req.method,
        headers,
        ...(body ? { body: body as unknown as BodyInit } : {}),
        signal: req.signal,
      });
    } catch {
      if (req.signal.aborted) return new Response(null, { status: 499 });
      return elevenError(502, "unreachable", "The demo server couldn't reach ElevenLabs.");
    }
    // The host's key was refused: say so plainly rather than ask the visitor for a new key.
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => {});
      return elevenError(502, "demo_key_rejected", "The demo server's ElevenLabs key was refused. Its owner needs to check it.");
    }
    return passBack(upstream);
  };
}

const handle = createElevenProxy();

export default {
  fetch(request: Request): Promise<Response> {
    return handle(request);
  },
};
