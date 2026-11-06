import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { environmentById, type Environment } from "../src/core/environments";
import {
  configurePanoramaTexture,
  createPanoramaMaterial,
  createPanoramaSwitcher,
  createTicketCounter,
  panoramaU,
  panoramaUv,
  panoramaV,
  pickAngleGradient,
  seamWeight,
} from "../src/xr/panorama";

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("panorama uv mapping (§8.7)", () => {
  it("puts the image centre straight ahead and the wrap seam behind", () => {
    close(panoramaU(0, -1), 0.5);
    // Behind (+Z): u sits on the wrap, at 0 or 1.
    const back = panoramaU(1e-9, 1);
    expect(Math.min(back, 1 - back)).toBeLessThan(1e-6);
    // Right (+X) is the right half of the image, left (−X) the left half.
    close(panoramaU(1, 0), 0.75);
    close(panoramaU(-1, 0), 0.25);
  });

  it("is continuous everywhere except across the seam behind", () => {
    for (let a = -Math.PI + 0.05; a < Math.PI - 0.05; a += 0.01) {
      const u1 = panoramaU(Math.sin(a), -Math.cos(a));
      const u2 = panoramaU(Math.sin(a + 0.01), -Math.cos(a + 0.01));
      expect(Math.abs(u2 - u1)).toBeLessThan(0.01);
    }
  });

  it("applies yaw as a shift in u, wrapped with fract", () => {
    close(panoramaU(0, -1, 0.25), 0.75);
    close(panoramaU(0, -1, 0.75), 0.25);
    const u = panoramaU(1, 0, 0.5);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
    close(u, 0.25);
  });

  it("maps height through the horizon and clamps away from the poles", () => {
    close(panoramaV(0, 0.5), 0.5);
    close(panoramaV(1, 0.5), 0.999);
    close(panoramaV(-1, 0.5), 0.001);
    close(panoramaV(Math.sin(Math.PI / 4), 0.5), 0.75);
    close(panoramaV(0, 0.45), 0.45);
    const { u, v } = panoramaUv({ x: 0, y: 0, z: -10 }, 0.5);
    close(u, 0.5);
    close(v, 0.5);
  });

  it("blends the mirrored lookup only near the wrap", () => {
    expect(seamWeight(0.5, 0.04)).toBe(0);
    expect(seamWeight(0.04, 0.04)).toBe(0);
    expect(seamWeight(0.2, 0.04)).toBe(0);
    close(seamWeight(0, 0.04), 0.5);
    close(seamWeight(1, 0.04), 0.5);
    // t = 1 − .02/.04 = .5, so the weight is .5 × .25
    close(seamWeight(0.02, 0.04), 0.125);
    close(seamWeight(0.98, 0.04), 0.125);
    // Off when seam is 0.
    expect(seamWeight(0, 0)).toBe(0);
    expect(seamWeight(0.001, 0)).toBe(0);
  });

  it("samples with the smaller of the two angle derivatives", () => {
    const smooth = { dx: 0.002, dy: 0.001 };
    const jump = { dx: 2 * Math.PI - 0.002, dy: 0.001 };
    expect(pickAngleGradient(smooth, jump)).toBe(smooth);
    expect(pickAngleGradient(jump, smooth)).toBe(smooth);
  });
});

