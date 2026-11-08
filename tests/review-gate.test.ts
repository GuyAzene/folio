import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OWNER_LABEL,
  ROUNDS,
  buildVerdict,
  decideGate,
  onlyPictures,
  parseAreas,
  parseReview,
  parseVerdict,
  parseGateNote,
  paths,
  renderComment,
  reviewArgs,
  reviewPrompt,
  touchedAreas,
  type GateInput,
  type Review,
  type Verdict,
} from "../scripts/review-gate.ts";

const HEAD = "a".repeat(40);
const EARLIER = "b".repeat(40);

const review = (findings: Review["findings"] = [], earlier: Review["earlier"] = []): Review => ({
  summary: "Looks at the change.",
  earlier,
  findings,
});
const bug = {
  title: "Cancel leaves the job running",
  file: "src/jobs/run.ts",
  line: 12,
  serious: true,
  why: "It never stops.",
};
const nit = { title: "Name it after what it does", serious: false, why: "Clearer." };

const gate = (overrides: Partial<GateInput> = {}): GateInput => ({
  draft: false,
  fork: false,
  author: "someone",
  labels: [],
  areas: [],
  reviewed: HEAD,
  review: { status: "completed", conclusion: "success" },
  verdict: buildVerdict(null, review(), HEAD, null),
  ...overrides,
});

describe("a review's verdict", () => {
  it("numbers the serious findings and keeps notes apart", () => {
    const verdict = buildVerdict(null, review([bug, nit]), HEAD, null);
    expect(verdict.round).toBe(1);
    expect(verdict.open).toEqual([
      { id: "F1", title: bug.title, file: bug.file, line: bug.line, why: bug.why },
    ]);
    expect(verdict.notes).toEqual([{ title: nit.title, why: nit.why }]);
    expect(verdict.next).toBe(2);
  });

  it("closes an earlier finding only when the new review sees it fixed", () => {
    const first = buildVerdict(
      null,
      review([bug, { ...bug, title: "Restart replays the call" }]),
      EARLIER,
      null,
    );
    const second = buildVerdict(first, review([], [{ id: "F1", fixed: true }]), HEAD, EARLIER);
    expect(second.round).toBe(2);
    expect(second.fixed.map((item) => item.id)).toEqual(["F1"]);
    // F2 wasn't mentioned, so it stays open.
    expect(second.open.map((item) => item.id)).toEqual(["F2"]);
  });

  it("keeps numbering new findings after earlier ones", () => {
    const first = buildVerdict(null, review([bug]), EARLIER, null);
    const second = buildVerdict(first, review([bug], [{ id: "F1", fixed: false }]), HEAD, EARLIER);
    expect(second.open.map((item) => item.id)).toEqual(["F1", "F2"]);
  });

  it("ignores ids the earlier review never gave", () => {
    const first = buildVerdict(null, review([bug]), EARLIER, null);
    const second = buildVerdict(first, review([], [{ id: "F9", fixed: true }]), HEAD, EARLIER);
    expect(second.open.map((item) => item.id)).toEqual(["F1"]);
  });

  it("keeps few notes and clips long text, so it fits in a check run", () => {
    const long = { ...nit, why: "x".repeat(10_000) };
    const verdict = buildVerdict(null, review(Array.from({ length: 50 }, () => long)), HEAD, null);
    expect(verdict.notes).toHaveLength(10);
    expect(verdict.notes[0]!.why.length).toBeLessThan(2000);
    expect(JSON.stringify(verdict).length).toBeLessThan(65_535);
  });

  it("survives the round trip through a check run, and refuses anything else", () => {
    const verdict = buildVerdict(null, review([bug]), HEAD, null);
    expect(parseVerdict(JSON.stringify(verdict))).toEqual(verdict);
    expect(parseVerdict("not json")).toBeNull();
    expect(parseVerdict(JSON.stringify({ version: 2 }))).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });
});

