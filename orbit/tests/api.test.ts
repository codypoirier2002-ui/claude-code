import { describe, expect, it, vi } from "vitest";
import claudeDefault, {
  CLAUDE_LIMITS,
  TOP_MODEL,
  capModel,
  capRequest,
  createClaudeProxy,
  createLimiter,
  clientIp,
  sameOrigin,
  textSize,
} from "../api/claude/v1/messages";
import elevenDefault, { ELEVEN_LIMITS, allowedCall, createElevenProxy, speechSize } from "../api/eleven";
import { classifyElevenError } from "../src/core/eleven";

const HOST = "orbit-demo.example";
const SITE = `https://${HOST}`;
const CLAUDE_URL = `${SITE}/api/claude/v1/messages?beta=true`;
const elevenUrl = (path: string) => `${SITE}/api/eleven?path=${encodeURIComponent(path)}`;
const TTS = "/v1/text-to-speech/7YaUDeaStRuoYg3FKsmU/stream?output_format=mp3_44100_128";
const DIALOGUE = "/v1/text-to-dialogue/stream?output_format=mp3_44100_128";

const sameSite = { "sec-fetch-site": "same-origin", host: HOST, "x-vercel-forwarded-for": "203.0.113.7" };

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...sameSite, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A stubbed upstream that records each call. */
function upstream(make: () => Response = () => new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return make();
  });
  return { fetch, calls };
}

const chatBody = (patch: Record<string, unknown> = {}) => ({
  model: "claude-haiku-5-5",
  max_tokens: 32000,
  system: "You are Callie.",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, { name: "set_timer", input_schema: { type: "object" } }],
  fallbacks: "default",
  ...patch,
});

async function errorOf(res: Response) {
  return (await res.json()) as { type: string; error: { type: string; message: string } };
}

describe("shared guards", () => {
  it("accepts same-origin requests by Sec-Fetch-Site, or by Origin when that header is missing", () => {
    expect(sameOrigin(new Request(`${SITE}/x`, { headers: { "sec-fetch-site": "same-origin" } }))).toBe(true);
    // A same-origin GET carries no Origin: Sec-Fetch-Site alone must pass (the voices call).
    expect(sameOrigin(new Request(`${SITE}/x`, { headers: { "sec-fetch-site": "same-origin", host: HOST } }))).toBe(true);
    expect(sameOrigin(new Request(`${SITE}/x`, { headers: { origin: SITE, host: HOST } }))).toBe(true);
    expect(sameOrigin(new Request(`${SITE}/x`, { headers: { origin: SITE.toUpperCase(), host: HOST } }))).toBe(true);
  });

  it("refuses other sites, a missing Origin, and a cross-site browser even with a matching Origin", () => {
    expect(sameOrigin(new Request(`${SITE}/x`, { headers: { "sec-fetch-site": "cross-site", origin: SITE, host: HOST } }))).toBe(false);
    expect(sameOrigin(new Request(`${SITE}/x`, { headers: { "sec-fetch-site": "same-site" } }))).toBe(false);
    expect(sameOrigin(new Request(`${SITE}/x`, { headers: { "sec-fetch-site": "none" } }))).toBe(false);
    expect(sameOrigin(new Request(`${SITE}/x`, { headers: { origin: "https://evil.example", host: HOST } }))).toBe(false);
    expect(sameOrigin(new Request(`${SITE}/x`, { headers: { origin: "null", host: HOST } }))).toBe(false);
    expect(sameOrigin(new Request(`${SITE}/x`))).toBe(false);
  });

  it("reads the caller's IP the way Vercel reports it", () => {
    expect(clientIp(new Request(SITE, { headers: { "x-vercel-forwarded-for": "1.1.1.1", "x-forwarded-for": "2.2.2.2" } }))).toBe("1.1.1.1");
    expect(clientIp(new Request(SITE, { headers: { "x-real-ip": "3.3.3.3" } }))).toBe("3.3.3.3");
    expect(clientIp(new Request(SITE, { headers: { "x-forwarded-for": "4.4.4.4, 10.0.0.1" } }))).toBe("4.4.4.4");
    expect(clientIp(new Request(SITE))).toBe("unknown");
  });

  it("limits each IP within a sliding window and says how long to wait", () => {
    const limit = createLimiter(3, 60_000);
    expect([limit("a", 0), limit("a", 1000), limit("a", 2000)]).toEqual([0, 0, 0]);
    expect(limit("a", 3000)).toBe(57);
    expect(limit("b", 3000)).toBe(0);
    expect(limit("a", 60_001)).toBe(0);
  });

  it("forgets the least recently seen IPs past its size", () => {
    const limit = createLimiter(1, 60_000, 2);
    limit("a", 0);
    limit("b", 0);
    limit("c", 0);
    // "a" was dropped, so it is allowed again; "c" is still remembered.
    expect(limit("a", 1)).toBe(0);
    expect(limit("c", 1)).toBeGreaterThan(0);
  });
});

