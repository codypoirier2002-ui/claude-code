// The "Let {name} talk" card (§6.8): shown on the configured welcome while
// there is no ElevenLabs key and the card hasn't been dismissed. The card is
// built once and moved in and out of conversation.voiceCardSlot, so a re-render
// never wipes a half-typed key (§18).

import { ElevenError, cleanElevenKey, createElevenClient, type ElevenClient } from "../core/eleven";
import { assistantName, hasVoiceKey, type Settings } from "../core/settings";
import type { AppCtx } from "./context";
import { h } from "./dom";
import { FACE_SRC } from "./header";

export const ELEVEN_KEYS_URL = "https://elevenlabs.io/app/api/api-keys";

export const CARD_TEXT = Object.freeze({
  intro: "Talk hands-free and hear her answer out loud. It takes about two minutes, and the free ElevenLabs plan works.",
  placeholder: "Paste your ElevenLabs API key",
  submit: "Give her a voice",
  dismiss: "Not now",
  checking: "Checking the key…",
  noteMissingPermission: "(Heads-up: the key can't list voices, but speaking can still work.)",
  noteNetwork: "(Couldn't reach ElevenLabs to check it, so it's saved as is.)",
});

export const cardTitle = (name: string) => `Let ${name} talk`;
export const voiceReadyToast = (name: string) => `${name} has a voice now. Tap Talk to chat out loud.`;

/** What submitting the card leads to. */
export type KeyCheckResult =
  | { kind: "empty" }
  /** Save `key`; toast `toast` (the success line, plus a note when the check couldn't confirm it). */
  | { kind: "save"; key: string; toast: string; note: string | null }
  /** Keep the form and show `message`. */
  | { kind: "invalid"; message: string };

/**
 * The submit decision (§6.8): clean the key, list voices, and classify. Only an
 * invalid key keeps the form; every other outcome saves the key, with a note
 * when the check failed for another reason.
 */
export async function checkVoiceKey(
  raw: string,
  name: string,
  makeClient: (key: string) => Pick<ElevenClient, "listVoices">,
  signal?: AbortSignal,
): Promise<KeyCheckResult> {
  const key = cleanElevenKey(raw);
  if (!key) return { kind: "empty" };
  const saved = (note: string | null): KeyCheckResult => ({
    kind: "save",
    key,
    note,
    toast: note ? `${voiceReadyToast(name)} ${note}` : voiceReadyToast(name),
  });
  try {
    await makeClient(key).listVoices(signal);
    return saved(null);
  } catch (err) {
    if (err instanceof ElevenError) {
      if (err.kind === "invalid_key") return { kind: "invalid", message: err.message };
      if (err.kind === "missing_permission") return saved(CARD_TEXT.noteMissingPermission);
      return saved(err.message);
    }
    // fetch rejects (a TypeError) when ElevenLabs can't be reached.
    return saved(CARD_TEXT.noteNetwork);
  }
}

/** Shown while there is no key and the card hasn't been dismissed. */
export function voiceCardVisible(s: Pick<Settings, "elevenLabsKey" | "voiceCardDismissed">): boolean {
  return !hasVoiceKey(s) && !s.voiceCardDismissed;
}

export interface VoiceCardDeps {
  ctx: AppCtx;
  /** conversation.voiceCardSlot: the persistent container in the configured welcome. */
  slot: HTMLElement;
  /** Defaults to an ElevenLabs client for the typed key. */
  makeClient?: (key: string) => Pick<ElevenClient, "listVoices">;
}

export function createVoiceCard(deps: VoiceCardDeps) {
  const { ctx, slot } = deps;
  const makeClient = deps.makeClient ?? ((key: string) => createElevenClient({ getKey: () => key }));
  let busy = false;

  const title = h("h2", { class: "voice-card-title" });
  const input = h("input", {
    type: "password",
    class: "voice-card-input",
    name: "voiceCardKey",
    placeholder: CARD_TEXT.placeholder,
    "aria-label": CARD_TEXT.placeholder,
    autocomplete: "off",
    spellcheck: "false",
    autocapitalize: "off",
  });
  const submitBtn = h("button", { type: "submit", class: "btn primary" }, CARD_TEXT.submit);
  const dismissBtn = h(
    "button",
    { type: "button", class: "btn ghost", onClick: () => ctx.updateSettings({ voiceCardDismissed: true }) },
    CARD_TEXT.dismiss,
  );
  const message = h("p", { class: "voice-card-msg", "aria-live": "polite", hidden: true });

  const form = h(
    "form",
    {
      class: "voice-card-form",
      onSubmit: (e: Event) => {
        e.preventDefault();
        void submit();
      },
    },
    input,
    h("div", { class: "voice-card-buttons" }, submitBtn, dismissBtn),
    message,
  );

  const el = h(
    "section",
    { class: "voice-card", "aria-labelledby": "voice-card-title" },
    h(
      "div",
      { class: "voice-card-head" },
      h("img", { class: "voice-card-face", src: FACE_SRC, alt: "", width: "56", height: "56", decoding: "async" }),
      h("div", null, title, h("p", { class: "voice-card-intro" }, CARD_TEXT.intro)),
    ),
    h(
      "ol",
      { class: "voice-card-steps" },
      h(
        "li",
        null,
        "Open ",
        h("a", { href: ELEVEN_KEYS_URL, target: "_blank", rel: "noopener noreferrer" }, "elevenlabs.io → Developers → API keys"),
        " and sign in or sign up.",
      ),
      h(
        "li",
        null,
        "Tap ",
        h("strong", null, "Create API key"),
        ". Name it “Orbit”. If you see “Restrict key”, either turn it off or set Text to Speech, Speech to Text and Voices to “Access”.",
      ),
      h("li", null, "Copy the key and paste it below. It's saved only on this headset. Never paste it into a chat."),
      h(
        "li",
        { class: "dim" },
        "Optional: on elevenlabs.io → Voices, search “Callie” and “Marissa” and tap Add, so her favourite voices are ready.",
      ),
    ),
    form,
  );
  title.id = "voice-card-title";

  function showMessage(text: string, error: boolean): void {
    message.textContent = text;
    message.hidden = !text;
    message.classList.toggle("error", error);
  }

  function setBusy(on: boolean): void {
    busy = on;
    submitBtn.disabled = on;
    input.readOnly = on;
  }

  async function submit(): Promise<void> {
    if (busy) return;
    const name = assistantName(ctx.getSettings());
    if (!cleanElevenKey(input.value)) {
      input.focus();
      return;
    }
    setBusy(true);
    showMessage(CARD_TEXT.checking, false);
    let result: KeyCheckResult;
    try {
      result = await checkVoiceKey(input.value, name, makeClient);
    } finally {
      setBusy(false);
    }
    if (result.kind === "empty") {
      showMessage("", false);
      input.focus();
      return;
    }
    if (result.kind === "invalid") {
      showMessage(result.message, true);
      input.focus();
      input.select();
      return;
    }
    input.value = "";
    showMessage("", false);
    ctx.updateSettings({ elevenLabsKey: result.key });
    ctx.toast(result.toast);
  }

  /** Puts the card in the slot or takes it out; call on every settings change. */
  function sync(): boolean {
    const s = ctx.getSettings();
    title.textContent = cardTitle(assistantName(s));
    const show = voiceCardVisible(s);
    if (show && el.parentNode !== slot) slot.replaceChildren(el);
    else if (!show && el.parentNode === slot) slot.replaceChildren();
    return show;
  }

  return { el, sync, submit };
}
