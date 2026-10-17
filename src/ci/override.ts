// The override rule (docs/github-actions.md, "Overriding a red gate"), in one place. Two
// writers of a review's verdict apply it: the CLI's final commit status write
// (src/pr/teardown.ts) and the publisher's repost of a status the CLI could not write
// (src/ci/publish.ts). They must give the same answer, so both import it from here.
//
// WHY ONLY BUILTINS: publish.ts runs before `bun install`, so it cannot import a
// package, and it imports this module. The rule needs nothing outside the language,
// so this module imports nothing at all.

// The start of an override's status description. The publisher writes an override with
// it, and this rule recognises an override by it.
export const OVERRIDE_DESCRIPTION_PREFIX = "pr-hero: overridden by @";

// The context both the review's verdict and an override are written on. preflight.ts's
// COMMIT_STATUS_CONTEXT is the same string; a drift test pins the two together
// (test/ci/override.test.ts).
export const OVERRIDE_STATUS_CONTEXT = "pr-hero";

// WHY the allowance: a run's start is read on the runner's clock, and GitHub's created_at
// is server time, so the two can differ by a few seconds. Without the allowance an
// override posted in the run's first moments would read as posted before the run and be
// overwritten. The error is taken toward the human's explicit decision: a review that is
// deemed to start a few seconds early leaves a fresh override standing, while a missed
// override overwrites a deliberate unlock. created_at has one-second precision, which the
// same allowance already covers.
//
// WHY it is only taken when the run's own pending status landed: the allowance is safe only
// while something in the run witnesses the start, and the CLI's own pending status is that
// witness. When that pending did not land, no pr-hero status vouches for the start, and the
// cutoff is the start itself (overrideCutoffMs).
const OVERRIDE_CLOCK_SKEW_ALLOWANCE_MS = 5_000;

// The override cutoff: the instant at or after which an override counts as posted during the
// run. The CLI computes it ONCE, from its own start and whether its pending landed (teardown.ts),
// and records it (override_cutoff_ms, src/ci/cli-record.ts). The publisher reads that recorded
// cutoff and never re-derives it, so the two writers cannot disagree about the same override.
//
// WHY the start less the allowance when the pending landed: the pending is the witness that the
// start is on the head's timeline, so the skew allowance may widen the window (see above).
// WHY the start itself when it did not: nothing vouches for the start, so an override created a
// few seconds before it is not one posted during the run, and it must not stand over the run.
export function overrideCutoffMs(
  runStartedMs: number,
  pendingLanded: boolean,
): number {
  return pendingLanded
    ? runStartedMs - OVERRIDE_CLOCK_SKEW_ALLOWANCE_MS
    : runStartedMs;
}

// The fields of a commit status the rule reads. A status the reader did not describe has
// no description, and is never taken as an override.
export interface OverrideStatusFact {
  state: string;
  context: string;
  created_at: string;
  description?: string | null;
}

// Whether a status is an override: a successful status whose description carries the override
// prefix. The override check below and the CI admission carry-forward (src/pr/admission.ts) both
// read overrides through this one predicate, so they cannot disagree about what an override is.
export function isOverrideStatus(status: OverrideStatusFact): boolean {
  return (
    status.state === "success" &&
    typeof status.description === "string" &&
    status.description.startsWith(OVERRIDE_DESCRIPTION_PREFIX)
  );
}

// Whether an override stands over a review, given the review's override cutoff. The override
// stands when the newest OVERRIDE_STATUS_CONTEXT status is a successful override created at or
// after cutoffMs. A later review has posted its own status since, which is then the newest, so
// this is false and its write goes ahead.
//
// WHY no allowance here: the cutoff already carries the decision (overrideCutoffMs). Both
// writers compare with the same cutoff and nothing else.
//
// WHY the rule guards a verdict write only (`success` or `failure`): an `error` write is a
// failed review (every hunter failed, a cancel, a crash), and it may replace an override.
// The CLI checks the write's state before it calls this (teardown.ts). The publisher's
// repost is a verdict by construction: the CLI records only `success` or `failure` as an
// unsettled status, and the repost writes that record (publish.ts).
//
// WHY the state too: an override is a success. A status that merely carries the
// description (a failure or a pending one) is not an override, and must not hold the gate
// open over a review that finished.
export function overrideStandsOverRun(
  statuses: readonly OverrideStatusFact[],
  cutoffMs: number,
): boolean {
  const latest = newestStatusInContext(statuses, OVERRIDE_STATUS_CONTEXT);
  if (latest === undefined) return false;
  if (!isOverrideStatus(latest)) return false;
  const createdMs = Date.parse(latest.created_at);
  if (Number.isNaN(createdMs)) return false;
  return createdMs >= cutoffMs;
}

// The newest status of one context by created_at: a tie goes to the later row, and a row
// whose time does not parse is skipped. This is preflight.ts's latestStatusInContext,
// which this builtins-only module cannot import. The publisher's reads use it too, so the
// two selections cannot drift.
export function newestStatusInContext(
  statuses: readonly OverrideStatusFact[],
  context: string,
): OverrideStatusFact | undefined {
  let latest: OverrideStatusFact | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const status of statuses) {
    if (status.context !== context) continue;
    const createdMs = Date.parse(status.created_at);
    if (Number.isNaN(createdMs)) continue;
    if (createdMs >= latestMs) {
      latest = status;
      latestMs = createdMs;
    }
  }
  return latest;
}
