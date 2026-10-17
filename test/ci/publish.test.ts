// The outcome publisher (odd/tasks/agent-first-ci.md, T2b / S3, T2c). It speaks
// for the outcomes that happen BEFORE the CLI step starts: no credential, an
// unresolved PR, an unverifiable commenter permission, and an install step
// that failed. Once the CLI started, its cli.json decides: a reviewed run cleans
// up, and an error, a hunters-failed run or a progress record with no outcome is
// published. A run with no record took no lock, so it gets its comment alone.
// decidePublication is the pure table; runPublish is the shell.
//
// The builtins-only guard at the bottom mirrors the one in outcome.test.ts. The
// allowed relative imports are "./outcome" and "./override": both are builtins-only
// at runtime (outcome's repo imports are `import type`, erased at transpile; override
// imports nothing), and they need no node_modules, which is the only thing this step
// cannot have.

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
import { classifyCliError } from "#ci/classify-error";
import { PENDING_POSTING_PREFIX, writeFatalCliRecord } from "#ci/cli-record";
import {
  CLI_RECORD_FILE,
  type CliRecord,
  PENDING_AT_FILE,
  parseCliRecord,
  type TriggerRecord,
} from "#ci/outcome";
import {
  CANCELLED_STATUS_DESCRIPTION,
  decideCancelSettle,
  decidePublication,
  PENDING_POSTING_MARK,
  runCancelSettle,
  runPublish,
} from "#ci/publish";
import { CliError } from "../../src/errors";
import type { TransportFailureCause } from "../../src/execution/contracts";

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

    // WHY the status rides on the cleanup: the review completed, but the CLI's final
    // status write did not land, and the CLI recorded that status. The publisher posts
    // it on the head that record names (the status's head, not the trigger's), then
    // cleans up as it does for any reviewed record.
    test("a reviewed record with an unsettled status names that status on the record's head, and still cleans up", () => {
      const description = "pr-hero: 2 blocking finding(s) — fix and push";
      expect(
        decidePublication({
          record: record({ head_sha: TRIGGER_HEAD }),
          cliStarted: true,
          cliRecord: {
            ...REVIEWED,
            head_sha: REVIEWED_HEAD,
            unsettled_status: { state: "failure", description },
          },
        }),
      ).toEqual({
        kind: "cleanup",
        repository: REPO,
        pr: 7,
        runId: "4242",
        runAttempt: 1,
        headSha: REVIEWED_HEAD,
        status: {
          state: "failure",
          context: "pr-hero",
          description,
          targetUrl: RUN_URL,
        },
      });
    });

    test("a reviewed record with an unsettled status and no PR still posts the status, and cleans nothing", () => {
      expect(
        decidePublication({
          record: record({ pr: undefined, head_sha: undefined }),
          cliStarted: true,
          cliRecord: {
            ...REVIEWED,
            head_sha: REVIEWED_HEAD,
            unsettled_status: {
              state: "success",
              description: "review complete",
            },
          },
        }),
      ).toEqual({
        kind: "cleanup",
        repository: REPO,
        pr: undefined,
        runId: "4242",
        runAttempt: 1,
        headSha: REVIEWED_HEAD,
        status: {
          state: "success",
          context: "pr-hero",
          description: "review complete",
          targetUrl: RUN_URL,
        },
      });
    });

    // Fix 4: the override cutoff rides on the cleanup beside the status it may guard, so the
    // publisher can judge an override against the cutoff the CLI computed, before it reposts.
    test("a reviewed record's override cutoff rides on the cleanup beside its unsettled status", () => {
      const CUTOFF = Date.parse("2026-10-17T12:00:00Z") - 5_000;
      expect(
        decidePublication({
          record: record(),
          cliStarted: true,
          cliRecord: {
            ...REVIEWED,
            head_sha: REVIEWED_HEAD,
            unsettled_status: {
              state: "success",
              description: "review complete",
            },
            override_cutoff_ms: CUTOFF,
          },
        }),
      ).toMatchObject({
        kind: "cleanup",
        headSha: REVIEWED_HEAD,
        overrideCutoffMs: CUTOFF,
      });
    });

    test("an unsettled status without a head names no status: the cleanup stands as before", () => {
      // toEqual, not toMatchObject: a key set to undefined must be absent here.
      expect(
        decidePublication({
          record: record(),
          cliStarted: true,
          cliRecord: {
            ...REVIEWED,
            unsettled_status: {
              state: "success",
              description: "review complete",
            },
          },
        }),
      ).toEqual({
        kind: "cleanup",
        repository: REPO,
        pr: 7,
        runId: "4242",
        runAttempt: 1,
      });
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

    test("every failed hunter model_unavailable renders PRH-MODEL-UNAVAILABLE with the provider and model", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: {
          v: 1,
          outcome: "hunters-failed",
          head_sha: REVIEWED_HEAD,
          hunter_failures: [
            {
              cause: "model_unavailable",
              provider: "opencode",
              model: "gpt-4o",
            },
            {
              cause: "model_unavailable",
              provider: "opencode",
              model: "gpt-4o",
            },
          ],
        },
      });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.rendered.code).toBe("PRH-MODEL-UNAVAILABLE");
      expect(plan.rendered.annotation).toContain("Provider opencode: ");
      expect(plan.rendered.annotation).toContain("gpt-4o");
      expect(plan.status?.description).toStartWith("PRH-MODEL-UNAVAILABLE: ");
    });

    test("every failed hunter with a missing provider record renders PRH-CRED-UNUSABLE, owned by the configuration", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: {
          v: 1,
          outcome: "hunters-failed",
          head_sha: REVIEWED_HEAD,
          hunter_failures: [
            {
              cause: "missing_provider_record",
              provider: "opencode",
              model: "no-such-model-free",
            },
            {
              cause: "missing_provider_record",
              provider: "opencode",
              model: "no-such-model-free",
            },
          ],
        },
      });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.rendered.code).toBe("PRH-CRED-UNUSABLE");
      expect(plan.rendered.owner).toBe("config");
      expect(plan.rendered.annotation).toContain("Your configuration: ");
      expect(plan.rendered.annotation).toContain(
        "route opencode/no-such-model-free has no usable credential record",
      );
      expect(plan.status?.description).toStartWith("PRH-CRED-UNUSABLE: ");
    });

    test("a missing provider record with no provider or model falls back to PRH-HUNTERS-FAILED, with no placeholder", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: {
          v: 1,
          outcome: "hunters-failed",
          hunter_failures: [{ cause: "missing_provider_record" }],
        },
      });
      if (plan.kind !== "remote") throw new Error("expected a remote plan");
      // WHY the fallback: the credential sentence names the backend, provider and step, and
      // this path knows none of them, so its own rendering would ship "<backend>/<provider>".
      expect(plan.rendered.code).toBe("PRH-HUNTERS-FAILED");
      expect(plan.rendered.annotation).not.toMatch(/<[a-z][a-z-]*>/);
    });

    test("a mix of a missing provider record and model_unavailable stays PRH-HUNTERS-FAILED", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: {
          v: 1,
          outcome: "hunters-failed",
          hunter_failures: [
            { cause: "missing_provider_record", provider: "opencode" },
            { cause: "model_unavailable", provider: "opencode" },
          ],
        },
      });
      if (plan.kind !== "remote") throw new Error("expected a remote plan");
      expect(plan.rendered.code).toBe("PRH-HUNTERS-FAILED");
    });

    test("every failed hunter with an unclassified runtime cause stays PRH-HUNTERS-FAILED", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: {
          v: 1,
          outcome: "hunters-failed",
          hunter_failures: [
            { cause: "runtime_unavailable", provider: "opencode" },
            { cause: "runtime_unavailable", provider: "opencode" },
          ],
        },
      });
      if (plan.kind !== "remote") throw new Error("expected a remote plan");
      expect(plan.rendered.code).toBe("PRH-HUNTERS-FAILED");
    });

    test("a model_unavailable with no provider or model falls back to PRH-HUNTERS-FAILED, since its fix names the provider", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: {
          v: 1,
          outcome: "hunters-failed",
          hunter_failures: [{ cause: "model_unavailable" }],
        },
      });
      if (plan.kind !== "remote") throw new Error("expected a remote plan");
      // WHY the fallback: "$ opencode models {provider}" and "a model that {provider} serves"
      // would name "<provider>" without a provider.
      expect(plan.rendered.code).toBe("PRH-HUNTERS-FAILED");
      expect(plan.rendered.annotation).not.toMatch(/<[a-z][a-z-]*>/);
    });

    test("a mix of model_unavailable and another cause stays PRH-HUNTERS-FAILED", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: {
          v: 1,
          outcome: "hunters-failed",
          hunter_failures: [
            { cause: "model_unavailable", provider: "opencode" },
            { cause: "network_transient", provider: "opencode" },
          ],
        },
      });
      if (plan.kind !== "remote") throw new Error("expected a remote plan");
      expect(plan.rendered.code).toBe("PRH-HUNTERS-FAILED");
    });

    test("an entry with no cause keeps PRH-HUNTERS-FAILED even beside model_unavailable entries", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: {
          v: 1,
          outcome: "hunters-failed",
          hunter_failures: [{ cause: "model_unavailable" }, {}],
        },
      });
      if (plan.kind !== "remote") throw new Error("expected a remote plan");
      expect(plan.rendered.code).toBe("PRH-HUNTERS-FAILED");
    });

    test("a record without the new fields renders PRH-HUNTERS-FAILED, unchanged", () => {
      const plan = decidePublication({
        record: record(),
        cliStarted: true,
        cliRecord: { v: 1, outcome: "hunters-failed" },
      });
      if (plan.kind !== "remote") throw new Error("expected a remote plan");
      expect(plan.rendered.code).toBe("PRH-HUNTERS-FAILED");
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

    // T2d-1 (S2), end to end: the CLI's fatal writer leaves cli.json, the publisher
    // reads it back, and the config-owned code and its owner lead reach the PR.
    test("a gotchas error written by the CLI renders PRH-GOTCHAS-MISSING under 'Your configuration:'", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "pr-hero-gotchas-e2e-"));
      try {
        const env = { PRHERO_OUTCOME_DIR: dir };
        writeFatalCliRecord(
          classifyCliError(
            new CliError("gotchas file is still the scaffold", {
              cls: { kind: "gotchas", reason: "placeholder" },
            }),
          ),
          env,
        );
        const cliRecord = parseCliRecord(
          readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8"),
        );
        const plan = decidePublication({
          record: record(),
          cliStarted: true,
          cliRecord,
        });
        expect(plan.kind).toBe("remote");
        if (plan.kind !== "remote") return;
        expect(plan.rendered.code).toBe("PRH-GOTCHAS-MISSING");
        expect(plan.rendered.owner).toBe("config");
        expect(plan.rendered.summary.join("\n")).toContain(
          "Your configuration: .prhero/gotchas.md is missing or still the scaffold",
        );
        expect(plan.status?.state).toBe("error");
        expect(plan.status?.description).toStartWith("PRH-GOTCHAS-MISSING");
        expect(plan.headSha).toBe(SHA);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
    // WHY the progress record scopes the lock (F001 and F002 on #330): a reviewing
    // record says this run took the pending lock on its own head, so the status
    // the publisher reads and replaces is that head's, never the trigger's. A
    // settled status means the CLI finished, so the publisher never overrides it (F004).
    // CHANGED: this case used to be a run with no record at all. A no-record run
    // took no lock, so it now gets the comment alone (see the test.each below).
    test("a reviewing record whose head's pr-hero status is still pending replaces the lock on the record's head: PRH-UNCLASSIFIED as the status and the comment", () => {
      const plan = decidePublication({
        record: record({ head_sha: TRIGGER_HEAD }),
        cliStarted: true,
        cliRecord: { v: 1, outcome: "reviewing", head_sha: REVIEWED_HEAD },
        latestStatusState: "pending",
      });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.rendered.code).toBe("PRH-UNCLASSIFIED");
      expect(plan.rendered.owner).toBe("unclassified");
      expect(plan.rendered.annotation).toContain(
        "pr-hero stopped at the review before it reported an outcome and could not tell why",
      );
      expect(plan.headSha).toBe(REVIEWED_HEAD);
      expect(plan.status?.state).toBe("error");
      expect(plan.status?.context).toBe("pr-hero");
      expect(plan.status?.targetUrl).toBe(RUN_URL);
      expect(plan.status?.description.startsWith("PRH-UNCLASSIFIED: ")).toBe(
        true,
      );
      expect(plan.commentBody.split("\n")[0]).toBe(
        `<!-- pr-hero-outcome v=1 head=${REVIEWED_HEAD} run=4242 attempt=1 -->`,
      );
    });

    // CHANGED (F001 on #330): the same scoping as the pending case above. The
    // lock is this run's own, so a visible red is recoverable and the record's
    // head carries it.
    test("a reviewing record whose head's status cannot be read posts the error status on the record's head, and the comment", () => {
      const plan = decidePublication({
        record: record({ head_sha: TRIGGER_HEAD }),
        cliStarted: true,
        cliRecord: { v: 1, outcome: "reviewing", head_sha: REVIEWED_HEAD },
        latestStatusState: "unknown",
      });
      expect(plan.kind).toBe("remote");
      if (plan.kind !== "remote") return;
      expect(plan.rendered.code).toBe("PRH-UNCLASSIFIED");
      expect(plan.headSha).toBe(REVIEWED_HEAD);
      expect(plan.status?.state).toBe("error");
      expect(plan.commentBody.split("\n")[0]).toBe(
        `<!-- pr-hero-outcome v=1 head=${REVIEWED_HEAD} run=4242 attempt=1 -->`,
      );
    });

    test("a reviewing record whose head's pr-hero status settled posts its comment only: the CLI's status stands", () => {
      const plan = decidePublication({
        record: record({ head_sha: TRIGGER_HEAD }),
        cliStarted: true,
        cliRecord: { v: 1, outcome: "reviewing", head_sha: REVIEWED_HEAD },
        latestStatusState: "settled",
      });
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

    // CHANGED (F001 and F002 on #330): with no progress record this run took no
    // lock, so neither the status read nor the trigger's head can decide anything.
    // Every case is the comment alone, with no status, whatever the trigger holds.
    test.each(["pending", "settled", "unknown"] as const)(
      "a no-record run posts its comment alone, whatever the status read and whatever head the trigger holds (%s)",
      (latestStatusState) => {
        const plan = decidePublication({
          record: record({ head_sha: TRIGGER_HEAD }),
          cliStarted: true,
          latestStatusState,
        });
        expect(plan.kind).toBe("remote");
        if (plan.kind !== "remote") return;
        expect(plan.rendered.code).toBe("PRH-UNCLASSIFIED");
        expect(plan.headSha).toBeUndefined();
        expect(plan.status).toBeUndefined();
      },
    );

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

// One JSON array per status of the head, as the status read's --jq filter
// prints them: [context, state, created_at].
function statusRows(...rows: Array<[string, string, string]>): GhResult {
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
  // The answer to the head's combined-status read, printed one row per status
  // as the --jq filter does. Unset, the read fails.
  latestStatus?: GhResult;
  env?: Record<string, string>;
  // The publisher's clock. Unset, the real one: only a test that reads the time
  // back needs it pinned.
  now?: () => Date;
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
        // The publisher reads a commit status in one case only: a progress record
        // (reviewing) on the head it names (decideCliOutcome). Every other read is
        // a regression, and the tests assert which calls route here.
        if (endpoint.includes("/commits/")) {
          return options.latestStatus ?? fail("gh: status read not answered");
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
      ...(options.now === undefined ? {} : { now: options.now }),
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

  // WHY no status (F001 and F002 on #330): a run with no progress record took no
  // lock, so the publisher writes no status on any head. A status here would turn
  // a skipped or yielded run red, or overwrite another process's live lock.
  // CHANGED (F001 on #330): this test used to read the trigger's head and post the
  // error status. With no record it now posts the comment alone, and reads nothing.
  test("with no CLI record, the run posts its comment alone: no status read and no status write, even with a pending status on the trigger's head", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      latestStatus: statusRows(["pr-hero", "pending", "2026-10-16T10:00:00Z"]),
      list: listing(),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("::error title=pr-hero PRH-UNCLASSIFIED::");
    expect(run.stdout).toContain(
      "pr-hero stopped at the review before it reported an outcome",
    );
    expect(run.summary).toContain("### PRH-UNCLASSIFIED");
    expect(statusReadEndpoints(run.calls)).toEqual([]);
    expect(statusCalls(run.calls)).toEqual([]);
    expect(commentPost(run.calls)?.args).toContain(
      `repos/${REPO}/issues/7/comments`,
    );
  });

  // WHY the progress record is the only status read (F001 and F002 on #330): the
  // admission gate yields to a pending status for 90 minutes, so a killed CLI's
  // lock is replaced here. One read, on the head the record names, and no other.
  test("a reviewing record with a pending pr-hero status on its head reads that head once, replaces it with an error status on that head, then posts the comment", () => {
    const run = runPublishIn({
      record: record({ head_sha: TRIGGER_HEAD }),
      cliStarted: true,
      cliRecord: { v: 1, outcome: "reviewing", head_sha: REVIEWED_HEAD },
      latestStatus: statusRows(["pr-hero", "pending", "2026-10-16T10:00:00Z"]),
      list: listing(),
    });
    expect(run.exitCode).toBe(0);
    expect(statusReadEndpoints(run.calls)).toEqual([
      `repos/${REPO}/commits/${REVIEWED_HEAD}/status?per_page=100`,
    ]);
    const statuses = statusCalls(run.calls);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.args).toContain(
      `repos/${REPO}/statuses/${REVIEWED_HEAD}`,
    );
    expect(statuses[0]?.args).toContain("state=error");
    expect(statuses[0]?.args).toContain("context=pr-hero");
    const comment = commentPost(run.calls);
    expect(comment?.args).toContain(`repos/${REPO}/issues/7/comments`);
    expect(comment?.stdin).toContain(`head=${REVIEWED_HEAD} run=4242`);
    expect(run.calls.indexOf(statuses[0] as Call)).toBeLessThan(
      run.calls.indexOf(comment as Call),
    );
  });

  test.each([
    ["success", "success"],
    ["error", "error"],
    ["failure", "failure"],
  ])(
    "a reviewing record whose record head's pr-hero status is %s reads that head once and posts the comment alone",
    (_label, state) => {
      const run = runPublishIn({
        record: record({ head_sha: TRIGGER_HEAD }),
        cliStarted: true,
        cliRecord: { v: 1, outcome: "reviewing", head_sha: REVIEWED_HEAD },
        latestStatus: statusRows(["pr-hero", state, "2026-10-16T10:00:00Z"]),
        list: listing(),
      });
      expect(run.exitCode).toBe(0);
      expect(statusReadEndpoints(run.calls)).toEqual([
        `repos/${REPO}/commits/${REVIEWED_HEAD}/status?per_page=100`,
      ]);
      expect(statusCalls(run.calls)).toEqual([]);
      expect(commentPost(run.calls)?.args).toContain(
        `repos/${REPO}/issues/7/comments`,
      );
    },
  );

  test("a reviewing record whose status read fails posts the error status on the record's head, and the comment", () => {
    const run = runPublishIn({
      record: record({ head_sha: TRIGGER_HEAD }),
      cliStarted: true,
      cliRecord: { v: 1, outcome: "reviewing", head_sha: REVIEWED_HEAD },
      latestStatus: fail("gh: HTTP 502"),
      list: listing(),
    });
    expect(run.exitCode).toBe(0);
    expect(statusReadEndpoints(run.calls)).toEqual([
      `repos/${REPO}/commits/${REVIEWED_HEAD}/status?per_page=100`,
    ]);
    const statuses = statusCalls(run.calls);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.args).toContain(
      `repos/${REPO}/statuses/${REVIEWED_HEAD}`,
    );
    expect(statuses[0]?.args).toContain("state=error");
    expect(commentPost(run.calls)).toBeDefined();
  });

  // CHANGED (F002 on #330): the record's head is the only one the lock is on, so
  // a trigger that recorded no head does not stop the lock from being replaced.
  test("a reviewing record whose trigger recorded no head still reads and replaces the lock on the record's head", () => {
    const run = runPublishIn({
      record: record({ head_sha: undefined }),
      cliStarted: true,
      cliRecord: { v: 1, outcome: "reviewing", head_sha: REVIEWED_HEAD },
      latestStatus: statusRows(["pr-hero", "pending", "2026-10-16T10:00:00Z"]),
      list: listing(),
    });
    expect(run.exitCode).toBe(0);
    expect(statusReadEndpoints(run.calls)).toEqual([
      `repos/${REPO}/commits/${REVIEWED_HEAD}/status?per_page=100`,
    ]);
    expect(statusCalls(run.calls)[0]?.args).toContain(
      `repos/${REPO}/statuses/${REVIEWED_HEAD}`,
    );
    expect(commentPost(run.calls)).toBeDefined();
  });

  test.each([
    ["an error", { v: 1, outcome: "error", cls: { kind: "unknown" } }],
    ["hunters-failed", { v: 1, outcome: "hunters-failed", head_sha: SHA }],
    ["skipped", { v: 1, outcome: "skipped", skip: "size" }],
    ["yielded", { v: 1, outcome: "yielded" }],
  ])(
    "a CLI record that is %s reads no commit status, whatever the head holds",
    (_label, cliRecord) => {
      const run = runPublishIn({
        record: record(),
        cliStarted: true,
        cliRecord,
        latestStatus: statusRows([
          "pr-hero",
          "pending",
          "2026-10-16T10:00:00Z",
        ]),
        list: listing(),
      });
      expect(statusReadEndpoints(run.calls)).toEqual([]);
    },
  );

  test("a run that never started the CLI reads no commit status", () => {
    const run = runPublishIn({
      record: record(),
      latestStatus: statusRows(["pr-hero", "pending", "2026-10-16T10:00:00Z"]),
    });
    expect(statusReadEndpoints(run.calls)).toEqual([]);
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
      // CHANGED (F001 and F002 on #330): an unreadable cli.json is the same as a
      // missing one, and a missing one has no progress record, so the publisher
      // cannot tell whose lock a head holds. It posts the comment alone: no status
      // read and no status write, on any head. It used to read the trigger's head
      // and post the error status there.
      expect(statusReadEndpoints(run.calls)).toEqual([]);
      expect(statusCalls(run.calls)).toEqual([]);
      expect(commentPost(run.calls)).toBeDefined();
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

  // The `-f key=value` flags of a status write, read back as an object.
  function statusFlags(args: readonly string[]): Record<string, string> {
    const flags: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== "-f") continue;
      const raw = args[i + 1] ?? "";
      const eq = raw.indexOf("=");
      if (eq !== -1) flags[raw.slice(0, eq)] = raw.slice(eq + 1);
    }
    return flags;
  }

  // WHY this post: the CLI's review completed, but its final status write did not land,
  // and the CLI recorded that status. The publisher posts it once, on the head the record
  // names, before the cleanup of older comments.
  test("a reviewed record with an unsettled status posts that state and description on pr-hero for the record's head, then cleans up", () => {
    const run = runPublishIn({
      record: record({ head_sha: TRIGGER_HEAD }),
      cliStarted: true,
      cliRecord: {
        ...REVIEWED,
        head_sha: REVIEWED_HEAD,
        unsettled_status: { state: "success", description: "review complete" },
      },
      status: [ok()],
      viewer: ok("pr-hero-bot"),
      list: listing([10, "pr-hero-bot", "Bot", OLDER_MARKER]),
    });
    expect(run.exitCode).toBe(0);
    const posted = statusCalls(run.calls);
    expect(posted).toHaveLength(1);
    const status = posted[0] as Call;
    expect(status.args).toContain(`repos/${REPO}/statuses/${REVIEWED_HEAD}`);
    expect(statusFlags(status.args)).toEqual({
      state: "success",
      context: "pr-hero",
      description: "review complete",
      target_url: RUN_URL,
    });
    const firstDeletion = run.calls.findIndex((call) =>
      call.args.includes("DELETE"),
    );
    expect(run.calls.indexOf(status)).toBeLessThan(firstDeletion);
    expect(removedIds(run)).toEqual(["10"]);
  });

  // WHY one attempt: the teardown already retried the write twice, so the publisher's
  // one more chance is one call. A failure is named as the status write failure, on one
  // annotation line, and the cleanup still runs.
  test("a failed unsettled status is one attempt, names PRH-STATUS-WRITE-FAILED on one line, still cleans up, and exits 1", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliRecord: {
        ...REVIEWED,
        head_sha: REVIEWED_HEAD,
        unsettled_status: {
          state: "failure",
          description: "pr-hero: 2 blocking finding(s) — fix and push",
        },
      },
      status: [fail("gh: Server Error (HTTP 500)")],
      viewer: ok("pr-hero-bot"),
      list: listing([10, "pr-hero-bot", "Bot", OLDER_MARKER]),
    });
    expect(statusCalls(run.calls)).toHaveLength(1);
    const annotations = run.stdout
      .split("\n")
      .filter((line) => line.startsWith("::error"));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toContain("PRH-STATUS-WRITE-FAILED");
    expect(removedIds(run)).toEqual(["10"]);
    expect(run.exitCode).toBe(1);
  });
});

