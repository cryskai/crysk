// The pure builder behind `pr-hero status` (src/pr/pr-status.ts). Raw GitHub facts go in,
// the status object comes out, and no I/O happens here: the shell's fake-gh tests live in
// test/commands/status.test.ts. This file pins what the skill acts on: every next_action
// branch, the override read, the join from a posted finding to its state-block row, the
// triage a finding is owed at its own head, and the two sources of unresolved_blocking.

import { describe, expect, test } from "bun:test";
import { OVERRIDE_DESCRIPTION_PREFIX } from "#ci/override";
import {
  buildPrStatus,
  type PrStatusInput,
  type PrStatusReviewComment,
  renderPrStatusLines,
} from "#pr/pr-status";
import {
  COMMIT_STATUS_CONTEXT,
  type CommitStatusFact,
  findingMarker,
} from "#pr/preflight";
import { type RecoveredTier, TIER_UNRECOVERABLE } from "#rereview/classify";
import {
  renderStateBlock,
  type StateFinding,
  stateFinding,
} from "#rereview/state";
import { adjudicationMarker, CI_ADJUDICATOR_LOGIN } from "#triage/adjudication";
import {
  type TriageTag,
  type TriageVerdict,
  triageMarker,
} from "#triage/triage";

const EARLIER = "1".repeat(40);
const CURRENT = "2".repeat(40);
const NOW = Date.parse("2026-10-17T12:00:00Z");

// Minutes before NOW, as the ISO timestamp GitHub would return.
function at(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString();
}

function gate(
  state: string,
  description: string | null,
  minutesAgo = 5,
  targetUrl: string | null = null,
): CommitStatusFact {
  return {
    state,
    context: COMMIT_STATUS_CONTEXT,
    created_at: at(minutesAgo),
    description,
    target_url: targetUrl,
  };
}

const BLOCKING_DESCRIPTION = (n: number) =>
  `pr-hero: ${n} blocking finding(s) — fix and push, or /pr-hero override`;
const OVERRIDE_DESCRIPTION = `${OVERRIDE_DESCRIPTION_PREFIX}maintainer — no review on this head`;
const SKIP_DESCRIPTION =
  "pr-hero skipped the review: diff over the size gate. /pr-hero review reviews it anyway";

// One pr-hero summary comment, its state block carrying `rows` (the live findings).
function summary(
  head: string,
  rows: StateFinding[] = [],
  options: { complete?: boolean; reviews?: number } = {},
): string {
  const partial = options.complete === false ? " coverage=partial" : "";
  return [
    `<!-- pr-hero-report head=${head}${partial} -->`,
    "",
    "### Summary",
    "",
    renderStateBlock(head, rows, options.reviews),
  ].join("\n");
}

function stateRow(
  id: string,
  claim: string,
  tier: RecoveredTier = "blocking",
  loc = "src/a.ts:10",
): StateFinding {
  return stateFinding({
    id,
    sev: "CRITICAL",
    tier,
    channel: "inline",
    locs: [loc],
    claim,
  });
}

// A posted finding comment, as renderInlineComment writes it: marker, header, location, claim.
function findingBody(options: {
  head: string;
  claim: string;
  tier?: "blocking" | "advisory";
  path?: string;
  line?: number;
  withHeader?: boolean;
}): string {
  const path = options.path ?? "src/a.ts";
  const line = options.line ?? 10;
  const tier = options.tier ?? "blocking";
  const marker = findingMarker({
    path,
    line,
    headSha: options.head,
    claim: options.claim,
  });
  const header =
    options.withHeader === false
      ? []
      : [
          `${tier === "blocking" ? "🔴" : "🔵"} ${tier} · CRITICAL · introduced · reliability`,
          "",
        ];
  return [marker, "", ...header, `\`${path}:${line}\``, "", options.claim].join(
    "\n",
  );
}

function triageReply(options: {
  id: number;
  parent: number;
  head: string;
  tag: TriageTag;
  verdict?: TriageVerdict;
  actor?: "agent" | "human";
}): { id: number; body: string; in_reply_to_id: number | null } {
  return {
    id: options.id,
    body: `${triageMarker({
      tag: options.tag,
      headSha: options.head,
      actor: options.actor ?? "agent",
      ...(options.verdict === undefined ? {} : { verdict: options.verdict }),
    })}\n\nreasoning`,
    in_reply_to_id: options.parent,
  };
}

function input(overrides: Partial<PrStatusInput> = {}): PrStatusInput {
  return {
    pr: 12,
    head: CURRENT,
    nowMs: NOW,
    statuses: [],
    issueComments: [],
    reviewComments: [],
    ...overrides,
  };
}

const CLAIM = "the value is stored in seconds and read as milliseconds";

