// What a scenario PR shows, and what it means. Pure: the runner collects raw
// facts from gh, and everything below decides from those facts alone, so each
// path and each invariant is pinned by a fixture rather than by a live run.
//
// Two rules keep the classifier honest. First, the path is read from the
// evidence on the PR and the run, never from the status state alone: the S7
// invariants are checked separately, so a status that violates S7 cannot also
// decide the path. Second, a path with no positive evidence is no-outcome, not
// a guess.

import {
  FINDING_MARKER_PREFIX,
  OUTCOME_MARKER_PREFIX,
  PRH_CODE,
  REPORT_MARKER_PREFIX,
  RUN_STEP_NAME,
  SKIP_MARKERS,
  type SkipReason,
} from "./markers";

// The catalog code of "every hunter failed" (src/ci/outcome.ts, ERROR_CATALOG).
// Both the outcome comment and the status carry it, and both read as the same path.
const HUNTERS_FAILED_CODE = "PRH-HUNTERS-FAILED";

export type CommentKind = "report" | "finding" | "outcome" | "skip" | "other";

export interface CommentFact {
  source: "issue" | "inline";
  kind: CommentKind;
  code?: string;
  skip?: SkipReason;
  // A report or an outcome names the head it was written for. Only a report for
  // the head under test counts as this run's review, and only an outcome for it
  // decides this run's path: an earlier head's comment on the same PR is not.
  head?: string;
}

export interface RunFact {
  id: number;
  // The event that started the run. A comment-triggered run and the pull_request
  // run of the same PR are different runs, and a check must tell them apart.
  event?: string;
  status: string;
  conclusion: string | null;
  steps: { name: string; conclusion: string | null }[];
}

export interface StatusFact {
  state: string;
  description: string;
}

export interface Observation {
  prNumber: number;
  prUrl: string;
  headSha: string;
  run?: RunFact;
  status?: StatusFact;
  comments: CommentFact[];
  artifacts: string[];
}

export type SmokePath =
  | "reviewed"
  | "hunters-failed"
  | `error:${string}`
  | `skipped:${string}`
  | "no-outcome";

export function outcomeCodeOf(body: string): string | undefined {
  return PRH_CODE.exec(body)?.[0];
}

export function classifyComment(
  body: string,
  source: "issue" | "inline",
): CommentFact {
  const first = (body.split("\n", 1)[0] ?? "").trim();
  if (first.startsWith(REPORT_MARKER_PREFIX)) {
    const head = /\bhead=([0-9a-f]{40})\b/.exec(first)?.[1];
    return head === undefined
      ? { source, kind: "report" }
      : { source, kind: "report", head };
  }
  if (first.startsWith(FINDING_MARKER_PREFIX))
    return { source, kind: "finding" };
  if (first.startsWith(OUTCOME_MARKER_PREFIX)) {
    // The head is "unknown" when the publisher had no sha; such an outcome has no head.
    const head = /\bhead=([0-9a-f]{40})\b/.exec(first)?.[1];
    const code = outcomeCodeOf(body);
    return head === undefined
      ? { source, kind: "outcome", code }
      : { source, kind: "outcome", code, head };
  }
  for (const [reason, marker] of Object.entries(SKIP_MARKERS)) {
    if (first === marker)
      return { source, kind: "skip", skip: reason as SkipReason };
  }
  return { source, kind: "other" };
}

function stepConclusion(obs: Observation): string | null | undefined {
  return obs.run?.steps.find((s) => s.name === RUN_STEP_NAME)?.conclusion;
}

export function classifyPath(obs: Observation): SmokePath {
  // An outcome of an earlier head is that head's failure, not this one's. It still
  // counts for S7 (invariantViolations reads every outcome on the PR).
  const outcome = obs.comments.find(
    (c) =>
      c.kind === "outcome" && (c.head === undefined || c.head === obs.headSha),
  );
  if (outcome !== undefined) {
    if (outcome.code === HUNTERS_FAILED_CODE) return "hunters-failed";
    return `error:${outcome.code ?? "no-code"}`;
  }
  const skip = obs.comments.find((c) => c.kind === "skip");
  if (skip?.skip !== undefined) return `skipped:${skip.skip}`;

  const hasReport = obs.comments.some(
    (c) => c.kind === "report" && c.head === obs.headSha,
  );
  if (hasReport && obs.status?.state === "success") return "reviewed";

  // The status is written apart from the outcome comment, so a read can see it
  // alone. Its code is the same failure the comment names, so it classifies the
  // same way; an error status with any other code stays `error:<code>`.
  const statusCode = /^PRH-[A-Z]+(?:-[A-Z]+)*/.exec(
    obs.status?.description ?? "",
  )?.[0];
  if (obs.status?.state === "error" && statusCode !== undefined) {
    return statusCode === HUNTERS_FAILED_CODE
      ? "hunters-failed"
      : `error:${statusCode}`;
  }

  // The step failed, nothing was posted, and the run directory was uploaded:
  // the engine started and produced no review. The dev-era CLI posts no PRH
  // code here ("review did not finish", which S7 flags), so only the run tells.
  const uploaded = obs.artifacts.some((a) => a.startsWith("pr-hero-run-"));
  if (!hasReport && stepConclusion(obs) === "failure" && uploaded)
    return "hunters-failed";
  return "no-outcome";
}

// The S7 invariants from #330's review rounds, checked literally. They are
// reported as violations even when the path itself looks fine.
export function invariantViolations(obs: Observation): string[] {
  const violations: string[] = [];
  const status = obs.status;
  if (status?.state === "error" && !/^PRH-/.test(status.description)) {
    violations.push(
      `S7 violation: error status without a PRH- code: "${status.description}"`,
    );
  }
  if (
    status?.state === "success" &&
    obs.comments.some((c) => c.kind === "outcome")
  ) {
    violations.push(
      "S7 violation: outcome comment on a head whose status is success",
    );
  }
  if (status?.state === "pending" && obs.run?.status === "completed") {
    violations.push(
      "S7 violation: status still pending after the run completed",
    );
  }
  return violations;
}