// Fix 4: the CLI's final status write failed, so its own status reads may have failed too, and
// an override posted during the run may not have been seen by the CLI. Before the repost, the
// publisher reads the head once and skips the repost when the override rule (src/ci/override.ts)
// says an override stands, against the cutoff the CLI recorded. A failed read reposts, as
// before, and so does a record with no cutoff.
describe("runPublish — the repost of an unsettled status, against an override (Fix 4)", () => {
  const RUN_START = Date.parse("2026-10-17T12:00:00Z");
  const OVERRIDE =
    "pr-hero: overridden by @maintainer — no review on this head";
  const UNSETTLED = { state: "success", description: "review complete" };
  const at = (ms: number) => new Date(ms).toISOString();
  // One row per status of the head, as the status read's --jq filter prints them with the
  // description: [context, state, created_at, description].
  const describedStatusRows = (
    ...rows: Array<[string, string, string, string]>
  ): GhResult => ok(rows.map((row) => JSON.stringify(row)).join("\n"));
  // The record as the CLI wrote it. The default cutoff is the run's start, which is the record
  // the CLI writes when its own pending did not land (no clock-skew allowance).
  const withCutoff = (cutoffMs: number = RUN_START, extra: object = {}) => ({
    ...REVIEWED,
    head_sha: REVIEWED_HEAD,
    unsettled_status: UNSETTLED,
    override_cutoff_ms: cutoffMs,
    ...extra,
  });
  const runWith = (cliRecord: object, latestStatus: GhResult | undefined) =>
    runPublishIn({
      record: record({ head_sha: TRIGGER_HEAD }),
      cliStarted: true,
      cliRecord,
      status: [ok()],
      viewer: ok("pr-hero-bot"),
      list: listing([10, "pr-hero-bot", "Bot", OLDER_MARKER]),
      ...(latestStatus === undefined ? {} : { latestStatus }),
    });
  const HEAD_READ = `repos/${REPO}/commits/${REVIEWED_HEAD}/status?per_page=100`;

  test("a fresh override as the newest status: the repost is skipped, the head is read once, and the cleanup still runs", () => {
    const run = runWith(
      withCutoff(),
      describedStatusRows([
        "pr-hero",
        "success",
        at(RUN_START + 30_000),
        OVERRIDE,
      ]),
    );
    expect(run.exitCode).toBe(0);
    expect(statusReadEndpoints(run.calls)).toEqual([HEAD_READ]);
    expect(statusCalls(run.calls)).toEqual([]);
    expect(deletions(run.calls)).toEqual([`repos/${REPO}/issues/comments/10`]);
  });

  test("a newest status that is not an override is reposted", () => {
    const run = runWith(
      withCutoff(),
      describedStatusRows([
        "pr-hero",
        "success",
        at(RUN_START + 30_000),
        "review complete",
      ]),
    );
    const posted = statusCalls(run.calls);
    expect(posted).toHaveLength(1);
    expect((posted[0] as Call).args).toEqual(
      expect.arrayContaining(["state=success", "description=review complete"]),
    );
  });

  test("an override older than the run is reposted", () => {
    const run = runWith(
      withCutoff(),
      describedStatusRows([
        "pr-hero",
        "success",
        at(RUN_START - 60_000),
        OVERRIDE,
      ]),
    );
    expect(statusCalls(run.calls)).toHaveLength(1);
  });

  // The pending did not land, so the CLI's cutoff is the run's start with no allowance. An
  // override created 3 s before that start did not stand over the run, and the publisher
  // reposts it. The read is asserted, because a publisher that did not read the head would
  // repost too, and would not be judging the override at all.
  test("the cutoff is the run's start (the pending did not land): an override created 3 s before the start is reposted", () => {
    const run = runWith(
      withCutoff(RUN_START),
      describedStatusRows([
        "pr-hero",
        "success",
        at(RUN_START - 3_000),
        OVERRIDE,
      ]),
    );
    expect(statusReadEndpoints(run.calls)).toEqual([HEAD_READ]);
    expect(statusCalls(run.calls)).toHaveLength(1);
  });

  // The pending landed, so the CLI's cutoff is the start less the 5 s allowance. The same
  // override, created 3 s before the start, is inside it and stands, so the publisher skips.
  // The publisher adds no allowance of its own: this is the cutoff it was given, verbatim.
  test("the cutoff is the start less 5 s (the pending landed): the same override stands and the repost is skipped", () => {
    const run = runWith(
      withCutoff(RUN_START - 5_000),
      describedStatusRows([
        "pr-hero",
        "success",
        at(RUN_START - 3_000),
        OVERRIDE,
      ]),
    );
    expect(statusReadEndpoints(run.calls)).toEqual([HEAD_READ]);
    expect(statusCalls(run.calls)).toEqual([]);
  });

  test("a failed head read reposts, as before", () => {
    const run = runWith(withCutoff(), fail("gh: Server Error (HTTP 500)"));
    expect(statusCalls(run.calls)).toHaveLength(1);
    expect(run.exitCode).toBe(0);
  });

  test("a record without the override cutoff reposts as before, and reads no status", () => {
    const run = runWith(
      { ...REVIEWED, head_sha: REVIEWED_HEAD, unsettled_status: UNSETTLED },
      describedStatusRows([
        "pr-hero",
        "success",
        at(RUN_START + 30_000),
        OVERRIDE,
      ]),
    );
    expect(statusReadEndpoints(run.calls)).toEqual([]);
    expect(statusCalls(run.calls)).toHaveLength(1);
  });
});

