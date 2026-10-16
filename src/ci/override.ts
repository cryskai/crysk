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
const OVERRIDE_CLOCK_SKEW_ALLOWANCE_MS = 5_000;

// The fields of a commit status the rule reads. A status the reader did not describe has
// no description, and is never taken as an override.
export interface OverrideStatusFact {
  state: string;
  context: string;
  created_at: string;
  description?: string | null;
}

// Whether an override stands over a review that started at runStartedMs. The override
// stands when the newest OVERRIDE_STATUS_CONTEXT status is a successful override created
// at or after the run's start, less the allowance. A later review has posted its own
// status since, which is then the newest, so this is false and its write goes ahead.
//
// WHY the state too: an override is a success. A status that merely carries the
// description (a failure or a pending one) is not an override, and must not hold the gate
// open over a review that finished.
export function overrideStandsOverRun(
  statuses: readonly OverrideStatusFact[],
  runStartedMs: number,
): boolean {
  const latest = newestStatusInContext(statuses, OVERRIDE_STATUS_CONTEXT);
  if (latest === undefined) return false;
  if (latest.state !== "success") return false;
  const description = latest.description;
  if (
    typeof description !== "string" ||
    !description.startsWith(OVERRIDE_DESCRIPTION_PREFIX)
  ) {
    return false;
  }
  const createdMs = Date.parse(latest.created_at);
  if (Number.isNaN(createdMs)) return false;
  return createdMs >= runStartedMs - OVERRIDE_CLOCK_SKEW_ALLOWANCE_MS;
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
