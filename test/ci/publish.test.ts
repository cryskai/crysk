// The outcome publisher (odd/tasks/agent-first-ci.md, T2b / S3, T2c). It speaks
// for the outcomes that happen BEFORE the CLI step starts: no credential, an
// unresolved PR, an unverifiable commenter permission, and an install step
// that failed. Once the CLI started, its cli.json decides: a reviewed run cleans
// up, and an error, a hunters-failed run or a missing record is published.
// decidePublication is the pure table; runPublish is the shell.
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
import type { CliRecord, TriggerRecord } from "#ci/outcome";
import { decidePublication, runPublish } from "#ci/publish";

const REPO = "acme/widgets";
const SHA = "c".repeat(40);
// The head the trigger recorded, and a head the PR moved to before the CLI
// reviewed it. The CLI's cli.json may name REVIEWED_HEAD; the trigger's head is
// never a cleanup proof.
const TRIGGER_HEAD = "e".repeat(40);
const REVIEWED_HEAD = "d".repeat(40);
const RUN_URL = `https://github.com/${REPO}/actions/runs/4242`;
const MODULE_PATH = path.resolve(import.meta.dir, "../../src/ci/publish.ts");
const MARKER = `<!-- pr-hero-outcome v=1 head=${SHA} run=4242 attempt=1 -->`;
// The run this file's record belongs to is 4242, so a marker from an older run
// is 4000 and one from a newer run is 5000. Cleanup deletes only the older one.
const OLDER_MARKER = `<!-- pr-hero-outcome v=1 head=${SHA} run=4000 attempt=1 -->`;
const NEWER_MARKER = `<!-- pr-hero-outcome v=1 head=${SHA} run=5000 attempt=1 -->`;
// The same run's first attempt, which a re-run (attempt 2) must replace.
const FIRST_ATTEMPT_MARKER = `<!-- pr-hero-outcome v=1 head=${SHA} run=4242 attempt=1 -->`;
// What the CLI writes to cli.json when its review completed.
const REVIEWED: CliRecord = { v: 1, outcome: "reviewed" };

