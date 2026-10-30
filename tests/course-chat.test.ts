import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Conversation, questionText } from "../src/conversation.ts";
import { randomUUID } from "node:crypto";
import { createAttach } from "../src/library/attachments.ts";
import { createRuntimes } from "../src/library/course-tools.ts";
import { PageReader } from "../src/library/page-reader.ts";
import { CITING_RULE, TEACHING_RULES } from "../src/library/tutoring.ts";
import { LibraryStore } from "../src/library/store.ts";
import { createSessionStore, type SessionStore } from "../src/session-store.ts";
import { modelContextMessages } from "../src/transcript.ts";
import { SYNTHETIC_LECTURE, syntheticPdf } from "./fixtures/synthetic-pdf.ts";

const model: Model<Api> = {
  id: "synthetic-model",
  name: "Synthetic model",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://synthetic.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 1024,
};
const homes: string[] = [];
const conversations: Conversation[] = [];

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function completed(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({
    type: "done",
    reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
    message,
  });
  return stream;
}

/** First request asks for a page; the second answers in text. */
function readThenAnswer(args: Record<string, unknown>, requests: TranscriptContext[]): StreamFn {
  return (_model, context) => {
    requests.push(structuredClone(context));
    return completed(
      requests.length % 2 === 1
        ? assistant(
            [
              {
                type: "toolCall",
                id: `call_${requests.length}`,
                name: "read_page",
                arguments: args as never,
              },
            ],
            "toolUse",
          )
        : assistant([{ type: "text", text: "Answered from the page." }]),
    );
  };
}

async function setup() {
  const home = await mkdtemp(resolve(tmpdir(), "folio-course-chat-test-"));
  homes.push(home);
  const pdf = resolve(home, "lecture1.pdf");
  await writeFile(pdf, syntheticPdf(SYNTHETIC_LECTURE));
  const data = resolve(home, "data");
  const library = await LibraryStore.open({ home: data });
  const store: SessionStore = await createSessionStore({ home: data });
  const algorithms = await library.createCourse({ name: "Algorithms", code: "CS 201" });
  const other = await library.createCourse({ name: "Private course" });
  const lecture = (await library.importFile(algorithms.id, pdf)).document;
  const elsewhere = (await library.importFile(other.id, pdf)).document;
  const runtimes = createRuntimes(library);
  const open = async (
    streamFn: StreamFn,
    options: Partial<Parameters<typeof Conversation.open>[0]>,
  ) => {
    const conversation = await Conversation.open({
      store,
      streamFn,
      resolveModel: () => model,
      modelId: model.id,
      courseRuntime: runtimes.course,
      libraryRuntime: runtimes.library,
      ...options,
    });
    conversations.push(conversation);
    return conversation;
  };
  return { home, library, store, algorithms, other, lecture, elsewhere, runtimes, open };
}

