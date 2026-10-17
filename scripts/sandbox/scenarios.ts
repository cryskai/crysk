// The scenarios, as data. A scenario is a sequence of phases. Each phase does one
// action on the scenario PR, waits for the run that action starts, observes the
// PR, and asserts its checks against that one observation. The runner in
// scenario.ts executes them; nothing here touches gh or git.
//
// Phases run in order, and a later phase starts only after the earlier one's run
// completed, so the second push of `cleanup` always meets a finished first run.

import { GOTCHAS_TEMPLATE } from "#review/preflight";
import type { Check } from "./expect";
import { GOTCHAS_PATH, MUTE_BUGGY, MUTE_PATH } from "./seed";
import type { VariantName } from "./variants";

// A file the scenario branch commits on top of the planted volume. The path is a
// seed constant, so a scenario can only replace a file the sandbox main already
// defines. Variants edit only the workflow, so this is the one other way a
// scenario changes the branch.
export interface FileOverride {
  path: typeof GOTCHAS_PATH;
  contents: string;
}

// D3: a file a later push adds. The path is a seed constant, so a scenario can only
// add a file the seed names.
export interface NewFile {
  path: typeof MUTE_PATH;
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
  // A later commit on the same branch, a plain fast-forward push. `files` are committed with it.
  | { kind: "push"; variant: VariantName; files?: readonly NewFile[] }
  // A PR comment, posted as the authenticated user.
  | { kind: "comment"; body: string }
  // T5b: reply `dismissed` on the first blocking finding's thread, then comment /pr-hero recheck.
  | { kind: "dismiss-and-recheck"; argument: string };

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
  // Asserted only when the phase before this one posted at least one blocking
  // finding comment, such as a re-run on the same head that must keep a red gate
  // red. Otherwise they are not asserted, and the runner says why.
  afterPriorBlocking?: readonly Check[];
  // SB3: once this phase's run is in progress and the head's pr-hero status is pending, cancel the run, then wait for it to complete as usual.
  cancelWhenPending?: true;
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
// S4: the free model finds different things run to run, so the status cannot be
// pinned to one state. It must agree with the blocking findings the PR shows.
const STATUS_MATCHES_FINDINGS: Check = { kind: "status-matches-findings" };
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
      "the normal workflow on the sandbox route: a reviewed head, a report, and a status that agrees with the blocking findings",
    phases: [
      {
        action: { kind: "open", variant: "normal" },
        wait: "pull_request",
        checks: [
          REVIEWED,
          STEP_SUCCEEDED,
          STATUS_MATCHES_FINDINGS,
          ONE_REPORT,
          { kind: "no-outcome" },
        ],
      },
    ],
  },
  {
    name: "review-advisory",
    description:
      "the advisory gate mode: a reviewed head whose status is success whatever the review finds (S4)",
    phases: [
      {
        action: { kind: "open", variant: "advisory" },
        wait: "pull_request",
        checks: [
          REVIEWED,
          STEP_SUCCEEDED,
          { kind: "status", state: "success" },
          ONE_REPORT,
          { kind: "no-outcome" },
        ],
      },
    ],
  },
  {
    name: "size-skip",
    description:
      "a diff over the size gate in gate mode: a skip with a failure status that names /pr-hero review, and a /pr-hero review comment that reviews the same head with its own evidence (S4)",
    phases: [
      {
        action: { kind: "open", variant: "size-skip" },
        wait: "pull_request",
        checks: [
          { kind: "path", accept: ["skipped:size"] },
          {
            kind: "status",
            state: "failure",
            descriptionStartsWith: "pr-hero skipped the review",
          },
          { kind: "no-report" },
        ],
      },
      {
        action: { kind: "comment", body: "/pr-hero review" },
        wait: "issue_comment",
        checks: [
          { kind: "run-completed", event: "issue_comment" },
          STEP_SUCCEEDED,
          { kind: "own-evidence" },
          REVIEWED,
        ],
      },
    ],
  },
  {
    name: "override",
    description:
      "the human escape hatch (S8): a red gate on a reviewed head, unlocked by a /pr-hero override comment that posts a success status and an audit comment on that head, with no review and no cost",
    phases: [
      {
        action: { kind: "open", variant: "normal" },
        wait: "pull_request",
        checks: [
          REVIEWED,
          STEP_SUCCEEDED,
          STATUS_MATCHES_FINDINGS,
          ONE_REPORT,
          { kind: "no-outcome" },
        ],
      },
      {
        action: { kind: "comment", body: "/pr-hero override" },
        wait: "issue_comment",
        checks: [
          { kind: "run-completed", event: "issue_comment" },
          {
            kind: "status",
            state: "success",
            descriptionStartsWith: "pr-hero: overridden by @",
          },
          { kind: "override-comment" },
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
          STATUS_MATCHES_FINDINGS,
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
          // The accepted command is answered with eyes on the comment (T2e).
          { kind: "reaction", content: "eyes" },
        ],
        // The cleanup of phase 1's outcome comment. Only meaningful when phase 1
        // left one, so it is not asserted otherwise.
        afterPriorOutcome: [{ kind: "no-outcome" }],
      },
    ],
  },
  {
    name: "near-miss",
    description:
      "a /pr-hero review comment that is not the exact command runs no review: it gets the confused reaction, no review evidence of its own and no outcome comment of its own (T2e)",
    phases: [
      {
        action: { kind: "open", variant: "normal" },
        wait: "pull_request",
        // A precondition, as in comment-trigger: the free route may hunters-fail here.
        checks: [{ kind: "path", accept: ["reviewed", "hunters-failed"] }],
      },
      {
        action: { kind: "comment", body: "/pr-hero review please" },
        wait: "issue_comment",
        checks: [
          { kind: "run-completed", event: "issue_comment" },
          { kind: "reaction", content: "confused" },
          // The comment's own run: it left no review evidence of its own. Phase 1's
          // outcome, when it hunters-failed, stays on the PR: only this run's count.
          { kind: "no-run-evidence" },
          { kind: "no-own-outcome" },
        ],
      },
    ],
  },
  {
    name: "same-head-rereview",
    description:
      "a blocking finding survives /pr-hero review on the same head: the gate stays red, so the author cannot re-run its way to green (S7)",
    phases: [
      {
        action: { kind: "open", variant: "normal" },
        wait: "pull_request",
        checks: [REVIEWED, STATUS_MATCHES_FINDINGS],
      },
      {
        action: { kind: "comment", body: "/pr-hero review" },
        wait: "issue_comment",
        // The comment run itself is asserted every time: the trigger is the
        // subject. Its status is asserted only when phase 1 left a blocking
        // finding to carry, because the free model's clean run has nothing to
        // carry and the scenario says so rather than failing on it.
        checks: [
          { kind: "run-completed", event: "issue_comment" },
          STEP_SUCCEEDED,
        ],
        afterPriorBlocking: [{ kind: "status", state: "failure" }],
      },
    ],
  },
  {
    name: "rereview-fresh-finding",
    description:
      "a blocking finding first found by a re-review is kept in the state block, so the next re-review still counts it (D3, T5c)",
    phases: [
      {
        action: { kind: "open", variant: "normal" },
        wait: "pull_request",
        checks: [REVIEWED],
      },
      {
        action: {
          kind: "push",
          variant: "normal",
          files: [{ path: MUTE_PATH, contents: MUTE_BUGGY }],
        },
        wait: "pull_request",
        // Admission may skip this head; the forced review below is the one under test.
        checks: [{ kind: "run-completed", event: "pull_request" }],
      },
      {
        action: { kind: "comment", body: "/pr-hero review" },
        wait: "issue_comment",
        checks: [
          { kind: "run-completed", event: "issue_comment" },
          STEP_SUCCEEDED,
          STATUS_MATCHES_FINDINGS,
          { kind: "state-row-at", path: MUTE_PATH },
        ],
      },
    ],
  },
  {
    name: "recheck-dismissal",
    description:
      "a false dismissal does not turn the gate green: /pr-hero recheck has the CI adjudicator rule on it, and it is rejected or inconclusive, so the finding still counts (T5b, D5)",
    phases: [
      {
        action: { kind: "open", variant: "normal" },
        wait: "pull_request",
        checks: [REVIEWED, STATUS_MATCHES_FINDINGS],
      },
      {
        action: {
          kind: "dismiss-and-recheck",
          argument:
            "This scaling is intentional and correct; the volume is already clamped by the caller.",
        },
        wait: "issue_comment",
        checks: [
          { kind: "run-completed", event: "issue_comment" },
          STEP_SUCCEEDED,
        ],
        afterPriorBlocking: [
          { kind: "status", state: "failure" },
          { kind: "adjudication-reply", accept: ["rejected", "inconclusive"] },
        ],
      },
    ],
  },
  {
    name: "cancel",
    description:
      "a review run cancelled mid-review leaves the pr-hero status settled, not pending (SB3)",
    phases: [
      {
        action: { kind: "open", variant: "normal" },
        wait: "pull_request",
        cancelWhenPending: true,
        checks: [
          { kind: "run-conclusion", conclusion: "cancelled" },
          { kind: "status-settled" },
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
