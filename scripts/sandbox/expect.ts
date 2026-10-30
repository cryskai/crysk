// What a scenario phase asserts about its observation. Pure: a check reads one
// Observation and says pass or fail with the fact it saw, so every expectation
// is pinned by a fixture and the report can print each one. The S7 invariants
// are not checks here: the runner applies them to every observation itself.

import { canonicalStatusText } from "../../src/brand";
import {
  isRunArtifactName,
  isRunStepName,
  RUN_STEP_NAME,
  runArtifactNames,
} from "./markers";
import {
  COMMENT_RUN_CLOCK_SKEW_MS,
  type CommentFact,
  classifyPath,
  type Observation,
  postedByThisRun,
} from "./observe";
import { PLANTED_SITE } from "./seed";

export type Check =
  // `skipped` accepts any documented skip, `skipped:<reason>`.
  | { kind: "path"; accept: readonly string[] }
  // `lead` (optional) names the owner the outcome's comment must open with.
  | { kind: "outcome"; code: string; lead?: string }
  | { kind: "no-outcome" }
  // T2e: this run posted no outcome comment. Unlike no-outcome it reads the outcomes
  // this run created (postedByThisRun), so an outcome an earlier run left stays out of it.
  | { kind: "no-own-outcome" }
  // `descriptionContains` (optional) is a substring the description must carry, for a text
  // whose count or sha varies (the carried and unverified texts of budget-exhausted-carry).
  | {
      kind: "status";
      state: string;
      descriptionStartsWith?: string;
      descriptionContains?: string;
    }
  // S4: the head's status is failure when the PR shows a blocking finding
  // comment, and success when it shows none. For a review whose findings vary.
  | { kind: "status-matches-findings" }
  | { kind: "report-min"; min: number }
  | { kind: "no-report" }
  | { kind: "run-completed"; event: string }
  // The review step of the observed run itself succeeded. A report and a status
  // on the head can be left by an earlier run, so this is the run's own evidence.
  | { kind: "step-succeeded" }
  // The run's own evidence for the path it observed. A reviewed path needs the
  // run's own artifact; a skip needs a skip marker the run posted after its trigger.
  // Checks on the head alone cannot tell this run from one that did nothing.
  | { kind: "own-evidence" }
  // S8: the run posted an override comment on the observed head. An override on an
  // earlier head, or one posted before this run's trigger, does not count.
  | { kind: "override-comment" }
  // T2e: the triggering comment carries this reaction. A refused or near-miss comment
  // gets its reaction and no text reply, so the reaction is the only trace it leaves.
  | { kind: "reaction"; content: string }
  // T2e: this run left no review evidence of its own: no `crysk-run-*` (or `pr-hero-run-*`) artifact on
  // this run, and no skip marker it posted after its trigger. A near miss runs nothing,
  // so it leaves neither. WHY not the review step: the composite `Run pr-hero` step has
  // no `if:` and always concludes, so a near miss's step reads success and its
  // conclusion cannot show that no review ran. This is the inverse of own-evidence.
  | { kind: "no-run-evidence" }
  // D3: this head's report carries a state-block row located in `path`.
  // S2: `tier`, when set, makes the row match only with that tier as well as the path.
  | { kind: "state-row-at"; path: string; tier?: "blocking" | "advisory" }
  // SB3: the phase's run concluded this way.
  | { kind: "run-conclusion"; conclusion: string }
  // SB3: the head's pr-hero status exists and is not pending, so a cancelled run leaves no stuck gate.
  | { kind: "status-settled" }
  // T5b: this run posted a CI adjudication reply whose verdict is one of `accept`.
  | { kind: "adjudication-reply"; accept: readonly string[] }
  // The planted bug is reported: a finding on this head is anchored in PLANTED_SITE.
  | { kind: "finding-at-planted-site" }
  // No hunter failed in the observed run, read from its log. A failed hunter is the
  // free model's flake, so the failure carries that cause and a re-run may clear it.
  | { kind: "no-hunter-failed" }
  // The head a rerun did not observe kept its status: its status before the rerun and
  // after it are the same. Reads Observation.newerHead, so it is a single-observation check.
  | { kind: "newer-head-unchanged" }
  // budget-exhausted-carry S10: the PR carries the end-of-budget comment, the manual-required
  // notice that says no more automatic reviews will run (observe.ts END_OF_BUDGET_SENTENCE).
  | { kind: "end-of-budget-comment" };

