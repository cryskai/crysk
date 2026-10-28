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
import { MARKER_OPEN } from "../../src/brand";

// The summary comment and the per-finding comments. The summary is an issue
// comment; the findings are inline review comments, so the runner reads both.
export const REPORT_MARKER_PREFIX = PR_COMMENT_MARKER_PREFIX;
export const FINDING_MARKER_PREFIX = PR_FINDING_MARKER_PREFIX;

// Private MARKER_PREFIX in src/ci/publish.ts: the outcome comment's first line.
export const OUTCOME_MARKER_PREFIX = `${MARKER_OPEN}outcome`;

// Private MARKER_PREFIX of the override comment in src/ci/publish.ts (S8). It is
// not an outcome marker, so the classifier must read it as its own kind.
export const OVERRIDE_MARKER_PREFIX = `${MARKER_OPEN}override`;

// Private STATUS_CONTEXT in src/ci/publish.ts: the commit status context.
export const STATUS_CONTEXT = "pr-hero";

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
export const WORKFLOW_NAME = "pr-hero Review";
export const RUN_STEP_NAME = "Run pr-hero";
