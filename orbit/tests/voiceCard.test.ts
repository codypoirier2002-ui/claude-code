import { describe, expect, it } from "vitest";
import { ElevenError, type Voice } from "../src/core/eleven";
import { CARD_TEXT, checkVoiceKey, voiceCardVisible, voiceReadyToast } from "../src/ui/voiceCard";

/** A fake client whose listVoices resolves or throws; records the key it was built with. */
function fakeClient(outcome: () => Promise<Voice[]>) {
  const keys: string[] = [];
  return {
    keys,
    make: (key: string) => {
      keys.push(key);
      return { listVoices: () => outcome() };
    },
  };
}

const elevenError = (status: number, body: unknown) => ElevenError.from(status, body, "voices");

describe("checkVoiceKey (§6.8)", () => {
  it("cleans the key and saves it with the success toast", async () => {
    const c = fakeClient(async () => [{ id: "v1", name: "Laura" }]);
    const r = await checkVoiceKey('  xi-api-key: "sk_abc123"  ', "Callie", c.make);
    expect(c.keys).toEqual(["sk_abc123"]);
    expect(r).toEqual({ kind: "save", key: "sk_abc123", note: null, toast: "Callie has a voice now. Tap Talk to chat out loud." });
  });

  it("saves anyway with the heads-up note when the key can't list voices", async () => {
    const c = fakeClient(() =>
      Promise.reject(elevenError(401, { detail: { status: "missing_permissions", message: "The API key you used is missing the permission voices_read to execute this operation." } })),
    );
    const r = await checkVoiceKey("sk_x", "Callie", c.make);
    expect(r.kind).toBe("save");
    if (r.kind !== "save") return;
    expect(r.note).toBe("(Heads-up: the key can't list voices, but speaking can still work.)");
    expect(r.toast).toBe(`${voiceReadyToast("Callie")} ${CARD_TEXT.noteMissingPermission}`);
  });

  it("saves anyway with the error as the note for any other ElevenLabs error", async () => {
    const err = elevenError(429, { detail: "Too many requests" });
    const c = fakeClient(() => Promise.reject(err));
    const r = await checkVoiceKey("sk_x", "Nova", c.make);
    expect(r).toMatchObject({ kind: "save", key: "sk_x", note: err.message });
    expect(err.message).toBe("ElevenLabs is busy right now. Try again in a moment.");
    if (r.kind === "save") expect(r.toast).toBe(`Nova has a voice now. Tap Talk to chat out loud. ${err.message}`);
  });

  it("saves as is when ElevenLabs can't be reached", async () => {
    const c = fakeClient(() => Promise.reject(new TypeError("Failed to fetch")));
    const r = await checkVoiceKey("sk_x", "Callie", c.make);
    expect(r).toMatchObject({ kind: "save", key: "sk_x", note: "(Couldn't reach ElevenLabs to check it, so it's saved as is.)" });
  });

  it("keeps the form with the error for an invalid key", async () => {
    const err = elevenError(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } });
    const c = fakeClient(() => Promise.reject(err));
    const r = await checkVoiceKey("sk_bad", "Callie", c.make);
    expect(r).toEqual({ kind: "invalid", message: err.message });
    expect(err.kind).toBe("invalid_key");
  });

  it("does nothing for an empty key", async () => {
    const c = fakeClient(async () => []);
    expect(await checkVoiceKey(' " ` ', "Callie", c.make)).toEqual({ kind: "empty" });
    expect(c.keys).toEqual([]);
  });
});

describe("voiceCardVisible", () => {
  it("shows without a key until dismissed", () => {
    expect(voiceCardVisible({ elevenLabsKey: "", voiceCardDismissed: false })).toBe(true);
    expect(voiceCardVisible({ elevenLabsKey: "", voiceCardDismissed: true })).toBe(false);
    expect(voiceCardVisible({ elevenLabsKey: "sk_x", voiceCardDismissed: false })).toBe(false);
  });
});
