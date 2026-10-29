// The safety rails (S6), tested before the runners that depend on them.
// Every refusal here is a path the runner could take by mistake; the
// recorded-calls test at the bottom runs both runners and checks what they
// actually sent, independent of the guard that is supposed to have stopped it.

import { describe, expect, test } from "bun:test";
import { runInit } from "../../scripts/sandbox/init";
import { WORKFLOW_NAME } from "../../scripts/sandbox/markers";
import { runClean, runList } from "../../scripts/sandbox/pr";
import {
  assertGhArgs,
  assertGitArgs,
  assertScenarioBranch,
  guardedGh,
  RailViolation,
  SANDBOX_REPO,
} from "../../scripts/sandbox/rails";
import {
  CLAUDE_TOKEN_SECRET,
  ROUTING_VARIABLE,
} from "../../scripts/sandbox/seed";
import { runSmoke } from "../../scripts/sandbox/smoke";
import { type GhScript, harness, ok } from "./fakes";

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
      ["pr", "list", "-R", "cryskai/crysk"],
      ["pr", "list", "--repo=cryskai/crysk"],
      ["pr", "list"],
      ["api", "repos/cryskai/crysk/pulls"],
      ["repo", "view", "cryskai/crysk"],
      ["repo", "clone", "cryskai/crysk", "/tmp/x"],
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
        "repos/cryskai/crysk/git/refs/heads/sandbox/x",
        "-X",
        "DELETE",
      ],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });
  test("posts a PR comment only on the sandbox, and reads back the comment it wrote", () => {
    expect(() =>
      assertGhArgs([
        "pr",
        "comment",
        "7",
        "-R",
        SANDBOX_REPO,
        "--body",
        "/pr-hero review",
      ]),
    ).not.toThrow();
    expect(() =>
      assertGhArgs(["api", sandboxApi("issues/comments/123")]),
    ).not.toThrow();
  });

  test("refuses a PR comment on any other repository, or with no repository named", () => {
    const refused: string[][] = [
      ["pr", "comment", "7", "-R", "cryskai/crysk", "--body", "x"],
      ["pr", "comment", "7", "--repo=cryskai/crysk", "--body", "x"],
      ["pr", "comment", "7", "--body", "x"],
      ["issue", "comment", "7", "-R", SANDBOX_REPO, "--body", "x"],
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
      ["pr", "list", "-R", SANDBOX_REPO, "-R", "cryskai/crysk"],
      ["pr", "list", "-R", SANDBOX_REPO, "--repo=cryskai/crysk"],
      ["pr", "list", "-Rcryskai/crysk"],
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

// The claude route deletes the routing variable, and only that one. The rail names it
// as a literal, so widening it means editing this allowlist, not the seed.
describe("gh rail: the routing variable is the only variable deleted", () => {
  test("accepts exactly the delete the claude route makes, in either repo spelling", () => {
    expect(() =>
      assertGhArgs([
        "variable",
        "delete",
        ROUTING_VARIABLE,
        "--repo",
        SANDBOX_REPO,
      ]),
    ).not.toThrow();
    expect(() =>
      assertGhArgs([
        "variable",
        "delete",
        ROUTING_VARIABLE,
        "-R",
        SANDBOX_REPO,
      ]),
    ).not.toThrow();
    expect(() =>
      assertGhArgs([
        "variable",
        "delete",
        ROUTING_VARIABLE,
        `--repo=${SANDBOX_REPO}`,
      ]),
    ).not.toThrow();
  });

  test("refuses a delete of any other variable name, or of no name", () => {
    const refused: string[][] = [
      ["variable", "delete", "OTHER_VARIABLE", "--repo", SANDBOX_REPO],
      ["variable", "delete", "PRHERO_ROUTING_V2", "--repo", SANDBOX_REPO],
      ["variable", "delete", "--repo", SANDBOX_REPO],
      ["variable", "delete", "--repo", SANDBOX_REPO, ROUTING_VARIABLE],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });

  test("refuses the routing variable's delete in any other repo, or with no repo, or with a widening flag", () => {
    const refused: string[][] = [
      ["variable", "delete", ROUTING_VARIABLE, "--repo", "cryskai/crysk"],
      ["variable", "delete", ROUTING_VARIABLE, "-R", "cryskai/crysk"],
      ["variable", "delete", ROUTING_VARIABLE],
      [
        "variable",
        "delete",
        ROUTING_VARIABLE,
        "--env",
        "production",
        "-R",
        SANDBOX_REPO,
      ],
      [
        "variable",
        "delete",
        ROUTING_VARIABLE,
        "--org",
        "juanmaagd",
        "-R",
        SANDBOX_REPO,
      ],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });

  test("refuses the other variable verbs the claude route does not need", () => {
    expect(() =>
      assertGhArgs(["variable", "list", "--repo", SANDBOX_REPO]),
    ).toThrow(RailViolation);
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
      ["run", "cancel", "42", "-R", "cryskai/crysk"],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });
});

describe("gh rail: run view --log (SB3 hunter check)", () => {
  test("accepts the log read of a sandbox run, and refuses it aimed at another repo", () => {
    expect(() =>
      assertGhArgs(["run", "view", "42", "-R", SANDBOX_REPO, "--log"]),
    ).not.toThrow();
    expect(() =>
      assertGhArgs(["run", "view", "42", "-R", "cryskai/crysk", "--log"]),
    ).toThrow(RailViolation);
  });
});

describe("gh rail: run rerun (SB3)", () => {
  test("accepts a rerun of a run in the sandbox", () => {
    expect(() =>
      assertGhArgs(["run", "rerun", "42", "-R", SANDBOX_REPO]),
    ).not.toThrow();
  });

  test("refuses a rerun without the sandbox target, or aimed at another repo", () => {
    const refused: string[][] = [
      ["run", "rerun", "42"],
      ["run", "rerun", "42", "-R", "cryskai/crysk"],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });
});

describe("gh rail: one review-thread reply on a sandbox PR (T5b)", () => {
  const path = `repos/${SANDBOX_REPO}/pulls/7/comments`;
  const reply = (...extra: string[]) => [
    "api",
    path,
    "--method",
    "POST",
    "-f",
    "body=<!-- pr-hero-triage tag=dismissed -->",
    "-F",
    "in_reply_to=99",
    ...extra,
  ];

  test("accepts the exact reply shape", () => {
    expect(() => assertGhArgs(reply())).not.toThrow();
  });

  test("refuses any other field, path, method or repository", () => {
    const refused: string[][] = [
      reply("-f", "commit_id=abc"),
      ["api", path, "--method", "POST", "-f", "body=x"],
      [
        "api",
        path,
        "--method",
        "PATCH",
        "-f",
        "body=x",
        "-F",
        "in_reply_to=99",
      ],
      [
        "api",
        `repos/${SANDBOX_REPO}/issues/7/comments`,
        "--method",
        "POST",
        "-f",
        "body=x",
        "-F",
        "in_reply_to=99",
      ],
      [
        "api",
        "repos/cryskai/crysk/pulls/7/comments",
        "--method",
        "POST",
        "-f",
        "body=x",
        "-F",
        "in_reply_to=99",
      ],
      ["api", path, "--method", "POST", "-f", "body=x", "-F", "in_reply_to=x"],
      ["api", path, "--method", "POST", "-F", "in_reply_to=99", "-f", "body=x"],
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

describe("gh rail: the end-of-options marker", () => {
  // `gh repo clone <sandbox> dir -- <git flags>` passed the -R check, and gh handed
  // the flags after `--` to git. No gh call the runner makes uses `--`, so it is
  // refused on every verb.
  test("refuses -- on every gh call, however the call is otherwise sandbox-only", () => {
    const refused: string[][] = [
      [
        "repo",
        "clone",
        SANDBOX_REPO,
        "/scratch/x",
        "--",
        "--upload-pack=touch /tmp/p",
      ],
      ["pr", "list", "-R", SANDBOX_REPO, "--", "--state"],
      ["api", `repos/${SANDBOX_REPO}/issues`, "--"],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
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

// Class 1. The cluster check used to live in assertApi, so a cluster on any other
// verb reached gh: `-dR other/repo` is `-d -R other/repo` to pflag, and the -R
// then names another repository. The two api cases were already refused there;
// they are here so the rule is proven for every verb, not for api alone.
describe("gh rail: short-flag clusters on every verb", () => {
  test("refuses a single-dash argument longer than two characters, on any verb", () => {
    const refused: string[][] = [
      ["api", "repos/juanmaagd/pr-hero-sandbox", "-iX", "DELETE"],
      ["api", "repos/juanmaagd/pr-hero-sandbox/issues", "-if", "title=x"],
      [
        "pr",
        "close",
        "5",
        "-R",
        SANDBOX_REPO,
        "-dR",
        "juanmaagd/other",
        "--delete-branch",
      ],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });
});

// Class 2. gh resolves a URL positional to the repository the URL names, and that
// overrides -R, so the -R check passes while the call lands elsewhere.
describe("gh rail: a URL cannot override -R", () => {
  test("refuses a URL or a github.com/ path in any argument", () => {
    const url = "https://github.com/other-owner/other-repo/pull/9";
    const refused: string[][] = [
      ["pr", "close", url, "-R", SANDBOX_REPO, "--delete-branch"],
      ["pr", "view", url, "-R", SANDBOX_REPO],
      [
        "pr",
        "view",
        "github.com/other-owner/other-repo/pull/9",
        "-R",
        SANDBOX_REPO,
      ],
      // The verifier's pr comment case. `pr comment` is not an allowed verb, so
      // the verb check refuses it; the cases above are what test the URL rule.
      ["pr", "comment", url, "-R", SANDBOX_REPO, "--body", "x"],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });
});

// Class 3. --org, --user and --env aim a secret or variable at an organization, a
// user or an environment, and --hostname aims any call at another GitHub host.
// The short forms are two characters, so the cluster rule does not catch them.
describe("gh rail: scope and host flags, on every gh call", () => {
  test("refuses each scope or host flag, long, short and attached", () => {
    const refused: string[][] = [
      [
        "secret",
        "set",
        "X",
        "-R",
        SANDBOX_REPO,
        "--org",
        "someorg",
        "--body",
        "x",
      ],
      ["secret", "set", "X", "-R", SANDBOX_REPO, "--user", "--body", "x"],
      [
        "variable",
        "set",
        "X",
        "-R",
        SANDBOX_REPO,
        "--org",
        "someorg",
        "--body",
        "x",
      ],
      [
        "secret",
        "set",
        "X",
        "-R",
        SANDBOX_REPO,
        "--org=someorg",
        "--body",
        "x",
      ],
      [
        "secret",
        "set",
        "X",
        "-R",
        SANDBOX_REPO,
        "-o",
        "someorg",
        "--body",
        "x",
      ],
      ["secret", "set", "X", "-R", SANDBOX_REPO, "-u", "--body", "x"],
      ["variable", "set", "X", "-R", SANDBOX_REPO, "-e", "prod", "--body", "x"],
      ["variable", "set", "X", "-R", SANDBOX_REPO, "--env=prod", "--body", "x"],
      ["api", sandboxApi("actions/variables"), "--hostname", "ghe.example.com"],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });
});

// Class 4, branch half. `sandbox/../main` passes the prefix and the character test,
// but git and GitHub resolve the `..`, so the name reads as main.
describe("scenario branches: no dot or empty segment", () => {
  test("refuses a dot, dot-dot or empty segment", () => {
    for (const name of [
      "sandbox/../main",
      "sandbox/../../tags/v1",
      "sandbox//x",
      "sandbox/x/.",
    ]) {
      expect(() => assertScenarioBranch(name)).toThrow(RailViolation);
    }
    expect(() => assertGitArgs(["push", "origin", "sandbox/../main"])).toThrow(
      RailViolation,
    );
  });

  test("still accepts a dot inside a segment", () => {
    expect(() => assertScenarioBranch("sandbox/smoke.v2")).not.toThrow();
  });
});

// Class 4, api half. The prefix test reads the path as written. GitHub resolves
// `..` and decodes `%2e`, so a path that starts inside the sandbox can end in
// another repository, and a DELETE can reach main.
describe("gh api: dot segments and percent-encoding are refused before the prefix test", () => {
  test("refuses the verifier's paths, reads and writes alike", () => {
    const refused: string[][] = [
      [
        "api",
        "repos/juanmaagd/pr-hero-sandbox/git/refs/heads/sandbox/../main",
        "-X",
        "DELETE",
      ],
      ["api", "repos/juanmaagd/pr-hero-sandbox/%2e%2e/x"],
      ["api", "repos/juanmaagd/pr-hero-sandbox/../pr-hero/pulls"],
    ];
    for (const args of refused) {
      expect(() => assertGhArgs(args)).toThrow(RailViolation);
    }
  });
});

// Class 5, rail half. The clone check reads both the fetch URL and the push URL
// of origin; the rail allows exactly those two reads and no other remote read.
describe("git rail: the remote is read only as origin's fetch and push URLs", () => {
  test("accepts exactly the two reads the clone check makes", () => {
    expect(() => assertGitArgs(["remote", "get-url", "origin"])).not.toThrow();
    expect(() =>
      assertGitArgs(["remote", "get-url", "--push", "origin"]),
    ).not.toThrow();
  });

  test("refuses any other remote read, and a push to a literal URL", () => {
    const refused: string[][] = [
      ["remote", "get-url", "upstream"],
      ["remote", "get-url", "--push", "upstream"],
      ["remote", "get-url", "--all", "origin"],
      ["push", "https://github.com/juanmaagd/pr-hero-sandbox.git", "main"],
    ];
    for (const args of refused) {
      expect(() => assertGitArgs(args)).toThrow(RailViolation);
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

// The GitHub a happy run of init and smoke meets: an empty remote to seed, a
// missing repo to create, and a scenario run that completes on its first read.
const happyGh: GhScript = (args, world) => {
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
  // The claude route's default init needs the subscription token to be listed.
  if (args[0] === "secret" && args[1] === "list") {
    return ok(JSON.stringify([{ name: CLAUDE_TOKEN_SECRET }]));
  }
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
  if (args[0] === "api" && String(args[1]).includes("/actions/runs/")) {
    return ok(JSON.stringify({ artifacts: [] }));
  }
  return ok("[]");
};

describe("recorded calls", () => {
  test("init and smoke send only sandbox-scoped, non-destructive calls", async () => {
    const h = harness({ gh: happyGh });
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

// The hardened rails must still admit every call the runners really make. A
// refusal would surface as a non-zero exit or a "sandbox rail" line, so both are
// checked, and the recorded calls are re-checked against the rails directly.
describe("every real call site passes the hardened rails", () => {
  test("init, smoke, list and clean each reach their normal end", async () => {
    const scenarioPr = {
      number: 7,
      headRefName: "sandbox/smoke-20261016T143000Z",
      url: "https://github.com/juanmaagd/pr-hero-sandbox/pull/7",
      isCrossRepository: false,
      headRepositoryOwner: { login: "juanmaagd" },
    };
    const inFlight = {
      databaseId: 42,
      headSha: "b".repeat(40),
      status: "in_progress",
      conclusion: null,
      workflowName: WORKFLOW_NAME,
      url: "u",
    };

    const init = harness({ gh: happyGh });
    await runInit(init.deps, "v0.2.0");

    // The fake stages no review, so the scenario's verdict is no-outcome and smoke
    // exits 1 by design. What is checked is that it got through to cleanup: the PR
    // closed, and no call was refused on the way.
    const smoke = harness({ gh: happyGh });
    await runSmoke(smoke.deps, {
      ref: "v0.2.0",
      keep: false,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });
    expect(smoke.ghCalls.some((c) => c[0] === "pr" && c[1] === "close")).toBe(
      true,
    );
    expect(smoke.logs.some((l) => l.startsWith("cleanup failed"))).toBe(false);

    const list = harness({
      gh: (args) =>
        args[0] === "pr" && args[1] === "list"
          ? ok(JSON.stringify([scenarioPr]))
          : ok(),
    });
    expect(await runList(list.deps)).toBe(0);

    // A run still in flight, so clean's cancel is one of the real calls.
    let cancelled = false;
    const clean = harness({
      gh: (args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return ok(JSON.stringify([scenarioPr]));
        }
        if (args[0] === "run" && args[1] === "list") {
          return ok(JSON.stringify([inFlight]));
        }
        if (args[0] === "run" && args[1] === "cancel") {
          cancelled = true;
          return ok();
        }
        if (args[0] === "run" && args[1] === "view") {
          return ok(
            JSON.stringify({ status: cancelled ? "completed" : "in_progress" }),
          );
        }
        return ok();
      },
    });
    expect(await runClean(clean.deps)).toBe(0);
    expect(clean.ghCalls.some((c) => c[0] === "run" && c[1] === "cancel")).toBe(
      true,
    );

    for (const h of [init, smoke, list, clean]) {
      for (const args of h.ghCalls) {
        expect(() => assertGhArgs(args)).not.toThrow();
      }
      for (const call of h.gitCalls) {
        expect(() => assertGitArgs(call.args)).not.toThrow();
      }
      expect(h.logs.some((l) => l.includes("sandbox rail"))).toBe(false);
    }
  });
});