// T6 (S8): an override is a human's decision, not an outcome. It posts a success
// status on the head it names and an audit comment. Nothing renders an error, and
// no cleanup may ever remove the comment.
const OVERRIDE_DESCRIPTION =
  "pr-hero: overridden by @maintainer — no review on this head";
const overrideRecord = (overrides: Partial<TriggerRecord> = {}) =>
  record({ decision: "override", actor: "maintainer", ...overrides });

describe("decidePublication — the override (S8)", () => {
  test("an override with a head publishes a success status and the audit comment, never an error", () => {
    const plan = decidePublication({
      record: overrideRecord(),
      cliStarted: false,
    });
    expect(plan).toMatchObject({
      kind: "override",
      repository: REPO,
      pr: 7,
      actor: "maintainer",
      headSha: SHA,
    });
    expect(JSON.stringify(plan)).not.toContain("PRH-");
  });

  test("an override with no head still publishes, with no head to set a status on", () => {
    const plan = decidePublication({
      record: overrideRecord({ head_sha: undefined }),
      cliStarted: false,
    });
    expect(plan).toMatchObject({ kind: "override", headSha: undefined });
  });
});

describe("runPublish — the override (S8)", () => {
  test("a head gets the success status first, then the audit comment with its marker and the actor", () => {
    const run = runPublishIn({
      record: overrideRecord(),
      now: () => new Date("2026-10-17T12:34:56.000Z"),
    });
    expect(run.exitCode).toBe(0);
    const statuses = statusCalls(run.calls);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.args).toContain("state=success");
    expect(statuses[0]?.args).toContain(`description=${OVERRIDE_DESCRIPTION}`);
    const comment = commentPost(run.calls);
    expect(comment).toBeDefined();
    expect(run.calls.indexOf(statuses[0] as Call)).toBeLessThan(
      run.calls.indexOf(comment as Call),
    );
    const body = comment?.stdin ?? "";
    expect(body.split("\n")[0]).toBe(
      `<!-- pr-hero-override head=${SHA} run=4242 attempt=1 -->`,
    );
    expect(body).toContain("@maintainer");
    expect(body).toContain("2026-10-17 12:34 UTC");
    expect(body).toContain(
      "A new push or a later `/pr-hero review` on this head replaces it",
    );
    expect(run.stdout).toContain("::notice title=pr-hero::");
    expect(run.stdout).not.toContain("PRH-INSTALL-FAILED");
  });

  // The longest login the trigger accepts (91 characters) makes the description
  // exactly GitHub's 140-character limit. The whole sentence is posted, unclipped.
  test("a 91-character login's override description is posted whole, within 140 characters", () => {
    const login = "a".repeat(91);
    const run = runPublishIn({
      record: overrideRecord({ actor: login }),
    });
    const statuses = statusCalls(run.calls);
    expect(statuses).toHaveLength(1);
    const descriptionArg = statuses[0]?.args.find((arg) =>
      arg.startsWith("description="),
    );
    const description = descriptionArg?.slice("description=".length) ?? "";
    expect(description.length).toBeLessThanOrEqual(140);
    expect(description).toBe(
      `pr-hero: overridden by @${login} — no review on this head`,
    );
  });

  test("no head posts the comment alone, and says that no status could be set", () => {
    const run = runPublishIn({
      record: overrideRecord({ head_sha: undefined }),
    });
    expect(run.exitCode).toBe(0);
    expect(statusCalls(run.calls)).toHaveLength(0);
    const body = commentPost(run.calls)?.stdin ?? "";
    expect(body.split("\n")[0]).toBe(
      `<!-- pr-hero-override head=unknown run=4242 attempt=1 -->`,
    );
    expect(body).toContain("no commit status could be set");
  });

  test("a failed status write is PRH-STATUS-WRITE-FAILED and exit 1, and the comment then says no status was set", () => {
    const run = runPublishIn({
      record: overrideRecord(),
      status: [fail("gh: HTTP 500"), fail("gh: HTTP 500")],
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("PRH-STATUS-WRITE-FAILED");
    const body = commentPost(run.calls)?.stdin ?? "";
    expect(body).toContain("no commit status could be set");
    expect(body).not.toContain("gate was overridden");
  });

  test("a review's cleanup leaves an override comment alone, even an older one by the same bot", () => {
    const run = runPublishIn({
      record: record(),
      cliStarted: true,
      cliRecord: REVIEWED,
      viewer: ok("github-actions"),
      list: listing(
        [501, "github-actions[bot]", "Bot", OVERRIDE_OLDER_MARKER],
        [502, "github-actions[bot]", "Bot", OLDER_MARKER],
      ),
    });
    expect(run.exitCode).toBe(0);
    expect(deletions(run.calls)).toEqual([
      "repos/acme/widgets/issues/comments/502",
    ]);
  });

  test("a review's comment post never deletes an override comment of the same author", () => {
    const run = runPublishIn({
      record: record(),
      create: ok(JSON.stringify([9000, "bot-a"])),
      list: listing(
        [501, "bot-a", "Bot", OVERRIDE_OLDER_MARKER],
        [502, "bot-a", "Bot", OLDER_MARKER],
      ),
    });
    expect(deletions(run.calls)).toEqual([
      "repos/acme/widgets/issues/comments/502",
    ]);
  });

  // WHY the override settles the head the way a completed review does, so it removes the
  // same older outcome comments. The list also holds an older override audit comment, a
  // newer run's outcome comment and the pr-hero-report summary: only the older outcome goes.
  test("an override whose status write succeeds deletes an older run's outcome comment, and keeps the override audit, the newer outcome and the report summary", () => {
    const run = runPublishIn({
      record: overrideRecord(),
      viewer: ok("github-actions"),
      list: listing(
        [501, "github-actions[bot]", "Bot", OVERRIDE_OLDER_MARKER],
        [502, "github-actions[bot]", "Bot", OLDER_MARKER],
        [503, "github-actions[bot]", "Bot", NEWER_MARKER],
        [504, "github-actions[bot]", "Bot", REPORT_SUMMARY_MARKER],
      ),
    });
    expect(run.exitCode).toBe(0);
    expect(deletions(run.calls)).toEqual([
      "repos/acme/widgets/issues/comments/502",
    ]);
  });

  // WHY nothing is cleaned up when the status write fails: the head is not green, so the
  // outcome comments stay beside the red status. The graphql call is the viewer lookup
  // that starts the cleanup, so its absence proves the cleanup never began.
  test("an override whose status write fails deletes nothing, and never starts the cleanup", () => {
    const run = runPublishIn({
      record: overrideRecord(),
      status: [fail("gh: HTTP 500"), fail("gh: HTTP 500")],
      viewer: ok("github-actions"),
      list: listing([502, "github-actions[bot]", "Bot", OLDER_MARKER]),
    });
    expect(run.exitCode).toBe(1);
    expect(deletions(run.calls)).toEqual([]);
    expect(run.calls.some((call) => call.args.includes("graphql"))).toBe(false);
  });

  test("an override with no head sets no status, so it cleans up nothing", () => {
    const run = runPublishIn({
      record: overrideRecord({ head_sha: undefined }),
      viewer: ok("github-actions"),
      list: listing([502, "github-actions[bot]", "Bot", OLDER_MARKER]),
    });
    expect(run.exitCode).toBe(0);
    expect(deletions(run.calls)).toEqual([]);
  });

  // WHY a warning, not a failure: the override's exit code follows the status write alone,
  // as a completed review's does. The status is set, so the exit stays 0.
  test("a failed delete of an older outcome comment is a warning, and the override still exits 0", () => {
    const run = runPublishIn({
      record: overrideRecord(),
      viewer: ok("github-actions"),
      list: listing([502, "github-actions[bot]", "Bot", OLDER_MARKER]),
      remove: fail("gh: Server Error (HTTP 500)"),
    });
    expect(deletions(run.calls)).toEqual([
      "repos/acme/widgets/issues/comments/502",
    ]);
    expect(run.stdout).toContain("::warning title=pr-hero::");
    expect(run.stdout).toContain("could not delete an older outcome comment");
    expect(run.exitCode).toBe(0);
  });
});

const OVERRIDE_OLDER_MARKER = `<!-- pr-hero-override head=${SHA} run=4000 attempt=1 -->`;
const REPORT_SUMMARY_MARKER = `<!-- pr-hero-report head=${SHA} -->`;

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

  test("it imports only builtins, plus the builtins-only ./outcome and ./override siblings", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    expect(
      runtimeImportViolations(source, ["./outcome", "./override"]),
    ).toEqual([]);
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

// WHY every cause, not a sample: the hunters-failed path renders a shared cause only from
// its allowlist, and any cause outside it falls back to PRH-HUNTERS-FAILED. A placeholder
// (`<secret>`, `<provider>`, `{model}`) in the rendered text would ship to the PR, so the
// check runs over the whole transport vocabulary, with and without the params the path
// may or may not know.
const TRANSPORT_CAUSES: readonly TransportFailureCause[] = [
  "auth_invalid",
  "quota_exhausted",
  "rate_limit",
  "network_transient",
  "protocol_truncation",
  "protocol_mismatch",
  "protocol_overflow",
  "output_limit_exceeded",
  "context_window_exceeded",
  "safety_refusal",
  "provider_configuration_invalid",
  "model_unavailable",
  "missing_provider_record",
  "runtime_unavailable",
  "remote_abort_unconfirmed",
];

const KNOWN_PARAM_SETS: readonly {
  readonly label: string;
  readonly provider?: string;
  readonly model?: string;
}[] = [
  { label: "provider and model", provider: "opencode", model: "gpt-4o" },
  { label: "provider only", provider: "opencode" },
  { label: "no provider and no model" },
];

function hunterFailedPlan(
  cause: TransportFailureCause,
  known: { readonly provider?: string; readonly model?: string },
) {
  return decidePublication({
    record: record(),
    cliStarted: true,
    cliRecord: {
      v: 1,
      outcome: "hunters-failed",
      head_sha: REVIEWED_HEAD,
      hunter_failures: [
        { cause, ...known },
        { cause, ...known },
      ],
    },
  });
}

describe("hunters-failed renders no placeholder for any cause", () => {
  for (const cause of TRANSPORT_CAUSES) {
    for (const known of KNOWN_PARAM_SETS) {
      test(`${cause} with ${known.label}`, () => {
        const plan = hunterFailedPlan(cause, known);
        expect(plan.kind).toBe("remote");
        if (plan.kind !== "remote") return;
        const texts = [
          plan.rendered.annotation,
          plan.rendered.summary.join("\n"),
          plan.rendered.what,
          plan.status?.description ?? "",
          plan.commentBody,
        ];
        for (const text of texts) {
          expect(text).not.toMatch(/<[a-z][a-z-]*>/);
          expect(text).not.toMatch(/[{}]/);
        }
      });
    }
  }
});

describe("hunters-failed allowlist", () => {
  test("auth_invalid is not rendered from its own code, so no secret name is needed", () => {
    const plan = hunterFailedPlan("auth_invalid", {
      provider: "opencode",
      model: "gpt-4o",
    });
    if (plan.kind !== "remote") throw new Error("expected a remote plan");
    expect(plan.rendered.code).toBe("PRH-HUNTERS-FAILED");
    expect(plan.rendered.annotation).not.toContain("rejected the credential");
  });

  test("model_unavailable with a provider renders PRH-MODEL-UNAVAILABLE without a model", () => {
    const plan = hunterFailedPlan("model_unavailable", {
      provider: "opencode",
    });
    if (plan.kind !== "remote") throw new Error("expected a remote plan");
    expect(plan.rendered.code).toBe("PRH-MODEL-UNAVAILABLE");
    expect(plan.rendered.annotation).toContain(
      "The configured model is not served by this provider",
    );
    expect(plan.rendered.annotation).toContain("Provider opencode: ");
  });

  test("missing_provider_record without a model falls back to PRH-HUNTERS-FAILED", () => {
    const plan = hunterFailedPlan("missing_provider_record", {
      provider: "opencode",
    });
    if (plan.kind !== "remote") throw new Error("expected a remote plan");
    expect(plan.rendered.code).toBe("PRH-HUNTERS-FAILED");
  });

  test("missing_provider_record with a model keeps PRH-CRED-UNUSABLE", () => {
    const plan = hunterFailedPlan("missing_provider_record", {
      provider: "opencode",
      model: "gpt-4o",
    });
    if (plan.kind !== "remote") throw new Error("expected a remote plan");
    expect(plan.rendered.code).toBe("PRH-CRED-UNUSABLE");
  });
});

// The head's status read, as the --jq filter prints it: [context, state, created_at, description].
// A failed read and a read with a corrupt row are both failed reads, and neither is an empty answer.
describe("runPublish — the override read before a repost is strict and logged", () => {
  const RUN_START = Date.parse("2026-10-17T12:00:00Z");
  const OVERRIDE =
    "pr-hero: overridden by @maintainer — no review on this head";
  const UNSETTLED = { state: "success", description: "review complete" };
  const overrideRow = JSON.stringify([
    "pr-hero",
    "success",
    new Date(RUN_START + 30_000).toISOString(),
    OVERRIDE,
  ]);
  const withCutoff = {
    ...REVIEWED,
    head_sha: REVIEWED_HEAD,
    unsettled_status: UNSETTLED,
    override_cutoff_ms: RUN_START,
  };
  const runWith = (latestStatus: GhResult) =>
    runPublishIn({
      record: record({ head_sha: TRIGGER_HEAD }),
      cliStarted: true,
      cliRecord: withCutoff,
      status: [ok()],
      viewer: ok("pr-hero-bot"),
      list: listing([10, "pr-hero-bot", "Bot", OLDER_MARKER]),
      latestStatus,
    });

  test("a failed head read reposts the unsettled status, and logs one warning", () => {
    const run = runWith(fail("gh: Server Error (HTTP 500)"));
    expect(statusCalls(run.calls)).toHaveLength(1);
    expect(run.exitCode).toBe(0);
    const warnings = run.stdout
      .split("\n")
      .filter((line) => line.startsWith("::warning"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not read the statuses");
  });

  // A malformed row is skipped and the valid rows decide. The fresh override is a valid row, so it
  // stands: no repost, and no warning, because the head was read.
  test("a malformed row next to a valid fresh override: the override stands, no repost, and no warning", () => {
    const run = runWith(ok(`not a status row\n${overrideRow}`));
    expect(statusCalls(run.calls)).toHaveLength(0);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain("::warning");
    expect(run.stdout).toContain("an override on this head stands");
  });
});

// The reviewing path reads the head's status to decide whether the CLI's lock must be replaced. It
// keeps its previous reading: a malformed row is dropped and the rest is read, so a corrupt row can
// never turn a settled head into an error overwrite. Only a failed gh call reads as unknown.
describe("runPublish — the reviewing path's status read drops a malformed row", () => {
  test("a malformed row next to a settled pr-hero row reads as settled: no status is written on the head", () => {
    const run = runPublishIn({
      record: record({ head_sha: TRIGGER_HEAD }),
      cliStarted: true,
      cliRecord: { v: 1, outcome: "reviewing", head_sha: REVIEWED_HEAD },
      latestStatus: ok(
        `not a status row\n${JSON.stringify(["pr-hero", "success", "2026-10-16T10:00:00Z"])}`,
      ),
      list: listing(),
    });
    expect(run.exitCode).toBe(0);
    expect(statusReadEndpoints(run.calls)).toEqual([
      `repos/${REPO}/commits/${REVIEWED_HEAD}/status?per_page=100`,
    ]);
    expect(statusCalls(run.calls)).toEqual([]);
    expect(commentPost(run.calls)).toBeDefined();
  });
});

// SB3: a review run cancelled mid-review. The settle reads the CLI's reviewing record and
// the head's newest pr-hero status, and settles only this run's own pending.
const CANCEL_HEAD = "f".repeat(40);
const WRITTEN_MS = Date.parse("2026-10-17T10:00:00.000Z");
// A reviewing record on the head, or with no head when `head` is null (an optional
// default would turn an undefined argument into the head).
const reviewingRecord = (head: string | null = CANCEL_HEAD): CliRecord =>
  head === null
    ? { v: 1, outcome: "reviewing" }
    : { v: 1, outcome: "reviewing", head_sha: head };
const pendingAt = (ms: number) => ({
  state: "pending",
  created_at: new Date(ms).toISOString(),
});

// The created_at GitHub returned for this run's own pending, as the CLI recorded it.
const PENDING_ISO = new Date(WRITTEN_MS).toISOString();

describe("decideCancelSettle — the pure table (SB3)", () => {
  test("settles this run's own pending on the head the CLI locked", () => {
    expect(
      decideCancelSettle({
        record: reviewingRecord(),
        latest: pendingAt(WRITTEN_MS),
        pendingAt: PENDING_ISO,
      }),
    ).toEqual({ settle: true, headSha: CANCEL_HEAD });
  });

  // #347 round 1: the CLI rewrites its record just before its final status, so a cancel
  // in that window still holds the lock on the head.
  test.each(["reviewed", "hunters-failed"])(
    "a %s record that names the head still settles this run's pending",
    (outcome) => {
      expect(
        decideCancelSettle({
          record: { v: 1, outcome, head_sha: CANCEL_HEAD } as CliRecord,
          latest: pendingAt(WRITTEN_MS),
          pendingAt: PENDING_ISO,
        }),
      ).toEqual({ settle: true, headSha: CANCEL_HEAD });
    },
  );

  test("no record, or a record that names no head, is no lock in this run", () => {
    for (const record of [undefined, REVIEWED, reviewingRecord(null)]) {
      expect(
        decideCancelSettle({
          record,
          latest: pendingAt(WRITTEN_MS),
          pendingAt: PENDING_ISO,
        }),
      ).toEqual({ settle: false, reason: "no review lock in this run" });
    }
  });

  test("a settled head status, or none, is left alone", () => {
    for (const latest of [
      { state: "success", created_at: PENDING_ISO },
      undefined,
    ]) {
      expect(
        decideCancelSettle({
          record: reviewingRecord(),
          latest,
          pendingAt: PENDING_ISO,
        }),
      ).toEqual({
        settle: false,
        reason: "the head's pr-hero status is not pending",
      });
    }
  });

  // #347 rounds 2-3: another run's pending on the same head (a Force Review beside a push
  // run) is never this run's, however close in time it was posted.
  test("a pending one second away from this run's own is another run's", () => {
    for (const offset of [-1_000, 1_000, 600_000]) {
      expect(
        decideCancelSettle({
          record: reviewingRecord(),
          latest: pendingAt(WRITTEN_MS + offset),
          pendingAt: PENDING_ISO,
        }),
      ).toEqual({
        settle: false,
        reason: "the pending status is not this run's",
      });
    }
  });

  // #347 round 4: the cancel landed inside the POST, before its answer was recorded.
  test("a posting placeholder settles a pending created within seconds of it, not later", () => {
    const placeholder = `${PENDING_POSTING_MARK}${WRITTEN_MS}`;
    expect(
      decideCancelSettle({
        record: reviewingRecord(),
        latest: pendingAt(WRITTEN_MS + 2_000),
        pendingAt: placeholder,
      }),
    ).toEqual({ settle: true, headSha: CANCEL_HEAD });
    for (const offset of [-10_000, 60_000]) {
      expect(
        decideCancelSettle({
          record: reviewingRecord(),
          latest: pendingAt(WRITTEN_MS + offset),
          pendingAt: placeholder,
        }).settle,
      ).toBe(false);
    }
  });

  test("the placeholder mark is the cli-record writer's prefix", () => {
    expect(PENDING_POSTING_MARK).toBe(PENDING_POSTING_PREFIX);
  });

  test("no record of this run's pending (it never landed) settles nothing", () => {
    for (const pending of [undefined, "not a time"]) {
      expect(
        decideCancelSettle({
          record: reviewingRecord(),
          latest: pendingAt(WRITTEN_MS),
          pendingAt: pending,
        }),
      ).toEqual({
        settle: false,
        reason: "the pending status is not this run's",
      });
    }
  });
});

function runCancelSettleIn(options: {
  cliRecord?: object | string;
  statuses?: GhResult;
  post?: GhResult;
}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-cancel-"));
  try {
    if (options.cliRecord !== undefined) {
      // The CLI's record of its own pending, written once the pending landed.
      writeFileSync(path.join(dir, PENDING_AT_FILE), `${PENDING_ISO}\n`);
      writeFileSync(
        path.join(dir, CLI_RECORD_FILE),
        typeof options.cliRecord === "string"
          ? options.cliRecord
          : JSON.stringify(options.cliRecord),
      );
    }
    const calls: Call[] = [];
    let stdout = "";
    const exitCode = runCancelSettle({
      env: {
        PRHERO_OUTCOME_DIR: dir,
        GITHUB_REPOSITORY: REPO,
        GITHUB_RUN_ID: "4242",
        GITHUB_SERVER_URL: "https://github.com",
      },
      gh: (args, stdin) => {
        calls.push({ args: [...args], stdin });
        const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
        if (endpoint.includes("/commits/")) {
          return options.statuses ?? fail("gh: status read not answered");
        }
        if (endpoint.includes("/statuses/")) return options.post ?? ok();
        return fail("gh: unexpected call");
      },
      sleep: () => {},
      stdout: (text) => {
        stdout += text;
      },
      appendSummary: () => {},
    });
    return { exitCode, stdout, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const liveRecordText = JSON.stringify(reviewingRecord());

describe("runCancelSettle — the shell (SB3)", () => {
  test("posts one PRH-CANCELLED error on the locked head for this run's pending", () => {
    const run = runCancelSettleIn({
      cliRecord: liveRecordText,
      statuses: statusRows(["pr-hero", "pending", PENDING_ISO]),
    });
    expect(run.exitCode).toBe(0);
    const posts = statusCalls(run.calls);
    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post?.args).toContain(`repos/${REPO}/statuses/${CANCEL_HEAD}`);
    expect(post?.args).toContain("state=error");
    expect(post?.args).toContain("context=pr-hero");
    expect(post?.args).toContain(`description=${CANCELLED_STATUS_DESCRIPTION}`);
    expect(post?.args).toContain(
      "target_url=https://github.com/acme/widgets/actions/runs/4242",
    );
    expect(run.stdout).toContain("the pr-hero status is now PRH-CANCELLED");
  });

  test("a settled head status gets no write", () => {
    const run = runCancelSettleIn({
      cliRecord: liveRecordText,
      statuses: statusRows(["pr-hero", "success", PENDING_ISO]),
    });
    expect(run.exitCode).toBe(0);
    expect(statusCalls(run.calls)).toHaveLength(0);
    expect(run.stdout).toContain(
      "cancel: nothing to settle (the head's pr-hero status is not pending)",
    );
  });

  test("a run that took no lock reads no status and writes none", () => {
    const run = runCancelSettleIn({
      cliRecord: { v: 1, outcome: "reviewed" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.calls).toHaveLength(0);
    expect(run.stdout).toContain(
      "cancel: nothing to settle (no review lock in this run)",
    );
  });

  test("no cli.json reads no status and writes none", () => {
    const run = runCancelSettleIn({});
    expect(run.exitCode).toBe(0);
    expect(run.calls).toHaveLength(0);
  });

  test("a failed status read warns and exits 0", () => {
    const run = runCancelSettleIn({
      cliRecord: liveRecordText,
      statuses: fail("gh: network"),
    });
    expect(run.exitCode).toBe(0);
    expect(statusCalls(run.calls)).toHaveLength(0);
    expect(run.stdout).toContain("::warning title=pr-hero::");
    expect(run.stdout).toContain(
      "could not read the head's status after the cancel",
    );
  });

  test("a failed status write warns and still exits 0", () => {
    const run = runCancelSettleIn({
      cliRecord: liveRecordText,
      statuses: statusRows(["pr-hero", "pending", PENDING_ISO]),
      post: fail("gh: HTTP 500"),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("::warning title=pr-hero::");
  });
});
