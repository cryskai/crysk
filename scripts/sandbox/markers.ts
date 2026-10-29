// The one place the sandbox runner names what pr-hero writes to a PR. Markers
// the product exports are imported, so a rename there breaks this file's
// build. Markers the product keeps private are mirrored here and pinned by
// test/sandbox/seed.test.ts against decidePublication's real output, so a drift
// in the publisher fails that test rather than silently mis-classifying a run.

import {
  MANUAL_REQUIRED_COMMENT_MARKER,
  SKIP_BUDGET_COMMENT_MARKER,
  SKIP_COVERAGE_COMMENT_MARKER,
  SKIP_SIZE_COMMENT_MARKER,
} from "#ci/gates";
import {
  PR_COMMENT_MARKER_PREFIX,
  PR_FINDING_MARKER_PREFIX,
} from "#pr/preflight";
import {
  STATUS_CONTEXT as BRAND_STATUS_CONTEXT,
  isLegacyStatusContext,
  isStatusContext,
  LEGACY_RUN_ARTIFACT_PREFIX,
  LEGACY_RUN_STEP_DISPLAY_NAME,
  LEGACY_WORKFLOW_DISPLAY_NAME,
  MARKER_OPEN,
  RUN_ARTIFACT_PREFIX,
  RUN_STEP_DISPLAY_NAME,
  WORKFLOW_DISPLAY_NAME,
} from "../../src/brand";

// The summary comment and the per-finding comments. The summary is an issue
// comment; the findings are inline review comments, so the runner reads both.
export const REPORT_MARKER_PREFIX = PR_COMMENT_MARKER_PREFIX;
export const FINDING_MARKER_PREFIX = PR_FINDING_MARKER_PREFIX;

// Private MARKER_PREFIX in src/ci/publish.ts: the outcome comment's first line.
export const OUTCOME_MARKER_PREFIX = `${MARKER_OPEN}outcome`;

// Private MARKER_PREFIX of the override comment in src/ci/publish.ts (S8). It is
// not an outcome marker, so the classifier must read it as its own kind.
export const OVERRIDE_MARKER_PREFIX = `${MARKER_OPEN}override`;

// The commit status context the publisher writes (src/ci/publish.ts), brand's one literal.
export const STATUS_CONTEXT = BRAND_STATUS_CONTEXT;

// The gate's row among a commit's statuses. The publisher writes the gate on `crysk` and, for
// one version, on the legacy `pr-hero` too, and a sandbox run on an older ref writes only
// `pr-hero`: the newest row across both names is the gate, as every product reader takes it.
// A tie goes to the crysk row. A row without a time sorts as the oldest.
export function gateStatusOf<
  T extends { context: string; created_at?: string },
>(rows: readonly T[]): T | undefined {
  let latest: T | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (!isStatusContext(row.context, STATUS_CONTEXT)) continue;
    const parsed = Date.parse(row.created_at ?? "");
    const ms = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    const wins =
      latest === undefined ||
      ms > latestMs ||
      (ms === latestMs &&
        isLegacyStatusContext(latest.context) &&
        !isLegacyStatusContext(row.context));
    if (wins) {
      latest = row;
      latestMs = ms;
    }
  }
  return latest;
}

export const SKIP_MARKERS = {
  size: SKIP_SIZE_COMMENT_MARKER,
  budget: SKIP_BUDGET_COMMENT_MARKER,
  coverage: SKIP_COVERAGE_COMMENT_MARKER,
  "manual-required": MANUAL_REQUIRED_COMMENT_MARKER,
} as const;

export type SkipReason = keyof typeof SKIP_MARKERS;

// A PRH code as it appears in an outcome body's heading and a status description.
export const PRH_CODE = /PRH-[A-Z]+(?:-[A-Z]+)*/;

// The workflow the sandbox scaffolds, and the step that runs the action. A
// composite action is one step to the jobs API, so the classifier reads this step.
// The current names are what a scaffold of this tree writes; a run of an older ref
// carries the pre-rename ones, so every reader goes through the is* helpers.
export const WORKFLOW_NAME = WORKFLOW_DISPLAY_NAME;
export const RUN_STEP_NAME = RUN_STEP_DISPLAY_NAME;

export function isWorkflowName(name: string): boolean {
  return name === WORKFLOW_NAME || name === LEGACY_WORKFLOW_DISPLAY_NAME;
}

export function isRunStepName(name: string): boolean {
  return name === RUN_STEP_NAME || name === LEGACY_RUN_STEP_DISPLAY_NAME;
}

// The run directory artifact of a PR head, under either prefix.
export function runArtifactNames(prNumber: number, headSha: string): string[] {
  return [RUN_ARTIFACT_PREFIX, LEGACY_RUN_ARTIFACT_PREFIX].map(
    (prefix) => `${prefix}${prNumber}-${headSha}`,
  );
}

export function isRunArtifactName(name: string): boolean {
  return (
    name.startsWith(RUN_ARTIFACT_PREFIX) ||
    name.startsWith(LEGACY_RUN_ARTIFACT_PREFIX)
  );
}
