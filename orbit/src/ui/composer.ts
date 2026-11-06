// The composer (§6.6): the floating pill with ＋ attach, 👁 look, the
// autosizing textarea, 🎙 dictation and Send/Stop.

import type { Attachment } from "../core/assistant";
import { audioContext } from "../core/audioContext";
import { prepareImage } from "../core/images";
import { DICTATION_TEXT } from "../core/session";
import { assistantName, isConfigured } from "../core/settings";
import type { AppCtx } from "./context";
import { h } from "./dom";

export const TEXTAREA_MAX_PX = 180;
export const LOOK_PLACEHOLDER = "What should I look at?";

export function createComposer(ctx: AppCtx) {
  const { assistant } = ctx;
  let attachment: Attachment | undefined;
  /** The attachment came from the headset camera (phase 8); drives the 👁 placeholder. */
  let fromCamera = false;
  let capturing = false;

  const fileInput = h("input", {
    type: "file",
    accept: "image/*",
    class: "visually-hidden",
    tabindex: "-1",
    "aria-hidden": "true",
    onChange: () => void onFile(),
  });

  const textarea = h("textarea", {
    class: "composer-input",
    rows: 1,
    "aria-label": "Message",
    enterkeyhint: "send",
    onInput: () => {
      autosize();
      renderPlaceholder();
    },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      // Nothing happens during IME composition (229 covers older engines).
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      send();
    },
  });

  const preview = h("div", { class: "attachment", hidden: true });
  const attachBtn = h(
    "button",
    { type: "button", class: "icon-btn", title: "Attach an image or screenshot", "aria-label": "Attach an image or screenshot", onClick: () => fileInput.click() },
    "＋",
  );
  const lookBtn = h(
    "button",
    {
      type: "button",
      class: "icon-btn look",
      title: "Show her what you see (headset camera)",
      "aria-label": "Show her what you see (headset camera)",
      onClick: () => ctx.toast("Camera comes in a later build"),
    },
    "👁",
  );
  const micBtn = h(
    "button",
    {
      type: "button",
      class: "icon-btn mic",
      title: "Dictate",
      "aria-label": "Dictate",
      onClick: () => {
        audioContext(); // inside the tap (§5.2)
        ctx.voice.startDictation();
        render();
      },
    },
    "🎙",
  );
  const sendBtn = h("button", { type: "button", class: "send", onClick: () => (assistant.getState().busy ? assistant.stop() : send()) }, "Send");

  const pill = h("div", { class: "composer" }, attachBtn, lookBtn, textarea, micBtn, sendBtn);
  const el = h("div", { class: "composer-wrap" }, preview, pill, fileInput);

  function autosize(): void {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(TEXTAREA_MAX_PX, textarea.scrollHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > TEXTAREA_MAX_PX ? "auto" : "hidden";
  }

  function renderPlaceholder(): void {
    const name = assistantName(ctx.getSettings());
    const look = (capturing || fromCamera) && textarea.value === "";
    textarea.placeholder = ctx.voice.isTranscribing()
      ? DICTATION_TEXT.transcribing
      : look ? LOOK_PLACEHOLDER : `Message ${name}…`;
  }

  function renderPreview(): void {
    if (!attachment) {
      preview.hidden = true;
      preview.replaceChildren();
      return;
    }
    preview.hidden = false;
    preview.replaceChildren(
      h("img", { src: `data:image/jpeg;base64,${attachment.data}`, alt: "Attached image" }),
      h("button", { type: "button", class: "link", onClick: () => setAttachment(undefined) }, "Remove"),
    );
  }

  function setAttachment(a: Attachment | undefined, camera = false): void {
    attachment = a;
    fromCamera = Boolean(a) && camera;
    renderPreview();
    renderPlaceholder();
  }

  async function onFile(): Promise<void> {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      setAttachment({ data: await prepareImage(file) });
    } catch {
      ctx.toast("Couldn't read that image.");
    }
  }

  function send(): void {
    if (assistant.getState().busy) return;
    const text = textarea.value;
    if (!text.trim() && !attachment) return;
    if (!isConfigured(ctx.getSettings())) {
      ctx.openSettings("apiKey");
      return;
    }
    const a = attachment;
    textarea.value = "";
    setAttachment(undefined);
    autosize();
    void assistant.send({ text, ...(a ? { attachment: a } : {}) });
  }

  function render(): void {
    const busy = assistant.getState().busy;
    sendBtn.textContent = busy ? "Stop" : "Send";
    sendBtn.classList.toggle("stop", busy);
    sendBtn.setAttribute("aria-label", busy ? "Stop" : "Send");
    const recording = ctx.voice.isDictating();
    micBtn.classList.toggle("recording", recording);
    micBtn.setAttribute("aria-pressed", recording ? "true" : "false");
    lookBtn.classList.toggle("capturing", capturing);
    renderPlaceholder();
  }

  return {
    el,
    render,
    focus: () => textarea.focus(),
    restore(text: string, a?: Attachment): void {
      if (textarea.value.trim() || attachment) return;
      textarea.value = text;
      setAttachment(a);
      autosize();
    },
    clearIfDraft(text: string): void {
      if (textarea.value !== text) return;
      textarea.value = "";
      setAttachment(undefined);
      autosize();
    },
    /** Phase 8's camera: pulse 👁 while a frame is being taken. */
    setCapturing(on: boolean): void {
      capturing = on;
      render();
    },
    /** Phase 8's camera: attach a frame that went through prepareImage. */
    attachCameraFrame(data: string): void {
      setAttachment({ data }, true);
    },
    getDraft: () => textarea.value,
    setDraft(text: string): void {
      textarea.value = text;
      autosize();
      renderPlaceholder();
    },
  };
}
