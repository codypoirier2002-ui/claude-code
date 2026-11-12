// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  ELEVEN_BASE,
  ElevenError,
  LAURA_VOICE_ID,
  classifyElevenError,
  cleanElevenKey,
  createElevenClient,
  elevenMessage,
  permissionLabel,
  speechFileName,
} from "../src/core/eleven";

describe("classifyElevenError", () => {
  it("missing_permission, with the permission name from the message", () => {
    const body = {
      detail: {
        status: "missing_permissions",
        message: "The API key you used is missing the permission speech_to_text to execute this operation.",
      },
    };
    const info = classifyElevenError(401, body);
    expect(info.kind).toBe("missing_permission");
    expect(info.permission).toBe("speech_to_text");
    expect(classifyElevenError(403, { detail: "Key is missing the permission voices_read" }).permission).toBe("voices_read");
  });

  it("quota, before the 401 rule (an empty balance is not a bad key)", () => {
    expect(classifyElevenError(401, { detail: { status: "quota_exceeded", message: "You have 0 credits remaining" } }).kind).toBe("quota");
    expect(classifyElevenError(400, { detail: "This request exceeds your character limit" }).kind).toBe("quota");
  });

  it("voice_unavailable: 402, paid-plan wording and voice not found", () => {
    expect(classifyElevenError(402, {}).kind).toBe("voice_unavailable");
    expect(classifyElevenError(400, { detail: { status: "payment_required", message: "x" } }).kind).toBe("voice_unavailable");
    expect(classifyElevenError(403, { detail: { message: "Free users cannot use library voices via the API. Please upgrade your subscription." } }).kind).toBe("voice_unavailable");
    expect(classifyElevenError(404, { detail: { status: "voice_not_found", message: "A voice with that ID was not found." } }).kind).toBe("voice_unavailable");
    expect(classifyElevenError(400, { detail: "Voice abc does not exist." }).kind).toBe("voice_unavailable");
  });

  it("invalid_key on 401 or invalid-key wording", () => {
    expect(classifyElevenError(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }).kind).toBe("invalid_key");
    expect(classifyElevenError(401, "Unauthorized").kind).toBe("invalid_key");
    expect(classifyElevenError(400, { detail: "invalid api key supplied" }).kind).toBe("invalid_key");
  });

  it("the 401 nuance: restricted keys and empty balances are not bad keys", () => {
    expect(classifyElevenError(401, { detail: { status: "missing_permissions", message: "missing the permission text_to_speech" } }).kind).toBe("missing_permission");
    expect(classifyElevenError(401, { detail: { status: "quota_exceeded", message: "quota" } }).kind).toBe("quota");
  });

  it("rate_limit on 429 and other for the rest", () => {
    expect(classifyElevenError(429, { detail: { status: "too_many_concurrent_requests", message: "Busy" } }).kind).toBe("rate_limit");
    const other = classifyElevenError(500, { detail: { message: "Boom" } });
    expect(other).toEqual({ kind: "other", detail: "Boom" });
    expect(classifyElevenError(422, { detail: [{ msg: "field required" }] })).toEqual({ kind: "other", detail: "field required" });
    expect(classifyElevenError(503, "upstream down").detail).toBe("upstream down");
  });

  it("keeps ElevenLabs' own error status (detail.status) as detailStatus, apart from the body's code", () => {
    // As eleven_v4 refused a lone "[giggles]" on 2026-11-11.
    const message = "Input at position 0 has empty text. All inputs must include non-empty text after removing speaker tags and emojis.";
    const body = { detail: { type: "validation_error", code: "invalid_parameters", message, status: "input_text_empty", param: "text" } };
    expect(classifyElevenError(400, body)).toEqual({ kind: "other", detail: message, detailStatus: "input_text_empty" });
    const err = ElevenError.from(400, { detail: { status: "model_not_found", message: "A model with model ID x does not exist ..." } }, "speech");
    expect([err.kind, err.detailStatus, err.detail]).toEqual(["other", "model_not_found", "A model with model ID x does not exist ..."]);
    expect(ElevenError.from(500, { detail: { message: "Boom" } }, "speech").detailStatus).toBeUndefined();
  });
});

