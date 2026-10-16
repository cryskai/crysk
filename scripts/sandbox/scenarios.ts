// The scenarios, as data. A scenario is a sequence of phases. Each phase does one
// action on the scenario PR, waits for the run that action starts, observes the
// PR, and asserts its checks against that one observation. The runner in
// scenario.ts executes them; nothing here touches gh or git.
//
// Phases run in order, and a later phase starts only after the earlier one's run
// completed, so the second push of `cleanup` always meets a finished first run.

import type { Check } from "./expect";
import type { VariantName } from "./variants";

export type Action =
  // The first phase: the branch, its first commit and the PR.
  | { kind: "open"; variant: VariantName }
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
}

export interface Scenario {
  name: string;
  description: string;
  phases: readonly Phase[];
}

const REVIEWED: Check = { kind: "path", accept: ["reviewed"] };
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
    name: "review-free",
    description:
      "the normal workflow on the free route: a reviewed head, a success status, a report",
    phases: [
      {
        action: { kind: "open", variant: "normal" },
        wait: "pull_request",
        checks: [REVIEWED, POSTED_STATUS, ONE_REPORT, { kind: "no-outcome" }],
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
      "/pr-hero review on a reviewed head starts an issue_comment run that completes the review",
    phases: [
      {
        action: { kind: "open", variant: "normal" },
        wait: "pull_request",
        checks: [REVIEWED],
      },
      {
        action: { kind: "comment", body: "/pr-hero review" },
        wait: "issue_comment",
        checks: [
          { kind: "run-completed", event: "issue_comment" },
          // The comment's own review step, not the first run's report on the same head.
          { kind: "step-succeeded" },
          // A forced run may review again or skip with a recorded reason; the
          // source says force bypasses every skip gate, so a skip here is a signal.
          { kind: "path", accept: ["reviewed", "skipped"] },
          POSTED_STATUS,
          ONE_REPORT,
        ],
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
