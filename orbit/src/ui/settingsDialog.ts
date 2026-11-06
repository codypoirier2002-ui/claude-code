// The settings dialog (§6.9). A native <dialog> with a <form method="dialog">:
// Save (or Enter in a field) writes every field at once; Esc or Cancel
// discards. The form is rebuilt on every open, so discarded edits never linger.

import { ElevenError, createElevenClient, type Voice } from "../core/eleven";
import { ENVIRONMENTS } from "../core/environments";
import { PERSONALITIES } from "../core/modes";
import {
  EFFORTS,
  MODELS,
  VOICE_PRESETS,
  assistantName,
  type AmbienceMode,
  type Effort,
  type Settings,
} from "../core/settings";
import { eraseAllStorage } from "../core/store";
import type { AppCtx, SettingsSection } from "./context";
import { h } from "./dom";

export const ERASE_CONFIRM = "Delete your keys, chats, timers, tasks, notes, memories and avatar from this headset?";
export type ElevenVoice = Voice;

/** GET /v1/voices mapped to {id, name}. Failures throw an ElevenError classified per §5.3. */
export function fetchVoices(key: string, signal?: AbortSignal): Promise<ElevenVoice[]> {
  return createElevenClient({ getKey: () => key })
    .listVoices(signal)
    .then((list) => list.map((v) => ({ id: v.id, name: v.name || v.id })));
}

const NOTE_FIRST = "Callie and Marissa need adding to My voices on elevenlabs.io first (Voices → search the name → Add).";
const NOTE_LOADING = "Loading your voices…";
const NOTE_ALL = "All the favourites are in your account.";

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The note when the voices couldn't load: the classified ElevenLabs message, else the first note. */
export function voicesErrorNote(err: unknown): string {
  return err instanceof ElevenError ? err.message : NOTE_FIRST;
}

/** The note under "Her voice" once the account's voices are known. */
export function voicesNote(accountIds: ReadonlySet<string>): string {
  const missing = VOICE_PRESETS.filter((p) => !accountIds.has(p.id)).map((p) => p.name);
  if (!missing.length) return NOTE_ALL;
  return `Not in your account yet: ${joinNames(missing)}. Add them on elevenlabs.io → Voices → search the name → Add to my voices.`;
}

