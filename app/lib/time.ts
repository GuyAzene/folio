import type { ChatSummary } from "../../src/desktop/api.ts";

const DAY = 86_400_000;

export interface ChatGroup {
  label: string;
  chats: ChatSummary[];
}

/** Today, Yesterday, Previous 7 days, then by month. Input is newest first. */
export function groupChats(chats: ChatSummary[], now = new Date()): ChatGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: ChatGroup[] = [];
  for (const chat of chats) {
    const time = Date.parse(chat.updatedAt);
    const label =
      time >= startOfToday
        ? "Today"
        : time >= startOfToday - DAY
          ? "Yesterday"
          : time >= startOfToday - 7 * DAY
            ? "Previous 7 days"
            : new Date(time).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const last = groups.at(-1);
    if (last?.label === label) last.chats.push(chat);
    else groups.push({ label, chats: [chat] });
  }
  return groups;
}
