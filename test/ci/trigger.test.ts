// The action-side trigger (odd/tasks/agent-first-ci.md, T1/S1): which events
// review, who may ask for one by comment, and what a run with no credential
// does. The consumer workflow's job `if:` pre-filters fork `pull_request` runs
// and comments that are not a command. It cannot pre-filter a comment by its
// head repository, because an `issue_comment` event does not carry one, so the
// action re-decides all of it, and every rule here is pinned on the action's
// own module rather than on the caller's YAML.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CI_REVIEW_COMMENT, CI_REVIEW_FULL_COMMENT } from "#ci/force-comment";
import {
  PENDING_AT_FILE,
  parseTriggerRecord,
  type TriggerRecord,
} from "#ci/outcome";
import {
  type CiTriggerDecision,
  type CiTriggerInput,
  type CommenterPermission,
  commenterPermissionNeeded,
  decideCiTrigger,
  type GhResult,
  type OutcomeFs,
  parseReviewCommand,
  RECHECK_COMMAND,
  REVIEW_COMMAND,
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
        adjudicate: false,
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
        adjudicate: false,
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

// T6 (odd/tasks/agent-first-ci.md, S8): `/pr-hero override` is the human escape
// hatch. It spends nothing, so it never reaches the credential check, and it is
// the only comment that records WHO acted (the actor), because the override must
// name who unlocked the gate.
describe("decideCiTrigger — the override command (S8)", () => {
  test.each([
    ["exact", "/pr-hero override"],
    ["surrounding spaces", "   /pr-hero override  "],
    ["surrounding newlines", "\n/pr-hero override\n"],
  ])("`/pr-hero override` (%s) overrides for a writer", (_label, body) => {
    expect(decideCiTrigger(comment(body))).toEqual({
      kind: "override",
      actor: "maintainer",
    });
  });

  test("an admin may override", () => {
    expect(
      decideCiTrigger(
        comment("/pr-hero override", {
          commenterPermission: { kind: "resolved", permission: "admin" },
        }),
      ),
    ).toEqual({ kind: "override", actor: "maintainer" });
  });

  test.each([
    "/pr-hero override please",
    "/pr-hero overriding",
    "/PR-HERO override",
    "/pr-hero  override",
    "/pr-hero override --force",
    "please /pr-hero override",
    "/pr-hero review override",
  ])("a near-miss %j is ignored, never an override", (body) => {
    expect(decideCiTrigger(comment(body)).kind).toBe("ignore");
  });

  test("a commenter with read access is denied, and the reason names the override command", () => {
    const verdict = decideCiTrigger(
      comment("/pr-hero override", {
        commenterPermission: { kind: "resolved", permission: "read" },
      }),
    );
    expect(verdict.kind).toBe("denied");
    expect(verdict).toMatchObject({
      reason: expect.stringContaining("`/pr-hero override`"),
    });
  });

  test("an override with no permission answer is denied, never run", () => {
    expect(
      decideCiTrigger(
        comment("/pr-hero override", { commenterPermission: undefined }),
      ),
    ).toMatchObject({ kind: "denied" });
  });

  test("an unverifiable permission lookup is unverifiable, never an override", () => {
    const verdict = decideCiTrigger(
      comment("/pr-hero override", {
        commenterPermission: {
          kind: "indeterminate",
          detail: "HTTP 503",
          status: 503,
        },
      }),
    );
    expect(verdict.kind).toBe("unverifiable");
    expect(verdict).toMatchObject({
      reason: expect.stringContaining("`/pr-hero override`"),
    });
  });

  test("an override needs no credential: it spends nothing, so a repository with none can still unlock", () => {
    expect(
      decideCiTrigger(
        comment("/pr-hero override", {
          credentials: NO_CREDENTIALS,
          selfHostedRunner: false,
        }),
      ),
    ).toEqual({ kind: "override", actor: "maintainer" });
  });

  test("a login that is not a GitHub login is refused, and the refusal never echoes it", () => {
    const verdict = decideCiTrigger(
      comment("/pr-hero override", {
        commenterLogin: "evil\n::warning::HOSTILE",
      }),
    );
    expect(verdict.kind).toBe("denied");
    expect(JSON.stringify(verdict)).not.toContain("HOSTILE");
  });

  // An Enterprise Managed User login is `handle_shortcode` and can be longer than
  // 39 characters, so the guard must accept both (the maintainer could not override).
  // The bound is 91 characters, the longest login whose override description
  // (49 characters around it) still fits GitHub's 140-character status limit.
  test.each([
    ["an EMU login with an underscore", "octo_corp"],
    ["a 45-character EMU-style login", `${"a".repeat(40)}_corp`],
    ["a 91-character login, the bound", "a".repeat(91)],
    ["a bot login", "dependabot[bot]"],
    ["a bot login of 91 characters in all", `${"a".repeat(86)}[bot]`],
  ])("%s is accepted as the override actor", (_label, login) => {
    expect(
      decideCiTrigger(comment("/pr-hero override", { commenterLogin: login })),
    ).toEqual({ kind: "override", actor: login });
  });

  // One past the bound is refused, for a plain login and for a bot login whose
  // `[bot]` suffix counts toward the same 91.
  test.each([
    ["a 92-character login", "a".repeat(92)],
    ["a 96-character bot login", `${"a".repeat(91)}[bot]`],
  ])(
    "%s is refused, so its override description cannot overflow",
    (_label, login) => {
      const verdict = decideCiTrigger(
        comment("/pr-hero override", { commenterLogin: login }),
      );
      expect(verdict.kind).toBe("denied");
      expect(JSON.stringify(verdict)).not.toContain(login);
    },
  );

  // Whatever could break the status text or the markdown comment stays refused.
  test.each([
    ["a space", "octo corp"],
    ["a backtick", "octo`corp"],
    ["an opening angle bracket", "octo<corp"],
    ["a closing angle bracket", "octo>corp"],
    ["an @ sign", "@octo"],
    ["a newline", "octo\ncorp"],
    ["a trailing newline", "octo\n"],
  ])("a login with %s is refused", (_label, login) => {
    const verdict = decideCiTrigger(
      comment("/pr-hero override", { commenterLogin: login }),
    );
    expect(verdict.kind).toBe("denied");
    expect(JSON.stringify(verdict)).not.toContain(login);
  });

  // A re-run replays the original comment event, but resolves the head at re-run
  // time. The override would then land on a head its commenter never saw.
  test("an override on a re-run attempt is refused, and the first attempt proceeds", () => {
    expect(
      decideCiTrigger(comment("/pr-hero override", { runAttempt: 2 })),
    ).toMatchObject({
      kind: "denied",
      reason: expect.stringContaining(
        "an override applies to the head at the time of the comment",
      ),
    });
    expect(
      decideCiTrigger(comment("/pr-hero override", { runAttempt: 1 })),
    ).toEqual({ kind: "override", actor: "maintainer" });
    expect(decideCiTrigger(comment("/pr-hero override"))).toEqual({
      kind: "override",
      actor: "maintainer",
    });
  });

  test("the override record names its actor, and a review record never does", () => {
    const override = outcomeRun(
      commentEnv("/pr-hero override"),
      scriptedGh(ok("write"), overrideHead(HEAD_SHA, false)),
    );
    expect(override.exitCode).toBe(0);
    expect(override.outputs).toMatchObject({
      run: "false",
      publish: "true",
      pr: "21",
      head_sha: HEAD_SHA,
    });
    expect(override.record).toMatchObject({
      decision: "override",
      actor: "maintainer",
      pr: 21,
    });

    const review = outcomeRun(
      commentEnv("/pr-hero review"),
      scriptedGh(ok("write"), ok(HEAD_SHA)),
    );
    expect(review.recordText).toBeDefined();
    expect(JSON.parse(review.recordText ?? "{}")).not.toHaveProperty("actor");
  });

  test("an override whose head cannot be resolved still records its actor, with no head", () => {
    // A same-repository answer with no usable sha: the head is unknown, not the fork.
    const run = outcomeRun(
      commentEnv("/pr-hero override"),
      scriptedGh(ok("write"), overrideHead("", false)),
    );
    expect(run.exitCode).toBe(0);
    expect(run.record).toMatchObject({
      decision: "override",
      actor: "maintainer",
      pr: 21,
    });
    expect(run.record?.head_sha).toBeUndefined();
  });

  test("an override on a pull request that cannot be resolved takes the review's error path", () => {
    const run = outcomeRun(
      commentEnv("/pr-hero override", { EVENT_ISSUE_NUMBER: "" }),
      scriptedGh(ok("write"), ok(HEAD_SHA)),
    );
    expect(run.exitCode).toBe(1);
    expect(run.outputs.run).toBe("false");
  });

  test("an override whose record cannot be written fails the job, never silently", () => {
    const run = runShell(
      commentEnv("/pr-hero override", {
        PRHERO_OUTCOME_DIR: path.join(
          os.tmpdir(),
          "prhero-override-unwritable",
        ),
      }),
      scriptedGh(ok("write"), overrideHead(HEAD_SHA, false)),
      () => false,
      failingFs,
    );
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("could not write its outcome record");
  });

  test("an override re-run (attempt 2) sets nothing and looks up no head; attempt 1 records the override", () => {
    const rerun = outcomeRun(
      commentEnv("/pr-hero override", { GITHUB_RUN_ATTEMPT: "2" }),
      scriptedGh(ok("write"), ok(HEAD_SHA)),
    );
    expect(rerun.exitCode).toBe(0);
    expect(rerun.outputs).toMatchObject({ run: "false", head_sha: "" });
    expect(rerun.record).toMatchObject({ decision: "denied", run_attempt: 2 });
    expect(rerun.record).not.toHaveProperty("actor");
    expect(rerun.ghCalls.filter((args) => args[0] === "pr")).toEqual([]);
    expect(rerun.stdout).toContain(
      "an override applies to the head at the time of the comment; comment `/pr-hero override` again",
    );

    const first = outcomeRun(
      commentEnv("/pr-hero override", { GITHUB_RUN_ATTEMPT: "1" }),
      scriptedGh(ok("write"), overrideHead(HEAD_SHA, false)),
    );
    expect(first.exitCode).toBe(0);
    expect(first.record).toMatchObject({
      decision: "override",
      actor: "maintainer",
    });
  });

  // The head is the whole target of an override's status, so its one lookup is
  // retried once. A review only names an artifact with its head, so it is not.
  test("an override retries its head lookup once: a second answer is used", () => {
    let headCalls = 0;
    const run = outcomeRun(commentEnv("/pr-hero override"), (args) => {
      if (args[0] === "api") return ok("write");
      headCalls += 1;
      return headCalls === 1
        ? { exitCode: 1, stdout: "", stderr: "gh: transient failure" }
        : overrideHead(HEAD_SHA, false);
    });
    expect(run.exitCode).toBe(0);
    expect(run.record).toMatchObject({
      decision: "override",
      head_sha: HEAD_SHA,
    });
    expect(run.outputs).toMatchObject({ head_sha: HEAD_SHA });
    expect(run.ghCalls.filter((args) => args[0] === "pr")).toHaveLength(2);
    expect(run.sleeps).toHaveLength(1);
  });

  // The lookup also answers whether the pull request is from a fork, so a lookup
  // that fails twice cannot tell, and the override is refused rather than guessed.
  test("an override whose head lookup fails twice is refused, with no status", () => {
    const run = outcomeRun(commentEnv("/pr-hero override"), (args) =>
      args[0] === "api"
        ? ok("write")
        : { exitCode: 1, stdout: "", stderr: "gh: still failing" },
    );
    expect(run.exitCode).toBe(0);
    expect(run.ghCalls.filter((args) => args[0] === "pr")).toHaveLength(2);
    expect(run.outputs).toMatchObject({ run: "false", publish: "false" });
    expect(run.record).toMatchObject({ decision: "denied" });
    expect(run.record).not.toHaveProperty("actor");
    expect(run.stdout).toContain(UNKNOWN_FORK_OVERRIDE_REFUSAL);
    expect(run.stdout).not.toContain(FORK_OVERRIDE_REFUSAL);
  });

  // A fork's head can change after the comment, and an override binds to the head
  // the job resolves. So a fork pull request is refused, and a definite answer
  // is not retried.
  test("an override on a fork pull request is refused: a notice, no status, and no actor recorded", () => {
    const run = outcomeRun(
      commentEnv("/pr-hero override"),
      scriptedGh(ok("write"), overrideHead(HEAD_SHA, true)),
    );
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toMatchObject({
      run: "false",
      publish: "false",
      head_sha: "",
    });
    expect(run.record).toMatchObject({ decision: "denied" });
    expect(run.record).not.toHaveProperty("actor");
    expect(run.stdout).toContain(FORK_OVERRIDE_REFUSAL);
    expect(run.stdout).not.toContain(UNKNOWN_FORK_OVERRIDE_REFUSAL);
    // The gh API calls are the permission lookup and the refusal's reaction (T2e,
    // -1), one more than before the reaction existed. The shell still posts no
    // status, and the publisher, which would, never runs for a refused override.
    expect(run.ghCalls.filter((args) => args[0] === "api")).toHaveLength(2);
    expect(run.ghCalls.filter((args) => args[0] === "pr")).toHaveLength(1);
    expect(run.ghCalls).toContainEqual(reactionArgv("-1"));
    expect(run.sleeps).toEqual([]);
  });

  test("an override on a same-repository pull request still overrides on the head it names", () => {
    const run = outcomeRun(
      commentEnv("/pr-hero override"),
      scriptedGh(ok("write"), overrideHead(HEAD_SHA, false)),
    );
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toMatchObject({
      run: "false",
      publish: "true",
      head_sha: HEAD_SHA,
    });
    expect(run.record).toMatchObject({
      decision: "override",
      actor: "maintainer",
      head_sha: HEAD_SHA,
    });
    expect(run.stdout).not.toContain(FORK_OVERRIDE_REFUSAL);
  });

  test.each([
    ["the lookup failed", { exitCode: 1, stdout: "", stderr: "gh: failing" }],
    ["the field is missing", ok(JSON.stringify({ headRefOid: HEAD_SHA }))],
    [
      "the field is not a boolean",
      ok(JSON.stringify({ headRefOid: HEAD_SHA, isCrossRepository: "false" })),
    ],
    ["the answer is the review's bare sha", ok(HEAD_SHA)],
  ])(
    "an override is refused when the lookup cannot tell a fork (%s)",
    (_label, answer) => {
      const run = outcomeRun(commentEnv("/pr-hero override"), (args) =>
        args[0] === "api" ? ok("write") : answer,
      );
      expect(run.exitCode).toBe(0);
      expect(run.outputs).toMatchObject({ run: "false", publish: "false" });
      expect(run.record).toMatchObject({ decision: "denied" });
      expect(run.record).not.toHaveProperty("actor");
      expect(run.stdout).toContain(UNKNOWN_FORK_OVERRIDE_REFUSAL);
      expect(run.stdout).not.toContain(FORK_OVERRIDE_REFUSAL);
      expect(run.ghCalls.filter((args) => args[0] === "pr")).toHaveLength(2);
    },
  );

  test("a review of a fork pull request is not refused and keeps its bare-sha lookup", () => {
    const run = outcomeRun(commentEnv("/pr-hero review"), (args) => {
      if (args[0] === "api") return ok("write");
      // The fork answer is for the override's combined lookup only.
      return args.some((arg) => arg.includes("isCrossRepository"))
        ? overrideHead(HEAD_SHA, true)
        : ok(HEAD_SHA);
    });
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toMatchObject({
      run: "true",
      publish: "true",
      head_sha: HEAD_SHA,
    });
    expect(run.ghCalls.filter((args) => args[0] === "pr")).toEqual([
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
    expect(run.stdout).not.toContain(FORK_OVERRIDE_REFUSAL);
  });

  test("a review does not retry its head lookup", () => {
    const run = outcomeRun(commentEnv("/pr-hero review"), (args) =>
      args[0] === "api"
        ? ok("write")
        : { exitCode: 1, stdout: "", stderr: "gh: failing" },
    );
    expect(run.ghCalls.filter((args) => args[0] === "pr")).toHaveLength(1);
    expect(run.sleeps).toEqual([]);
  });
});

describe("decideCiTrigger — the pull_request filter", () => {
  test("a same-repo pull_request reviews without force", () => {
    expect(decideCiTrigger(pullRequest())).toEqual({
      kind: "review",
      force: false,
      full: false,
      adjudicate: false,
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
    ).toEqual({ kind: "review", force: false, full: false, adjudicate: false });
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
      ).toEqual({ kind: "review", force: true, full, adjudicate: false });
    },
  );

  test("workflow_dispatch without force reviews without force", () => {
    expect(decideCiTrigger(dispatch())).toEqual({
      kind: "review",
      force: false,
      full: false,
      adjudicate: false,
    });
  });

  test("a full input widens a plain comment command too", () => {
    expect(
      decideCiTrigger(comment("/pr-hero review", { fullInput: true })),
    ).toEqual({
      kind: "review",
      force: true,
      full: true,
      adjudicate: false,
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

// The triggering comment's id, as a real issue_comment event always carries it.
const COMMENT_ID = "9001";

function commentEnv(body: string, overrides: Record<string, string> = {}) {
  return baseEnv({
    EVENT_NAME: "issue_comment",
    EVENT_PR_NUMBER: "",
    EVENT_PR_HEAD_REPO: "",
    EVENT_PR_HEAD_SHA: "",
    EVENT_ISSUE_NUMBER: "21",
    EVENT_ISSUE_PR_URL: `https://api.github.com/repos/${REPO}/pulls/21`,
    EVENT_COMMENT_ID: COMMENT_ID,
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

// A fake fs whose removals of the matching files fail with EPERM, the way a stale
// file another user owns fails. Every other operation is the real one.
function fsWhereRemovalFails(
  failing: (filePath: string) => boolean,
): OutcomeFs {
  return {
    mkdir: (target) => {
      mkdirSync(target, { recursive: true });
    },
    writeFile: (filePath, text) => {
      writeFileSync(filePath, text);
    },
    rename: (from, to) => {
      renameSync(from, to);
    },
    remove: (filePath) => {
      if (failing(filePath)) {
        throw Object.assign(new Error("EPERM: operation not permitted"), {
          code: "EPERM",
        });
      }
      rmSync(filePath, { force: true });
    },
  };
}

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

// The override's one head lookup, `gh pr view --json headRefOid,isCrossRepository`,
// answers in JSON. A review's lookup still answers with the bare sha.
const overrideHead = (sha: string, crossRepository: boolean): GhResult =>
  ok(JSON.stringify({ headRefOid: sha, isCrossRepository: crossRepository }));

// The notice a refused override prints, verbatim.
const FORK_OVERRIDE_REFUSAL =
  "`/pr-hero override` is refused on a pull request from a fork: its head can change after the comment, so the override would not be bound to the code you saw. Review the fork with `/pr-hero review` and merge it with your repository's own rules.";

// The notice an override prints when the lookup could not say whether the pull request is
// a fork. Distinct from the fork notice: a lookup that failed is not a proven fork.
const UNKNOWN_FORK_OVERRIDE_REFUSAL =
  "`/pr-hero override` could not confirm whether this pull request comes from a fork, so it was refused; comment `/pr-hero override` again.";

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
      adjudicate: "false",
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
      adjudicate: "false",
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
      // The accepted command's reaction (T2e), the last call of the run.
      reactionArgv("eyes"),
    ]);
  });

  test("a near-miss comment is a notice, and its only gh call is the confused reaction (T2e)", () => {
    const run = runShell(commentEnv("/pr-hero review please"));
    expect(run.exitCode).toBe(0);
    expect(run.outputs.run).toBe("false");
    expect(run.stdout).toStartWith("::notice title=pr-hero::");
    // Before T2e this was no call at all. A near miss runs no permission lookup.
    expect(run.ghCalls).toEqual([reactionArgv("confused")]);
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
      // head is resolved. The second call is the denial's reaction (T2e, -1).
      expect(run.ghCalls.length).toBe(2);
      expect(run.ghCalls[1]).toEqual(reactionArgv("-1"));
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
      if (args.includes("POST")) return ok("{}");
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
      adjudicate: "false",
      pr: "21",
      head_sha: OTHER_SHA,
      publish: "true",
    });
    // Two permission lookups and one head lookup, then the accepted reaction (T2e).
    expect(run.ghCalls.map((call) => call[0])).toEqual([
      "api",
      "api",
      "pr",
      "api",
    ]);
    expect(run.ghCalls[3]).toEqual(reactionArgv("eyes"));
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
      adjudicate: "false",
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

  test("the record carries the run attempt the runner reports, so a re-run is told apart from its first attempt", () => {
    // WHY: gh run rerun reuses the run id. Without the attempt, a re-run's
    // record is indistinguishable from the first attempt's.
    const run = outcomeRun(baseEnv({ GITHUB_RUN_ATTEMPT: "2" }));
    expect(run.record?.run_attempt).toBe(2);
  });

  test("a run attempt the runner does not report as a positive integer is left out of the record", () => {
    const run = outcomeRun(baseEnv({ GITHUB_RUN_ATTEMPT: "0" }));
    expect(run.recordText).not.toContain("run_attempt");
    expect(run.record?.run_attempt).toBe(1);
  });

  test("a marker left by an earlier run in the same outcome directory is cleared before this run writes its record", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "prhero-trigger-stale-"));
    try {
      const dir = path.join(root, "pr-hero-outcome");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "cli-started"), "");
      writeFileSync(path.join(dir, "setup.json"), "{}");
      // SB3: an older run's pending identity would let the cancel settle trust its pending.
      writeFileSync(path.join(dir, PENDING_AT_FILE), "2026-10-17T10:00:00Z\n");
      runShell({ ...baseEnv(), PRHERO_OUTCOME_DIR: dir });
      expect(existsSync(path.join(dir, PENDING_AT_FILE))).toBe(false);
      expect(existsSync(path.join(dir, "cli-started"))).toBe(false);
      expect(existsSync(path.join(dir, "setup.json"))).toBe(false);
      expect(existsSync(path.join(dir, "trigger.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a cli.json left by an earlier job in the same outcome directory is removed at trigger start", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "prhero-trigger-cli-stale-"),
    );
    try {
      const dir = path.join(root, "pr-hero-outcome");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "cli.json"),
        '{"v":1,"outcome":"reviewed"}\n',
      );
      runShell({ ...baseEnv(), PRHERO_OUTCOME_DIR: dir });
      expect(existsSync(path.join(dir, "cli.json"))).toBe(false);
      expect(existsSync(path.join(dir, "trigger.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WHY a directory (F003 on #330): the temp name is unique per write, so an
  // earlier job's temp file at the old fixed name cannot stop this run's record.
  // A directory there fails any write to that path for every user, root included.
  test("a directory left at the old fixed trigger temp name does not stop the trigger record", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "prhero-trigger-tmp-dir-"));
    try {
      const dir = path.join(root, "pr-hero-outcome");
      mkdirSync(path.join(dir, "trigger.json.tmp"), { recursive: true });
      const run = runShell({ ...baseEnv(), PRHERO_OUTCOME_DIR: dir });
      expect(existsSync(path.join(dir, "trigger.json"))).toBe(true);
      expect(run.stdout).not.toContain("could not write its outcome record");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a review whose PR resolves records no class and no error", () => {
    const run = outcomeRun(baseEnv());
    expect(run.record?.cls).toBeUndefined();
    expect(run.exitCode).toBe(0);
  });

  // WHY strict (F003 on #330): cli-started, setup.json and cli.json are what the
  // publisher reads, so a stale one that cannot be removed must still fail the
  // record write. The CLI's temp file is not among them: its name is unique per
  // write, so no stale one can collide with it.
  test("a stale cli-started that cannot be removed still fails the record write, as before", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "prhero-trigger-start-eperm-"),
    );
    try {
      const dir = path.join(root, "outcome");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "cli-started"), "");
      const run = runShell(
        { ...baseEnv(), PRHERO_OUTCOME_DIR: dir },
        undefined,
        undefined,
        fsWhereRemovalFails((filePath) => filePath.endsWith("cli-started")),
      );
      expect(existsSync(path.join(dir, "trigger.json"))).toBe(false);
      expect(run.stdout).toContain("could not write its outcome record");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a stale setup.json that cannot be removed still fails the record write, as before", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "prhero-trigger-setup-eperm-"),
    );
    try {
      const dir = path.join(root, "outcome");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "setup.json"), "{}");
      const run = runShell(
        { ...baseEnv(), PRHERO_OUTCOME_DIR: dir },
        undefined,
        undefined,
        fsWhereRemovalFails((filePath) => filePath.endsWith("setup.json")),
      );
      expect(existsSync(path.join(dir, "trigger.json"))).toBe(false);
      expect(run.stdout).toContain("could not write its outcome record");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a stale cli.json that cannot be removed still fails the record write, as before", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "prhero-trigger-cli-eperm-"),
    );
    try {
      const dir = path.join(root, "outcome");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "cli.json"),
        '{"v":1,"outcome":"reviewed"}\n',
      );
      const run = runShell(
        { ...baseEnv(), PRHERO_OUTCOME_DIR: dir },
        undefined,
        undefined,
        fsWhereRemovalFails((filePath) => filePath.endsWith("cli.json")),
      );
      expect(existsSync(path.join(dir, "trigger.json"))).toBe(false);
      expect(run.stdout).toContain("could not write its outcome record");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      // CHANGED (F003 on #330): the temp name is unique per write, so a fixed
      // `trigger.json.tmp` check could not see a leftover. Any `.tmp` entry counts.
      expect(
        existsSync(dir)
          ? readdirSync(dir).filter((name) => name.endsWith(".tmp"))
          : [],
      ).toEqual([]);
      expect(stdout).toContain("::error title=pr-hero::");
      expect(stdout).toContain("outcome record");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WHY: the publish step reads whatever trigger.json is on disk. When this
  // run's write failed, the file there is an earlier attempt's, so publish must
  // be off. A decision that is the only speaker (no credential, an unresolved
  // PR, an unverifiable permission) names its own cause on the failed write.
  test.each([
    ["a review", baseEnv(), undefined, 0, undefined],
    [
      "no credentials",
      baseEnv({ HAS_CLAUDE_TOKEN: "false" }),
      undefined,
      1,
      "pr-hero has no credential",
    ],
    [
      "an unresolved PR",
      baseEnv({ EVENT_NAME: "workflow_dispatch", EVENT_PR_NUMBER: "" }),
      undefined,
      1,
      "Could not determine the pull request number",
    ],
    [
      "an unverifiable permission",
      commentEnv("/pr-hero review"),
      (): GhResult => ({
        exitCode: 1,
        stdout: "",
        stderr: "gh: Server Error (HTTP 503)",
      }),
      1,
      "could not verify",
    ],
  ])(
    "a failed record write on %s turns publish off",
    (_label, env, answer, exitCode, cause) => {
      const root = mkdtempSync(
        path.join(os.tmpdir(), "prhero-trigger-publish-off-"),
      );
      try {
        const run = runShell(
          { ...env, PRHERO_OUTCOME_DIR: path.join(root, "outcome") },
          answer,
          () => false,
          failingFs,
        );
        expect(run.exitCode).toBe(exitCode);
        expect(run.outputs.publish).toBe("false");
        if (cause === undefined) {
          expect(run.outputs.run).toBe("true");
        } else {
          expect(run.stdout).toContain(cause);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("with no PRHERO_OUTCOME_DIR nothing is written and the outputs are unchanged", () => {
    const run = runShell(baseEnv());
    expect(run.outputs.run).toBe("true");
    expect(run.outputs.publish).toBe("true");
    expect(Object.keys(run.outputs).sort()).toEqual(
      [
        "adjudicate",
        "force",
        "full",
        "head_sha",
        "pr",
        "publish",
        "run",
      ].sort(),
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
      adjudicate: "false",
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
    expect(parseReviewCommand(CI_REVIEW_COMMENT)).toEqual({
      full: false,
      adjudicate: false,
    });
    expect(parseReviewCommand(CI_REVIEW_FULL_COMMENT)).toEqual({
      full: true,
      adjudicate: false,
    });
  });
});

// T2e: a best-effort reaction on the comment that triggered the run. 👀 an
// accepted command, 👎 a refused one (no write access, or an override that was
// refused), 😕 a near miss. Each reaction is one exact gh call.
type Answer = (args: readonly string[]) => GhResult;

const REACTION_PATH = `repos/${REPO}/issues/comments/${COMMENT_ID}/reactions`;

function reactionArgv(content: string): string[] {
  return ["api", "-X", "POST", REACTION_PATH, "-f", `content=${content}`];
}

function reactionCalls(run: { ghCalls: string[][] }): string[][] {
  return run.ghCalls.filter((args) => args.includes("POST"));
}

// Answers each call by its shape: the reaction POST, then the permission
// lookup (an `api` call), then the head lookup (a `pr` call).
function routed(
  permission: GhResult,
  head: GhResult,
  reaction: GhResult = ok("{}"),
): Answer {
  return (args) => {
    if (args.includes("POST")) return reaction;
    return args[0] === "api" ? permission : head;
  };
}

const REACTION_FAILED: GhResult = {
  exitCode: 1,
  stdout: "",
  stderr: "gh: Validation Failed (HTTP 422)",
};

function warningLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("::warning"));
}

describe("the reaction on the triggering comment (T2e)", () => {
  // Each row: the reaction, what the comment is, its env, and its answers.
  test.each<[string, string, Record<string, string>, Answer]>([
    [
      "eyes",
      "an accepted review by a writer",
      commentEnv("/pr-hero review"),
      routed(ok("write\n"), ok(`${HEAD_SHA}\n`)),
    ],
    [
      "eyes",
      "an accepted full review by an admin",
      commentEnv("/pr-hero review --full"),
      routed(ok("admin\n"), ok(`${HEAD_SHA}\n`)),
    ],
    [
      "eyes",
      "an accepted override",
      commentEnv("/pr-hero override"),
      routed(ok("write\n"), overrideHead(HEAD_SHA, false)),
    ],
    [
      "eyes",
      "an authorised review with no credential",
      commentEnv("/pr-hero review", { HAS_CLAUDE_TOKEN: "false" }),
      routed(ok("write\n"), ok(`${HEAD_SHA}\n`)),
    ],
    [
      "-1",
      "a review by a read-only commenter",
      commentEnv("/pr-hero review"),
      routed(ok("read\n"), ok(`${HEAD_SHA}\n`)),
    ],
    [
      "-1",
      "a review by a commenter who is not a collaborator (404)",
      commentEnv("/pr-hero review"),
      routed(
        { exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" },
        ok(`${HEAD_SHA}\n`),
      ),
    ],
    [
      "-1",
      "an override on a fork",
      commentEnv("/pr-hero override"),
      routed(ok("write\n"), overrideHead(HEAD_SHA, true)),
    ],
    [
      "-1",
      "an override the lookup cannot place",
      commentEnv("/pr-hero override"),
      routed(ok("write\n"), ok(HEAD_SHA)),
    ],
    [
      "confused",
      "a near miss",
      commentEnv("/pr-hero review please"),
      routed(ok("write\n"), ok(`${HEAD_SHA}\n`)),
    ],
    [
      "eyes",
      "an accepted review on run attempt 1",
      commentEnv("/pr-hero review", { GITHUB_RUN_ATTEMPT: "1" }),
      routed(ok("write\n"), ok(`${HEAD_SHA}\n`)),
    ],
  ])(
    "reaction %s for %s, as one exact gh call",
    (content, _label, env, answer) => {
      const run = runShell(env, answer);
      expect(reactionCalls(run)).toEqual([reactionArgv(content)]);
    },
  );

  // WHY only attempt 1 reacts: GitHub replays the comment event on a re-run, so a re-run
  // would stack its own reaction on the comment its first attempt already answered (👀 and
  // then 👎). The re-run's decision, notices and exit code are the same as attempt 1's.
  test.each<[string, string, Record<string, string>, Answer]>([
    [
      "an accepted review",
      "/pr-hero review",
      { GITHUB_RUN_ATTEMPT: "2" },
      routed(ok("write\n"), ok(`${HEAD_SHA}\n`)),
    ],
    [
      "a refused review",
      "/pr-hero review",
      { GITHUB_RUN_ATTEMPT: "2" },
      routed(ok("read\n"), ok(`${HEAD_SHA}\n`)),
    ],
    [
      "a near miss",
      "/pr-hero review please",
      { GITHUB_RUN_ATTEMPT: "2" },
      routed(ok("write\n"), ok(`${HEAD_SHA}\n`)),
    ],
  ])(
    "a re-run (attempt 2) of %s makes no reaction call, and keeps the decision of attempt 1",
    (_label, body, attempt, answer) => {
      const rerun = runShell(commentEnv(body, attempt), answer);
      const first = runShell(
        commentEnv(body, { GITHUB_RUN_ATTEMPT: "1" }),
        answer,
      );
      expect(reactionCalls(rerun)).toEqual([]);
      expect(rerun.exitCode).toBe(first.exitCode);
      expect(rerun.outputs).toEqual(first.outputs);
      expect(rerun.stdout).toBe(first.stdout);
    },
  );

  test("an override re-run (attempt 2) is refused with its notice, and makes no reaction call", () => {
    const run = runShell(
      commentEnv("/pr-hero override", { GITHUB_RUN_ATTEMPT: "2" }),
      routed(ok("write\n"), overrideHead(HEAD_SHA, false)),
    );
    expect(reactionCalls(run)).toEqual([]);
    expect(run.exitCode).toBe(0);
    expect(run.outputs.run).toBe("false");
    expect(run.stdout).toContain(
      "an override applies to the head at the time of the comment; comment `/pr-hero override` again",
    );
  });

  test.each<[string, string]>([
    ["an empty id", ""],
    ["a word", "abc"],
    ["digits with a letter", "12a"],
    ["a negative number", "-7"],
    ["a decimal", "1.5"],
    ["padded digits", " 42 "],
  ])("%s gets no reaction, and the review still runs", (_label, id) => {
    const run = runShell(
      commentEnv("/pr-hero review", { EVENT_COMMENT_ID: id }),
      routed(ok("write\n"), ok(`${HEAD_SHA}\n`)),
    );
    expect(run.exitCode).toBe(0);
    expect(run.outputs.run).toBe("true");
    expect(reactionCalls(run)).toEqual([]);
  });

  test("an absent id gets no reaction", () => {
    const env = commentEnv("/pr-hero review");
    delete env.EVENT_COMMENT_ID;
    const run = runShell(env, routed(ok("write\n"), ok(`${HEAD_SHA}\n`)));
    expect(reactionCalls(run)).toEqual([]);
  });

  test("a pull_request event never reacts, even with an id", () => {
    const run = runShell(baseEnv({ EVENT_COMMENT_ID: COMMENT_ID }));
    expect(run.exitCode).toBe(0);
    expect(run.ghCalls).toEqual([]);
  });

  test("an unverifiable lookup gets no reaction: its error comment explains it", () => {
    const run = runShell(commentEnv("/pr-hero review"), () => {
      throw new Error("spawn gh ENOENT");
    });
    expect(run.exitCode).toBe(1);
    expect(reactionCalls(run)).toEqual([]);
  });

  test("a failed reaction prints one warning, and the accepted review keeps its decision and exit", () => {
    const run = runShell(
      commentEnv("/pr-hero review"),
      routed(ok("write\n"), ok(`${HEAD_SHA}\n`), REACTION_FAILED),
    );
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toMatchObject({
      run: "true",
      pr: "21",
      head_sha: HEAD_SHA,
    });
    expect(warningLines(run.stdout)).toHaveLength(1);
  });

  test("a failed reaction on a refused command keeps the refusal and its notice", () => {
    const run = runShell(
      commentEnv("/pr-hero review"),
      routed(ok("read\n"), ok(`${HEAD_SHA}\n`), REACTION_FAILED),
    );
    expect(run.exitCode).toBe(0);
    expect(run.outputs.run).toBe("false");
    expect(run.stdout).toStartWith("::notice title=pr-hero::");
    expect(warningLines(run.stdout)).toHaveLength(1);
  });

  test("a failed reaction on a no-credentials comment keeps its red exit", () => {
    const run = runShell(
      commentEnv("/pr-hero review", { HAS_CLAUDE_TOKEN: "false" }),
      routed(ok("write\n"), ok(`${HEAD_SHA}\n`), REACTION_FAILED),
    );
    expect(run.exitCode).toBe(1);
    expect(warningLines(run.stdout)).toHaveLength(1);
  });
});

describe("the no-credentials head lookup (T2e)", () => {
  test("a first failed head lookup is retried once, and the second answer is recorded", () => {
    let heads = 0;
    const answer: Answer = (args) => {
      if (args.includes("POST")) return ok("{}");
      if (args[0] === "api") return ok("write\n");
      heads += 1;
      return heads === 1
        ? { exitCode: 1, stdout: "", stderr: "gh: i/o timeout" }
        : ok(`${HEAD_SHA}\n`);
    };
    const run = outcomeRun(
      commentEnv("/pr-hero review", { HAS_CLAUDE_TOKEN: "false" }),
      answer,
    );
    expect(run.exitCode).toBe(1);
    expect(heads).toBe(2);
    expect(run.sleeps).toHaveLength(1);
    expect(run.record).toMatchObject({
      decision: "no-credentials",
      head_sha: HEAD_SHA,
    });
  });

  test("two failed head lookups leave the head unknown, after exactly one retry", () => {
    let heads = 0;
    const answer: Answer = (args) => {
      if (args.includes("POST")) return ok("{}");
      if (args[0] === "api") return ok("write\n");
      heads += 1;
      return { exitCode: 1, stdout: "", stderr: "gh: i/o timeout" };
    };
    const run = runShell(
      commentEnv("/pr-hero review", { HAS_CLAUDE_TOKEN: "false" }),
      answer,
    );
    expect(run.exitCode).toBe(1);
    expect(run.outputs.head_sha).toBe("");
    expect(heads).toBe(2);
    expect(run.sleeps).toHaveLength(1);
  });

  test("a pull_request without a head sha does not retry its lookup", () => {
    let heads = 0;
    const run = runShell(
      baseEnv({ HAS_CLAUDE_TOKEN: "false", EVENT_PR_HEAD_SHA: "" }),
      () => {
        heads += 1;
        return { exitCode: 1, stdout: "", stderr: "gh: i/o timeout" };
      },
    );
    expect(heads).toBe(1);
    expect(run.sleeps).toEqual([]);
  });
});

// `/pr-hero recheck` is `/pr-hero review` plus the CI adjudicator: the same
// permission check, the same reaction and the same forced review of the head,
// with `adjudicate` set. A fork is refused, because the adjudicator needs this
// repository's checkout of the head.
describe("decideCiTrigger — /pr-hero recheck", () => {
  test("from a writer it reviews with force and adjudicate, like the review command", () => {
    expect(decideCiTrigger(comment(RECHECK_COMMAND))).toEqual({
      kind: "review",
      force: true,
      full: false,
      adjudicate: true,
    });
    expect(decideCiTrigger(comment(`  ${RECHECK_COMMAND}\n`))).toEqual({
      kind: "review",
      force: true,
      full: false,
      adjudicate: true,
    });
  });

  test("from a read-only user it is refused like the review command", () => {
    const decision = decideCiTrigger(
      comment(RECHECK_COMMAND, {
        commenterPermission: { kind: "resolved", permission: "read" },
      }),
    );
    expect(decision.kind).toBe("denied");
    const review = decideCiTrigger(
      comment(REVIEW_COMMAND, {
        commenterPermission: { kind: "resolved", permission: "read" },
      }),
    );
    expect(review.kind).toBe("denied");
  });

  test("the permission is needed for the exact recheck command only", () => {
    expect(commenterPermissionNeeded(comment(RECHECK_COMMAND))).toBe(true);
    expect(commenterPermissionNeeded(comment("/pr-hero recheck please"))).toBe(
      false,
    );
  });

  test.each([
    "/pr-hero recheck please",
    "/pr-hero recheck --full",
    "/pr-hero rechecking",
  ])("a near miss is ignored and flagged: %j", (body) => {
    expect(decideCiTrigger(comment(body))).toEqual({
      kind: "ignore",
      reason: expect.any(String),
      nearMiss: true,
    });
  });

  test("the rejection lists /pr-hero recheck among the valid commands", () => {
    const decision = decideCiTrigger(comment("/pr-hero recheck please"));
    expect((decision as { reason: string }).reason).toContain(RECHECK_COMMAND);
  });

  test("the review command keeps adjudicate false", () => {
    expect(decideCiTrigger(comment(REVIEW_COMMAND))).toMatchObject({
      adjudicate: false,
    });
    expect(parseReviewCommand(REVIEW_COMMAND)).toEqual({
      full: false,
      adjudicate: false,
    });
    expect(parseReviewCommand(RECHECK_COMMAND)).toEqual({
      full: false,
      adjudicate: true,
    });
  });
});

describe("runCiTrigger — /pr-hero recheck", () => {
  // The recheck looks the head up twice: the fork answer, then the bare sha a review reads.
  const recheckGh =
    (head: string) =>
    (args: readonly string[]): GhResult =>
      args[0] === "api"
        ? ok("write\n")
        : args.some((arg) => arg.includes("isCrossRepository"))
          ? overrideHead(head, false)
          : ok(`${head}\n`);
  const RECHECK_FORK_REFUSAL =
    "/pr-hero recheck cannot run on a fork pull request: the adjudicator needs this repository's checkout of the head";

  test("a writer's recheck reviews the head with adjudicate true and force", () => {
    const run = outcomeRun(commentEnv(RECHECK_COMMAND), recheckGh(OTHER_SHA));
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toMatchObject({
      run: "true",
      force: "true",
      full: "false",
      adjudicate: "true",
      pr: "21",
      head_sha: OTHER_SHA,
      publish: "true",
    });
  });

  test("the review command's outputs carry adjudicate false", () => {
    const run = outcomeRun(
      commentEnv(REVIEW_COMMAND),
      scriptedGh(ok("write\n"), ok(`${OTHER_SHA}\n`)),
    );
    expect(run.outputs).toMatchObject({ adjudicate: "false" });
  });

  test("a recheck on a fork pull request is refused with the reason, a 👎 and no review", () => {
    const run = outcomeRun(
      commentEnv(RECHECK_COMMAND),
      scriptedGh(ok("write"), overrideHead(HEAD_SHA, true)),
    );
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toMatchObject({
      run: "false",
      publish: "false",
      head_sha: "",
    });
    expect(run.stdout).toContain(RECHECK_FORK_REFUSAL);
    expect(run.ghCalls).toContainEqual(reactionArgv("-1"));
  });

  test("a recheck whose lookup cannot tell a fork is refused too", () => {
    const run = outcomeRun(
      commentEnv(RECHECK_COMMAND),
      scriptedGh(ok("write"), ok("not json")),
    );
    expect(run.outputs).toMatchObject({ run: "false", publish: "false" });
    expect(run.stdout).toContain("/pr-hero recheck could not confirm");
    expect(run.ghCalls).toContainEqual(reactionArgv("-1"));
  });
});