describe("buildPrStatus: next_action, first match wins", () => {
  // Each row is one branch of the table in docs/github-actions.md. The gate and the
  // comments are the whole input; the expectation is the action and the gate state.
  const cases: {
    name: string;
    input: PrStatusInput;
    action: string;
    state: string;
  }[] = [
    {
      name: "a pending gate in flight waits",
      input: input({ statuses: [gate("pending", "pr-hero reviewing", 5)] }),
      action: "wait",
      state: "pending",
    },
    {
      name: "a pending gate past the 90-minute window is not in flight, so review",
      input: input({ statuses: [gate("pending", "pr-hero reviewing", 120)] }),
      action: "review",
      state: "pending",
    },
    {
      name: "no pr-hero status on the head means review",
      input: input(),
      action: "review",
      state: "none",
    },
    {
      name: "an errored gate means review",
      input: input({ statuses: [gate("error", "review did not finish")] }),
      action: "review",
      state: "error",
    },
    {
      name: "a passed gate is done",
      input: input({ statuses: [gate("success", "review posted")] }),
      action: "done",
      state: "success",
    },
    {
      name: "an override that turned the gate green is done",
      input: input({ statuses: [gate("success", OVERRIDE_DESCRIPTION)] }),
      action: "done",
      state: "success",
    },
    {
      name: "a red gate with an untriaged blocking finding on this head needs triage",
      input: input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(1))],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
        ],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [stateRow("R001", CLAIM)]),
          },
        ],
      }),
      action: "triage",
      state: "failure",
    },
    {
      name: "a red gate whose dismissed blocking finding has no CI ruling needs a recheck",
      input: input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(1))],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
          triageReply({
            id: 2,
            parent: 1,
            head: CURRENT,
            tag: "dismissed",
            verdict: "upheld",
          }),
        ],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [stateRow("R001", CLAIM)]),
          },
        ],
      }),
      action: "recheck",
      state: "failure",
    },
    {
      name: "a red gate with an applied blocking finding needs a fix",
      input: input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(1))],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
          triageReply({ id: 2, parent: 1, head: CURRENT, tag: "applied" }),
        ],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [stateRow("R001", CLAIM)]),
          },
        ],
      }),
      action: "fix",
      state: "failure",
    },
    {
      name: "a triage reply at another head does not count as triage at the posted head",
      input: input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(1))],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: EARLIER, claim: CLAIM }),
            in_reply_to_id: null,
          },
          triageReply({
            id: 2,
            parent: 1,
            head: CURRENT,
            tag: "applied",
          }),
        ],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [stateRow("R001", CLAIM)]),
          },
        ],
      }),
      action: "triage",
      state: "failure",
    },
    {
      name: "one untriaged blocking finding outranks an applied one",
      input: input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(2))],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
          triageReply({ id: 2, parent: 1, head: CURRENT, tag: "applied" }),
          {
            id: 3,
            body: findingBody({
              head: CURRENT,
              claim: "a second claim that nobody has answered",
              line: 20,
            }),
            in_reply_to_id: null,
          },
        ],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM),
              stateRow("R002", "a second claim that nobody has answered"),
            ]),
          },
        ],
      }),
      action: "triage",
      state: "failure",
    },
    {
      name: "a skipped review with no blocking finding is override-or-fix",
      input: input({ statuses: [gate("failure", SKIP_DESCRIPTION)] }),
      action: "override-or-fix",
      state: "failure",
    },
  ];

  for (const row of cases) {
    test(row.name, () => {
      const status = buildPrStatus(row.input);
      expect(status.next_action).toBe(row.action as typeof status.next_action);
      expect(status.gate.state).toBe(row.state as typeof status.gate.state);
      expect(status.reason.length).toBeGreaterThan(0);
    });
  }

  test("the stale-pending reason names the 90-minute window, so an operator sees why review", () => {
    const status = buildPrStatus(
      input({ statuses: [gate("pending", "pr-hero reviewing", 120)] }),
    );
    expect(status.reason).toMatch(/90-minute/);
  });

  test("the skip reason names the skip, so the skill is not misled into a fix", () => {
    const status = buildPrStatus(
      input({ statuses: [gate("failure", SKIP_DESCRIPTION)] }),
    );
    expect(status.reason).toMatch(/skipped/);
  });
});

describe("buildPrStatus: gate", () => {
  test("pending_in_flight is true for a fresh pending and false for a stale one", () => {
    expect(
      buildPrStatus(input({ statuses: [gate("pending", "x", 5)] })).gate
        .pending_in_flight,
    ).toBe(true);
    expect(
      buildPrStatus(input({ statuses: [gate("pending", "x", 120)] })).gate
        .pending_in_flight,
    ).toBe(false);
  });

  test("the override is active only on a newest success with the prefix, and names its login", () => {
    const override = buildPrStatus(
      input({ statuses: [gate("success", OVERRIDE_DESCRIPTION)] }),
    ).gate.override;
    expect(override).toEqual({ active: true, by: "maintainer" });
    const plain = buildPrStatus(
      input({ statuses: [gate("success", "review posted")] }),
    ).gate.override;
    expect(plain).toEqual({ active: false, by: null });
  });

  test("an override that a later review superseded is not the newest, so it is not active", () => {
    const status = buildPrStatus(
      input({
        statuses: [
          gate("success", OVERRIDE_DESCRIPTION, 30),
          gate("failure", BLOCKING_DESCRIPTION(1), 5),
        ],
      }),
    );
    expect(status.gate.state).toBe("failure");
    expect(status.gate.override).toEqual({ active: false, by: null });
  });

  test("the gate carries its description, target_url and created_at from the newest row", () => {
    const url = "https://github.com/MusiveTech/musive/actions/runs/9";
    const status = buildPrStatus(
      input({ statuses: [gate("success", "review posted", 5, url)] }),
    );
    expect(status.gate.description).toBe("review posted");
    expect(status.gate.target_url).toBe(url);
    expect(status.gate.created_at).toBe(at(5));
  });

  test("with no status, the gate's fields are null, not invented", () => {
    const status = buildPrStatus(input());
    expect(status.gate).toEqual({
      state: "none",
      description: null,
      target_url: null,
      created_at: null,
      pending_in_flight: false,
      override: { active: false, by: null },
    });
  });
});