describe("the Claude proxy's caps", () => {
  it("runs Haiku and Opus, Fable on Opus, and nothing else", () => {
    expect(capModel("claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(capModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(capModel("claude-fable-5-1")).toBe(TOP_MODEL);
    expect(capModel("claude-fable-5-2")).toBe(TOP_MODEL);
    expect(capModel("claude-mythos-5-2")).toBeNull();
    expect(capModel("claude-opus-5")).toBeNull();
    expect(capModel(42)).toBeNull();
  });

  it("caps max_tokens and web search, and drops fast mode and fallback lists", () => {
    const out = capRequest(chatBody({ model: "claude-fable-5-1", speed: "fast" }));
    if ("error" in out) throw new Error(out.error);
    expect(out.body.model).toBe("claude-opus-5-5");
    expect(out.body.max_tokens).toBe(16000);
    expect(out.body.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      { name: "set_timer", input_schema: { type: "object" } },
    ]);
    expect(out.body).not.toHaveProperty("speed");
    expect(out.body.fallbacks).toBe("default");
    const listed = capRequest(chatBody({ fallbacks: [{ model: "claude-fable-5-2" }] }));
    if ("error" in listed) throw new Error(listed.error);
    expect(listed.body).not.toHaveProperty("fallbacks");
  });

  it("keeps smaller asks as they are", () => {
    const out = capRequest(chatBody({ max_tokens: 200, tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }] }));
    if ("error" in out) throw new Error(out.error);
    expect(out.body.max_tokens).toBe(200);
    expect(out.body.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 1 }]);
    const noUses = capRequest(chatBody({ tools: [{ type: "web_search_20250305", name: "web_search" }] }));
    if ("error" in noUses) throw new Error(noUses.error);
    expect(noUses.body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
  });

  it("counts text but not base64 image data", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "A".repeat(100_000) } };
    expect(textSize({ messages: [{ role: "user", content: [image, { type: "text", text: "what is this" }] }] })).toBe(
      "user".length + "image".length + "base64".length + "image/jpeg".length + "text".length + "what is this".length,
    );
  });
});

