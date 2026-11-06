// Audio tags (§5.7): the expressive voice reads tags like [giggles]; every
// display strips them, but never inside code.

export const AUDIO_TAGS: readonly string[] = [
  "giggles",
  "giggling",
  "laughs",
  "laughing",
  "chuckles",
  "sighs",
  "whispers",
  "whispering",
  "excited",
  "curious",
  "playfully",
  "teasing",
  "mischievously",
  "softly",
  "happily",
  "gasps",
  "surprised",
  "sarcastic",
  "shy",
  "nervous",
  "hums",
  "yawns",
  "pause",
  "short pause",
  "long pause",
  "clears throat",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `[tag]` not followed by `(` or `[` (so links stay intact), plus one trailing space or tab. */
export const AUDIO_TAG_RE = new RegExp(`\\[(?:${AUDIO_TAGS.map(escapeRe).join("|")})\\](?![([])[ \\t]?`, "gi");

interface Segment {
  code: boolean;
  text: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/;

/** Splits into code (fenced blocks, including an unclosed one, and inline spans) and prose. */
export function splitCode(text: string): Segment[] {
  const out: Segment[] = [];
  const push = (code: boolean, t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.code === code) last.text += t;
    else out.push({ code, text: t });
  };

  const lines = text.split(/(?<=\n)/);
  let fence: string | null = null;
  let prose = "";
  for (const line of lines) {
    if (fence) {
      push(true, line);
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      splitInline(prose, push);
      prose = "";
      fence = open[1];
      push(true, line);
    } else {
      prose += line;
    }
  }
  splitInline(prose, push);
  return out;
}

function splitInline(text: string, push: (code: boolean, t: string) => void): void {
  let i = 0;
  let start = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let n = 0;
    while (text[i + n] === "`") n++;
    // Look for a closing run of exactly n backticks.
    let j = i + n;
    let close = -1;
    while (j < text.length) {
      if (text[j] === "`") {
        let m = 0;
        while (text[j + m] === "`") m++;
        if (m === n) {
          close = j;
          break;
        }
        j += m;
      } else {
        j++;
      }
    }
    if (close < 0) {
      i += n; // unmatched backticks are literal text
      continue;
    }
    push(false, text.slice(start, i));
    push(true, text.slice(i, close + n));
    i = close + n;
    start = i;
  }
  push(false, text.slice(start));
}

/** Removes recognised audio tags everywhere except inside code. */
export function stripAudioTags(text: string): string {
  return splitCode(text)
    .map((s) => (s.code ? s.text : s.text.replace(AUDIO_TAG_RE, "")))
    .join("");
}
