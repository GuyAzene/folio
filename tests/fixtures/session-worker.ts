// A disposable provider that never completes, used to kill an actual process
// after an autosaved streaming update. It never authenticates or uses a network.
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { Conversation } from "../../src/conversation.ts";
import { createSessionStore } from "../../src/session-store.ts";
import { DEFAULT_MODEL } from "../../src/agents.ts";

const catalog = createModels();
catalog.setProvider(openaiProvider());
const model = catalog.getModel("openai", DEFAULT_MODEL)!;
const partial: AssistantMessage = {
  role: "assistant",
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [{ type: "text", text: "A saved partial explanation." }],
  timestamp: Date.now(),
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

const conversation = await Conversation.open({
  store: await createSessionStore(),
  newSession: true,
  resolveModel: () => model,
  streamFn: () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...partial, content: [] } });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "A saved partial explanation.",
      partial,
    });
    return stream;
  },
});
await conversation.setFocus(2);
conversation.subscribe((event) => {
  if (event.type === "message_update")
    console.log(JSON.stringify({ id: conversation.snapshot.id }));
});
setInterval(() => {}, 1_000);
await conversation.send("Synthetic question before process death.");
