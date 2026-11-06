// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { DisplayTurn } from "../src/core/assistant";
import { buildRows, enteringFrom } from "../src/ui/chat";
import { createSlot } from "../src/ui/slots";
import { sceneUrl } from "../src/ui/app";

const user = (text: string, index: number, image?: string): DisplayTurn => ({
  role: "user",
  text,
  actions: [],
  models: [],
  index,
  ...(image ? { image } : {}),
});
const her = (text: string, index: number, models: string[] = [], actions: string[] = []): DisplayTurn => ({
  role: "assistant",
  text,
  actions,
  models,
  index,
});
const idle = { busy: false, text: "", actions: [], model: "", status: "" };

describe("buildRows", () => {
  it("marks her last finished reply and notes an attached image", () => {
    const rows = buildRows({ ...idle, turns: [user("look", 0, "AAAA"), her("A cat.", 1, ["claude-haiku-5-5"])] });
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows[0].image).toBe("AAAA");
    expect(rows[1].imageNote).toBe(true);
    expect(rows[1].last).toBe(true);
  });

  it("adds one live bubble while busy", () => {
    const rows = buildRows({ busy: true, text: "", actions: [], model: "claude-haiku-5-5", status: "Thinking…", turns: [user("hi", 0)] });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ live: true, status: "Thinking…", models: ["claude-haiku-5-5"] });
    expect(rows.some((r) => r.last)).toBe(false);
  });

  it("folds a run's already-stored rounds into the live bubble", () => {
    const rows = buildRows({
      busy: true,
      text: "Sure",
      actions: ["Set a timer"],
      model: "claude-opus-5-5",
      status: "",
      turns: [user("plan it", 0), her("", 1, ["claude-haiku-5-5"])],
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ live: true, text: "Sure", models: ["claude-haiku-5-5", "claude-opus-5-5"], actions: ["Set a timer"] });
  });
});

describe("enteringFrom (slide-in only for new rows)", () => {
  it("animates one or two new rows", () => {
    expect(enteringFrom(2, 4, false)).toBe(2);
    expect(enteringFrom(4, 5, false)).toBe(4);
  });
  it("skips the animation for more than two at once, a mode switch, or no change", () => {
    expect(enteringFrom(0, 6, false)).toBe(6);
    expect(enteringFrom(2, 3, true)).toBe(3);
    expect(enteringFrom(4, 4, false)).toBe(4);
    expect(enteringFrom(4, 3, false)).toBe(3);
  });
});

describe("character slots", () => {
  it("start with the orb and keep one stable element across mounts", () => {
    const slot = createSlot("hero");
    const el = slot.el;
    expect(slot.content).toBe("orb");
    expect(el.querySelector(".orb")).not.toBeNull();
    let disposed = 0;
    const face = document.createElement("div");
    slot.mount({ el: face, dispose: () => disposed++ });
    expect(slot.el).toBe(el);
    expect(slot.content).toBe("custom");
    expect(el.firstChild).toBe(face);
    expect(el.classList.contains("slot-orb")).toBe(false);
    slot.mountOrb();
    expect(disposed).toBe(1);
    expect(el.classList.contains("slot-orb")).toBe(true);
  });
});

describe("sceneUrl", () => {
  it("is absolute, so a custom property can't resolve it against the stylesheet", () => {
    expect(sceneUrl("skies/thumbs/beach.jpg", "https://orbit.example/app/index.html")).toBe(
      'url("https://orbit.example/app/skies/thumbs/beach.jpg")',
    );
  });
});