function record(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
  return {
    v: 1,
    decision: "review",
    params: {},
    pr: 7,
    head_sha: SHA,
    repository: REPO,
    run_id: "4242",
    run_attempt: 1,
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

  // WHY the record decides: once the CLI started, cli.json says what its run
  // did. A trigger head is never a cleanup proof, so the table never reads it.
  describe("once the CLI started, its record decides", () => {
    test("a reviewed record cleans up its PR, and posts neither status nor comment", () => {
      // WHY: an outcome comment from an earlier run contradicts the review this
      // run completed, and the CLI owns this run's status and comment. So the
      // plan names only the PR to clean, and the run whose comments may go.
      expect(
        decidePublication({
          record: record(),
          cliStarted: true,
          cliRecord: REVIEWED,
        }),
      ).toEqual({
        kind: "cleanup",
        repository: REPO,
        pr: 7,
        runId: "4242",
        runAttempt: 1,
      });
    });

    // F002: a failed `gh pr view` at trigger time records no head. The CLI's own
    // record does not need one.
    test("a reviewed record cleans up even when the trigger recorded no head", () => {
      expect(
        decidePublication({
          record: record({ head_sha: undefined }),
          cliStarted: true,
          cliRecord: REVIEWED,
        }),
      ).toMatchObject({ kind: "cleanup", pr: 7 });
    });

    // F004: the PR head can move after the trigger. The reviewed record is the
    // proof of the review, whichever head the trigger saw.
    test("a reviewed record cleans up whatever head the trigger saw", () => {
      expect(
        decidePublication({
          record: record({ head_sha: TRIGGER_HEAD }),
          cliStarted: true,
          cliRecord: { ...REVIEWED, head_sha: REVIEWED_HEAD },
        }),
      ).toMatchObject({ kind: "cleanup", pr: 7 });
    });

    test("a reviewed record whose PR is unknown cleans nothing", () => {
      expect(
        decidePublication({
          record: record({ pr: undefined, head_sha: undefined }),
          cliStarted: true,
          cliRecord: REVIEWED,
        }),
      ).toEqual({ kind: "none" });
    });

    test.each(["size", "budget", "coverage", "manual-required"] as const)(
      "a CLI skip for %s posts nothing: the CLI already posted its own notice",
      (skip) => {
        expect(
          decidePublication({
            record: record(),
            cliStarted: true,
            cliRecord: { v: 1, outcome: "skipped", skip },
          }),
        ).toEqual({ kind: "none" });
      },
    );

    test("a yielded run posts nothing: the CLI already posted its own notice", () => {
      expect(
        decidePublication({
          record: record(),
          cliStarted: true,
          cliRecord: { v: 1, outcome: "yielded" },
        }),
      ).toEqual({ kind: "none" });
    });

    test("hunters-failed is an error publication with its own code, on the trigger's head when the record has none", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: { v: 1, outcome: "hunters-failed" },
      });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.rendered.code).toBe("PRH-HUNTERS-FAILED");
      expect(plan.rendered.annotation).toStartWith(
        "::error title=pr-hero PRH-HUNTERS-FAILED::",
      );
      expect(plan.rendered.annotation).toContain(
        "each hunter's session ended without a result",
      );
      expect(plan.headSha).toBe(SHA);
    });

    test("hunters-failed names the head the CLI recorded, over the trigger's", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: { v: 1, outcome: "hunters-failed", head_sha: REVIEWED_HEAD },
      });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.headSha).toBe(REVIEWED_HEAD);
      expect(plan.status?.description).toStartWith("PRH-HUNTERS-FAILED: ");
    });

    test("a CLI error is rendered from its class: a route class names the route code and its owner", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: {
          v: 1,
          outcome: "error",
          cls: { kind: "route", reason: "unmapped" },
        },
      });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.rendered.code).toBe("PRH-ROUTE-UNRESOLVABLE");
      expect(plan.rendered.owner).toBe("config");
    });

    test("a CLI error for an unusable runtime is the runtime code, owned by pr-hero in action mode", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: {
          v: 1,
          outcome: "error",
          cls: { kind: "capability", issue: "sdk_unavailable" },
        },
      });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.rendered.code).toBe("PRH-RUNTIME-UNAVAILABLE");
      expect(plan.rendered.owner).toBe("pr-hero");
    });

    test("an unclassified CLI error says pr-hero could not tell why, naming the review as the step", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: { v: 1, outcome: "error", cls: { kind: "unknown" } },
      });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.rendered.code).toBe("PRH-UNCLASSIFIED");
      expect(plan.rendered.annotation).toContain(
        "pr-hero stopped at the review and could not tell why",
      );
      expect(plan.status?.description).toStartWith("PRH-UNCLASSIFIED: ");
    });

    // WHY the step is named: a posting failure is the CLI's own error, and the
    // step tells the operator which stage the review stopped at.
    test("a posting failure names the posting step in the status and the comment", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: {
          v: 1,
          outcome: "error",
          cls: { kind: "unknown" },
          params: { step: "posting the review" },
        },
      });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.status?.description).toContain("posting the review");
      expect(plan.commentBody).toContain("posting the review");
    });

    test("a CLI error on a PR the trigger could not resolve is annotation only", () => {
      const plan = decidePublication({
        record: record({ pr: undefined, head_sha: undefined }),
        cliStarted: true,
        cliRecord: { v: 1, outcome: "error", cls: { kind: "unknown" } },
      });
      expect(plan.kind).toBe("local");
      if (plan.kind !== "local") return;
      expect(plan.rendered.code).toBe("PRH-UNCLASSIFIED");
    });

    // WHY stopped-before-reporting: no record after cli-started means the CLI
    // exited without writing one, a crash, a kill, a usage error, or a record
    // write that failed. The text claims only what is known: it stopped before
    // it reported an outcome.
    // WHY comment only: the publisher cannot tell those causes apart, so it
    // never overrides the CLI's own commit status (decideCliOutcome says why).
    test("no CLI record after the CLI started is PRH-UNCLASSIFIED as a comment only: no status, whatever head the trigger saw", () => {
      const plan = decidePublication({ record: record(), cliStarted: true });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.rendered.code).toBe("PRH-UNCLASSIFIED");
      expect(plan.rendered.owner).toBe("unclassified");
      expect(plan.rendered.annotation).toContain(
        "pr-hero stopped at the review before it reported an outcome and could not tell why",
      );
      expect(plan.headSha).toBeUndefined();
      expect(plan.status).toBeUndefined();
      expect(plan.commentBody.split("\n")[0]).toBe(
        `<!-- pr-hero-outcome v=1 head=unknown run=4242 attempt=1 -->`,
      );
    });

    test("a CLI record is ignored when the CLI did not start: the install failure stands", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: false,
        cliRecord: REVIEWED,
      });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.rendered.code).toBe("PRH-INSTALL-FAILED");
    });
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
      "<!-- pr-hero-outcome v=1 head=unknown run=4242 attempt=1 -->",
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
      "<!-- pr-hero-outcome v=1 head=unknown run=4242 attempt=1 -->",
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
  // The CLI's cli.json. A string is the file's text, an object is stringified.
  cliRecord?: object | string;
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
    if (options.cliRecord !== undefined) {
      writeFileSync(
        path.join(dir, "cli.json"),
        typeof options.cliRecord === "string"
          ? options.cliRecord
          : JSON.stringify(options.cliRecord),
      );
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
        // Nothing in the publisher reads a commit status any more. A read here
        // is a regression, and the tests assert no call routes to it.
        if (endpoint.includes("/commits/")) {
          return fail("gh: status read not answered");
        }
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

// The endpoint of every combined-status read, in call order: each names the
// head the read was made on, so a test can see which head was read.
function statusReadEndpoints(calls: Call[]): string[] {
  return calls
    .flatMap((call) => call.args)
    .filter((arg) => /\/commits\/[^/]+\/status/.test(arg));
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

  test("a reviewed record never reads a commit status, and posts neither status nor comment", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliRecord: REVIEWED,
      viewer: ok("pr-hero-bot"),
      list: listing(),
    });
    expect(run.exitCode).toBe(0);
    expect(statusReadEndpoints(run.calls)).toEqual([]);
    expect(statusCalls(run.calls)).toEqual([]);
    expect(run.calls.filter((call) => call.args.includes("POST"))).toEqual([]);
    expect(run.summary).toBe("");
  });

  test.each([
    ["a size skip", { v: 1, outcome: "skipped", skip: "size" }],
    ["a budget skip", { v: 1, outcome: "skipped", skip: "budget" }],
    ["a coverage skip", { v: 1, outcome: "skipped", skip: "coverage" }],
    [
      "a manual-required skip",
      { v: 1, outcome: "skipped", skip: "manual-required" },
    ],
    ["a yield", { v: 1, outcome: "yielded" }],
  ])(
    "%s posts nothing, deletes nothing, and prints nothing: the CLI spoke",
    (_label, cliRecord) => {
      const run = runPublishIn({
        record: record(),
        cliStarted: true,
        cliRecord,
        viewer: ok("pr-hero-bot"),
        list: listing([10, "pr-hero-bot", "Bot", OLDER_MARKER]),
      });
      expect(run.exitCode).toBe(0);
      expect(run.calls).toEqual([]);
      expect(run.stdout).toBe("");
      expect(run.summary).toBe("");
    },
  );

  test("an error record posts its comment and its status on the trigger's head, with the code the record names", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliRecord: {
        v: 1,
        outcome: "error",
        cls: { kind: "route", reason: "unmapped" },
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      "::error title=pr-hero PRH-ROUTE-UNRESOLVABLE::",
    );
    expect(run.summary).toContain("### PRH-ROUTE-UNRESOLVABLE");
    const [status] = statusCalls(run.calls);
    expect(status?.args).toContain(`repos/${REPO}/statuses/${SHA}`);
    expect(status?.args).toContain("state=error");
    expect(
      status?.args.some((arg) =>
        arg.startsWith("description=PRH-ROUTE-UNRESOLVABLE: "),
      ),
    ).toBe(true);
    expect(commentPost(run.calls)?.args).toContain(
      `repos/${REPO}/issues/7/comments`,
    );
  });

  test("an error record's own head wins over the trigger's: the status and the marker name the reviewed head", () => {
    const run = runPublishIn({
      record: record({ head_sha: TRIGGER_HEAD }),
      cliStarted: true,
      cliRecord: {
        v: 1,
        outcome: "error",
        cls: { kind: "route", reason: "unmapped" },
        head_sha: REVIEWED_HEAD,
      },
    });
    const [status] = statusCalls(run.calls);
    expect(status?.args).toContain(`repos/${REPO}/statuses/${REVIEWED_HEAD}`);
    expect(commentPost(run.calls)?.stdin).toContain(
      `head=${REVIEWED_HEAD} run=4242 attempt=1 -->`,
    );
  });

  test("hunters-failed falls back to the trigger's head when the record names none", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliRecord: { v: 1, outcome: "hunters-failed" },
    });
    const [status] = statusCalls(run.calls);
    expect(status?.args).toContain(`repos/${REPO}/statuses/${SHA}`);
    expect(run.stdout).toContain("::error title=pr-hero PRH-HUNTERS-FAILED::");
    expect(commentPost(run.calls)?.stdin).toContain(
      `head=${SHA} run=4242 attempt=1 -->`,
    );
  });

  test("hunters-failed posts on the head the CLI recorded, not the trigger's", () => {
    const run = runPublishIn({
      record: record({ head_sha: TRIGGER_HEAD }),
      cliStarted: true,
      cliRecord: { v: 1, outcome: "hunters-failed", head_sha: REVIEWED_HEAD },
    });
    const [status] = statusCalls(run.calls);
    expect(status?.args).toContain(`repos/${REPO}/statuses/${REVIEWED_HEAD}`);
    expect(commentPost(run.calls)?.stdin).toContain(
      `head=${REVIEWED_HEAD} run=4242`,
    );
  });

  // WHY no status: F004 on #330. A completed review whose cli.json write failed
  // (ENOSPC, or EACCES on a stale cli.json.tmp) used to get an `error` status
  // after the CLI's own success status, and turned green into red.
  test("with no CLI record, the run stopped before reporting: PRH-UNCLASSIFIED is posted as one comment, never as a status", () => {
    const run = runPublishIn({ record: record(), cliStarted: true });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("::error title=pr-hero PRH-UNCLASSIFIED::");
    expect(run.stdout).toContain(
      "pr-hero stopped at the review before it reported an outcome",
    );
    expect(run.summary).toContain("### PRH-UNCLASSIFIED");
    expect(statusCalls(run.calls)).toEqual([]);
    const posts = run.calls.filter((call) => call.args.includes("POST"));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args).toContain(`repos/${REPO}/issues/7/comments`);
  });

  test.each([
    ["malformed JSON", "{ not json"],
    ["an unknown outcome", JSON.stringify({ v: 1, outcome: "crashed" })],
    ["another schema version", JSON.stringify({ v: 2, outcome: "reviewed" })],
    [
      "an error class the CLI never writes",
      JSON.stringify({
        v: 1,
        outcome: "error",
        cls: { kind: "github", status: 500 },
      }),
    ],
  ])(
    "a cli.json that is %s reads as no record: PRH-UNCLASSIFIED, never a silent skip",
    (_label, cliRecord) => {
      const run = runPublishIn({
        record: record(),
        cliStarted: true,
        cliRecord,
      });
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("::error title=pr-hero PRH-UNCLASSIFIED::");
      // An unreadable cli.json is the same as a missing one: no status either.
      expect(statusCalls(run.calls)).toEqual([]);
    },
  );

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

  // WHY these values: parseTriggerRecord accepts any run of digits, so both
  // reach the guard in isOlderRunComment. "0" is not positive. The unsafe
  // integer is what makes the guard observable: converted with Number(), it
  // is 1e20 and every older run would compare as older. The guard must hold.
  test.each([
    ["zero", "0"],
    ["an integer past Number.MAX_SAFE_INTEGER", "99999999999999999999"],
  ])(
    "when this run's own id is not a safe positive integer (%s), no older comment can be ordered, so none is deleted",
    (_label, runId) => {
      // WHY: with no run order, an older comment cannot be proven older, so the
      // safe default is to delete nothing. GITHUB_RUN_ID is blanked so the
      // record's id is the only one the step has.
      const run = runPublishIn({
        record: record({ run_id: runId }),
        list: listing([10, "bot-a", "User", OLDER_MARKER]),
        env: { GITHUB_RUN_ID: "" },
      });
      expect(deletions(run.calls)).toEqual([]);
    },
  );

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

  test("a repeated failure on attempt 2 replaces attempt 1's comment instead of stacking", () => {
    // WHY: gh run rerun reuses the run id, so only the attempt tells the two
    // failures apart. Without it, the first comment stays beside the second.
    const run = runPublishIn({
      record: record({ run_attempt: 2 }),
      env: { GITHUB_RUN_ATTEMPT: "2" },
      list: listing([10, "bot-a", "User", FIRST_ATTEMPT_MARKER]),
    });
    expect(deletions(run.calls)).toEqual([`repos/${REPO}/issues/comments/10`]);
    expect(commentPost(run.calls)?.stdin?.split("\n")[0]).toBe(
      `<!-- pr-hero-outcome v=1 head=${SHA} run=4242 attempt=2 -->`,
    );
  });

  test("a marker written before attempts were recorded counts as attempt 1", () => {
    const run = runPublishIn({
      record: record({ run_attempt: 2 }),
      env: { GITHUB_RUN_ATTEMPT: "2" },
      list: listing([
        10,
        "bot-a",
        "User",
        `<!-- pr-hero-outcome v=1 head=${SHA} run=4242 -->`,
      ]),
    });
    expect(deletions(run.calls)).toEqual([`repos/${REPO}/issues/comments/10`]);
  });

  test("a later attempt of the same run is never deleted by an earlier attempt", () => {
    const run = runPublishIn({
      record: record({ run_attempt: 1 }),
      list: listing([
        10,
        "bot-a",
        "User",
        `<!-- pr-hero-outcome v=1 head=${SHA} run=4242 attempt=2 -->`,
      ]),
    });
    expect(deletions(run.calls)).toEqual([]);
  });

  // WHY: gh run rerun keeps the run id and bumps the attempt. On a runner that
  // reuses runner.temp, attempt 2 can find attempt 1's record still on disk
  // (its own record write failed), and must not publish attempt 1's outcome.
  test("a record from an earlier attempt of this run is refused before anything is read or posted", () => {
    const run = runPublishIn({
      record: record({ run_attempt: 1 }),
      env: { GITHUB_RUN_ATTEMPT: "2" },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("belongs to another run");
    expect(run.calls).toEqual([]);
  });

  test("a record of the attempt that is running publishes, and an absent or invalid attempt counts as attempt 1", () => {
    const matching = runPublishIn({
      record: record({ run_attempt: 2 }),
      env: { GITHUB_RUN_ATTEMPT: "2" },
    });
    expect(matching.exitCode).toBe(0);
    expect(statusCalls(matching.calls)).not.toEqual([]);
    const invalid = runPublishIn({
      record: record({ run_attempt: 1 }),
      env: { GITHUB_RUN_ATTEMPT: "abc" },
    });
    expect(invalid.exitCode).toBe(0);
    expect(statusCalls(invalid.calls)).not.toEqual([]);
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

  // F002: the trigger recorded no head (a failed `gh pr view`). The reviewed
  // record needs none, so the cleanup still runs and reads no status.
  test("a trigger that recorded no head still cleans up, and reads no commit status", () => {
    const run = runPublishIn({
      record: record({ head_sha: undefined }),
      cliStarted: true,
      cliRecord: REVIEWED,
      viewer: ok("pr-hero-bot"),
      list: listing([10, "pr-hero-bot", "Bot", OLDER_MARKER]),
    });
    expect(run.exitCode).toBe(0);
    expect(statusReadEndpoints(run.calls)).toEqual([]);
    expect(removedIds(run)).toEqual(["10"]);
  });

  // F004: the PR head moved between the trigger and the CLI. The record is the
  // proof, so the cleanup runs, and it reads no status on either head.
  test("when the PR head moved after the trigger, a reviewed record still cleans up, and reads no status", () => {
    const run = runPublishIn({
      record: record({ head_sha: TRIGGER_HEAD }),
      cliStarted: true,
      cliRecord: { ...REVIEWED, head_sha: REVIEWED_HEAD },
      viewer: ok("pr-hero-bot"),
      list: listing([10, "pr-hero-bot", "Bot", OLDER_MARKER]),
    });
    expect(run.exitCode).toBe(0);
    expect(statusReadEndpoints(run.calls)).toEqual([]);
    expect(removedIds(run)).toEqual(["10"]);
  });

  test("with a viewer login, deletes only that login's older marker comments", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliRecord: REVIEWED,
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

  test("a successful re-run (same run id, attempt 2) deletes attempt 1's comment", () => {
    // WHY: the re-run's review completed, so the first attempt's failure comment
    // contradicts it. Same run id, so only the attempt orders the two.
    const run = runPublishIn({
      record: record({ run_attempt: 2 }),
      env: { GITHUB_RUN_ATTEMPT: "2" },
      cliStarted: true,
      cliRecord: REVIEWED,
      viewer: ok("pr-hero-bot"),
      list: listing([10, "pr-hero-bot", "Bot", FIRST_ATTEMPT_MARKER]),
    });
    expect(removedIds(run)).toEqual(["10"]);
    expect(run.exitCode).toBe(0);
  });

  test("the cleanup never deletes this run's own marker or a newer run's", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliRecord: REVIEWED,
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
      cliRecord: REVIEWED,
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
      cliRecord: REVIEWED,
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
        cliRecord: REVIEWED,
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
      cliRecord: REVIEWED,
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
      cliRecord: REVIEWED,
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

  test("a reviewed record on a PR the trigger could not resolve makes no gh call at all", () => {
    const run = runPublishIn({
      record: record({ pr: undefined, head_sha: undefined }),
      cliStarted: true,
      cliRecord: REVIEWED,
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
  test("as a process, a reviewed CLI run with no PR exits 0 and writes nothing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-publish-proc-"));
    try {
      writeFileSync(
        path.join(dir, "trigger.json"),
        JSON.stringify(record({ pr: undefined, head_sha: undefined })),
      );
      writeFileSync(path.join(dir, "cli-started"), "");
      writeFileSync(path.join(dir, "cli.json"), JSON.stringify(REVIEWED));
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

  test("as a process, a reviewed CLI run whose gh is missing still exits 0, with no error", () => {
    // WHY: Bun throws when gh is not on PATH. A call that cannot run is a failed
    // call like any other, so the cleanup's failed listing becomes one notice,
    // never a crash and never an error: the cleanup must not fail the job.
    const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-publish-nogh-"));
    try {
      writeFileSync(path.join(dir, "trigger.json"), JSON.stringify(record()));
      writeFileSync(path.join(dir, "cli-started"), "");
      writeFileSync(path.join(dir, "cli.json"), JSON.stringify(REVIEWED));
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
      expect(result.stdout.toString()).not.toContain("::error");
      expect(result.stdout.toString()).toContain("::notice title=pr-hero::");
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
