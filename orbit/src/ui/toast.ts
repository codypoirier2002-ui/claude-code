// The toast (§6.10): a centred pill 110 px from the bottom, hidden after 6 s.

import { h } from "./dom";

export const TOAST_MS = 6000;

let el: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The toast element; main.ts places it outside the layout grid. */
export function toastElement(): HTMLElement {
  if (!el) el = h("div", { class: "toast", role: "status", "aria-live": "polite", hidden: true });
  return el;
}

export function toast(message: string): void {
  const t = toastElement();
  t.textContent = message;
  t.hidden = false;
  // Restart the entry animation for back-to-back toasts.
  t.classList.remove("show");
  void t.offsetWidth;
  t.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => {
    t.classList.remove("show");
    t.hidden = true;
  }, TOAST_MS);
}
