// The override rule (docs/github-actions.md, "Overriding a red gate"), in one place. Two
// writers of a review's verdict apply it: the CLI's final commit status write
// (src/pr/teardown.ts) and the publisher's repost of a status the CLI could not write
// (src/ci/publish.ts). They must give the same answer, so both import it from here.
//
// WHY ONLY BUILTINS AND ../brand: publish.ts runs before dependencies are installed, so it
// cannot import a package, and it imports this module. The rule needs nothing outside the
// language, and ../brand itself imports nothing, so it is the one module this file may load.
import {
  canonicalStatusText,
  isLegacyStatusContext,
  isStatusContext,
  STATUS_CONTEXT,
  statusContextForms,
} from "../brand";

// The start of an override's status description. The publisher writes an override with
// it, and this rule recognises an override by it. An override an older action wrote starts
// `pr-hero: overridden by @`; readers rewrite that lead (canonicalStatusText) before they
// compare, so this one prefix serves both.
export const OVERRIDE_DESCRIPTION_PREFIX = `${STATUS_CONTEXT}: overridden by @`;

// The context both the review's verdict and an override are written on. It is brand's
// STATUS_CONTEXT, the one preflight.ts's COMMIT_STATUS_CONTEXT also is; a drift test pins
// the two together (test/ci/override.test.ts). A row on the legacy `pr-hero` name counts
// as the same context (newestStatusInContext).
export const OVERRIDE_STATUS_CONTEXT = STATUS_CONTEXT;

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

// Whether one status is an override: a success whose description carries the override
// prefix. This is the single test both writers and the status reader use, so none of them
// can recognise an override by a different rule. A status without a description is never one.
export function isOverrideStatus(status: OverrideStatusFact): boolean {
  return (
    status.state === "success" &&
    typeof status.description === "string" &&
    canonicalStatusText(status.description).startsWith(
      OVERRIDE_DESCRIPTION_PREFIX,
    )
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
  if (latest === undefined || !isOverrideStatus(latest)) return false;
  const createdMs = Date.parse(latest.created_at);
  if (Number.isNaN(createdMs)) return false;
  return createdMs >= cutoffMs;
}

// The login an override was written by: the text after the prefix up to the first space. The
// publisher writes `crysk: overridden by @<login> — no review on this head` (an older action
// wrote `pr-hero: …`, which reads the same), and a GitHub login has no space, so this is the
// login exactly. Null when the description is not an override or names no one.
export function overrideActorOf(description: string): string | null {
  const text = canonicalStatusText(description);
  if (!text.startsWith(OVERRIDE_DESCRIPTION_PREFIX)) return null;
  const actor = text.slice(OVERRIDE_DESCRIPTION_PREFIX.length).split(" ")[0];
  return actor === undefined || actor === "" ? null : actor;
}

// The newest status of one context by created_at: a row whose time does not parse is skipped.
// A tie goes to the row that comes first in the array. GitHub's status LIST is newest-first, so
// the first of two same-second rows is the newer one: `[success@t, failure@t]` reads as success.
// The combined endpoint has one row per context, so it never ties. This is the same selection
// as preflight.ts's latestStatusInContext except on a tie, where that one takes the later row
// (`>=`). This module cannot import it. The publisher's reads use this one too.
//
// WHY one context means two names: for one version the gate is written on `crysk` and on the
// legacy `pr-hero`, and an older action still writes only `pr-hero`. The newest row across both
// names is the gate, so an override posted by an older action still beats a newer-version
// verdict that is older than it. Two rows with the same time are a pair one run wrote, with
// identical content, so either would do; the crysk row is taken so the answer never depends
// on the order of the list.
// A half-landed pair. Every write posts both names, so a name whose newest row is still
// pending while the other name holds a later settled row missed that write. The settled
// row is the verdict (a finished review, or a human's override), and the stuck name is
// what a repair copies it onto. Undefined when the two names agree.
export function strandedStatusPair<T extends OverrideStatusFact>(
  statuses: readonly T[],
  context: string,
): { stranded: T; verdict: T } | undefined {
  const [first, second] = statusContextForms(context).map((name) =>
    newestStatusInContext(
      statuses.filter((status) => status.context === name),
      context,
    ),
  );
  for (const [stranded, verdict] of [
    [first, second],
    [second, first],
  ]) {
    if (
      stranded?.state === "pending" &&
      verdict !== undefined &&
      verdict.state !== "pending" &&
      Date.parse(verdict.created_at) >= Date.parse(stranded.created_at)
    ) {
      return { stranded, verdict };
    }
  }
  return undefined;
}

export function newestStatusInContext<T extends OverrideStatusFact>(
  statuses: readonly T[],
  context: string,
): T | undefined {
  let latest: T | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const status of statuses) {
    if (!isStatusContext(status.context, context)) continue;
    const createdMs = Date.parse(status.created_at);
    if (Number.isNaN(createdMs)) continue;
    const newer =
      createdMs > latestMs ||
      (createdMs === latestMs &&
        latest !== undefined &&
        isLegacyStatusContext(latest.context) &&
        !isLegacyStatusContext(status.context));
    if (newer) {
      latest = status;
      latestMs = createdMs;
    }
  }
  return latest;
}