afterEach(async () => {
  await Promise.allSettled(conversations.splice(0).map((conversation) => conversation.close()));
  for (const home of homes.splice(0)) {
    await chmod(home, 0o700).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});

describe("course chats", () => {
  it("reads a page of its own course, told the course and the page in view", async () => {
    const { algorithms, lecture, open } = await setup();
    const requests: TranscriptContext[] = [];
    const chat = await open(readThenAnswer({ documentId: lecture.id, page: 2 }, requests), {
      newSession: true,
      kind: "course",
      courseId: algorithms.id,
      focus: { documentId: lecture.id, page: 2 },
    });
    expect(chat.kind).toBe("course");
    await chat.send("Why only once?", randomUUID(), { focus: { documentId: lecture.id, page: 2 } });
    expect(getCurrentTools(requests[0]!.messages).map((tool) => tool.name)).toEqual([
      "list_documents",
      "read_page",
    ]);
    const prompt = JSON.stringify(requests[0]!.messages[0]);
    expect(prompt).toContain('course \\"Algorithms\\" (CS 201)');
    expect(prompt).not.toContain("page 2 of 3");
    expect(JSON.stringify(requests[0]!.messages[1])).toContain(
      'The student is reading \\"lecture1\\", page 2 of 3.',
    );
    const result = chat.snapshot.messages.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({ isError: false, details: { title: "lecture1", page: 2 } });
    expect(JSON.stringify(result)).toContain("enqueued at most once");
  });

  it.each([
    ["another course's document", "elsewhere", 1, {}],
    ["a page past the end", "lecture", 9, {}],
    ["an invented argument", "lecture", 1, { path: "/etc/passwd" }],
  ])("rejects %s regardless of the prompt", async (_name, which, page, extra) => {
    const setupResult = await setup();
    const document = which === "elsewhere" ? setupResult.elsewhere : setupResult.lecture;
    const requests: TranscriptContext[] = [];
    const chat = await setupResult.open(
      readThenAnswer({ documentId: document.id, page, ...extra }, requests),
      { newSession: true, kind: "course", courseId: setupResult.algorithms.id },
    );
    await chat.send("Read it anyway.");
    const result = chat.snapshot.messages.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain("enqueued");
  });

  it("keeps its focus across reopen and refuses focus outside the course", async () => {
    const { store, algorithms, lecture, elsewhere, open } = await setup();
    const chat = await open(readThenAnswer({}, []), {
      newSession: true,
      kind: "course",
      courseId: algorithms.id,
    });
    await chat.setCourseFocus({ documentId: lecture.id, page: 3 });
    await expect(chat.setCourseFocus({ documentId: elsewhere.id, page: 1 })).rejects.toThrow(
      "not part of this chat",
    );
    await expect(chat.setCourseFocus({ documentId: lecture.id, page: 4 })).rejects.toThrow();
    const id = chat.snapshot.id;
    await chat.close();
    expect((await store.load(id)).focus).toEqual({ documentId: lecture.id, page: 3 });
    const reopened = await open(readThenAnswer({}, []), { id, allowedKinds: ["chat", "course"] });
    expect(reopened.snapshot.focus).toEqual({ documentId: lecture.id, page: 3 });
    await reopened.close();
    await expect(open(readThenAnswer({}, []), { id, kind: "chat" })).rejects.toThrow(
      "belongs to a course",
    );
  });
});

describe("library chats", () => {
  it("read a page of any course, with every course listed in the prompt", async () => {
    const { elsewhere, open } = await setup();
    const requests: TranscriptContext[] = [];
    const chat = await open(readThenAnswer({ documentId: elsewhere.id, page: 2 }, requests), {
      newSession: true,
      kind: "library",
    });
    expect(chat.kind).toBe("library");
    expect(chat.snapshot.scope).toEqual({ courseId: null, library: 1 });
    await chat.send("Why is each vertex enqueued once in my private course?");
    const prompt = JSON.stringify(requests[0]!.messages[0]);
    expect(prompt).toContain("Algorithms (CS 201");
    expect(prompt).toContain("Private course (");
    expect(prompt).toContain("Work out from the student's message which course");
    const result = chat.snapshot.messages.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({ isError: false, details: { page: 2 } });
    expect(JSON.stringify(result)).toContain("Private course · lecture1");
  });

  it("check every argument against the library, not the prompt", async () => {
    const { runtimes, other } = await setup();
    const { tools } = await runtimes.library(randomUUID());
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    await expect(
      tool("read_page").execute("call_1", { documentId: randomUUID(), page: 1 }),
    ).rejects.toThrow("not in your library");
    await expect(tool("list_documents").execute("call_2", {})).rejects.toThrow();
    await expect(
      tool("list_documents").execute("call_3", { courseId: randomUUID() }),
    ).rejects.toThrow("not in your library");
    await expect(
      tool("list_documents").execute("call_4", { courseId: other.id, path: "/" } as never),
    ).rejects.toThrow("accepts only");
    const listed = await tool("list_documents").execute("call_5", { courseId: other.id });
    expect(JSON.stringify(listed.content)).toContain("lecture1");
  });

  it("reopen only as library chats and follow no page", async () => {
    const { lecture, open } = await setup();
    const chat = await open(readThenAnswer({}, []), { newSession: true, kind: "library" });
    await expect(chat.setCourseFocus({ documentId: lecture.id, page: 1 })).rejects.toThrow(
      "do not follow a page",
    );
    const id = chat.snapshot.id;
    await chat.close();
    const reopened = await open(readThenAnswer({}, []), { id, allowedKinds: ["library"] });
    expect(reopened.kind).toBe("library");
    await reopened.close();
    await expect(open(readThenAnswer({}, []), { id, kind: "course" })).rejects.toThrow(
      "reads your course library",
    );
  });
});

describe("pages as images", () => {
  it("show the tutor the page itself, and only pages of its own course", async () => {
    const { runtimes, algorithms, lecture, elsewhere } = await setup();
    const { tools } = await runtimes.course(algorithms.id, randomUUID());
    const readPage = tools.find((candidate) => candidate.name === "read_page")!;
    const result = await readPage.execute("call_1", { documentId: lecture.id, page: 2 });
    const image = result.content.find((block) => block.type === "image");
    expect(image).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    // A real JPEG, small enough to keep in a saved chat.
    const bytes = Buffer.from((image as { data: string }).data, "base64");
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(bytes.byteLength).toBeLessThan(400_000);
    await expect(readPage.execute("call_2", { documentId: elsewhere.id, page: 1 })).rejects.toThrow(
      "not part of this chat",
    );
  });

  it("send only the most recent page images, while the saved chat keeps them all", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/jpeg" };
    const turns = Array.from({ length: 8 }, (_, n) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `page ${n + 1}` }, image],
      timestamp: n,
    }));
    const sent = modelContextMessages(turns);
    const imagesIn = (message: (typeof sent)[number]) =>
      typeof message.content === "string"
        ? 0
        : message.content.filter((block) => block.type === "image").length;
    // Eight messages with images: the first five are let go together, the last three keep theirs.
    expect(sent.map(imagesIn)).toEqual([0, 0, 0, 0, 0, 1, 1, 1]);
    expect(JSON.stringify(sent[0])).toContain("not sent again");
    expect(turns.every((turn) => turn.content.length === 2 && turn.content[1] === image)).toBe(
      true,
    );
  });
});

