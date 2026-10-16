// The action-side trigger (odd/tasks/agent-first-ci.md, T1/S1): which events
// review, who may ask for one by comment, and what a run with no credential
// does. The consumer workflow's job `if:` pre-filters forks and comments, but
// the action re-decides all of it, so every rule here is pinned on the
// action's own module rather than on the caller's YAML.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CI_REVIEW_COMMENT, CI_REVIEW_FULL_COMMENT } from "#ci/force-comment";
import {
  type CiTriggerDecision,
  type CiTriggerInput,
  type CommenterPermission,
  commenterPermissionNeeded,
  decideCiTrigger,
  type GhResult,
  parseReviewCommand,
  renderNoCredentialsSummary,
  resolvePrNumber,
  runCiTrigger,
} from "#ci/trigger";

const REPO = "acme/widgets";
const MODULE_PATH = path.resolve(import.meta.dir, "../../src/ci/trigger.ts");

const NO_CREDENTIALS = {
  anthropicApiKey: false,
  claudeToken: false,
  opencodeAuth: false,
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
    [
      "pull_request_target from a fork",
      "pull_request_target",
      "stranger/widgets",
    ],
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
    ["the lookup failed", { kind: "unavailable", detail: "HTTP 404" }],
  ])("a permission that was %s is denied", (_label, commenterPermission) => {
    expect(
      decideCiTrigger(comment("/pr-hero review", { commenterPermission })).kind,
    ).toBe("denied");
  });

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

  test.each(["anthropicApiKey", "claudeToken", "opencodeAuth"] as const)(
    "%s alone is enough to review",
    (credential) => {
      expect(
        decideCiTrigger(
          pullRequest({
            credentials: { ...NO_CREDENTIALS, [credential]: true },
          }),
        ).kind,
      ).toBe("review");
    },
  );
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

function runShell(
  env: Record<string, string>,
  answer: (args: readonly string[]) => GhResult = () => ({
    exitCode: 1,
    stdout: "",
    stderr: "gh: not scripted",
  }),
) {
  const ghCalls: string[][] = [];
  let stdout = "";
  let output = "";
  let summary = "";
  const exitCode = runCiTrigger({
    env,
    gh: (args) => {
      ghCalls.push([...args]);
      return answer(args);
    },
    stdout: (text) => {
      stdout += text;
    },
    appendOutput: (text) => {
      output += text;
    },
    appendSummary: (text) => {
      summary += text;
    },
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
  return { exitCode, stdout, output, outputs, summary, ghCalls };
}

const ok = (stdout: string): GhResult => ({ exitCode: 0, stdout, stderr: "" });

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
      // Denied before the head is resolved: one lookup, never the second.
      expect(run.ghCalls.length).toBe(1);
    },
  );

  test("a gh that cannot even start is denied, not a crash", () => {
    const run = runShell(commentEnv("/pr-hero review"), () => {
      throw new Error("spawn gh ENOENT");
    });
    expect(run.exitCode).toBe(0);
    expect(run.outputs.run).toBe("false");
  });

  test("no credential is an error, a summary with the fix, run=false and exit 1", () => {
    const run = runShell(baseEnv({ HAS_CLAUDE_TOKEN: "false" }));
    expect(run.exitCode).toBe(1);
    expect(run.outputs.run).toBe("false");
    expect(run.stdout).toStartWith("::error title=pr-hero::");
    expect(run.summary).toBe(renderNoCredentialsSummary({ runId: "4242" }));
  });

  test("the no-credentials summary names every fix command and both ways to re-run", () => {
    const summary = renderNoCredentialsSummary({ runId: "4242" });
    for (const command of [
      "claude setup-token",
      "gh secret set CLAUDE_CODE_OAUTH_TOKEN",
      "gh secret set ANTHROPIC_API_KEY",
      "gh secret set OPENCODE_AUTH_JSON",
      "gh variable set PRHERO_ROUTING --body '<routing-object-json>'",
      "gh run rerun 4242",
      "/pr-hero review",
    ]) {
      expect(summary).toContain(command);
    }
    // What is wrong names the three inputs that were all empty.
    for (const input of [
      "anthropic-api-key",
      "claude-token",
      "opencode-auth",
    ]) {
      expect(summary).toContain(input);
    }
  });

  test("without a run id the re-run command keeps a placeholder", () => {
    expect(renderNoCredentialsSummary({})).toContain("gh run rerun <run-id>");
  });

  test("a dispatch with no pr-number is the old error and exit 1", () => {
    const run = runShell(
      baseEnv({ EVENT_NAME: "workflow_dispatch", EVENT_PR_NUMBER: "" }),
    );
    expect(run.exitCode).toBe(1);
    expect(run.outputs.run).toBe("false");
    expect(run.stdout).toContain(
      "Could not determine the pull request number from the workflow context. Set the 'pr-number' input explicitly.",
    );
    expect(run.stdout).toStartWith("::error");
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

  test("as a process, no credential exits 1 with the summary written", () => {
    const run = spawnTrigger(baseEnv({ HAS_CLAUDE_TOKEN: "false" }));
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain("run=false\n");
    expect(run.stdout).toContain("::error title=pr-hero::");
    expect(run.summary).toContain("gh secret set CLAUDE_CODE_OAUTH_TOKEN");
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
