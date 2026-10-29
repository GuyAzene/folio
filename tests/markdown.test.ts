import { describe, expect, it } from "vite-plus/test";
import { estimateDirection, writtenDirection } from "../app/lib/direction.ts";
import { fillMath, markdownToHtml, splitPendingMath } from "../app/lib/markdown.ts";

// Synthetic sentences in the style of Folio's replies; no course material.
const html = (text: string, options = {}) => markdownToHtml(text, options);
const texOf = (out: string) =>
  [...out.matchAll(/data-tex="([^"]*)"/g)].map((match) =>
    match[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
  );

describe("math in chat Markdown", () => {
  it("keeps TeX intact through Markdown, with every delimiter models use", () => {
    expect(texOf(html("לכן המרחק האמיתי הוא \\(\\delta(s,a)=1\\)."))).toEqual(["\\delta(s,a)=1"]);
    expect(texOf(html("\\[\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\\]"))).toEqual([
      "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}",
    ]);
    expect(texOf(html("The set \\(\\{x \\mid x>0\\}\\) is open."))).toEqual(["\\{x \\mid x>0\\}"]);
    expect(texOf(html("$$\n\\sum_{i=1}^{n} x_i\n$$"))).toEqual(["\\sum_{i=1}^{n} x_i"]);
    expect(html("$$\n\\sum_{i=1}^{n} x_i\n$$")).toContain('<div class="math" dir="ltr"');
  });

  it("does not let emphasis or Markdown escapes eat the formula", () => {
    const out = html("$x^*$ and $y^*$");
    expect(texOf(out)).toEqual(["x^*", "y^*"]);
    expect(out).not.toContain("<em>");
    const crossing = html("*see $a*b$ here*");
    expect(crossing).toMatch(/<em>see <span class="math"[^>]*data-tex="a\*b"/);
  });

  it("leaves currency, code and escaped dollars as text", () => {
    expect(texOf(html("It costs $5 and $10."))).toEqual([]);
    expect(texOf(html("Revenue grew from $2bn to at least $4bn."))).toEqual([]);
    expect(texOf(html("Prices run $100-$200."))).toEqual([]);
    expect(texOf(html("Literally \\$x\\$ here."))).toEqual([]);
    expect(html("Run `$x$` now.")).toContain('<code dir="ltr">$x$</code>');
    const fenced = html("```sh\necho $$ $HOME\n```");
    expect(texOf(fenced)).toEqual([]);
    expect(fenced).toContain('<pre dir="ltr"><code class="language-sh">echo $$ $HOME');
  });

  it("accepts math touching Hebrew letters, as in prefixes", () => {
    expect(texOf(html("ו$x$ הוא המשתנה"))).toEqual(["x"]);
    expect(texOf(html("הוא\\(x\\)כן"))).toEqual(["x"]);
  });

  it("fills placeholders with KaTeX output after sanitizing, keeping the source", () => {
    const filled = fillMath(html("Since \\(a<b\\) and \\[\\frac{1}{2}\\]"));
    expect(filled).toContain('class="katex"');
    expect(filled).toContain("katex-display");
    expect(filled).toContain('<annotation encoding="application/x-tex">a&lt;b</annotation>');
    expect(filled).toContain('data-tex="a&lt;b"');
  });

  it("shows unfinished math as source while the reply streams", () => {
    expect(splitPendingMath("נתון \\[ \\frac{a}{")).toEqual({
      head: "נתון ",
      pending: "\\[ \\frac{a}{",
    });
    expect(splitPendingMath("Done \\(x\\) and $$y$$")).toEqual({
      head: "Done \\(x\\) and $$y$$",
      pending: "",
    });
    expect(splitPendingMath("```\n\\[ in code\n```")).toMatchObject({ pending: "" });
    const streaming = html("נתון \\[ \\frac{a}{", { streaming: true });
    expect(streaming).toContain('<div class="math-pending" dir="ltr"');
    expect(streaming).toContain("\\[ \\frac{a}{");
    expect(html("נתון \\[ \\frac{a}{")).not.toContain("math-pending");
  });
});