describe("buildPrStatus: report and output shape", () => {
  test("the envelope names its schema, the PR and the PR's head", () => {
    const status = buildPrStatus(input());
    expect(status.schema).toBe("pr-hero.status/v1");
    expect(status.pr).toBe(12);
    expect(status.head).toBe(CURRENT);
  });

  test("the report reads the summary's head, completeness and reviews", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          { id: 100, body: summary(CURRENT, [], { reviews: 3 }) },
        ],
      }),
    );
    expect(status.report).toEqual({
      head: CURRENT,
      complete: true,
      reviews: 3,
      outcome_code: null,
    });
  });

  test("a partial summary reads as incomplete, not complete", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          { id: 100, body: summary(CURRENT, [], { complete: false }) },
        ],
      }),
    );
    expect(status.report.complete).toBe(false);
  });

  test("with no summary the report fields are null, and nothing is invented", () => {
    expect(buildPrStatus(input()).report).toEqual({
      head: null,
      complete: null,
      reviews: null,
      outcome_code: null,
    });
  });

  test("outcome_code is the newest outcome comment's code", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          {
            id: 200,
            body: `<!-- pr-hero-outcome v=1 head=${CURRENT} run=1 attempt=1 -->\n\n### PRH-CRED-MISSING\n\nbody`,
          },
          {
            id: 201,
            body: `<!-- pr-hero-outcome v=1 head=${CURRENT} run=2 attempt=1 -->\n\n### PRH-CANCELLED: not reviewed\n\nbody`,
          },
        ],
      }),
    );
    expect(status.report.outcome_code).toBe("PRH-CANCELLED");
  });

  test("an older outcome's code is not used when the newest outcome has none", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          {
            id: 200,
            body: `<!-- pr-hero-outcome v=1 head=${CURRENT} run=1 attempt=1 -->\n\n### PRH-CRED-MISSING`,
          },
          {
            id: 201,
            body: `<!-- pr-hero-outcome v=1 head=${CURRENT} run=2 attempt=1 -->\n\nno heading`,
          },
        ],
      }),
    );
    expect(status.report.outcome_code).toBeNull();
  });

  test("the line renderer names the action and never carries an escape byte", () => {
    const lines = renderPrStatusLines(
      buildPrStatus(input({ statuses: [gate("success", "review posted")] })),
    );
    expect(lines.join("\n")).toContain("done");
    for (const line of lines) expect(line).not.toContain("\x1b");
  });
});

describe("buildPrStatus: findings", () => {
  test("a posted finding is reported from its marker, on its own head", () => {
    const status = buildPrStatus(
      input({
        reviewComments: [
          {
            id: 41,
            body: findingBody({ head: EARLIER, claim: CLAIM, line: 33 }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.findings).toEqual([
      {
        id: null,
        path: "src/a.ts",
        line: 33,
        head: EARLIER,
        comment_id: 41,
        channel: "inline",
        severity: "CRITICAL",
        tier: "blocking",
        blocking: true,
        live_on_head: false,
        triage: null,
        ci_verdict: null,
      },
    ]);
  });

  test("an issue-comment finding is the outside channel, and findings come out in comment order", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          {
            id: 60,
            body: findingBody({ head: CURRENT, claim: "b", path: "src/b.ts" }),
          },
        ],
        reviewComments: [
          {
            id: 50,
            body: findingBody({ head: CURRENT, claim: "a" }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.findings.map((f) => [f.comment_id, f.channel])).toEqual([
      [50, "inline"],
      [60, "outside"],
    ]);
  });

  test("a comment without a finding marker is not a finding, and neither is the summary", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          { id: 100, body: summary(CURRENT, [stateRow("R001", CLAIM)]) },
          { id: 101, body: "a human's reply, with no marker at all" },
        ],
      }),
    );
    // The state row is a live finding with no thread (the gate counts it), so it is emitted; the
    // human reply and the summary are still not findings.
    expect(status.findings.map((f) => [f.id, f.comment_id])).toEqual([
      ["R001", null],
    ]);
  });

  test("the state block joins a finding by claim fingerprint and supplies the id", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          { id: 100, body: summary(CURRENT, [stateRow("R002", CLAIM)]) },
        ],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.findings[0]?.id).toBe("R002");
    expect(status.findings[0]?.live_on_head).toBe(true);
  });

  test("the severity and tier come from the header, and the state row supplies them when the header is missing", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [stateRow("R003", CLAIM, "advisory")]),
          },
        ],
        reviewComments: [
          {
            id: 1,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              withHeader: false,
            }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.findings[0]).toMatchObject({
      id: "R003",
      severity: "CRITICAL",
      tier: "advisory",
    });
  });

  test("a claim-less state row joins by its location, the way the engine binds a prior with no claim", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          { id: 100, body: summary(CURRENT, [stateRow("R004", "")]) },
        ],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.findings[0]?.id).toBe("R004");
  });

  test("two findings with the same claim on different paths join to different rows", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM, "blocking", "src/a.ts:10"),
              stateRow("R002", CLAIM, "blocking", "src/b.ts:10"),
            ]),
          },
        ],
        reviewComments: [
          {
            id: 1,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              path: "src/a.ts",
            }),
            in_reply_to_id: null,
          },
          {
            id: 2,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              path: "src/b.ts",
            }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.findings.map((f) => f.id)).toEqual(["R001", "R002"]);
  });

  test("a finding whose row sits on another path does not join it, and is live only on its own head", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM, "blocking", "src/a.ts:10"),
            ]),
          },
        ],
        reviewComments: [
          {
            id: 1,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              path: "src/b.ts",
            }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.findings[0]?.id).toBeNull();
    expect(status.findings[0]?.live_on_head).toBe(true);
  });

  test("live_on_head is true for a state-block row or a finding posted on this head, and false otherwise", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [stateRow("R005", "carried claim")]),
          },
        ],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: EARLIER, claim: "carried claim" }),
            in_reply_to_id: null,
          },
          {
            id: 2,
            body: findingBody({
              head: EARLIER,
              claim: "a fixed claim",
              line: 5,
            }),
            in_reply_to_id: null,
          },
          {
            id: 3,
            body: findingBody({ head: CURRENT, claim: "a new claim", line: 6 }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.findings.map((f) => f.live_on_head)).toEqual([
      true,
      false,
      true,
    ]);
  });

  test("triage is the newest reply in the thread, and applied has no verdict", () => {
    const status = buildPrStatus(
      input({
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
          triageReply({
            id: 2,
            parent: 1,
            head: CURRENT,
            tag: "dismissed",
            verdict: "rejected",
          }),
          triageReply({ id: 3, parent: 1, head: CURRENT, tag: "applied" }),
        ],
      }),
    );
    expect(status.findings[0]?.triage).toEqual({
      tag: "applied",
      verdict: null,
      actor: "agent",
      head: CURRENT,
    });
  });

  test("a reply to another thread is not this finding's triage", () => {
    const status = buildPrStatus(
      input({
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
          triageReply({ id: 2, parent: 99, head: CURRENT, tag: "applied" }),
        ],
      }),
    );
    expect(status.findings[0]?.triage).toBeNull();
  });
});

