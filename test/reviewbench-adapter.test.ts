import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertComplete,
  assertHuntersRan,
  type Contract,
  copyTraces,
  isReviewable,
  readContract,
  reviewArgv,
  toFindingsFile,
} from "../benchmarks/reviewbench/adapter";
import {
  prKey,
  subscriptionEnv,
  threeDotDiff,
} from "../benchmarks/reviewbench/run-local";
import { parseIgnoreFile } from "../src/ignore-file";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const ENV = {
  RB_NWO: "owner/repo",
  RB_PR_NUMBER: "1938",
  RB_BASE: BASE,
  RB_HEAD: HEAD,
  RB_AGENT: "crysk",
  RB_DIFF: "/work/pr/diff.patch",
  RB_OUT: "/work/out/findings.json",
};
const CONTRACT = readContract(ENV) as Contract;

function finding(
  overrides: Partial<{ path: string; line: number; claim: string }> = {},
) {
  return {
    path: "src/pool.ts",
    line: 42,
    claim: "Race on conns.",
    ...overrides,
  };
}
function doc(findings: ReturnType<typeof finding>[], head = HEAD) {
  return { head_sha: head, findings };
}

describe("readContract", () => {
  test("reads the variables the benchmark sets", () => {
    expect(CONTRACT).toMatchObject({
      nwo: "owner/repo",
      prNumber: 1938,
      base: BASE,
      head: HEAD,
      agent: "crysk",
      out: "/work/out/findings.json",
    });
  });

  test("names a missing variable, because the benchmark then fails the run", () => {
    const { RB_OUT: _out, ...env } = ENV;
    expect(() => readContract(env)).toThrow("RB_OUT");
  });

  test("refuses a PR number and SHAs that are not what the contract promises", () => {
    expect(() => readContract({ ...ENV, RB_PR_NUMBER: "abc" })).toThrow(
      "RB_PR_NUMBER",
    );
    expect(() => readContract({ ...ENV, RB_HEAD: "abc" })).toThrow("RB_HEAD");
  });

  test("defaults to the contract's mount, and a local run can point elsewhere", () => {
    expect(CONTRACT.repo).toBe("/work/repo");
    expect(CONTRACT.runDir).toBeUndefined();
    const local = readContract({
      ...ENV,
      RB_REPO: "/tmp/repo",
      RB_RUN_DIR: "/tmp/run",
    });
    expect(local.repo).toBe("/tmp/repo");
    expect(local.runDir).toBe("/tmp/run");
  });

  test("reads the sessions directory only when the image sets it", () => {
    expect(CONTRACT.sessionsDir).toBeUndefined();
    expect(
      readContract({ ...ENV, RB_SESSIONS_DIR: "/home/bun/.claude/projects" })
        .sessionsDir,
    ).toBe("/home/bun/.claude/projects");
  });

  test("reads the model from the manifest's configuration", () => {
    expect(readContract({ ...ENV, RB_CONFIG_MODEL: "opus" }).model).toBe(
      "opus",
    );
    expect(CONTRACT.model).toBeUndefined();
  });
});

describe("reviewArgv", () => {
  const argv = (contract: Contract = CONTRACT) =>
    reviewArgv({
      bun: "/bun",
      cli: "/engine/src/cli.ts",
      repo: "/work/repo",
      contract,
      gotchas: "/engine/gotchas.md",
      runDir: "/tmp/run",
    });

  test("reviews the contract's range against the repo, into the run directory", () => {
    expect(argv().slice(0, 3)).toEqual([
      "/bun",
      "/engine/src/cli.ts",
      "review",
    ]);
    for (const [flag, value] of [
      ["--repo", "/work/repo"],
      ["--base", BASE],
      ["--head", HEAD],
      ["--gotchas", "/engine/gotchas.md"],
      ["--out", "/tmp/run"],
    ]) {
      expect(argv()[argv().indexOf(flag as string) + 1]).toBe(value as string);
    }
  });

  // The contract's diff is three-dot, which is the engine's default range.
  test("does not ask for a two-dot range", () => {
    expect(argv()).not.toContain("--two-dot");
  });

  // A skipped pull request scores nothing, and a prompt would hang the container.
  test("never stops at the size gate or a confirmation", () => {
    expect(argv()).toContain("--force");
    expect(argv()).toContain("--yes");
  });

  test("passes the model only when one is configured", () => {
    expect(argv()).not.toContain("--model");
    const withModel = argv({ ...CONTRACT, model: "opus" });
    expect(withModel[withModel.indexOf("--model") + 1]).toBe("opus");
  });
});

