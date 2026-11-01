import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
import { FolioConfig, readSkills } from "../src/config.ts";
import { modelCatalog } from "../src/connections.ts";
import { Conversation, grantsOf } from "../src/conversation.ts";
import { createRuntimes } from "../src/library/course-tools.ts";
import { LibraryStore } from "../src/library/store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { SkillLibrary, type SkillSwitches } from "../src/skills/library.ts";
import { parseSkill } from "../src/skills/skill-file.ts";
import { skillCommand, skillTool } from "../src/skills/tool.ts";

const homes: string[] = [];
const conversations: Conversation[] = [];

afterEach(async () => {
  await Promise.allSettled(conversations.splice(0).map((conversation) => conversation.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "folio-skills-test-"));
  homes.push(home);
  return home;
}

const skillMd = (name: string, description: string, body = "Do it step by step.", extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;

async function writeSkill(root: string, dir: string, text: string): Promise<string> {
  const path = resolve(root, dir);
  await mkdir(path, { recursive: true });
  await writeFile(resolve(path, "SKILL.md"), text);
  return path;
}

/** A Folio home and a home folder with other agents' skills, with switches kept in memory. */
async function libraryWith(switches: SkillSwitches = { on: [], off: [], folders: [] }) {
  const root = await folder();
  const home = resolve(root, "folio");
  const user = resolve(root, "user");
  await mkdir(home, { recursive: true });
  await mkdir(user, { recursive: true });
  const state = { switches };
  const library = new SkillLibrary({ home, user, switches: () => state.switches });
  return { root, home, user, library, state };
}

describe("reading SKILL.md", () => {
  it("reads a name, a description and the instructions", () => {
    const parsed = parseSkill(skillMd("quiz-me", "Quiz me one question at a time."), "quiz-me");
    expect(parsed).toEqual({
      meta: {
        name: "quiz-me",
        description: "Quiz me one question at a time.",
        model: true,
        user: true,
      },
      body: "Do it step by step.",
    });
  });

  it("joins a folded description, keeps Hebrew, and reads the optional fields", () => {
    const text = [
      "---",
      "name: hebrew-terms",
      "description: >",
      "  Explain terms in Hebrew",
      "  and English: מכונת טיורינג",
      "license: MIT",
      "allowed-tools: Bash(python:*) Read",
      "disable-model-invocation: true",
      "metadata:",
      "  author: someone",
      "---",
      "השתמש במונחים של הקורס.",
    ].join("\r\n");
    const parsed = parseSkill(text, "hebrew-terms");
    if ("problem" in parsed) throw new Error(parsed.problem);
    expect(parsed.meta).toEqual({
      name: "hebrew-terms",
      description: "Explain terms in Hebrew and English: מכונת טיורינג",
      license: "MIT",
      allowedTools: "Bash(python:*) Read",
      model: false,
      user: true,
    });
    expect(parsed.body).toBe("השתמש במונחים של הקורס.");
  });

  it("takes the folder's name when there is none, and says when the two differ", () => {
    const unnamed = parseSkill("---\ndescription: Something useful.\n---\nBody", "folder-name");
    expect("meta" in unnamed && unnamed.meta.name).toBe("folder-name");
    const other = parseSkill(skillMd("other-name", "Something useful."), "folder-name");
    expect("meta" in other && other.meta.note).toMatch(/differs from its folder/);
  });

  it("skips what can't be a routine, saying why", () => {
    const problem = (text: string, dir = "x") => {
      const parsed = parseSkill(text, dir);
      return "problem" in parsed ? parsed.problem : null;
    };
    expect(problem("No frontmatter at all")).toMatch(/frontmatter/);
    expect(problem("---\nname: x\n")).toMatch(/doesn't end/);
    expect(problem("---\nname: x\n---\nBody")).toBe("it has no description");
    expect(problem("---\nname: [x\ndescription: y\n---\n")).toMatch(/valid YAML/);
    expect(problem(skillMd("Quiz Me", "Upper case and a space."))).toMatch(/lowercase/);
    expect(problem(skillMd("a".repeat(65), "Long."))).toMatch(/64/);
    expect(problem(skillMd("x", "d".repeat(1025)))).toMatch(/1024/);
    // Aliases could multiply a small file into a huge one.
    expect(problem("---\nname: x\nbase: &a [1]\ndescription: *a\n---\n")).toMatch(/valid YAML/);
  });
});

describe("the routines Folio finds", () => {
  it("turns Folio's own on and other agents' off, and the first of a name wins among those on", async () => {
    const { home, user, library, state } = await libraryWith();
    await writeSkill(resolve(home, "skills"), "quiz-me", skillMd("quiz-me", "Folio's quiz."));
    await writeSkill(
      resolve(user, ".claude/skills"),
      "quiz-me",
      skillMd("quiz-me", "Claude's quiz."),
    );
    await writeSkill(resolve(user, ".claude/skills"), "pdf", skillMd("pdf", "Fill PDF forms."));
    await writeSkill(resolve(user, ".codex/skills"), "broken", "---\nname: broken\n---\n");
    await writeSkill(resolve(user, ".claude/skills"), ".hidden", skillMd("hidden", "Hidden."));

    let found = await library.scan();
    expect(found.skills.map((skill) => [skill.key, skill.from, skill.on])).toEqual([
      [`${home}/skills/quiz-me`, "Folio", true],
      ["~/.claude/skills/pdf", "Claude Code", false],
      ["~/.claude/skills/quiz-me", "Claude Code", false],
    ]);
    expect(found.skipped).toEqual([
      { key: "~/.codex/skills/broken", from: "Codex", reason: "it has no description" },
    ]);

    state.switches = {
      on: ["~/.claude/skills/quiz-me", "~/.claude/skills/pdf"],
      off: [],
      folders: [],
    };
    found = await library.scan();
    expect(
      found.skills.find((skill) => skill.from === "Claude Code" && skill.name === "quiz-me"),
    ).toMatchObject({ on: true, hiddenBy: "Folio's quiz-me" });
    expect((await library.active()).map((skill) => `${skill.from}:${skill.name}`)).toEqual([
      "Folio:quiz-me",
      "Claude Code:pdf",
    ]);

    // Folio's own turned off, Claude's of the same name is used.
    state.switches = { ...state.switches, off: [`${home}/skills/quiz-me`] };
    expect((await library.active()).map((skill) => `${skill.from}:${skill.name}`)).toEqual([
      "Claude Code:pdf",
      "Claude Code:quiz-me",
    ]);
  });

  it("reads a folder the student added, whether it holds skills or is one", async () => {
    const { root, library, state } = await libraryWith();
    const many = resolve(root, "study-skills");
    await writeSkill(many, "feynman", skillMd("feynman", "Teach it back."));
    const single = await writeSkill(root, "exam-prep", skillMd("exam-prep", "Plan exam prep."));
    state.switches = { on: [`${many}/feynman`, single], off: [], folders: [many, single] };
    expect((await library.active()).map((skill) => skill.name)).toEqual(["feynman", "exam-prep"]);
  });

  it("lists routines for the tutor within its budget, escaped, without the ones only the student starts", () => {
    const skill = (name: string, description: string, model = true) => ({
      name,
      description,
      model,
      user: true,
      key: name,
      source: "folio" as const,
      from: "Folio",
      on: true,
      digest: "",
    });
    const catalog = SkillLibrary.catalog([
      skill("a-b", "Use <tags> & such."),
      skill("mine", "Only when I say.", false),
      ...Array.from({ length: 30 }, (_, index) => skill(`s${index}`, "x".repeat(400))),
    ]);
    expect(catalog).toContain("<description>Use &lt;tags&gt; &amp; such.</description>");
    expect(catalog).not.toContain("<name>mine</name>");
    expect(catalog.length).toBeLessThan(8_200);
    expect(catalog).toMatch(/\(\d+ more routines didn't fit in this list\.\)$/);
  });
});

describe("a routine's files", () => {
  async function withFiles() {
    const setup = await libraryWith();
    const dir = await writeSkill(
      resolve(setup.home, "skills"),
      "graded",
      skillMd("graded", "Grade an answer.", "Use references/rubric.md."),
    );
    await mkdir(resolve(dir, "references"));
    await mkdir(resolve(dir, "scripts"));
    await writeFile(resolve(dir, "references/rubric.md"), "Full marks need a proof.");
    const marker = resolve(setup.root, "ran");
    await writeFile(resolve(dir, "scripts/run.sh"), `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(resolve(dir, "scripts/run.sh"), 0o755);
    await writeFile(resolve(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    await writeFile(resolve(dir, "big.md"), "x".repeat(129 * 1024));
    await writeFile(resolve(setup.root, "secret.txt"), "Outside the routine.");
    await symlink(resolve(setup.root, "secret.txt"), resolve(dir, "link.txt"));
    return { ...setup, dir, marker };
  }

  it("lists the files with scripts marked, and reads text files inside the folder only", async () => {
    const { library, marker } = await withFiles();
    const loaded = await library.instructions("graded");
    expect(loaded.body).toBe("Use references/rubric.md.");
    expect(loaded.files).toEqual([
      // Links aren't listed: a routine's files are its own.
      { path: "big.md", kind: "text" },
      { path: "logo.png", kind: "other" },
      { path: "references/rubric.md", kind: "text" },
      { path: "scripts/run.sh", kind: "script" },
    ]);
    expect((await library.file("graded", "references/rubric.md")).text).toBe(
      "Full marks need a proof.",
    );
    await expect(library.file("graded", "../../../secret.txt")).rejects.toThrow(/isn't inside/);
    await expect(library.file("graded", "link.txt")).rejects.toThrow(/isn't inside/);
    await expect(library.file("graded", "logo.png")).rejects.toThrow(/isn't a text file/);
    await expect(library.file("graded", "big.md")).rejects.toThrow(/128 KB/);
    await expect(library.file("graded", "missing.md")).rejects.toThrow(/no file/);
    // Reading a script is all Folio ever does with it.
    expect((await library.file("graded", "scripts/run.sh")).text).toContain("touch");
    await expect(stat(marker)).rejects.toThrow();
  });
});

describe("writing Folio's own routines", () => {
  it("creates one, refuses a stale save, and keeps its name", async () => {
    const { home, library } = await libraryWith();
    await library.create("quiz-me", "Quiz me: one question at a time.", "Ask, wait, then check.");
    const file = resolve(home, "skills/quiz-me/SKILL.md");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(resolve(home, "skills"))).mode & 0o777).toBe(0o700);
    const { text, revision } = await library.read("quiz-me");
    const parsed = parseSkill(text, "quiz-me");
    expect("meta" in parsed && parsed.meta.description).toBe("Quiz me: one question at a time.");
    await expect(library.create("quiz-me", "Again.", "")).rejects.toThrow(/already/);
    await expect(library.create("Quiz Me", "Bad name.", "")).rejects.toThrow(/lowercase/);

    await library.save("quiz-me", text.replace("check.", "check, kindly."), revision);
    await expect(library.save("quiz-me", text, revision)).rejects.toThrow(/changed since/);
    const now = await library.read("quiz-me");
    await expect(
      library.save("quiz-me", now.text.replace("name: quiz-me", "name: other"), now.revision),
    ).rejects.toThrow(/Keep the name/);
    await expect(library.save("quiz-me", "no frontmatter", now.revision)).rejects.toThrow(
      /can't be saved/,
    );
    expect(await readFile(file, "utf8")).toContain("check, kindly.");
  });
});

describe("the use_skill tool and /name", () => {
  it("loads a routine that is on, reads its files, and leaves the student's own to the student", async () => {
    const { home, library } = await libraryWith();
    await writeSkill(resolve(home, "skills"), "quiz-me", skillMd("quiz-me", "Quiz me."));
    await writeSkill(
      resolve(home, "skills"),
      "mine",
      skillMd("mine", "Only when I ask.", "My way.", "disable-model-invocation: true\n"),
    );
    await writeFile(resolve(home, "skills/quiz-me/notes.md"), "Extra notes.");
    const started: string[] = [];
    const tool = skillTool(library, await library.active(), () => started);
    expect(tool.description).toContain("<name>quiz-me</name>");
    expect(tool.description).not.toContain("<name>mine</name>");

    const run = (params: Record<string, unknown>) => tool.execute("call", params as never);
    const loaded = await run({ name: "quiz-me" });
    expect(loaded.content[0]).toMatchObject({ type: "text" });
    expect((loaded.content[0] as { text: string }).text).toContain(
      '<skill_content name="quiz-me">\nDo it step by step.\n</skill_content>',
    );
    expect((loaded.content[0] as { text: string }).text).toContain("- notes.md");
    expect(loaded.details).toEqual({ v: 1, skill: { name: "quiz-me" } });
    expect((await run({ name: "quiz-me", file: "notes.md" })).details).toEqual({
      v: 1,
      skill: { name: "quiz-me", file: "notes.md" },
    });
    await expect(run({ name: "missing" })).rejects.toThrow(/no routine "missing"/);
    await expect(run({ name: "mine" })).rejects.toThrow(/themselves/);
    started.push("mine");
    expect(((await run({ name: "mine" })).content[0] as { text: string }).text).toContain(
      "My way.",
    );
  });

  it("sends a started routine as it is, and refuses one that is off", async () => {
    const { home, library, state } = await libraryWith();
    await writeSkill(resolve(home, "skills"), "quiz-me", skillMd("quiz-me", "Quiz me."));
    const started = await skillCommand(library, "quiz-me");
    expect(started.record).toMatchObject({ v: 1, kind: "skill", name: "quiz-me", from: "Folio" });
    expect(started.block).toMatch(
      /^<folio_skill name="quiz-me">\nDo it step by step\.\n<\/folio_skill>/,
    );
    expect(started.block).toContain('started their routine "quiz-me"');
    state.switches = { on: [], off: [`${home}/skills/quiz-me`], folders: [] };
    await expect(skillCommand(library, "quiz-me")).rejects.toThrow(
      /no routine "quiz-me" turned on/,
    );
  });
});

describe("the skills section of config.json", () => {
  it("reads lists of folders and reports anything else", () => {
    expect(readSkills(undefined).switches).toEqual({ on: [], off: [], folders: [] });
    expect(readSkills({ on: ["~/a", "~/a"], folders: ["~/f"] }).switches).toEqual({
      on: ["~/a"],
      off: [],
      folders: ["~/f"],
    });
    expect(readSkills({ on: "~/a" }).problems).toEqual(["skills.on: write a list of folders."]);
    expect(readSkills([]).problems).toHaveLength(1);
  });

  it("writes a switch only where it differs from what is usual", async () => {
    const home = await folder();
    const config = await FolioConfig.open(home, modelCatalog());
    await config.setSkill("~/.claude/skills/pdf", true, false);
    await config.setSkill("~/.folio/skills/quiz-me", false, true);
    await config.setSkillFolder("~/study-skills", true);
    expect(config.skills).toEqual({
      on: ["~/.claude/skills/pdf"],
      off: ["~/.folio/skills/quiz-me"],
      folders: ["~/study-skills"],
    });
    await config.setSkill("~/.folio/skills/quiz-me", true, true);
    await config.setSkillFolder("~/study-skills", false);
    expect(JSON.parse(await readFile(resolve(home, "config.json"), "utf8")).skills).toEqual({
      on: ["~/.claude/skills/pdf"],
      off: [],
      folders: [],
    });
  });
});

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

function reply(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
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

/** Answers each request with the next scripted reply, keeping what each request carried. */
function scripted(replies: AssistantMessage["content"][], requests: TranscriptContext[]): StreamFn {
  return (_model, context) => {
    requests.push(structuredClone(context));
    const message = reply(replies.shift() ?? [{ type: "text", text: "Done." }]);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    return stream;
  };
}

describe("routines in a chat", () => {
  async function chatSetup() {
    const setup = await libraryWith();
    const data = resolve(setup.root, "data");
    const library = await LibraryStore.open({ home: data });
    const store = await createSessionStore({ home: data });
    const course = await library.createCourse({ name: "Algorithms" });
    const runtimes = createRuntimes(library, {
      async extras(chat) {
        const active = await setup.library.active();
        return active.length
          ? [skillTool(setup.library, active, () => chat.grants().skills ?? [])]
          : [];
      },
    });
    const open = async (streamFn: StreamFn, id?: string) => {
      const conversation = await Conversation.open({
        store,
        streamFn,
        resolveModel: () => model,
        modelId: model.id,
        ...(id ? { id } : { newSession: true, kind: "course" as const, courseId: course.id }),
        allowedKinds: ["course"],
        courseRuntime: runtimes.course,
      });
      conversations.push(conversation);
      return conversation;
    };
    return { ...setup, store, open };
  }
  const names = (request: TranscriptContext) =>
    getCurrentTools(request.messages).map((tool) => tool.name);

  it("offers use_skill from the question after a routine is turned on, and keeps the request's start otherwise", async () => {
    const { home, open } = await chatSetup();
    const requests: TranscriptContext[] = [];
    const chat = await open(scripted([], requests));
    await chat.send("First question", randomUUID());
    await chat.send("Second question", randomUUID());
    expect(names(requests[0]!)).not.toContain("use_skill");
    // Nothing changed between the questions, so each request starts the same way.
    expect(requests[1]!.messages[0]).toEqual(requests[0]!.messages[0]);

    await writeSkill(resolve(home, "skills"), "quiz-me", skillMd("quiz-me", "Quiz me."));
    await chat.send("Third question", randomUUID());
    expect(names(requests[2]!).at(-1)).toBe("use_skill");
    // Only the leading message holds tool declarations; none were saved with the chat.
    expect(chat.snapshot.messages.filter((message) => message.role === "system")).toHaveLength(1);
  });

  it("runs use_skill when the tutor loads a routine", async () => {
    const { home, open } = await chatSetup();
    await writeSkill(resolve(home, "skills"), "quiz-me", skillMd("quiz-me", "Quiz me."));
    const requests: TranscriptContext[] = [];
    const chat = await open(
      scripted(
        [[{ type: "toolCall", id: "call_1", name: "use_skill", arguments: { name: "quiz-me" } }]],
        requests,
      ),
    );
    await chat.send("Quiz me on lecture 1", randomUUID());
    const result = chat.snapshot.messages.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({ toolName: "use_skill", isError: false });
    expect(requests).toHaveLength(2);
  });

  it("keeps a started routine's text as it was when sent, and remembers it was started", async () => {
    const { home, library, open } = await chatSetup();
    const dir = await writeSkill(
      resolve(home, "skills"),
      "quiz-me",
      skillMd("quiz-me", "Quiz me.", "Version one."),
    );
    const requests: TranscriptContext[] = [];
    const chat = await open(scripted([], requests));
    await chat.send("/quiz-me lecture 1", randomUUID(), {
      command: await skillCommand(library, "quiz-me"),
    });
    await writeFile(resolve(dir, "SKILL.md"), skillMd("quiz-me", "Quiz me.", "Version two."));
    await chat.send("Next", randomUUID());
    const id = chat.snapshot.id;
    expect(chat.snapshot.title).toBe("lecture 1");
    await chat.close();
    conversations.splice(conversations.indexOf(chat), 1);

    const reopened = await open(scripted([], requests), id);
    const question = reopened.snapshot.messages.find((message) => message.role === "user")!;
    expect(question).toMatchObject({ folioCommand: { kind: "skill", name: "quiz-me" } });
    const content = JSON.stringify(question.content);
    expect(content).toContain("Version one.");
    expect(content).not.toContain("Version two.");
    expect(grantsOf(reopened.snapshot.messages).skills).toEqual(["quiz-me"]);
  });
});