describe("buildPrStatus: a renamed file still joins its state row", () => {
  // The re-review rewrites a row's locs to the new path, while the posted comment's marker keeps
  // the path it was posted on. GitHub's live review comment follows the rename, so its live path
  // binds the row, as the engine's own callers do (pr/discovery.ts passes livePath and liveLine).
  test("a row on the new path binds through the live path, so the finding is live and owes triage", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", "pr-hero: gate red, see the findings")],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM, "blocking", "src/new.ts:10"),
            ]),
          },
        ],
        reviewComments: [
          {
            id: 41,
            body: findingBody({
              head: EARLIER,
              claim: CLAIM,
              path: "src/old.ts",
              line: 10,
              tier: "blocking",
            }),
            in_reply_to_id: null,
            path: "src/new.ts",
            line: 10,
          },
        ],
      }),
    );
    const [finding] = status.findings;
    expect(finding?.id).toBe("R001");
    expect(finding?.live_on_head).toBe(true);
    expect(status.next_action).toBe("triage");
  });
});

describe("buildPrStatus: an unrecoverable tier still blocks", () => {
  // The gate's own rule counts a row whose tier cannot be read as blocking (rereview/state.ts
  // unresolvedBlockingCount), and a finding with no readable tier at all is unrecoverable too
  // (priorsFromPostedMarkers), so this read counts both. The tier reads as unrecoverable, never null:
  // an unreadable tier is named, not dropped.
  test("an unrecoverable live finding with no reply on a red gate is triage, not override-or-fix", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", "pr-hero: gate red, see the findings")],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM, TIER_UNRECOVERABLE),
            ]),
          },
        ],
        reviewComments: [
          {
            id: 41,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              withHeader: false,
            }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.next_action).toBe("triage");
    expect(status.unresolved_blocking).toBe(1);
  });

  test("blocking is true for an unrecoverable tier and false for an advisory one, and tier stays as reported", () => {
    const status = buildPrStatus(
      input({
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM, TIER_UNRECOVERABLE),
              stateRow(
                "R002",
                "a second claim the reviewers raised as advisory",
                "advisory",
                "src/b.ts:20",
              ),
            ]),
          },
        ],
        reviewComments: [
          {
            id: 41,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              withHeader: false,
            }),
            in_reply_to_id: null,
          },
          {
            id: 42,
            body: findingBody({
              head: CURRENT,
              claim: "a second claim the reviewers raised as advisory",
              tier: "advisory",
              path: "src/b.ts",
              line: 20,
            }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    const [unrecoverable, advisory] = status.findings;
    expect(unrecoverable?.tier).toBe(TIER_UNRECOVERABLE);
    expect(unrecoverable?.blocking).toBe(true);
    expect(advisory?.tier).toBe("advisory");
    expect(advisory?.blocking).toBe(false);
  });

  test("an unparseable badge with no state row blocks: tier is unrecoverable and the finding is counted", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", "pr-hero: gate red, see the findings")],
        reviewComments: [
          {
            id: 41,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              withHeader: false,
            }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    const [finding] = status.findings;
    expect(finding?.id).toBeNull();
    expect(finding?.tier).toBe(TIER_UNRECOVERABLE);
    expect(finding?.blocking).toBe(true);
    expect(status.unresolved_blocking).toBe(1);
    expect(status.next_action).toBe("triage");
  });
});

describe("buildPrStatus: unresolved_blocking", () => {
  test("a red gate's own count wins when its description carries one", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(3))],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
        ],
        issueComments: [
          { id: 100, body: summary(CURRENT, [stateRow("R001", CLAIM)]) },
        ],
      }),
    );
    expect(status.unresolved_blocking).toBe(3);
  });

  test("with no count in the description, it is the live blocking findings on this head", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", SKIP_DESCRIPTION)],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
          {
            id: 2,
            body: findingBody({
              head: EARLIER,
              claim: "an advisory claim",
              tier: "advisory",
              line: 4,
            }),
            in_reply_to_id: null,
          },
        ],
        issueComments: [
          { id: 100, body: summary(CURRENT, [stateRow("R001", CLAIM)]) },
        ],
      }),
    );
    expect(status.unresolved_blocking).toBe(1);
  });

  test("a finding posted on an older head with no state row is not counted as live", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", SKIP_DESCRIPTION)],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: EARLIER, claim: CLAIM }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.unresolved_blocking).toBe(0);
  });
});

