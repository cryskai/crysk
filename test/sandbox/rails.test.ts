// The safety rails (S6), tested before the runners that depend on them.
// Every refusal here is a path the runner could take by mistake; the
// recorded-calls test at the bottom runs both runners and checks what they
// actually sent, independent of the guard that is supposed to have stopped it.

import { describe, expect, test } from "bun:test";
import { runInit } from "../../scripts/sandbox/init";
import {
  assertGhArgs,
  assertGitArgs,
  assertScenarioBranch,
  guardedGh,
  RailViolation,
  SANDBOX_REPO,
} from "../../scripts/sandbox/rails";
import { runSmoke } from "../../scripts/sandbox/smoke";
import { harness, ok } from "./fakes";

const sandboxApi = (path: string) => `repos/${SANDBOX_REPO}/${path}`;

describe("gh rail: the sandbox repo is the only target", () => {
  test("accepts every shape the runner uses, pinned to the sandbox", () => {
    const allowed: string[][] = [
      ["pr", "list", "-R", SANDBOX_REPO, "--state", "open"],
      ["pr", "close", "7", "-R", SANDBOX_REPO, "--delete-branch"],
      ["pr", "create", "-R", SANDBOX_REPO, "--base", "main"],
      ["run", "list", "-R", SANDBOX_REPO, "--branch", "sandbox/x"],
      ["run", "view", "42", "-R", SANDBOX_REPO, "--json", "jobs"],
      ["secret", "list", "-R", SANDBOX_REPO, "--json", "name"],
      ["variable", "get", "PRHERO_ROUTING", `--repo=${SANDBOX_REPO}`],
      ["repo", "view", SANDBOX_REPO, "--json", "name"],
      ["repo", "create", SANDBOX_REPO, "--public"],
      ["repo", "clone", SANDBOX_REPO, "/tmp/x"],
      ["api", sandboxApi("commits/abc/status")],
      ["api", sandboxApi("actions/runs/1/artifacts")],
      ["api", sandboxApi("git/refs/heads/sandbox/smoke-1"), "-X", "DELETE"],
    ];
    for (const args of allowed) {
      expect(() => assertGhArgs(args)).not.toThrow();
    }
  });

  test("refuses any other repository, however it is spelled", () => {
    const refused: string[][] = [
      ["pr", "list", "-R", "juanmaagd/pr-hero"],
      ["pr", "list", "--repo=juanmaagd/pr-hero"],
      ["pr", "list"],
      ["api", "repos/juanmaagd/pr-hero/pulls"],
      ["repo", "view", "juanmaagd/pr-hero"],
      ["repo", "clone", "juanmaagd/pr-hero", "/tmp/x"],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });

  test("refuses repo delete and every write verb the runner does not need", () => {
    const refused: string[][] = [
      ["repo", "delete", SANDBOX_REPO, "--yes"],
      ["repo", "edit", SANDBOX_REPO],
      ["api", sandboxApi("issues/1"), "-X", "PATCH"],
      ["api", sandboxApi("issues/1/comments"), "-f", "body=x"],
      ["api", sandboxApi("issues/1/comments"), "--field", "body=x"],
      ["api", sandboxApi("git/refs/heads/main"), "-X", "DELETE"],
      ["api", sandboxApi("git/refs/heads/dev"), "-X", "DELETE"],
      [
        "api",
        "repos/juanmaagd/pr-hero/git/refs/heads/sandbox/x",
        "-X",
        "DELETE",
      ],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });
});

describe("gh rail: attached flags and repeated flags", () => {
  test("refuses an attached method or field value, even on a scenario ref", () => {
    const refused: string[][] = [
      ["api", sandboxApi("git/refs/heads/main"), "-XDELETE"],
      ["api", sandboxApi("git/refs/heads/sandbox/x"), "-XDELETE"],
      ["api", sandboxApi("issues/1/comments"), "-fbody=x"],
      ["api", sandboxApi("issues/1/comments"), "-Fk=v"],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });

  test("refuses a second method flag, because gh keeps the last one", () => {
    expect(() =>
      assertGhArgs([
        "api",
        sandboxApi("git/refs/heads/main"),
        "-X",
        "GET",
        "-X",
        "DELETE",
      ]),
    ).toThrow(RailViolation);
  });

  test("every -R or --repo occurrence must be the sandbox, because gh keeps the last one", () => {
    const refused: string[][] = [
      ["pr", "list", "-R", SANDBOX_REPO, "-R", "juanmaagd/pr-hero"],
      ["pr", "list", "-R", SANDBOX_REPO, "--repo=juanmaagd/pr-hero"],
      ["pr", "list", "-Rjuanmaagd/pr-hero"],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });
});

describe("gh rail: short-flag clusters", () => {
  // pflag reads `-iXDELETE` as `-i` then `-X DELETE`, and `-ifbody=x` as `-i`
  // then `-f`. `-i` is boolean, so the cluster is invisible to a check that looks
  // only for a leading -X or -f. Any single-dash argument longer than two
  // characters is refused, so no cluster reaches gh.
  test("refuses any single-dash argument longer than two characters", () => {
    const refused: string[][] = [
      ["api", sandboxApi("git/refs/heads/main"), "-iXDELETE"],
      ["api", sandboxApi("git/refs/heads/sandbox/x"), "-iXDELETE"],
      ["api", sandboxApi("issues/1/comments"), "-ifbody=x"],
      ["api", sandboxApi("issues/1"), "-iF"],
      ["api", sandboxApi("git/refs/heads/sandbox/x"), "-XDELETE"],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });

  // Every gh api call the runner makes, one vector per call site, so a future
  // rail tightening that breaks a real call fails here rather than live.
  test("accepts every gh api call the runner sends", () => {
    const sent: string[][] = [
      // smoke.ts, the head's combined status
      ["api", sandboxApi(`commits/${"b".repeat(40)}/status`)],
      // smoke.ts, issue comments and inline review comments
      ["api", sandboxApi("issues/7/comments?per_page=100")],
      ["api", sandboxApi("pulls/7/comments?per_page=100")],
      // smoke.ts, the run's artifacts
      ["api", sandboxApi("actions/runs/42/artifacts")],
      // pr.ts, the scenario branch ref delete
      [
        "api",
        sandboxApi("git/refs/heads/sandbox/smoke-20261016T143000Z"),
        "-X",
        "DELETE",
      ],
    ];
    for (const args of sent) {
      expect(() => assertGhArgs(args)).not.toThrow();
    }
  });
});

describe("gh rail: run cancel", () => {
  test("accepts a cancel of a run in the sandbox", () => {
    expect(() =>
      assertGhArgs(["run", "cancel", "42", "-R", SANDBOX_REPO]),
    ).not.toThrow();
  });

  test("refuses a cancel without the sandbox target, or aimed at another repo", () => {
    const refused: string[][] = [
      ["run", "cancel", "42"],
      ["run", "cancel", "42", "-R", "juanmaagd/pr-hero"],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });
});

describe("git rail: no force, no deletes, no rewritten main", () => {
  test("accepts the pushes the runner makes", () => {
    const allowed: string[][] = [
      ["push", "origin", "main"],
      ["push", "-u", "origin", "sandbox/smoke-20261016T143000Z"],
      ["commit", "-m", "sandbox: seed main"],
      ["add", "--", ".github/workflows/pr-hero.yml"],
      ["checkout", "-b", "sandbox/smoke-20261016T143000Z"],
      ["rev-parse", "HEAD"],
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      ["remote", "get-url", "origin"],
    ];
    for (const args of allowed) {
      expect(() => assertGitArgs(args)).not.toThrow();
    }
  });

  test("a push takes exactly one remote and one refspec", () => {
    const refused: string[][] = [
      ["push", "origin", "main", "+dev:dev"],
      ["push", "origin", "main", ":dev"],
      ["push", "origin", "sandbox/x", "main"],
    ];
    for (const args of refused) {
      expect(() => assertGitArgs(args)).toThrow(RailViolation);
    }
  });

  test("refuses a force or delete refspec even as the only refspec", () => {
    const refused: string[][] = [
      ["push", "origin", "+sandbox/x"],
      ["push", "origin", ":sandbox/x"],
      ["push", "origin", "sandbox/x:sandbox/y"],
    ];
    for (const args of refused) {
      expect(() => assertGitArgs(args)).toThrow(RailViolation);
    }
  });

  test("refuses force pushes, deletes, refspecs and amends", () => {
    const refused: string[][] = [
      ["push", "--force", "origin", "main"],
      ["push", "-f", "origin", "sandbox/x"],
      ["push", "--force-with-lease", "origin", "main"],
      ["push", "--mirror", "origin"],
      ["push", "--delete", "origin", "sandbox/x"],
      ["push", "origin", "+main:main"],
      ["push", "origin", ":sandbox/x"],
      ["push", "origin", "HEAD:refs/heads/dev"],
      ["push", "origin", "dev"],
      ["push", "upstream", "main"],
      ["commit", "--amend", "-m", "x"],
      ["reset", "--hard"],
      ["rebase", "main"],
      ["branch", "-D", "main"],
      ["checkout", "-B", "main"],
    ];
    for (const args of refused) {
      expect(() => assertGitArgs(args)).toThrow(RailViolation);
    }
  });
});

describe("scenario branches", () => {
  test("only sandbox/<name> is a scenario branch", () => {
    expect(() =>
      assertScenarioBranch("sandbox/smoke-20261016T143000Z"),
    ).not.toThrow();
    for (const name of ["main", "dev", "feat/x", "sandbox/", "sandbox/a b"]) {
      expect(() => assertScenarioBranch(name)).toThrow(RailViolation);
    }
  });
});

describe("guards", () => {
  test("a refused call never reaches the inner transport", async () => {
    const calls: string[][] = [];
    const guarded = guardedGh(async (args) => {
      calls.push([...args]);
      return ok();
    });
    await expect(guarded(["repo", "delete", SANDBOX_REPO])).rejects.toThrow(
      RailViolation,
    );
    expect(calls).toEqual([]);
  });
});

describe("recorded calls", () => {
  test("init and smoke send only sandbox-scoped, non-destructive calls", async () => {
    const h = harness({
      gh: (args, world) => {
        // Make both runners do their full work: an empty remote to seed, a
        // missing repo to create, and a happy scenario run.
        if (args[0] === "repo" && args[1] === "view") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Could not resolve to a Repository",
          };
        }
        if (args[0] === "repo" && args[1] === "clone") {
          world.workspace.seed(args[3] ?? "", new Map());
          return ok();
        }
        if (args[0] === "variable" && args[1] === "get") {
          return { exitCode: 1, stdout: "", stderr: "HTTP 404: Not Found" };
        }
        if (args[0] === "secret" && args[1] === "list") return ok("[]");
        if (args[0] === "pr" && args[1] === "list") return ok("[]");
        if (args[0] === "pr" && args[1] === "create") {
          return ok("https://github.com/juanmaagd/pr-hero-sandbox/pull/7\n");
        }
        if (args[0] === "run" && args[1] === "list") {
          return ok(
            JSON.stringify([
              {
                databaseId: 42,
                headSha: "b".repeat(40),
                status: "completed",
                conclusion: "success",
                url: "u",
                workflowName: "pr-hero Review",
              },
            ]),
          );
        }
        if (args[0] === "run" && args[1] === "view") {
          return ok(
            JSON.stringify({
              status: "completed",
              conclusion: "success",
              jobs: [],
            }),
          );
        }
        if (args[0] === "api" && String(args[1]).includes("/commits/")) {
          return ok(JSON.stringify({ statuses: [] }));
        }
        return ok("[]");
      },
    });
    await runInit(h.deps, "v0.2.0");
    await runSmoke(h.deps, {
      ref: "v0.2.0",
      keep: true,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    expect(h.ghCalls.length).toBeGreaterThan(5);
    for (const args of h.ghCalls) {
      const names =
        args.includes(SANDBOX_REPO) ||
        args.some((a) => a.startsWith(`repos/${SANDBOX_REPO}/`));
      expect(names).toBe(true);
      expect(args).not.toContain("--force");
      expect(args).not.toContain("-f");
      expect(args.slice(0, 2)).not.toEqual(["repo", "delete"]);
    }
    for (const call of h.gitCalls) {
      expect(call.args).not.toContain("--force");
      expect(call.args).not.toContain("-f");
      expect(call.args.some((a) => a.startsWith("+"))).toBe(false);
      expect(call.cwd.startsWith("/scratch/")).toBe(true);
    }
  });
});
