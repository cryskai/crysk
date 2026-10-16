// The outcome publisher (odd/tasks/agent-first-ci.md, T2b / S3). It speaks for
// the outcomes that happen BEFORE the CLI step starts: no credential, an
// unresolved PR, an unverifiable commenter permission, and an install step
// that failed. decidePublication is the pure table; runPublish is the shell.
//
// The builtins-only guard at the bottom mirrors the one in outcome.test.ts. The
// one allowed relative import is "./outcome": it is itself builtins-only at
// runtime (its repo imports are `import type`, erased at transpile), and it
// needs no node_modules, which is the only thing this step cannot have.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TriggerRecord } from "#ci/outcome";
import { decidePublication, runPublish } from "#ci/publish";

const REPO = "acme/widgets";
const SHA = "c".repeat(40);
const RUN_URL = `https://github.com/${REPO}/actions/runs/4242`;
const MODULE_PATH = path.resolve(import.meta.dir, "../../src/ci/publish.ts");
const MARKER = `<!-- pr-hero-outcome v=1 head=${SHA} run=4242 -->`;
// The run this file's record belongs to is 4242, so a marker from an older run
// is 4000 and one from a newer run is 5000. Cleanup deletes only the older one.
const OLDER_MARKER = `<!-- pr-hero-outcome v=1 head=${SHA} run=4000 -->`;
const NEWER_MARKER = `<!-- pr-hero-outcome v=1 head=${SHA} run=5000 -->`;

function record(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
  return {
    v: 1,
    decision: "review",
    params: {},
    pr: 7,
    head_sha: SHA,
    repository: REPO,
    run_id: "4242",
    run_url: RUN_URL,
    ...overrides,
  };
}

