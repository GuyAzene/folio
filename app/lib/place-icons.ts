import {
  BookMarked,
  BookOpen,
  FileText,
  Highlighter,
  House,
  ListChecks,
  MessageSquare,
  MessagesSquare,
  NotebookPen,
  Trash2,
} from "@lucide/svelte";

/** Each kind of place's icon, in a tab and a pane's header; a course shows its own tile. */
export const PLACE_ICONS = {
  home: House,
  library: BookOpen,
  chats: MessagesSquare,
  assignments: ListChecks,
  jobs: Highlighter,
  document: FileText,
  notes: NotebookPen,
  study: BookMarked,
  trash: Trash2,
  chat: MessageSquare,
  course: null,
};