export interface CheckResult {
  label: string;
  pass: boolean;
  // What was seen, when it was not what the check asked for. A check that names
  // its case on a pass (status-matches-findings) sets it too; the report prints
  // only failed details.
  detail?: string;
  // Set on a failed check whose phase observed `hunters-failed`: the free
  // model's flake, which a re-run is expected to clear.
  cause?: "free-model-hunters-failed";
}

// The label a check is printed under. Exported so the runner can name a check it
// did not assert, in the same words the table would have used.
export function describeCheck(check: Check): string {
  switch (check.kind) {
    case "path":
      return `path is ${check.accept.join(" or ")}`;
    case "outcome":
      return check.lead === undefined
        ? `outcome comment with code ${check.code}`
        : `outcome comment with code ${check.code}, owner lead ${check.lead}`;
    case "no-outcome":
      return "no outcome comment";
    case "no-own-outcome":
      return "this run posted no outcome comment";
    case "status": {
      const parts = [`status is ${check.state}`];
      if (check.descriptionStartsWith !== undefined)
        parts.push(`description starts with ${check.descriptionStartsWith}`);
      if (check.descriptionContains !== undefined)
        parts.push(`description contains ${check.descriptionContains}`);
      return parts.join(", ");
    }
    case "status-matches-findings":
      return "status matches the blocking findings: failure when any is visible, success or a counted failure otherwise";
    case "report-min":
      return `at least ${check.min} report on the head`;
    case "no-report":
      return "no report on the head";
    case "run-completed":
      return `${check.event} run completed`;
    case "step-succeeded":
      return "the run's review step succeeded";
    case "own-evidence":
      return "the run left its own evidence (its artifact, or its skip marker)";
    case "override-comment":
      return "an override comment this run posted on this head";
    case "reaction":
      return `the triggering comment has the ${check.content} reaction`;
    case "no-run-evidence":
      return "the run left no review evidence of its own";
    case "state-row-at":
      return check.tier === undefined
        ? `state row at ${check.path}`
        : `state row at ${check.path} with tier ${check.tier}`;
    case "run-conclusion":
      return `run concluded ${check.conclusion}`;
    case "status-settled":
      return "pr-hero status is settled (not pending)";
    case "adjudication-reply":
      return `CI adjudication reply is one of ${check.accept.join("/")}`;
    case "finding-at-planted-site":
      return `a finding is anchored at the planted bug (${PLANTED_SITE.path}:${PLANTED_SITE.lineMin}-${PLANTED_SITE.lineMax})`;
    case "no-hunter-failed":
      return "no hunter failed in the run";
    case "newer-head-unchanged":
      return "the newer head's pr-hero status is unchanged by the rerun";
    case "end-of-budget-comment":
      return "the end-of-budget comment says no more automatic reviews will run";
  }
}

// The N the gate writes into its own description: `crysk: N blocking finding(s) …`
// (blockingCommitStatusRequest). A run of an older ref writes `pr-hero: …`, so the lead is
// read in its new spelling first. Undefined when the description carries no count.
function gateBlockingCount(description: string): number | undefined {
  const match = /^crysk: (\d+) blocking finding\(s\)/.exec(
    canonicalStatusText(description),
  );
  return match === null ? undefined : Number(match[1]);
}

function headReports(obs: Observation): number {
  return obs.comments.filter(
    (c) => c.kind === "report" && c.head === obs.headSha,
  ).length;
}

// The partial-review verdict's text, finished or carried. Spelled out here because the sandbox
// harness does not import the engine.
const PARTIAL_REVIEW =
  /^crysk: review partial \(\d+ of \d+ hunters failed(?:, set [0-9a-f]{6})?\)(?: carried from [0-9a-f]{7})? — \/pr-hero review retries it$|^crysk: review partial again \(\d+ of \d+ hunters failed(?:, set [0-9a-f]{6})?\) — fix the failing route or \/pr-hero override$/;