describe("elevenMessage", () => {
  it("produces the six messages", () => {
    expect(elevenMessage("invalid_key", "speech")).toBe(
      "ElevenLabs says this key isn't valid. Copy it again from elevenlabs.io → Developers → API keys (it starts with sk_) and paste only the key.",
    );
    expect(elevenMessage("missing_permission", "transcription", 401, "", "speech_to_text")).toBe(
      "Your ElevenLabs key isn't allowed to use Speech to Text. On elevenlabs.io → Developers → API keys, edit the key and set Text to Speech, Speech to Text and Voices to “Access” (or turn off “Restrict key”).",
    );
    expect(elevenMessage("quota", "speech")).toBe("Your ElevenLabs credits have run out for this month. They refill on your plan's renewal date.");
    expect(elevenMessage("voice_unavailable", "speech")).toBe(
      "That voice needs a paid ElevenLabs plan (free plans can only use the built-in voices from apps).",
    );
    expect(elevenMessage("rate_limit", "voices")).toBe("ElevenLabs is busy right now. Try again in a moment.");
    expect(elevenMessage("other", "transcription", 500, "Boom")).toBe("Transcription failed (500): Boom");
    expect(elevenMessage("other", "voices", 418, "teapot")).toBe("Loading voices failed (418): teapot");
    expect(elevenMessage("other", "speech", 502, "bad gateway")).toBe("Speech failed (502): bad gateway");
  });

  it("names the feature from the permission", () => {
    expect(permissionLabel("voices_read")).toBe("Voices");
    expect(permissionLabel("text_to_speech")).toBe("Text to Speech");
    expect(permissionLabel("speech_to_text")).toBe("Speech to Text");
    expect(permissionLabel("dubbing_write")).toBe("this feature");
    expect(permissionLabel(undefined)).toBe("this feature");
  });

  it("ElevenError carries status, kind and detail, with the message", () => {
    const err = ElevenError.from(429, { detail: { message: "slow down" } }, "speech");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(429);
    expect(err.kind).toBe("rate_limit");
    expect(err.detail).toBe("slow down");
    expect(err.message).toBe("ElevenLabs is busy right now. Try again in a moment.");
  });
});

describe("cleanElevenKey", () => {
  it("strips labels, quotes, backticks and whitespace", () => {
    expect(cleanElevenKey("  sk_abc123  ")).toBe("sk_abc123");
    expect(cleanElevenKey("xi-api-key: sk_abc123")).toBe("sk_abc123");
    expect(cleanElevenKey("XI-API-KEY:sk_abc")).toBe("sk_abc");
    expect(cleanElevenKey('api key = "sk_abc"')).toBe("sk_abc");
    expect(cleanElevenKey("`sk_a b\nc`")).toBe("sk_abc");
    expect(cleanElevenKey("“sk_abc”")).toBe("sk_abc");
    expect(cleanElevenKey("")).toBe("");
  });
});

