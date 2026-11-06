// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { clear, formatRemaining, h } from "../src/ui/dom";

describe("h", () => {
  it("creates an element with class, dataset and attributes", () => {
    const el = h("div", { class: "card hot", dataset: { id: "42", gone: null, off: false }, title: "Hi", "aria-label": "Card" });
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("card hot");
    expect(el.dataset.id).toBe("42");
    expect("gone" in el.dataset).toBe(false);
    expect("off" in el.dataset).toBe(false);
    expect(el.getAttribute("title")).toBe("Hi");
    expect(el.getAttribute("aria-label")).toBe("Card");
  });

  it("accepts a list of classes and skips falsy entries", () => {
    expect(h("span", { class: ["a", false, "b", null] }).className).toBe("a b");
  });

  it("turns on* props into listeners", () => {
    const onClick = vi.fn();
    const btn = h("button", { onClick });
    btn.click();
    btn.dispatchEvent(new Event("click"));
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(btn.getAttribute("onclick")).toBeNull();
  });

  it("sets non-string values as properties", () => {
    const input = h("input", { type: "checkbox", checked: true, tabIndex: 3 });
    expect(input.checked).toBe(true);
    expect(input.tabIndex).toBe(3);
    const btn = h("button", { disabled: true });
    expect(btn.disabled).toBe(true);
  });

  it("skips null and false props", () => {
    const btn = h("button", { disabled: false, title: null, id: undefined });
    expect(btn.disabled).toBe(false);
    expect(btn.hasAttribute("title")).toBe(false);
    expect(btn.hasAttribute("id")).toBe(false);
  });

  it("appends children, flattening arrays and skipping null/false", () => {
    const el = h("p", null, "Hello ", h("b", null, "you"), null, false, ["!", 1], undefined);
    expect(el.innerHTML).toBe("Hello <b>you</b>!1");
  });

  it("puts strings in as text, never HTML", () => {
    const el = h("div", null, "<img src=x onerror=alert(1)>");
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("clear", () => {
  it("removes every child", () => {
    const el = h("ul", null, h("li", null, "a"), h("li", null, "b"), "text");
    clear(el);
    expect(el.childNodes).toHaveLength(0);
  });
});

describe("formatRemaining", () => {
  it("formats m:ss under an hour", () => {
    expect(formatRemaining(0)).toBe("0:00");
    expect(formatRemaining(5_000)).toBe("0:05");
    expect(formatRemaining(65_000)).toBe("1:05");
    expect(formatRemaining(25 * 60_000)).toBe("25:00");
    expect(formatRemaining(3_599_000)).toBe("59:59");
  });

  it("formats h:mm:ss from an hour up", () => {
    expect(formatRemaining(3_600_000)).toBe("1:00:00");
    expect(formatRemaining(3_725_000)).toBe("1:02:05");
    expect(formatRemaining(24 * 3_600_000)).toBe("24:00:00");
  });

  it("rounds partial seconds up and clamps negatives", () => {
    expect(formatRemaining(400)).toBe("0:01");
    expect(formatRemaining(59_001)).toBe("1:00");
    expect(formatRemaining(-5_000)).toBe("0:00");
    expect(formatRemaining(Number.NaN)).toBe("0:00");
  });
});
