/**
 * A synthetic MCP server for Folio's tests, with no dependencies: newline-delimited JSON-RPC on
 * stdin and stdout when run as a program, or `serve()` over any pair of message callbacks. Its
 * tools echo, wait, crash, leak a fake token, return images or a long text, and change the tool
 * list. When FIXTURE_LOG is set, each call and the process ID are appended to that file, so a test
 * can tell whether a call ever reached the server.
 */
import { appendFileSync } from "node:fs";

type Message = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: unknown;
};

/** A 1x1 PNG. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
export const FAKE_TOKEN = "synthetic-token-0123456789";
/** A prompt's text names the server's token when it has one, to check that it is hidden. */
const FAKE_TOKEN_NOTE = process.env.SYNTHETIC_TOKEN ? `(token ${process.env.SYNTHETIC_TOKEN})` : "";

const BASE_TOOLS = [
  {
    name: "lookup",
    description: "Looks up a synthetic record.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  { name: "slow", description: "Waits until cancelled.", inputSchema: { type: "object" } },
  { name: "crash", description: "Exits at once.", inputSchema: { type: "object" } },
  { name: "env_names", description: "Names of its environment.", inputSchema: { type: "object" } },
  { name: "leak", description: "Prints a fake token.", inputSchema: { type: "object" } },
  { name: "pictures", description: "Five tiny pictures.", inputSchema: { type: "object" } },
  { name: "big", description: "A long text.", inputSchema: { type: "object" } },
  {
    name: "nested",
    description: "Takes a pydantic-style schema.",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: { Range: { type: "object", properties: { days: { type: "integer" } } } },
      properties: { range: { $ref: "#/$defs/Range" } },
    },
  },
  { name: "change_tools", description: "Adds a tool.", inputSchema: { type: "object" } },
];

export function serve(send: (message: Message) => void, exit: () => void = () => {}) {
  const tools = [...BASE_TOOLS];
  const log = (line: string) => {
    if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, `${line}\n`);
  };
  log(`start ${process.pid}`);
  const text = (value: string) => ({ content: [{ type: "text", text: value }] });
  return function receive(message: Message): void {
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id!, result });
    if (message.method === "initialize")
      return reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
        serverInfo: { name: "synthetic", version: "1.0.0" },
        instructions: "A synthetic server for Folio's tests.",
      });
    if (message.method === "tools/list") return reply({ tools });
    if (message.method === "prompts/list")
      return reply({
        prompts: [
          { name: "weekly_briefing", description: "What is due this week." },
          {
            name: "exam_prep",
            description: "A study plan for an exam.",
            arguments: [
              { name: "course", description: "The course.", required: true },
              { name: "topic", description: "One topic, if any." },
            ],
          },
        ],
      });
    if (message.method === "prompts/get") {
      const { name, arguments: args } = message.params ?? {};
      log(`prompt ${name} ${JSON.stringify(args ?? {})}`);
      if (name === "weekly_briefing")
        return reply({
          messages: [
            { role: "user", content: { type: "text", text: "Summarize what is due this week." } },
          ],
        });
      if (name === "exam_prep") {
        if (!args?.course)
          return send({
            jsonrpc: "2.0",
            id: message.id!,
            error: { code: -32602, message: "course is required" },
          } as never);
        return reply({
          description: "A study plan.",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Plan exam prep for ${args.course}${args.topic ? ` on ${args.topic}` : ""}. ${FAKE_TOKEN_NOTE}`,
              },
            },
          ],
        });
      }
      return send({
        jsonrpc: "2.0",
        id: message.id!,
        error: { code: -32602, message: `No prompt ${name}` },
      } as never);
    }
    if (message.method === "ping") return reply({});
    if (message.method !== "tools/call") return;
    const { name, arguments: args } = message.params ?? {};
    log(`call ${name} ${JSON.stringify(args ?? {})}`);
    if (name === "lookup") return reply(text(`Found: ${args?.query}`));
    if (name === "slow") return;
    if (name === "crash") return exit();
    if (name === "env_names") return reply(text(Object.keys(process.env).sort().join(",")));
    if (name === "leak") {
      process.stderr.write(`debug: using ${FAKE_TOKEN}\n`);
      return reply(text(`The token is ${FAKE_TOKEN}.`));
    }
    if (name === "pictures")
      return reply({
        content: Array.from({ length: 5 }, () => ({
          type: "image",
          data: PIXEL,
          mimeType: "image/png",
        })),
      });
    if (name === "big") return reply(text("x".repeat(200_000)));
    if (name === "nested") return reply(text(`Range: ${JSON.stringify(args?.range ?? null)}`));
    if (name === "change_tools") {
      tools.push({ name: "extra", description: "Added later.", inputSchema: { type: "object" } });
      reply(text("Added a tool."));
      return send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    send({
      jsonrpc: "2.0",
      id: message.id!,
      error: { code: -32601, message: `No tool ${name}` },
    } as never);
  };
}

if (import.meta.main) {
  if (process.env.FIXTURE_IGNORE_TERM) process.on("SIGTERM", () => {});
  const receive = serve(
    (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    () => process.exit(1),
  );
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) receive(JSON.parse(line) as Message);
    }
  });
  // Without FIXTURE_IGNORE_TERM, the server leaves when Folio closes its input.
  process.stdin.on("end", () => {
    if (!process.env.FIXTURE_IGNORE_TERM) process.exit(0);
  });
}