describe("the client", () => {
  interface Call {
    url: string;
    init: RequestInit;
  }
  function fakeFetch(respond: (url: string) => Response) {
    const calls: Call[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return respond(url);
    };
    return { calls, fetch };
  }
  const audio = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

  it("transcribe posts the file and scribe_v2 with the cleaned key", async () => {
    const { calls, fetch } = fakeFetch(() => Response.json({ text: "  hello there \n" }));
    const client = createElevenClient({ getKey: () => " xi-api-key: sk_k ", fetch });
    const text = await client.transcribe(new Blob(["x"], { type: "audio/mp4" }));
    expect(text).toBe("hello there");
    expect(calls[0].url).toBe(`${ELEVEN_BASE}/v1/speech-to-text`);
    expect(new Headers(calls[0].init.headers).get("xi-api-key")).toBe("sk_k");
    const form = calls[0].init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect((form.get("file") as File).name).toBe("speech.m4a");
  });

  it("names the upload by blob type", () => {
    expect(speechFileName("audio/webm;codecs=opus")).toBe("speech.webm");
    expect(speechFileName("audio/ogg;codecs=opus")).toBe("speech.ogg");
    expect(speechFileName("audio/mp4")).toBe("speech.m4a");
    expect(speechFileName("")).toBe("speech.webm");
  });

  it("fast speech strips tags and sends the speed", async () => {
    const { calls, fetch } = fakeFetch(audio);
    const client = createElevenClient({ getKey: () => "k", fetch });
    const buf = await client.synthesizeFast("[giggles] Hi there.", "v1", 1.1);
    expect(buf.byteLength).toBe(3);
    expect(calls[0].url).toBe(`${ELEVEN_BASE}/v1/text-to-speech/v1/stream?output_format=mp3_44100_128`);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      text: "Hi there.",
      model_id: "eleven_flash_v2_5",
      voice_settings: { speed: 1.1 },
    });
  });

  it("expressive speech keeps tags, sends previous_text at the top level only when there is one, and no speed", async () => {
    const { calls, fetch } = fakeFetch(audio);
    const client = createElevenClient({ getKey: () => "k", fetch });
    await client.synthesizeExpressive("[giggles] Hi.", LAURA_VOICE_ID, "Before.");
    await client.synthesizeExpressive("Next.", "v2");
    expect(calls[0].url).toBe(`${ELEVEN_BASE}/v1/text-to-dialogue/stream?output_format=mp3_44100_128`);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      inputs: [{ text: "[giggles] Hi.", voice_id: LAURA_VOICE_ID }],
      model_id: "eleven_v4",
      previous_text: "Before.",
    });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ inputs: [{ text: "Next.", voice_id: "v2" }], model_id: "eleven_v4" });
  });

  /** ElevenLabs' 429 when the account's plan has too many requests running (5 on the demo's key, seen 2026-11-11). */
  const tooManyAtOnce = (init: ResponseInit = {}) =>
    Response.json(
      {
        detail: {
          type: "rate_limit_error",
          code: "concurrent_limit_exceeded",
          message: "Too many concurrent requests. Your current subscription is associated with a maximum of 5 concurrent requests (running in parallel).",
          status: "too_many_concurrent_requests",
        },
      },
      { status: 429, ...init },
    );

  it("retries ElevenLabs' too-many-at-once 429 after a wait, honouring retry-after", async () => {
    let n = 0;
    const { calls, fetch } = fakeFetch(() => (++n === 1 ? tooManyAtOnce() : n === 2 ? tooManyAtOnce({ headers: { "retry-after": "2" } }) : audio()));
    const waits: number[] = [];
    const client = createElevenClient({ getKey: () => "k", fetch, wait: async (ms) => void waits.push(ms) });
    const buf = await client.synthesizeExpressive("Hi.", "v");
    expect(buf.byteLength).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls[2].init.body).toBe(calls[0].init.body);
    expect(waits).toEqual([400, 2000]);
  });

  it("gives up after three retries, and never retries the demo server's own per-visitor limit", async () => {
    const waits: number[] = [];
    const busy = fakeFetch(() => tooManyAtOnce());
    const client = createElevenClient({ getKey: () => "k", fetch: busy.fetch, wait: async (ms) => void waits.push(ms) });
    await expect(client.synthesizeFast("Hi.", "v", 1)).rejects.toMatchObject({ kind: "rate_limit", status: 429 });
    expect(busy.calls).toHaveLength(4);
    expect(waits).toEqual([400, 900, 1800]);

    const yours = fakeFetch(() =>
      Response.json(
        { detail: { status: "too_many_requests", message: "The demo server is busy with you. Try again in 120 s." } },
        { status: 429, headers: { "retry-after": "120" } },
      ),
    );
    const demo = createElevenClient({ getKey: () => "", fetch: yours.fetch, demo: true, wait: () => Promise.reject(new Error("no wait expected")) });
    await expect(demo.synthesizeFast("Hi.", "v", 1)).rejects.toMatchObject({ kind: "rate_limit" });
    expect(yours.calls).toHaveLength(1);
  });

  it("stops waiting to retry when the request is aborted", async () => {
    const { calls, fetch } = fakeFetch(() => tooManyAtOnce());
    const client = createElevenClient({ getKey: () => "k", fetch });
    const controller = new AbortController();
    const speech = client.synthesizeFast("Hi.", "v", 1, controller.signal);
    await new Promise((r) => setTimeout(r, 0)); // the 429 is in, and the wait has started
    controller.abort();
    await expect(speech).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });

  it("listVoices maps to {id, name}", async () => {
    const { calls, fetch } = fakeFetch(() =>
      Response.json({ voices: [{ voice_id: "a", name: "Ann", extra: 1 }, { voice_id: "b", name: "Bo" }, { name: "no id" }] }),
    );
    const client = createElevenClient({ getKey: () => "k", fetch });
    expect(await client.listVoices()).toEqual([{ id: "a", name: "Ann" }, { id: "b", name: "Bo" }]);
    expect(calls[0].init.method).toBe("GET");
  });

  it("throws a classified ElevenError on failure", async () => {
    const { fetch } = fakeFetch(() => Response.json({ detail: { status: "invalid_api_key", message: "bad" } }, { status: 401 }));
    const client = createElevenClient({ getKey: () => "k", fetch });
    const err = await client.listVoices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElevenError);
    expect((err as ElevenError).kind).toBe("invalid_key");
    expect((err as ElevenError).feature).toBe("voices");

    const plain = createElevenClient({ getKey: () => "k", fetch: fakeFetch(() => new Response("oops", { status: 500 })).fetch });
    const e2 = (await plain.transcribe(new Blob(["x"])).catch((e: unknown) => e)) as ElevenError;
    expect(e2.message).toBe("Transcription failed (500): oops");
  });
});