describe("what the student adds to a chat", () => {
  it("lets a course chat read another course only once the student adds it", async () => {
    const { runtimes, algorithms, other, elsewhere } = await setup();
    let grants = { courses: [] as string[], documents: [] as string[] };
    const runtime = await runtimes.course(algorithms.id, randomUUID(), () => grants);
    const tool = (name: string) => runtime.tools.find((candidate) => candidate.name === name)!;
    await expect(
      tool("read_page").execute("call_1", { documentId: elsewhere.id, page: 1 }),
    ).rejects.toThrow("not part of this chat");
    await expect(tool("list_documents").execute("call_2", { courseId: other.id })).rejects.toThrow(
      "not part of this chat",
    );
    const before = await runtime.prompt();
    expect(before).toContain("You cannot see other courses");

    grants = { courses: [other.id], documents: [] };
    const page = await tool("read_page").execute("call_3", { documentId: elsewhere.id, page: 1 });
    expect(JSON.stringify(page.content)).toContain("Private course");
    const listed = await tool("list_documents").execute("call_4", { courseId: other.id });
    expect(JSON.stringify(listed.content)).toContain(elsewhere.title);
    // What was added travels on the student's message; the prompt stays the same.
    expect(await runtime.prompt()).toBe(before);
  });

  it("opens an added lecture, not the rest of its course", async () => {
    const { runtimes, library, home, algorithms, elsewhere } = await setup();
    const extra = await library.createCourse({ name: "Third course" });
    const third = (await library.importFile(extra.id, resolve(home, "lecture1.pdf"))).document;
    const runtime = await runtimes.course(algorithms.id, randomUUID(), () => ({
      courses: [],
      documents: [third.id],
    }));
    const readPage = runtime.tools.find((candidate) => candidate.name === "read_page")!;
    await readPage.execute("call_1", { documentId: third.id, page: 1 });
    // Another lecture of a course that was not added stays out of reach.
    await expect(readPage.execute("call_2", { documentId: elsewhere.id, page: 1 })).rejects.toThrow(
      "not part of this chat",
    );
    expect(await runtime.prompt()).not.toContain(third.id);
  });

  it("takes grants from the student's own messages, and keeps them when the chat reopens", async () => {
    const { store, algorithms, other, elsewhere, open } = await setup();
    const chat = await open(readThenAnswer({ documentId: elsewhere.id, page: 1 }, []), {
      newSession: true,
      kind: "course",
      courseId: algorithms.id,
    });
    await chat.send("What does the other course say?");
    const results = () => chat.snapshot.messages.filter((message) => message.role === "toolResult");
    expect(results()[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(results()[0])).toContain("The student can add it");

    await chat.send("Now with it added.", randomUUID(), {
      attachments: [
        {
          attachment: { kind: "course", courseId: other.id },
          note: `the course "Private course", courseId ${other.id}`,
        },
      ],
    });
    expect(results()[1]).toMatchObject({ isError: false });
    expect(JSON.stringify(results()[1])).toContain("Private course · lecture1 · page 1");
    const question = chat.snapshot.messages.filter((message) => message.role === "user")[1]!;
    expect(question).toMatchObject({ folioAttachments: [{ kind: "course", courseId: other.id }] });
    expect(questionText(question as never)).toBe("Now with it added.");

    const id = chat.snapshot.id;
    await chat.close();
    const reopened = await open(readThenAnswer({}, []), { id, allowedKinds: ["course"] });
    expect(reopened.grants()).toEqual({ courses: [other.id], documents: [] });
    expect((await store.load(id)).scope).toEqual({ courseId: algorithms.id, library: 1 });
  });

  it("checks pages against the chat, counting courses added with them", async () => {
    const { library, algorithms, other, lecture, elsewhere } = await setup();
    const attach = createAttach(library, new PageReader(library));
    const reach = { courseId: algorithms.id, grants: { courses: [], documents: [] } };
    const [page] = await attach(reach, [{ kind: "page", documentId: lecture.id, page: 2 }]);
    expect(page!.attachment).toEqual({ kind: "page", documentId: lecture.id, page: 2 });
    expect(page!.image).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(page!.note).toContain("page 2 of");
    await expect(
      attach(reach, [{ kind: "page", documentId: elsewhere.id, page: 1 }]),
    ).rejects.toThrow("not part of this chat");
    await expect(
      attach(reach, [{ kind: "page", documentId: lecture.id, page: 9 }]),
    ).rejects.toThrow("not in this document");
    const together = await attach(reach, [
      { kind: "course", courseId: other.id },
      { kind: "page", documentId: elsewhere.id, page: 1 },
    ]);
    expect(together.map((item) => item.attachment.kind)).toEqual(["course", "page"]);
    // The chat's own course is already readable; adding it does nothing.
    expect(await attach(reach, [{ kind: "course", courseId: algorithms.id }])).toEqual([]);
    await expect(attach(reach, [{ kind: "document", documentId: randomUUID() }])).rejects.toThrow(
      "no longer in your library",
    );
    // A library chat reads any page.
    const anywhere = await attach({ courseId: null, grants: { courses: [], documents: [] } }, [
      { kind: "page", documentId: elsewhere.id, page: 1 },
    ]);
    expect(anywhere).toHaveLength(1);
  });

  it("tells the tutor an earlier image of the student's is gone, not to reread a page", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/jpeg" };
    const own = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "my working" }, image],
      timestamp: 0,
      folioAttachments: [{ kind: "image", name: "work.png", thumbnail: "AAAA" }],
    };
    const pages = Array.from({ length: 6 }, (_, n) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `page ${n + 1}` }, image],
      timestamp: n + 1,
      folioAttachments: [{ kind: "page", documentId: "d", page: n + 1 }],
    }));
    const sent = modelContextMessages([own, ...pages]);
    expect(JSON.stringify(sent[0])).toContain("ask them to add it again");
    expect(JSON.stringify(sent[0])).not.toContain("read the page again");
  });
});

