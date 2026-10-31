// `post_min_severity`: the lowest finding a PR review posts. A posting filter
// only: the pipeline still finds, refutes and tiers every finding, and local
// reports still show all of them. The PR comments change, and with them the
// re-review admission, which scores only what was posted: a finding nobody
// sees should not spend a re-review. The gate is unaffected, since a blocking
// finding is never hidden.
//
// The floor never hides a blocking finding: `blocking` hides every advisory one,
// `warning` hides advisory SUGGESTIONs only, so a BLOCKER/CRITICAL the refuter
// demoted to advisory still posts there. Absent means `suggestion`: post
// everything, the behaviour before this key existed.

import type { Severity, Tier } from "#review/findings";

export const POST_MIN_SEVERITIES = [
  "suggestion",
  "warning",
  "blocking",
] as const;
export type PostMinSeverity = (typeof POST_MIN_SEVERITIES)[number];

export function isBelowPostFloor(
  finding: { tier: Tier; severity: Severity },
  floor: PostMinSeverity | undefined,
): boolean {
  if (finding.tier === "blocking") return false;
  if (floor === "blocking") return true;
  if (floor === "warning") return finding.severity === "SUGGESTION";
  return false;
}