describe("toFindingsFile", () => {
  test("writes the contract's shape", () => {
    expect(toFindingsFile(doc([finding()]), CONTRACT)).toEqual({
      pr: {
        repo: "https://github.com/owner/repo",
        pr_number: 1938,
        base: BASE,
        head: HEAD,
      },
      agent: "crysk",
      findings: [
        {
          file: "src/pool.ts",
          start_line: 42,
          end_line: 42,
          message: "Race on conns.",
          producer: "crysk",
        },
      ],
    });
  });

  test("an empty review is a valid answer", () => {
    expect(toFindingsFile(doc([]), CONTRACT).findings).toEqual([]);
  });

  test("refuses a review of another commit, which the benchmark would reject", () => {
    expect(() => toFindingsFile(doc([], "c".repeat(40)), CONTRACT)).toThrow(
      "head",
    );
  });

  test("normalizes a path to repository-relative with forward slashes", () => {
    const out = toFindingsFile(
      doc([finding({ path: "./src\\a.ts" })]),
      CONTRACT,
    );
    expect(out.findings[0]?.file).toBe("src/a.ts");
  });

  test("drops what the benchmark could not locate, and keeps the rest", () => {
    const out = toFindingsFile(
      doc([
        finding({ line: 0 }),
        finding({ path: "" }),
        finding({ path: "/etc/passwd" }),
        finding({ path: "../outside.ts" }),
        finding({ claim: "  " }),
        finding({ line: 7 }),
      ]),
      CONTRACT,
    );
    expect(out.findings.map((f) => f.start_line)).toEqual([7]);
  });

  test("one claim on one line, since it is what the judge matches", () => {
    const out = toFindingsFile(
      doc([finding({ claim: "A race.\n\n  It loses writes." })]),
      CONTRACT,
    );
    expect(out.findings[0]?.message).toBe("A race. It loses writes.");
  });
});

describe("isReviewable", () => {
  const record = (file: string) =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;

  test("a change to source is reviewable", () => {
    expect(isReviewable(record("src/a.ts"))).toBe(true);
  });

  // The engine refuses these with an error, and the benchmark would fail the
  // whole run over a pull request that has nothing to review.
  test("an empty diff or only lockfiles is not", () => {
    expect(isReviewable("")).toBe(false);
    expect(isReviewable(record("bun.lock"))).toBe(false);
  });

  // The verdict has to match the engine's, which also reads the repository's
  // ignore file: it errors on what is left with nothing, and reviews a negation.
  test("the repository's ignore file counts, both ways", () => {
    const ignore = (text: string) => ({
      found: true,
      rules: parseIgnoreFile(text, "user"),
    });
    expect(isReviewable(record("src/a.ts"), ignore("src/"))).toBe(false);
    expect(isReviewable(record("bun.lock"), ignore("!bun.lock"))).toBe(true);
  });
});

