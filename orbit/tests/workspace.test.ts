// Pin a zone with daylight saving so the DST cases mean something on any machine.
(globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env.TZ = "America/New_York";

import { describe, expect, it, vi } from "vitest";
import {
  createWorkspace,
  isValidDate,
  makeId,
  nextOccurrence,
  type WorkspaceState,
} from "../src/core/workspace";

const MIN = 60_000;
/** Local time helper. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

function setup(start = at(2026, 6, 15, 9, 0)) {
  let t = start;
  const saved: WorkspaceState[] = [];
  const ws = createWorkspace({ now: () => t, persist: (s) => saved.push(s) });
  return {
    ws,
    saved,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe("makeId", () => {
  it("uses {prefix}_{base36 time}{4 random base-36 chars}", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const id = makeId("tmr");
    vi.restoreAllMocks();
    const stamp = (1_800_000_000_000).toString(36);
    expect(id.startsWith(`tmr_${stamp}`)).toBe(true);
    expect(id).toMatch(new RegExp(`^tmr_${stamp}[0-9a-z]{4}$`));
  });
});

describe("timers", () => {
  it("adds a timer with fractional minutes and lists running ones soonest first", () => {
    const { ws } = setup();
    const a = ws.addTimer(10, "Tea");
    const b = ws.addTimer(0.5, "Eggs");
    expect(a.id).toMatch(/^tmr_/);
    expect(b.durationMs).toBe(30_000);
    expect(ws.listRunning().map((x) => x.label)).toEqual(["Eggs", "Tea"]);
  });

  it("tick returns due timers once and marks them done", () => {
    const { ws, advance } = setup();
    ws.addTimer(1, "A");
    ws.addTimer(5, "B");
    expect(ws.tick()).toEqual([]);
    advance(MIN);
    const due = ws.tick();
    expect(due.map((x) => x.label)).toEqual(["A"]);
    expect(due[0].done).toBe(false); // returned as it was when it came due
    expect(ws.tick()).toEqual([]);
    expect(ws.listRunning().map((x) => x.label)).toEqual(["B"]);
    expect(ws.getState().timers.find((x) => x.label === "A")?.done).toBe(true);
  });

  it("fires timers that came due while the app was closed on the first tick", () => {
    const start = at(2026, 6, 15, 9, 0);
    const first = setup(start);
    first.ws.addTimer(5, "Laundry");
    first.ws.addTimer(10, "Oven");
    const saved = first.saved[first.saved.length - 1];

    // Reopen two hours later from the persisted state.
    const later = start + 120 * MIN;
    const ws = createWorkspace({ now: () => later, persist: () => {}, initial: JSON.parse(JSON.stringify(saved)) });
    expect(ws.tick().map((x) => x.label)).toEqual(["Laundry", "Oven"]);
    expect(ws.listRunning()).toEqual([]);
  });

  it("cancels running timers only", () => {
    const { ws, advance } = setup();
    const a = ws.addTimer(1, "A");
    const b = ws.addTimer(5, "B");
    expect(ws.cancelTimer(b.id)).toBe(true);
    expect(ws.cancelTimer(b.id)).toBe(false);
    expect(ws.cancelTimer("tmr_nope")).toBe(false);
    advance(MIN);
    ws.tick();
    expect(ws.cancelTimer(a.id)).toBe(false);
  });

  it("clearFinished drops done timers", () => {
    const { ws, advance } = setup();
    ws.addTimer(1, "A");
    ws.addTimer(5, "B");
    advance(MIN);
    ws.tick();
    ws.clearFinished();
    expect(ws.getState().timers.map((x) => x.label)).toEqual(["B"]);
  });
});

describe("persistence and subscriptions", () => {
  it("persists every change as a new immutable state and notifies listeners", () => {
    const { ws, saved } = setup();
    const seen: WorkspaceState[] = [];
    const off = ws.subscribe((s) => seen.push(s));
    const before = ws.getState();
    ws.addTask("Buy milk");
    const after = ws.getState();
    expect(after).not.toBe(before);
    expect(before.tasks).toHaveLength(0);
    expect(saved[saved.length - 1]).toBe(after);
    expect(seen).toEqual([after]);
    off();
    ws.addNote("n", "b");
    expect(seen).toHaveLength(1);
    expect(saved).toHaveLength(2);
  });

  it("does not persist when nothing changed", () => {
    const { ws, saved } = setup();
    ws.tick();
    ws.dueCheckIns();
    ws.clearFinished();
    expect(ws.completeTask("tsk_missing")).toBe(false);
    expect(ws.forget("mem_missing")).toBe(false);
    expect(ws.deleteNote("note_missing")).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it("restores from an initial state and ignores malformed input", () => {
    const initial = {
      timers: [{ id: "tmr_x", label: "X", endsAt: 1, durationMs: 1, done: true }],
      tasks: [{ id: "tsk_x", text: "T", done: false, createdAt: 1 }, "junk"],
      notes: "nope",
    };
    const ws = createWorkspace({ now: () => 0, persist: () => {}, initial });
    expect(ws.getState().timers).toHaveLength(1);
    expect(ws.getState().tasks).toHaveLength(1);
    expect(ws.getState().notes).toEqual([]);
    expect(ws.getState().memories).toEqual([]);
    expect(createWorkspace({ initial: null }).getState()).toEqual({ timers: [], tasks: [], notes: [], memories: [] });
  });
});

describe("tasks", () => {
  it("adds, completes and lists tasks", () => {
    const { ws } = setup();
    const a = ws.addTask("Buy milk");
    ws.addTask("Call mom");
    expect(a).toMatchObject({ text: "Buy milk", done: false });
    expect(a.id).toMatch(/^tsk_/);
    expect(ws.completeTask(a.id)).toBe(true);
    expect(ws.completeTask("tsk_nope")).toBe(false);
    expect(ws.listTasks().map((x) => x.text)).toEqual(["Call mom"]);
    expect(ws.listTasks(true).map((x) => [x.text, x.done])).toEqual([
      ["Buy milk", true],
      ["Call mom", false],
    ]);
  });
});

describe("notes", () => {
  it("keeps notes newest first and deletes them", () => {
    const { ws, advance } = setup();
    const a = ws.addNote("Groceries", "eggs, milk");
    advance(1000);
    ws.addNote("Ideas", "VR garden");
    expect(a.id).toMatch(/^note_/);
    expect(ws.getState().notes.map((n) => n.title)).toEqual(["Ideas", "Groceries"]);
    expect(ws.deleteNote(a.id)).toBe(true);
    expect(ws.getState().notes.map((n) => n.title)).toEqual(["Ideas"]);
  });

  it("searches title or body case-insensitively; empty query returns all", () => {
    const { ws, advance } = setup();
    ws.addNote("Groceries", "Eggs and MILK");
    advance(1000);
    ws.addNote("Milkshake recipe", "banana");
    advance(1000);
    ws.addNote("Other", "nothing");
    expect(ws.searchNotes("milk").map((n) => n.title)).toEqual(["Milkshake recipe", "Groceries"]);
    expect(ws.searchNotes("BANANA").map((n) => n.title)).toEqual(["Milkshake recipe"]);
    expect(ws.searchNotes("")).toHaveLength(3);
    expect(ws.searchNotes("   ")).toHaveLength(3);
    expect(ws.searchNotes("zzz")).toEqual([]);
  });

  it("returns the newest 10 with bodies cut to 2000 characters", () => {
    const { ws, advance } = setup();
    for (let i = 0; i < 12; i++) {
      ws.addNote(`Note ${i}`, "x".repeat(2500));
      advance(1000);
    }
    const found = ws.searchNotes("");
    expect(found).toHaveLength(10);
    expect(found[0].title).toBe("Note 11");
    expect(found[9].title).toBe("Note 2");
    expect(found.every((n) => n.body.length === 2000)).toBe(true);
    // The stored notes keep their full bodies.
    expect(ws.getState().notes[0].body).toHaveLength(2500);
  });
});

describe("memories", () => {
  it("remembers, forgets and keeps only the last 50", () => {
    const { ws } = setup();
    const first = ws.remember("Likes green tea");
    expect(first.id).toMatch(/^mem_/);
    for (let i = 0; i < 55; i++) ws.remember(`fact ${i}`);
    const mems = ws.getState().memories;
    expect(mems).toHaveLength(50);
    expect(mems[0].fact).toBe("fact 5");
    expect(mems[49].fact).toBe("fact 54");
    expect(ws.forget(first.id)).toBe(false); // already dropped
    expect(ws.forget(mems[0].id)).toBe(true);
    expect(ws.getState().memories).toHaveLength(49);
  });
});

describe("dates and nextOccurrence", () => {
  it("validates real calendar dates", () => {
    expect(isValidDate("2026-02-28")).toBe(true);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-04-31")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-00-10")).toBe(false);
    expect(isValidDate("2026-1-5")).toBe(false);
    expect(isValidDate("tomorrow")).toBe(false);
  });

  it("finds today's time when it is still ahead, otherwise tomorrow", () => {
    const now = new Date(2026, 5, 15, 9, 0);
    expect(nextOccurrence(now, "17:30").getTime()).toBe(at(2026, 6, 15, 17, 30));
    expect(nextOccurrence(now, "08:00").getTime()).toBe(at(2026, 6, 16, 8, 0));
    expect(nextOccurrence(now, "09:00").getTime()).toBe(at(2026, 6, 16, 9, 0)); // must be after now
  });

  it("rolls over month and year ends", () => {
    expect(nextOccurrence(new Date(2026, 11, 31, 23, 0), "07:00").getTime()).toBe(at(2027, 1, 1, 7, 0));
  });

  it("uses exactly the given local date and time", () => {
    const now = new Date(2026, 5, 15, 9, 0);
    expect(nextOccurrence(now, "08:15", "2026-07-01").getTime()).toBe(at(2026, 7, 1, 8, 15));
  });

  it("keeps the clock time across the spring-forward change", () => {
    // US DST begins Sunday 2026-03-08 at 02:00 local.
    const now = new Date(2026, 2, 7, 22, 0); // Saturday evening, EST
    const next = nextOccurrence(now, "07:00");
    expect(next.getHours()).toBe(7);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(8);
    // Only 8 real hours pass even though the clock moves 9.
    expect(next.getTime() - now.getTime()).toBe(8 * 60 * MIN);
  });
});

describe("reminders", () => {
  it("sets a one-off reminder at the next occurrence", () => {
    const { ws } = setup(at(2026, 6, 15, 9, 0));
    const r = ws.addReminder("18:00", "Call mom");
    expect(r.id).toMatch(/^rem_/);
    expect(r).toMatchObject({ label: "Call mom", at: "18:00", endsAt: at(2026, 6, 15, 18, 0), done: false });
    expect(r.daily).toBeUndefined();
    expect(r.durationMs).toBe(9 * 60 * MIN);
  });

  it("sets a dated reminder exactly then", () => {
    const { ws } = setup(at(2026, 6, 15, 9, 0));
    const r = ws.addReminder("07:45", "Dentist", { date: "2026-06-20" });
    expect(r.endsAt).toBe(at(2026, 6, 20, 7, 45));
  });

  it("rejects dates that aren't real", () => {
    const { ws } = setup();
    expect(() => ws.addReminder("09:00", "X", { date: "2026-02-30" })).toThrow("2026-02-30 isn't a real calendar date.");
    expect(() => ws.addReminder("09:00", "X", { date: "2026-02-30" })).toThrowError(
      new Error("2026-02-30 isn't a real calendar date."),
    );
  });

  it("rejects dates and times that have passed", () => {
    const { ws } = setup(at(2026, 6, 15, 9, 0));
    expect(() => ws.addReminder("08:00", "X", { date: "2026-06-15" })).toThrowError(
      new Error("That date and time has already passed."),
    );
    expect(() => ws.addReminder("09:00", "X", { date: "2026-06-15" })).toThrow("That date and time has already passed.");
    expect(() => ws.addReminder("12:00", "X", { date: "2025-01-01" })).toThrow("That date and time has already passed.");
  });

  it("re-arms a daily reminder for the next day and marks one-offs done", () => {
    const { ws, set } = setup(at(2026, 6, 15, 9, 0));
    const daily = ws.addReminder("10:00", "Stretch", { daily: true });
    ws.addReminder("10:00", "Once");
    expect(daily.daily).toBe(true);
    set(at(2026, 6, 15, 10, 0));
    const fired = ws.tick();
    expect(fired.map((x) => x.label).sort()).toEqual(["Once", "Stretch"]);
    const running = ws.listRunning();
    expect(running.map((x) => x.label)).toEqual(["Stretch"]);
    expect(running[0].endsAt).toBe(at(2026, 6, 16, 10, 0));
    expect(ws.tick()).toEqual([]);
  });

  it("a daily reminder missed for days fires once and re-arms after now", () => {
    const { ws, set } = setup(at(2026, 6, 15, 9, 0));
    ws.addReminder("10:00", "Stretch", { daily: true });
    set(at(2026, 6, 18, 14, 0));
    expect(ws.tick()).toHaveLength(1);
    expect(ws.listRunning()[0].endsAt).toBe(at(2026, 6, 19, 10, 0));
  });

  it("a daily reminder keeps its clock time across the fall-back change", () => {
    // US DST ends Sunday 2026-11-01 at 02:00 local.
    const { ws, set } = setup(at(2026, 10, 31, 6, 0));
    ws.addReminder("07:00", "Vitamins", { daily: true });
    set(at(2026, 10, 31, 7, 0));
    expect(ws.tick()).toHaveLength(1);
    const next = ws.listRunning()[0].endsAt;
    expect(new Date(next).getHours()).toBe(7);
    expect(new Date(next).getDate()).toBe(1);
    expect(next - at(2026, 10, 31, 7, 0)).toBe(25 * 60 * MIN);
  });
});

describe("focus sessions", () => {
  it("labels sessions and records the break", () => {
    const { ws } = setup();
    const a = ws.startFocus(25, "essay");
    const b = ws.startFocus(25);
    const c = ws.startFocus(50, "  ", 10);
    expect(a.id).toMatch(/^fcs_/);
    expect(a.label).toBe("Focus: essay");
    expect(a.focus).toEqual({ task: "essay", breakMinutes: 5 });
    expect(b.label).toBe("Focus");
    expect(b.focus).toEqual({ breakMinutes: 5 });
    expect(c.label).toBe("Focus");
    expect(c.focus?.breakMinutes).toBe(10);
  });

  it("checks in once past halfway", () => {
    const { ws, advance } = setup();
    const s = ws.startFocus(20, "reading");
    ws.addTimer(5, "plain timer");
    advance(9 * MIN);
    expect(ws.dueCheckIns()).toEqual([]);
    advance(MIN);
    const due = ws.dueCheckIns();
    expect(due.map((x) => x.id)).toEqual([s.id]);
    expect(ws.getState().timers.find((x) => x.id === s.id)?.focus?.checkedIn).toBe(true);
    advance(MIN);
    expect(ws.dueCheckIns()).toEqual([]);
    advance(10 * MIN);
    expect(ws.tick().map((x) => x.label)).toEqual(["plain timer", "Focus: reading"]);
  });

  it("does not check in on a session that already ended", () => {
    const { ws, advance } = setup();
    ws.startFocus(10);
    advance(30 * MIN);
    expect(ws.dueCheckIns()).toEqual([]);
    expect(ws.tick()).toHaveLength(1);
  });
});
