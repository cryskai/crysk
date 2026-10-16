// The action-side trigger (odd/tasks/agent-first-ci.md, T1/S1): which events
// review, who may ask for one by comment, and what a run with no credential
// does. The consumer workflow's job `if:` pre-filters forks and comments, but
// the action re-decides all of it, so every rule here is pinned on the
// action's own module rather than on the caller's YAML.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CI_REVIEW_COMMENT, CI_REVIEW_FULL_COMMENT } from "#ci/force-comment";
import { parseTriggerRecord, type TriggerRecord } from "#ci/outcome";
import {
  type CiTriggerDecision,
  type CiTriggerInput,
  type CommenterPermission,
  commenterPermissionNeeded,
  decideCiTrigger,
  type GhResult,
  type OutcomeFs,
  parseReviewCommand,
  resolvePrNumber,
  runCiTrigger,
  runnerCredentialPaths,
} from "#ci/trigger";
import {
  CLAUDE_SESSION_FILES,
  produceClaudeCapabilityReport,
} from "#model/provider-capabilities";
import { resolveOpenCodeAuthPath } from "../../src/security/credential-broker";

const REPO = "acme/widgets";
const MODULE_PATH = path.resolve(import.meta.dir, "../../src/ci/trigger.ts");

const NO_CREDENTIALS = {
  anthropicApiKey: false,
  claudeToken: false,
  opencodeAuth: false,
  runnerFile: false,
};

function pullRequest(overrides: Partial<CiTriggerInput> = {}): CiTriggerInput {
  return {
    eventName: "pull_request",
    repository: REPO,
    prHeadRepo: REPO,
    commentBody: "",
    commentOnPullRequest: false,
    commenterLogin: "",
    credentials: { ...NO_CREDENTIALS, claudeToken: true },
    selfHostedRunner: false,
    forceInput: false,
    fullInput: false,
    ...overrides,
  };
}

function comment(
  body: string,
  overrides: Partial<CiTriggerInput> = {},
): CiTriggerInput {
  return pullRequest({
    eventName: "issue_comment",
    prHeadRepo: "",
    commentBody: body,
    commentOnPullRequest: true,
    commenterLogin: "maintainer",
    commenterPermission: { kind: "resolved", permission: "write" },
    ...overrides,
  });
}

function dispatch(overrides: Partial<CiTriggerInput> = {}): CiTriggerInput {
  return pullRequest({
    eventName: "workflow_dispatch",
    prHeadRepo: "",
    ...overrides,
  });
}

describe("decideCiTrigger — the comment commands", () => {
  test.each([
    ["exact", "/pr-hero review"],
    ["surrounding spaces", "   /pr-hero review  "],
    ["surrounding newlines", "\n/pr-hero review\n"],
    ["tab and CRLF", "\t/pr-hero review\r\n"],
  ])(
    "`/pr-hero review` (%s) reviews with force and without full",
    (_label, body) => {
      expect(decideCiTrigger(comment(body))).toEqual({
        kind: "review",
        force: true,
        full: false,
      });
    },
  );

  test.each([
    ["exact", "/pr-hero review --full"],
    ["surrounding whitespace", "  /pr-hero review --full\n"],
  ])(
    "`/pr-hero review --full` (%s) reviews with force and full",
    (_label, body) => {
      expect(decideCiTrigger(comment(body))).toEqual({
        kind: "review",
        force: true,
        full: true,
      });
    },
  );

  test.each([
    "/pr-hero review please",
    "/pr-hero reviewing",
    "/PR-HERO review",
    "/pr-hero  review",
    "/pr-hero review --full please",
    "/pr-hero review --FULL",
    "/pr-hero review --force",
    "please /pr-hero review",
    "/pr-hero review\nand then some",
    "/pr-hero",
    "",
  ])("a near miss is ignored: %j", (body) => {
    expect(decideCiTrigger(comment(body)).kind).toBe("ignore");
    expect(parseReviewCommand(body)).toBeUndefined();
  });

  test("an ignored comment's reason never echoes the comment body", () => {
    // The body is free text anyone can type, and the reason is printed as a
    // workflow command. Echoing it would hand the commenter the log.
    const body = "/pr-hero review ::warning::INJECTED-MARKER";
    const decision = decideCiTrigger(comment(body));
    expect(decision.kind).toBe("ignore");
    expect(JSON.stringify(decision)).not.toContain("INJECTED-MARKER");
  });

  test("a command on an issue that is not a pull request is ignored", () => {
    const decision = decideCiTrigger(
      comment("/pr-hero review", { commentOnPullRequest: false }),
    );
    expect(decision.kind).toBe("ignore");
    expect((decision as { reason: string }).reason).toContain("pull request");
  });
});

describe("decideCiTrigger — the pull_request filter", () => {
  test("a same-repo pull_request reviews without force", () => {
    expect(decideCiTrigger(pullRequest())).toEqual({
      kind: "review",
      force: false,
      full: false,
    });
  });

  test.each([
    ["pull_request from a fork", "pull_request", "stranger/widgets"],
    // A deleted fork renders `head.repo.full_name` as the empty string; an
    // unknown head is not the base repo, so it must not review either.
    ["pull_request whose fork was deleted", "pull_request", ""],
  ])(
    "%s is ignored and tells a maintainer how to review it",
    (_label, eventName, head) => {
      const decision = decideCiTrigger(
        pullRequest({ eventName, prHeadRepo: head }),
      );
      expect(decision.kind).toBe("ignore");
      expect((decision as { reason: string }).reason).toContain(
        "/pr-hero review",
      );
    },
  );

  // pull_request_target runs in the BASE repository's context, with its
  // secrets, so "a fork's run receives no secrets" is false there. The
  // scaffolded template never wires it; a consumer who does chose to review
  // fork heads with base-context credentials, and the action honors that.
  test.each([
    ["from a fork", "stranger/widgets"],
    ["from the same repository", REPO],
  ])("pull_request_target %s reviews without force", (_label, head) => {
    expect(
      decideCiTrigger(
        pullRequest({ eventName: "pull_request_target", prHeadRepo: head }),
      ),
    ).toEqual({ kind: "review", force: false, full: false });
  });

  test("a fork's pull_request_target still has to pass the credential check", () => {
    expect(
      decideCiTrigger(
        pullRequest({
          eventName: "pull_request_target",
          prHeadRepo: "stranger/widgets",
          credentials: NO_CREDENTIALS,
        }),
      ).kind,
    ).toBe("no-credentials");
  });

  test("a pull_request never consults the commenter permission", () => {
    expect(
      decideCiTrigger(pullRequest({ commenterPermission: undefined })).kind,
    ).toBe("review");
    expect(commenterPermissionNeeded(pullRequest())).toBe(false);
  });
});

