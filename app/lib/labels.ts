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
    case "notes":
      return folio.note(location.noteId)?.title ?? "Notes";
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

/**
 * When a note last changed, as a notes list shows it: the time today, the weekday this week,
 * then the date, with the year once it is another year's.
 */
export function noteTime(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.round((day(now).getTime() - day(date).getTime()) / 86_400_000);
  if (days === 0) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** How long ago something happened, for "Pick up": minutes, hours, then days. */
export function since(iso: string, now = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "An hour ago" : `${hours} hours ago`;
  return formatDate(iso);
}

/** The heading a note falls under in a list sorted by its last change, newest first. */
export function noteGroup(iso: string | null, now = new Date()): string {
  if (!iso) return "Earlier";
  const date = new Date(iso);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = date.getTime();
  if (at >= start) return "Today";
  if (at >= start - 86_400_000) return "Yesterday";
  if (at >= start - 7 * 86_400_000) return "Previous 7 days";
  if (at >= start - 30 * 86_400_000) return "Previous 30 days";
  if (date.getFullYear() === now.getFullYear())
    return date.toLocaleDateString(undefined, { month: "long" });
  return String(date.getFullYear());
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

/**
 * A due date as a student reads it: "Today", "Tomorrow", a weekday this week, "in 9 days", or the
 * date; past dates say how late. The time shows only when one was set.
 */
export function relativeDue(dueAt: string, hasTime: boolean, now = new Date()): string {
  const due = new Date(dueAt);
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(due) - day(now)) / 86_400_000);
  const time = hasTime
    ? ` ${due.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : "";
  if (days < -1) return `${-days} days late`;
  if (days === -1) return "Yesterday";
  if (days === 0) return `Today${time}`;
  if (days === 1) return `Tomorrow${time}`;
  if (days < 7) return `${due.toLocaleDateString(undefined, { weekday: "short" })}${time}`;
  if (days < 15) return `in ${days} days`;
  return due.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(due.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}