export function createSettingsDialog(ctx: AppCtx) {
  const dialog = h("dialog", { class: "settings", "aria-label": "Settings" });
  let voicesAbort: AbortController | null = null;

  function hint(text: string): HTMLElement {
    return h("p", { class: "hint" }, text);
  }

  function field(label: string, control: HTMLElement, ...rest: (HTMLElement | false | null)[]): HTMLElement {
    return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, ...rest);
  }

  function check(label: string, checked: boolean, name: string): { row: HTMLElement; input: HTMLInputElement } {
    const input = h("input", { type: "checkbox", name, checked });
    return { input, row: h("label", { class: "check" }, input, h("span", null, label)) };
  }

  function section(title: string, id?: string): HTMLElement {
    return h("h3", { class: "section", ...(id ? { id } : {}) }, title);
  }

  function build(s: Settings): { form: HTMLFormElement; focusTargets: Record<SettingsSection, HTMLElement> } {
    // 1. Claude key
    const apiKey = h("input", { type: "password", name: "apiKey", value: s.apiKey, placeholder: "sk-ant-…", autocomplete: "off", spellcheck: "false" });
    // 2. Models
    const model = h("select", { name: "model" }, MODELS.map((m) => h("option", { value: m.id, selected: m.id === s.model }, m.label)));
    // 3. Voice
    const elevenKey = h("input", { type: "password", name: "elevenLabsKey", value: s.elevenLabsKey, autocomplete: "off", spellcheck: "false" });
    // 4. Her voice
    const voice = h("select", { name: "voiceId" });
    const voiceNote = h("p", { class: "hint", "aria-live": "polite" }, NOTE_FIRST);
    let accountVoices: ElevenVoice[] | null = null;
    function renderVoices(): void {
      const selected = voice.value || s.voiceId;
      const presetIds = new Set(VOICE_PRESETS.map((p) => p.id));
      const favs = h(
        "optgroup",
        { label: "Favourites" },
        VOICE_PRESETS.map((p) => h("option", { value: p.id }, `${p.name} · ${p.note}`)),
      );
      const groups: HTMLElement[] = [favs];
      const own = (accountVoices ?? []).filter((v) => !presetIds.has(v.id));
      // Keep a saved custom voice selectable even before the list loads.
      if (!presetIds.has(selected) && !own.some((v) => v.id === selected)) own.unshift({ id: selected, name: selected });
      if (own.length) {
        groups.push(h("optgroup", { label: "Your ElevenLabs voices" }, own.map((v) => h("option", { value: v.id }, v.name))));
      }
      voice.replaceChildren(...groups);
      voice.value = selected;
    }
    async function loadVoices(): Promise<void> {
      voicesAbort?.abort();
      const key = elevenKey.value.trim();
      if (!key) {
        accountVoices = null;
        voiceNote.textContent = NOTE_FIRST;
        renderVoices();
        return;
      }
      const abort = new AbortController();
      voicesAbort = abort;
      voiceNote.textContent = NOTE_LOADING;
      try {
        const list = await fetchVoices(key, abort.signal);
        if (abort.signal.aborted) return;
        accountVoices = list;
        voiceNote.textContent = voicesNote(new Set(list.map((v) => v.id)));
      } catch (err) {
        if (abort.signal.aborted) return;
        accountVoices = null;
        voiceNote.textContent = voicesErrorNote(err);
      }
      renderVoices();
    }
    renderVoices();
    let keyTimer: ReturnType<typeof setTimeout> | undefined;
    elevenKey.addEventListener("input", () => {
      clearTimeout(keyTimer);
      keyTimer = setTimeout(() => void loadVoices(), 600);
    });
    void loadVoices();

    // 5. Speed
    const speedOut = h("output", { class: "readout" }, `${s.voiceSpeed.toFixed(2)}×`);
    const speed = h("input", { type: "range", name: "voiceSpeed", min: "0.7", max: "1.2", step: "0.05", value: String(s.voiceSpeed) });
    speed.addEventListener("input", () => (speedOut.textContent = `${Number(speed.value).toFixed(2)}×`));
    // 6–7
    const expressive = check("Expressive voice", s.expressiveVoice, "expressiveVoice");
    const bargeIn = check("Interrupt her by talking", s.bargeIn, "bargeIn");
    // 8. Her
    const name = h("input", { type: "text", name: "assistantName", value: assistantName(s), maxlength: "24", autocomplete: "off" });
    const personality = h(
      "select",
      { name: "personalityId" },
      PERSONALITIES.map((p) => h("option", { value: p.id, selected: p.id === s.personalityId }, p.name)),
    );
    // 9. VR scene
    const startInVR = check("Open straight into VR", s.startInVR, "startInVR");
    let envId = s.environmentId;
    const cards = ENVIRONMENTS.map((env) => {
      const thumb = env.thumb
        ? h("img", { class: "scene-thumb", src: env.thumb, alt: "", loading: "lazy", width: "320", height: "160" })
        : h("span", { class: "scene-thumb clock-swatch", "aria-hidden": "true" }, "🕒");
      const card = h(
        "button",
        {
          type: "button",
          class: ["scene-card", env.id === envId && "selected"],
          "aria-pressed": env.id === envId ? "true" : "false",
          title: env.note,
          dataset: { env: env.id },
          onClick: () => {
            envId = env.id;
            for (const c of cards) {
              const on = c.dataset.env === envId;
              c.classList.toggle("selected", on);
              c.setAttribute("aria-pressed", on ? "true" : "false");
            }
          },
        },
        thumb,
        h("span", { class: "scene-name" }, env.name),
      );
      return card;
    });
    const ambience = h(
      "select",
      { name: "ambience" },
      ([["vr", "In VR"], ["always", "In VR and the app"], ["off", "Off"]] as const).map(([v, label]) =>
        h("option", { value: v, selected: v === s.ambience }, label),
      ),
    );
    const ambienceVolume = h("input", { type: "range", name: "ambienceVolume", min: "0", max: "1", step: "0.05", value: String(s.ambienceVolume) });
    // 10. Her eyes
    const look = check("Look when I say “look at this”", s.lookOnRequest, "lookOnRequest");
    // 11. Her body
    const showCharacter = check("Show her animated face", s.showCharacter, "showCharacter");
    const bodyNote = hint(
      "No 3D body yet, so she uses her illustrated face. For a full 3D body, make her in VRoid Studio (free), export as .vrm, then load it here.",
    );
    const loadVrm = h(
      "button",
      { type: "button", class: "btn ghost", onClick: () => ctx.toast("3D bodies come in a later build") },
      "Load .vrm avatar",
    );
    const removeVrm = h("button", { type: "button", class: "btn ghost", disabled: true }, "Remove body");
    // 12. Advanced
    const suggest = check("Suggested replies after answers", s.suggestReplies, "suggestReplies");
    const effort = h("select", { name: "effort" }, EFFORTS.map((e) => h("option", { value: e, selected: e === s.effort }, e)));
    const baseURL = h("input", {
      type: "url",
      name: "baseURL",
      value: s.baseURL,
      placeholder: "https://your-proxy.example.com (optional)",
      autocomplete: "off",
      spellcheck: "false",
    });

    const cancel = h("button", { type: "button", class: "btn ghost", onClick: () => dialog.close("cancel") }, "Cancel");
    const save = h("button", { type: "submit", class: "btn primary", value: "save" }, "Save");
    const erase = h(
      "button",
      {
        type: "button",
        class: "btn danger",
        onClick: () => {
          if (!confirm(ERASE_CONFIRM)) return;
          ctx.voice.stop();
          ctx.assistant.reset();
          eraseAllStorage();
          // Phase 7 also deletes the IndexedDB avatar here.
          location.reload();
        },
      },
      "Erase all data",
    );

    const voiceHeading = section("Voice", "settings-voice");
    const form = h(
      "form",
      { method: "dialog" },
      h("div", { class: "settings-head" }, h("h2", null, "Settings")),
      h(
        "div",
        { class: "settings-body" },
        field("Claude API key (Anthropic)", apiKey, hint("From platform.claude.com → API keys, scoped to the Default workspace. Saved only on this headset.")),
        field("Models", model, hint("Auto: Claude Haiku 5.5 for chat, Claude Opus 5.5 when it needs to think, Claude Fable 5.1 when it's stuck.")),
        voiceHeading,
        field(
          "ElevenLabs API key",
          elevenKey,
          hint(
            "Lets you talk hands-free and hear her answer (Quest Browser has no built-in speech recognition). Get a key at elevenlabs.io → Developers → API keys. The free plan works.",
          ),
        ),
        field("Her voice", voice, voiceNote),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Speaking speed ", speedOut), speed),
        expressive.row,
        hint("She can actually giggle, sigh and whisper (ElevenLabs v4). Starts speaking a beat later; the speed slider applies only to the fast voice."),
        bargeIn.row,
        hint("Start talking while she speaks and she stops to listen. Turn off if she cuts herself off in a loud room."),
        section("Her"),
        field("Name", name),
        field("Personality", personality),
        hint("She warms up as you talk more and she remembers more about you."),
        section("VR scene"),
        startInVR.row,
        hint("When Orbit is installed on your Quest, opening it takes you right into VR with her. Exit VR to get back to the regular app."),
        h("div", { class: "scene-grid", role: "group", "aria-label": "VR scene" }, cards),
        hint("Where you two hang out in VR, and the backdrop behind your chat. In VR, the 🌅 Scene button cycles through them."),
        field("Scene sounds", ambience),
        field("Scene sound volume", ambienceVolume),
        hint("Waves, rain, birdsong… each scene has its own soundscape. It quiets down whenever she talks or listens."),
        section("Her eyes"),
        look.row,
        hint(
          "In voice mode, phrases like “what is this?” or “can you see…” take one photo through the headset camera and send it with your question. The 👁 button does the same any time. Photos go to Claude only with that message; nothing is recorded.",
        ),
        section("Her body"),
        showCharacter.row,
        bodyNote,
        h("div", { class: "button-row" }, loadVrm, removeVrm),
        h(
          "details",
          { class: "advanced" },
          h("summary", null, "Advanced"),
          suggest.row,
          field("Thinking effort", effort),
          field(
            "API proxy URL",
            baseURL,
            hint("Point Orbit at your own proxy, which adds the Claude key server-side. With a proxy set, the key above is never sent."),
          ),
        ),
      ),
      h("div", { class: "settings-foot" }, erase, h("span", { class: "spacer" }), cancel, save),
    );

    form.addEventListener("submit", () => {
      voicesAbort?.abort();
      ctx.updateSettings({
        apiKey: apiKey.value.trim(),
        model: model.value,
        elevenLabsKey: elevenKey.value.trim(),
        voiceId: voice.value || s.voiceId,
        voiceSpeed: Math.min(1.2, Math.max(0.7, Number(speed.value) || 1.1)),
        expressiveVoice: expressive.input.checked,
        bargeIn: bargeIn.input.checked,
        assistantName: assistantName({ assistantName: name.value }),
        personalityId: personality.value,
        startInVR: startInVR.input.checked,
        environmentId: envId,
        ambience: ambience.value as AmbienceMode,
        ambienceVolume: Math.min(1, Math.max(0, Number(ambienceVolume.value))),
        lookOnRequest: look.input.checked,
        showCharacter: showCharacter.input.checked,
        suggestReplies: suggest.input.checked,
        effort: effort.value as Effort,
        baseURL: baseURL.value.trim(),
      });
    });

    return { form, focusTargets: { apiKey, voice: elevenKey } };
  }

  dialog.addEventListener("close", () => voicesAbort?.abort());

  function open(section?: SettingsSection): void {
    const { form, focusTargets } = build(ctx.getSettings());
    dialog.replaceChildren(form);
    if (!dialog.open) dialog.showModal();
    const target = section ? focusTargets[section] : null;
    if (target) {
      target.focus();
      target.closest(".field")?.scrollIntoView({ block: "center" });
      if (section === "voice") form.querySelector("#settings-voice")?.scrollIntoView({ block: "start" });
    } else {
      form.querySelector<HTMLElement>(".settings-body")?.scrollTo({ top: 0 });
    }
  }

  return { el: dialog, open };
}