// A top-level issue-comment reply (the outside-channel finding's only kind of reply). It
// binds to its finding by the link triage/reply writes: `In reply to: <url>#issuecomment-<id>`.
function issueReply(options: {
  id: number;
  parent: number;
  head: string;
  tag: TriageTag;
  verdict?: TriageVerdict;
}): { id: number; body: string } {
  return {
    id: options.id,
    body: [
      triageMarker({
        tag: options.tag,
        headSha: options.head,
        actor: "agent",
        ...(options.verdict === undefined ? {} : { verdict: options.verdict }),
      }),
      "",
      "reasoning",
      "",
      `In reply to: https://github.com/MusiveTech/musive/pull/12#issuecomment-${options.parent}`,
    ].join("\n"),
  };
}

// A green gate is not the end of the loop while a finding on this head has no reply. The
// triage skill answers every finding, advisory included, so `done` needs every finding posted
// on the current head to be answered at that head. An override is a human's unlock, so it stays
// `done` whatever the findings say.
describe("buildPrStatus: a red partial review is run again (S6)", () => {
  const PARTIAL =
    "pr-hero: review partial (1 of 4 hunters failed) — /pr-hero review retries it";
  const PARTIAL_CARRIED =
    "pr-hero: review partial (1 of 4 hunters failed) carried from aaaaaaa — /pr-hero review retries it";

  test("a red gate that is a partial review is review, naming the partial review and the retry", () => {
    const status = buildPrStatus(
      input({ statuses: [gate("failure", PARTIAL)] }),
    );
    expect(status.next_action).toBe("review");
    expect(status.reason).toBe(
      "The last review of this head was partial (some reviewers failed); run /pr-hero review, which retries it. If the same reviewers fail every time (an unavailable model, a broken route), fix that route or override the gate.",
    );
  });

  test("the carried form of the partial review reads the same way", () => {
    const status = buildPrStatus(
      input({ statuses: [gate("failure", PARTIAL_CARRIED)] }),
    );
    expect(status.next_action).toBe("review");
  });

  // W3-PARTIAL F004: a retry already failed the same way, so the repeat form asks for a route fix or an override, not review.
  test("the repeat form of the partial review asks for a fix or an override", () => {
    const REPEAT =
      "pr-hero: review partial again (1 of 4 hunters failed) — fix the failing route or /pr-hero override";
    const status = buildPrStatus(
      input({ statuses: [gate("failure", REPEAT)] }),
    );
    expect(status.next_action).toBe("override-or-fix");
    expect(status.reason).toBe(
      "The review is partial again with the same failure counts: a retry already failed the same way; fix the failing hunter's route (model or provider) or run /pr-hero override.",
    );
  });

  test("a red partial review names no blocking count: unresolved_blocking is the live count, zero here", () => {
    const status = buildPrStatus(
      input({ statuses: [gate("failure", PARTIAL)] }),
    );
    expect(status.unresolved_blocking).toBe(0);
  });
});

describe("buildPrStatus: a partial review of this head is run again", () => {
  // The engine's own admission re-runs a partial review of the same head (partialSameHead in
  // ci/review-admission.ts). A green gate over such a review must read as review, not done, or
  // a partial run settles as complete. The same marker on an older head is that head's history.
  test("a green gate over a partial review of this head is review, with the partial reason", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("success", "pr-hero: review passed")],
        issueComments: [
          { id: 100, body: summary(CURRENT, [], { complete: false }) },
        ],
      }),
    );
    expect(status.next_action).toBe("review");
    expect(status.reason).toBe(
      "The last review of this head was partial (some reviewers failed); run /pr-hero review.",
    );
  });

  test("a green gate over a partial review of an older head keeps the normal rows", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("success", "pr-hero: review passed")],
        issueComments: [
          { id: 100, body: summary(EARLIER, [], { complete: false }) },
        ],
      }),
    );
    expect(status.next_action).toBe("done");
  });
});

