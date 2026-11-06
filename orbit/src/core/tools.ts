// Client tools (§3.6): definitions sent to Claude, zod validation, and runTool.

import { z } from "zod";
import type { Settings } from "./settings";
import type { Workspace } from "./workspace";
import { decideEscalation, type Tier } from "./routing";

export const ESCALATE_DESCRIPTION =
  "Hand this turn to a stronger Claude model, which continues the same conversation and answers the user. Use level 'think' (Claude Opus 5.5) BEFORE answering when the request needs careful reasoning: multi-step planning, math, coding or debugging, comparing options, troubleshooting, detailed explanations, long or polished writing, or synthesizing research. Use level 'deep' (Claude Fable 5.1) only when the user is clearly stuck after earlier attempts failed, or the problem is exceptionally hard. Do not escalate small talk, quick facts, simple tool actions (timers, tasks, notes) or short answers. Never escalate to your own tier or below. Don't write an answer in the same turn you escalate.";

export const MEMORY_BLOCKED =
  "Memory changes are disabled right after a web search. Ask the user to confirm in a new message.";

export const WEB_SEARCH_TOOL = Object.freeze({ type: "web_search_20250305", name: "web_search", max_uses: 5 });

type JsonSchema = Record<string, unknown>;

interface ToolDef {
  name: string;
  description: string;
  action: string;
  input_schema: JsonSchema;
  schema: z.ZodType;
}

const obj = (properties: Record<string, JsonSchema>, required: string[] = [], strict = false): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  ...(strict ? { additionalProperties: false } : {}),
});

