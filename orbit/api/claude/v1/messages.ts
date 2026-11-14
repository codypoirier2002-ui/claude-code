// The demo server's Claude proxy (§21): POST /api/claude/v1/messages[?beta=…].
// A Vercel Function (Node.js runtime, Web-standard handler). Demo builds of
// Orbit (VITE_ORBIT_DEMO=1) send Claude calls here when the visitor has no key
// of their own; this adds the host's key (ANTHROPIC_API_KEY, set in the Vercel
// dashboard and capped in the Claude Console) and streams the answer back.
//
// Guards, all best-effort speed bumps (curl can fake headers; the Console
// workspace's spend limit is the real cap):
// - same origin only: Sec-Fetch-Site: same-origin, else an Origin whose host is this host;
// - a per-IP request limit, kept in this instance's memory;
// - a 4 MB body and a cap on the text it carries;
// - models: Haiku and Opus; Fable requests run on Opus;
// - max_tokens at most 16,000, web search at most 3 uses, no fast mode,
//   no fallback list other than "default" (Opus's fallbacks are older Opus models).
// Errors come back in the Anthropic error shape, so the SDK in the page reads them.
//
// Self-contained on purpose: Vercel bundles each file under api/ on its own.

const UPSTREAM = "https://api.anthropic.com/v1/messages";
const DEFAULT_VERSION = "2023-06-01";

export const CLAUDE_LIMITS = Object.freeze({
  /** Request body, in bytes. */
  maxBody: 4 * 1024 * 1024,
  /** Characters of text across system, messages and tools (base64 image data not counted). */
  maxText: 400_000,
  maxTokens: 16_000,
  webSearchMaxUses: 3,
  /** Per IP, per instance: requests in the window. One voice turn is 2–5 calls. */
  perIp: 90,
  windowMs: 10 * 60 * 1000,
});

/** The models the demo server runs. */
export const ALLOWED_MODELS: readonly string[] = ["claude-haiku-5-5", "claude-opus-5-5"];
/** Fable (any version) runs on this instead. */
export const TOP_MODEL = "claude-opus-5-5";

type Env = Record<string, string | undefined>;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProxyDeps {
  env: Env;
  fetch: FetchFn;
  now: () => number;
}

// ---- Shared guards (duplicated in api/eleven.ts: no local imports) ----

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

// ---- Claude ----

export type ClaudeErrorType =
  | "invalid_request_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error";

/** An error in the Anthropic shape. x-should-retry: false keeps the SDK from retrying the proxy's own refusals. */
export function claudeError(status: number, type: ClaudeErrorType, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-should-retry": "false", ...extra },
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The model the demo server runs for a requested one, or null when it doesn't run it. */
export function capModel(model: unknown): string | null {
  if (typeof model !== "string") return null;
  if (model.startsWith("claude-fable")) return TOP_MODEL;
  return ALLOWED_MODELS.includes(model) ? model : null;
}

/** Characters of text in a request, skipping base64 payloads (`data`), which images and PDFs carry. */
export function textSize(v: unknown, key = ""): number {
  if (typeof v === "string") return key === "data" ? 0 : v.length;
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + textSize(x), 0);
  if (isRecord(v)) return Object.entries(v).reduce<number>((n, [k, x]) => n + textSize(x, k), 0);
  return 0;
}

/**
 * Applies the demo server's caps to a request body. Returns the body to send,
 * or an error message for a model it doesn't run.
 */
export function capRequest(body: Record<string, unknown>): { body: Record<string, unknown> } | { error: string } {
  const model = capModel(body.model);
  if (!model) return { error: "The demo server runs Claude Haiku 5.5 and Claude Opus 5.5 only." };
  const out: Record<string, unknown> = { ...body, model };
  const asked = typeof body.max_tokens === "number" && body.max_tokens > 0 ? Math.floor(body.max_tokens) : CLAUDE_LIMITS.maxTokens;
  out.max_tokens = Math.min(asked, CLAUDE_LIMITS.maxTokens);
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t) => {
      if (!isRecord(t) || typeof t.type !== "string" || !t.type.startsWith("web_search")) return t;
      const uses = typeof t.max_uses === "number" && t.max_uses > 0 ? Math.floor(t.max_uses) : CLAUDE_LIMITS.webSearchMaxUses;
      return { ...t, max_uses: Math.min(uses, CLAUDE_LIMITS.webSearchMaxUses) };
    });
  }
  delete out.speed;
  if ("fallbacks" in out && out.fallbacks !== "default") delete out.fallbacks;
  return { body: out };
}

export function createClaudeProxy(deps: Partial<ProxyDeps> = {}) {
  const env = deps.env ?? ((globalThis as { process?: { env?: Env } }).process?.env ?? {});
  const doFetch: FetchFn = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const limited = createLimiter(CLAUDE_LIMITS.perIp, CLAUDE_LIMITS.windowMs);

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return claudeError(405, "invalid_request_error", "Use POST.", { allow: "POST" });
    if (!sameOrigin(req)) return claudeError(403, "permission_error", "This demo server only answers the Orbit page it is hosted with.");
    const key = env.ANTHROPIC_API_KEY?.trim();
    if (!key) return claudeError(503, "api_error", "The demo server has no Claude key set up yet.");
    const wait = limited(clientIp(req), now());
    if (wait) {
      return claudeError(429, "rate_limit_error", `The demo server is busy with you. Try again in ${wait} s, or add your own key in Settings.`, {
        "retry-after": String(wait),
      });
    }

    const raw = await readCapped(req, CLAUDE_LIMITS.maxBody);
    if (!raw) return claudeError(413, "request_too_large", "That request is larger than the demo server takes (4 MB).");
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return claudeError(400, "invalid_request_error", "The request body isn't JSON.");
    }
    if (!isRecord(parsed)) return claudeError(400, "invalid_request_error", "The request body isn't a JSON object.");
    if (textSize(parsed) > CLAUDE_LIMITS.maxText) {
      return claudeError(413, "request_too_large", "This conversation is longer than the demo server takes. Start a new chat, or add your own key in Settings.");
    }
    const capped = capRequest(parsed);
    if ("error" in capped) return claudeError(400, "invalid_request_error", capped.error);

    const headers = new Headers({
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": req.headers.get("anthropic-version") || DEFAULT_VERSION,
    });
    const beta = req.headers.get("anthropic-beta");
    if (beta) headers.set("anthropic-beta", beta);
    const betaQuery = new URL(req.url).searchParams.get("beta");
    const url = betaQuery === null ? UPSTREAM : `${UPSTREAM}?beta=${encodeURIComponent(betaQuery)}`;

    let upstream: Response;
    try {
      upstream = await doFetch(url, { method: "POST", headers, body: JSON.stringify(capped.body), signal: req.signal });
    } catch {
      if (req.signal.aborted) return new Response(null, { status: 499 });
      return claudeError(502, "api_error", "The demo server couldn't reach the Claude API.", { "x-should-retry": "true" });
    }
    return passBack(upstream);
  };
}

const handle = createClaudeProxy();

export default {
  fetch(request: Request): Promise<Response> {
    return handle(request);
  },
};