describe("decideCiTrigger — commenter permission fails closed", () => {
  test.each(["admin", "write"])("`%s` may trigger a review", (permission) => {
    expect(
      decideCiTrigger(
        comment("/pr-hero review", {
          commenterPermission: { kind: "resolved", permission },
        }),
      ).kind,
    ).toBe("review");
  });

  test.each(["read", "none", "triage", "maintain", "", "WRITE", "unknown"])(
    "`%s` is denied",
    (permission) => {
      const decision = decideCiTrigger(
        comment("/pr-hero review", {
          commenterPermission: { kind: "resolved", permission },
        }),
      );
      expect(decision.kind).toBe("denied");
      expect((decision as { reason: string }).reason).toContain("maintainer");
    },
  );

  test.each<[string, CommenterPermission | undefined]>([
    ["never looked up", undefined],
    [
      "unanswerable from the event",
      {
        kind: "unavailable",
        detail: "the event carried no commenter login or repository",
      },
    ],
  ])("a permission that was %s is denied", (_label, commenterPermission) => {
    expect(
      decideCiTrigger(comment("/pr-hero review", { commenterPermission })).kind,
    ).toBe("denied");
  });

  // A lookup that failed says nothing about the commenter. A quiet denial
  // there is a notice on a default-branch run, invisible on the pull
  // request, so a maintainer whose command met a GitHub outage saw nothing
  // and got no review. It stays fail-closed, but red and actionable.
  test.each(["/pr-hero review", "/pr-hero review --full"])(
    "an indeterminate lookup for `%s` is unverifiable and names the retry",
    (command) => {
      const decision = decideCiTrigger(
        comment(command, {
          commenterLogin: "octocat",
          commenterPermission: { kind: "indeterminate", detail: "HTTP 502" },
        }),
      );
      expect(decision.kind).toBe("unverifiable");
      const reason = (decision as { reason: string }).reason;
      expect(reason).toContain("@octocat");
      expect(reason).toContain("write access");
      expect(reason).toContain("GitHub API");
      expect(reason).toContain("HTTP 502");
      expect(reason).toContain(`\`${command}\` again`);
    },
  );

  test("the permission is needed only for a real command on a pull request", () => {
    expect(commenterPermissionNeeded(comment("/pr-hero review"))).toBe(true);
    expect(commenterPermissionNeeded(comment("/pr-hero review --full"))).toBe(
      true,
    );
    expect(commenterPermissionNeeded(comment("/pr-hero review please"))).toBe(
      false,
    );
    expect(
      commenterPermissionNeeded(
        comment("/pr-hero review", { commentOnPullRequest: false }),
      ),
    ).toBe(false);
  });
});

describe("decideCiTrigger — precedence and credentials", () => {
  test.each<[string, CiTriggerInput, CiTriggerDecision["kind"]]>([
    [
      "a near-miss comment",
      comment("/pr-hero reviewing", { credentials: NO_CREDENTIALS }),
      "ignore",
    ],
    [
      "a command on a plain issue",
      comment("/pr-hero review", {
        commentOnPullRequest: false,
        credentials: NO_CREDENTIALS,
      }),
      "ignore",
    ],
    [
      "a fork pull_request",
      pullRequest({
        prHeadRepo: "stranger/widgets",
        credentials: NO_CREDENTIALS,
      }),
      "ignore",
    ],
    [
      "a read-only commenter",
      comment("/pr-hero review", {
        commenterPermission: { kind: "resolved", permission: "read" },
        credentials: NO_CREDENTIALS,
      }),
      "denied",
    ],
    [
      "an unverifiable commenter",
      comment("/pr-hero review", {
        commenterPermission: { kind: "indeterminate", detail: "HTTP 502" },
        credentials: NO_CREDENTIALS,
      }),
      "unverifiable",
    ],
  ])(
    "%s with no credential reports its own outcome, not no-credentials",
    (_label, input, kind) => {
      expect(decideCiTrigger(input).kind).toBe(kind);
    },
  );

  test("no credential at all is a no-credentials decision", () => {
    const decision = decideCiTrigger(
      pullRequest({ credentials: NO_CREDENTIALS }),
    );
    expect(decision).toEqual({
      kind: "no-credentials",
      inputs: ["anthropic-api-key", "claude-token", "opencode-auth"],
    });
  });

  test.each([
    "anthropicApiKey",
    "claudeToken",
    "opencodeAuth",
    "runnerFile",
  ] as const)("%s alone is enough to review", (credential) => {
    expect(
      decideCiTrigger(
        pullRequest({
          credentials: { ...NO_CREDENTIALS, [credential]: true },
        }),
      ).kind,
    ).toBe("review");
  });

  // A self-hosted runner may hold a keychain entry this builtins-only step
  // cannot probe, so `no-credentials` would be a guess there.
  test("a self-hosted runner with no input defers to the engine's own gate", () => {
    expect(
      decideCiTrigger(
        pullRequest({ credentials: NO_CREDENTIALS, selfHostedRunner: true }),
      ).kind,
    ).toBe("review");
  });
});

