/**
 * Text with its HTML tags taken out, for a title or heading written with markup:
 * `<span style="display:block"><u>Exercise 3</u></span>` reads "Exercise 3". Only whole tags go,
 * from a `<` before a letter or `</` to the next `>` on the same line, so "a < b" and "x<y" keep
 * their signs. The result is shown as text, never as HTML.
 */
export function withoutMarkup(text: string): string {
  let plain = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "<") {
      const next = text[index + 1] === "/" ? text[index + 2] : text[index + 1];
      const end = text.indexOf(">", index);
      const inner = end === -1 ? "" : text.slice(index + 1, end);
      if (next && /[A-Za-z]/.test(next) && end !== -1 && !/[<\n]/.test(inner)) {
        index = end;
        continue;
      }
    }
    plain += char;
  }
  return plain;
}
