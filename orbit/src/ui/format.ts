// Small display formatters for the side panel (§6.4).

import { localDateKey } from "../core/bond";

/** "7:00 PM", or "Tue 7:00 PM" when it isn't today, plus " ↻" for daily reminders. */
export function formatReminder(endsAt: number, now: number, daily = false, locale?: string): string {
  const due = new Date(endsAt);
  const time = due.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const sameDay = localDateKey(due) === localDateKey(new Date(now));
  const day = sameDay ? "" : `${due.toLocaleDateString(locale, { weekday: "short" })} `;
  return `${day}${time}${daily ? " ↻" : ""}`;
}

/** "Jun 15" style date for note cards. */
export function formatNoteDate(createdAt: number, locale?: string): string {
  return new Date(createdAt).toLocaleDateString(locale, { month: "short", day: "numeric" });
}
