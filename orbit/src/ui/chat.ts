// The conversation (§6.5): welcome states, the greeting banner, message rows,
// follow-up chips, bubble tools and the error bar.

import { THINK_HARDER_TITLE, modelsLabel, thinkHarderLabel, type AssistantState, type DisplayTurn } from "../core/assistant";
import { modeById } from "../core/modes";
import { assistantName, isConfigured } from "../core/settings";
import { stripAudioTags } from "../core/tags";
import type { AppCtx } from "./context";
import { h } from "./dom";
import { FACE_SRC } from "./header";
import { renderMarkdown } from "./markdown";

/** A row on screen: a stored turn, or her live (streaming) reply. */
export interface Row {
  role: "user" | "assistant";
  text: string;
  actions: string[];
  models: string[];
  image?: string;
  /** Her row follows a user turn that carried an image. */
  imageNote?: boolean;
  live?: boolean;
  status?: string;
  /** Her finished reply that is the last row. */
  last?: boolean;
}

const dedupe = (xs: readonly string[]) => [...new Set(xs.filter(Boolean))];

/**
 * The rows to draw. While a run is busy, the assistant messages it has already
 * stored (after the last user turn) are shown as one live bubble together with
 * the streaming text, so the bubble never jumps when a round is saved.
 */
export function buildRows(state: Pick<AssistantState, "turns" | "busy" | "text" | "actions" | "model" | "status">): Row[] {
  const turns: DisplayTurn[] = state.turns;
  let stored = turns;
  let tail: DisplayTurn | undefined;
  if (state.busy && turns.length && turns[turns.length - 1].role === "assistant") {
    tail = turns[turns.length - 1];
    stored = turns.slice(0, -1);
  }
  const rows: Row[] = [];
  let prevImage = false;
  for (const t of stored) {
    if (t.role === "user") {
      rows.push({ role: "user", text: t.text, actions: [], models: [], ...(t.image ? { image: t.image } : {}) });
      prevImage = Boolean(t.image);
    } else {
      rows.push({ role: "assistant", text: t.text, actions: t.actions, models: t.models, imageNote: prevImage });
      prevImage = false;
    }
  }
  if (state.busy) {
    rows.push({
      role: "assistant",
      live: true,
      text: state.text || tail?.text || "",
      actions: dedupe([...(tail?.actions ?? []), ...state.actions]),
      models: dedupe([...(tail?.models ?? []), state.model]),
      imageNote: prevImage,
      status: state.status,
    });
  } else {
    const lastRow = rows[rows.length - 1];
    if (lastRow && lastRow.role === "assistant") lastRow.last = true;
  }
  return rows;
}

/** Which of `count` rows animate in, given how many were shown before (§6.5 slide-in rule). */
export function enteringFrom(shown: number, count: number, modeChanged: boolean): number {
  if (modeChanged || count <= shown || count - shown > 2) return count;
  return shown;
}

const MD_CACHE_MAX = 200;
const mdCache = new Map<string, string>();
function markdownHtml(text: string): string {
  let html = mdCache.get(text);
  if (html === undefined) {
    html = renderMarkdown(stripAudioTags(text));
    if (mdCache.size >= MD_CACHE_MAX) mdCache.delete(mdCache.keys().next().value as string);
    mdCache.set(text, html);
  }
  return html;
}