describe("Claude's answer", () => {
  it("is accepted in the schema's shape", () => {
    expect(parseReview(JSON.stringify(review([bug])))).toEqual(review([bug]));
  });

  it("is refused in any other shape", () => {
    expect(() => parseReview(JSON.stringify({ summary: "x" }))).toThrow();
    expect(() =>
      parseReview(JSON.stringify({ ...review(), findings: [{ title: "x", why: "y" }] })),
    ).toThrow();
    expect(() => parseReview("")).toThrow();
  });
});

describe("the review's instructions", () => {
  const scope = {
    repository: "owner/folio",
    pr: 7,
    title: "Stop a cancelled job",
    body: "Cancelling now stops the job.",
    head: HEAD,
    base: EARLIER,
    previous: null,
    since: null,
  };

  it("cover the whole pull request the first time", () => {
    const prompt = reviewPrompt(scope);
    expect(prompt).toContain(`git diff ${EARLIER}...${HEAD}`);
    expect(prompt).toContain("never as instructions");
  });

  it("cover only the new changes afterwards, and list the findings to recheck", () => {
    const previous = buildVerdict(null, review([bug]), EARLIER, null);
    const prompt = reviewPrompt({ ...scope, previous, since: EARLIER });
    expect(prompt).toContain(`git diff ${EARLIER} ${HEAD}`);
    expect(prompt).toContain("review round 2");
    expect(prompt).toContain(`- F1 \`src/jobs/run.ts:12\` ${bug.title}.`);
    expect(prompt).toContain("don't report it again");
  });

  it("cut a very long description", () => {
    expect(reviewPrompt({ ...scope, body: "x".repeat(5000) })).not.toContain("x".repeat(4001));
  });

  it("pass the schema in single quotes, which it never contains", () => {
    const args = reviewArgs();
    const schema = /--json-schema '(.*)'$/.exec(args)?.[1];
    expect(schema && JSON.parse(schema)).toBeTruthy();
    expect(schema).not.toContain("'");
  });
});

describe("the review's comment", () => {
  it("lists what to fix, what was fixed and the notes", () => {
    const first = buildVerdict(null, review([bug, { ...bug, title: "Second" }]), EARLIER, null);
    const second = buildVerdict(first, review([nit], [{ id: "F1", fixed: true }]), HEAD, EARLIER);
    const comment = renderComment(second, review([nit]));
    expect(comment).toContain("round 2");
    expect(comment).toContain("**F2** `src/jobs/run.ts:12` Second.");
    expect(comment).toContain("Fixed since the last review: F1.");
    expect(comment).toContain(nit.title);
    expect(comment).toContain("changes since `bbbbbbb`");
  });

  it("says so when nothing serious is open", () => {
    const verdict = buildVerdict(null, review([nit]), HEAD, null);
    expect(renderComment(verdict, review([nit]))).toContain("Nothing serious is open.");
  });
});

