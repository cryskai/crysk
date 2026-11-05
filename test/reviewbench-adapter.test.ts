import { describe, expect, test } from "bun:test";
import {
  assertHuntersRan,
  type Contract,
  isReviewable,
  readContract,
  reviewArgv,
  toFindingsFile,
} from "../benchmarks/reviewbench/adapter";
import { prKey, subscriptionEnv } from "../benchmarks/reviewbench/run-local";

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

describe("the local runner", () => {
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
