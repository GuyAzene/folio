/**
 * An assignment as its own record, not only a PDF with a due date: any piece of coursework (a
 * problem set, a reading, exam prep, a project) moving through To do, Doing, Submitted and Done,
 * with the files it came with and, once handed in, the student's submissions, the grade and the
 * feedback. Late, overdue and extended are worked out from its dates, never set by hand.
 */

export const ASSIGNMENT_KINDS = [
  "problem_set",
  "reading",
  "project",
  "lab",
  "quiz",
  "exam",
  "exam_prep",
  "presentation",
  "other",
] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

export const ASSIGNMENT_STATUSES = ["todo", "doing", "submitted", "done"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** A file kept with an assignment, copied in and made read-only. */
export interface AssignmentFile {
  id: string;
  name: string;
  size: number;
  sha256: string;
  addedAt: string;
}

/** One hand-in: the files as submitted, never changed afterwards. */
export interface AssignmentAttempt {
  id: string;
  submittedAt: string;
  files: AssignmentFile[];
  note: string;
}

export interface AssignmentRecord {
  version: 1;
  id: string;
  courseId: string;
  title: string;
  kind: AssignmentKind;
  status: AssignmentStatus;
  /** When it is due; a date without a time is due at the end of that day. */
  dueAt: string | null;
  dueHasTime: boolean;
  /** The due date before an extension, when there was one. */
  originalDueAt: string | null;
  excused: boolean;
  /** The library documents it came with: what was handed out, and the official solution. */
  documents: { statement: string | null; solution: string | null };
  steps: { id: string; text: string; done: boolean }[];
  /** Study-notes topics it covers. */
  topics: string[];
  attempts: AssignmentAttempt[];
  grade: { score: number | null; max: number | null; text: string };
  feedback: { text: string; files: AssignmentFile[] };
  reflection: string;
  /** When it last moved to Done, so old finished work can fold away. */
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** What the student can change directly; files and attempts have their own operations. */
export type AssignmentPatch = Partial<
  Pick<
    AssignmentRecord,
    | "title"
    | "kind"
    | "status"
    | "dueAt"
    | "dueHasTime"
    | "excused"
    | "documents"
    | "steps"
    | "topics"
    | "grade"
    | "reflection"
  >
> & {
  /** A new due date granted as an extension: the first one keeps the original date. */
  extendTo?: string;
  feedbackText?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDate = (value: unknown): value is string =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const id = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const optionalId = (value: unknown) => value === null || id(value);
const optionalDate = (value: unknown) => value === null || isoDate(value);
const score = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);

function validFile(value: unknown): value is AssignmentFile {
  const file = value as AssignmentFile;
  return (
    !!file &&
    id(file.id) &&
    text(file.name, 255) &&
    !!file.name &&
    !/[/\\]/.test(file.name) &&
    Number.isInteger(file.size) &&
    /^[0-9a-f]{64}$/.test(file.sha256) &&
    isoDate(file.addedAt)
  );
}

export function validAssignment(value: unknown): value is AssignmentRecord {
  const a = value as AssignmentRecord;
  return (
    !!a &&
    typeof a === "object" &&
    a.version === 1 &&
    id(a.id) &&
    id(a.courseId) &&
    text(a.title, 200) &&
    !!a.title.trim() &&
    ASSIGNMENT_KINDS.includes(a.kind) &&
    ASSIGNMENT_STATUSES.includes(a.status) &&
    optionalDate(a.dueAt) &&
    typeof a.dueHasTime === "boolean" &&
    optionalDate(a.originalDueAt) &&
    typeof a.excused === "boolean" &&
    !!a.documents &&
    optionalId(a.documents.statement) &&
    optionalId(a.documents.solution) &&
    Array.isArray(a.steps) &&
    a.steps.length <= 100 &&
    a.steps.every(
      (step) => id(step.id) && text(step.text, 500) && typeof step.done === "boolean",
    ) &&
    Array.isArray(a.topics) &&
    a.topics.every((topic) => text(topic, 200)) &&
    Array.isArray(a.attempts) &&
    a.attempts.every(
      (attempt) =>
        id(attempt.id) &&
        isoDate(attempt.submittedAt) &&
        Array.isArray(attempt.files) &&
        attempt.files.every(validFile) &&
        text(attempt.note, 2_000),
    ) &&
    !!a.grade &&
    score(a.grade.score) &&
    score(a.grade.max) &&
    text(a.grade.text, 100) &&
    !!a.feedback &&
    text(a.feedback.text, 20_000) &&
    Array.isArray(a.feedback.files) &&
    a.feedback.files.every(validFile) &&
    text(a.reflection, 20_000) &&
    optionalDate(a.finishedAt) &&
    isoDate(a.createdAt) &&
    isoDate(a.updatedAt) &&
    Number.isInteger(a.revision) &&
    a.revision >= 1
  );
}

/** Applies what the student changed, keeping what code derives consistent. */
export function patchAssignment(
  current: AssignmentRecord,
  patch: AssignmentPatch,
  now = new Date(),
): AssignmentRecord {
  const next: AssignmentRecord = { ...current };
  for (const key of [
    "title",
    "kind",
    "dueAt",
    "dueHasTime",
    "excused",
    "documents",
    "steps",
    "topics",
    "grade",
    "reflection",
  ] as const)
    if (patch[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = patch[key];
  if (patch.title !== undefined) next.title = patch.title.replace(/\s+/g, " ").trim();
  if (patch.extendTo !== undefined) {
    next.originalDueAt = current.originalDueAt ?? current.dueAt;
    next.dueAt = patch.extendTo;
  }
  if (patch.feedbackText !== undefined)
    next.feedback = { ...next.feedback, text: patch.feedbackText };
  if (patch.status !== undefined && patch.status !== current.status) {
    next.status = patch.status;
    next.finishedAt = patch.status === "done" ? now.toISOString() : null;
  }
  return next;
}

/** What a card shows about its dates, worked out from them rather than set by hand. */
export interface AssignmentBadges {
  overdue: boolean;
  late: boolean;
  extended: boolean;
  excused: boolean;
}

export function assignmentBadges(
  record: Pick<AssignmentRecord, "dueAt" | "attempts" | "excused" | "status" | "originalDueAt">,
  now = new Date(),
): AssignmentBadges {
  const due = record.dueAt ? Date.parse(record.dueAt) : null;
  const first = record.attempts[0] ? Date.parse(record.attempts[0].submittedAt) : null;
  return {
    overdue:
      !record.excused &&
      due !== null &&
      due < now.getTime() &&
      (record.status === "todo" || record.status === "doing"),
    late: !record.excused && due !== null && first !== null && first > due,
    extended: record.originalDueAt !== null && record.originalDueAt !== record.dueAt,
    excused: record.excused,
  };
}

/** Finished work older than this folds away on the board. */
export const DONE_FOLDS_AFTER_DAYS = 21;