const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extra });
const num = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "number", description, ...extra });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The 13 client tools, in table order. */
export const CLIENT_TOOLS: readonly ToolDef[] = [
  {
    name: "get_current_time",
    description: "Get the current local date, time and time zone on the headset. Use before anything time-relative.",
    action: "Checked the time",
    input_schema: obj({}, [], true),
    schema: z.object({}).strict(),
  },
  {
    name: "set_timer",
    description:
      "Start a countdown timer that chimes and is announced when it ends. For a clock time (\"at 6:30\", \"tomorrow at 9\"), use set_reminder instead.",
    action: "Set a timer",
    input_schema: obj(
      {
        minutes: num("Length in minutes: more than 0, at most 1440. Decimals are fine (0.5 = 30 seconds).", {
          exclusiveMinimum: 0,
          maximum: 1440,
        }),
        label: str("A short name for the timer, e.g. 'Pasta'.", { minLength: 1, maxLength: 80 }),
      },
      ["minutes", "label"],
    ),
    schema: z.object({ minutes: z.number().gt(0).max(1440), label: z.string().min(1).max(80) }),
  },
  {
    name: "set_reminder",
    description:
      "Set a reminder at a local clock time. It fires at the next occurrence of that time, or exactly then when a date is given. Set daily to repeat it every day.",
    action: "Set a reminder",
    input_schema: obj(
      {
        time: str("24-hour local time, HH:MM.", { pattern: "^([01]?\\d|2[0-3]):[0-5]\\d$" }),
        label: str("What to remind the user about.", { minLength: 1, maxLength: 80 }),
        date: str("Optional date, YYYY-MM-DD, for a one-off reminder on a specific day.", {
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        }),
        daily: bool("Repeat every day at this time."),
      },
      ["time", "label"],
    ),
    schema: z.object({
      time: z.string().regex(HHMM, "time must be 24-hour HH:MM"),
      label: z.string().min(1).max(80),
      date: z.string().regex(YMD, "date must be YYYY-MM-DD").optional(),
      daily: z.boolean().optional(),
    }),
  },
  {
    name: "start_focus",
    description:
      "Start a focus session (Pomodoro). You check in halfway, and when it ends a break timer starts. Suggest 25 minutes if the user doesn't say.",
    action: "Started a focus session",
    input_schema: obj(
      {
        minutes: num("Focus length in minutes, 1 to 180. Suggest 25.", { minimum: 1, maximum: 180 }),
        task: str("What the user is focusing on.", { maxLength: 120 }),
        break_minutes: num("Break length in minutes, 0 to 60. Default 5.", { minimum: 0, maximum: 60 }),
      },
      ["minutes"],
    ),
    schema: z.object({
      minutes: z.number().min(1).max(180),
      task: z.string().max(120).optional(),
      break_minutes: z.number().min(0).max(60).default(5),
    }),
  },
  {
    name: "cancel_timer",
    description: "Cancel a running timer, reminder or focus session by its id.",
    action: "Cancelled a timer",
    input_schema: obj({ id: str("The id from list_timers or from the tool that created it.") }, ["id"]),
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "list_timers",
    description: "List the running timers, reminders and focus sessions with the seconds left on each.",
    action: "Checked timers",
    input_schema: obj({}, [], true),
    schema: z.object({}).strict(),
  },
  {
    name: "add_task",
    description: "Add an item to the user's to-do list.",
    action: "Added a task",
    input_schema: obj({ text: str("The to-do item.", { minLength: 1, maxLength: 300 }) }, ["text"]),
    schema: z.object({ text: z.string().min(1).max(300) }),
  },
  {
    name: "complete_task",
    description: "Mark a to-do item as done by its id.",
    action: "Completed a task",
    input_schema: obj({ id: str("The task id from list_tasks.") }, ["id"]),
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "list_tasks",
    description: "List the user's to-do items. Only open items unless include_done is true.",
    action: "Checked tasks",
    input_schema: obj({ include_done: bool("Include finished items. Default false.") }),
    schema: z.object({ include_done: z.boolean().default(false) }),
  },
  {
    name: "save_note",
    description: "Save a note for the user. The body is plain text or light markdown.",
    action: "Saved a note",
    input_schema: obj(
      {
        title: str("A short title.", { minLength: 1, maxLength: 120 }),
        body: str("The note itself, plain text or light markdown.", { minLength: 1, maxLength: 20000 }),
      },
      ["title", "body"],
    ),
    schema: z.object({ title: z.string().min(1).max(120), body: z.string().min(1).max(20000) }),
  },
  {
    name: "search_notes",
    description:
      "Search the user's notes by a case-insensitive match on the title or body. An empty query returns everything. Returns the newest 10.",
    action: "Searched notes",
    input_schema: obj({ query: str("Text to look for; empty for all notes.", { maxLength: 200 }) }, ["query"]),
    schema: z.object({ query: z.string().max(200) }),
  },
  {
    name: "remember",
    description:
      "Save a durable fact about the user to long-term memory. Use only when the user shares something they would expect you to remember, or asks you to.",
    action: "Remembered something",
    input_schema: obj({ fact: str("The fact, in one short sentence.", { minLength: 1, maxLength: 300 }) }, ["fact"]),
    schema: z.object({ fact: z.string().min(1).max(300) }),
  },
  {
    name: "forget",
    description: "Delete a saved memory by its id (shown in brackets next to each saved fact).",
    action: "Forgot something",
    input_schema: obj({ id: str("The memory id.") }, ["id"]),
    schema: z.object({ id: z.string().min(1) }),
  },
];

const ESCALATE_INPUT_SCHEMA = obj(
  {
    level: { type: "string", enum: ["think", "deep"] },
    reason: str("A few words on why, e.g. 'multi-step trip plan'."),
  },
  ["level", "reason"],
);

/** Action chip labels by tool name. Escalate has none. */
export const ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(CLIENT_TOOLS.map((t) => [t.name, t.action])),
);
export const WEB_SEARCH_ACTION = "Searched the web";

/** The chip for a tool call, or null for escalate. */
export function actionLabel(name: string, server = false): string | null {
  if (server) return name === "web_search" ? WEB_SEARCH_ACTION : `Used ${name}`;
  if (name === "escalate") return null;
  return ACTION_LABELS[name] ?? `Used ${name}`;
}

/** Tools in the order sent (§3.6). The list depends only on Auto and Web, never on the tier. */
export function toolsFor(settings: Pick<Settings, "model" | "webSearch">): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = CLIENT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    eager_input_streaming: true,
  }));
  if (settings.model === "auto") {
    tools.push({
      name: "escalate",
      description: ESCALATE_DESCRIPTION,
      input_schema: ESCALATE_INPUT_SCHEMA,
      eager_input_streaming: true,
    });
  }
  if (settings.webSearch) tools.push({ ...WEB_SEARCH_TOOL });
  return tools;
}