describe("buildPrStatus: a green gate still owes a reply on this head", () => {
  const green = (extra: Partial<PrStatusInput> = {}) =>
    input({ statuses: [gate("success", "review posted")], ...extra });

  test("green plus one untriaged advisory on this head is triage, and the reason counts it", () => {
    const status = buildPrStatus(
      green({
        reviewComments: [
          {
            id: 1,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              tier: "advisory",
            }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.next_action).toBe("triage");
    expect(status.reason).toMatch(
      /^The gate is green, but 1 finding\(s\) on this head have no reply yet/,
    );
    expect(status.unresolved_blocking).toBe(0);
  });

  test("green with every finding on this head triaged at this head is done", () => {
    const status = buildPrStatus(
      green({
        reviewComments: [
          {
            id: 1,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              tier: "advisory",
            }),
            in_reply_to_id: null,
          },
          triageReply({
            id: 2,
            parent: 1,
            head: CURRENT,
            tag: "dismissed",
            verdict: "upheld",
          }),
          {
            id: 3,
            body: findingBody({
              head: CURRENT,
              claim: "a second claim",
              line: 20,
            }),
            in_reply_to_id: null,
          },
          triageReply({ id: 4, parent: 3, head: CURRENT, tag: "applied" }),
        ],
      }),
    );
    expect(status.next_action).toBe("done");
  });

  test("green with an untriaged finding only on an older head is done", () => {
    const status = buildPrStatus(
      green({
        reviewComments: [
          {
            id: 1,
            body: findingBody({
              head: EARLIER,
              claim: CLAIM,
              tier: "advisory",
            }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.next_action).toBe("done");
  });

  test("an override with an untriaged finding on this head is done", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("success", OVERRIDE_DESCRIPTION)],
        reviewComments: [
          {
            id: 1,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              tier: "advisory",
            }),
            in_reply_to_id: null,
          },
        ],
      }),
    );
    expect(status.next_action).toBe("done");
    expect(status.gate.override.active).toBe(true);
  });

  test("a reply at another head does not answer a green gate's finding on this head", () => {
    const status = buildPrStatus(
      green({
        reviewComments: [
          {
            id: 1,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              tier: "advisory",
            }),
            in_reply_to_id: null,
          },
          triageReply({
            id: 2,
            parent: 1,
            head: EARLIER,
            tag: "dismissed",
            verdict: "upheld",
          }),
        ],
      }),
    );
    expect(status.next_action).toBe("triage");
  });

  test("an outside-channel finding on this head with no reply is owed one", () => {
    const status = buildPrStatus(
      green({
        issueComments: [
          {
            id: 60,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              tier: "advisory",
            }),
          },
        ],
      }),
    );
    expect(status.next_action).toBe("triage");
  });

  test("an outside-channel finding answered by a reply that links it, at this head, is done", () => {
    const status = buildPrStatus(
      green({
        issueComments: [
          {
            id: 60,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              tier: "advisory",
            }),
          },
          issueReply({
            id: 61,
            parent: 60,
            head: CURRENT,
            tag: "dismissed",
            verdict: "upheld",
          }),
        ],
      }),
    );
    expect(status.next_action).toBe("done");
    expect(status.findings[0]?.triage).toEqual({
      tag: "dismissed",
      verdict: "upheld",
      actor: "agent",
      head: CURRENT,
    });
  });

  test("an issue reply that links a different comment does not answer this finding", () => {
    const status = buildPrStatus(
      green({
        issueComments: [
          {
            id: 60,
            body: findingBody({
              head: CURRENT,
              claim: CLAIM,
              tier: "advisory",
            }),
          },
          issueReply({
            id: 61,
            parent: 6,
            head: CURRENT,
            tag: "dismissed",
            verdict: "upheld",
          }),
        ],
      }),
    );
    expect(status.next_action).toBe("triage");
  });

  test("a red gate whose blocking outside-channel finding is answered at this head is override-or-fix, never a recheck that cannot settle it", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(1))],
        issueComments: [
          {
            id: 60,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
          },
          issueReply({
            id: 61,
            parent: 60,
            head: CURRENT,
            tag: "dismissed",
            verdict: "upheld",
          }),
        ],
      }),
    );
    // An outside-channel finding has no review thread, so the CI adjudicator never rules on it:
    // a recheck could not settle it, and only a fix or an override can.
    expect(status.next_action).toBe("override-or-fix");
  });
});

