import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import type { AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type AuthInteraction, type AuthPrompt } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createFolioModels, readConnectionStatus } from "./auth.ts";
import { cacheTable, requestsOf, requestTable } from "./cache-report.ts";
import { Conversation } from "./conversation.ts";
import { folioModel } from "./model-catalog.ts";
import { DEFAULT_DEMO_PROMPT, readDemoPage } from "./demo-source.ts";
import { DEFAULT_MODEL } from "./agents.ts";
import { createSessionStore, type SessionStore } from "./session-store.ts";
import { askTerminalQuestion, TerminalInputCancelledError } from "./terminal.ts";
import { prepareHome } from "./home.ts";

const HELP = `Folio · terminal client

  vp run login                 Continue with ChatGPT (your plan)
  vp run status                Check local connection, without a request
  vp run demo                  Stream a synthetic page explanation with a tool
  vp run start                 Chat in this terminal
  vp run start --new           Start another conversation; preserve the old one
  vp run start --resume <id>   Open a saved conversation (offline viewing works)
  vp run sessions              List saved conversations without an account
  vp run cache [--chat <id>]   How much of each request the provider reused from its cache
  vp run start --prompt "..."   Send one prompt and exit
  vp run models                Show Pi's bundled model catalog
  vp run logout                Remove Folio's local credentials
  vp run start --page 1         Read the synthetic page offline

Options: --model <id> (new-session default: ${DEFAULT_MODEL}), --new, --resume <id>, --help
Chat commands: /quit, /new (/reset), /sessions, /resume <id>, /page 1|2.
Ctrl+C cancels a reply; at the prompt it exits. Conversation and page focus autosave locally.
Startup resumes your latest conversation. Sources are synthetic; no learning assessment is saved.
`;

function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    execFile("open", [url], (error) => {
      if (error) console.error("Open the sign-in URL above in your browser.");
    });
  }
}

async function loginPrompt(
  prompt: AuthPrompt,
  cancelLogin: () => void,
  loginSignal: AbortSignal,
): Promise<string> {
  prompt.signal?.throwIfAborted();
  if (prompt.type === "select") {
    throw new Error("Folio supports ChatGPT browser sign-in only.");
  }
  return askTerminalQuestion(`${prompt.message}\n> `, {
    signal: prompt.signal ? AbortSignal.any([prompt.signal, loginSignal]) : loginSignal,
    onCancel: cancelLogin,
  });
}

function renderEvent(event: AgentEvent): void {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  } else if (event.type === "tool_execution_start") {
    console.log(`\n[Reading synthetic course page with ${event.toolName}]`);
  } else if (event.type === "tool_execution_end" && event.isError) {
    console.error("[Page read rejected]");
  } else if (event.type === "message_end" && event.message.role === "assistant") {
    console.log();
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function renderHistory(messages: readonly AgentMessage[]): void {
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      const text = contentText(message.content);
      if (text) console.log(`${message.role === "user" ? "You" : "Folio"} > ${text}\n`);
      if (message.role === "assistant" && ["error", "aborted"].includes(message.stopReason)) {
        console.log(`[Saved reply ${message.stopReason === "aborted" ? "cancelled" : "failed"}]`);
      }
    } else if (message.role === "toolResult") {
      const anchor = contentText(message.content).split("\n")[0];
      console.log(
        message.isError
          ? `[${message.toolName}: rejected]`
          : `[${message.toolName}${anchor?.startsWith("demo:") ? ` → ${anchor}` : ": completed"}]`,
      );
    }
  }
}

function renderConversation(conversation: Conversation): void {
  const saved = conversation.snapshot;
  console.log(
    `\nSession: ${saved.id}\n${saved.title}\nModel: ${saved.modelId} · ${saved.focus ? `demo page ${saved.focus.page}` : "plain chat"} · ${saved.status}\n`,
  );
  if (conversation.resumed) {
    console.log("[Restored saved conversation]\n");
    renderHistory(saved.messages);
    if (saved.partialAssistant) {
      const text = contentText(saved.partialAssistant.content);
      if (text) console.log(`[Partial reply from the interrupted run]\n${text}\n`);
    }
  }
  if (saved.status === "interrupted" || saved.status === "running") {
    console.log("[Previous reply was interrupted. No model request was restarted.]\n");
  }
}

