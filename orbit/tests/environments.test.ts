import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLOCK_ENVIRONMENT_ID,
  ENVIRONMENTS,
  ambienceFile,
  cssColor,
  environmentById,
  nextEnvironment,
  sceneLoadFailedText,
} from "../src/core/environments";

const publicDir = resolve(__dirname, "../public");

describe("environments", () => {
  it("has seven scenes with unique ids, in table order", () => {
    expect(ENVIRONMENTS).toHaveLength(7);
    expect(new Set(ENVIRONMENTS.map((e) => e.id)).size).toBe(7);
    expect(ENVIRONMENTS.map((e) => e.id)).toEqual(["clock", "beach", "lake", "loft", "deck", "forest", "rooftop"]);
  });

  it("follows the image and thumbnail path conventions", () => {
    for (const e of ENVIRONMENTS) {
      if (e.id === CLOCK_ENVIRONMENT_ID) {
        expect(e.image).toBeUndefined();
        expect(e.thumb).toBeUndefined();
        continue;
      }
      expect(e.image).toBe(`skies/${e.id}.jpg`);
      expect(e.thumb).toBe(`skies/thumbs/${e.id}.jpg`);
      expect(existsSync(resolve(publicDir, e.image!))).toBe(true);
      expect(existsSync(resolve(publicDir, e.thumb!))).toBe(true);
    }
  });

  it("keeps horizons between 0.3 and 0.7, with lights and particles", () => {
    for (const e of ENVIRONMENTS) {
      expect(e.horizon).toBeGreaterThanOrEqual(0.3);
      expect(e.horizon).toBeLessThanOrEqual(0.7);
      expect(e.seam).toBeGreaterThanOrEqual(0);
      expect(e.key.intensity).toBeGreaterThan(0);
      expect(e.particles.count).toBeGreaterThan(0);
    }
    expect(environmentById("rooftop").particles).toEqual({ kind: "rain", color: 0xd8c8ff, count: 700 });
    // The panoramas are made to wrap in the image (docs/ASSETS.md), so the mirrored seam blend is off everywhere.
    for (const e of ENVIRONMENTS) expect(e.seam).toBe(0);
    expect(environmentById("lake").hemisphere).toEqual({ sky: 0x9fb8ff, ground: 0x0c1418 });
  });

  it("falls back to the clock scene", () => {
    expect(environmentById("nowhere").id).toBe("clock");
    expect(environmentById(undefined).id).toBe("clock");
    expect(environmentById(null).id).toBe("clock");
    expect(environmentById("lake").name).toBe("Night lake");
  });

  it("cycles in table order and wraps", () => {
    const seen: string[] = [];
    let id = "clock";
    for (let i = 0; i < 7; i++) {
      id = nextEnvironment(id).id;
      seen.push(id);
    }
    expect(seen).toEqual(["beach", "lake", "loft", "deck", "forest", "rooftop", "clock"]);
    expect(nextEnvironment("unknown").id).toBe("beach");
  });

  it("formats colours for CSS", () => {
    expect(cssColor(0x0c1418)).toBe("#0c1418");
    expect(cssColor(0xffe6c8)).toBe("#ffe6c8");
  });

  it("words the load failure and names each soundscape file", () => {
    expect(sceneLoadFailedText("Night lake")).toBe("Couldn't load the Night lake scene. Going back to the clock sky.");
    expect(ambienceFile("rooftop")).toBe("ambience/rooftop.ogg");
    expect(ambienceFile("clock")).toBe("ambience/clock.ogg");
  });
});
