// The scenarios, as data. A scenario is a sequence of phases. Each phase does one
// action on the scenario PR, waits for the run that action starts, observes the
// PR, and asserts its checks against that one observation. The runner in
// scenario.ts executes them; nothing here touches gh or git.
//
// Phases run in order, and a later phase starts only after the earlier one's run
// completed, so the second push of `cleanup` always meets a finished first run.

import { GOTCHAS_TEMPLATE } from "#review/preflight";
import type { Check } from "./expect";
import { GOTCHAS_PATH } from "./seed";
import type { VariantName } from "./variants";

// A file the scenario branch commits on top of the planted volume. The path is a
// seed constant, so a scenario can only replace a file the sandbox main already
// defines. Variants edit only the workflow, so this is the one other way a
// scenario changes the branch.
export interface FileOverride {
  path: typeof GOTCHAS_PATH;
  contents: string;
}

export type Action =
  // The first phase: the branch, its first commit and the PR. `overrides` are
  // committed with that first commit.
  | {
      kind: "open";
      variant: VariantName;
      overrides?: readonly FileOverride[];
    }
  // A later commit on the same branch, a plain fast-forward push.
  | { kind: "push"; variant: VariantName }
  // A PR comment, posted as the authenticated user.
  | { kind: "comment"; body: string };

export interface Phase {
  action: Action;
  // The run this phase waits for: the pull_request run on the new head, or the
  // issue_comment run that the comment started (main's workflow).
  wait: "pull_request" | "issue_comment";
  checks: readonly Check[];
  // Asserted only when the phase before this one posted an outcome comment, such
  // as the cleanup of that comment. Otherwise they are not asserted, and the
  // runner says so.
  afterPriorOutcome?: readonly Check[];
}

export interface Scenario {
  name: string;
  description: string;
  phases: readonly Phase[];
}

const REVIEWED: Check = { kind: "path", accept: ["reviewed"] };
// The review step of the observed run itself, not an earlier run's report on the
// same head. A run that did not succeed cannot pass a phase on what it left behind.
const STEP_SUCCEEDED: Check = { kind: "step-succeeded" };
const POSTED_STATUS: Check = { kind: "status", state: "success" };
const ONE_REPORT: Check = { kind: "report-min", min: 1 };

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "no-credential",
    description:
      "no model credential reaches the action: PRH-CRED-MISSING, an error status, no report ($0)",
    phases: [
      {
        action: { kind: "open", variant: "no-credential" },
        wait: "pull_request",
        checks: [
          { kind: "outcome", code: "PRH-CRED-MISSING" },
          {
            kind: "status",
            state: "error",
            descriptionStartsWith: "PRH-CRED-MISSING",
          },
          { kind: "no-report" },
        ],
      },
    ],
  },
  {
    name: "bad-routing",
    description:
      "the routing input is malformed JSON: PRH-ROUTING-INVALID, an error status, no report ($0)",
    phases: [
      {
        action: { kind: "open", variant: "bad-routing" },
        wait: "pull_request",
        checks: [
          { kind: "outcome", code: "PRH-ROUTING-INVALID" },
          {
            kind: "status",
            state: "error",
            descriptionStartsWith: "PRH-ROUTING-INVALID",
          },
          { kind: "no-report" },
        ],
      },
    ],
  },
  {
    name: "bad-gotchas",
    description:
      "the branch commits the scaffold gotchas file: PRH-GOTCHAS-MISSING under your configuration, an error status, no report ($0)",
    phases: [
      {
        // The scaffold carries the marker gotchasUnusableReason refuses, so the
        // CLI fails before admission, spend and the reservation (review-pr.ts).
        action: {
          kind: "open",
          variant: "normal",
          overrides: [{ path: GOTCHAS_PATH, contents: GOTCHAS_TEMPLATE }],
        },
        wait: "pull_request",
        checks: [
          {
            kind: "outcome",
            code: "PRH-GOTCHAS-MISSING",
            lead: "Your configuration:",
          },
          {
            kind: "status",
            state: "error",
            descriptionStartsWith: "PRH-GOTCHAS-MISSING",
          },
          { kind: "no-report" },
        ],
      },
    ],
  },
  {
    name: "review-free",
    description:
      "the normal workflow on the free route: a reviewed head, a success status, a report",
    phases: [
      {
        action: { kind: "open", variant: "normal" },
        wait: "pull_request",
        checks: [
          REVIEWED,
          STEP_SUCCEEDED,
          POSTED_STATUS,
          ONE_REPORT,
          { kind: "no-outcome" },
        ],
      },
    ],
  },
  {
    name: "cleanup",
    description:
      "an outcome comment from a failed run is deleted once a later run on the same branch completes its review",
    phases: [
      {
        action: { kind: "open", variant: "no-credential" },
        wait: "pull_request",
        checks: [{ kind: "outcome", code: "PRH-CRED-MISSING" }],
      },
      {
        action: { kind: "push", variant: "normal" },
        wait: "pull_request",
        checks: [
          REVIEWED,
          STEP_SUCCEEDED,
          POSTED_STATUS,
          ONE_REPORT,
          // The publisher's cleanup is the only thing that removes this comment.
          { kind: "no-outcome" },
        ],
      },
    ],
  },
  {
    name: "comment-trigger",
    description:
      "/pr-hero review starts an issue_comment run that completes the review, and removes the outcome comment a failed first run left",
    phases: [
      {
        action: { kind: "open", variant: "normal" },
        wait: "pull_request",
        // A precondition, not the subject: the free route may fail its hunters on
        // this first run (a flake), and the comment run is what is under test.
        // The hunters-failed tolerance and its flake label need an action ref at or
        // after T2c (98569d1), where the publisher renders PRH-HUNTERS-FAILED; on an
        // older ref an all-hunters-failed run shows `review did not finish` with no
        // PRH code, and S7 reports it.
        checks: [{ kind: "path", accept: ["reviewed", "hunters-failed"] }],
      },
      {
        action: { kind: "comment", body: "/pr-hero review" },
        wait: "issue_comment",
        // Only what this run did is asserted. Phase 1's report and status still read
        // as reviewed on this head, so a head-level check would pass a trigger that
        // ignored the command, and a skip marker from this run must not pass either:
        // a forced run bypasses admission and budget, and the diff is tiny, so the
        // only accepted result is a review with this run's own artifact.
        checks: [
          { kind: "run-completed", event: "issue_comment" },
          STEP_SUCCEEDED,
          { kind: "own-evidence" },
          REVIEWED,
        ],
        // The cleanup of phase 1's outcome comment. Only meaningful when phase 1
        // left one, so it is not asserted otherwise.
        afterPriorOutcome: [{ kind: "no-outcome" }],
      },
    ],
  },
];

export function scenarioNames(): string[] {
  return SCENARIOS.map((s) => s.name);
}

export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}
