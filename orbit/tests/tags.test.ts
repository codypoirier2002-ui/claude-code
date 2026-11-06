import { describe, expect, it } from "vitest";
import { AUDIO_TAGS, stripAudioTags } from "../src/core/tags";

describe("stripAudioTags", () => {
  it("knows the documented tags", () => {
    expect(AUDIO_TAGS).toHaveLength(26);
    expect(AUDIO_TAGS).toContain("short pause");
    expect(AUDIO_TAGS).toContain("clears throat");
  });

  it("removes tags and one trailing space or tab", () => {
    expect(stripAudioTags("[giggles] Hi there!")).toBe("Hi there!");
    expect(stripAudioTags("Okay [whispers]\tthis is a secret.")).toBe("Okay this is a secret.");
    expect(stripAudioTags("Well [short pause]  fine.")).toBe("Well  fine.");
    expect(stripAudioTags("Done[laughs]")).toBe("Done");
    expect(stripAudioTags("[Excited] [CLEARS THROAT] Big news")).toBe("Big news");
    expect(stripAudioTags("Line one [sighs]\nLine two")).toBe("Line one \nLine two");
  });

  it("leaves unknown brackets, indexing and links alone", () => {
    expect(stripAudioTags("[Chorus] la la")).toBe("[Chorus] la la");
    expect(stripAudioTags("Use arr[i] here")).toBe("Use arr[i] here");
    expect(stripAudioTags("See [laughs](https://example.com) and [docs](https://x.dev)")).toBe(
      "See [laughs](https://example.com) and [docs](https://x.dev)",
    );
    expect(stripAudioTags("[sighs][ref]: note")).toBe("[sighs][ref]: note");
  });

  it("keeps tags inside inline code", () => {
    expect(stripAudioTags("Type `[giggles] ` to test [giggles] it")).toBe("Type `[giggles] ` to test it");
    expect(stripAudioTags("``a [sighs] ` b`` [sighs] c")).toBe("``a [sighs] ` b`` c");
  });

  it("keeps tags inside fenced code", () => {
    const md = "[laughs] Look:\n```js\nconst s = \"[laughs] \";\n```\n[laughs] done";
    expect(stripAudioTags(md)).toBe("Look:\n```js\nconst s = \"[laughs] \";\n```\ndone");
    const tilde = "~~~\n[hums]\n~~~\n[hums] ok";
    expect(stripAudioTags(tilde)).toBe("~~~\n[hums]\n~~~\nok");
  });

  it("keeps tags inside an unclosed fence", () => {
    const md = "[sighs] Here:\n```\n[sighs] still code\n[gasps]";
    expect(stripAudioTags(md)).toBe("Here:\n```\n[sighs] still code\n[gasps]");
  });

  it("treats an unmatched backtick as text", () => {
    expect(stripAudioTags("It's 5` tall [giggles] ok")).toBe("It's 5` tall ok");
  });
});