describe("a prompt the provider can reuse", () => {
  /** Each request must repeat the one before it and only add to the end. */
  function expectAppendOnly(requests: TranscriptContext[]) {
    for (let index = 1; index < requests.length; index++) {
      const before = requests[index - 1]!.messages;
      expect(requests[index]!.messages.slice(0, before.length)).toEqual(before);
    }
  }

  it("keeps the prompt the same across page turns, added courses and tool rounds", async () => {
    const { algorithms, other, lecture, open } = await setup();
    const requests: TranscriptContext[] = [];
    const chat = await open(readThenAnswer({ documentId: lecture.id, page: 1 }, requests), {
      newSession: true,
      kind: "course",
      courseId: algorithms.id,
    });
    const at = (page: number) => ({ focus: { documentId: lecture.id, page } });
    await chat.send("What is on this page?", randomUUID(), at(1));
    await chat.send("And this one?", randomUUID(), at(2));
    await chat.send("Same page, another question.", randomUUID(), at(2));
    await chat.send("Compare with the other course.", randomUUID(), {
      ...at(2),
      attachments: [
        {
          attachment: { kind: "course", courseId: other.id },
          note: `the course "Private course", courseId ${other.id}`,
        },
      ],
    });
    await chat.send("Back to reading nothing.", randomUUID(), { focus: null });
    expect(requests).toHaveLength(10);
    const heads = new Set(requests.map((request) => JSON.stringify(request.messages[0])));
    expect(heads.size).toBe(1);
    expectAppendOnly(requests);
    // The page is mentioned when it changes, and not again for the same page.
    const notes = requests
      .at(-1)!
      .messages.filter((message) => message.role === "user")
      .map(
        (message) => JSON.stringify(message).match(/<folio_context>(.*?)<\/folio_context>/)?.[1],
      );
    expect(notes).toEqual([
      'The student is reading \\"lecture1\\", page 1 of 3.',
      'The student is reading \\"lecture1\\", page 2 of 3.',
      undefined,
      undefined,
      "The student is not reading a document now.",
    ]);
    expect(chat.snapshot.focus).toBeNull();
  });

  it("keeps what an earlier question said when the document is renamed later", async () => {
    const { algorithms, library, lecture, open } = await setup();
    const requests: TranscriptContext[] = [];
    const chat = await open(readThenAnswer({ documentId: lecture.id, page: 1 }, requests), {
      newSession: true,
      kind: "course",
      courseId: algorithms.id,
    });
    await chat.send("First question.", randomUUID(), {
      focus: { documentId: lecture.id, page: 1 },
    });
    await library.updateDocument(lecture.id, { title: "Renamed lecture" }, lecture.revision);
    await chat.send("Second question.", randomUUID(), {
      focus: { documentId: lecture.id, page: 1 },
    });
    // The document list in the prompt follows the rename; the earlier question does not.
    expect(requests.at(-1)!.messages[1]).toEqual(requests[0]!.messages[1]);
    expect(JSON.stringify(requests[0]!.messages[1])).toContain("lecture1");
  });

  it("counts a page that left the course as not reading", async () => {
    const { algorithms, elsewhere, open } = await setup();
    const requests: TranscriptContext[] = [];
    const chat = await open(readThenAnswer({ documentId: elsewhere.id, page: 1 }, requests), {
      newSession: true,
      kind: "course",
      courseId: algorithms.id,
    });
    await chat.send("Explain this.", randomUUID(), {
      focus: { documentId: elsewhere.id, page: 1 },
    });
    const question = chat.snapshot.messages.find((message) => message.role === "user");
    expect(question).toMatchObject({ folioFocus: null });
    expect(JSON.stringify(requests[0]!.messages[1])).not.toContain("folio_context");
  });
});

describe("teaching rules", () => {
  it("go into every course and library chat's prompt", async () => {
    const { runtimes, algorithms } = await setup();
    const course = await (await runtimes.course(algorithms.id, randomUUID())).prompt();
    const library = await (await runtimes.library(randomUUID())).prompt();
    expect(course).toContain(TEACHING_RULES);
    expect(library).toContain(TEACHING_RULES);
    // The pages read are listed under each reply, so a closing source line only repeats them.
    expect(course).toContain(CITING_RULE);
    expect(library).toContain(CITING_RULE);
    expect(CITING_RULE).toContain("never end a reply with a Source or Sources line");
  });

  it("cover quizzes, getting ready, tracing and connecting, asked for in the student's words", () => {
    expect(TEACHING_RULES).toContain("Recognize it from their words; there is no mode");
    for (const request of [
      "To be quizzed or to practice",
      "To get ready for a lecture or recitation",
      "Where a concept comes from",
      "How lectures or topics connect",
      "One step at a time means",
    ])
      expect(TEACHING_RULES).toContain(request);
  });
});