describe("buildPrStatus: the CI adjudicator's ruling on a dismissal", () => {
  const CLAIM_TWO = "a second claim the author dismissed on another line";
  const NEW_REASON =
    "The gate is red with 1 live blocking finding(s), all triaged and none applied or pending a CI ruling (a rejected dismissal, or a deferred or misclassified tag, never leaves the count): fix and push, or override the gate.";

  // One blocking inline finding whose newest reply is a dismissed, upheld triage at CURRENT.
  function dismissed(extra: PrStatusReviewComment[] = []): PrStatusInput {
    return input({
      statuses: [gate("failure", BLOCKING_DESCRIPTION(1))],
      reviewComments: [
        {
          id: 1,
          body: findingBody({ head: CURRENT, claim: CLAIM }),
          in_reply_to_id: null,
        },
        triageReply({
          id: 2,
          parent: 1,
          head: CURRENT,
          tag: "dismissed",
          verdict: "upheld",
        }),
        ...extra,
      ],
      issueComments: [
        { id: 100, body: summary(CURRENT, [stateRow("R001", CLAIM)]) },
      ],
    });
  }

  function ruling(options: {
    id: number;
    user: string;
    reply: number;
    verdict: "upheld" | "rejected" | "inconclusive";
    head?: string;
  }): PrStatusReviewComment {
    return {
      id: options.id,
      user: options.user,
      body: `${adjudicationMarker({
        verdict: options.verdict,
        reply: options.reply,
        head: options.head ?? CURRENT,
      })}\n\nruling`,
      in_reply_to_id: 1,
    };
  }

  test("(a) a dismissal with no bot reply has no ruling and needs a recheck", () => {
    const status = buildPrStatus(dismissed());
    expect(status.findings[0]?.ci_verdict).toBeNull();
    expect(status.next_action).toBe("recheck");
    expect(status.reason).toMatch(/comment \/pr-hero recheck/);
  });

  test("(b) a bot ruling upheld on the newest reply and this head counts, and the review no longer waits on it", () => {
    const status = buildPrStatus(
      dismissed([
        ruling({
          id: 3,
          user: CI_ADJUDICATOR_LOGIN,
          reply: 2,
          verdict: "upheld",
        }),
      ]),
    );
    expect(status.findings[0]?.ci_verdict).toBe("upheld");
    expect(status.next_action).toBe("review");
    expect(status.reason).toMatch(/upheld every dismissal/);
  });

  // #348 F002: the gate counts a blocking finding this read cannot see (one only in the summary).
  test("(j) every visible dismissal upheld, but the gate counts more: not review again", () => {
    const upheld = ruling({
      id: 3,
      user: CI_ADJUDICATOR_LOGIN,
      reply: 2,
      verdict: "upheld",
    });
    const status = buildPrStatus({
      ...dismissed([upheld]),
      statuses: [gate("failure", BLOCKING_DESCRIPTION(2))],
    });
    expect(status.next_action).toBe("override-or-fix");
  });

  // #348 F001: an upheld dismissal left the gate's count, so the fallback count leaves it too.
  test("(k) a green gate after the review that consumed an upheld dismissal reports 0 unresolved", () => {
    const upheld = ruling({
      id: 3,
      user: CI_ADJUDICATOR_LOGIN,
      reply: 2,
      verdict: "upheld",
    });
    const status = buildPrStatus({
      ...dismissed([upheld]),
      statuses: [gate("success", "review posted")],
    });
    expect(status.unresolved_blocking).toBe(0);
  });

  test("(c) the same marker posted by another login is not the adjudicator's ruling", () => {
    const status = buildPrStatus(
      dismissed([
        ruling({ id: 3, user: "mallory", reply: 2, verdict: "upheld" }),
      ]),
    );
    expect(status.findings[0]?.ci_verdict).toBeNull();
    expect(status.next_action).toBe("recheck");
  });

  test("(d) a bot ruling on another head is not counted", () => {
    const status = buildPrStatus(
      dismissed([
        ruling({
          id: 3,
          user: CI_ADJUDICATOR_LOGIN,
          reply: 2,
          verdict: "upheld",
          head: EARLIER,
        }),
      ]),
    );
    expect(status.findings[0]?.ci_verdict).toBeNull();
    expect(status.next_action).toBe("recheck");
  });

  test("(e) a bot ruling on an older triage reply does not rule on a newer dismissal", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(1))],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
          triageReply({
            id: 2,
            parent: 1,
            head: CURRENT,
            tag: "dismissed",
            verdict: "upheld",
          }),
          triageReply({
            id: 4,
            parent: 1,
            head: CURRENT,
            tag: "dismissed",
            verdict: "upheld",
          }),
          ruling({
            id: 5,
            user: CI_ADJUDICATOR_LOGIN,
            reply: 2,
            verdict: "upheld",
          }),
        ],
        issueComments: [
          { id: 100, body: summary(CURRENT, [stateRow("R001", CLAIM)]) },
        ],
      }),
    );
    expect(status.findings[0]?.ci_verdict).toBeNull();
    expect(status.next_action).toBe("recheck");
  });

  test("(f) an inconclusive bot ruling still needs a recheck", () => {
    const status = buildPrStatus(
      dismissed([
        ruling({
          id: 3,
          user: CI_ADJUDICATOR_LOGIN,
          reply: 2,
          verdict: "inconclusive",
        }),
      ]),
    );
    expect(status.findings[0]?.ci_verdict).toBe("inconclusive");
    expect(status.next_action).toBe("recheck");
  });

  test("(g) a bot ruling rejected leaves the dismissal counted, with the new reason text", () => {
    const status = buildPrStatus(
      dismissed([
        ruling({
          id: 3,
          user: CI_ADJUDICATOR_LOGIN,
          reply: 2,
          verdict: "rejected",
        }),
      ]),
    );
    expect(status.findings[0]?.ci_verdict).toBe("rejected");
    expect(status.next_action).toBe("override-or-fix");
    expect(status.reason).toBe(NEW_REASON);
  });

  test("(h) a live deferred finding keeps the gate red even when the dismissal was upheld", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(2))],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
          triageReply({
            id: 2,
            parent: 1,
            head: CURRENT,
            tag: "dismissed",
            verdict: "upheld",
          }),
          ruling({
            id: 3,
            user: CI_ADJUDICATOR_LOGIN,
            reply: 2,
            verdict: "upheld",
          }),
          {
            id: 4,
            body: findingBody({ head: CURRENT, claim: CLAIM_TWO, line: 20 }),
            in_reply_to_id: null,
          },
          triageReply({
            id: 5,
            parent: 4,
            head: CURRENT,
            tag: "deferred",
            verdict: "upheld",
          }),
        ],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM),
              stateRow("R002", CLAIM_TWO, "blocking", "src/a.ts:20"),
            ]),
          },
        ],
      }),
    );
    expect(status.next_action).not.toBe("review");
    expect(status.next_action).toBe("override-or-fix");
  });

  test("(i) an applied finding still wins over a ruled dismissal", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(2))],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
          triageReply({
            id: 2,
            parent: 1,
            head: CURRENT,
            tag: "dismissed",
            verdict: "upheld",
          }),
          ruling({
            id: 3,
            user: CI_ADJUDICATOR_LOGIN,
            reply: 2,
            verdict: "upheld",
          }),
          {
            id: 4,
            body: findingBody({ head: CURRENT, claim: CLAIM_TWO, line: 20 }),
            in_reply_to_id: null,
          },
          triageReply({ id: 5, parent: 4, head: CURRENT, tag: "applied" }),
        ],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM),
              stateRow("R002", CLAIM_TWO),
            ]),
          },
        ],
      }),
    );
    expect(status.next_action).toBe("fix");
  });
});