export interface ToolContext {
  workspace: Workspace;
  /** Epoch ms. Defaults to Date.now. */
  now?: () => number;
  /** The current run already holds a web search result. */
  webSearchUsed?: boolean;
  /** For escalate: the model that made the call. */
  currentModel?: string;
  /** For escalate: routing is Auto. */
  auto?: boolean;
}

export interface ToolResult {
  content: string;
  is_error?: boolean;
  /** Escalate only: the tier to hand off to. */
  target?: Tier;
}

const fail = (content: string): ToolResult => ({ content, is_error: true });
const ok = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ");
}

const shortTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dateTime = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));

type Input = Record<string, unknown>;

/** Runs one client tool. Never throws: every failure is an is_error result. */
export function runTool(name: string, input: unknown, ctx: ToolContext): ToolResult {
  try {
    if (name === "escalate") return decideEscalation(input, ctx.currentModel ?? "", ctx.auto ?? false);
    const def = CLIENT_TOOLS.find((t) => t.name === name);
    if (!def) return fail(`Unknown tool: ${name}`);
    const parsed = def.schema.safeParse(input ?? {});
    if (!parsed.success) return fail(`INVALID_INPUT: ${formatIssues(parsed.error)}`);
    if ((name === "remember" || name === "forget") && ctx.webSearchUsed) return fail(MEMORY_BLOCKED);
    return execute(name, parsed.data as Input, ctx);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function execute(name: string, a: Input, ctx: ToolContext): ToolResult {
  const ws = ctx.workspace;
  const now = (ctx.now ?? Date.now)();
  switch (name) {
    case "get_current_time": {
      const d = new Date(now);
      return ok({
        iso: d.toISOString(),
        local: new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(d),
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    }
    case "set_timer": {
      const t = ws.addTimer(a.minutes as number, a.label as string);
      return ok({ id: t.id, label: t.label, ends_at_local: shortTime(t.endsAt) });
    }
    case "set_reminder": {
      const t = ws.addReminder(a.time as string, a.label as string, {
        date: a.date as string | undefined,
        daily: a.daily as boolean | undefined,
      });
      return ok({ id: t.id, label: t.label, due_local: dateTime(t.endsAt), daily: !!t.daily });
    }
    case "start_focus": {
      const t = ws.startFocus(a.minutes as number, a.task as string | undefined, a.break_minutes as number);
      return ok({ id: t.id, label: t.label, ends_at_local: shortTime(t.endsAt), break_minutes: t.focus?.breakMinutes });
    }
    case "cancel_timer": {
      const id = a.id as string;
      return ws.cancelTimer(id) ? ok({ cancelled: id }) : fail(`No timer with id ${id}`);
    }
    case "list_timers":
      return ok(
        ws.listRunning().map((t) => ({
          id: t.id,
          label: t.label,
          seconds_left: Math.max(0, Math.round((t.endsAt - now) / 1000)),
          ...(t.at ? { at: t.at } : {}),
          ...(t.daily ? { daily: true } : {}),
        })),
      );
    case "add_task": {
      const t = ws.addTask(a.text as string);
      return ok({ id: t.id, text: t.text });
    }
    case "complete_task": {
      const id = a.id as string;
      return ws.completeTask(id) ? ok({ completed: id }) : fail(`No task with id ${id}`);
    }
    case "list_tasks":
      return ok(ws.listTasks(a.include_done as boolean).map((t) => ({ id: t.id, text: t.text, done: t.done })));
    case "save_note": {
      const n = ws.addNote(a.title as string, a.body as string);
      return ok({ id: n.id, title: n.title });
    }
    case "search_notes":
      return ok(ws.searchNotes(a.query as string).map((n) => ({ id: n.id, title: n.title, body: n.body })));
    case "remember": {
      const m = ws.remember(a.fact as string);
      return ok({ id: m.id, remembered: m.fact });
    }
    case "forget": {
      const id = a.id as string;
      return ws.forget(id) ? ok({ forgotten: id }) : fail(`No memory with id ${id}`);
    }
    default:
      return fail(`Unknown tool: ${name}`);
  }
}
