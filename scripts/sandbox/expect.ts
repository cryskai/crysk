// What a scenario phase asserts about its observation. Pure: a check reads one
// Observation and says pass or fail with the fact it saw, so every expectation
// is pinned by a fixture and the report can print each one. The S7 invariants
// are not checks here: the runner applies them to every observation itself.

import { RUN_STEP_NAME } from "./markers";
import {
  COMMENT_RUN_CLOCK_SKEW_MS,
  classifyPath,
  type Observation,
  postedByThisRun,
} from "./observe";

export type Check =
  // `skipped` accepts any documented skip, `skipped:<reason>`.
  | { kind: "path"; accept: readonly string[] }
  // `lead` (optional) names the owner the outcome's comment must open with.
  | { kind: "outcome"; code: string; lead?: string }
  | { kind: "no-outcome" }
  // T2e: this run posted no outcome comment. Unlike no-outcome it reads the outcomes
  // this run created (postedByThisRun), so an outcome an earlier run left stays out of it.
  | { kind: "no-own-outcome" }
  | { kind: "status"; state: string; descriptionStartsWith?: string }
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
  // T2e: this run left no review evidence of its own: no `pr-hero-run-*` artifact on
  // this run, and no skip marker it posted after its trigger. A near miss runs nothing,
  // so it leaves neither. WHY not the review step: the composite `Run pr-hero` step has
  // no `if:` and always concludes, so a near miss's step reads success and its
  // conclusion cannot show that no review ran. This is the inverse of own-evidence.
  | { kind: "no-run-evidence" }
  // D3: this head's report carries a state-block row located in `path`.
  | { kind: "state-row-at"; path: string }
  // SB3: the phase's run concluded this way.
  | { kind: "run-conclusion"; conclusion: string }
  // SB3: the head's pr-hero status exists and is not pending, so a cancelled run leaves no stuck gate.
  | { kind: "status-settled" }
  // T5b: this run posted a CI adjudication reply whose verdict is one of `accept`.
  | { kind: "adjudication-reply"; accept: readonly string[] };

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
    case "status":
      return check.descriptionStartsWith === undefined
        ? `status is ${check.state}`
        : `status is ${check.state}, description starts with ${check.descriptionStartsWith}`;
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
      return `state row at ${check.path}`;
    case "run-conclusion":
      return `run concluded ${check.conclusion}`;
    case "status-settled":
      return "pr-hero status is settled (not pending)";
    case "adjudication-reply":
      return `CI adjudication reply is one of ${check.accept.join("/")}`;
  }
}

// The N the gate writes into its own description: `pr-hero: N blocking finding(s) …`
// (blockingCommitStatusRequest). Undefined when the description carries no count.
function gateBlockingCount(description: string): number | undefined {
  const match = /^pr-hero: (\d+) blocking finding\(s\)/.exec(description);
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
  /^pr-hero: review partial \(\d+ of \d+ hunters failed\)(?: carried from [0-9a-f]{7})? — \/pr-hero review retries it$/;

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
      const prefixOk =
        check.descriptionStartsWith === undefined ||
        status.description.startsWith(check.descriptionStartsWith);
      return pass(
        status.state === check.state && prefixOk,
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
      const outside = obs.comments.reduce(
        (sum, c) =>
          c.kind === "report" && c.head === obs.headSha
            ? sum + (c.outsideDiffBlocking ?? 0)
            : sum,
        0,
      );
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
        PARTIAL_REVIEW.test(status.description ?? "")
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
      const step = obs.run?.steps.find((s) => s.name === RUN_STEP_NAME);
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
        const artifact = `pr-hero-run-${obs.prNumber}-${obs.headSha}`;
        return pass(
          obs.artifacts.includes(artifact),
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
      // Artifacts are read per run id, so a `pr-hero-run-` artifact here is this run's.
      const uploaded = obs.artifacts.filter((a) =>
        a.startsWith("pr-hero-run-"),
      );
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
  }
}

export function evaluateChecks(
  checks: readonly Check[],
  obs: Observation,
): CheckResult[] {
  return checks.map((check) => evaluateCheck(check, obs));
}
