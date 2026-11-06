// The side panel, "Your stuff" (§6.4): Today (timers and to-dos), Notes and
// Memory with the story card.

import {
  bestStreak,
  bondProgress,
  closenessScore,
  currentStreak,
  daysTogether,
  nextStageName,
  stageName,
} from "../core/bond";
import { assistantName } from "../core/settings";
import { readJSON } from "../core/store";
import type { Timer } from "../core/workspace";
import type { AppCtx } from "./context";
import { clear, formatRemaining, h } from "./dom";
import { formatNoteDate, formatReminder } from "./format";
import { renderMarkdown } from "./markdown";

type Tab = "today" | "notes" | "memory";

function conversationCount(): number {
  const n = readJSON<unknown>("conversations", 0);
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

export function createSidePanel(ctx: AppCtx) {
  const { workspace } = ctx;
  let tab: Tab = "today";
  const openNotes = new Set<string>();
  /** Countdown spans by timer id, updated in place by the clock. */
  const countdowns = new Map<string, HTMLElement>();

  const el = h("aside", { class: "side", id: "side-panel", "aria-label": "Your stuff" });
  const tabsEl = h("div", { class: "tabs", role: "tablist" });
  const body = h("div", { class: "side-body" });

  // The to-do input is built once, so re-renders don't wipe what the user is typing.
  const taskInput = h("input", {
    class: "task-input",
    type: "text",
    placeholder: "Add a task",
    "aria-label": "Add a task",
    maxlength: "300",
    enterkeyhint: "done",
    onKeydown: (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      const text = taskInput.value.trim();
      if (!text) return;
      e.preventDefault();
      workspace.addTask(text);
      taskInput.value = "";
    },
  });

  el.append(tabsEl, body);

  function renderTabs(): void {
    const notes = workspace.getState().notes.length;
    const mk = (id: Tab, label: string) =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          class: ["tab", tab === id && "active"],
          "aria-selected": tab === id ? "true" : "false",
          onClick: () => {
            tab = id;
            render();
          },
        },
        label,
      );
    tabsEl.replaceChildren(mk("today", "Today"), mk("notes", `Notes ${notes}`), mk("memory", "Memory"));
  }

  function timerRow(t: Timer, now: number): HTMLElement {
    const isReminder = t.at !== undefined;
    let right: HTMLElement;
    if (t.done) right = h("span", { class: "timer-when" }, "done");
    else if (isReminder) right = h("span", { class: "timer-when" }, formatReminder(t.endsAt, now, t.daily));
    else {
      right = h("span", { class: "countdown" }, formatRemaining(t.endsAt - now));
      countdowns.set(t.id, right);
    }
    return h(
      "li",
      { class: ["timer", t.done && "finished"] },
      h("span", { class: "timer-label" }, isReminder ? `🔔 ${t.label}` : t.focus ? `🎯 ${t.label}` : t.label),
      right,
      !t.done &&
        h(
          "button",
          { type: "button", class: "x", title: "Cancel", "aria-label": `Cancel ${t.label}`, onClick: () => workspace.cancelTimer(t.id) },
          "×",
        ),
    );
  }

  function renderToday(name: string): HTMLElement[] {
    const now = Date.now();
    const timers = [...workspace.getState().timers].sort((a, b) => Number(a.done) - Number(b.done) || a.endsAt - b.endsAt);
    countdowns.clear();
    const quick = h(
      "div",
      { class: "quick-chips" },
      [1, 5, 10].map((m) =>
        h("button", { type: "button", class: "chip small", onClick: () => workspace.addTimer(m, `${m} min timer`) }, `${m}m`),
      ),
      h("button", { type: "button", class: "chip small", onClick: () => workspace.startFocus(25, undefined, 5) }, "🎯 25m"),
    );
    const hasFinished = timers.some((t) => t.done);
    const timersSection = h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "card-head" },
        h("h3", null, "Timers"),
        hasFinished && h("button", { type: "button", class: "link", onClick: () => workspace.clearFinished() }, "Clear finished"),
      ),
      timers.length
        ? h("ul", { class: "timers" }, timers.map((t) => timerRow(t, now)))
        : h("p", { class: "empty" }, "No timers. Try “set a 10 minute timer” or “remind me every day at 9 to stretch”."),
      quick,
    );

    const tasks = workspace.listTasks(true);
    const todo = h(
      "section",
      { class: "card" },
      h("div", { class: "card-head" }, h("h3", null, "To-do")),
      taskInput,
      tasks.length
        ? h(
            "ul",
            { class: "tasks" },
            tasks.map((t) =>
              h(
                "li",
                { class: ["task", t.done && "done"] },
                h(
                  "label",
                  null,
                  h("input", {
                    type: "checkbox",
                    checked: t.done,
                    onChange: (e: Event) => {
                      if ((e.target as HTMLInputElement).checked) workspace.completeTask(t.id);
                      else workspace.reopenTask(t.id);
                    },
                  }),
                  h("span", null, t.text),
                ),
                h(
                  "button",
                  { type: "button", class: "x", title: "Remove", "aria-label": `Remove ${t.text}`, onClick: () => workspace.deleteTask(t.id) },
                  "×",
                ),
              ),
            ),
          )
        : h("p", { class: "empty" }, `Nothing yet. ${name} can add tasks for you.`),
    );
    return [timersSection, todo];
  }

  function renderNotes(name: string): HTMLElement[] {
    const notes = workspace.getState().notes;
    if (!notes.length) return [h("p", { class: "empty pad" }, `Ask ${name} to “save that as a note” and it lands here.`)];
    // Forget open states of deleted notes.
    for (const id of [...openNotes]) if (!notes.some((n) => n.id === id)) openNotes.delete(id);
    return notes.map((n) => {
      const md = h("div", { class: "md" });
      md.innerHTML = renderMarkdown(n.body);
      const card = h(
        "details",
        {
          class: "card note",
          open: openNotes.has(n.id),
          onToggle: () => {
            if (card.open) openNotes.add(n.id);
            else openNotes.delete(n.id);
          },
        },
        h("summary", null, h("span", { class: "note-title" }, n.title), h("span", { class: "note-date" }, formatNoteDate(n.createdAt))),
        md,
        h("button", { type: "button", class: "link danger", onClick: () => workspace.deleteNote(n.id) }, "Delete note"),
      ) as HTMLDetailsElement;
      return card;
    });
  }

  function renderMemory(name: string): HTMLElement[] {
    const now = new Date();
    const memories = workspace.getState().memories;
    const chats = conversationCount();
    const score = closenessScore(chats, memories.length);
    const pct = bondProgress(score);
    const next = nextStageName(score);
    const streak = currentStreak(now);
    const best = bestStreak();
    const story = h(
      "section",
      { class: "card story" },
      h("div", { class: "story-kicker" }, `You & ${name}`),
      h("div", { class: "story-stage" }, stageName(score)),
      h(
        "div",
        { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) },
        h("span", { style: `width:${pct}%` }),
      ),
      h(
        "p",
        { class: "story-line" },
        next ? `${pct}% of the way to “${next}”. Chats and memories bring you closer.` : "As close as it gets. She knows you well.",
      ),
      h(
        "div",
        { class: "stats" },
        h("span", null, `🔥 ${streak} day streak`),
        h("span", null, `${chats} chats`),
        h("span", null, `${daysTogether(now)} days`),
        best > 1 && h("span", null, `${best} best`),
      ),
    );
    const facts = h(
      "section",
      { class: "card" },
      h("p", { class: "hint" }, `Facts ${name} keeps between chats. New facts apply from your next new chat.`),
      memories.length
        ? h(
            "ul",
            { class: "facts" },
            [...memories].reverse().map((m) =>
              h(
                "li",
                null,
                h("span", null, m.fact),
                h("button", { type: "button", class: "x", title: "Forget", "aria-label": `Forget ${m.fact}`, onClick: () => workspace.forget(m.id) }, "×"),
              ),
            ),
          )
        : h("p", { class: "empty" }, `Nothing remembered yet. Tell ${name} “remember that I play on a Quest 3”.`),
    );
    return [story, facts];
  }

  function render(): void {
    const name = assistantName(ctx.getSettings());
    renderTabs();
    const scroll = body.scrollTop;
    clear(body);
    const parts = tab === "today" ? renderToday(name) : tab === "notes" ? renderNotes(name) : renderMemory(name);
    body.append(...parts);
    body.scrollTop = scroll;
  }

  /** The clock's step 1: update countdown text in place. */
  function updateCountdowns(): void {
    const now = Date.now();
    for (const t of workspace.getState().timers) {
      const span = countdowns.get(t.id);
      if (span && !t.done) span.textContent = formatRemaining(t.endsAt - now);
    }
  }

  return { el, render, updateCountdowns };
}