describe("panorama material and texture", () => {
  it("leaves the texture without a colour space, repeating across the wrap", () => {
    const tex = configurePanoramaTexture(new THREE.Texture(), 16);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
    expect(tex.flipY).toBe(false);
    expect(tex.wrapS).toBe(THREE.RepeatWrapping);
    expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(tex.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(tex.magFilter).toBe(THREE.LinearFilter);
    expect(tex.generateMipmaps).toBe(true);
    expect(tex.anisotropy).toBe(8);
    expect(configurePanoramaTexture(new THREE.Texture(), 4).anisotropy).toBe(4);
  });

  it("carries the scene's horizon and seam into the shader, which uses textureGrad", () => {
    const tex = new THREE.Texture();
    const m = createPanoramaMaterial(tex, environmentById("beach"));
    expect(m.uniforms.uHorizon.value).toBe(0.5);
    expect(m.uniforms.uSeam.value).toBe(environmentById("beach").seam);
    expect(m.uniforms.uMap.value).toBe(tex);
    expect(m.side).toBe(THREE.BackSide);
    expect(m.fragmentShader).toContain("textureGrad");
    expect(m.fragmentShader).toContain("atan(-d.x, d.z)");
    expect(createPanoramaMaterial(tex, environmentById("deck")).uniforms.uSeam.value).toBe(0);
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const pending = new Map<string, ReturnType<typeof deferred<string>>>();
  const log: string[] = [];
  const sw = createPanoramaSwitcher<string>({
    load: (env: Environment) => {
      const d = deferred<string>();
      pending.set(env.id, d);
      return d.promise;
    },
    showPanorama: (env, t) => log.push(`show ${env.id} ${t}`),
    showClock: () => log.push("clock"),
    discard: (t) => log.push(`discard ${t}`),
    failed: (env) => log.push(`failed ${env.name}`),
  });
  return { sw, pending, log };
}

describe("ticket counter and scene switching", () => {
  it("only the latest ticket is current", () => {
    const t = createTicketCounter();
    const a = t.next();
    const b = t.next();
    expect(t.isCurrent(a)).toBe(false);
    expect(t.isCurrent(b)).toBe(true);
  });

  it("drops a load that finishes after a newer request", async () => {
    const { sw, pending, log } = harness();
    const first = sw.set(environmentById("beach"));
    const second = sw.set(environmentById("lake"));
    pending.get("lake")!.resolve("tex-lake");
    await second;
    pending.get("beach")!.resolve("tex-beach");
    await first;
    expect(log).toEqual(["show lake tex-lake", "discard tex-beach"]);
    expect(sw.current()).toBe("lake");
  });

  it("drops a panorama that loads after a switch back to the clock", async () => {
    const { sw, pending, log } = harness();
    const p = sw.set(environmentById("forest"));
    await sw.set(environmentById("clock"));
    pending.get("forest")!.resolve("tex-forest");
    await p;
    expect(log).toEqual(["clock", "discard tex-forest"]);
  });

  it("frees the previous panorama when the next one shows, and on the clock", async () => {
    const { sw, pending, log } = harness();
    const a = sw.set(environmentById("deck"));
    pending.get("deck")!.resolve("t1");
    await a;
    const b = sw.set(environmentById("rooftop"));
    pending.get("rooftop")!.resolve("t2");
    await b;
    await sw.set(environmentById("clock"));
    expect(log).toEqual(["show deck t1", "show rooftop t2", "discard t1", "clock", "discard t2"]);
  });

  it("ignores a repeat of the scene already loading", async () => {
    const { sw, pending, log } = harness();
    const a = sw.set(environmentById("loft"));
    await sw.set(environmentById("loft"));
    pending.get("loft")!.resolve("t");
    await a;
    expect(log).toEqual(["show loft t"]);
  });

  it("falls back to the clock sky when a load fails, and allows a retry", async () => {
    const { sw, pending, log } = harness();
    const a = sw.set(environmentById("lake"));
    pending.get("lake")!.reject(new Error("404"));
    await a;
    expect(log).toEqual(["clock", "failed Night lake"]);
    const b = sw.set(environmentById("lake"));
    pending.get("lake")!.resolve("t");
    await b;
    expect(log.at(-1)).toBe("show lake t");
  });

  it("stays quiet about a stale load that fails", async () => {
    const { sw, pending, log } = harness();
    const a = sw.set(environmentById("beach"));
    await sw.set(environmentById("clock"));
    pending.get("beach")!.reject(new Error("gone"));
    await a;
    expect(log).toEqual(["clock"]);
  });
});