// S3: this observation's head carries a blocking finding comment anchored at `path`. The
// same blocking test the status-matches-findings check reads (the finding header's tier),
// narrowed to the head under test, so an earlier head's finding does not count.
export function blockingFindingAt(obs: Observation, path: string): boolean {
  return obs.comments.some(
    (c) =>
      c.kind === "finding" &&
      c.blocking === true &&
      c.head === obs.headSha &&
      c.path === path,
  );
}

// The blocking entries in this head's report's "Comments Outside Diff" section. Each has
// no inline comment, so only the report's count shows it. Read by status-matches-findings,
// which counts every visible blocking finding; ownBlockingGate reads the paths instead.
export function outsideDiffBlockingOn(obs: Observation): number {
  return obs.comments.reduce(
    (sum, c) =>
      c.kind === "report" && c.head === obs.headSha
        ? sum + (c.outsideDiffBlocking ?? 0)
        : sum,
    0,
  );
}

// S3 gate for the ifOwnBlockingAt checks: this head shows a blocking finding at the path,
// either inline there or in its report's outside-diff section, where each entry names the
// path it is about (outsideDiffBlockingPaths). An outside-diff finding at another file
// does not open the gate for this path. Only when neither holds are the checks not asserted.
export function ownBlockingGate(obs: Observation, path: string): boolean {
  return (
    blockingFindingAt(obs, path) ||
    obs.comments.some(
      (c) =>
        c.kind === "report" &&
        c.head === obs.headSha &&
        (c.outsideDiffBlockingPaths ?? []).includes(path),
    )
  );
}

// S2: a closed ownBlockingGate on a head whose outside-diff blocking entry names no path
// cannot be decided: that entry may be about this path. The ifOwnBlockingAt checks then
// fail with this result rather than being silently skipped. Undefined when the gate is
// open, or when every entry on this head names a path.
export function ownBlockingUndecided(
  obs: Observation,
  path: string,
): CheckResult | undefined {
  if (ownBlockingGate(obs, path)) return undefined;
  const unlocated = obs.comments.reduce(
    (sum, c) =>
      c.kind === "report" && c.head === obs.headSha
        ? sum + (c.outsideDiffUnlocated ?? 0)
        : sum,
    0,
  );
  if (unlocated === 0) return undefined;
  return {
    label: "an outside-diff blocking entry on this head has no parseable path",
    pass: false,
    detail: `an outside-diff blocking entry on this head has no parseable path:line location, so the gate for ${path} cannot be decided`,
  };
}

// Why a closed gate's ifOwnBlockingAt checks are not asserted, for the skip line. An
// undecided gate must not claim the path is clear: the unlocated entry may be about it.
export function ownBlockingSkipReason(obs: Observation, path: string): string {
  return ownBlockingUndecided(obs, path) === undefined
    ? `the re-review found no blocking finding at ${path}`
    : `an unlocated outside-diff blocking entry leaves ${path} undecided`;
}