describe("buildPrStatus: a live blocking row with no comment thread", () => {
  const CLAIM_TWO = "a second claim that only the state block carries";
  const BUDGET_DESCRIPTION =
    "pr-hero: review budget for this PR is used up — /pr-hero review reviews this head";
  const MANUAL_DESCRIPTION =
    "pr-hero: review needs a manual trigger (ci_review_policy is manual_only) — /pr-hero review reviews this head";

  test("(a) a state row with no comment behind a red gate is a finding with no thread, and it is fixed", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(1))],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM, "blocking", "src/b.ts:42"),
            ]),
          },
        ],
      }),
    );
    expect(status.findings).toHaveLength(1);
    expect(status.findings[0]).toMatchObject({
      id: "R001",
      path: "src/b.ts",
      line: 42,
      head: null,
      comment_id: null,
      channel: "inline",
      tier: "blocking",
      blocking: true,
      live_on_head: true,
      triage: null,
      ci_verdict: null,
    });
    expect(status.unresolved_blocking).toBe(1);
    expect(status.next_action).toBe("fix");
    expect(status.reason).toBe(
      "1 live blocking finding(s) (R001) have no comment thread to answer (summary-only or never posted inline); fix them and push, or /pr-hero override.",
    );
  });

  // #348 R001/R003: the upheld dismissal was consumed, the gate still counts a summary-only row.
  // The answer must be fix, never review, which would loop on the same red gate.
  test("(b) upheld dismissals consumed and one summary-only blocking row: never review", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(1))],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
          triageReply({
            id: 2,
            parent: 1,
            head: CURRENT,
            tag: "dismissed",
            verdict: "upheld",
          }),
          {
            id: 3,
            user: CI_ADJUDICATOR_LOGIN,
            body: `${adjudicationMarker({
              verdict: "upheld",
              reply: 2,
              head: CURRENT,
            })}\n\nruling`,
            in_reply_to_id: 1,
          },
        ],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM),
              stateRow("R002", CLAIM_TWO, "blocking", "src/c.ts:7"),
            ]),
          },
        ],
      }),
    );
    expect(status.next_action).toBe("fix");
    expect(status.reason).toMatch(/\(R002\)/);
    expect(status.reason).not.toMatch(/upheld every dismissal/);
  });

  test("(c) a used-up automatic budget with no live blocking finding is review", () => {
    const status = buildPrStatus(
      input({ statuses: [gate("failure", BUDGET_DESCRIPTION)] }),
    );
    expect(status.next_action).toBe("review");
    expect(status.reason).toMatch(/automatic review budget/);
    expect(status.reason).toMatch(/\/pr-hero review/);
  });

  test("(c) a manual_only policy with no live blocking finding is review", () => {
    const status = buildPrStatus(
      input({ statuses: [gate("failure", MANUAL_DESCRIPTION)] }),
    );
    expect(status.next_action).toBe("review");
    expect(status.reason).toMatch(/manual-only|manual_only/);
    expect(status.reason).toMatch(/\/pr-hero review/);
  });

  test("(c) a used-up budget answers review even with a live blocking finding (no push gets reviewed there; review #348 R006)", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", BUDGET_DESCRIPTION)],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
        ],
        issueComments: [
          { id: 100, body: summary(CURRENT, [stateRow("R001", CLAIM)]) },
        ],
      }),
    );
    expect(status.next_action).toBe("review");
  });

  test("R006: a budget gate after a push with an older head's thread-less row answers review, not fix", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", BUDGET_DESCRIPTION)],
        issueComments: [
          {
            id: 100,
            body: summary("0".repeat(40), [
              stateRow("R001", CLAIM, "blocking", "src/b.ts:42"),
            ]),
          },
        ],
      }),
    );
    expect(status.next_action).toBe("review");
  });

  test("R006: a skipped gate with a thread-less row falls to the skip branch, not fix", () => {
    const status = buildPrStatus(
      input({
        statuses: [
          gate(
            "failure",
            "pr-hero skipped the review: the diff is over the size gate — /pr-hero review reviews it anyway",
          ),
        ],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM, "blocking", "src/b.ts:42"),
            ]),
          },
        ],
      }),
    );
    expect(status.next_action).toBe("override-or-fix");
    expect(status.reason).toContain("was skipped");
  });

  test("(d) a row bound to its posted comment is emitted once, with its comment", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", BLOCKING_DESCRIPTION(1))],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
        ],
        issueComments: [
          { id: 100, body: summary(CURRENT, [stateRow("R001", CLAIM)]) },
        ],
      }),
    );
    expect(status.findings).toHaveLength(1);
    expect(status.findings[0]?.comment_id).toBe(1);
    expect(status.findings[0]?.id).toBe("R001");
    expect(status.unresolved_blocking).toBe(1);
  });

  test("unresolved_blocking counts a threaded and an unthreaded row once each", () => {
    const status = buildPrStatus(
      input({
        statuses: [gate("failure", BUDGET_DESCRIPTION)],
        reviewComments: [
          {
            id: 1,
            body: findingBody({ head: CURRENT, claim: CLAIM }),
            in_reply_to_id: null,
          },
        ],
        issueComments: [
          {
            id: 100,
            body: summary(CURRENT, [
              stateRow("R001", CLAIM),
              stateRow("R002", CLAIM_TWO, "blocking", "src/c.ts:7"),
            ]),
          },
        ],
      }),
    );
    expect(status.unresolved_blocking).toBe(2);
    expect(status.findings.filter((f) => f.comment_id === null)).toHaveLength(
      1,
    );
  });
});
