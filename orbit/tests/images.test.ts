import { describe, expect, it } from "vitest";
import { fitWithin } from "../src/core/images";

describe("fitWithin (the §3.9 image step)", () => {
  it("scales the longest side down to 1280", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(1080, 2400)).toEqual({ width: 576, height: 1280 });
  });

  it("never scales up", () => {
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 });
    expect(fitWithin(1280, 720)).toEqual({ width: 1280, height: 720 });
  });
});
