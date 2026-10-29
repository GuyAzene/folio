import type { AgentStatus, CourseView, DocumentRole, Pencil } from "../../src/desktop/api.ts";
import type { AssignmentKind, AssignmentStatus } from "../../src/library/assignments.ts";
import type { Location } from "./state.svelte.ts";
import { folio } from "./state.svelte.ts";

export const PENCIL: Record<Pencil, string> = {
  graphite: "#3f3f46",
  blue: "#2b59c3",
  red: "#d3392b",
  green: "#1e8e4e",
  violet: "#6e4bd8",
  orange: "#e0700f",
  teal: "#0f8a8a",
  pink: "#d23f7e",
};
export const PENCILS = Object.keys(PENCIL) as Pencil[];

export const ROLE_LABEL: Record<DocumentRole, string> = {
  lecture: "Lecture",
  recitation: "Recitation",
  assignment: "Assignment",
  solution: "Official solution",
  asset: "Asset",
};
export const ROLE_DOT: Record<DocumentRole, string> = {
  lecture: "var(--ink)",
  recitation: PENCIL.blue,
  assignment: PENCIL.orange,
  solution: PENCIL.green,
  asset: "#a1a1aa",
};
export const ROLES = Object.keys(ROLE_LABEL) as DocumentRole[];

/** The course's monogram for its tile: the first letter of its first word. */
export function glyph(course: Pick<CourseView, "name">): string {
  return course.name.trim().charAt(0).toUpperCase() || "·";
}

export function tabTitle(location: Location): string {
  switch (location.view) {
    case "home":
      return "Home";
    case "library":
      return "Library";
    case "chats":
      return "Chats";
    case "assignments":
      return "Assignments";
    case "jobs":
      return "Studying";
    case "trash":
      return "Trash";
    case "course":
      return folio.course(location.courseId)?.name ?? "Course";
    case "document":
      return folio.document(location.documentId)?.title ?? "Document";
    case "note":
      return folio.note(location.noteId)?.title ?? "Note";
    case "study": {
      const notes = folio.studyNotes[location.courseId];
      const [kind, slug] = location.item?.split(":") ?? [];
      const title =
        kind === "topic"
          ? notes?.topics.find((topic) => topic.slug === slug)?.title
          : notes?.sessions.find((session) => session.slug === slug)?.title;
      return title ?? `${folio.course(location.courseId)?.name ?? "Course"} study notes`;
    }
    case "chat":
      return location.chatId
        ? (folio.chats.find((chat) => chat.id === location.chatId)?.title ?? "Chat")
        : "New chat";
  }
}

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const days = Math.round((Date.now() - date.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7 && days > 0) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDue(iso: string | null): string {
  if (!iso) return "No due date";
  const date = new Date(iso);
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  const label = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    // Another year is named, so a date a year out never reads as this year's.
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
  if (days < 0) return `Was due ${label}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due ${label}`;
}

// ── Jobs ──────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<AgentStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Needs you",
  done: "Done",
  failed: "Failed",
  stopped: "Paused",
};

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** A model's display name: the subscription's name for it, else one derived from its ID. */
export function modelLabel(id: string | null): string {
  if (!id) return "Folio";
  const known = folio.modelName(id);
  if (known !== id) return known;
  const gpt = /^gpt-([\d.]+)-([a-z-]+)$/i.exec(id);
  if (gpt) return `GPT-${gpt[1]} ${gpt[2]!.split("-").map(capitalize).join(" ")}`;
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)$/i.exec(id);
  if (claude) return `${capitalize(claude[1]!)} ${claude[2]}.${claude[3]}`;
  return id;
}

export function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

/** 820, 12.3k, 412k, 1.2M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 41s, 3m 12s, 1h 04m. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "Page 8", "Pages 1–3", "Pages 1–2, 5". */
export function formatPages(pages: number[]): string {
  if (!pages.length) return "";
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    ranges.push(end > start ? `${sorted[start]}–${sorted[end]}` : String(sorted[start]));
    start = end + 1;
  }
  return `${sorted.length === 1 ? "Page" : "Pages"} ${ranges.join(", ")}`;
}

// ── Assignments ───────────────────────────────────────────────────────────

export const STATUS_COLUMN: Record<AssignmentStatus, string> = {
  todo: "To do",
  doing: "Doing",
  submitted: "Submitted",
  done: "Done",
};

export const KIND_LABEL: Record<AssignmentKind, string> = {
  problem_set: "Problem set",
  reading: "Reading",
  project: "Project",
  lab: "Lab",
  quiz: "Quiz",
  exam: "Exam",
  exam_prep: "Exam prep",
  presentation: "Presentation",
  other: "Other",
};

/** "Due Fri, Nov 5" or "Due Fri, Nov 5, 14:00" when a time was given. */
export function formatAssignmentDue(dueAt: string | null, hasTime: boolean): string {
  if (!dueAt) return "No due date";
  const base = formatDue(dueAt);
  if (!hasTime || base === "No due date") return base;
  const time = new Date(dueAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${base}, ${time}`;
}