describe("the Claude proxy", () => {
  const env = { ANTHROPIC_API_KEY: " sk-ant-host " };

  it("forwards a same-origin call with the host key, the version, the betas and the beta query", async () => {
    const up = upstream();
    const handle = createClaudeProxy({ env, fetch: up.fetch });
    const res = await handle(
      post(CLAUDE_URL, chatBody(), {
        "x-api-key": "proxy-managed",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "thinking-binding-controls-2026-08-01,server-side-fallback-2026-07-01",
        cookie: "session=secret",
        authorization: "Bearer visitor",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: {}\n\n");
    const { url, init } = up.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    const h = new Headers(init.headers);
    expect(h.get("x-api-key")).toBe("sk-ant-host");
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    expect(h.get("anthropic-beta")).toBe("thinking-binding-controls-2026-08-01,server-side-fallback-2026-07-01");
    expect(h.has("cookie")).toBe(false);
    expect(h.has("authorization")).toBe(false);
    expect(init.signal).toBeDefined();
    const sent = JSON.parse(String(init.body));
    expect(sent.max_tokens).toBe(16000);
    expect(sent.tools[0].max_uses).toBe(3);
  });

  it("calls the plain endpoint when there's no beta query, with a default version", async () => {
    const up = upstream();
    const handle = createClaudeProxy({ env, fetch: up.fetch });
    await handle(post(`${SITE}/api/claude/v1/messages`, chatBody()));
    expect(up.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(up.calls[0].init.headers).get("anthropic-version")).toBe("2023-06-01");
  });

  it("passes the stream back without encoding or length headers", async () => {
    const up = upstream(
      () =>
        new Response("event: message_start\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": "999", "request-id": "req_1", "set-cookie": "a=b" },
        }),
    );
    const res = await createClaudeProxy({ env, fetch: up.fetch })(post(CLAUDE_URL, chatBody()));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("request-id")).toBe("req_1");
    expect(res.headers.has("content-encoding")).toBe(false);
    expect(res.headers.has("set-cookie")).toBe(false);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("passes upstream errors through as they are", async () => {
    const body = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    const up = upstream(() => new Response(body, { status: 529, headers: { "content-type": "application/json" } }));
    const res = await createClaudeProxy({ env, fetch: up.fetch })(post(CLAUDE_URL, chatBody()));
    expect(res.status).toBe(529);
    expect(await res.text()).toBe(body);
  });

  it("refuses other sites, other methods and unknown models in the Anthropic error shape, without calling upstream", async () => {
    const up = upstream();
    const handle = createClaudeProxy({ env, fetch: up.fetch });
    const cross = await handle(post(CLAUDE_URL, chatBody(), { "sec-fetch-site": "cross-site" }));
    expect(cross.status).toBe(403);
    expect(await errorOf(cross)).toEqual({ type: "error", error: { type: "permission_error", message: expect.any(String) } });
    expect(cross.headers.get("x-should-retry")).toBe("false");
    const get = await handle(new Request(CLAUDE_URL, { headers: sameSite }));
    expect(get.status).toBe(405);
    const mythos = await handle(post(CLAUDE_URL, chatBody({ model: "claude-mythos-5-2" })));
    expect(mythos.status).toBe(400);
    expect((await errorOf(mythos)).error.type).toBe("invalid_request_error");
    const junk = await handle(post(CLAUDE_URL, "{not json"));
    expect(junk.status).toBe(400);
    expect(up.fetch).not.toHaveBeenCalled();
  });

  it("says so when the host key is missing", async () => {
    const up = upstream();
    const res = await createClaudeProxy({ env: {}, fetch: up.fetch })(post(CLAUDE_URL, chatBody()));
    expect(res.status).toBe(503);
    expect((await errorOf(res)).error.type).toBe("api_error");
    expect(up.fetch).not.toHaveBeenCalled();
  });

  it("refuses a body over 4 MB, by its header or by what arrives", async () => {
    const up = upstream();
    const handle = createClaudeProxy({ env, fetch: up.fetch });
    const declared = await handle(post(CLAUDE_URL, chatBody(), { "content-length": String(CLAUDE_LIMITS.maxBody + 1) }));
    expect(declared.status).toBe(413);
    const big = chatBody({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "A".repeat(CLAUDE_LIMITS.maxBody) } }] }] });
    const actual = await handle(post(CLAUDE_URL, big));
    expect(actual.status).toBe(413);
    expect((await errorOf(actual)).error.type).toBe("request_too_large");
    expect(up.fetch).not.toHaveBeenCalled();
  });

  it("refuses a conversation with more text than it takes, but not a big image", async () => {
    const up = upstream();
    const handle = createClaudeProxy({ env, fetch: up.fetch });
    const long = chatBody({ messages: [{ role: "user", content: "x".repeat(CLAUDE_LIMITS.maxText + 1) }] });
    expect((await handle(post(CLAUDE_URL, long))).status).toBe(413);
    const photo = chatBody({
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "A".repeat(2_000_000) } }] }],
    });
    expect((await handle(post(CLAUDE_URL, photo))).status).toBe(200);
  });

  it("rate-limits one IP with a 429 the SDK won't retry, and lets another through", async () => {
    let t = 0;
    const up = upstream();
    const handle = createClaudeProxy({ env, fetch: up.fetch, now: () => t });
    for (let i = 0; i < CLAUDE_LIMITS.perIp; i++) expect((await handle(post(CLAUDE_URL, chatBody()))).status).toBe(200);
    const res = await handle(post(CLAUDE_URL, chatBody()));
    expect(res.status).toBe(429);
    expect((await errorOf(res)).error.type).toBe("rate_limit_error");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect((await handle(post(CLAUDE_URL, chatBody(), { "x-vercel-forwarded-for": "198.51.100.1" }))).status).toBe(200);
    t += CLAUDE_LIMITS.windowMs + 1;
    expect((await handle(post(CLAUDE_URL, chatBody()))).status).toBe(200);
  });

  it("answers a network failure with a retryable 502", async () => {
    const handle = createClaudeProxy({
      env,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const res = await handle(post(CLAUDE_URL, chatBody()));
    expect(res.status).toBe(502);
    expect(res.headers.get("x-should-retry")).toBe("true");
  });

  it("is a Web-standard Vercel handler", () => {
    expect(typeof claudeDefault.fetch).toBe("function");
    expect(typeof elevenDefault.fetch).toBe("function");
  });
});

