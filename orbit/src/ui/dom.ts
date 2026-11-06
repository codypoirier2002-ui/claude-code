// Tiny DOM helpers (§2). No UI framework.

export type Child = Node | string | number | boolean | null | undefined | readonly Child[];
export type Props = Record<string, unknown>;

/**
 * Creates an element.
 * - `class` (string or list) and `dataset` (object) are handled specially.
 * - `on*` function props become event listeners (`onClick` → "click").
 * - Strings are set as attributes; any other value is set as a property.
 * - `null`, `undefined` and `false` props and children are skipped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class" || key === "className") {
        const cls = Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value);
        if (cls) el.className = cls;
      } else if (key === "dataset") {
        if (typeof value === "object") {
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (v !== null && v !== undefined && v !== false) el.dataset[k] = String(v);
          }
        }
      } else if (key.startsWith("on") && key.length > 2 && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (typeof value === "string") {
        el.setAttribute(key, value);
      } else {
        (el as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (typeof c === "string" || typeof c === "number") el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c as Node);
  }
}

/** Removes every child. */
export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** "m:ss", or "h:mm:ss" from an hour up. Rounds up so a countdown shows 0:01 until it is done. */
export function formatRemaining(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${String(mins).padStart(2, "0")}:${secs}` : `${mins}:${secs}`;
}
