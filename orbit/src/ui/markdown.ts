// A small, safe Markdown renderer (§2). All HTML in the source is escaped;
// the only tags produced are the ones below. Links render only for https:.

type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "para"; lines: string[] }
  | { kind: "heading"; text: string }
  | { kind: "rule" };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]*)/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const ORDERED = /^[ \t]*(\d{1,9})[.)][ \t]+(.*)$/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BLANK = /^[ \t]*$/;
const INDENTED = /^[ \t]+\S/;

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] | null = null;
  let list: Extract<Block, { kind: "list" }> | null = null;
  const flush = () => {
    if (para) blocks.push({ kind: "para", lines: para });
    if (list) blocks.push(list);
    para = null;
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const body: string[] = [];
      // An unclosed fence runs to the end of the text.
      for (i++; i < lines.length; i++) {
        const close = FENCE_CLOSE.exec(lines[i]);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
        body.push(lines[i]);
      }
      blocks.push({ kind: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }

    if (BLANK.test(line)) {
      flush();
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      if (para) {
        blocks.push({ kind: "para", lines: para });
        para = null;
      }
      const isOrdered = ordered !== null;
      const text = bullet ? bullet[1] : ordered![2];
      if (list && list.ordered === isOrdered) {
        list.items.push(text);
      } else {
        if (list) blocks.push(list);
        list = { kind: "list", ordered: isOrdered, start: ordered ? Number(ordered[1]) : 1, items: [text] };
      }
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", text: heading[1] });
      continue;
    }

    if (list && INDENTED.test(line)) {
      const items: string[] = (list as Extract<Block, { kind: "list" }>).items;
      items[items.length - 1] += "\n" + line.trim();
      continue;
    }

    if (list) {
      blocks.push(list);
      list = null;
    }
    (para ??= []).push(line.trim());
  }
  flush();
  return blocks;
}

// ---- Inline ------------------------------------------------------------------

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** True only for an absolute https: URL. */
export function isSafeLink(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

const CODE_SPAN = /(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
const LINK = /\[([^\]\n]+)\]\(\s*<?([^\s()<>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
const SLOT = /\u0000(\d+)\u0000/g;

interface Emphasis {
  bold: (inner: string) => string;
  italic: (inner: string) => string;
}

function applyEmphasis(s: string, e: Emphasis): string {
  return s
    .replace(/\*\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*\*/g, (_, x: string) => e.bold(e.italic(x)))
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_, x: string) => e.bold(x))
    .replace(/__(?=\S)([\s\S]*?\S)__/g, (_, x: string) => e.bold(x))
    .replace(/\*(?![\s*])([^*\n]*?[^\s*])\*/g, (_, x: string) => e.italic(x))
    .replace(/(^|[^\w])_(?![\s_])([^_\n]*?[^\s_])_(?!\w)/g, (_, pre: string, x: string) => pre + e.italic(x));
}

const HTML_EMPHASIS: Emphasis = { bold: (x) => `<strong>${x}</strong>`, italic: (x) => `<em>${x}</em>` };
const PLAIN_EMPHASIS: Emphasis = { bold: (x) => x, italic: (x) => x };

function trimCode(code: string): string {
  return code.replace(/\n/g, " ").trim();
}

/**
 * Shared inline pass: code spans and links are lifted into slots first so
 * their contents are never touched by emphasis, then the rest is formatted.
 */
function inline(raw: string, html: boolean): string {
  const slots: string[] = [];
  const hold = (out: string) => `\u0000${slots.push(out) - 1}\u0000`;
  const esc = html ? escapeHtml : (s: string) => s;
  const emphasis = html ? HTML_EMPHASIS : PLAIN_EMPHASIS;

  let s = raw.replace(/\u0000/g, "");
  s = s.replace(CODE_SPAN, (_, _ticks: string, code: string) =>
    hold(html ? `<code>${escapeHtml(trimCode(code))}</code>` : trimCode(code)),
  );
  s = s.replace(LINK, (_, label: string, url: string) => {
    const text = applyEmphasis(esc(label), emphasis);
    if (html && isSafeLink(url)) {
      return hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`);
    }
    return hold(text);
  });
  s = applyEmphasis(esc(s), emphasis);
  // Slots can nest (a code span inside a link label), so restore until none remain.
  for (let guard = 0; guard < 4 && s.includes("\u0000"); guard++) {
    s = s.replace(SLOT, (_, n: string) => slots[Number(n)] ?? "");
  }
  return s;
}

// ---- Public API ----------------------------------------------------------------

/** Markdown → safe HTML: paragraphs, bold/italic, - and 1. lists, inline and fenced code, https links. */
export function renderMarkdown(md: string): string {
  return parseBlocks(md)
    .map((b) => {
      switch (b.kind) {
        case "code": {
          const cls = b.lang ? ` class="language-${escapeHtml(b.lang)}"` : "";
          return `<pre><code${cls}>${escapeHtml(b.text)}</code></pre>`;
        }
        case "list": {
          const items = b.items.map((it) => `<li>${inline(it, true).replace(/\n/g, "<br>")}</li>`).join("");
          if (!b.ordered) return `<ul>${items}</ul>`;
          return b.start !== 1 ? `<ol start="${b.start}">${items}</ol>` : `<ol>${items}</ol>`;
        }
        case "heading":
          return `<p><strong>${inline(b.text, true)}</strong></p>`;
        case "rule":
          return "<hr>";
        case "para":
          return `<p>${b.lines.map((l) => inline(l, true)).join("<br>")}</p>`;
      }
    })
    .join("");
}

/** Markdown → plain text for the VR panel: markers removed, list items as "- " lines, code kept as text. */
export function markdownToPlain(md: string): string {
  return parseBlocks(md)
    .map((b) => {
      switch (b.kind) {
        case "code":
          return b.text;
        case "list":
          return b.items.map((it) => `- ${inline(it, false).replace(/\n/g, "\n  ")}`).join("\n");
        case "heading":
          return inline(b.text, false);
        case "rule":
          return "";
        case "para":
          return b.lines.map((l) => inline(l, false)).join("\n");
      }
    })
    .filter((s) => s !== "")
    .join("\n\n");
}
