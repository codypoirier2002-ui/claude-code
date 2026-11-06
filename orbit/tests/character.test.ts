// @vitest-environment happy-dom
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/core/assistant";
import { Blinker, type Mood, type RandomSource } from "../src/core/avatarMotion";
import { BLINK_THRESHOLD, FaceRig, type FaceState } from "../src/core/faceRig";
import { DEFAULT_ASSISTANT_NAME, DEFAULT_SETTINGS, assistantName } from "../src/core/settings";

// ---- Helpers -------------------------------------------------------------------------

/** A seeded random source (mulberry32), so the random-looking tests repeat exactly. */
function seeded(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Input {
  mood: Mood;
  level?: number;
  text?: string;
}

/**
 * Runs the rig for `seconds` at `fps` and returns every frame's state. `input` may change with
 * the time in seconds since this call began.
 */
function drive(rig: FaceRig, seconds: number, fps: number, input: Input | ((t: number) => Input)): FaceState[] {
  const dt = 1 / fps;
  const frames = Math.round(seconds * fps);
  const out: FaceState[] = [];
  for (let i = 1; i <= frames; i++) {
    const now = typeof input === "function" ? input(i * dt) : input;
    out.push(rig.update(dt, now.mood, now.level ?? 0, now.text ?? ""));
  }
  return out;
}

function last<T>(items: readonly T[]): T {
  return items[items.length - 1];
}

/**
 * A rig whose first blink comes at about 4 s, so a test shorter than that sees no blink
 * and a longer one still gets a deterministic rig.
 */
function quiet(): FaceRig {
  return new FaceRig(() => 0.9999);
}

/** The state `seconds` into a run of frames at `fps`. */
function at(frames: readonly FaceState[], seconds: number, fps = 60): FaceState {
  return frames[Math.round(seconds * fps) - 1];
}

// ---- The art -------------------------------------------------------------------------

const characterDir = resolve(__dirname, "../public/character");
const LAYERS = ["base", "blink", "smile", "talk", "think", "wow"] as const;
const FILES = [...LAYERS, "face"] as const;

/** Width and height from a WebP header (VP8X, VP8L or lossy VP8). */
function webpSize(file: Uint8Array): { width: number; height: number } {
  const text = (from: number, to: number) => String.fromCharCode(...file.subarray(from, to));
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  expect(text(0, 4)).toBe("RIFF");
  expect(text(8, 12)).toBe("WEBP");
  const kind = text(12, 16);
  if (kind === "VP8X") {
    const u24 = (pos: number) => file[pos] | (file[pos + 1] << 8) | (file[pos + 2] << 16);
    return { width: 1 + u24(24), height: 1 + u24(27) };
  }
  if (kind === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
}

describe("the character art", () => {
  it("has the seven WebP files", () => {
    for (const name of FILES) {
      const file = resolve(characterDir, `${name}.webp`);
      expect(existsSync(file), `${name}.webp exists`).toBe(true);
      expect(statSync(file).size, `${name}.webp is not empty`).toBeGreaterThan(1000);
    }
    expect(FILES).toHaveLength(7);
  });

  it("makes every file a real WebP", () => {
    for (const name of FILES) {
      const file = readFileSync(resolve(characterDir, `${name}.webp`));
      const { width, height } = webpSize(file);
      expect(width, `${name} width`).toBeGreaterThan(0);
      expect(height, `${name} height`).toBeGreaterThan(0);
    }
  });

  it("sizes the base and the five patches at 768x1024 and the face at 160x160", () => {
    for (const name of LAYERS) {
      expect(webpSize(readFileSync(resolve(characterDir, `${name}.webp`))), name).toEqual({ width: 768, height: 1024 });
    }
    expect(webpSize(readFileSync(resolve(characterDir, "face.webp")))).toEqual({ width: 160, height: 160 });
  });
});

// ---- Her name ------------------------------------------------------------------------

describe("assistantName", () => {
  it("defaults to Callie", () => {
    expect(DEFAULT_ASSISTANT_NAME).toBe("Callie");
    expect(DEFAULT_SETTINGS.assistantName).toBe("Callie");
    expect(assistantName(DEFAULT_SETTINGS)).toBe("Callie");
  });

  it("keeps an ordinary name as it is", () => {
    expect(assistantName({ assistantName: "Nova" })).toBe("Nova");
    expect(assistantName({ assistantName: "Zoë-2 O'Neil" })).toBe("Zoë-2 O'Neil");
  });

  it("strips < > [ ] { } double quotes and backticks", () => {
    for (const ch of ["<", ">", "[", "]", "{", "}", '"', "`"]) {
      expect(assistantName({ assistantName: `No${ch}va` }), JSON.stringify(ch)).toBe("Nova");
    }
    expect(assistantName({ assistantName: 'Ni<>[]{}"`va' })).toBe("Niva");
  });

  it("collapses whitespace and trims", () => {
    expect(assistantName({ assistantName: "  Nova   Prime \t\n x  " })).toBe("Nova Prime x");
  });

  it("keeps 24 characters", () => {
    const long = "abcdefghijklmnopqrstuvwxyz";
    expect(assistantName({ assistantName: long })).toBe("abcdefghijklmnopqrstuvwx");
    expect(assistantName({ assistantName: long }).length).toBe(24);
    expect(assistantName({ assistantName: "a".repeat(24) })).toBe("a".repeat(24));
    // Forbidden characters are stripped before the cut, so they do not use up the 24.
    expect(assistantName({ assistantName: "<<<" + "a".repeat(30) })).toBe("a".repeat(24));
  });

  it("falls back to Callie when nothing is left", () => {
    expect(assistantName({ assistantName: "" })).toBe("Callie");
    expect(assistantName({ assistantName: "   " })).toBe("Callie");
    expect(assistantName({ assistantName: "<>[]{}\"`" })).toBe("Callie");
    expect(assistantName({ assistantName: undefined as unknown as string })).toBe("Callie");
    expect(assistantName({ assistantName: 42 as unknown as string })).toBe("Callie");
  });
});

describe("the system prompt names her", () => {
  const now = new Date(2026, 10, 6);
  const firstLine = (name: string) =>
    buildSystemPrompt({
      settings: { ...DEFAULT_SETTINGS, assistantName: name },
      modeId: "everyday",
      conversations: 0,
      memories: [],
      now,
    }).split("\n")[0];

  it("opens with Callie by default", () => {
    const line = firstLine(DEFAULT_SETTINGS.assistantName);
    expect(line.startsWith("You are Callie, the AI assistant inside Orbit")).toBe(true);
    expect(line).toContain("Orbit is the app; Callie is you.");
  });

  it("uses the name from the settings, cleaned the same way", () => {
    const line = firstLine("  Nova  ");
    expect(line).toContain("You are Nova, the AI assistant inside Orbit");
    expect(line).toContain("Orbit is the app; Nova is you.");
    expect(line).not.toContain("Callie");
  });

  it("cannot be talked out of the sentence by the characters it strips", () => {
    expect(firstLine('Ev"il<>[]{}`')).toContain("You are Evil, the AI assistant inside Orbit");
  });

  it("falls back to Callie for an empty name", () => {
    expect(firstLine("")).toContain("You are Callie, the AI assistant inside Orbit");
    expect(firstLine("<>")).toContain("Orbit is the app; Callie is you.");
  });

  it("puts the name in the very first line of the prompt", () => {
    const prompt = buildSystemPrompt({
      settings: { ...DEFAULT_SETTINGS, assistantName: "Nova" },
      modeId: "everyday",
      conversations: 0,
      memories: [],
      now,
    });
    expect(prompt.split("\n")[0]).toContain("Nova");
    expect(prompt.indexOf("Nova")).toBeLessThan(prompt.indexOf("\n"));
  });
});

// ---- FaceRig -------------------------------------------------------------------------

describe("FaceRig", () => {
  it("starts with everything at rest", () => {
    const first = quiet().update(0, "idle", 0, "");
    for (const [key, value] of Object.entries(first)) expect(value, key).toBeCloseTo(0, 12);
  });

  describe("thinking", () => {
    it("raises the think layer while she thinks and eases it away afterwards", () => {
      const rig = quiet();
      const thinking = drive(rig, 1.5, 60, { mood: "thinking" });
      expect(at(thinking, 0.5).think).toBeGreaterThan(0.9); // 1 - e^-2.5 = 0.918
      expect(at(thinking, 1).think).toBeGreaterThan(0.99); // 1 - e^-5 = 0.993
      for (let i = 1; i < thinking.length; i++) expect(thinking[i].think).toBeGreaterThanOrEqual(thinking[i - 1].think);
      const after = drive(rig, 1, 60, { mood: "idle" });
      expect(last(after).think).toBeLessThan(0.01);
      for (let i = 1; i < after.length; i++) expect(after[i].think).toBeLessThanOrEqual(after[i - 1].think);
    });

    it("does not raise it while she is anything else", () => {
      for (const mood of ["idle", "listening", "speaking"] as const) {
        const frames = drive(quiet(), 1, 60, { mood });
        for (const f of frames) expect(f.think, mood).toBe(0);
      }
    });

    it("glances back now and then: the layer dips while sin(0.9t) is under -0.6", () => {
      // sin(0.9t) < -0.6 from t = 4.21 s to t = 6.27 s.
      const frames = drive(quiet(), 7.2, 60, { mood: "thinking" });
      expect(at(frames, 4).think).toBeGreaterThan(0.99);
      expect(at(frames, 5.5).think).toBeLessThan(0.01);
      expect(at(frames, 6).think).toBeLessThan(0.01);
      expect(at(frames, 7.2).think).toBeGreaterThan(0.97);
    });

    it("fades under the mouth: think = think without a mouth x (1 - talk)", () => {
      const talking = quiet();
      const silent = quiet();
      drive(talking, 1.5, 60, { mood: "thinking" });
      drive(silent, 1.5, 60, { mood: "thinking" });
      const a = drive(talking, 0.5, 60, { mood: "speaking", level: 0.8 });
      const b = drive(silent, 0.5, 60, { mood: "speaking", level: 0 });
      a.forEach((f, i) => expect(f.think).toBeCloseTo(b[i].think * (1 - f.talk), 12));
      expect(a[10].talk).toBeGreaterThan(0.3); // the mouth really opened
      expect(b[10].think).toBeGreaterThan(0.01); // and there was a think layer to fade
    });
  });

  describe("smile", () => {
    it("shrinks the mouth under it: talk = talk without a smile x (1 - 0.6 smile)", () => {
      const plain = quiet();
      const cheering = quiet();
      cheering.cheer();
      const a = drive(plain, 1, 60, { mood: "speaking", level: 0.8 });
      const b = drive(cheering, 1, 60, { mood: "speaking", level: 0.8 });
      a.forEach((f) => expect(f.smile).toBe(0));
      b.forEach((f, i) => expect(f.talk).toBeCloseTo(a[i].talk * (1 - 0.6 * f.smile), 12));
      expect(last(b).smile).toBeGreaterThan(0.99);
      expect(last(b).talk).toBeLessThan(last(a).talk * 0.5);
    });

    it("smiles at a laugh in the words", () => {
      for (const text of ["haha", "That was funny, lol", "[giggles] oh dear"]) {
        const frames = drive(quiet(), 1, 60, { mood: "speaking", text });
        expect(last(frames).smile, text).toBeGreaterThan(0.99);
      }
      // Neither plain words, an exclamation mark (happy 0.4) nor a wow word is a laugh (over 0.5).
      for (const text of ["", "Sure thing.", "Great!", "wow"]) {
        const frames = drive(quiet(), 1, 60, { mood: "speaking", text });
        expect(Math.max(...frames.map((f) => f.smile)), text).toBe(0);
      }
    });

    it("gives way to the wow face: smile = smile without a wow x (1 - wow)", () => {
      const plain = quiet();
      const excited = quiet();
      const a = drive(plain, 1, 60, { mood: "idle", text: "haha" });
      const b = drive(excited, 1, 60, { mood: "idle", text: "haha!" });
      b.forEach((f, i) => expect(f.smile).toBeCloseTo(a[i].smile * (1 - f.wow), 12));
      expect(at(b, 0.4).wow).toBeGreaterThan(0.9); // the wow really showed
      expect(at(b, 0.4).smile).toBeLessThan(at(a, 0.4).smile * 0.2);
    });
  });

  describe("wow", () => {
    it("fires on a new exclamation mark, holds for 0.9 s and fades", () => {
      const rig = quiet();
      const before = drive(rig, 0.5, 60, { mood: "speaking", text: "Hello there" });
      for (const f of before) expect(f.wow).toBe(0);
      const frames = drive(rig, 2.5, 60, { mood: "speaking", text: "Hello there!" });
      expect(frames[0].wow).toBeGreaterThan(0.1); // 1 - e^-0.15 on the first frame
      expect(at(frames, 0.35).wow).toBeGreaterThan(0.9); // 1 - e^-3.15
      expect(at(frames, 0.85).wow).toBeGreaterThan(0.99); // still held at 0.85 s
      expect(at(frames, 1.8).wow).toBeLessThan(0.01);
      expect(last(frames).wow).toBeLessThan(0.001);
    });

    it("does not fire again for the same text", () => {
      const rig = quiet();
      drive(rig, 3, 60, { mood: "idle", text: "Great!" });
      const again = drive(rig, 2, 60, { mood: "idle", text: "Great!" });
      expect(Math.max(...again.map((f) => f.wow))).toBeLessThan(0.001);
    });

    it("fires again for another exclamation mark", () => {
      const rig = quiet();
      drive(rig, 3, 60, { mood: "idle", text: "Great!" });
      const next = drive(rig, 1, 60, { mood: "idle", text: "Great! Nice!" });
      expect(at(next, 0.4).wow).toBeGreaterThan(0.9);
    });

    it("does not fire when the text only gets shorter", () => {
      const rig = quiet();
      drive(rig, 3, 60, { mood: "idle", text: "Great! Nice!" });
      const shorter = drive(rig, 2, 60, { mood: "idle", text: "Great!" });
      expect(Math.max(...shorter.map((f) => f.wow))).toBeLessThan(0.001);
    });

    it("counts the first exclamation mark of a new message", () => {
      const rig = quiet();
      drive(rig, 3, 60, { mood: "idle", text: "Hi!" });
      drive(rig, 0.5, 60, { mood: "idle", text: "" }); // the next message starts empty
      const next = drive(rig, 1, 60, { mood: "idle", text: "Hi!" });
      expect(at(next, 0.4).wow).toBeGreaterThan(0.9);
    });

    it("fires on a wow word without any exclamation mark, once", () => {
      const rig = quiet();
      drive(rig, 0.5, 60, { mood: "idle", text: "that is" });
      const said = drive(rig, 1, 60, { mood: "idle", text: "that is wow" });
      expect(at(said, 0.4).wow).toBeGreaterThan(0.9);
      drive(rig, 2.5, 60, { mood: "idle", text: "that is wow" });
      const more = drive(rig, 1, 60, { mood: "idle", text: "that is wow wow" }); // same score: nothing new
      expect(Math.max(...more.map((f) => f.wow))).toBeLessThan(0.001);
    });

    it("does not fire on a wow word that is outside the last 160 characters", () => {
      const text = "wow " + "blah ".repeat(40); // 204 characters, the wow at the very start
      const frames = drive(quiet(), 1, 60, { mood: "idle", text });
      expect(Math.max(...frames.map((f) => f.wow))).toBe(0);
    });
  });

  describe("cheer", () => {
    it("smiles for 1.6 s and then lets go", () => {
      const rig = quiet();
      rig.cheer();
      const frames = drive(rig, 3, 60, { mood: "idle" });
      expect(at(frames, 0.5).smile).toBeGreaterThan(0.9); // 1 - e^-3 = 0.95
      expect(at(frames, 1.55).smile).toBeGreaterThan(0.99);
      expect(at(frames, 2.8).smile).toBeLessThan(0.01);
      for (let i = 98; i < frames.length; i++) expect(frames[i].smile).toBeLessThanOrEqual(frames[i - 1].smile);
    });

    it("does nothing until it is called", () => {
      const frames = drive(quiet(), 2, 60, { mood: "idle" });
      for (const f of frames) {
        expect(f.smile).toBe(0);
        expect(f.hop).toBe(0);
      }
    });

    it("hops once, 0 -> 1 -> 0 over 0.45 s, as sin(pi x elapsed / 0.45)", () => {
      const rig = quiet();
      rig.cheer();
      const frames = drive(rig, 1, 60, { mood: "idle" });
      for (let k = 1; k <= 26; k++) {
        expect(frames[k - 1].hop, `frame ${k}`).toBeCloseTo(Math.sin((Math.PI * (k / 60)) / 0.45), 9);
      }
      for (let k = 29; k <= 60; k++) expect(frames[k - 1].hop, `frame ${k}`).toBe(0);
      expect(Math.max(...frames.map((f) => f.hop))).toBeGreaterThan(0.99);
      expect(Math.min(...frames.map((f) => f.hop))).toBeGreaterThanOrEqual(0);
    });

    it("lets a hop under way finish, and hops again on a later cheer", () => {
      const rig = quiet();
      rig.cheer();
      drive(rig, 0.2, 60, { mood: "idle" });
      rig.cheer(); // 0.25 s of the first hop is left
      const rest = drive(rig, 0.5, 60, { mood: "idle" });
      expect(rest[5].hop).toBeGreaterThan(0.5); // still in the first hop
      expect(at(rest, 0.3).hop).toBe(0); // it ended at 0.45 s, not 0.45 s after the second cheer
      rig.cheer();
      const again = drive(rig, 0.3, 60, { mood: "idle" });
      expect(Math.max(...again.map((f) => f.hop))).toBeGreaterThan(0.9);
    });

    it("keeps smiling for 1.6 s after a second cheer", () => {
      const rig = quiet();
      rig.cheer();
      drive(rig, 1, 60, { mood: "idle" });
      rig.cheer();
      const frames = drive(rig, 1.5, 60, { mood: "idle" });
      expect(at(frames, 1.4).smile).toBeGreaterThan(0.99); // 2.4 s after the first cheer
      expect(last(drive(rig, 1.5, 60, { mood: "idle" })).smile).toBeLessThan(0.01);
    });

    it("holds her blinks while she cheers, and they carry on afterwards", () => {
      // With a random source of 0 the blinks come at 1.0 s and 1.28 s (a double), then 3.44 s and 3.72 s.
      const shut = (frames: readonly FaceState[], from: number, to: number) =>
        frames.some((f, i) => f.blink === 1 && (i + 1) / 60 > from && (i + 1) / 60 <= to);
      const calm = drive(new FaceRig(() => 0), 4, 60, { mood: "idle" });
      expect(shut(calm, 1.0, 1.2)).toBe(true);
      expect(shut(calm, 1.28, 1.5)).toBe(true);
      expect(shut(calm, 3.44, 3.9)).toBe(true);

      const rig = new FaceRig(() => 0);
      const before = drive(rig, 0.5, 60, { mood: "idle" });
      rig.cheer(); // cheering from 0.5 s to 2.1 s
      const cheered = [...before, ...drive(rig, 3.5, 60, { mood: "idle" })];
      expect(shut(cheered, 0.5, 2.1)).toBe(false);
      expect(shut(cheered, 3.44, 3.9)).toBe(true);
    });
  });

  describe("blinking", () => {
    /** Lengths in frames of each run of blink = 1 that ends inside the data. */
    function runLengths(frames: readonly FaceState[]): number[] {
      const out: number[] = [];
      let n = 0;
      for (const f of frames) {
        if (f.blink === 1) n++;
        else if (n > 0) {
          out.push(n);
          n = 0;
        }
      }
      return out;
    }

    it("is a plain 0 or 1", () => {
      const frames = drive(new FaceRig(seeded(4)), 20, 60, { mood: "idle" });
      for (const f of frames) expect(f.blink === 0 || f.blink === 1).toBe(true);
    });

    it("blinks at least once in 8 s at 60 fps, and no blink lasts more than 10 frames", () => {
      for (let seed = 1; seed <= 25; seed++) {
        const lengths = runLengths(drive(new FaceRig(seeded(seed)), 8, 60, { mood: "idle" }));
        expect(lengths.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
        for (const n of lengths) {
          expect(n, `seed ${seed}`).toBeLessThanOrEqual(10);
          expect(n, `seed ${seed}`).toBeGreaterThanOrEqual(5); // and it is shown long enough to see
        }
      }
    });

    it("shows every blink for at least 2 frames at 20 fps (the 90 ms hold)", () => {
      for (let seed = 1; seed <= 5; seed++) {
        const lengths = runLengths(drive(new FaceRig(seeded(seed)), 60, 20, { mood: "idle" }));
        expect(lengths.length, `seed ${seed}`).toBeGreaterThanOrEqual(8);
        for (const n of lengths) expect(n, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      }
    });

    it("holds a blink for 2 frames even at 12 fps, where one frame is longer than 80 ms", () => {
      for (let seed = 1; seed <= 5; seed++) {
        const lengths = runLengths(drive(new FaceRig(seeded(seed)), 60, 12, { mood: "idle" }));
        expect(lengths.length, `seed ${seed}`).toBeGreaterThanOrEqual(8);
        for (const n of lengths) expect(n, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      }
    });

    it("never skips a blink at low frame rates: the edges follow a 1 kHz reference", () => {
      const seed = 99;
      // The reference: the same blinker stepped every millisecond. The lid counts as shut above 0.3.
      const reference = new Blinker(seeded(seed));
      const truth: number[] = [];
      let was = false;
      for (let i = 1; i <= 38000; i++) {
        const on = reference.update(0.001) > BLINK_THRESHOLD;
        if (on && !was) truth.push(i * 0.001);
        was = on;
      }
      expect(truth.length).toBeGreaterThan(5);
      for (const fps of [60, 30, 20, 12]) {
        const dt = 1 / fps;
        const frames = drive(new FaceRig(seeded(seed)), 40, fps, { mood: "idle" });
        const edges: number[] = [];
        frames.forEach((f, i) => {
          if (f.blink === 1 && (i === 0 || frames[i - 1].blink === 0)) edges.push((i + 1) * dt);
        });
        expect(edges.length, `${fps} fps`).toBeGreaterThanOrEqual(truth.length);
        truth.forEach((t, k) => {
          // A frame lands inside the 0.3-and-up window within one frame of its start.
          expect(edges[k] - t, `blink ${k + 1} at ${fps} fps`).toBeGreaterThanOrEqual(-0.0015);
          expect(edges[k] - t, `blink ${k + 1} at ${fps} fps`).toBeLessThanOrEqual(dt + 0.0015);
        });
      }
    });
  });

  describe("the mouth", () => {
    it("opens only while she is speaking", () => {
      for (const mood of ["idle", "listening", "thinking"] as const) {
        const frames = drive(quiet(), 0.5, 60, { mood, level: 1 });
        for (const f of frames) expect(f.talk, mood).toBe(0);
      }
    });

    it("follows the audio level while she speaks", () => {
      const loud = drive(quiet(), 0.5, 60, { mood: "speaking", level: 0.5 });
      expect(last(loud).talk).toBeGreaterThan(0.4);
      for (const f of loud) {
        expect(f.talk).toBeGreaterThanOrEqual(0);
        expect(f.talk).toBeLessThanOrEqual(1);
      }
      const silent = drive(quiet(), 0.5, 60, { mood: "speaking", level: 0 });
      for (const f of silent) expect(f.talk).toBe(0);
      const quietish = drive(quiet(), 0.5, 60, { mood: "speaking", level: 0.03 }); // the floor
      for (const f of quietish) expect(f.talk).toBe(0);
    });

    it("clamps the level to 0-1 and reads NaN as silence", () => {
      const over = drive(quiet(), 1, 60, { mood: "speaking", level: 5 });
      const full = drive(quiet(), 1, 60, { mood: "speaking", level: 1 });
      expect(over).toEqual(full);
      for (const level of [-3, Number.NaN]) {
        for (const f of drive(quiet(), 1, 60, { mood: "speaking", level })) expect(f.talk).toBe(0);
      }
    });

    it("eases the mouth instead of snapping it", () => {
      const frames = drive(quiet(), 0.5, 60, { mood: "speaking", level: 1 });
      expect(frames[0].talk).toBeGreaterThan(0);
      expect(frames[0].talk).toBeLessThan(0.5); // one frame at rate 22 covers about 31% of the gap
    });
  });

  describe("head and body", () => {
    it("eases tilt and pitch toward the mood pose", () => {
      const first = quiet().update(1 / 60, "listening", 0);
      expect(first.tilt).toBeCloseTo(0.12 * (1 - Math.exp(-4 / 60)), 9);
      expect(first.pitch).toBeCloseTo(0.04 * (1 - Math.exp(-4 / 60)), 9);

      const listening = last(drive(quiet(), 2, 60, { mood: "listening" }));
      expect(listening.tilt).toBeCloseTo(0.12, 2);
      expect(listening.pitch).toBeCloseTo(0.04, 2);

      const thinking = last(drive(quiet(), 2, 60, { mood: "thinking" }));
      expect(thinking.tilt).toBeCloseTo(-0.06, 2);
      expect(thinking.pitch).toBeLessThan(-0.07);
      expect(thinking.pitch).toBeGreaterThan(-0.125);
    });

    it("breathes as sin(1.7 t) and sways as the mood pose says", () => {
      const idle = drive(quiet(), 5, 60, { mood: "idle" });
      idle.forEach((f, i) => {
        const t = (i + 1) / 60;
        expect(f.breath).toBeCloseTo(Math.sin(1.7 * t), 9);
        expect(f.sway).toBeCloseTo(0.025 * Math.sin(0.9 * t), 9);
      });
      const thinking = drive(quiet(), 3, 60, { mood: "thinking" });
      thinking.forEach((f, i) => expect(f.sway).toBeCloseTo(0.0125 * Math.sin(0.9 * ((i + 1) / 60)), 9));
    });

    it("breathes the same at any frame rate", () => {
      for (const fps of [30, 60, 144]) {
        expect(last(drive(quiet(), 2, fps, { mood: "idle" })).breath).toBeCloseTo(Math.sin(1.7 * 2), 9);
      }
    });
  });

  describe("the words she says", () => {
    const filler = "blah ".repeat(40); // 200 characters of nothing

    it("only reads the last 160 characters", () => {
      // A laugh followed by 200 characters has scrolled out of the tail: no smile.
      const gone = drive(quiet(), 1, 60, { mood: "idle", text: "haha " + filler });
      expect(Math.max(...gone.map((f) => f.smile))).toBe(0);
      // The same laugh at the end of the text is in it.
      const there = drive(quiet(), 1, 60, { mood: "idle", text: filler + " haha" });
      expect(last(there).smile).toBeGreaterThan(0.99);
    });

    it("lets a smile fade once the laugh scrolls out of the tail", () => {
      const rig = quiet();
      expect(last(drive(rig, 1, 60, { mood: "idle", text: "haha" })).smile).toBeGreaterThan(0.99);
      const after = drive(rig, 1, 60, { mood: "idle", text: "haha" + filler });
      expect(last(after).smile).toBeLessThan(0.01);
    });

    it("takes missing or odd text as nothing", () => {
      const rig = quiet();
      expect(() => rig.update(0.016, "idle", 0)).not.toThrow();
      expect(() => rig.update(0.016, "idle", 0, undefined)).not.toThrow();
      const odd = rig.update(0.016, "idle", 0, null as unknown as string);
      expect(odd.wow).toBe(0);
      expect(odd.smile).toBe(0);
      expect(() => rig.update(0.016, "idle", 0, 42 as unknown as string)).not.toThrow();
    });
  });

  describe("bad steps", () => {
    it("treats a NaN, negative or infinite step as no time passing", () => {
      const rig = quiet();
      drive(rig, 1, 60, { mood: "speaking", level: 0.6, text: "haha!" });
      const rest = rig.update(0, "speaking", 0.6, "haha!");
      for (const dt of [Number.NaN, -0.5, Number.POSITIVE_INFINITY]) {
        const f = rig.update(dt, "speaking", 0.6, "haha!");
        for (const [key, value] of Object.entries(f)) expect(Number.isFinite(value), `${key} after dt ${dt}`).toBe(true);
        expect(f).toEqual(rest);
      }
    });
  });

  it("returns a fresh state object every frame", () => {
    const rig = quiet();
    const a = rig.update(0.016, "idle", 0);
    const b = rig.update(0.016, "idle", 0);
    expect(a).not.toBe(b);
    a.talk = 99;
    expect(rig.update(0.016, "idle", 0).talk).toBeLessThan(1);
  });

  it("keeps every output in range through a long mixed run", () => {
    const rand = seeded(2024);
    const rig = new FaceRig(seeded(77));
    const moods: Mood[] = ["idle", "listening", "thinking", "speaking"];
    const texts = ["", "Sure, one moment.", "Haha, nice one!", "Wow!!", "oh my", "x".repeat(300), "Done! Great! Lovely!"];
    let mood: Mood = "idle";
    let text = "";
    for (let i = 0; i < 60 * 120; i++) {
      if (i % 90 === 0) {
        mood = moods[Math.floor(rand() * moods.length)];
        text = texts[Math.floor(rand() * texts.length)];
        if (rand() < 0.3) rig.cheer();
      }
      const f = rig.update(1 / 60, mood, rand(), text);
      for (const key of ["talk", "smile", "think", "wow", "hop"] as const) {
        expect(f[key], key).toBeGreaterThanOrEqual(0);
        expect(f[key], key).toBeLessThanOrEqual(1);
      }
      expect(f.blink === 0 || f.blink === 1).toBe(true);
      expect(Math.abs(f.breath)).toBeLessThanOrEqual(1);
      expect(Math.abs(f.sway)).toBeLessThanOrEqual(0.025 + 1e-12);
      expect(Math.abs(f.tilt)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(f.pitch)).toBeLessThanOrEqual(0.2);
    }
  });
});