describe("decideCiTrigger — the legacy force workflow still works", () => {
  // pr-hero-force.yml dispatches the action with `pr-number`, `force: true`
  // and `full`. Scaffolds made before the comment trigger keep calling it.
  test.each([
    ["with", true],
    ["without", false],
  ])(
    "workflow_dispatch with force=true %s full reviews with exactly those flags",
    (_label, full) => {
      expect(
        decideCiTrigger(dispatch({ forceInput: true, fullInput: full })),
      ).toEqual({ kind: "review", force: true, full });
    },
  );

  test("workflow_dispatch without force reviews without force", () => {
    expect(decideCiTrigger(dispatch())).toEqual({
      kind: "review",
      force: false,
      full: false,
    });
  });

  test("a full input widens a plain comment command too", () => {
    expect(
      decideCiTrigger(comment("/pr-hero review", { fullInput: true })),
    ).toEqual({
      kind: "review",
      force: true,
      full: true,
    });
  });
});

describe("resolvePrNumber", () => {
  const none = {
    prNumberInput: "",
    eventName: "workflow_dispatch",
    eventPrNumber: "",
    eventIssueNumber: "",
  };

  test("the explicit pr-number input wins over the event", () => {
    expect(
      resolvePrNumber({
        ...none,
        prNumberInput: "305",
        eventName: "pull_request",
        eventPrNumber: "12",
      }),
    ).toEqual({ ok: true, pr: "305" });
  });

  test.each([
    ["pull_request", { eventPrNumber: "12" }, "12"],
    ["pull_request_target", { eventPrNumber: "13" }, "13"],
    ["issue_comment", { eventIssueNumber: "14" }, "14"],
  ])("%s takes its number from the event", (eventName, fields, pr) => {
    expect(resolvePrNumber({ ...none, eventName, ...fields })).toEqual({
      ok: true,
      pr,
    });
  });

  test("no number anywhere is the action's old error, verbatim", () => {
    expect(resolvePrNumber(none)).toEqual({
      ok: false,
      error:
        "Could not determine the pull request number from the workflow context. Set the 'pr-number' input explicitly.",
    });
  });

  test.each(["abc", "0", "-3", "12\nrun=true", "1.5"])(
    "a pr-number that is not a positive integer is refused: %j",
    (prNumberInput) => {
      // The number is written to $GITHUB_OUTPUT as `pr=<n>`. A newline in it
      // would let the caller forge `run=true` on the next line.
      const result = resolvePrNumber({ ...none, prNumberInput });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("run=true");
    },
  );
});

// ---------------------------------------------------------------------------
// The shell, driven through its injected seams. `gh` is a recorded fake, so
// the suite stays offline and can prove WHEN a lookup happens, not only what
// its answer does.
// ---------------------------------------------------------------------------

const SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-SECRET-VALUE-1",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-SECRET-VALUE-2",
  OPENCODE_AUTH_JSON: '{"token":"SECRET-VALUE-3"}',
  GH_TOKEN: "ghs_SECRET-VALUE-4",
};
const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function baseEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ...SECRETS,
    GITHUB_REPOSITORY: REPO,
    GITHUB_RUN_ID: "4242",
    EVENT_NAME: "pull_request",
    EVENT_PR_NUMBER: "7",
    EVENT_PR_HEAD_REPO: REPO,
    EVENT_PR_HEAD_SHA: HEAD_SHA,
    EVENT_ISSUE_NUMBER: "",
    EVENT_ISSUE_PR_URL: "",
    COMMENT_BODY: "",
    COMMENTER_LOGIN: "",
    PR_NUMBER_INPUT: "",
    FORCE_INPUT: "false",
    FULL_INPUT: "false",
    HAS_ANTHROPIC_API_KEY: "false",
    HAS_CLAUDE_TOKEN: "true",
    HAS_OPENCODE_AUTH: "false",
    ...overrides,
  };
}

function commentEnv(body: string, overrides: Record<string, string> = {}) {
  return baseEnv({
    EVENT_NAME: "issue_comment",
    EVENT_PR_NUMBER: "",
    EVENT_PR_HEAD_REPO: "",
    EVENT_PR_HEAD_SHA: "",
    EVENT_ISSUE_NUMBER: "21",
    EVENT_ISSUE_PR_URL: `https://api.github.com/repos/${REPO}/pulls/21`,
    COMMENT_BODY: body,
    COMMENTER_LOGIN: "maintainer",
    ...overrides,
  });
}

// `exists` answers for the on-runner credential files and defaults to
// "nothing on disk", so no test reads the developer's own home. `sleep` is
// recorded, never real, so the permission retry costs no wall time.
// The record's file writes fail, as a full disk would. Nothing is left behind.
const failingFs: OutcomeFs = {
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  writeFile: () => {
    throw new Error("ENOSPC: no space left on device");
  },
  rename: () => {
    throw new Error("rename must not run after a failed write");
  },
  remove: (filePath) => rmSync(filePath, { force: true }),
};

