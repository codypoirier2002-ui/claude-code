import { describe, expect, it } from "vitest";
import { formatReminder } from "../src/ui/format";
import { headerStatus } from "../src/ui/header";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("formatReminder (§6.4)", () => {
  it("shows the time alone for today", () => {
    expect(formatReminder(at(2026, 6, 16, 19, 0), at(2026, 6, 16, 9, 0), false, "en-US")).toBe("7:00 PM");
  });
  it("adds the weekday on another day and ↻ for daily ones", () => {
    // 2026-06-16 is a Tuesday.
    expect(formatReminder(at(2026, 6, 16, 19, 0), at(2026, 6, 15, 21, 0), false, "en-US")).toBe("Tue 7:00 PM");
    expect(formatReminder(at(2026, 6, 16, 9, 5), at(2026, 6, 16, 8, 0), true, "en-US")).toBe("9:05 AM ↻");
  });
});

describe("headerStatus (§6.3)", () => {
  it("prefers speaking, then typing/thinking while busy, then the mode", () => {
    expect(headerStatus({ speaking: true, busy: true, text: "x", modeName: "Everyday" })).toBe("speaking…");
    expect(headerStatus({ speaking: false, busy: true, text: "Hi", modeName: "Everyday" })).toBe("typing…");
    expect(headerStatus({ speaking: false, busy: true, text: "", modeName: "Everyday" })).toBe("thinking…");
    expect(headerStatus({ speaking: false, busy: false, text: "", modeName: "Quest Guide" })).toBe("Quest Guide mode");
  });
});
