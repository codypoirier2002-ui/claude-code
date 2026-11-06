// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS, STORAGE_PREFIX, eraseAllStorage, readJSON, removeKey, writeJSON } from "../src/core/store";

/** A localStorage whose every method throws. */
function brokenStorage(): Storage {
  const fail = () => {
    throw new Error("QuotaExceededError");
  };
  return { getItem: fail, setItem: fail, removeItem: fail, clear: fail, key: fail, length: 0 } as unknown as Storage;
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("store", () => {
  it("uses the orbit: prefix and the seven keys", () => {
    expect(STORAGE_PREFIX).toBe("orbit:");
    expect(STORAGE_KEYS).toEqual(["settings", "threads", "workspace", "conversations", "lastGreeting", "visits", "avatarSpot"]);
  });

  it("round-trips JSON under the prefix", () => {
    expect(writeJSON("conversations", 7)).toBe(true);
    expect(localStorage.getItem("orbit:conversations")).toBe("7");
    expect(readJSON("conversations", 0)).toBe(7);
    writeJSON("workspace", { tasks: [1] });
    expect(readJSON("workspace", null)).toEqual({ tasks: [1] });
  });

  it("returns the fallback for missing or broken values", () => {
    expect(readJSON("threads", { none: true })).toEqual({ none: true });
    localStorage.setItem("orbit:threads", "{oops");
    expect(readJSON("threads", "fallback")).toBe("fallback");
  });

  it("returns the fallback when reading throws", () => {
    vi.stubGlobal("localStorage", brokenStorage());
    expect(readJSON("visits", 3)).toBe(3);
  });

  it("returns false when writing throws", () => {
    vi.stubGlobal("localStorage", brokenStorage());
    expect(writeJSON("visits", { a: 1 })).toBe(false);
  });

  it("returns false when there is no localStorage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(writeJSON("visits", 1)).toBe(false);
    expect(readJSON("visits", 2)).toBe(2);
    expect(() => eraseAllStorage()).not.toThrow();
  });

  it("returns false for values JSON can't encode", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(writeJSON("threads", loop)).toBe(false);
  });

  it("removes a single key and erases exactly the seven keys", () => {
    for (const k of STORAGE_KEYS) writeJSON(k, 1);
    localStorage.setItem("orbit:other", "keep");
    localStorage.setItem("unrelated", "keep");
    removeKey("settings");
    expect(localStorage.getItem("orbit:settings")).toBeNull();
    eraseAllStorage();
    for (const k of STORAGE_KEYS) expect(localStorage.getItem(STORAGE_PREFIX + k)).toBeNull();
    expect(localStorage.getItem("orbit:other")).toBe("keep");
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });

  it("never throws when removal fails", () => {
    vi.stubGlobal("localStorage", brokenStorage());
    expect(() => eraseAllStorage()).not.toThrow();
  });
});
