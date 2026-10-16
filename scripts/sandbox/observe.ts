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

export type CommentKind = "report" | "finding" | "outcome" | "skip" | "other";

export interface CommentFact {
  source: "issue" | "inline";
  kind: CommentKind;
  code?: string;
  skip?: SkipReason;
  // A report names the head it reviewed. Only a report for the head under test
  // counts as this run's review: an earlier head's summary on the same PR is not.
  head?: string;
}

export interface RunFact {
  id: number;
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
    return { source, kind: "outcome", code: outcomeCodeOf(body) };
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
  const outcome = obs.comments.find((c) => c.kind === "outcome");
  if (outcome !== undefined) {
    if (outcome.code === "PRH-HUNTERS-FAILED") return "hunters-failed";
    return `error:${outcome.code ?? "no-code"}`;
  }
  const skip = obs.comments.find((c) => c.kind === "skip");
  if (skip?.skip !== undefined) return `skipped:${skip.skip}`;

  const hasReport = obs.comments.some(
    (c) => c.kind === "report" && c.head === obs.headSha,
  );
  if (hasReport && obs.status?.state === "success") return "reviewed";

  const statusCode = /^PRH-[A-Z]+(?:-[A-Z]+)*/.exec(
    obs.status?.description ?? "",
  )?.[0];
  if (obs.status?.state === "error" && statusCode !== undefined)
    return `error:${statusCode}`;

  // The step failed, nothing was posted, and the run directory was uploaded:
  // the engine started and produced no review. That is the hunters-failed
  // shape, which the product does not name with its catalog code today.
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

// reviewed and hunters-failed both prove the free route ran end to end. A
// violation overrides them: a run that passed the path but broke an invariant
// is a failure of the publisher, which is what this runner exists to catch.
export function exitCodeFor(
  path: SmokePath,
  violations: readonly string[],
): 0 | 1 {
  if (violations.length > 0) return 1;
  return path === "reviewed" || path === "hunters-failed" ? 0 : 1;
}