describe("direction of each block", () => {
  it("decides by the share of Hebrew words, ignoring code, math and URLs", () => {
    expect(html("Python היא שפת תכנות נפוצה.")).toContain('<p dir="rtl">');
    expect(html("$O(n)$ הוא זמן הריצה של האלגוריתם.")).toContain('<p dir="rtl">');
    expect(html("`DIJKSTRA(G, w, s)` מחזיר את המרחקים מ-s.")).toContain('<p dir="rtl">');
    expect(html("Dijkstra's algorithm needs non-negative weights.")).toContain('<p dir="ltr">');
    expect(html("See https://example.com/a for the proof.")).toContain('<p dir="ltr">');
  });

  it("lets blocks without words keep the reply's direction, or the question's", () => {
    const out = html("זהו הסבר קצר על האלגוריתם.\n\n3 + 4 = 7");
    expect(out).toMatch(/<p dir="rtl"><span dir="ltr">3 \+ 4 = 7<\/span><\/p>/);
    expect(html("(1)", { base: "rtl" })).toContain('<p dir="rtl">(1)</p>');
    expect(html("(1)")).toContain('<p dir="ltr">(1)</p>');
  });

  it("isolates arithmetic and signed numbers inside Hebrew text", () => {
    const out = html("לכן 3 + 4 = 7 והטמפרטורה -5 מעלות, בעמודים 12–15.");
    expect(out).toContain('<span dir="ltr">3 + 4 = 7</span>');
    expect(out).toContain('<span dir="ltr">-5</span>');
    expect(out).toContain('<span dir="ltr">12–15</span>');
    expect(html("קצר יותר: 3 + (-2) = 1, ולכן")).toContain('<span dir="ltr">3 + (-2) = 1</span>');
    // Dates, times and Hebrew prefixes with a hyphen stay as they are.
    const plain = html("בתאריך 28.10.2026 בשעה 10:30, ב-5 תרגילים.");
    expect(plain).not.toContain('<span dir="ltr">');
    // English text is never touched.
    expect(html("So 3 + 4 = 7.")).not.toContain("<span");
  });

  it("keeps an English citation in Hebrew text one island, parentheses included", () => {
    const out = html("ואז החסם נעשה מדויק (Lecture 3 Shortest paths, pp.3, 6).");
    expect(out).toContain('<span dir="ltr">(Lecture 3 Shortest paths, pp.3, 6)</span>.');
    // Hebrew asides and English text are left alone.
    expect(html("זה נכון (ראו את ההרצאה).")).not.toContain("<span");
    expect(html("This holds (see Lecture 3).")).not.toContain("<span");
  });

  it("gives a list one direction and each item its own words' direction", () => {
    const out = html("- הצעד הראשון הוא אתחול\n- Relax every edge\n- הצעד האחרון");
    expect(out).toContain('<ul dir="rtl">');
    expect(out).toContain('<li><span dir="ltr">Relax every edge</span></li>');
    expect(out).toContain("<li>הצעד הראשון הוא אתחול</li>");
  });

  it("decides a table from its header and first column, and each cell on its own", () => {
    const out = html("| קודקוד | מרחק |\n|:---|---:|\n| s | 0 |\n| source | אפס |");
    expect(out).toContain('<table dir="rtl">');
    expect(out).toContain('<th style="text-align:start">קודקוד</th>');
    expect(out).toContain('<td dir="ltr" style="text-align:start">source</td>');
  });

  it("keeps code, math and bare links left to right inside Hebrew", () => {
    const out = html("ראו https://example.com/x והקוד `a[i]` והנוסחה \\(x_1\\).");
    expect(out).toContain('<a dir="ltr" href="https://example.com/x"');
    expect(out).toContain('<code dir="ltr">a[i]</code>');
    expect(out).toContain('<span class="math" dir="ltr"');
  });

  it("holds the direction of the block still being written until it has a few words", () => {
    const text = "זוהי פסקה ראשונה בעברית עם כמה מילים.\n\nPython";
    expect(html(text, { streaming: true })).toMatch(/<p dir="rtl">Python<\/p>/);
    expect(html(text)).toMatch(/<p dir="ltr">Python<\/p>/);
  });

  it("estimates direction from strong words, skipping a byte-order mark and isolates", () => {
    expect(estimateDirection("\uFEFFשלום world")).toMatchObject({ direction: "rtl", words: 2 });
    expect(estimateDirection("hello \u2067שלום עולם\u2069 world")).toMatchObject({
      direction: "ltr",
      words: 2,
    });
    expect(estimateDirection("3 + 4 = 7 (1).")).toEqual({ direction: null, words: 0, first: null });
    expect(estimateDirection("one two three ארבע")).toMatchObject({ direction: "ltr" });
    expect(estimateDirection("one two ארבע חמש")).toMatchObject({ direction: "rtl" });
  });

  it("keeps written text in the direction of its first letter", () => {
    const written = (text: string) => writtenDirection(estimateDirection(text));
    expect(written("שלום this is my first note")).toBe("rtl");
    expect(written("Hello שלום עולם רב לכולם")).toBe("ltr");
    expect(written("3 + 4 = שבע")).toBe("rtl");
    expect(written("3 + 4")).toBeNull();
  });
});

describe("raw HTML blocks", () => {
  it("gives a block of HTML the direction of its words on its first element", () => {
    expect(html("<details><summary>הוכחה</summary>\nנבנה אוטומט\n</details>")).toMatch(
      /^<details dir="rtl">/,
    );
    expect(html("<div>An English block</div>")).toMatch(/^<div dir="ltr">/);
    expect(html('<div dir="ltr">שלום</div>')).toMatch(/^<div dir="ltr">שלום/);
    expect(html("<!-- a comment -->")).toBe("<!-- a comment -->");
  });
});

describe("notes in the reading view", () => {
  it("decides each line as the note editor does", () => {
    const mixed = "שלום this is my first note מה קורה";
    expect(html(mixed)).toMatch(/^<p dir="ltr">/);
    expect(html(mixed, { note: true })).toMatch(/^<p dir="rtl">/);
    expect(html("שלום עולם\nhello world", { note: true })).toBe(
      '<p dir="rtl"><span class="line" dir="rtl">שלום עולם</span><span class="line" dir="ltr">hello world</span></p>\n',
    );
  });
});
