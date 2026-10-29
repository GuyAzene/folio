/**
 * Starting points for an empty note, offered under its title. A template is ordinary Markdown
 * added as the student's own edit, so ⌘Z takes it back out. `{cursor}` marks where writing
 * starts.
 */
export interface NoteTemplate {
  id: string;
  label: string;
  body(today: string): string;
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: "lecture",
    label: "Lecture notes",
    body: (today) =>
      [
        `**Date:** ${today}`,
        "",
        "## Main ideas",
        "",
        "- {cursor}",
        "",
        "## Definitions",
        "",
        "## Examples",
        "",
        "## Questions to ask",
        "",
        "- [ ] ",
        "",
      ].join("\n"),
  },
  {
    id: "problem-set",
    label: "Problem-set log",
    body: (today) =>
      [
        `**Started:** ${today}`,
        "",
        "## Questions",
        "",
        "- [ ] Question 1{cursor}",
        "- [ ] Question 2",
        "",
        "## Where I got stuck",
        "",
        "## What worked",
        "",
      ].join("\n"),
  },
  {
    id: "exam",
    label: "Exam review",
    body: () =>
      [
        "**Exam:** {cursor}",
        "",
        "## Topics",
        "",
        "- [ ] ",
        "",
        "## Practice problems",
        "",
        "## Mistakes to avoid",
        "",
        "## Formulas",
        "",
        "#exam",
        "",
      ].join("\n"),
  },
];

/** Whether a note has nothing yet past its title line. */
export function onlyTitle(content: string): boolean {
  const lines = content.split("\n");
  const title = lines.findIndex((line) => line.trim());
  return (
    title === -1 ||
    !lines
      .slice(title + 1)
      .join("")
      .trim()
  );
}
