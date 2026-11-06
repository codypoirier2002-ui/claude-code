// Workspace (§4.1–4.2): timers, reminders, focus sessions, tasks, notes and
// memories. Dependencies are injected; every change is an immutable commit
// that is persisted and announced to subscribers.

export interface FocusInfo {
  task?: string;
  breakMinutes: number;
  checkedIn?: boolean;
}

export interface Timer {
  id: string;
  label: string;
  /** Epoch ms when it fires. */
  endsAt: number;
  durationMs: number;
  done: boolean;
  /** Reminders only: the local clock time "HH:MM". */
  at?: string;
  /** Reminders only: re-arms for the next day after it fires. */
  daily?: boolean;
  /** Focus sessions only. */
  focus?: FocusInfo;
}

export interface Task {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: number;
}

export interface Memory {
  id: string;
  fact: string;
  createdAt: number;
}

export interface WorkspaceState {
  timers: readonly Timer[];
  tasks: readonly Task[];
  notes: readonly Note[];
  memories: readonly Memory[];
}

export interface WorkspaceDeps {
  /** Current time in epoch ms. Defaults to Date.now. */
  now?: () => number;
  /** Called with every committed state, e.g. to write `orbit:workspace`. */
  persist?: (state: WorkspaceState) => void;
  /** Saved state to start from; anything malformed is ignored. */
  initial?: unknown;
}

export interface ReminderOptions {
  /** "YYYY-MM-DD": fire exactly then instead of at the next occurrence. */
  date?: string;
  daily?: boolean;
}

export const MAX_MEMORIES = 50;
export const NOTE_SEARCH_LIMIT = 10;
export const NOTE_BODY_LIMIT = 2000;

const MINUTE = 60_000;
const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `{prefix}_{Date.now() in base 36}{4 random base-36 chars}` (§3.6). */
export function makeId(prefix: string): string {
  let rand = "";
  for (let i = 0; i < 4; i++) rand += ID_CHARS[Math.floor(Math.random() * 36)];
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

function parseTime(hhmm: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  const h = m ? Number(m[1]) : NaN;
  const min = m ? Number(m[2]) : NaN;
  if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) {
    throw new RangeError(`"${hhmm}" isn't a 24-hour HH:MM time.`);
  }
  return [h, min];
}

/** True for a real calendar date "YYYY-MM-DD" (round-trips through new Date(y, m - 1, d)). */
export function isValidDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

/**
 * With a date: exactly that local date and time. Without: today at HH:MM:00,
 * stepped forward one calendar day at a time until it is after `now`, which
 * keeps the clock time across daylight-saving changes.
 */
export function nextOccurrence(now: Date, hhmm: string, date?: string): Date {
  const [h, min] = parseTime(hhmm);
  if (date !== undefined) {
    if (!isValidDate(date)) throw new RangeError(`${date} isn't a real calendar date.`);
    const [y, mo, d] = date.split("-").map(Number);
    return new Date(y, mo - 1, d, h, min, 0, 0);
  }
  const t = new Date(now.getTime());
  t.setHours(h, min, 0, 0);
  while (t.getTime() <= now.getTime()) {
    t.setDate(t.getDate() + 1);
    // Re-pin the clock time in case the previous day's time fell in a DST gap.
    t.setHours(h, min, 0, 0);
  }
  return t;
}

function records<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null) as T[]) : [];
}

function normalize(initial: unknown): WorkspaceState {
  const o = (typeof initial === "object" && initial !== null ? initial : {}) as Record<string, unknown>;
  return {
    timers: records<Timer>(o.timers),
    tasks: records<Task>(o.tasks),
    notes: records<Note>(o.notes),
    memories: records<Memory>(o.memories).slice(-MAX_MEMORIES),
  };
}

const isRunning = (t: Timer) => !t.done;
const bySoonest = (a: Timer, b: Timer) => a.endsAt - b.endsAt;

export type Workspace = ReturnType<typeof createWorkspace>;