export function evaluateCheck(check: Check, obs: Observation): CheckResult {
  const label = describeCheck(check);
  const pass = (ok: boolean, detail?: string): CheckResult =>
    ok ? { label, pass: true } : { label, pass: false, detail };
  switch (check.kind) {
    case "path": {
      const path = classifyPath(obs);
      const ok = check.accept.some(
        (a) => a === path || (a === "skipped" && path.startsWith("skipped:")),
      );
      return pass(ok, `got ${path}`);
    }
    case "outcome": {
      const outcomes = obs.comments.filter((c) => c.kind === "outcome");
      const codes = outcomes.map((c) => c.code ?? "no-code");
      if (check.lead === undefined) {
        return pass(
          codes.includes(check.code),
          codes.length === 0 ? "no outcome comment" : `got ${codes.join(", ")}`,
        );
      }
      // The lead is read from the comment that carries this code, so a comment
      // of another code cannot satisfy it.
      const leads = outcomes
        .filter((c) => c.code === check.code)
        .map((c) => c.lead ?? "no lead");
      return pass(
        outcomes.some((c) => c.code === check.code && c.lead === check.lead),
        codes.length === 0
          ? "no outcome comment"
          : `got ${leads.length === 0 ? codes.join(", ") : leads.join(", ")}`,
      );
    }
    case "no-outcome": {
      const codes = obs.comments
        .filter((c) => c.kind === "outcome")
        .map((c) => c.code ?? "no-code");
      return pass(codes.length === 0, `got ${codes.join(", ")}`);
    }
    case "no-own-outcome": {
      // Outcome comments are issue comments, which collect() stamps with created_at, so
      // postedByThisRun can read each one. A phase with no trigger has no window: every
      // outcome counts there, as no-outcome counts it.
      const own = obs.comments
        .filter((c) => c.kind === "outcome" && postedByThisRun(c, obs))
        .map((c) => c.code ?? "no-code");
      return pass(own.length === 0, `this run posted ${own.join(", ")}`);
    }
    case "status": {
      const status = obs.status;
      if (status === undefined) return pass(false, "no status on the head");
      const text = canonicalStatusText(status.description);
      const prefixOk =
        check.descriptionStartsWith === undefined ||
        text.startsWith(check.descriptionStartsWith);
      const containsOk =
        check.descriptionContains === undefined ||
        text.includes(check.descriptionContains);
      return pass(
        status.state === check.state && prefixOk && containsOk,
        `got ${status.state}: ${status.description}`,
      );
    }
    case "status-matches-findings": {
      const status = obs.status;
      if (status === undefined) return pass(false, "no status on the head");
      // Visible on THIS head only: an inline blocking finding whose marker names the
      // observed head, plus the blocking entries in that head's report's outside-diff
      // section. The gate counts every unresolved blocking finding, including the
      // carried priors that show no comment, so a failure may count more than is
      // visible. Inline comments from older heads are never deleted and never count.
      const inline = obs.comments.filter(
        (c) =>
          c.kind === "finding" && c.blocking === true && c.head === obs.headSha,
      ).length;
      const outside = outsideDiffBlockingOn(obs);
      const visible = inline + outside;
      const counted = gateBlockingCount(status.description);
      // Each branch names its case in the detail, so a pass says which rule it used.
      const verdict = (ok: boolean, detail: string): CheckResult => ({
        label,
        pass: ok,
        detail,
      });
      if (visible > 0) {
        const ok =
          status.state === "failure" &&
          counted !== undefined &&
          counted >= visible;
        return verdict(
          ok,
          `${visible} visible blocking finding(s) (${inline} inline, ${outside} outside the diff); ${status.state} counts ${counted ?? "none"}`,
        );
      }
      if (status.state === "success") {
        return verdict(true, "no visible blocking finding; success");
      }
      if (status.state === "failure" && counted !== undefined && counted >= 1) {
        return verdict(
          true,
          `no visible blocking finding; failure counts ${counted} carried prior blocking finding(s)`,
        );
      }
      // D2: a gate-mode review where some hunters failed and nothing blocked is red with its own
      // text (src/pr/preflight.ts partialReviewDescription, or the carried form from admission.ts).
      // It counts nothing because nothing blocks, so it agrees with no visible blocking finding.
      if (
        status.state === "failure" &&
        PARTIAL_REVIEW.test(canonicalStatusText(status.description ?? ""))
      ) {
        return verdict(
          true,
          "no visible blocking finding; failure is a partial review",
        );
      }
      return verdict(
        false,
        `no visible blocking finding, and the ${status.state} does not count one`,
      );
    }
    case "report-min": {
      const n = headReports(obs);
      return pass(n >= check.min, `found ${n}`);
    }
    case "no-report": {
      const n = headReports(obs);
      return pass(n === 0, `found ${n}`);
    }
    case "run-completed": {
      const run = obs.run;
      if (run === undefined) return pass(false, "no run was found");
      const ok = run.event === check.event && run.status === "completed";
      return pass(
        ok,
        `got run ${run.id} ${run.event ?? "no-event"} ${run.status}`,
      );
    }
    case "step-succeeded": {
      const step = obs.run?.steps.find((s) => isRunStepName(s.name));
      if (obs.run === undefined) return pass(false, "no run was found");
      return pass(
        step?.conclusion === "success",
        `got ${step?.conclusion ?? "no step"} for ${RUN_STEP_NAME}`,
      );
    }
    case "own-evidence": {
      // A reviewed head reads as reviewed from an earlier run's report too, so
      // only this run's artifact proves this run reviewed. The artifact is named
      // by PR and head, and collect() fetches it by this run's id.
      const path = classifyPath(obs);
      if (path === "reviewed") {
        // The action uploads `crysk-run-…`; a run of a ref from before the
        // rename uploaded `pr-hero-run-…`. Either proves this run reviewed.
        const [artifact, legacyArtifact] = runArtifactNames(
          obs.prNumber,
          obs.headSha,
        ) as [string, string];
        return pass(
          obs.artifacts.includes(artifact) ||
            obs.artifacts.includes(legacyArtifact),
          `no ${artifact} artifact on this run (artifacts: ${obs.artifacts.join(", ") || "none"})`,
        );
      }
      // A skip uploads nothing and its marker names no run, so the marker must be
      // a comment this run created: posted at or after the trigger, less the skew.
      if (path.startsWith("skipped:")) {
        const triggeredAt = obs.triggeredAt;
        const own = obs.comments.some(
          (c) =>
            c.kind === "skip" &&
            triggeredAt !== undefined &&
            c.createdAt !== undefined &&
            Date.parse(c.createdAt) >= triggeredAt - COMMENT_RUN_CLOCK_SKEW_MS,
        );
        return pass(own, "no skip marker posted after this run's trigger");
      }
      return pass(false, `path ${path} leaves no evidence this run could own`);
    }
    case "override-comment": {
      const ok = obs.comments.some(
        (c) =>
          c.kind === "override" &&
          c.head === obs.headSha &&
          postedByThisRun(c, obs),
      );
      return pass(ok, `no override comment on ${obs.headSha} from this run`);
    }
    case "reaction": {
      // Unset when the phase has no triggering comment or its read failed. That is
      // a failure of the observation, not a missing reaction, so it never passes.
      const seen = obs.reactions;
      if (seen === undefined) {
        return pass(false, "the triggering comment's reactions were not read");
      }
      return pass(
        seen.includes(check.content),
        `got ${seen.join(", ") || "no reaction"}`,
      );
    }
    case "no-run-evidence": {
      // A missing run is not a pass: collect() reports no artifacts for it, so an
      // unread run would otherwise look like one that reviewed nothing.
      if (obs.run === undefined) return pass(false, "no run was found");
      // Artifacts are read per run id, so a run artifact here is this run's.
      const uploaded = obs.artifacts.filter((a) => isRunArtifactName(a));
      if (uploaded.length > 0) {
        return pass(false, `this run uploaded ${uploaded.join(", ")}`);
      }
      // postedByThisRun is the same window own-evidence reads a skip marker through.
      const skipped = obs.comments.some(
        (c) => c.kind === "skip" && postedByThisRun(c, obs),
      );
      return pass(!skipped, "this run posted a skip marker");
    }
    case "state-row-at": {
      // Only this head's reports are read: an earlier head's state rows describe that head.
      const reports = obs.comments.filter(
        (c) => c.kind === "report" && c.head === obs.headSha,
      );
      const blocks = reports.filter((c) => c.statePaths !== undefined);
      if (blocks.length === 0) {
        return pass(false, "no state block on this head's report");
      }
      // S2: a tiered check reads each row's tier too, so an advisory row at the path
      // does not satisfy a blocking one. Without a tier the path alone decides, as before.
      if (check.tier !== undefined) {
        const tiered = blocks.flatMap((c) => c.stateRows ?? []);
        const shown = tiered
          .map((row) => `${row.path} (${row.tier ?? "no tier"})`)
          .join(", ");
        return pass(
          tiered.some(
            (row) => row.path === check.path && row.tier === check.tier,
          ),
          `no state row at ${check.path} with tier ${check.tier} (state rows: ${shown || "none"})`,
        );
      }
      const rows = blocks.flatMap((c) => c.statePaths ?? []);
      return pass(
        rows.includes(check.path),
        `no state row at ${check.path} (state rows: ${rows.join(", ") || "none"})`,
      );
    }
    case "run-conclusion": {
      const concluded = obs.run?.conclusion;
      return pass(
        concluded === check.conclusion,
        `concluded ${obs.run?.conclusion ?? "none"}`,
      );
    }
    case "status-settled": {
      const status = obs.status;
      return pass(
        status !== undefined && status.state !== "pending",
        status === undefined
          ? "no pr-hero status"
          : `${status.state}: ${status.description}`,
      );
    }
    case "adjudication-reply": {
      // Only replies this run posted count: an adjudication an earlier run left on the
      // PR is that run's ruling, not this one's.
      const replies = obs.comments.filter(
        (c) => c.kind === "adjudication" && postedByThisRun(c, obs),
      );
      const verdict = replies.find(
        (c) => c.verdict !== undefined && check.accept.includes(c.verdict),
      )?.verdict;
      if (verdict !== undefined) {
        return { label, pass: true, detail: `adjudication ${verdict}` };
      }
      const seen = replies.flatMap((c) =>
        c.verdict === undefined ? [] : [c.verdict],
      );
      return pass(
        false,
        `no adjudication reply from this run (verdicts seen: ${seen.join(", ") || "none"})`,
      );
    }
    case "finding-at-planted-site": {
      // Only findings on the observed head count: an older head's finding is not this run's.
      const sites = obs.comments.filter(
        (c) => c.kind === "finding" && c.head === obs.headSha,
      );
      const inSite = (c: CommentFact): boolean =>
        c.path === PLANTED_SITE.path &&
        c.line !== undefined &&
        c.line >= PLANTED_SITE.lineMin &&
        c.line <= PLANTED_SITE.lineMax;
      const found = sites.some(inSite);
      const seen = sites.map((c) =>
        c.path === undefined ? "no anchor" : `${c.path}:${c.line ?? "?"}`,
      );
      // A hunter that died may be the one that would have found the bug: its miss is the flake.
      const flake = (obs.hunterFailures?.length ?? 0) > 0;
      const result = pass(
        found,
        `findings on this head: ${seen.join(", ") || "none"}`,
      );
      return flake && !found
        ? { ...result, cause: "free-model-hunters-failed" }
        : result;
    }
    case "no-hunter-failed": {
      // An unread log is not a clean run: it fails, so a missing read never passes.
      const failed = obs.hunterFailures;
      if (failed === undefined) {
        return pass(false, "the run log was not read");
      }
      if (failed.length === 0) return pass(true);
      return {
        label,
        pass: false,
        detail: `hunters failed: ${failed.join(", ")}`,
        cause: "free-model-hunters-failed",
      };
    }
    case "end-of-budget-comment": {
      // The manual-required marker alone is not enough: before S10 the same marker opened a
      // notice that asked for a manual override. Only the S10 sentence passes.
      const notices = obs.comments.filter(
        (c) => c.kind === "skip" && c.skip === "manual-required",
      );
      return pass(
        notices.some((c) => c.endOfBudget === true),
        notices.length === 0
          ? "no manual-required comment on the PR"
          : "the manual-required comment does not say that no more automatic reviews will run",
      );
    }
    case "newer-head-unchanged": {
      const newer = obs.newerHead;
      if (newer === undefined) {
        return pass(false, "the newer head was not observed");
      }
      const { before, after } = newer;
      if (before === undefined || after === undefined) {
        return pass(
          false,
          `status before ${before === undefined ? "not read" : `${before.state}`}, after ${after === undefined ? "not read" : `${after.state}`}`,
        );
      }
      const same =
        before.state === after.state &&
        before.description === after.description;
      return pass(
        same,
        same
          ? undefined
          : `${newer.sha.slice(0, 7)} changed from ${before.state}: ${before.description} to ${after.state}: ${after.description}`,
      );
    }
  }
}

export function evaluateChecks(
  checks: readonly Check[],
  obs: Observation,
): CheckResult[] {
  return checks.map((check) => evaluateCheck(check, obs));
}