export function createConversation(ctx: AppCtx) {
  const { assistant } = ctx;
  const banner = h("div", { class: "greeting-wrap" });
  const list = h("div", { class: "messages", role: "log", "aria-live": "polite", "aria-relevant": "additions" });
  const errorBar = h("div", { class: "error-wrap" });
  /** Persistent container for the "Let {name} talk" card (§6.8, ui/voiceCard.ts). */
  const voiceCardSlot = h("div", { class: "voice-card-slot" });

  let shown = 0;
  let shownMode = "";
  /** Row index → when it started sliding in, so rebuilds mid-animation continue it instead of cutting it. */
  const enteredAt = new Map<number, number>();
  const ENTER_MS = 350;
  let welcomeShowing = false;
  let hadPending = false;

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(stripAudioTags(text));
      ctx.toast("Copied.");
    } catch {
      ctx.toast("Couldn't copy here.");
    }
  }

  /** 🔊 Read (§6.5): ElevenLabs with a key, else the browser's speechSynthesis. */
  function read(text: string): void {
    if (!ctx.voice.canSpeak()) return ctx.needVoiceKey();
    ctx.voice.say(text);
  }

  function face(): HTMLElement {
    return h("img", { class: "face", src: FACE_SRC, alt: "", width: "38", height: "38", decoding: "async" });
  }

  function herRow(row: Row, name: string, state: AssistantState): HTMLElement {
    const bubble = h(
      "div",
      { class: "bubble her" },
      h(
        "div",
        { class: "bubble-head" },
        h("span", { class: "her-name" }, name),
        row.models.length > 0 && h("span", { class: "model-chip" }, modelsLabel(row.models)),
      ),
      row.imageNote && h("div", { class: "image-note" }, "🖼 Image attached"),
      row.actions.length > 0 && h("div", { class: "actions" }, row.actions.map((a) => h("span", { class: "action" }, a))),
    );
    if (row.text) {
      const md = h("div", { class: "md" });
      md.innerHTML = markdownHtml(row.text);
      bubble.append(md);
    }
    if (row.live) {
      if (row.status) {
        bubble.append(h("div", { class: "status-line" }, h("span", { class: "pulse-dot", "aria-hidden": "true" }), row.status));
      } else if (!row.text) {
        bubble.append(
          h("div", { class: "typing", "aria-label": `${name} is typing` }, h("span", null), h("span", null), h("span", null)),
        );
      }
    }
    const col = h("div", { class: "her-col" }, bubble);
    if (!row.live && row.text) {
      const target = row.last ? state.thinkHarderTarget : null;
      col.append(
        h(
          "div",
          { class: "bubble-tools" },
          h("button", { type: "button", class: "tool", onClick: () => read(row.text) }, "🔊 Read"),
          h("button", { type: "button", class: "tool", onClick: () => void copy(row.text) }, "📋 Copy"),
          target &&
            h(
              "button",
              { type: "button", class: "tool think", title: THINK_HARDER_TITLE, onClick: () => void assistant.thinkHarder() },
              thinkHarderLabel(target),
            ),
        ),
      );
    }
    if (row.last && state.suggestions.length) {
      col.append(
        h(
          "div",
          { class: "followups" },
          state.suggestions.map((s) =>
            h("button", { type: "button", class: "followup", onClick: () => void assistant.send({ text: s }) }, s),
          ),
        ),
      );
    }
    return h("div", { class: "row her-row" }, face(), col);
  }

  function userRow(row: Row): HTMLElement {
    return h(
      "div",
      { class: "row user-row" },
      h(
        "div",
        { class: "bubble you" },
        row.image && h("img", { class: "sent-image", src: `data:image/jpeg;base64,${row.image}`, alt: "Attached image" }),
        row.text && h("div", { class: "you-text" }, row.text),
      ),
    );
  }

  function welcome(state: AssistantState): HTMLElement {
    const s = ctx.getSettings();
    const name = assistantName(s);
    const hero = h(
      "button",
      { type: "button", class: "hero", "aria-label": isConfigured(s) ? `Talk to ${name}` : "Open Settings" },
      ctx.slots.hero.el,
    );
    if (!isConfigured(s)) {
      hero.addEventListener("click", () => ctx.openSettings("apiKey"));
      return h(
        "div",
        { class: "welcome" },
        hero,
        h("h1", null, `Hi, I'm ${name}`),
        h(
          "p",
          { class: "welcome-sub" },
          "I run on your own Anthropic API key. It's stored only in this headset's browser and sent only to the Claude API.",
        ),
        h("button", { type: "button", class: "btn primary", onClick: () => ctx.openSettings("apiKey") }, "Add API key"),
      );
    }
    hero.addEventListener("click", () => ctx.voice.startTalk());
    const mode = modeById(state.modeId);
    const showCard = voiceCardSlot.childElementCount > 0;
    hero.classList.toggle("compact", showCard);
    return h(
      "div",
      { class: "welcome" },
      hero,
      h("h1", null, state.greeting ? `Hey, it's ${name}` : `Hi, I'm ${name}`),
      h("p", { class: "welcome-sub" }, `${mode.icon} ${mode.name} · ${mode.blurb}. Tap me to talk, or try one of these:`),
      voiceCardSlot,
      h(
        "div",
        { class: "prompts" },
        mode.quickPrompts.map((p) => h("button", { type: "button", class: "prompt", onClick: () => void assistant.send({ text: p }) }, p)),
      ),
    );
  }

  function renderBanner(state: AssistantState): void {
    if (!state.greeting || state.greeting.dismissed) {
      banner.replaceChildren();
      return;
    }
    banner.replaceChildren(
      h(
        "div",
        { class: "greeting" },
        h("span", { class: "greeting-text" }, stripAudioTags(state.greeting.text)),
        h("button", { type: "button", class: "x", "aria-label": "Dismiss", onClick: () => assistant.dismissGreeting() }, "×"),
      ),
    );
  }

  function renderError(state: AssistantState): void {
    const err = state.error;
    if (!err || state.busy) {
      errorBar.replaceChildren();
      return;
    }
    errorBar.replaceChildren(
      h(
        "div",
        { class: "error-bar", role: "alert" },
        h("span", { class: "error-text" }, err.message),
        err.canRetry &&
          h(
            "button",
            {
              type: "button",
              class: "btn small",
              onClick: () => {
                const p = assistant.getState().pending;
                if (p) ctx.composer.clearIfDraft(p.text);
                void assistant.retry();
              },
            },
            "Retry",
          ),
        /key|settings/i.test(err.message) &&
          h("button", { type: "button", class: "btn small ghost", onClick: () => ctx.openSettings() }, "Settings"),
      ),
    );
  }

  function render(): void {
    const state = assistant.getState();
    const name = assistantName(ctx.getSettings());

    // A failed send comes back as a pending retry: put its text and image back in the composer.
    if (state.hasPending && !hadPending && state.pending) ctx.composer.restore(state.pending.text, state.pending.attachment);
    hadPending = state.hasPending;

    renderBanner(state);
    renderError(state);

    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    const rows = buildRows(state);
    const modeChanged = state.modeId !== shownMode;

    if (rows.length === 0) {
      welcomeShowing = true;
      list.replaceChildren(welcome(state));
      document.body.classList.add("hero-showing");
      shown = 0;
      shownMode = state.modeId;
      enteredAt.clear();
      list.scrollTop = 0;
      return;
    }

    welcomeShowing = false;
    document.body.classList.remove("hero-showing");
    const from = enteringFrom(shown, rows.length, modeChanged);
    const t = performance.now();
    if (modeChanged || rows.length < shown) enteredAt.clear();
    for (let i = from; i < rows.length; i++) enteredAt.set(i, t);
    const els = rows.map((row, i) => {
      const el = row.role === "user" ? userRow(row) : herRow(row, name, state);
      const started = enteredAt.get(i);
      if (started !== undefined) {
        const elapsed = t - started;
        if (elapsed < ENTER_MS) {
          el.classList.add("enter");
          if (elapsed > 0) el.style.animationDelay = `${-Math.round(elapsed)}ms`;
        } else {
          enteredAt.delete(i);
        }
      }
      return el;
    });
    list.replaceChildren(...els);
    shown = rows.length;
    shownMode = state.modeId;

    if (nearBottom || state.busy || modeChanged) list.scrollTop = list.scrollHeight;
  }

  return {
    banner,
    list,
    errorBar,
    voiceCardSlot,
    render,
    isWelcomeShowing: () => welcomeShowing,
  };
}