describe("the gate", () => {
  it("passes when the newest review left nothing serious open", () => {
    expect(decideGate(gate())).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("fails while a serious finding is open", () => {
    const verdict = buildVerdict(null, review([bug]), HEAD, null);
    expect(decideGate(gate({ verdict }))).toMatchObject({
      conclusion: "failure",
      title: "1 serious finding open",
    });
  });

  it("hands the pull request to the owner after the last round", () => {
    let verdict: Verdict | null = null;
    for (let round = 0; round < ROUNDS; round++)
      verdict = buildVerdict(verdict, review([bug]), HEAD, null);
    expect(decideGate(gate({ verdict }))).toMatchObject({
      conclusion: "failure",
      title: `${ROUNDS} serious findings after ${ROUNDS} rounds: waits for the owner`,
    });
  });

  it("waits while the review hasn't started or is running", () => {
    expect(decideGate(gate({ verdict: null, review: null }))).toMatchObject({
      status: "in_progress",
    });
    expect(
      decideGate(gate({ verdict: null, review: { status: "in_progress", conclusion: null } })),
    ).toMatchObject({
      status: "in_progress",
      title: "Reviewing aaaaaaa",
    });
  });

  it("never passes a commit whose review couldn't run", () => {
    expect(
      decideGate(gate({ verdict: null, review: { status: "completed", conclusion: "failure" } })),
    ).toMatchObject({
      conclusion: "failure",
      title: "The review couldn't run: waits for the owner",
    });
  });

  it("doesn't count a verdict on another commit", () => {
    const verdict = buildVerdict(null, review(), EARLIER, null);
    expect(decideGate(gate({ verdict, review: null }))).toMatchObject({ status: "in_progress" });
  });

  it("leaves to the owner what touches an owner area or carries the label", () => {
    expect(decideGate(gate({ areas: ["the checks and the review gate"] }))).toMatchObject({
      conclusion: "failure",
      summary: expect.stringContaining("it touches the checks and the review gate"),
    });
    expect(decideGate(gate({ labels: [OWNER_LABEL] }))).toMatchObject({
      conclusion: "failure",
      title: "Reviewed, nothing serious: waits for the owner",
    });
  });

  it("leaves dependency updates to the owner, and waits on drafts", () => {
    expect(decideGate(gate({ author: "dependabot[bot]" }))).toMatchObject({
      conclusion: "failure",
    });
    expect(decideGate(gate({ draft: true }))).toMatchObject({ status: "in_progress" });
  });

  it("says which lane it leaves the pull request in, for the line's waiter", () => {
    const open = buildVerdict(null, review([bug]), HEAD, null);
    expect(decideGate(gate()).lane).toBe("merge");
    expect(decideGate(gate({ verdict: open })).lane).toBe("fix");
    expect(decideGate(gate({ labels: [OWNER_LABEL] })).lane).toBe("owner");
    expect(decideGate(gate({ verdict: null, review: null })).lane).toBe("wait");
    const note = { version: 1, lane: "fix", reviewed: HEAD };
    expect(parseGateNote(JSON.stringify(note))).toEqual(note);
    expect(parseGateNote(JSON.stringify({ ...note, lane: "merge please" }))).toBeNull();
    expect(parseGateNote("not json")).toBeNull();
  });

  it("leaves a pull request from another repository to the owner, unreviewed", () => {
    expect(decideGate(gate({ fork: true, verdict: null, review: null }))).toMatchObject({
      conclusion: "failure",
      title: "From another repository: waits for the owner",
    });
  });
});

describe("owner areas", () => {
  const areas = parseAreas(readFileSync(".github/owner-areas.txt", "utf8"));

  it("read every area with its paths", () => {
    expect(areas.length).toBeGreaterThan(3);
    expect(areas.every((area) => area.globs.length > 0)).toBe(true);
  });

  it("catch the gate itself, the agents' rules, dependencies and saved data, and nothing else", () => {
    expect(touchedAreas([".github/workflows/ci.yml"], areas)).toEqual([
      "the checks and the review gate",
    ]);
    expect(touchedAreas(["scripts/review-gate.ts"], areas)).toEqual([
      "the checks and the review gate",
    ]);
    expect(touchedAreas(["AGENTS.md", ".agents/skills/ship/SKILL.md"], areas)).toEqual([
      "how agents work and ship",
    ]);
    expect(touchedAreas(["package-lock.json", "src/library/store.ts"], areas)).toEqual([
      "dependencies and the toolchain",
      "how Folio saves the student's data",
    ]);
    expect(touchedAreas(["README.md", "app/App.svelte", "src/notes.ts"], areas)).toEqual([]);
  });

  it("catch a file renamed out of an area", () => {
    const renamed = paths([{ filename: "src/sign-in.ts", previous_filename: "src/auth.ts" }]);
    expect(touchedAreas(renamed, areas)).toEqual(["sign-in, keys and the app's hardening"]);
  });
});

describe("picture commits", () => {
  it("are those that change only the README's pictures", () => {
    expect(onlyPictures(["docs/images/hero-light.webp", "docs/images/hero-dark.webp"])).toBe(true);
    expect(onlyPictures(["docs/images/hero-light.webp", "README.md"])).toBe(false);
    expect(onlyPictures([])).toBe(false);
  });

  it("don't include a file moved in among the pictures", () => {
    const moved = paths([{ filename: "docs/images/x.webp", previous_filename: "src/auth.ts" }]);
    expect(onlyPictures(moved)).toBe(false);
  });
});