describe("decidePublication — the pure table", () => {
  test("no trigger record publishes nothing", () => {
    expect(decidePublication({ record: undefined, cliStarted: false })).toEqual(
      { kind: "none" },
    );
  });

  test("a review whose CLI succeeded cleans up its PR, and posts neither status nor comment", () => {
    // WHY: an outcome comment from an earlier run contradicts the review this
    // run completed, and the CLI owns this run's status and comment. So the plan
    // names only the PR to clean, and the run whose comments may be removed.
    expect(
      decidePublication({
        record: record(),
        cliStarted: true,
        cliSucceeded: true,
      }),
    ).toEqual({
      kind: "cleanup",
      repository: REPO,
      pr: 7,
      runId: "4242",
    });
  });

  test("a review whose CLI started but did not succeed is left alone, so the CLI's own output stays the explanation", () => {
    // WHY: cli-started is written before the CLI runs, so an early CLI failure
    // leaves no outcome of its own. Cleaning up here would delete the only
    // explanation on the PR. T2c moves the CLI's outcomes into this step.
    expect(
      decidePublication({
        record: record(),
        cliStarted: true,
        cliSucceeded: false,
      }),
    ).toEqual({ kind: "none" });
  });

  test("a review whose CLI started without a known PR has nothing to clean up", () => {
    const input = {
      record: record({ pr: undefined, head_sha: undefined }),
      cliStarted: true,
      cliSucceeded: true,
    };
    expect(decidePublication(input)).toEqual({ kind: "none" });
  });

  test.each(["ignore", "denied"] as const)(
    "a %s decision publishes nothing, with or without the marker",
    (decision) => {
      const input = { record: record({ decision }), cliStarted: false };
      expect(decidePublication(input)).toEqual({ kind: "none" });
    },
  );

  test("a review with no CLI start and a PR is an install failure, posted on the PR", () => {
    const plan = decidePublication({ record: record(), cliStarted: false });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.rendered.code).toBe("PRH-INSTALL-FAILED");
    expect(plan.rendered.annotation).toStartWith(
      "::error title=pr-hero PRH-INSTALL-FAILED::",
    );
    expect(plan.rendered.annotation).toContain("An install step failed");
    expect(plan.rendered.annotation).toContain("gh run rerun 4242 --failed");
    expect(plan.repository).toBe(REPO);
    expect(plan.pr).toBe(7);
    expect(plan.headSha).toBe(SHA);
  });

  test("the status is an error on pr-hero's own context, linked to the run", () => {
    const plan = decidePublication({ record: record(), cliStarted: false });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.status).toEqual({
      state: "error",
      context: "pr-hero",
      description: "PRH-INSTALL-FAILED: An install step failed",
      targetUrl: RUN_URL,
    });
  });

  test("the comment opens with the marker line, then the summary block", () => {
    const plan = decidePublication({ record: record(), cliStarted: false });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    const [first, blank, heading] = plan.commentBody.split("\n");
    expect(first).toBe(MARKER);
    expect(blank).toBe("");
    expect(heading).toBe("### PRH-INSTALL-FAILED");
  });

  test("a review whose PR could not be resolved is posted nowhere: annotation only", () => {
    // The trigger records the review decision with a class (not install).
    // Install never ran, but the cause is the unresolved PR, not the install.
    const plan = decidePublication({
      record: record({
        pr: undefined,
        head_sha: undefined,
        cls: { kind: "trigger", check: "pr-unresolved" },
      }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("local");
    if (plan.kind !== "local") return;
    expect(plan.rendered.code).toBe("PRH-PR-UNRESOLVED");
    expect(plan.rendered.owner).toBe("config");
    expect(plan.rendered.annotation).toContain(
      "pr-hero could not determine the pull request number or head",
    );
  });

  test("an install failure without a PR or a valid head is annotation only", () => {
    const plan = decidePublication({
      record: record({ pr: undefined, head_sha: undefined }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("local");
    if (plan.kind !== "local") return;
    expect(plan.rendered.code).toBe("PRH-INSTALL-FAILED");
  });

  test("a PR number without a sha posts its comment, marked head=unknown, and no status", () => {
    // WHY: a status needs a sha, but the PR still gets its one sticky comment.
    const plan = decidePublication({
      record: record({ head_sha: undefined }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.status).toBeUndefined();
    expect(plan.commentBody.split("\n")[0]).toBe(
      "<!-- pr-hero-outcome v=1 head=unknown run=4242 -->",
    );
  });

  test("no credentials on a claude route is PRH-CRED-MISSING with the route named", () => {
    const plan = decidePublication({
      record: record({
        decision: "no-credentials",
        params: { backend: "claude" },
      }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.rendered.code).toBe("PRH-CRED-MISSING");
    expect(plan.rendered.owner).toBe("config");
    expect(plan.status?.description).toBe(
      "PRH-CRED-MISSING: No credential for the claude route reached the action",
    );
    expect(plan.rendered.annotation).toContain(
      "gh secret set CLAUDE_CODE_OAUTH_TOKEN",
    );
  });

  test("no credentials on an opencode route names the OpenCode secret", () => {
    const plan = decidePublication({
      record: record({
        decision: "no-credentials",
        params: { backend: "opencode" },
      }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.rendered.annotation).toContain(
      "set the OPENCODE_AUTH_JSON secret",
    );
  });

  test("no credentials without a PR is annotation only, and the cause stays CRED-MISSING", () => {
    const plan = decidePublication({
      record: record({
        decision: "no-credentials",
        params: { backend: "claude" },
        pr: undefined,
        head_sha: undefined,
      }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("local");
    if (plan.kind !== "local") return;
    expect(plan.rendered.code).toBe("PRH-CRED-MISSING");
  });

  test("a 5xx from the permission lookup is PRH-GITHUB-UNAVAILABLE, the server variant", () => {
    const plan = decidePublication({
      record: record({
        decision: "unverifiable",
        cls: { kind: "github", status: 503 },
      }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.rendered.code).toBe("PRH-GITHUB-UNAVAILABLE");
    expect(plan.rendered.owner).toBe("provider");
    expect(plan.rendered.annotation).toContain("HTTP 503");
    expect(plan.rendered.annotation).toContain(
      "once GitHub is serving requests again",
    );
  });

  test("a rate-limited lookup is PRH-GITHUB-UNAVAILABLE with the rate-limit wording", () => {
    const plan = decidePublication({
      record: record({
        decision: "unverifiable",
        cls: { kind: "github", status: 403, rateLimited: true },
      }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.rendered.code).toBe("PRH-GITHUB-UNAVAILABLE");
    expect(plan.rendered.annotation).toContain("rate limit");
  });

  test("a 403 the caller did not read as a rate limit keeps the catalog's permission reading", () => {
    const plan = decidePublication({
      record: record({
        decision: "unverifiable",
        cls: { kind: "github", status: 403 },
      }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.rendered.code).toBe("PRH-TOKEN-PERMISSION");
  });

  test("an unverifiable lookup with no captured status is PRH-UNCLASSIFIED, never a guessed outage", () => {
    const plan = decidePublication({
      record: record({ decision: "unverifiable" }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.rendered.code).toBe("PRH-UNCLASSIFIED");
    expect(plan.rendered.annotation).toContain(
      "the commenter permission check",
    );
    expect(plan.rendered.annotation).not.toContain("<step>");
  });

  test("an unverifiable lookup without a head sha still posts its comment, and no status", () => {
    // WHY: the trigger omits the head on an unverifiable lookup, and the
    // PR is known, so the comment is the one place the outcome can be seen.
    const plan = decidePublication({
      record: record({
        decision: "unverifiable",
        cls: { kind: "github", status: 500 },
        head_sha: undefined,
      }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.status).toBeUndefined();
    expect(plan.commentBody.split("\n")[0]).toBe(
      "<!-- pr-hero-outcome v=1 head=unknown run=4242 -->",
    );
  });

  test("a parsed setup record names its own failure instead of the generic install failure", () => {
    const plan = decidePublication({
      record: record(),
      cliStarted: false,
      setup: {
        v: 1,
        cls: { kind: "config-parse", source: "routing" },
        detail: "the routing input is not valid JSON",
      },
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.rendered.code).toBe("PRH-ROUTING-INVALID");
    expect(plan.rendered.owner).toBe("config");
    expect(plan.rendered.annotation).toContain(
      "the routing input is not valid JSON",
    );
  });

  test("a setup record for a malformed auth input is PRH-CRED-UNUSABLE, owned by configuration, with no route placeholder", () => {
    const plan = decidePublication({
      record: record(),
      cliStarted: false,
      setup: {
        v: 1,
        cls: { kind: "credential", failureClass: "malformed_payload" },
        detail: "the opencode-auth input is not valid JSON",
      },
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.rendered.code).toBe("PRH-CRED-UNUSABLE");
    expect(plan.rendered.owner).toBe("config");
    expect(plan.rendered.annotation).not.toContain("<backend>");
    expect(plan.rendered.annotation).not.toContain("<provider>");
  });

  test("an unverifiable 403 with no scope names the refused token, never a scope pr-hero does not know", () => {
    const plan = decidePublication({
      record: record({
        decision: "unverifiable",
        params: { step: "the commenter permission check" },
        cls: { kind: "github", status: 403 },
      }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.rendered.code).toBe("PRH-TOKEN-PERMISSION");
    expect(plan.rendered.annotation).toContain(
      "GitHub refused the workflow token (HTTP 403) during the commenter permission check",
    );
    expect(plan.rendered.annotation).not.toContain("lacks");
  });

  test("the status context is the name the required check reads (COMMIT_STATUS_CONTEXT)", () => {
    // WHY a drift test: publish.ts runs before install and cannot import the
    // constant from src/pr/preflight.ts, so the two are pinned to each other.
    const preflight = readFileSync(
      path.resolve(import.meta.dir, "../../src/pr/preflight.ts"),
      "utf8",
    );
    const expected = /export const COMMIT_STATUS_CONTEXT = "([^"]+)"/.exec(
      preflight,
    )?.[1];
    const plan = decidePublication({ record: record(), cliStarted: false });
    expect(plan.kind).toBe("remote");
    expect(expected).toBeDefined();
    if (plan.kind === "remote") {
      expect(plan.status?.context as string).toBe(expected as string);
    }
  });

  test("the status description is one line clipped to 140 characters", () => {
    const plan = decidePublication({
      record: record({
        decision: "no-credentials",
        params: { backend: "x".repeat(300) },
      }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("remote");
    if (plan.kind !== "remote") return;
    expect(plan.status?.description.length).toBeLessThanOrEqual(140);
    expect(plan.status?.description).not.toContain("\n");
    expect(plan.status?.description.startsWith("PRH-CRED-MISSING: ")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// The shell, with a fake `gh` that answers by endpoint. The outcome directory
// is a real temp directory, so trigger.json and cli-started are read from disk.
// ---------------------------------------------------------------------------

type GhResult = { exitCode: number; stdout: string; stderr: string };
type Call = { args: string[]; stdin: string | undefined };

const ok = (stdout = ""): GhResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): GhResult => ({
  exitCode: 1,
  stdout: "",
  stderr,
});

// One JSON array per listed comment, as the real --jq filter prints them:
// [id, login, user type, first line of the body].
function listing(...rows: Array<[number, string, string, string]>): GhResult {
  return ok(rows.map((row) => JSON.stringify(row)).join("\n"));
}

function runPublishIn(options: {
  record?: TriggerRecord | string;
  cliStarted?: boolean;
  cliSucceeded?: boolean;
  setup?: object | string;
  status?: GhResult[];
  create?: GhResult;
  list?: GhResult;
  remove?: GhResult;
  // The answer to the GraphQL `viewer` lookup. Unset, the lookup fails.
  viewer?: GhResult;
  env?: Record<string, string>;
}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-publish-"));
  try {
    if (options.record !== undefined) {
      const text =
        typeof options.record === "string"
          ? options.record
          : JSON.stringify(options.record);
      writeFileSync(path.join(dir, "trigger.json"), text);
    }
    if (options.cliStarted === true) {
      writeFileSync(path.join(dir, "cli-started"), "");
    }
    if (options.cliSucceeded === true) {
      writeFileSync(path.join(dir, "cli-succeeded"), "");
    }
    if (options.setup !== undefined) {
      writeFileSync(
        path.join(dir, "setup.json"),
        typeof options.setup === "string"
          ? options.setup
          : JSON.stringify(options.setup),
      );
    }
    const statusAnswers = [...(options.status ?? [ok()])];
    const calls: Call[] = [];
    let stdout = "";
    let summary = "";
    const exitCode = runPublish({
      env: {
        PRHERO_OUTCOME_DIR: dir,
        GITHUB_REPOSITORY: REPO,
        GITHUB_RUN_ID: "4242",
        GITHUB_SERVER_URL: "https://github.com",
        GH_TOKEN: "ghs_SECRET-VALUE-PUBLISH",
        ...options.env,
      },
      gh: (args, stdin) => {
        calls.push({ args: [...args], stdin });
        // The viewer lookup has no repos/ endpoint, so it is routed first.
        if (args.includes("graphql")) {
          return options.viewer ?? fail("gh: viewer not answered");
        }
        const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
        if (endpoint.includes("/statuses/")) {
          return statusAnswers.length > 1
            ? (statusAnswers.shift() as GhResult)
            : (statusAnswers[0] ?? ok());
        }
        if (args.includes("DELETE")) return options.remove ?? ok();
        if (args.includes("POST")) {
          return options.create ?? ok(JSON.stringify([20, "bot-a"]));
        }
        return options.list ?? ok("");
      },
      sleep: () => {},
      stdout: (text) => {
        stdout += text;
      },
      appendSummary: (text) => {
        summary += text;
      },
    });
    return {
      exitCode,
      stdout,
      summary,
      calls,
      dir,
      cliStartedLeft: existsSync(path.join(dir, "cli-started")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function statusCalls(calls: Call[]): Call[] {
  return calls.filter((call) =>
    call.args.some((arg) => arg.includes("/statuses/")),
  );
}

function commentPost(calls: Call[]): Call | undefined {
  return calls.find(
    (call) => call.args.includes("POST") && call.stdin !== undefined,
  );
}

function deletions(calls: Call[]): string[] {
  return calls
    .filter((call) => call.args.includes("DELETE"))
    .map((call) => call.args.find((arg) => arg.includes("/comments/")) ?? "");
}

describe("runPublish — the shell", () => {
  test("nothing is written when no trigger record exists", () => {
    const run = runPublishIn({});
    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.stdout).toBe("");
  });

  test("a CLI-started run with a known PR never posts a status or a comment", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliSucceeded: true,
      viewer: ok("pr-hero-bot"),
      list: listing(),
    });
    expect(run.exitCode).toBe(0);
    expect(statusCalls(run.calls)).toEqual([]);
    expect(run.calls.filter((call) => call.args.includes("POST"))).toEqual([]);
    expect(run.summary).toBe("");
  });

  test("a CLI that started and did not succeed deletes nothing and makes no gh call", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliSucceeded: false,
      viewer: ok("pr-hero-bot"),
      list: listing([10, "pr-hero-bot", "Bot", OLDER_MARKER]),
    });
    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.stdout).toBe("");
  });

  test("an install failure writes the annotation and the summary, then posts", () => {
    const run = runPublishIn({ record: record() });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("::error title=pr-hero PRH-INSTALL-FAILED::");
    expect(run.summary).toContain("### PRH-INSTALL-FAILED");
  });

  test("the commit status is posted before the comment", () => {
    const run = runPublishIn({ record: record() });
    const firstStatus = run.calls.findIndex((call) =>
      call.args.some((arg) => arg.includes("/statuses/")),
    );
    const comment = run.calls.indexOf(commentPost(run.calls) as Call);
    expect(firstStatus).toBeGreaterThanOrEqual(0);
    expect(comment).toBeGreaterThan(firstStatus);
  });

  test("the status call carries the context, the state, the description and the run link", () => {
    const run = runPublishIn({ record: record() });
    const [status] = statusCalls(run.calls);
    expect(status?.args).toContain(`repos/${REPO}/statuses/${SHA}`);
    expect(status?.args).toContain("state=error");
    expect(status?.args).toContain("context=pr-hero");
    expect(status?.args).toContain(
      "description=PRH-INSTALL-FAILED: An install step failed",
    );
    expect(status?.args).toContain(`target_url=${RUN_URL}`);
  });

  test("the comment is a new issue comment whose first line is the marker", () => {
    const run = runPublishIn({ record: record() });
    const post = commentPost(run.calls);
    expect(post?.args).toContain(`repos/${REPO}/issues/7/comments`);
    expect(post?.args).toContain("body=@-");
    expect(post?.stdin?.split("\n")[0]).toBe(MARKER);
  });

  test("older outcome comments of the same author are deleted; others are kept", () => {
    const run = runPublishIn({
      record: record(),
      list: listing(
        [10, "bot-a", "User", OLDER_MARKER],
        [11, "someone-else", "User", OLDER_MARKER],
        [12, "bot-a", "User", "Quoting it here: <!-- pr-hero-outcome"],
        [13, "bot-a", "User", OLDER_MARKER],
        [25, "bot-a", "User", NEWER_MARKER],
      ),
    });
    // The new comment is id 20 by bot-a. 25 is newer in both id and run (a
    // concurrent run), so it stays; 11 belongs to another author; 12 is not an
    // outcome.
    expect(deletions(run.calls)).toEqual([
      `repos/${REPO}/issues/comments/10`,
      `repos/${REPO}/issues/comments/13`,
    ]);
  });

  test("the post-path cleanup keeps a newer run's comment even when that comment was posted first", () => {
    // WHY: run ids order the runs, not comment ids. A run that started later can
    // post before this one, so its comment has a LOWER id than the new comment
    // (20) and only the run bound keeps it.
    const run = runPublishIn({
      record: record(),
      list: listing(
        [10, "bot-a", "User", OLDER_MARKER],
        [15, "bot-a", "User", NEWER_MARKER],
      ),
    });
    expect(deletions(run.calls)).toEqual([`repos/${REPO}/issues/comments/10`]);
  });

  test("when this run's own id is not a positive integer, no older comment can be ordered, so none is deleted", () => {
    // WHY: with no run order, an older comment cannot be proven older, so the
    // safe default is to delete nothing. GITHUB_RUN_ID is blanked so the
    // record's id is the only one the step has.
    const run = runPublishIn({
      record: record({ run_id: "abc" }),
      list: listing([10, "bot-a", "User", OLDER_MARKER]),
      env: { GITHUB_RUN_ID: "" },
    });
    expect(deletions(run.calls)).toEqual([]);
  });

  test("an outcome comment whose marker names no positive run id is kept on the post path", () => {
    // WHY: with no run id there is no order, so the comment is not this step's
    // to remove. Covers a missing run=, run=0 and a non-numeric run=.
    const run = runPublishIn({
      record: record(),
      list: listing(
        [10, "bot-a", "User", `<!-- pr-hero-outcome v=1 head=${SHA} -->`],
        [11, "bot-a", "User", `<!-- pr-hero-outcome v=1 head=${SHA} run=0 -->`],
        [
          12,
          "bot-a",
          "User",
          `<!-- pr-hero-outcome v=1 head=${SHA} run=abc -->`,
        ],
      ),
    });
    expect(deletions(run.calls)).toEqual([]);
  });

  test("an unknown author deletes nothing", () => {
    const run = runPublishIn({
      record: record(),
      create: ok(JSON.stringify([20, ""])),
      list: listing([10, "", "User", MARKER]),
    });
    expect(deletions(run.calls)).toEqual([]);
    expect(run.exitCode).toBe(0);
  });

  test("a failed cleanup never fails the run: the fresh comment already landed", () => {
    const run = runPublishIn({
      record: record(),
      list: fail("gh: Server Error (HTTP 502)"),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("::warning title=pr-hero::");
  });

  test("no PR writes when the PR is missing: annotation and summary only", () => {
    const run = runPublishIn({
      record: record({
        decision: "no-credentials",
        params: { backend: "claude" },
        pr: undefined,
        head_sha: undefined,
      }),
    });
    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.stdout).toContain("PRH-CRED-MISSING");
    expect(run.summary).toContain("### PRH-CRED-MISSING");
  });

  test("a failed status is retried once, and the retry's success is the result", () => {
    const run = runPublishIn({
      record: record(),
      status: [fail("gh: Server Error (HTTP 500)"), ok()],
    });
    expect(statusCalls(run.calls)).toHaveLength(2);
    expect(run.exitCode).toBe(0);
    expect(commentPost(run.calls)).toBeDefined();
  });

  test("a status that fails twice is PRH-STATUS-WRITE-FAILED, the comment still posts, exit 1", () => {
    const run = runPublishIn({
      record: record(),
      status: [fail("gh: Resource not accessible (HTTP 403)")],
    });
    expect(statusCalls(run.calls)).toHaveLength(2);
    expect(run.stdout).toContain("PRH-STATUS-WRITE-FAILED");
    expect(run.stdout).toContain("statuses: write");
    expect(commentPost(run.calls)).toBeDefined();
    expect(run.exitCode).toBe(1);
  });

  test("a 5xx on the status is the server variant of PRH-STATUS-WRITE-FAILED", () => {
    const run = runPublishIn({
      record: record(),
      status: [fail("gh: Server Error (HTTP 503)")],
    });
    expect(run.stdout).toContain("PRH-STATUS-WRITE-FAILED");
    expect(run.stdout).toContain("once GitHub accepts commit statuses again");
    expect(run.exitCode).toBe(1);
  });

  test("a failed comment is an error naming the comment, and exit 1", () => {
    const run = runPublishIn({
      record: record(),
      create: fail("gh: Forbidden (HTTP 403)"),
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("::error title=pr-hero::");
    expect(run.stdout).toContain("outcome comment");
    expect(deletions(run.calls)).toEqual([]);
  });

  test("the comment body and the token never reach stdout or the summary", () => {
    const run = runPublishIn({
      record: record({
        decision: "no-credentials",
        params: { backend: "claude" },
      }),
    });
    expect(run.stdout).not.toContain("ghs_SECRET-VALUE-PUBLISH");
    expect(run.summary).not.toContain("ghs_SECRET-VALUE-PUBLISH");
    expect(run.stdout).not.toContain(MARKER);
  });

  test("a record that is present but does not parse is an error, never a silent skip", () => {
    const run = runPublishIn({ record: "{ not json" });
    expect(run.exitCode).toBe(1);
    expect(run.calls).toEqual([]);
    expect(run.stdout).toContain("::error title=pr-hero PRH-UNCLASSIFIED::");
    expect(run.summary).toContain("### PRH-UNCLASSIFIED");
  });

  test("an unreadable record after the CLI started is still the CLI's to report", () => {
    const run = runPublishIn({ record: "{ not json", cliStarted: true });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("a no-credentials record with a PR but no head still gets its comment, and no status", () => {
    const run = runPublishIn({
      record: record({
        decision: "no-credentials",
        params: { backend: "claude" },
        head_sha: undefined,
      }),
    });
    expect(run.exitCode).toBe(0);
    expect(statusCalls(run.calls)).toEqual([]);
    expect(commentPost(run.calls)?.args).toContain(
      `repos/${REPO}/issues/7/comments`,
    );
  });

  test("a setup record is posted on the PR under its own code, status and comment alike", () => {
    const run = runPublishIn({
      record: record(),
      setup: {
        v: 1,
        cls: { kind: "config-parse", source: "routing" },
        detail: "the routing input is not valid JSON",
      },
    });
    expect(run.stdout).toContain("::error title=pr-hero PRH-ROUTING-INVALID::");
    expect(run.stdout).not.toContain("PRH-INSTALL-FAILED");
    const [status] = statusCalls(run.calls);
    expect(status?.args).toContain(
      "description=PRH-ROUTING-INVALID: PRHERO_ROUTING is invalid: the routing input is not valid JSON",
    );
    expect(commentPost(run.calls)).toBeDefined();
  });

  test("an unreadable setup record falls back to the install failure, with a warning", () => {
    const run = runPublishIn({ record: record(), setup: "{ not json" });
    expect(run.stdout).toContain("::warning title=pr-hero::");
    expect(run.stdout).toContain("::error title=pr-hero PRH-INSTALL-FAILED::");
  });

  test("a setup record outside the two classes the setup step writes is refused the same way", () => {
    const run = runPublishIn({
      record: record(),
      setup: {
        v: 1,
        cls: { kind: "trigger", check: "no-credential" },
        detail: "x",
      },
    });
    expect(run.stdout).toContain("::warning title=pr-hero::");
    expect(run.stdout).toContain("PRH-INSTALL-FAILED");
    expect(run.stdout).not.toContain("PRH-CRED-MISSING");
  });

  test("a record for another run is refused: nothing is posted", () => {
    const run = runPublishIn({
      record: record({ run_id: "9999" }),
      env: { GITHUB_RUN_ID: "4242" },
    });
    expect(run.exitCode).toBe(1);
    expect(run.calls).toEqual([]);
    expect(run.stdout).toContain("belongs to another run");
  });
});

describe("runPublish — cleanup once the CLI started", () => {
  const BOT_AUTHOR = "github-actions[bot]";
  const removedIds = (run: { calls: Call[] }) =>
    deletions(run.calls).map((url) => url.split("/").pop());

  test("with a viewer login, deletes only that login's older marker comments", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliSucceeded: true,
      viewer: ok("pr-hero-bot\n"),
      list: listing(
        [10, "pr-hero-bot", "Bot", OLDER_MARKER],
        [11, "alice", "User", OLDER_MARKER],
        [12, "pr-hero-bot", "Bot", "Thanks for the review"],
        [13, "pr-hero-bot", "Bot", OLDER_MARKER],
        // A Bot-typed marker by another login: the viewer chain keeps it.
        [14, BOT_AUTHOR, "Bot", OLDER_MARKER],
      ),
    });
    expect(deletions(run.calls)).toEqual([
      `repos/${REPO}/issues/comments/10`,
      `repos/${REPO}/issues/comments/13`,
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.summary).toBe("");
    expect(statusCalls(run.calls)).toEqual([]);
    expect(run.calls.filter((call) => call.args.includes("POST"))).toEqual([]);
  });

  test("the cleanup never deletes this run's own marker or a newer run's", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliSucceeded: true,
      viewer: ok("pr-hero-bot"),
      list: listing(
        [10, "pr-hero-bot", "Bot", OLDER_MARKER],
        [11, "pr-hero-bot", "Bot", MARKER],
        [12, "pr-hero-bot", "Bot", NEWER_MARKER],
      ),
    });
    expect(removedIds(run)).toEqual(["10"]);
  });

  test("the cleanup keeps an outcome comment whose marker names no positive run id", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliSucceeded: true,
      viewer: ok("pr-hero-bot"),
      list: listing(
        [10, "pr-hero-bot", "Bot", `<!-- pr-hero-outcome v=1 head=${SHA} -->`],
        [
          11,
          "pr-hero-bot",
          "Bot",
          `<!-- pr-hero-outcome v=1 head=${SHA} run=0 -->`,
        ],
      ),
    });
    expect(deletions(run.calls)).toEqual([]);
  });

  test("a viewer login matches the REST bot login, which carries a [bot] suffix", () => {
    // WHY: GraphQL names the workflow token's login `github-actions`, while REST
    // lists the same account as `github-actions[bot]`. Without this match a
    // successful viewer lookup would delete nothing at all.
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliSucceeded: true,
      viewer: ok("github-actions\n"),
      list: listing(
        [10, BOT_AUTHOR, "Bot", OLDER_MARKER],
        [11, "alice", "User", OLDER_MARKER],
      ),
    });
    expect(removedIds(run)).toEqual(["10"]);
  });

  test.each([
    ["fails", fail("gh: Bad credentials (HTTP 401)")],
    ["answers empty", ok("")],
  ])(
    "when the viewer lookup %s, deletes only Bot-typed marker comments",
    (_label, viewer) => {
      const run = runPublishIn({
        record: record(),
        cliStarted: true,
        cliSucceeded: true,
        viewer,
        list: listing(
          [10, "pr-hero-bot", "Bot", OLDER_MARKER],
          [11, "alice", "User", OLDER_MARKER],
          [12, BOT_AUTHOR, "Bot", OLDER_MARKER],
          [13, "bob", "User", "Thanks for the review"],
        ),
      });
      expect(removedIds(run)).toEqual(["10", "12"]);
      expect(run.exitCode).toBe(0);
      expect(statusCalls(run.calls)).toEqual([]);
      expect(run.calls.filter((call) => call.args.includes("POST"))).toEqual(
        [],
      );
    },
  );

  test("when the comments cannot be listed, one notice names the cleanup, nothing is deleted, exit 0", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliSucceeded: true,
      viewer: ok("pr-hero-bot"),
      list: fail("gh: Server Error (HTTP 502)"),
    });
    expect(run.exitCode).toBe(0);
    expect(deletions(run.calls)).toEqual([]);
    expect(run.stdout.match(/::notice title=pr-hero::/g)).toHaveLength(1);
    expect(run.stdout).toContain(
      "could not clean up its older outcome comments",
    );
    expect(run.stdout).not.toContain("::error");
    expect(run.stdout).not.toContain("::warning");
    expect(statusCalls(run.calls)).toEqual([]);
    expect(run.calls.filter((call) => call.args.includes("POST"))).toEqual([]);
  });

  test("a failed single delete is a warning, and the other deletions still run", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliSucceeded: true,
      viewer: ok("pr-hero-bot"),
      list: listing(
        [10, "pr-hero-bot", "Bot", OLDER_MARKER],
        [11, "pr-hero-bot", "Bot", OLDER_MARKER],
      ),
      remove: fail("gh: Server Error (HTTP 500)"),
    });
    expect(deletions(run.calls)).toHaveLength(2);
    expect(run.stdout).toContain("::warning title=pr-hero::");
    expect(run.stdout).not.toContain("::error");
    expect(run.exitCode).toBe(0);
  });

  test("with no known PR, a CLI-started run makes no gh call at all", () => {
    const run = runPublishIn({
      record: record({ pr: undefined, head_sha: undefined }),
      cliStarted: true,
      cliSucceeded: true,
    });
    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.stdout).toBe("");
  });

  test("a pre-CLI outcome posts, cleans up by the new comment's author, and never asks for the viewer", () => {
    // WHY: the viewer lookup belongs to the CLI-started cleanup only. A
    // pre-CLI outcome keeps its author-based cleanup exactly as before.
    const run = runPublishIn({
      record: record(),
      list: listing(
        [10, "bot-a", "User", OLDER_MARKER],
        [11, "someone-else", "User", OLDER_MARKER],
      ),
    });
    expect(run.exitCode).toBe(0);
    expect(statusCalls(run.calls)).toHaveLength(1);
    expect(commentPost(run.calls)).toBeDefined();
    expect(run.calls.some((call) => call.args.includes("graphql"))).toBe(false);
    expect(removedIds(run)).toEqual(["10"]);
  });
});

describe("publish.ts runs before `bun install`", () => {
  // The real entry point, spawned with an empty PATH and HOME: it must start
  // and finish with no node_modules and no gh, when there is nothing to say.
  test("as a process, a CLI-started run with no PR exits 0 and writes nothing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-publish-proc-"));
    try {
      writeFileSync(
        path.join(dir, "trigger.json"),
        JSON.stringify(record({ pr: undefined, head_sha: undefined })),
      );
      writeFileSync(path.join(dir, "cli-started"), "");
      const result = Bun.spawnSync([process.execPath, MODULE_PATH], {
        cwd: dir,
        env: {
          PRHERO_OUTCOME_DIR: dir,
          GITHUB_REPOSITORY: REPO,
          GITHUB_RUN_ID: "4242",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
          HOME: dir,
          PATH: dir,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(existsSync(path.join(dir, "summary"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("as a process, a CLI-started run whose gh is missing still exits 0, with one notice", () => {
    // WHY: Bun throws when gh is not on PATH. Cleanup is best effort and must
    // exit 0, so that throw is handled as a failed call, reported as a notice.
    const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-publish-nogh-"));
    try {
      writeFileSync(path.join(dir, "trigger.json"), JSON.stringify(record()));
      writeFileSync(path.join(dir, "cli-started"), "");
      writeFileSync(path.join(dir, "cli-succeeded"), "");
      const result = Bun.spawnSync([process.execPath, MODULE_PATH], {
        cwd: dir,
        env: {
          PRHERO_OUTCOME_DIR: dir,
          GITHUB_REPOSITORY: REPO,
          GITHUB_RUN_ID: "4242",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
          HOME: dir,
          PATH: dir,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("::notice title=pr-hero::");
      expect(result.stdout.toString()).not.toContain("::error");
      expect(existsSync(path.join(dir, "summary"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("it imports only builtins, plus the builtins-only ./outcome sibling", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    expect(runtimeImportViolations(source, ["./outcome"])).toEqual([]);
  });

  test("the guard itself fails on a repo import and passes a type-only one", () => {
    expect(
      runtimeImportViolations('import { a } from "../security/x";', [
        "./outcome",
      ]),
    ).toHaveLength(1);
    expect(
      runtimeImportViolations('import { a } from "./other";', ["./outcome"]),
    ).toHaveLength(1);
    expect(
      runtimeImportViolations('import type { A } from "../security/x";', [
        "./outcome",
      ]),
    ).toEqual([]);
  });
});

// The same rule as outcome.test.ts's runtimeImportViolations (kept as a copy:
// that helper is private to its file, and this one takes an allowlist).
function runtimeImportViolations(
  source: string,
  allowed: readonly string[] = [],
): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const ok = (specifier: string): boolean =>
    specifier.startsWith("node:") ||
    specifier === "bun" ||
    specifier.startsWith("bun:") ||
    allowed.includes(specifier);
  const violations: string[] = [];
  for (const match of code.matchAll(
    /\b(import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/g,
  )) {
    const clause = match[2] ?? "";
    const specifier = match[3] ?? "";
    if (/^\s*type\b/.test(clause)) continue;
    if (!ok(specifier)) violations.push(`${match[1]} from "${specifier}"`);
  }
  for (const match of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    const specifier = match[1] ?? "";
    if (!ok(specifier)) violations.push(`import "${specifier}"`);
  }
  for (const match of code.matchAll(
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    const specifier = match[1] ?? "";
    if (!ok(specifier)) violations.push(`dynamic "${specifier}"`);
  }
  return violations;
}
