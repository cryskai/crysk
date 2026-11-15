// The exam runner's chain, offline: case repository → pipeline → the hunter's
// own draft → grade. The model is replaced by a runner that returns a fixed
// draft, so the two shortcuts a grader must not reward are exercised through
// the real pipeline at no cost: a hunter that reports nothing, and a hunter
// that reports every line.

import { afterAll, describe, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { aggregateCase } from "#compare/hunter-exam";
import type { DraftFinding } from "#review/drafts";
import type { StepResult, StepRunner, StepSpec } from "#review/step-runner";
import {
  BUNDLED_AGENTS_DIR,
  caseDir,
  caseRoots,
  checkCase,
  EXAM_DIR,
  examDirs,
  examHome,
  gradeRecord,
  loadBank,
  materializeCase,
  removedCommentLines,
  removeTree,
  renderRequest,
  resolveHunter,
  runHunterOnCase,
  stepCostUsd,
  sweepWork,
} from "../../benchmarks/hunter-exam/run-case";

// The exam keeps everything it writes under one folder. The tests point that
// folder at a temp dir, so running them never touches the real one.
const HOME = await mkdtemp(path.join(tmpdir(), "casebank-test-"));
process.env.CRYSK_CASEBANK_HOME = HOME;
afterAll(async () => {
  await rm(HOME, { recursive: true, force: true });
});

const bank = await loadBank();
const pilot = bank.cases.find((c) => c.id === "py-invoice-reassign");
if (pilot === undefined) throw new Error("pilot case missing from the bank");
const pilotDir = caseDir(pilot.id);
const logic = resolveHunter("logic");

function draft(path: string, line: number, n: number): DraftFinding {
  return {
    id: `LOG-${n}`,
    category: 15,
    path,
    line,
    severity: "WARNING",
    evidence_class: "inferential",
    causal_disposition: "introduced",
    claim: "a claim",
    proof_refs: [],
    hunter: "logic",
    hops_used: 0,
    hop_trail: [],
    dedupe_key: `k-${n}`,
  } as DraftFinding;
}

class FixedDraftRunner implements StepRunner {
  constructor(private readonly findings: DraftFinding[] | "fail") {}

  async run(spec: StepSpec): Promise<StepResult> {
    const base = {
      name: spec.name,
      usage: {
        wall_ms: 1,
        tokens_in: 1,
        tokens_out: 1,
        tokens_total: 2,
        cost_usd_est: 0,
      },
      attempts: 1,
      stderrTail: "",
      resultText: "",
    };
    if (this.findings === "fail") return { ...base, status: "failed" };
    // The real runner owns this write: the step's delivered draft lands at
    // spec.outPath, which is the file the exam reads.
    const output = { findings: this.findings };
    await writeFile(spec.outPath, JSON.stringify(output));
    return { ...base, status: "ok", output };
  }
}

async function runWith(findings: DraftFinding[] | "fail") {
  const runDir = await mkdtemp(path.join(tmpdir(), "hunter-exam-test-"));
  try {
    const record = await runHunterOnCase(pilotDir, logic, {
      agentsDir: BUNDLED_AGENTS_DIR,
      runDir,
      runner: new FixedDraftRunner(findings),
    });
    return { record, grade: gradeRecord(pilot as never, record) };
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

describe("the case bank on disk", () => {
  // A site past the end of its file can never be hit, and would read as a
  // hunter's miss.
  // Cases on a real repository need its mirror, which is a download; the
  // offline suite builds the self-contained ones, and `exam.ts check` builds
  // them all.
  test("every site sits inside a file of its case", async () => {
    for (const examCase of bank.cases.filter((c) => c.origin === "synthetic")) {
      const built = await materializeCase(caseDir(examCase.id));
      try {
        const sites = [...examCase.must_find, ...examCase.must_not].flatMap(
          (entry) => entry.sites,
        );
        for (const site of sites) {
          const text = await readFile(
            path.join(built.repoDir, site.path),
            "utf8",
          );
          expect(site.end_line).toBeLessThanOrEqual(
            text.trimEnd().split("\n").length,
          );
        }
      } finally {
        await rm(built.tmp, { recursive: true, force: true });
      }
    }
  });

  test("a case builds the same commits every time, without its key", async () => {
    const a = await materializeCase(pilotDir);
    const b = await materializeCase(pilotDir);
    try {
      expect(a.headSha).toBe(b.headSha);
      expect(a.baseSha).not.toBe(a.headSha);
      const top = await readdir(a.repoDir);
      expect(top.sort()).toEqual([".git", "README.md", "billing"]);
      expect(await readFile(a.diffPath, "utf8")).toContain("def reassign");
    } finally {
      await rm(a.tmp, { recursive: true, force: true });
      await rm(b.tmp, { recursive: true, force: true });
    }
  });
});

// A case can sit on a real repository: source.json pins a commit, the tree is
// exported from a local mirror, and patches turn it into the base and the
// head. The upstream here is a local repository, so the test stays offline.
describe("a case backed by a pinned repository commit", () => {
  async function sh(cwd: string, args: string[]): Promise<string> {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "up",
        GIT_AUTHOR_EMAIL: "up@example.invalid",
        GIT_COMMITTER_NAME: "up",
        GIT_COMMITTER_EMAIL: "up@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}`);
    return out.trim();
  }

  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "hunter-exam-upstream-"));
    const upstream = path.join(root, "upstream");
    const dir = path.join(root, "case");
    await mkdir(path.join(upstream, "src"), { recursive: true });
    await mkdir(dir);
    await sh(root, ["init", "-q", "-b", "main", upstream]);
    await writeFile(path.join(upstream, "src", "a.txt"), "one\ntwo\nthree\n");
    await writeFile(path.join(upstream, "src", "a_test.txt"), "checks two\n");
    await writeFile(path.join(upstream, "CHANGES.txt"), "fixed two\n");
    await sh(upstream, ["add", "-A"]);
    await sh(upstream, ["commit", "-q", "-m", "fix: the secret fix message"]);
    const pinned = await sh(upstream, ["rev-parse", "HEAD"]);
    await writeFile(path.join(upstream, "src", "later.txt"), "later\n");
    await sh(upstream, ["add", "-A"]);
    await sh(upstream, ["commit", "-q", "-m", "later work"]);

    await writeFile(
      path.join(dir, "source.json"),
      JSON.stringify({
        repo: upstream,
        commit: pinned,
        drop: ["CHANGES.txt"],
      }),
    );
    await writeFile(
      path.join(dir, "base.patch"),
      [
        "diff --git a/src/a_test.txt b/src/a_test.txt",
        "deleted file mode 100644",
        "--- a/src/a_test.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-checks two",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(dir, "head.patch"),
      [
        "diff --git a/src/a.txt b/src/a.txt",
        "--- a/src/a.txt",
        "+++ b/src/a.txt",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+2",
        " three",
        "",
      ].join("\n"),
    );
    return { root, dir, reposDir: path.join(root, "mirrors") };
  }

  test("exports the pinned tree, applies both patches, keeps no upstream history", async () => {
    const { root, dir, reposDir } = await fixture();
    const built = await materializeCase(dir, { reposDir });
    try {
      // The changelog, which describes fixes in words, is dropped.
      expect(await readdir(built.repoDir)).not.toContain("CHANGES.txt");
      // The pinned commit, not the upstream tip.
      expect((await readdir(path.join(built.repoDir, "src"))).sort()).toEqual([
        "a.txt",
      ]);
      expect(
        await readFile(path.join(built.repoDir, "src", "a.txt"), "utf8"),
      ).toBe("one\n2\nthree\n");
      const diff = await readFile(built.diffPath, "utf8");
      expect(diff).toContain("+2");
      // The test the fix added is gone from the base, so the diff under
      // review does not mention it.
      expect(diff).not.toContain("a_test");
      const log = await sh(built.repoDir, ["log", "--format=%s"]);
      expect(log.split("\n")).toEqual(["update", "initial"]);
      expect(log).not.toContain("secret fix message");
    } finally {
      await rm(built.tmp, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("builds the same commits twice and reuses the mirror", async () => {
    const { root, dir, reposDir } = await fixture();
    try {
      const a = await materializeCase(dir, { reposDir });
      const mirrors = await readdir(reposDir);
      const b = await materializeCase(dir, { reposDir });
      expect(b.headSha).toBe(a.headSha);
      expect(await readdir(reposDir)).toEqual(mirrors);
      await rm(a.tmp, { recursive: true, force: true });
      await rm(b.tmp, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The first version leaked a checkout every time a build failed.
  test("a build that fails leaves no checkout behind", async () => {
    const { root, dir, reposDir } = await fixture();
    const workDir = path.join(root, "work");
    try {
      await writeFile(path.join(dir, "head.patch"), "not a patch\n");
      await expect(
        materializeCase(dir, { reposDir, workDir }),
      ).rejects.toThrow();
      expect(await readdir(workDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a commit the repository does not have", async () => {
    const { root, dir, reposDir } = await fixture();
    try {
      const source = JSON.parse(
        await readFile(path.join(dir, "source.json"), "utf8"),
      );
      await writeFile(
        path.join(dir, "source.json"),
        JSON.stringify({ ...source, commit: "0".repeat(40) }),
      );
      await expect(materializeCase(dir, { reposDir })).rejects.toThrow(
        /is not in/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// The bank lives outside the repository; the repository keeps one sample.
describe("where cases are read from", () => {
  test("the sample in the repository, then a linked bank, then the named ones", () => {
    const home = path.join(HOME, "nowhere");
    expect(caseRoots({ CRYSK_CASEBANK_HOME: home })).toEqual([
      path.join(EXAM_DIR, "cases"),
    ]);
    expect(
      caseRoots({ CRYSK_CASEBANK_HOME: home, CRYSK_CASEBANK_CASES: "/a:/b" }),
    ).toEqual([path.join(EXAM_DIR, "cases"), "/a", "/b"]);
  });

  test("a bank outside the repository adds its cases, and a new case goes there", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "casebank-outside-"));
    try {
      await cp(pilotDir, path.join(outside, "py-outside"), { recursive: true });
      const keyPath = path.join(outside, "py-outside", "key.json");
      const key = JSON.parse(await readFile(keyPath, "utf8"));
      await writeFile(keyPath, JSON.stringify({ ...key, id: "py-outside" }));
      process.env.CRYSK_CASEBANK_CASES = outside;
      const ids = (await loadBank()).cases.map((c) => c.id);
      expect(ids).toEqual(["py-invoice-reassign", "py-outside"]);
      expect(caseDir("py-outside")).toBe(path.join(outside, "py-outside"));
      expect(caseDir("py-invoice-reassign")).toBe(pilotDir);
      expect(caseDir("py-not-written-yet")).toBe(
        path.join(outside, "py-not-written-yet"),
      );
    } finally {
      delete process.env.CRYSK_CASEBANK_CASES;
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("the same case in two places is refused", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "casebank-outside-"));
    try {
      await cp(pilotDir, path.join(outside, pilot.id), { recursive: true });
      process.env.CRYSK_CASEBANK_CASES = outside;
      await expect(loadBank()).rejects.toThrow(/is in both/);
    } finally {
      delete process.env.CRYSK_CASEBANK_CASES;
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("removedCommentLines", () => {
  const diff = [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,5 +10,2 @@ function f() {",
    " const a = 1;",
    "-  // 32 is not a day",
    "-  if (day > 31) return null;",
    "-  #count = 0;",
    " return a;",
    "--- a/lib/b.py",
    "+++ b/lib/b.py",
    "@@ -4,3 +4,1 @@",
    "-    # paused schedules are skipped",
    "-    *rest,",
    " x = 1",
  ].join("\n");

  test("finds comment lines by language, with their old line numbers", () => {
    expect(removedCommentLines(diff)).toEqual([
      { file: "src/a.ts", line: 11 },
      { file: "lib/b.py", line: 4 },
    ]);
  });
});

describe("removedCommentLines inside a hunk", () => {
  // A removed line whose content starts with `--` looks like a file header.
  test("a removed `--count;` is a removed line, and later numbers hold", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -5,4 +5,1 @@",
      " keep();",
      "---count;",
      "--- a/not-a-header.ts",
      "-  // the comment",
    ].join("\n");
    expect(removedCommentLines(diff)).toEqual([{ file: "src/a.ts", line: 8 }]);
  });

  test("a second file's header is read once the hunk is over", () => {
    const diff = [
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1,1 +1,0 @@",
      "-// gone",
      "--- a/two.py",
      "+++ b/two.py",
      "@@ -3,1 +3,0 @@",
      "-# gone too",
    ].join("\n");
    expect(removedCommentLines(diff)).toEqual([
      { file: "one.ts", line: 1 },
      { file: "two.py", line: 3 },
    ]);
  });
});

// Run as a command, with nothing to buy: every one of these has to stop
// before a model is called.
describe("exam.ts refuses instead of guessing", () => {
  async function exam(args: string[]) {
    const proc = Bun.spawn(
      ["bun", "run", path.join(EXAM_DIR, "exam.ts"), ...args],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stderr, code };
  }

  // `--max-usd --fresh` read "--fresh" as the amount; NaN never trips a cap.
  test.each([
    [
      ["run", "--hunter", "logic", "--max-usd", "--fresh"],
      /--max-usd must be a number/,
    ],
    [["run", "--hunter", "logic", "--max-usd"], /--max-usd must be a number/],
    [
      ["run", "--hunter", "logic", "--max-usd", "abc"],
      /--max-usd must be a number/,
    ],
    [
      ["run", "--hunter", "logic", "--concurrency", "0"],
      /--concurrency must be a whole number/,
    ],
    [
      ["score", "--hunter", "logic", "--min-depth", "deep"],
      /--min-depth must be a whole number/,
    ],
  ])("a numeric option that does not parse: %j", async (args, message) => {
    const { stderr, code } = await exam(args);
    expect(code).toBe(64);
    expect(stderr).toMatch(message);
  });

  // An empty selection used to exit 0 with pass: true.
  test.each([
    [["score", "--hunter", "logic", "--project", "no-such-project"]],
    [["check", "--area", "concurrency", "--origin", "synthetic"]],
  ])("a selection that matches no case: %j", async (args) => {
    const { stderr, code } = await exam(args);
    expect(code).toBe(64);
    expect(stderr).toMatch(/no case matches this selection/);
  });
});

describe("checkCase", () => {
  test("a site ending one line past the end of its file is caught", async () => {
    const built = await materializeCase(pilotDir);
    let last = 0;
    try {
      const text = await readFile(
        path.join(built.repoDir, "billing/store.py"),
        "utf8",
      );
      expect(text.endsWith("\n")).toBe(true);
      last = text.trimEnd().split("\n").length;
    } finally {
      await removeTree(built.tmp);
    }
    const atEnd = structuredClone(pilot);
    const site = atEnd.must_find[0]?.sites[1];
    if (site) site.end_line = last;
    expect(await checkCase(atEnd)).toEqual([]);
    if (site) site.end_line = last + 1;
    expect(await checkCase(atEnd)).toEqual([
      `reassign-stale-listing: billing/store.py:${last + 1} is past the end of the file`,
    ]);
  });

  test("the self-contained case is fit to run", async () => {
    expect(await checkCase(pilot)).toEqual([]);
  });

  test("names a site that is past the end of its file", async () => {
    const broken = structuredClone(pilot);
    const site = broken.must_find[0]?.sites[0];
    if (site) site.end_line = 9999;
    expect(await checkCase(broken)).toEqual([
      "reassign-stale-listing: billing/store.py:9999 is past the end of the file",
    ]);
  });
});

describe("renderRequest", () => {
  test("is stable, and carries the profile's model and effort", async () => {
    const a = await renderRequest(pilotDir, logic, BUNDLED_AGENTS_DIR);
    const b = await renderRequest(pilotDir, logic, BUNDLED_AGENTS_DIR);
    expect(a).toEqual(b);
    expect(a.model).toBe("sonnet");
    expect(a.effort).toBe("xhigh");
  });

  test("changes when the hunter's prompt changes", async () => {
    const agents = await mkdtemp(path.join(tmpdir(), "hunter-exam-agents-"));
    try {
      await cp(BUNDLED_AGENTS_DIR, agents, { recursive: true });
      const same = await renderRequest(pilotDir, logic, agents);
      const file = path.join(agents, logic.file);
      await writeFile(
        file,
        `${await readFile(file, "utf8")}\nOne more line.\n`,
      );
      const edited = await renderRequest(pilotDir, logic, agents);
      expect(edited.key).not.toBe(same.key);
    } finally {
      await rm(agents, { recursive: true, force: true });
    }
  });
});

describe("runHunterOnCase, with the model replaced", () => {
  test("a hunter that reports nothing misses both defects", async () => {
    const { record, grade } = await runWith([]);
    expect(record.status).toBe("graded");
    expect(grade).toMatchObject({
      status: "graded",
      found: [],
      missed: ["reassign-stale-listing", "export-page-base"],
      flagged: [],
    });
    const result = aggregateCase(pilot, [grade, grade], bank.threshold);
    expect(result.verdict).toBe("fail");
  });

  test("a hunter that reports every line finds both and still fails", async () => {
    const everything = [
      "store.py",
      "export.py",
      "invoice.py",
      "cli.py",
    ].flatMap((file, f) =>
      Array.from({ length: 51 }, (_, i) =>
        draft(`billing/${file}`, i + 1, f * 100 + i),
      ),
    );
    const { grade } = await runWith(everything);
    expect(grade).toMatchObject({
      found: ["reassign-stale-listing", "export-page-base"],
      flagged: ["void-unindex", "paid-ratio-division"],
    });
    const result = aggregateCase(pilot, [grade, grade], bank.threshold);
    expect(result.verdict).toBe("fail");
  });

  test("a hunter that reports the two planted sites passes", async () => {
    const { record, grade } = await runWith([
      draft("billing/store.py", 26, 1),
      draft("billing/cli.py", 29, 2),
    ]);
    expect(record.findings.length).toBe(2);
    expect(grade).toMatchObject({ missed: [], flagged: [], extras: 0 });
    const result = aggregateCase(pilot, [grade, grade], bank.threshold);
    expect(result.verdict).toBe("pass");
  });

  test("a failed step is an infrastructure error, not an empty draft", async () => {
    const { record, grade } = await runWith("fail");
    expect(record.status).toBe("infra_error");
    expect(grade.status).toBe("infra_error");
  });
});

// Under subscription auth the cash cost of a run is zero. The first live run
// of this exam counted cash, so its budget never tripped and it bought three
// runs where one was asked for.
describe("stepCostUsd", () => {
  const pipeline = (usage: unknown) => ({
    steps: [{ name: "hunter-logic", usage_v2: usage }],
  });

  test("prefers the notional cost over a zero cash cost", () => {
    expect(
      stepCostUsd(
        pipeline({ notionalCostUsd: 0.12, cashCostUsd: 0 }),
        "hunter-logic",
      ),
    ).toBe(0.12);
  });

  test("falls back to the cash cost when no notional cost is recorded", () => {
    expect(stepCostUsd(pipeline({ cashCostUsd: 0.3 }), "hunter-logic")).toBe(
      0.3,
    );
  });

  test("is zero for a step that is not there or carries no usage", () => {
    expect(stepCostUsd(pipeline({}), "hunter-logic")).toBe(0);
    expect(stepCostUsd(pipeline({ notionalCostUsd: 1 }), "hunter-x")).toBe(0);
    expect(stepCostUsd(null, "hunter-logic")).toBe(0);
  });
});

describe("where the exam writes", () => {
  test("one folder, overridable, with a plain name", () => {
    expect(examHome({ CRYSK_CASEBANK_HOME: "/x/y" })).toBe("/x/y");
    const fallback = examHome({});
    expect(fallback.endsWith(path.join(".crysk", "casebank"))).toBe(true);
    // A hunter sees its checkout's path.
    expect(path.basename(fallback)).not.toMatch(/exam|test|bench|eval/i);
    expect(Object.values(examDirs("/x/y")).sort()).toEqual([
      "/x/y/deps",
      "/x/y/reports",
      "/x/y/repos",
      "/x/y/runs",
      "/x/y/work",
    ]);
  });

  test("removeTree removes a nested tree, a dangling link included", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "casebank-rm-"));
    await mkdir(path.join(root, "a", "b"), { recursive: true });
    await writeFile(path.join(root, "a", "b", "f.txt"), "x");
    await symlink("nowhere", path.join(root, "a", "dangling"));
    await removeTree(root);
    expect(await readdir(path.dirname(root))).not.toContain(
      path.basename(root),
    );
  });

  test("a checkout left by a killed run is swept, a fresh one is kept", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "casebank-sweep-"));
    try {
      await mkdir(path.join(work, "c-old"));
      await mkdir(path.join(work, "c-new"));
      const threeHours = 3 * 60 * 60 * 1000;
      expect(await sweepWork(work, Date.now() + threeHours)).toBe(2);
      await mkdir(path.join(work, "c-new"));
      expect(await sweepWork(work)).toBe(0);
      expect(await readdir(work)).toEqual(["c-new"]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("the suite used the temp folder, and emptied its work folder", async () => {
    expect(examHome()).toBe(HOME);
    expect(await readdir(examDirs().work)).toEqual([]);
  });
});

describe("resolveHunter", () => {
  test("drops the trigger of a conditional hunter", () => {
    expect(resolveHunter("parity")).toEqual({
      key: "parity",
      file: "deep-review-parity.md",
      role: "hunter",
    });
  });

  test("names a candidate hunter by key and file", () => {
    expect(resolveHunter("security:security.md")).toEqual({
      key: "security",
      file: "security.md",
      role: "hunter",
    });
  });

  test("refuses a hunter the spec does not carry", () => {
    expect(() => resolveHunter("refuter")).toThrow(/unknown hunter "refuter"/);
  });
});
