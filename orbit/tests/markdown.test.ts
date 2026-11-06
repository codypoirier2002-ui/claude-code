import { describe, expect, it } from "vitest";
import { isSafeLink, markdownToPlain, renderMarkdown } from "../src/ui/markdown";

describe("renderMarkdown", () => {
  it("escapes all HTML", () => {
    expect(renderMarkdown('<script>alert("x")</script> & \'q\'')).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>",
    );
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(renderMarkdown("**<b>bold</b>**")).toBe("<p><strong>&lt;b&gt;bold&lt;/b&gt;</strong></p>");
  });

  it("makes paragraphs and line breaks", () => {
    expect(renderMarkdown("One\ntwo\n\nThree")).toBe("<p>One<br>two</p><p>Three</p>");
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("\n\n  \n")).toBe("");
  });

  it("renders bold and italic", () => {
    expect(renderMarkdown("**bold** and *italic* and __b__ and _i_")).toBe(
      "<p><strong>bold</strong> and <em>italic</em> and <strong>b</strong> and <em>i</em></p>",
    );
    expect(renderMarkdown("***both***")).toBe("<p><strong><em>both</em></strong></p>");
    expect(renderMarkdown("2 * 3 * 4 and snake_case_name")).toBe("<p>2 * 3 * 4 and snake_case_name</p>");
  });

  it("renders - and 1. lists", () => {
    expect(renderMarkdown("Shopping:\n- eggs\n- **milk**\n\nThen")).toBe(
      "<p>Shopping:</p><ul><li>eggs</li><li><strong>milk</strong></li></ul><p>Then</p>",
    );
    expect(renderMarkdown("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>");
    expect(renderMarkdown("3. third\n4. fourth")).toBe('<ol start="3"><li>third</li><li>fourth</li></ol>');
    expect(renderMarkdown("- a\n  more a\n- b")).toBe("<ul><li>a<br>more a</li><li>b</li></ul>");
    expect(renderMarkdown("- a\n1. b")).toBe("<ul><li>a</li></ul><ol><li>b</li></ol>");
  });

  it("renders inline code without formatting inside it", () => {
    expect(renderMarkdown("Run `npm **test** <x>` now")).toBe("<p>Run <code>npm **test** &lt;x&gt;</code> now</p>");
    expect(renderMarkdown("``a ` b``")).toBe("<p><code>a ` b</code></p>");
  });

  it("renders fenced code, including an unclosed fence", () => {
    expect(renderMarkdown("```ts\nconst a = 1 < 2;\n**no**\n```\nafter")).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;\n**no**</code></pre><p>after</p>',
    );
    expect(renderMarkdown("Look:\n```\nopen <b>")).toBe("<p>Look:</p><pre><code>open &lt;b&gt;</code></pre>");
    expect(renderMarkdown("~~~\n- not a list\n~~~")).toBe("<pre><code>- not a list</code></pre>");
  });

  it("links only https URLs", () => {
    expect(renderMarkdown("[Docs](https://example.com/a?b=1&c=2)")).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">Docs</a></p>',
    );
    expect(renderMarkdown("[click](javascript:alert(1))")).not.toContain("<a");
    expect(renderMarkdown("[click](javascript:alert)")).toBe("<p>click</p>");
    expect(renderMarkdown("[plain](http://example.com)")).toBe("<p>plain</p>");
    expect(renderMarkdown("[data](data:text/html,hi)")).toBe("<p>data</p>");
    expect(renderMarkdown("[rel](/local/path)")).toBe("<p>rel</p>");
    expect(renderMarkdown('[x](https://e.com/"onmouseover="y)')).not.toMatch(/href="[^"]*"onmouseover/);
    expect(renderMarkdown("**[Bold link](https://e.com)**")).toBe(
      '<p><strong><a href="https://e.com" target="_blank" rel="noopener noreferrer">Bold link</a></strong></p>',
    );
    expect(renderMarkdown("[`code`](https://e.com)")).toBe(
      '<p><a href="https://e.com" target="_blank" rel="noopener noreferrer"><code>code</code></a></p>',
    );
  });

  it("isSafeLink accepts https only", () => {
    expect(isSafeLink("https://a.b")).toBe(true);
    expect(isSafeLink("HTTPS://a.b")).toBe(true);
    expect(isSafeLink("http://a.b")).toBe(false);
    expect(isSafeLink("javascript:alert(1)")).toBe(false);
    expect(isSafeLink("//a.b")).toBe(false);
  });

  it("shows headings as bold paragraphs and rules as <hr>", () => {
    expect(renderMarkdown("## Plan\ntext")).toBe("<p><strong>Plan</strong></p><p>text</p>");
    expect(renderMarkdown("a\n\n---\n\nb")).toBe("<p>a</p><hr><p>b</p>");
  });

  it("strips stray NUL characters so placeholders can't be forged", () => {
    expect(renderMarkdown("\u00000\u0000 `x`")).toBe("<p>0 <code>x</code></p>");
  });
});

describe("markdownToPlain", () => {
  it("removes markers and keeps text", () => {
    expect(markdownToPlain("**Bold** and *it* and `code` and [link](https://e.com)")).toBe(
      "Bold and it and code and link",
    );
  });

  it("writes list items as '- ' lines", () => {
    expect(markdownToPlain("Steps:\n1. one\n2. **two**\n\n* star\n- dash")).toBe(
      "Steps:\n\n- one\n- two\n\n- star\n- dash",
    );
  });

  it("keeps code as plain text and leaves HTML unescaped", () => {
    expect(markdownToPlain("Try:\n```js\nif (a < b) **x**\n```")).toBe("Try:\n\nif (a < b) **x**");
    expect(markdownToPlain("Use `a*b*c` <tag>")).toBe("Use a*b*c <tag>");
  });

  it("keeps paragraphs apart and headings as text", () => {
    expect(markdownToPlain("# Title\nOne\ntwo\n\nThree")).toBe("Title\n\nOne\ntwo\n\nThree");
  });
});
