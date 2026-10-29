import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * How much of each request the provider read from its cache, from the usage every saved reply
 * records. A request whose start repeats an earlier one costs less and answers sooner, so this is
 * how a change to the prompt or the history is measured rather than assumed.
 */
export interface RequestUsage {
  /** Everything the request sent, cached or not. */
  input: number;
  cached: number;
}

export interface ChatUsage {
  id: string;
  title: string;
  requests: RequestUsage[];
}

/** One entry per provider request in a chat, in order: each reply message is one request. */
export function requestsOf(messages: readonly AgentMessage[]): RequestUsage[] {
  return messages.flatMap((message) =>
    message.role === "assistant" && message.usage
      ? [
          {
            // Pi reports `input` without the cached part.
            input: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
            cached: message.usage.cacheRead,
          },
        ]
      : [],
  );
}

function share(requests: RequestUsage[]): string {
  const input = requests.reduce((sum, request) => sum + request.input, 0);
  const cached = requests.reduce((sum, request) => sum + request.cached, 0);
  return input ? `${Math.round((cached / input) * 100)}%` : "–";
}

const number = (value: number) => value.toLocaleString("en-US");

/**
 * A plain-text table. "Later" leaves out each chat's first request, which can never be cached
 * because nothing came before it.
 */
export function cacheTable(chats: ChatUsage[]): string {
  const rows = chats
    .filter((chat) => chat.requests.length)
    .map((chat) => [
      chat.title.length > 40 ? `${chat.title.slice(0, 39)}…` : chat.title,
      number(chat.requests.length),
      number(chat.requests.reduce((sum, request) => sum + request.input, 0)),
      share(chat.requests),
      share(chat.requests.slice(1)),
    ]);
  if (!rows.length) return "No saved replies yet.";
  const all = chats.flatMap((chat) => chat.requests);
  const later = chats.flatMap((chat) => chat.requests.slice(1));
  const table = [
    ["Chat", "Requests", "Input tokens", "From cache", "Later"],
    ...rows,
    [
      "All chats",
      number(all.length),
      number(all.reduce((sum, request) => sum + request.input, 0)),
      share(all),
      share(later),
    ],
  ];
  const widths = table[0]!.map((_, column) => Math.max(...table.map((row) => row[column]!.length)));
  return table
    .map((row) =>
      row.map((cell, column) =>
        column ? cell.padStart(widths[column]!) : cell.padEnd(widths[0]!),
      ),
    )
    .map((row) => row.join("  "))
    .join("\n");
}

/** One chat, request by request. */
export function requestTable(chat: ChatUsage): string {
  if (!chat.requests.length) return `${chat.title}: no saved replies yet.`;
  return [
    chat.title,
    ...chat.requests.map(
      (request, index) =>
        `${String(index + 1).padStart(3)}  ${number(request.input).padStart(9)} in  ${number(request.cached).padStart(9)} cached  ${share([request]).padStart(4)}`,
    ),
  ].join("\n");
}