export function createWorkspace(deps: WorkspaceDeps = {}) {
  const now = deps.now ?? Date.now;
  const persist = deps.persist ?? (() => {});
  let state: WorkspaceState = normalize(deps.initial);
  const listeners = new Set<(s: WorkspaceState) => void>();

  function commit(patch: Partial<WorkspaceState>): void {
    state = { ...state, ...patch };
    persist(state);
    for (const fn of [...listeners]) fn(state);
  }

  function addTimerRecord(t: Timer): Timer {
    commit({ timers: [...state.timers, t] });
    return t;
  }

  return {
    getState(): WorkspaceState {
      return state;
    },

    subscribe(fn: (s: WorkspaceState) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    /** A countdown; minutes may be fractional (0.5 = 30 s). */
    addTimer(minutes: number, label: string): Timer {
      const durationMs = Math.round(minutes * MINUTE);
      return addTimerRecord({ id: makeId("tmr"), label, endsAt: now() + durationMs, durationMs, done: false });
    },

    /**
     * Fires at the next occurrence of the local time, or exactly then with a date.
     * Throws "{date} isn't a real calendar date." or "That date and time has already passed."
     */
    addReminder(time: string, label: string, opts: ReminderOptions = {}): Timer {
      const { date, daily } = opts;
      if (date !== undefined && !isValidDate(date)) throw new Error(`${date} isn't a real calendar date.`);
      const t = now();
      const due = nextOccurrence(new Date(t), time, date).getTime();
      if (due <= t) throw new Error("That date and time has already passed.");
      const [h, min] = parseTime(time);
      const at = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      const timer: Timer = { id: makeId("rem"), label, endsAt: due, durationMs: due - t, done: false, at };
      if (daily) timer.daily = true;
      return addTimerRecord(timer);
    },

    /** A Pomodoro session labelled "Focus: {task}" or "Focus". */
    startFocus(minutes: number, task?: string, breakMinutes = 5): Timer {
      const cleanTask = task?.trim() || undefined;
      const durationMs = Math.round(minutes * MINUTE);
      const focus: FocusInfo = { breakMinutes };
      if (cleanTask) focus.task = cleanTask;
      return addTimerRecord({
        id: makeId("fcs"),
        label: cleanTask ? `Focus: ${cleanTask}` : "Focus",
        endsAt: now() + durationMs,
        durationMs,
        done: false,
        focus,
      });
    },

    /** Cancels a running timer, reminder or focus session. */
    cancelTimer(id: string): boolean {
      if (!state.timers.some((t) => t.id === id && isRunning(t))) return false;
      commit({ timers: state.timers.filter((t) => t.id !== id) });
      return true;
    },

    /** Running timers, soonest first. */
    listRunning(): Timer[] {
      return state.timers.filter(isRunning).sort(bySoonest);
    },

    /**
     * Returns the timers whose endsAt ≤ now, as they were when they came due.
     * Daily reminders re-arm for the next day; everything else is marked done.
     */
    tick(): Timer[] {
      const t = now();
      const due = state.timers.filter((x) => isRunning(x) && x.endsAt <= t).sort(bySoonest);
      if (due.length === 0) return [];
      const dueIds = new Set(due.map((x) => x.id));
      commit({
        timers: state.timers.map((x) => {
          if (!dueIds.has(x.id)) return x;
          if (x.daily && x.at) {
            const endsAt = nextOccurrence(new Date(t), x.at).getTime();
            return { ...x, endsAt, durationMs: endsAt - t };
          }
          return { ...x, done: true };
        }),
      });
      return due;
    },

    /** Running focus sessions past halfway that haven't checked in; marks them so each fires once. */
    dueCheckIns(): Timer[] {
      const t = now();
      const due = state.timers.filter(
        (x) => isRunning(x) && x.focus && !x.focus.checkedIn && x.endsAt > t && t >= x.endsAt - x.durationMs / 2,
      );
      if (due.length === 0) return [];
      const dueIds = new Set(due.map((x) => x.id));
      commit({
        timers: state.timers.map((x) =>
          dueIds.has(x.id) && x.focus ? { ...x, focus: { ...x.focus, checkedIn: true } } : x,
        ),
      });
      return due;
    },

    /** Drops finished timers. */
    clearFinished(): void {
      if (state.timers.every(isRunning)) return;
      commit({ timers: state.timers.filter(isRunning) });
    },

    addTask(text: string): Task {
      const task: Task = { id: makeId("tsk"), text, done: false, createdAt: now() };
      commit({ tasks: [...state.tasks, task] });
      return task;
    },

    completeTask(id: string): boolean {
      if (!state.tasks.some((x) => x.id === id)) return false;
      commit({ tasks: state.tasks.map((x) => (x.id === id ? { ...x, done: true } : x)) });
      return true;
    },

    /** Un-checks a completed task (the side panel's checkbox). */
    reopenTask(id: string): boolean {
      if (!state.tasks.some((x) => x.id === id && x.done)) return false;
      commit({ tasks: state.tasks.map((x) => (x.id === id ? { ...x, done: false } : x)) });
      return true;
    },

    /** Removes a task (the side panel's "×"). */
    deleteTask(id: string): boolean {
      if (!state.tasks.some((x) => x.id === id)) return false;
      commit({ tasks: state.tasks.filter((x) => x.id !== id) });
      return true;
    },

    listTasks(includeDone = false): Task[] {
      return state.tasks.filter((x) => includeDone || !x.done);
    },

    /** Notes are kept newest first. */
    addNote(title: string, body: string): Note {
      const note: Note = { id: makeId("note"), title, body, createdAt: now() };
      commit({ notes: [note, ...state.notes] });
      return note;
    },

    deleteNote(id: string): boolean {
      if (!state.notes.some((x) => x.id === id)) return false;
      commit({ notes: state.notes.filter((x) => x.id !== id) });
      return true;
    },

    /** Case-insensitive substring on title or body; an empty query returns all. Newest 10, bodies cut to 2000. */
    searchNotes(query: string): Note[] {
      const q = query.trim().toLowerCase();
      return state.notes
        .filter((n) => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, NOTE_SEARCH_LIMIT)
        .map((n) => (n.body.length > NOTE_BODY_LIMIT ? { ...n, body: n.body.slice(0, NOTE_BODY_LIMIT) } : n));
    },

    /** Keeps the last 50. */
    remember(fact: string): Memory {
      const memory: Memory = { id: makeId("mem"), fact, createdAt: now() };
      commit({ memories: [...state.memories, memory].slice(-MAX_MEMORIES) });
      return memory;
    },

    forget(id: string): boolean {
      if (!state.memories.some((x) => x.id === id)) return false;
      commit({ memories: state.memories.filter((x) => x.id !== id) });
      return true;
    },
  };
}