describe("assertHuntersRan", () => {
  const steps = (...statuses: string[]) => ({
    steps: [
      { name: "refuter-F001", status: "ok" },
      ...statuses.map((status, i) => ({ name: `hunter-${i}`, status })),
    ],
  });

  test("a complete or partial review counts", () => {
    expect(() => assertHuntersRan(steps("ok", "ok"))).not.toThrow();
    expect(() => assertHuntersRan(steps("ok", "failed"))).not.toThrow();
  });

  // Zero findings from no hunters would score as a clean review.
  test("a review where every hunter failed does not", () => {
    expect(() => assertHuntersRan(steps("failed", "failed"))).toThrow("hunter");
    expect(() => assertHuntersRan(steps())).toThrow("hunter");
  });
});

describe("assertComplete, for a run that scores privately", () => {
  const complete = {
    head_sha: HEAD,
    run_status: "complete" as const,
    findings: [],
  };

  test("a complete review counts", () => {
    expect(() => assertComplete(complete)).not.toThrow();
  });

  // Running out of quota partway leaves fewer findings that still look like a
  // result, so the pull request must fail and be run again.
  test("a partial review does not", () => {
    expect(() =>
      assertComplete({ ...complete, run_status: "partial" }),
    ).toThrow("partial");
  });
});

describe("readContract's strict mode", () => {
  test("is off unless asked for", () => {
    expect(CONTRACT.strict).toBe(false);
    expect(readContract({ ...ENV, RB_STRICT: "1" }).strict).toBe(true);
  });
});

describe("copyTraces", () => {
  function dirs() {
    const root = mkdtempSync(path.join(tmpdir(), "rb-traces-"));
    return {
      root,
      sessions: path.join(root, "projects"),
      runDir: path.join(root, "run"),
    };
  }

  test("copies each session into the run directory, with secrets removed", async () => {
    const { root, sessions, runDir } = dirs();
    try {
      await Bun.write(
        path.join(sessions, "-work-repo", "one.jsonl"),
        '{"content":"uses SECRET-VALUE here"}\n',
      );
      await Bun.write(path.join(sessions, "-work-repo", "two.jsonl"), "{}\n");
      await Bun.write(path.join(sessions, "-work-repo", "skip.txt"), "no");
      const copied = await copyTraces(sessions, runDir, {
        CLAUDE_CODE_OAUTH_TOKEN: "SECRET-VALUE",
      });
      expect(copied).toBe(2);
      const one = await Bun.file(
        path.join(runDir, "traces", "one.jsonl"),
      ).text();
      expect(one).toBe('{"content":"uses [REDACTED] here"}\n');
      expect(existsSync(path.join(runDir, "traces", "skip.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no sessions is not a failure, because traces must never cost a result", async () => {
    const { root, sessions, runDir } = dirs();
    try {
      expect(await copyTraces(sessions, runDir, {})).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the local runner", () => {
  test("a diff that git cannot produce is a failure, not an empty review", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "rb-diff-"));
    try {
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", "-C", repo, ...args], {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@example.com",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@example.com",
          },
        })
          .stdout.toString()
          .trim();
      git("init", "-q");
      await Bun.write(path.join(repo, "a.txt"), "1\n");
      git("add", ".");
      git("commit", "-qm", "one");
      const base = git("rev-parse", "HEAD");
      await Bun.write(path.join(repo, "a.txt"), "2\n");
      git("commit", "-qam", "two");
      const head = git("rev-parse", "HEAD");
      expect(threeDotDiff(repo, base, head)).toContain("+2");
      expect(() => threeDotDiff(repo, "f".repeat(40), head)).toThrow("diff");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("names a pull request the way the official runner does", () => {
    expect(
      prKey({
        nwo: "owner/repo",
        pr_number: 7,
        base: BASE,
        head: "0123456789".repeat(4),
      }),
    ).toBe("owner_repo_7-01234567");
  });

  // A key left in the shell would bill per token instead of the subscription.
  test("keeps no credential from the environment", () => {
    const env = subscriptionEnv({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "x",
      ANTHROPIC_AUTH_TOKEN: "x",
      CLAUDE_CODE_OAUTH_TOKEN: "x",
    });
    expect(env).toEqual({ PATH: "/bin" });
  });
});
