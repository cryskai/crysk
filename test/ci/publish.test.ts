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

  test("a review whose CLI started is owned by the CLI: nothing at all", () => {
    // WHY: until T2c the CLI still posts its own status and comment, so a
    // second outcome from here would be a duplicate on the same PR.
    expect(decidePublication({ record: record(), cliStarted: true })).toEqual({
      kind: "none",
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

  test("a PR number without a sha is still annotation only: no status can be posted", () => {
    const plan = decidePublication({
      record: record({ head_sha: undefined }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("local");
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
    expect(plan.status.description).toBe(
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

  test("an unverifiable lookup without a head sha is annotation only", () => {
    const plan = decidePublication({
      record: record({
        decision: "unverifiable",
        cls: { kind: "github", status: 500 },
        head_sha: undefined,
      }),
      cliStarted: false,
    });
    expect(plan.kind).toBe("local");
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
      expect(plan.status.context as string).toBe(expected as string);
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
    expect(plan.status.description.length).toBeLessThanOrEqual(140);
    expect(plan.status.description).not.toContain("\n");
    expect(plan.status.description.startsWith("PRH-CRED-MISSING: ")).toBe(true);
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
// [id, login, first line of the body].
function listing(...rows: Array<[number, string, string]>): GhResult {
  return ok(rows.map((row) => JSON.stringify(row)).join("\n"));
}

function runPublishIn(options: {
  record?: TriggerRecord | string;
  cliStarted?: boolean;
  status?: GhResult[];
  create?: GhResult;
  list?: GhResult;
  remove?: GhResult;
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

  test("nothing at all when the CLI started, whatever the record says", () => {
    const run = runPublishIn({ record: record(), cliStarted: true });
    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.stdout).toBe("");
    expect(run.summary).toBe("");
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
        [10, "bot-a", MARKER],
        [11, "someone-else", MARKER],
        [12, "bot-a", "Quoting it here: <!-- pr-hero-outcome"],
        [13, "bot-a", MARKER],
        [25, "bot-a", MARKER],
      ),
    });
    // The new comment is id 20 by bot-a. 25 is newer than it (a concurrent
    // run), so it stays; 11 belongs to another author; 12 is not an outcome.
    expect(deletions(run.calls)).toEqual([
      `repos/${REPO}/issues/comments/10`,
      `repos/${REPO}/issues/comments/13`,
    ]);
  });

  test("an unknown author deletes nothing", () => {
    const run = runPublishIn({
      record: record(),
      create: ok(JSON.stringify([20, ""])),
      list: listing([10, "", MARKER]),
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

describe("publish.ts runs before `bun install`", () => {
  // The real entry point, spawned with an empty PATH and HOME: it must start
  // and finish with no node_modules and no gh, when there is nothing to say.
  test("as a process, a CLI-started run exits 0 and writes nothing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-publish-proc-"));
    try {
      writeFileSync(path.join(dir, "trigger.json"), JSON.stringify(record()));
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