describe("the ElevenLabs proxy's allowlist", () => {
  it("lets exactly the four calls Orbit makes through", () => {
    expect(allowedCall("POST", "/v1/speech-to-text")?.call).toBe("speech-to-text");
    expect(allowedCall("POST", TTS)).toEqual({ call: "text-to-speech", url: `https://api.elevenlabs.io${TTS}` });
    expect(allowedCall("POST", DIALOGUE)?.call).toBe("text-to-dialogue");
    expect(allowedCall("GET", "/v1/voices")).toEqual({ call: "voices", url: "https://api.elevenlabs.io/v1/voices" });
  });

  it("refuses the wrong method, other paths and other hosts", () => {
    for (const [method, path] of [
      ["GET", "/v1/speech-to-text"],
      ["POST", "/v1/voices"],
      ["GET", TTS],
      ["POST", "/v1/user"],
      ["GET", "/v1/user/subscription"],
      ["POST", "/v1/voices/add"],
      ["DELETE", "/v1/voices/abc"],
      ["POST", "/v1/text-to-speech/abc"],
      ["POST", "/v2/text-to-dialogue/stream?output_format=mp3_44100_128"],
      ["GET", "//evil.example/v1/voices"],
      ["GET", "https://evil.example/v1/voices"],
      ["GET", "http://api.elevenlabs.io/v1/voices"],
      ["GET", "v1/voices"],
      ["GET", "/v1/voices#x"],
      ["GET", "\\\\evil.example/v1/voices"],
      ["GET", ""],
      ["GET", null],
    ] as const) {
      expect(allowedCall(method, path), `${method} ${path}`).toBeNull();
    }
  });

  it("refuses traversal and encoded slashes", () => {
    expect(allowedCall("GET", "/v1/voices/../user")).toBeNull();
    expect(allowedCall("GET", "/v1/x/../../v1/user")).toBeNull();
    expect(allowedCall("POST", "/v1/text-to-speech/abc%2F..%2F..%2Fuser/stream?output_format=mp3_44100_128")).toBeNull();
    expect(allowedCall("POST", "/v1/text-to-speech/../voices/stream?output_format=mp3_44100_128")).toBeNull();
    expect(allowedCall("POST", "/v1/text-to-speech/a b/stream?output_format=mp3_44100_128")).toBeNull();
  });

  it("takes only the query each call needs", () => {
    expect(allowedCall("GET", "/v1/voices?show_legacy=true")).toBeNull();
    expect(allowedCall("POST", "/v1/speech-to-text?enable_logging=false")).toBeNull();
    expect(allowedCall("POST", "/v1/text-to-dialogue/stream")).toBeNull();
    expect(allowedCall("POST", "/v1/text-to-dialogue/stream?output_format=mp3_44100_128&enable_logging=false")).toBeNull();
    expect(allowedCall("POST", "/v1/text-to-dialogue/stream?output_format=mp3_44100_128&output_format=pcm_44100")).toBeNull();
    expect(allowedCall("POST", "/v1/text-to-dialogue/stream?output_format=pcm_44100")).toBeNull();
    expect(allowedCall("POST", "/v1/text-to-dialogue/stream?output_format=mp3%5F44100%5F128")).toBeNull();
  });

  it("counts the speech in both request shapes, context included", () => {
    expect(speechSize({ text: "hello", model_id: "m" })).toBe(5);
    expect(speechSize({ inputs: [{ text: "ab", voice_id: "v" }], previous_text: "xyz" })).toBe(5);
    expect(speechSize({ inputs: [{ text: "ab", voice_id: "v" }, { text: "cde" }], settings: { previous_text: "xyz" } })).toBe(8);
    expect(speechSize(null)).toBe(0);
  });
});