async function listSavedSessions(store: SessionStore, currentId?: string): Promise<void> {
  const sessions = await store.list();
  if (sessions.length === 0) console.log("No saved conversations yet.");
  for (const session of sessions) {
    console.log(
      `${session.id === currentId ? "* " : ""}${session.id}  ${session.title}  [${session.status}; ${session.focus ? `page ${session.focus.page}` : "plain chat"}; ${session.updatedAt}]`,
    );
  }
  await warnUnavailableSessions(store);
}

/** Reads saved chats only: no account, no request. */
async function reportCache(store: SessionStore, chatId?: string): Promise<void> {
  const usage = async (id: string) => {
    const record = await store.load(id);
    return { id, title: record.title, requests: requestsOf(record.messages) };
  };
  if (chatId) {
    console.log(requestTable(await usage(chatId)));
    return;
  }
  const sessions = await store.list();
  console.log(cacheTable(await Promise.all(sessions.map((session) => usage(session.id)))));
}

async function warnUnavailableSessions(store: SessionStore): Promise<void> {
  for (const unavailable of await store.listUnavailable()) {
    console.error(`[Saved session ${unavailable.id} is unavailable: ${unavailable.error}]`);
  }
}

async function sendPrompt(
  conversation: Conversation,
  text: string,
  ensureConnected: () => Promise<void>,
): Promise<void> {
  await ensureConnected();
  const cancel = () => conversation.cancel();
  process.once("SIGINT", cancel);
  try {
    await conversation.send(text);
    const last = conversation.snapshot.messages.findLast((message) => message.role === "assistant");
    if (last?.role === "assistant" && last.stopReason === "aborted") {
      console.log("[Reply cancelled]");
    } else if (last?.role === "assistant" && last.stopReason === "error") {
      throw new Error(last.errorMessage ?? "Provider request failed.");
    } else if (last?.role === "assistant" && last.stopReason === "length") {
      console.log("[Reply reached the model's output limit]");
    }
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

type OpenConversation = (options: {
  id?: string;
  newSession?: boolean;
  modelId?: string;
}) => Promise<Conversation>;

async function chat(
  initial: Conversation,
  store: SessionStore,
  openConversation: OpenConversation,
  ensureConnected: () => Promise<void>,
): Promise<void> {
  let current = initial;
  console.log(
    "Folio · synthetic demo course · autosaved locally\n/quit, /new, /sessions, /resume <id>, /page 1|2.\n",
  );
  try {
    // Readline pauses during generation so Ctrl+C reaches the active conversation.
    while (true) {
      let text: string;
      try {
        text = (await askTerminalQuestion("You > ")).trim();
      } catch (error) {
        if (error instanceof TerminalInputCancelledError) return;
        throw error;
      }
      if (text === "/quit") return;
      if (!text) continue;
      try {
        if (text === "/sessions") {
          await listSavedSessions(store, current.snapshot.id);
        } else if (text === "/new" || text === "/reset" || text.startsWith("/resume ")) {
          const id = text.startsWith("/resume ") ? text.slice(8).trim() : undefined;
          if (id === current.snapshot.id) {
            renderConversation(current);
            continue;
          }
          const next = await openConversation(
            id ? { id } : { newSession: true, modelId: current.snapshot.modelId },
          );
          try {
            await current.close();
          } catch (error) {
            await next.close();
            throw error;
          }
          current = next;
          renderConversation(current);
        } else if (text.startsWith("/page ")) {
          const page = await current.setFocus(Number(text.slice(6).trim()));
          console.log(`${page.title}\n${page.anchor}\n\n${page.text}\n`);
        } else if (text.startsWith("/")) {
          console.error("Commands: /quit, /new (/reset), /sessions, /resume <id>, /page 1|2.");
        } else {
          await sendPrompt(current, text, ensureConnected);
        }
      } catch (error) {
        console.error(`Folio: ${error instanceof Error ? error.message : "Request failed"}`);
      }
    }
  } finally {
    await current.close();
  }
}

async function main(): Promise<void> {
  prepareHome();
  const { values, positionals } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      model: { type: "string" },
      prompt: { type: "string" },
      page: { type: "string" },
      new: { type: "boolean" },
      resume: { type: "string" },
      chat: { type: "string" },
    },
    allowPositionals: true,
  });
  const command = positionals[0] ?? "chat";
  if (positionals.length > 1) throw new Error("Use --prompt for a single message.");
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (
    ![
      "chat",
      "resume",
      "sessions",
      "cache",
      "demo",
      "login",
      "logout",
      "status",
      "models",
    ].includes(command)
  ) {
    throw new Error(`Unknown command '${command}'. Run vp run start --help.`);
  }
  if (values.resume !== undefined && !values.resume.trim()) {
    throw new Error("Provide a saved session UUID after --resume.");
  }
  if (values.new && values.resume) throw new Error("Choose --new or --resume, not both.");
  if ((values.new || values.resume) && !["chat", "resume", "demo"].includes(command)) {
    throw new Error("Use --new or --resume with start, resume, or demo.");
  }
  if (values.page !== undefined) {
    const page = readDemoPage({ courseId: "demo", page: Number(values.page) });
    console.log(`${page.title}\n${page.anchor}\n\n${page.text}`);
    return;
  }
  if (command === "sessions") {
    await listSavedSessions(await createSessionStore());
    return;
  }
  if (command === "cache") {
    await reportCache(await createSessionStore(), values.chat);
    return;
  }

  if (["status", "models", "logout", "login"].includes(command)) {
    const { models, store } = await createFolioModels();
    if (command === "status") {
      const status = await readConnectionStatus(store);
      console.log(
        status.connected
          ? "ChatGPT connection saved (local status; no network check)."
          : "ChatGPT is not connected. Run vp run login.",
      );
      console.log(`Private connection storage: ${store.home}`);
      return;
    }
    if (command === "models") {
      console.log("Pi's bundled OpenAI model catalog; availability depends on your account.\n");
      for (const model of models.getModels("openai")) console.log(`${model.id}\t${model.name}`);
      return;
    }
    if (command === "logout") {
      await models.logout("openai");
      console.log("Folio's local ChatGPT credentials removed.");
      return;
    }
    if (command === "login") {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      const interaction: AuthInteraction = {
        signal: controller.signal,
        prompt: (prompt) => loginPrompt(prompt, cancel, controller.signal),
        notify(event) {
          if (event.type === "auth_url") {
            console.log(`Continue with ChatGPT:\n${event.url}\n`);
            openBrowser(event.url);
          } else if (event.type === "info") {
            console.log(event.message);
            for (const link of event.links ?? [])
              console.log(`${link.label ?? "More information"}: ${link.url}`);
          } else if (event.type === "progress") {
            console.log(event.message);
          } else if (event.type === "device_code") {
            console.log(`Enter ${event.userCode} at ${event.verificationUri}`);
          }
        },
      };
      try {
        await models.login("openai", "oauth", interaction, {
          getDeviceId: store.getDeviceId,
          agentName: "Folio",
        });
        console.log("ChatGPT connected. Run vp run demo to test a real reply.");
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        console.log("[Sign-in cancelled]");
      } finally {
        process.removeListener("SIGINT", cancel);
      }
      return;
    }
  }

  const store = await createSessionStore();
  await warnUnavailableSessions(store);
  const catalog = createModels();
  catalog.setProvider(openaiProvider());
  let connectionPromise: ReturnType<typeof createFolioModels> | undefined;
  const getConnection = () => (connectionPromise ??= createFolioModels());
  const ensureConnected = async () => {
    if (!(await readConnectionStatus((await getConnection()).store)).connected) {
      throw new Error("Connect your ChatGPT account first: vp run login");
    }
  };
  const streamFn: StreamFn = async (model, context, options) =>
    (await getConnection()).models.streamSimple(model, context, options);
  const openConversation: OpenConversation = async (options) => {
    const conversation = await Conversation.open({
      store,
      ...options,
      streamFn,
      resolveModel(modelId) {
        const model = folioModel(catalog, modelId);
        if (!model)
          throw new Error(`Model '${modelId}' is absent from Pi's catalog. Run vp run models.`);
        return model;
      },
    });
    conversation.subscribe(renderEvent);
    return conversation;
  };
  const conversation = await openConversation({
    id: values.resume,
    newSession: values.new || (command === "demo" && !values.resume),
    modelId: values.model,
  });
  renderConversation(conversation);
  if (command === "demo" || values.prompt !== undefined || !process.stdin.isTTY) {
    try {
      if (command === "demo" || values.prompt !== undefined) {
        await sendPrompt(conversation, values.prompt ?? DEFAULT_DEMO_PROMPT, ensureConnected);
      }
    } finally {
      await conversation.close();
    }
    return;
  }
  await chat(conversation, store, openConversation, ensureConnected);
}

main().catch((error: unknown) => {
  console.error(`Folio: ${error instanceof Error ? error.message : "Unexpected failure"}`);
  process.exitCode = 1;
});