function runShell(
  env: Record<string, string>,
  answer: (args: readonly string[]) => GhResult = () => ({
    exitCode: 1,
    stdout: "",
    stderr: "gh: not scripted",
  }),
  exists: (filePath: string) => boolean = () => false,
  fs?: OutcomeFs,
) {
  const ghCalls: string[][] = [];
  const sleeps: number[] = [];
  let stdout = "";
  let output = "";
  let summary = "";
  const exitCode = runCiTrigger({
    env,
    gh: (args) => {
      ghCalls.push([...args]);
      return answer(args);
    },
    sleep: (ms) => {
      sleeps.push(ms);
    },
    exists,
    stdout: (text) => {
      stdout += text;
    },
    appendOutput: (text) => {
      output += text;
    },
    appendSummary: (text) => {
      summary += text;
    },
    ...(fs === undefined ? {} : { fs }),
  });
  const outputs = Object.fromEntries(
    output
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  return { exitCode, stdout, output, outputs, summary, ghCalls, sleeps };
}

const ok = (stdout: string): GhResult => ({ exitCode: 0, stdout, stderr: "" });

// Runs the shell with PRHERO_OUTCOME_DIR pointed at a fresh directory that does
// not exist yet (the trigger must create it), then reads trigger.json back.
function outcomeRun(
  env: Record<string, string>,
  answer?: (args: readonly string[]) => GhResult,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "prhero-trigger-record-"));
  try {
    const dir = path.join(root, "pr-hero-outcome");
    const run = runShell({ ...env, PRHERO_OUTCOME_DIR: dir }, answer);
    const file = path.join(dir, "trigger.json");
    const recordText = existsSync(file)
      ? readFileSync(file, "utf8")
      : undefined;
    return {
      ...run,
      recordText,
      record:
        recordText === undefined ? undefined : parseTriggerRecord(recordText),
      dir,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scriptedGh(permission: GhResult, headSha: GhResult) {
  return (args: readonly string[]): GhResult =>
    args[0] === "api" ? permission : headSha;
}

describe("runCiTrigger — the shell", () => {
  test("a same-repo pull_request reviews with the event's number and head, calling no gh", () => {
    const run = runShell(baseEnv());
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toEqual({
      run: "true",
      force: "false",
      full: "false",
      pr: "7",
      head_sha: HEAD_SHA,
      publish: "true",
    });
    expect(run.ghCalls).toEqual([]);
  });

  test("`/pr-hero review --full` from a writer looks up the permission, then the head", () => {
    const run = runShell(
      commentEnv("  /pr-hero review --full\n"),
      scriptedGh(ok("write\n"), ok(`${OTHER_SHA}\n`)),
    );
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toEqual({
      run: "true",
      force: "true",
      full: "true",
      pr: "21",
      head_sha: OTHER_SHA,
      publish: "true",
    });
    expect(run.ghCalls).toEqual([
      [
        "api",
        `repos/${REPO}/collaborators/maintainer/permission`,
        "--jq",
        ".permission",
      ],
      [
        "pr",
        "view",
        "21",
        "--repo",
        REPO,
        "--json",
        "headRefOid",
        "--jq",
        ".headRefOid",
      ],
    ]);
  });

  test("a near-miss comment is a notice and calls no gh at all", () => {
    const run = runShell(commentEnv("/pr-hero review please"));
    expect(run.exitCode).toBe(0);
    expect(run.outputs.run).toBe("false");
    expect(run.stdout).toStartWith("::notice title=pr-hero::");
    expect(run.ghCalls).toEqual([]);
  });

  test.each<[string, GhResult]>([
    ["a 404", { exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }],
    ["a read permission", ok("read\n")],
    ["a triage permission", ok("triage\n")],
    ["a none permission", ok("none\n")],
    ["an empty answer", ok("")],
  ])(
    "%s from the permission lookup is a denied notice, exit 0",
    (_label, answer) => {
      const run = runShell(
        commentEnv("/pr-hero review"),
        scriptedGh(answer, ok(HEAD_SHA)),
      );
      expect(run.exitCode).toBe(0);
      expect(run.outputs.run).toBe("false");
      expect(run.stdout).toStartWith("::notice title=pr-hero::");
      // A definitive answer: one lookup, no retry, and denied before the
      // head is resolved.
      expect(run.ghCalls.length).toBe(1);
      expect(run.sleeps).toEqual([]);
    },
  );

  test.each<[string, GhResult]>([
    [
      "a 5xx",
      { exitCode: 1, stdout: "", stderr: "gh: Server Error (HTTP 502)" },
    ],
    [
      "a rate limit",
      {
        exitCode: 1,
        stdout: "",
        stderr: "gh: API rate limit exceeded for installation. (HTTP 403)",
      },
    ],
    ["a killed or timed-out gh", { exitCode: -1, stdout: "", stderr: "" }],
  ])(
    "%s twice is an unverifiable error, exit 1, after exactly one retry",
    (_label, answer) => {
      const run = runShell(
        commentEnv("/pr-hero review"),
        scriptedGh(answer, ok(HEAD_SHA)),
      );
      expect(run.exitCode).toBe(1);
      expect(run.outputs.run).toBe("false");
      // No outcome dir means no record for the publisher, so the trigger names
      // the cause itself: one line, the commenter and the failed lookup.
      expect(run.outputs.publish).toBe("true");
      expect(run.stdout).toStartWith(
        "::error title=pr-hero::pr-hero could not verify whether @maintainer",
      );
      expect(run.stdout.split("\n").filter((line) => line !== "")).toHaveLength(
        1,
      );
      expect(run.ghCalls.filter((call) => call[0] === "api")).toHaveLength(2);
      expect(run.ghCalls.filter((call) => call[0] === "pr")).toHaveLength(0);
      // One short fixed pause between the two attempts, never more.
      expect(run.sleeps).toHaveLength(1);
      expect(run.sleeps[0]).toBeGreaterThan(0);
      expect(run.sleeps[0]).toBeLessThanOrEqual(5_000);
    },
  );

  test("a lookup that fails once and then answers `write` reviews", () => {
    let lookups = 0;
    const run = runShell(commentEnv("/pr-hero review"), (args) => {
      if (args[0] !== "api") return ok(`${OTHER_SHA}\n`);
      lookups += 1;
      return lookups === 1
        ? { exitCode: 1, stdout: "", stderr: "gh: Bad Gateway (HTTP 502)" }
        : ok("write\n");
    });
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toEqual({
      run: "true",
      force: "true",
      full: "false",
      pr: "21",
      head_sha: OTHER_SHA,
      publish: "true",
    });
    expect(run.ghCalls.map((call) => call[0])).toEqual(["api", "api", "pr"]);
    expect(run.sleeps).toHaveLength(1);
  });

  test("a gh that cannot even start is unverifiable and red, not a quiet denial", () => {
    const run = runShell(commentEnv("/pr-hero review"), () => {
      throw new Error("spawn gh ENOENT");
    });
    expect(run.exitCode).toBe(1);
    expect(run.outputs.run).toBe("false");
    expect(run.outputs.publish).toBe("true");
    // No outcome dir, so no record: the trigger names the cause itself.
    expect(run.stdout).toStartWith(
      "::error title=pr-hero::pr-hero could not verify whether @maintainer",
    );
    expect(run.stdout).toContain("spawn gh ENOENT");
    // The retry is the whole lookup: an unverifiable run asks for no head.
    expect(run.ghCalls).toHaveLength(2);
  });

  test("an unverifiable lookup prints nothing, and its record holds neither the login nor gh's text", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-trigger-hostile-"));
    try {
      const run = runShell(
        commentEnv("/pr-hero review", {
          COMMENTER_LOGIN: "evil\n::warning::HOSTILE-LOGIN",
          PRHERO_OUTCOME_DIR: path.join(dir, "outcome"),
        }),
        () => ({
          exitCode: 1,
          stdout: "",
          stderr: "gh: Server Error (HTTP 500)\n::error::HOSTILE-STDERR",
        }),
      );
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toBe("");
      const text = readFileSync(
        path.join(dir, "outcome", "trigger.json"),
        "utf8",
      );
      expect(text).not.toContain("HOSTILE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no credential is red with run=false and publish=true; with no record the trigger names the cause", () => {
    const run = runShell(baseEnv({ HAS_CLAUDE_TOKEN: "false" }));
    expect(run.exitCode).toBe(1);
    expect(run.outputs.run).toBe("false");
    expect(run.outputs.publish).toBe("true");
    expect(run.stdout).toStartWith(
      "::error title=pr-hero::pr-hero has no credential for this review",
    );
    expect(run.summary).toBe("");
  });

  test("a dispatch with no pr-number is red, publishes, and records the class instead of printing it", () => {
    const { exitCode, outputs, stdout, record } = outcomeRun(
      baseEnv({ EVENT_NAME: "workflow_dispatch", EVENT_PR_NUMBER: "" }),
    );
    expect(exitCode).toBe(1);
    expect(outputs.run).toBe("false");
    expect(outputs.publish).toBe("true");
    expect(stdout).toBe("");
    expect(record?.decision).toBe("review");
    expect(record?.cls).toEqual({ kind: "trigger", check: "pr-unresolved" });
    expect(record?.pr).toBeUndefined();
  });

  test("with no outcome dir, an unresolved PR names its cause on one error line", () => {
    const run = runShell(
      baseEnv({ EVENT_NAME: "workflow_dispatch", EVENT_PR_NUMBER: "" }),
    );
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toStartWith(
      "::error title=pr-hero::Could not determine the pull request number",
    );
    expect(run.stdout.split("\n").filter((line) => line !== "")).toHaveLength(
      1,
    );
  });

  test("with no outcome dir, a missing credential names its cause on one error line", () => {
    const run = runShell(baseEnv({ HAS_CLAUDE_TOKEN: "false" }));
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toStartWith(
      "::error title=pr-hero::pr-hero has no credential for this review",
    );
    expect(run.stdout).toContain("anthropic-api-key");
  });

  test("with no outcome dir, an unverifiable lookup names its cause and the gh detail", () => {
    const run = runShell(
      commentEnv("/pr-hero review"),
      scriptedGh(
        { exitCode: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)" },
        ok(HEAD_SHA),
      ),
    );
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toStartWith(
      "::error title=pr-hero::pr-hero could not verify whether @maintainer",
    );
    expect(run.stdout).toContain("gh: Server Error (HTTP 500)");
  });

  test("a record that cannot be written names the cause after the write error, on its own line", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "prhero-trigger-cause-"));
    try {
      const dir = path.join(root, "outcome");
      const run = runShell(
        baseEnv({ HAS_CLAUDE_TOKEN: "false", PRHERO_OUTCOME_DIR: dir }),
        undefined,
        undefined,
        failingFs,
      );
      expect(run.exitCode).toBe(1);
      const lines = run.stdout.split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toStartWith(
        "::error title=pr-hero::pr-hero could not write",
      );
      expect(lines[1]).toStartWith(
        "::error title=pr-hero::pr-hero has no credential for this review",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed pr-number is recorded with its fixed detail, and the record never echoes the value", () => {
    const { exitCode, outputs, stdout, recordText, record } = outcomeRun(
      baseEnv({
        EVENT_NAME: "workflow_dispatch",
        EVENT_PR_NUMBER: "",
        PR_NUMBER_INPUT: "12\nrun=true",
      }),
    );
    expect(exitCode).toBe(1);
    expect(outputs.publish).toBe("true");
    expect(stdout).toBe("");
    expect(record?.cls).toEqual({ kind: "trigger", check: "pr-unresolved" });
    expect(record?.params).toEqual({
      detail: "the pr-number input is not a positive integer",
    });
    expect(recordText).not.toContain("run=true");
  });

  test("the legacy force dispatch flows pr-number, force and full straight through", () => {
    const run = runShell(
      baseEnv({
        EVENT_NAME: "workflow_dispatch",
        EVENT_PR_NUMBER: "",
        EVENT_PR_HEAD_SHA: "",
        PR_NUMBER_INPUT: "305",
        FORCE_INPUT: "true",
        FULL_INPUT: "true",
      }),
      () => ok(`${OTHER_SHA}\n`),
    );
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toEqual({
      run: "true",
      force: "true",
      full: "true",
      pr: "305",
      head_sha: OTHER_SHA,
      publish: "true",
    });
  });

  test("a head that cannot be resolved still reviews; only the artifact name degrades", () => {
    const run = runShell(
      baseEnv({
        EVENT_NAME: "workflow_dispatch",
        EVENT_PR_NUMBER: "",
        PR_NUMBER_INPUT: "305",
      }),
      () => ({ exitCode: 1, stdout: "", stderr: "HTTP 502" }),
    );
    expect(run.exitCode).toBe(0);
    expect(run.outputs.run).toBe("true");
    expect(run.outputs.head_sha).toBe("unknown");
    expect(run.stdout).toContain("::warning title=pr-hero::");
  });

  test("a head sha that is not a sha is never written to the outputs", () => {
    const run = runShell(
      baseEnv({ EVENT_NAME: "workflow_dispatch", PR_NUMBER_INPUT: "305" }),
      () => ok("deadbeef\nrun=true\n"),
    );
    expect(run.outputs.head_sha).toBe("unknown");
    expect(run.output.match(/^run=/gm)).toEqual(["run="]);
  });

  test("trigger.json never holds a secret value, the comment body or gh's text", () => {
    const hostile = "/pr-hero review ::error::HOSTILE-BODY";
    const runs = [
      outcomeRun(baseEnv({ HAS_CLAUDE_TOKEN: "false" })),
      outcomeRun(baseEnv()),
      outcomeRun(commentEnv(hostile)),
      outcomeRun(commentEnv("/pr-hero review"), () => ({
        exitCode: 1,
        stdout: "",
        stderr: "gh: Server Error (HTTP 502) HOSTILE-GH",
      })),
    ];
    for (const run of runs) {
      expect(run.recordText).toBeDefined();
      for (const secret of Object.values(SECRETS)) {
        expect(run.recordText ?? "").not.toContain(secret);
      }
      expect(run.recordText ?? "").not.toContain("HOSTILE");
    }
  });

  test("no outcome ever prints a secret value or the comment body", () => {
    const hostile = "/pr-hero review ::error::HOSTILE-BODY";
    const runs = [
      runShell(baseEnv()),
      runShell(baseEnv({ HAS_CLAUDE_TOKEN: "false" })),
      runShell(commentEnv(hostile)),
      runShell(
        commentEnv("/pr-hero review"),
        scriptedGh(ok("read"), ok(HEAD_SHA)),
      ),
      runShell(
        commentEnv("/pr-hero review"),
        scriptedGh(ok("write"), ok(HEAD_SHA)),
      ),
      runShell(commentEnv("/pr-hero review"), () => ({
        exitCode: 1,
        stdout: "",
        stderr: "gh: Server Error (HTTP 502)",
      })),
    ];
    for (const run of runs) {
      const printed = run.stdout + run.output + run.summary;
      for (const secret of Object.values(SECRETS)) {
        expect(printed).not.toContain(secret);
      }
      expect(printed).not.toContain("HOSTILE-BODY");
    }
  });
});

describe("runCiTrigger — the outcome record and the publish output (T2b)", () => {
  test("every decision writes trigger.json with the documented fields", () => {
    const cases: Array<
      [string, Record<string, string>, TriggerRecord["decision"]]
    > = [
      ["review", baseEnv(), "review"],
      [
        "no-credentials",
        baseEnv({ HAS_CLAUDE_TOKEN: "false" }),
        "no-credentials",
      ],
      ["ignore", commentEnv("/pr-hero review please"), "ignore"],
    ];
    for (const [, env, decision] of cases) {
      const run = outcomeRun(env);
      expect(run.record?.decision).toBe(decision);
      expect(run.record?.v).toBe(1);
      expect(run.record?.repository).toBe(REPO);
      expect(run.record?.run_id).toBe("4242");
      expect(run.record?.run_url).toBe(
        `https://github.com/${REPO}/actions/runs/4242`,
      );
      expect(run.record?.params).toEqual(expect.any(Object));
    }
  });

  test("a denied commenter's record is written too", () => {
    const run = outcomeRun(
      commentEnv("/pr-hero review"),
      scriptedGh(ok("read"), ok(HEAD_SHA)),
    );
    expect(run.record?.decision).toBe("denied");
    expect(run.outputs.publish).toBe("false");
  });

  test("the record of a review carries the PR number and the head it reviewed", () => {
    const run = outcomeRun(baseEnv());
    expect(run.record?.pr).toBe(7);
    expect(run.record?.head_sha).toBe(HEAD_SHA);
    expect(run.outputs.publish).toBe("true");
  });

  test("no-credentials carries the PR and the head, so the publisher can post on the PR", () => {
    const run = outcomeRun(baseEnv({ HAS_CLAUDE_TOKEN: "false" }));
    expect(run.record?.pr).toBe(7);
    expect(run.record?.head_sha).toBe(HEAD_SHA);
    expect(run.outputs.pr).toBe("7");
    expect(run.outputs.head_sha).toBe(HEAD_SHA);
    expect(run.outputs.run).toBe("false");
  });

  test("no-credentials names the route from the routing input, so the fix matches it", () => {
    expect(
      outcomeRun(baseEnv({ HAS_CLAUDE_TOKEN: "false" })).record?.params,
    ).toEqual({ backend: "claude" });
    expect(
      outcomeRun(
        baseEnv({ HAS_CLAUDE_TOKEN: "false", HAS_OPENCODE_ROUTING: "true" }),
      ).record?.params,
    ).toEqual({ backend: "opencode" });
  });

  test("publish is true for review, no-credentials and unverifiable, and false otherwise", () => {
    const publish = (
      env: Record<string, string>,
      answer?: Parameters<typeof runShell>[1],
    ) => runShell(env, answer).outputs.publish;
    expect(publish(baseEnv())).toBe("true");
    expect(publish(baseEnv({ HAS_CLAUDE_TOKEN: "false" }))).toBe("true");
    expect(
      publish(commentEnv("/pr-hero review"), () => {
        throw new Error("spawn gh ENOENT");
      }),
    ).toBe("true");
    expect(publish(commentEnv("/pr-hero review please"))).toBe("false");
    expect(
      publish(
        commentEnv("/pr-hero review"),
        scriptedGh(ok("read"), ok(HEAD_SHA)),
      ),
    ).toBe("false");
  });

  test("an unverifiable lookup records the HTTP status gh printed, as a github class", () => {
    const run = outcomeRun(commentEnv("/pr-hero review"), () => ({
      exitCode: 1,
      stdout: "",
      stderr: "gh: Server Error (HTTP 503)",
    }));
    expect(run.record?.decision).toBe("unverifiable");
    expect(run.record?.cls).toEqual({ kind: "github", status: 503 });
    expect(run.record?.head_sha).toBeUndefined();
  });

  test("a 403 is a rate limit only when gh says so; otherwise it stays a permission reading", () => {
    const limited = outcomeRun(commentEnv("/pr-hero review"), () => ({
      exitCode: 1,
      stdout: "",
      stderr: "gh: API rate limit exceeded (HTTP 403)",
    }));
    expect(limited.record?.cls).toEqual({
      kind: "github",
      status: 403,
      rateLimited: true,
    });
    const refused = outcomeRun(commentEnv("/pr-hero review"), () => ({
      exitCode: 1,
      stdout: "",
      stderr: "gh: Resource not accessible (HTTP 403)",
    }));
    expect(refused.record?.cls).toEqual({ kind: "github", status: 403 });
    expect(refused.record?.cls).not.toHaveProperty("rateLimited");
  });

  test("an unverifiable lookup with no HTTP status records no class", () => {
    const run = outcomeRun(commentEnv("/pr-hero review"), () => ({
      exitCode: -1,
      stdout: "",
      stderr: "spawn gh ENOENT",
    }));
    expect(run.record?.decision).toBe("unverifiable");
    expect(run.record?.cls).toBeUndefined();
  });

  test("an unverifiable lookup's record names the step that failed, so the publisher can say which one", () => {
    const run = outcomeRun(commentEnv("/pr-hero review"), () => ({
      exitCode: 1,
      stdout: "",
      stderr: "gh: Resource not accessible (HTTP 403)",
    }));
    expect(run.record?.decision).toBe("unverifiable");
    expect(run.record?.params).toEqual({
      step: "the commenter permission check",
    });
  });

  test("a marker left by an earlier run in the same outcome directory is cleared before this run writes its record", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "prhero-trigger-stale-"));
    try {
      const dir = path.join(root, "pr-hero-outcome");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "cli-started"), "");
      writeFileSync(path.join(dir, "cli-succeeded"), "");
      writeFileSync(path.join(dir, "setup.json"), "{}");
      runShell({ ...baseEnv(), PRHERO_OUTCOME_DIR: dir });
      expect(existsSync(path.join(dir, "cli-started"))).toBe(false);
      expect(existsSync(path.join(dir, "cli-succeeded"))).toBe(false);
      expect(existsSync(path.join(dir, "setup.json"))).toBe(false);
      expect(existsSync(path.join(dir, "trigger.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a review whose PR resolves records no class and no error", () => {
    const run = outcomeRun(baseEnv());
    expect(run.record?.cls).toBeUndefined();
    expect(run.exitCode).toBe(0);
  });

  test("a record that cannot be written leaves no partial file and keeps the decision's exit code", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "prhero-trigger-atomic-"));
    try {
      const dir = path.join(root, "outcome");
      let stdout = "";
      const exitCode = runCiTrigger({
        env: { ...baseEnv(), PRHERO_OUTCOME_DIR: dir },
        gh: () => ({ exitCode: 1, stdout: "", stderr: "unused" }),
        sleep: () => {},
        exists: () => false,
        stdout: (text) => {
          stdout += text;
        },
        appendOutput: () => {},
        appendSummary: () => {},
        fs: {
          mkdir: (target) => {
            mkdirSync(target, { recursive: true });
          },
          writeFile: (filePath) => {
            writeFileSync(filePath, '{"v":1,"deci');
            throw new Error("ENOSPC: no space left on device");
          },
          rename: () => {
            throw new Error("rename must not run after a failed write");
          },
          remove: (filePath) => rmSync(filePath, { force: true }),
        },
      });
      expect(exitCode).toBe(0);
      expect(existsSync(path.join(dir, "trigger.json"))).toBe(false);
      expect(existsSync(path.join(dir, "trigger.json.tmp"))).toBe(false);
      expect(stdout).toContain("::error title=pr-hero::");
      expect(stdout).toContain("outcome record");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("with no PRHERO_OUTCOME_DIR nothing is written and the outputs are unchanged", () => {
    const run = runShell(baseEnv());
    expect(run.outputs.run).toBe("true");
    expect(run.outputs.publish).toBe("true");
    expect(Object.keys(run.outputs).sort()).toEqual(
      ["force", "full", "head_sha", "pr", "publish", "run"].sort(),
    );
  });
});

describe("runCiTrigger — a fork's pull_request_target", () => {
  test("reviews the fork head from the event, with no gh call", () => {
    const run = runShell(
      baseEnv({
        EVENT_NAME: "pull_request_target",
        EVENT_PR_HEAD_REPO: "stranger/widgets",
      }),
    );
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toEqual({
      run: "true",
      force: "false",
      full: "false",
      pr: "7",
      head_sha: HEAD_SHA,
      publish: "true",
    });
    expect(run.ghCalls).toEqual([]);
  });
});

// The engine authenticates with more than the three inputs: a Claude session
// file in HOME (defaultClaudeAuthProbe) and the OpenCode auth store
// (OpenCodeAuthBroker). A red `no-credentials` on a runner that holds one of
// them is a false alarm the engine would never have raised. The paths below
// are spelled out as literals, not derived from the module under test.
describe("runCiTrigger — credentials already on the runner", () => {
  const HOME = "/home/runner";
  const noInput = (extra: Record<string, string> = {}) =>
    baseEnv({ HAS_CLAUDE_TOKEN: "false", HOME, ...extra });

  test.each<[string, Record<string, string>, string]>([
    ["~/.claude.json", {}, "/home/runner/.claude.json"],
    ["~/.claude/session.json", {}, "/home/runner/.claude/session.json"],
    [
      "~/.claude/.credentials.json",
      {},
      "/home/runner/.claude/.credentials.json",
    ],
    [
      "the default OpenCode auth store",
      {},
      "/home/runner/.local/share/opencode/auth.json",
    ],
    [
      "the OpenCode auth store under XDG_DATA_HOME",
      { XDG_DATA_HOME: "/xdg/data" },
      "/xdg/data/opencode/auth.json",
    ],
  ])("%s alone avoids no-credentials", (_label, extra, file) => {
    const run = runShell(noInput(extra), undefined, (p) => p === file);
    expect(run.exitCode).toBe(0);
    expect(run.outputs.run).toBe("true");
  });

  test("with XDG_DATA_HOME set, the default OpenCode path is not the engine's and does not count", () => {
    const run = runShell(
      noInput({ XDG_DATA_HOME: "/xdg/data" }),
      undefined,
      (p) => p === "/home/runner/.local/share/opencode/auth.json",
    );
    expect(run.exitCode).toBe(1);
    expect(run.outputs.run).toBe("false");
  });

  test("a self-hosted runner with nothing found defers to the engine", () => {
    const run = runShell(noInput({ RUNNER_ENVIRONMENT: "self-hosted" }));
    expect(run.exitCode).toBe(0);
    expect(run.outputs.run).toBe("true");
  });

  test("a GitHub-hosted runner with no input and no file is still no-credentials", () => {
    const run = runShell(noInput({ RUNNER_ENVIRONMENT: "github-hosted" }));
    expect(run.exitCode).toBe(1);
    expect(run.outputs.publish).toBe("true");
    expect(run.summary).toBe("");
  });

  // action.yml's Run pr-hero step binds ANTHROPIC_API_KEY and
  // CLAUDE_CODE_OAUTH_TOKEN from the inputs in its own `env:`, which wins over
  // the job's, so a job-level value never reaches the engine.
  test("a job-level ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN alone does not count", () => {
    const run = runShell(
      noInput({
        RUNNER_ENVIRONMENT: "github-hosted",
        ANTHROPIC_API_KEY: "sk-ant-job-level",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-job-level",
      }),
    );
    expect(run.exitCode).toBe(1);
    expect(run.outputs.run).toBe("false");
  });
});

// trigger.ts reimplements the engine's credential locations because it runs
// before `bun install` and may import only builtins. This pins the copy to
// the engine's own definitions, so a new session file or a changed XDG rule
// on the engine side fails here instead of turning a working runner red.
describe("the trigger looks for runner credentials where the engine does", () => {
  test.each<[string, string, string | undefined]>([
    ["HOME only", "/home/runner", undefined],
    ["HOME and XDG_DATA_HOME", "/home/runner", "/xdg/data"],
    ["an empty XDG_DATA_HOME, which counts as unset", "/Users/dev", ""],
  ])("%s", (_label, home, xdgDataHome) => {
    const env: Record<string, string> =
      xdgDataHome === undefined
        ? { HOME: home }
        : { HOME: home, XDG_DATA_HOME: xdgDataHome };
    expect(runnerCredentialPaths(env)).toEqual([
      ...CLAUDE_SESSION_FILES.map((file) => path.join(home, file)),
      resolveOpenCodeAuthPath(env, home),
    ]);
  });

  // The constant is the engine's real predicate, not a second copy of it:
  // each file alone makes the engine's own default probe pass, and none of
  // them fails it. (The probe was refactored onto the constant in this
  // change; this also proves the refactor kept every file it accepted.)
  test.each([...CLAUDE_SESSION_FILES])(
    "the engine's default auth probe accepts %s alone",
    async (file: string) => {
      const home = "/home/runner";
      const report = await produceClaudeCapabilityReport({
        env: { PATH: "/bin" },
        platform: "linux",
        home,
        existsFn: (p) => p === "/bin/claude" || p === path.join(home, file),
        realpathFn: async (p) => p,
        readFileFn: async () => new Uint8Array([1]),
        keychainProbe: () => false,
      });
      expect(report.auth.probe).toBe("passed");
    },
  );

  test("the engine's default auth probe fails with no session file", async () => {
    const report = await produceClaudeCapabilityReport({
      env: { PATH: "/bin" },
      platform: "linux",
      home: "/home/runner",
      existsFn: (p) => p === "/bin/claude",
      realpathFn: async (p) => p,
      readFileFn: async () => new Uint8Array([1]),
      keychainProbe: () => false,
    });
    expect(report.auth.probe).toBe("failed");
  });

  test("with neither HOME nor XDG_DATA_HOME there is nothing to look for", () => {
    // Never a path relative to the working directory, and never the home of
    // whoever runs the suite.
    expect(runnerCredentialPaths({})).toEqual([]);
  });
});

describe("trigger.ts runs before `bun install`", () => {
  test("it imports only runtime builtins", () => {
    const source = readFileSync(MODULE_PATH, "utf-8");
    const specifiers = [
      ...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gms),
    ].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^(node:|bun$|bun:)/);
    }
  });

  // The real entry point, spawned: proves the `import.meta.main` shell reads
  // the env it is given and writes $GITHUB_OUTPUT / $GITHUB_STEP_SUMMARY.
  // Neither case reaches `gh`, so it stays offline.
  function spawnTrigger(env: Record<string, string>) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-trigger-"));
    try {
      const outputPath = path.join(dir, "output");
      const summaryPath = path.join(dir, "summary");
      writeFileSync(outputPath, "");
      writeFileSync(summaryPath, "");
      const result = Bun.spawnSync([process.execPath, MODULE_PATH], {
        cwd: dir,
        env: {
          ...env,
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          // An empty home: the real module probes the real filesystem for
          // runner credentials, and must not find the developer's own.
          HOME: dir,
          PATH: dir,
        },
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        output: readFileSync(outputPath, "utf-8"),
        summary: readFileSync(summaryPath, "utf-8"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("as a process, a same-repo pull_request writes run=true and the head", () => {
    const run = spawnTrigger(baseEnv());
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("run=true\n");
    expect(run.output).toContain("pr=7\n");
    expect(run.output).toContain(`head_sha=${HEAD_SHA}\n`);
  });

  test("as a process, no credential exits 1, publishes, and leaves its record", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-trigger-proc-"));
    try {
      const run = spawnTrigger({
        ...baseEnv({ HAS_CLAUDE_TOKEN: "false" }),
        PRHERO_OUTCOME_DIR: path.join(dir, "outcome"),
      });
      expect(run.exitCode).toBe(1);
      expect(run.output).toContain("run=false\n");
      expect(run.output).toContain("publish=true\n");
      expect(run.stdout).toBe("");
      expect(run.summary).toBe("");
      expect(
        parseTriggerRecord(
          readFileSync(path.join(dir, "outcome", "trigger.json"), "utf8"),
        )?.decision,
      ).toBe("no-credentials");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The command text lives in two modules that cannot share an import:
// trigger.ts runs before `bun install` and imports builtins only, while the
// skip-comment hint in force-comment.ts tells people what to type. A hint that
// drifted from what the trigger accepts would send every reader to a command
// that silently does nothing, so the two are pinned to each other here.
describe("the hint and the trigger agree on the command", () => {
  test("every command the skip-comment hint names is one the trigger accepts", () => {
    expect(parseReviewCommand(CI_REVIEW_COMMENT)).toEqual({ full: false });
    expect(parseReviewCommand(CI_REVIEW_FULL_COMMENT)).toEqual({ full: true });
  });
});