describe("the ElevenLabs proxy", () => {
  const env = { ELEVENLABS_API_KEY: "sk_host" };

  it("forwards speech with the host key and streams the audio back", async () => {
    const up = upstream(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg", "content-length": "3" } }));
    const handle = createElevenProxy({ env, fetch: up.fetch });
    const res = await handle(post(elevenUrl(TTS), { text: "Hello there.", model_id: "eleven_flash_v2_5" }, { accept: "audio/mpeg", "xi-api-key": "visitor" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.has("content-length")).toBe(false);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const { url, init } = up.calls[0];
    expect(url).toBe(`https://api.elevenlabs.io${TTS}`);
    const h = new Headers(init.headers);
    expect(h.get("xi-api-key")).toBe("sk_host");
    expect(h.get("accept")).toBe("audio/mpeg");
    expect(h.get("content-type")).toBe("application/json");
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(JSON.stringify({ text: "Hello there.", model_id: "eleven_flash_v2_5" }));
    expect(init.signal).toBeDefined();
  });

  it("lists voices on a same-origin GET with no Origin header", async () => {
    const up = upstream(() => new Response(JSON.stringify({ voices: [] }), { headers: { "content-type": "application/json" } }));
    const res = await createElevenProxy({ env, fetch: up.fetch })(new Request(elevenUrl("/v1/voices"), { headers: sameSite }));
    expect(res.status).toBe(200);
    expect(up.calls[0].init.method).toBe("GET");
    expect(up.calls[0].init.body).toBeUndefined();
  });

  it("passes a speech-to-text upload through as it came, boundary and all", async () => {
    const up = upstream(() => new Response(JSON.stringify({ text: "hi" }), { headers: { "content-type": "application/json" } }));
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(1000)], { type: "audio/webm" }), "speech.webm");
    form.append("model_id", "scribe_v2");
    const req = new Request(elevenUrl("/v1/speech-to-text"), { method: "POST", headers: sameSite, body: form });
    const type = req.headers.get("content-type");
    const res = await createElevenProxy({ env, fetch: up.fetch })(req);
    expect(res.status).toBe(200);
    expect(new Headers(up.calls[0].init.headers).get("content-type")).toBe(type);
    expect((up.calls[0].init.body as Uint8Array).byteLength).toBeGreaterThan(1000);
  });

  it("refuses speech over 1,200 characters, in a shape the page reads as a plain failure", async () => {
    const up = upstream();
    const handle = createElevenProxy({ env, fetch: up.fetch });
    const res = await handle(post(elevenUrl(DIALOGUE), { inputs: [{ text: "x".repeat(ELEVEN_LIMITS.maxSpeech + 1), voice_id: "v" }] }));
    expect(res.status).toBe(413);
    const body = await res.json();
    // Not quota, not a bad key, not a voice problem: the page treats it as one failed chunk.
    expect(classifyElevenError(res.status, body).kind).toBe("other");
    const ok = await handle(post(elevenUrl(DIALOGUE), { inputs: [{ text: "x".repeat(ELEVEN_LIMITS.maxSpeech), voice_id: "v" }] }));
    expect(ok.status).toBe(200);
    expect(up.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses other sites, disallowed calls and big bodies without calling upstream", async () => {
    const up = upstream();
    const handle = createElevenProxy({ env, fetch: up.fetch });
    expect((await handle(post(elevenUrl(TTS), { text: "hi" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await handle(post(elevenUrl("/v1/user"), {}))).status).toBe(404);
    expect((await handle(new Request(`${SITE}/api/eleven`, { headers: sameSite }))).status).toBe(404);
    expect((await handle(new Request(elevenUrl("/v1/voices"), { method: "PUT", headers: sameSite }))).status).toBe(405);
    const big = await handle(post(elevenUrl("/v1/speech-to-text"), "x", { "content-length": String(ELEVEN_LIMITS.maxBody + 1) }));
    expect(big.status).toBe(413);
    expect(up.fetch).not.toHaveBeenCalled();
  });

  it("passes ElevenLabs' own errors through, so quota and voice fallbacks still work", async () => {
    const quota = JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota." } });
    const up = upstream(() => new Response(quota, { status: 400, headers: { "content-type": "application/json" } }));
    const res = await createElevenProxy({ env, fetch: up.fetch })(post(elevenUrl(TTS), { text: "hi" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(quota);
  });

  it("turns a refused host key into a server error, not a request for the visitor's key", async () => {
    const up = upstream(() => new Response(JSON.stringify({ detail: { status: "invalid_api_key" } }), { status: 401 }));
    const res = await createElevenProxy({ env, fetch: up.fetch })(post(elevenUrl(TTS), { text: "hi" }));
    expect(res.status).toBe(502);
    expect(classifyElevenError(res.status, await res.json()).kind).toBe("other");
  });

  it("says so when the host key is missing, and rate-limits per IP", async () => {
    const up = upstream();
    expect((await createElevenProxy({ env: {}, fetch: up.fetch })(post(elevenUrl(TTS), { text: "hi" }))).status).toBe(503);
    const handle = createElevenProxy({ env, fetch: up.fetch, now: () => 0 });
    for (let i = 0; i < ELEVEN_LIMITS.perIp; i++) await handle(post(elevenUrl(TTS), { text: "hi" }));
    const res = await handle(post(elevenUrl(TTS), { text: "hi" }));
    expect(res.status).toBe(429);
    expect(classifyElevenError(res.status, await res.json()).kind).toBe("rate_limit");
  });
});
