import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AMBIENCE_TICK_MS,
  ambienceAllowed,
  ambienceGain,
  createAmbience,
  type AmbienceAudioContext,
  type AmbienceInput,
} from "../src/core/ambience";
import { ENVIRONMENTS, ambienceFile } from "../src/core/environments";

// ---- A fake Web Audio graph that records the scheduling calls ----

interface Call {
  method: string;
  args: number[];
}

class FakeParam {
  value = 1;
  calls: Call[] = [];
  setTargetAtTime(target: number, at: number, tc: number) {
    this.calls.push({ method: "setTargetAtTime", args: [target, at, tc] });
    return this;
  }
}

class FakeNode {
  connections: unknown[] = [];
  disconnected = false;
  connect(n: unknown) {
    this.connections.push(n);
    return n;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: { duration: number } | null = null;
  loop = false;
  started: number[] | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  start(when: number, offset: number) {
    this.started = [when, offset];
  }
  stop(when: number) {
    this.stoppedAt = when;
  }
}

class FakeContext {
  currentTime = 10;
  destination = new FakeNode();
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  decoded: number[] = [];
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  decodeAudioData(bytes: ArrayBuffer) {
    this.decoded.push(bytes.byteLength);
    return Promise.resolve({ duration: 30 });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(initial: Partial<AmbienceInput> = {}) {
  const ctx = new FakeContext();
  let input: AmbienceInput = { sceneId: "beach", mode: "vr", volume: 0.5, place: "vr", speaking: false, listening: false, ...initial };
  let haveContext = true;
  const fetched: string[] = [];
  let timerMs = 0;
  let cancelled = false;
  const amb = createAmbience({
    context: () => (haveContext ? (ctx as unknown as AmbienceAudioContext) : null),
    read: () => input,
    url: (id) => `/app/${ambienceFile(id)}`,
    fetchBytes: (url) => {
      fetched.push(url);
      if (url.includes("missing")) return Promise.reject(new Error("404"));
      return Promise.resolve(new ArrayBuffer(16));
    },
    every: (ms) => {
      timerMs = ms;
      return () => {
        cancelled = true;
      };
    },
    random: () => 0.5,
  });
  return {
    ctx,
    amb,
    fetched,
    set: (patch: Partial<AmbienceInput>) => (input = { ...input, ...patch }),
    setContext: (on: boolean) => (haveContext = on),
    timer: () => ({ ms: timerMs, cancelled }),
  };
}

describe("ambience rules (§8.9)", () => {
  it("has a loop file for every scene", () => {
    for (const e of ENVIRONMENTS) {
      const file = resolve(__dirname, "../public", ambienceFile(e.id));
      expect(existsSync(file), file).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(10_000);
    }
  });

  it("ducks: volume × .6, × .35 while she speaks, × .12 while she listens", () => {
    expect(ambienceGain(0.5, false, false)).toBeCloseTo(0.3, 12);
    expect(ambienceGain(0.5, true, false)).toBeCloseTo(0.105, 12);
    expect(ambienceGain(0.5, false, true)).toBeCloseTo(0.036, 12);
    expect(ambienceGain(0.5, true, true)).toBeCloseTo(0.036, 12);
    expect(ambienceGain(1, false, false)).toBeCloseTo(0.6, 12);
    expect(ambienceGain(0, false, false)).toBe(0);
    expect(ambienceGain(3, false, false)).toBeCloseTo(0.6, 12);
    expect(ambienceGain(Number.NaN, false, false)).toBe(0);
  });

  it("plays in VR for 'vr', in 2D too for 'always', never in passthrough or when off", () => {
    expect(ambienceAllowed("vr", "vr")).toBe(true);
    expect(ambienceAllowed("vr", "2d")).toBe(false);
    expect(ambienceAllowed("vr", "ar")).toBe(false);
    expect(ambienceAllowed("always", "2d")).toBe(true);
    expect(ambienceAllowed("always", "vr")).toBe(true);
    expect(ambienceAllowed("always", "ar")).toBe(false);
    expect(ambienceAllowed("off", "vr")).toBe(false);
    expect(ambienceAllowed("off", "2d")).toBe(false);
  });
});

describe("ambience playback with a fake AudioContext", () => {
  it("stays silent until a tap has created the AudioContext", async () => {
    const h = setup({ mode: "always", place: "2d" });
    h.setContext(false);
    h.amb.start();
    expect(h.timer().ms).toBe(AMBIENCE_TICK_MS);
    await flush();
    expect(h.fetched).toEqual([]);
    expect(h.ctx.sources).toHaveLength(0);
    h.setContext(true); // the first tap
    h.amb.tick();
    await flush();
    expect(h.fetched).toEqual(["/app/ambience/beach.ogg"]);
    expect(h.ctx.sources).toHaveLength(1);
  });

  it("starts a looping source at a random offset and fades it in with time constant .9", async () => {
    const h = setup();
    h.amb.tick();
    await flush();
    const [src] = h.ctx.sources;
    expect(src.loop).toBe(true);
    expect(src.started).toEqual([10, 15]); // random .5 × 30 s
    const trackGain = h.ctx.gains[1];
    expect(trackGain.gain.calls).toEqual([{ method: "setTargetAtTime", args: [1, 10, 0.9] }]);
    // The master gain: volume .5 × .6.
    const master = h.ctx.gains[0];
    expect(master.gain.calls[0].args[0]).toBeCloseTo(0.3, 12);
    expect(master.connections).toContain(h.ctx.destination);
  });

  it("crossfades on a scene change: old fades with .6 and stops 3.5 s later", async () => {
    const h = setup();
    h.amb.tick();
    await flush();
    const old = h.ctx.sources[0];
    const oldGain = h.ctx.gains[1];
    h.ctx.currentTime = 42;
    h.set({ sceneId: "forest" });
    h.amb.tick();
    expect(oldGain.gain.calls.at(-1)).toEqual({ method: "setTargetAtTime", args: [0, 42, 0.6] });
    expect(old.stoppedAt).toBe(45.5);
    await flush();
    expect(h.ctx.sources).toHaveLength(2);
    expect(h.ctx.gains[2].gain.calls).toEqual([{ method: "setTargetAtTime", args: [1, 42, 0.9] }]);
    expect(h.amb.playing()).toBe("forest");
    // The old nodes are released when the source ends.
    old.onended?.();
    expect(old.disconnected).toBe(true);
    expect(oldGain.disconnected).toBe(true);
  });

  it("decodes each loop once and caches it", async () => {
    const h = setup();
    h.amb.tick();
    await flush();
    h.set({ sceneId: "lake" });
    h.amb.tick();
    await flush();
    h.set({ sceneId: "beach" });
    h.amb.tick();
    await flush();
    expect(h.fetched).toEqual(["/app/ambience/beach.ogg", "/app/ambience/lake.ogg"]);
    expect(h.ctx.decoded).toHaveLength(2);
    expect(h.ctx.sources).toHaveLength(3);
  });

  it("only starts the scene still wanted when a slow decode finishes", async () => {
    const h = setup();
    h.amb.tick(); // beach requested
    h.set({ sceneId: "deck" });
    h.amb.tick(); // deck requested before beach decoded
    await flush();
    expect(h.ctx.sources).toHaveLength(1);
    expect(h.amb.playing()).toBe("deck");
  });

  it("ducks the master gain while she speaks and listens, every tick, only past .005", async () => {
    const h = setup();
    h.amb.tick();
    await flush();
    const master = h.ctx.gains[0].gain;
    expect(master.calls).toHaveLength(1);
    h.amb.tick();
    expect(master.calls).toHaveLength(1); // unchanged: nothing scheduled
    h.set({ speaking: true });
    h.amb.tick();
    expect(master.calls.at(-1)!.args[0]).toBeCloseTo(0.105, 12);
    h.set({ speaking: false, listening: true });
    h.amb.tick();
    expect(master.calls.at(-1)!.args[0]).toBeCloseTo(0.036, 12);
    h.set({ listening: false, volume: 0.505 }); // .3 → .303: back up from .036
    h.amb.tick();
    const n = master.calls.length;
    h.set({ volume: 0.51 }); // .303 → .306: under .005, not scheduled
    h.amb.tick();
    expect(master.calls).toHaveLength(n);
    h.set({ volume: 0.52 }); // → .312: scheduled
    h.amb.tick();
    expect(master.calls).toHaveLength(n + 1);
  });

  it("fades out when leaving VR in 'vr' mode and never plays in passthrough", async () => {
    const h = setup();
    h.amb.tick();
    await flush();
    h.set({ place: "2d" });
    h.amb.tick();
    expect(h.ctx.sources[0].stoppedAt).toBe(13.5);
    expect(h.amb.playing()).toBeNull();
    h.set({ place: "ar", mode: "always" });
    h.amb.tick();
    await flush();
    expect(h.ctx.sources).toHaveLength(1);
    h.set({ place: "2d" });
    h.amb.tick();
    await flush();
    expect(h.ctx.sources).toHaveLength(2);
  });

  it("treats a missing loop as silence without retrying every tick", async () => {
    const h = setup({ sceneId: "missing" });
    h.amb.tick();
    await flush();
    h.amb.tick();
    await flush();
    expect(h.fetched).toEqual(["/app/ambience/missing.ogg"]);
    expect(h.ctx.sources).toHaveLength(0);
  });

  it("stop() cancels the timer and fades the loop out", async () => {
    const h = setup();
    h.amb.start();
    await flush();
    h.amb.stop();
    expect(h.timer().cancelled).toBe(true);
    expect(h.ctx.sources[0].stoppedAt).toBe(13.5);
  });
});
