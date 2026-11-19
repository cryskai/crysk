// Parity: the same comments go to the gate (answeredBlockingFindings) and to the status
// (buildPrStatus). Both read the same triage replies through triage/reply.ts countedTriageReplies,
// so every scenario must agree on whether the gate counts the finding answered.
import { expect, test } from "bun:test";
import {
  type AnswerIssueComment,
  type AnswerReviewComment,
  answeredBlockingFindings,
} from "#pr/answered-findings";
import { buildPrStatus, type PrStatusFinding } from "#pr/pr-status";
import { COMMIT_STATUS_CONTEXT, findingMarker } from "#pr/preflight";
import { renderStateBlock, stateFinding } from "#rereview/state";
import { adjudicationMarker, CI_ADJUDICATOR_LOGIN } from "#triage/adjudication";
import { type TriageTag, triageMarker } from "#triage/triage";

const REVIEWED = "1".repeat(40);
const OLD = "2".repeat(40);
const FOREIGN = "3".repeat(40);
const BOT = CI_ADJUDICATOR_LOGIN; // "github-actions[bot]"
const WRITER = "dev";
const READER = "visitor";

const VERDICT_AT = "2026-11-10T12:00:00Z";
const LATE = "2026-11-10T13:00:00Z";
const LATER = "2026-11-10T14:00:00Z";
const STALE = "2026-11-10T11:00:00Z";
const NOW = Date.parse("2026-11-10T15:00:00Z");

const CLAIM = "the value is stored in seconds and read as milliseconds";
const ROW = "R001";
const FINDING_ID = 10;

// The summary comment: one live blocking row R001 at src/a.ts:10, written for REVIEWED.
function summaryComment(): AnswerIssueComment {
  return {
    id: 1,
    user: BOT,
    body: [
      `<!-- pr-hero-report head=${REVIEWED} -->`,
      "",
      "### Summary",
      "",
      renderStateBlock(REVIEWED, [
        stateFinding({
          id: ROW,
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          locs: ["src/a.ts:10"],
          claim: CLAIM,
        }),
      ]),
    ].join("\n"),
  };
}

// The inline finding comment id 10 by BOT, bound to row R001, marker head `head`.
function findingComment(
  head: string = REVIEWED,
  tier: "blocking" | "advisory" = "blocking",
): AnswerReviewComment {
  const marker = findingMarker({
    path: "src/a.ts",
    line: 10,
    headSha: head,
    claim: CLAIM,
  });
  const header =
    tier === "blocking"
      ? "🔴 blocking · CRITICAL · introduced · reliability"
      : "🔵 advisory · CRITICAL · introduced · reliability";
  return {
    id: FINDING_ID,
    user: BOT,
    body: [marker, "", header, "", "`src/a.ts:10`", "", CLAIM].join("\n"),
    in_reply_to_id: null,
    path: "src/a.ts",
    line: 10,
  };
}

function triageBody(
  tag: TriageTag,
  head: string,
  extra: { row?: string } = {},
): string {
  return `${triageMarker({
    tag,
    headSha: head,
    actor: "agent",
    ...(extra.row === undefined ? {} : { row: extra.row }),
    ...(tag === "applied" ? {} : { verdict: "upheld" as const }),
  })}\n\nreasoning`;
}

// A triage reply in the finding's review thread (in_reply_to_id = the finding).
function inlineReply(
  id: number,
  tag: TriageTag,
  head: string,
  at: string,
  user: string,
): AnswerReviewComment {
  return {
    id,
    user,
    created_at: at,
    body: triageBody(tag, head),
    in_reply_to_id: FINDING_ID,
  };
}

// A top-level triage reply that names row R001 (no finding comment needed).
function rowReply(
  id: number,
  tag: TriageTag,
  head: string,
  at: string,
  user: string,
): AnswerIssueComment {
  return {
    id,
    user,
    created_at: at,
    body: triageBody(tag, head, { row: ROW }),
  };
}

// The CI ruling on reply `replyId` at REVIEWED, a reply to the finding thread.
function ruling(
  id: number,
  replyId: number,
  verdict: "upheld" | "rejected",
  at: string,
): AnswerReviewComment {
  return {
    id,
    user: BOT,
    created_at: at,
    body: `${adjudicationMarker({ verdict, reply: replyId, head: REVIEWED })}\n\nruling`,
    in_reply_to_id: FINDING_ID,
  };
}

// The gate's status on the reviewed head: red, stating one blocking finding, created at the verdict time.
function redGate(blocking = 1) {
  return {
    state: "failure",
    context: COMMIT_STATUS_CONTEXT,
    created_at: VERDICT_AT,
    description: `crysk: ${blocking} blocking finding(s) — fix and push, or /crysk override`,
    target_url: null,
  };
}

// Both readers over the same comments, with the same write-access map.
function both(scenario: {
  reviewComments: AnswerReviewComment[];
  issueComments?: AnswerIssueComment[];
  writers?: Map<string, boolean>;
  blocking?: number;
}) {
  const issueComments = scenario.issueComments ?? [summaryComment()];
  const reviewComments = scenario.reviewComments;
  const writers =
    scenario.writers ??
    new Map<string, boolean>([
      [WRITER, true],
      [READER, false],
    ]);
  const gate = answeredBlockingFindings({
    pr: 12,
    reviewedHead: REVIEWED,
    issueComments,
    reviewComments,
    trustedActors: new Set([WRITER]),
    writers,
    verdictAt: VERDICT_AT,
  });
  const status = buildPrStatus({
    pr: 12,
    head: REVIEWED,
    nowMs: NOW,
    statuses: [redGate(scenario.blocking)],
    issueComments,
    reviewComments,
    verdictAt: VERDICT_AT,
    writers,
    trustedActors: new Set([WRITER]),
  });
  return { gate, status };
}

// The status finding of the blocking comment 10, or the row R001 when there is no comment.
function findingOf(status: { findings: PrStatusFinding[] }) {
  return (
    status.findings.find((f) => f.comment_id === FINDING_ID) ??
    status.findings.find((f) => f.id === ROW)
  );
}

// The rule both readers share: the gate passes the blocking finding when it counts nothing open,
// and the status then asks for fix or review, never for triage or an override.
function expectParity(
  gate: { blocking: number; open: number } | null,
  nextAction: string,
): void {
  expect(
    (gate !== null && gate.open === 0) ===
      ["fix", "review"].includes(nextAction),
  ).toBe(true);
}

test("S1: one reply, applied at REVIEWED by WRITER (baseline)", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(),
      inlineReply(11, "applied", REVIEWED, LATE, WRITER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 0 });
  expect(status.next_action).toBe("fix");
  expectParity(gate, status.next_action);
});

test("S2: no reply at all (baseline)", () => {
  const { gate, status } = both({ reviewComments: [findingComment()] });
  expect(gate).toEqual({ blocking: 1, open: 1 });
  expect(status.next_action).toBe("triage");
  expectParity(gate, status.next_action);
});

test("S3: applied@REVIEWED by WRITER (11), then newer applied@FOREIGN by WRITER (12)", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(),
      inlineReply(11, "applied", REVIEWED, LATE, WRITER),
      inlineReply(12, "applied", FOREIGN, LATER, WRITER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 1 });
  expect(status.next_action).toBe("triage");
  expectParity(gate, status.next_action);
});

test("S4: applied@FOREIGN by WRITER (11), then newer applied@REVIEWED by WRITER (12)", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(),
      inlineReply(11, "applied", FOREIGN, LATE, WRITER),
      inlineReply(12, "applied", REVIEWED, LATER, WRITER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 0 });
  expect(status.next_action).toBe("fix");
  expectParity(gate, status.next_action);
});

test("S5: only reply is applied@REVIEWED by READER (no write access)", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(),
      inlineReply(11, "applied", REVIEWED, LATE, READER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 1 });
  expect(status.next_action).toBe("triage");
  expect(status.reason).toContain("visitor");
  expect(status.reason).toContain("do not count");
  expectParity(gate, status.next_action);
});

test("S6: applied@REVIEWED by WRITER (11), then newer deferred@REVIEWED by READER (12)", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(),
      inlineReply(11, "applied", REVIEWED, LATE, WRITER),
      inlineReply(12, "deferred", REVIEWED, LATER, READER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 0 });
  expect(status.next_action).toBe("fix");
  expect(findingOf(status)?.triage?.tag).toBe("applied");
  expectParity(gate, status.next_action);
});

test("S7: applied@REVIEWED by READER (11), then newer deferred@REVIEWED by WRITER (12)", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(),
      inlineReply(11, "applied", REVIEWED, LATE, READER),
      inlineReply(12, "deferred", REVIEWED, LATER, WRITER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 1 });
  expect(status.next_action).toBe("override-or-fix");
  expectParity(gate, status.next_action);
});

test("S8: dismissed (upheld) by WRITER (11), upheld ruling (12), then newer applied@REVIEWED by READER (13)", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(),
      inlineReply(11, "dismissed", REVIEWED, LATE, WRITER),
      ruling(12, 11, "upheld", LATE),
      inlineReply(13, "applied", REVIEWED, LATER, READER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 0 });
  expect(status.next_action).toBe("review");
  expect(findingOf(status)?.triage?.tag).toBe("dismissed");
  expect(findingOf(status)?.ci_verdict).toBe("upheld");
  expectParity(gate, status.next_action);
});

test("S9: dismissed (upheld) by WRITER (11) with upheld ruling (12), nothing else (baseline for S8)", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(),
      inlineReply(11, "dismissed", REVIEWED, LATE, WRITER),
      ruling(12, 11, "upheld", LATE),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 0 });
  expect(status.next_action).toBe("review");
  expectParity(gate, status.next_action);
});

test("S10: carried finding (@OLD), only reply applied@OLD by WRITER created before the verdict", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(OLD),
      inlineReply(11, "applied", OLD, STALE, WRITER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 1 });
  expect(status.next_action).toBe("triage");
  expect(findingOf(status)?.triage).toBeNull();
  expectParity(gate, status.next_action);
});

test("S11: carried finding (@OLD): applied@REVIEWED by WRITER (11), then newer applied@OLD by WRITER after the verdict (12)", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(OLD),
      inlineReply(11, "applied", REVIEWED, LATE, WRITER),
      inlineReply(12, "applied", OLD, LATER, WRITER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 0 });
  expect(status.next_action).toBe("fix");
  expectParity(gate, status.next_action);
});

test("S12: carried finding (@OLD): applied@OLD by WRITER before the verdict (11, stale), then deferred@REVIEWED by WRITER (12)", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(OLD),
      inlineReply(11, "applied", OLD, STALE, WRITER),
      inlineReply(12, "deferred", REVIEWED, LATE, WRITER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 1 });
  expect(status.next_action).toBe("override-or-fix");
  expectParity(gate, status.next_action);
});

test("S13: no inline comment, row R001 only; top-level row reply applied@REVIEWED by READER", () => {
  const { gate, status } = both({
    reviewComments: [],
    issueComments: [
      summaryComment(),
      rowReply(21, "applied", REVIEWED, LATE, READER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 1 });
  expect(status.next_action).toBe("triage");
  expect(status.reason).toContain("visitor");
  expectParity(gate, status.next_action);
});

test("S14: row only: row reply applied@REVIEWED by WRITER (21), then newer row reply applied@FOREIGN by WRITER (22)", () => {
  const { gate, status } = both({
    reviewComments: [],
    issueComments: [
      summaryComment(),
      rowReply(21, "applied", REVIEWED, LATE, WRITER),
      rowReply(22, "applied", FOREIGN, LATER, WRITER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 1 });
  expect(status.next_action).toBe("triage");
  expectParity(gate, status.next_action);
});

test("S15: row only: row reply applied@REVIEWED by WRITER (21), then newer row reply deferred@REVIEWED by READER (22)", () => {
  const { gate, status } = both({
    reviewComments: [],
    issueComments: [
      summaryComment(),
      rowReply(21, "applied", REVIEWED, LATE, WRITER),
      rowReply(22, "deferred", REVIEWED, LATER, READER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 0 });
  expect(status.next_action).toBe("fix");
  expectParity(gate, status.next_action);
});

test("S17: deferred@REVIEWED by WRITER (11), then applied@REVIEWED by READER (12)", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(),
      inlineReply(11, "deferred", REVIEWED, LATE, WRITER),
      inlineReply(12, "applied", REVIEWED, LATER, READER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 1 });
  expect(status.next_action).toBe("override-or-fix");
  expect(findingOf(status)?.triage?.tag).toBe("deferred");
  expectParity(gate, status.next_action);
});

// A plain comment: a reply whose whole body starts with the word applied, with no marker. Its
// finding is the parent, so the marker is implied at the head that finding was posted on.
function plainApplied(id: number, user: string): AnswerReviewComment {
  return {
    id,
    user,
    created_at: LATE,
    body: "applied, the fix is in the parser now",
    in_reply_to_id: FINDING_ID,
  };
}

test("S18: the only reply is a plain applied by READER", () => {
  const { gate, status } = both({
    reviewComments: [findingComment(), plainApplied(11, READER)],
  });
  expect(gate).toEqual({ blocking: 1, open: 1 });
  expect(status.next_action).toBe("triage");
  expectParity(gate, status.next_action);
});

test("S18b: the only reply is a plain applied by WRITER", () => {
  const { gate, status } = both({
    reviewComments: [findingComment(), plainApplied(11, WRITER)],
  });
  expect(gate).toEqual({ blocking: 1, open: 0 });
  expect(status.next_action).toBe("fix");
  expectParity(gate, status.next_action);
});

test("S19: a reply by WRITER with a valid applied marker on its second line", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(),
      {
        id: 11,
        user: WRITER,
        created_at: LATE,
        body: `note\n${triageMarker({ tag: "applied", headSha: REVIEWED, actor: "agent" })}\n\nreasoning`,
        in_reply_to_id: FINDING_ID,
      },
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 1 });
  expect(status.next_action).toBe("triage");
  expectParity(gate, status.next_action);
});

test("S20: two blocking findings, the first applied by WRITER, the second applied by READER", () => {
  const SECOND_CLAIM = "the retry budget is never reset after a success";
  const SECOND_ID = 20;
  const summary: AnswerIssueComment = {
    id: 1,
    user: BOT,
    body: [
      `<!-- pr-hero-report head=${REVIEWED} -->`,
      "",
      "### Summary",
      "",
      renderStateBlock(REVIEWED, [
        stateFinding({
          id: ROW,
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          locs: ["src/a.ts:10"],
          claim: CLAIM,
        }),
        stateFinding({
          id: "R002",
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          locs: ["src/a.ts:20"],
          claim: SECOND_CLAIM,
        }),
      ]),
    ].join("\n"),
  };
  const secondFinding: AnswerReviewComment = {
    id: SECOND_ID,
    user: BOT,
    body: [
      findingMarker({
        path: "src/a.ts",
        line: 20,
        headSha: REVIEWED,
        claim: SECOND_CLAIM,
      }),
      "",
      "🔴 blocking · CRITICAL · introduced · reliability",
      "",
      "`src/a.ts:20`",
      "",
      SECOND_CLAIM,
    ].join("\n"),
    in_reply_to_id: null,
    path: "src/a.ts",
    line: 20,
  };
  const { gate, status } = both({
    issueComments: [summary],
    reviewComments: [
      findingComment(),
      secondFinding,
      inlineReply(11, "applied", REVIEWED, LATE, WRITER),
      {
        id: 21,
        user: READER,
        created_at: LATE,
        body: triageBody("applied", REVIEWED),
        in_reply_to_id: SECOND_ID,
      },
    ],
    blocking: 2,
  });
  expect(gate).toEqual({ blocking: 2, open: 1 });
  expect(status.next_action).toBe("triage");
  expect(status.reason).toContain("visitor");
  expectParity(gate, status.next_action);
});

test("green gate: an advisory finding on the head is owed a reply from any author", () => {
  const green = (reviewComments: AnswerReviewComment[]) =>
    buildPrStatus({
      pr: 12,
      head: REVIEWED,
      nowMs: NOW,
      statuses: [
        {
          state: "success",
          context: COMMIT_STATUS_CONTEXT,
          created_at: VERDICT_AT,
          description: "crysk: review passed",
          target_url: null,
        },
      ],
      issueComments: [],
      reviewComments,
      verdictAt: VERDICT_AT,
      writers: new Map<string, boolean>([
        [WRITER, true],
        [READER, false],
      ]),
    });
  const replied = green([
    findingComment(REVIEWED, "advisory"),
    inlineReply(11, "applied", REVIEWED, LATE, READER),
  ]);
  expect(replied.next_action).toBe("done");
  const unreplied = green([findingComment(REVIEWED, "advisory")]);
  expect(unreplied.next_action).toBe("triage");
});

// S8: status reads a finding from the logins the gate trusts, so the two agree on who posted it.
test("a finding posted by a login the repository trusts counts for both", () => {
  const { gate, status } = both({
    reviewComments: [
      { ...findingComment(), user: WRITER },
      inlineReply(11, "applied", REVIEWED, LATE, WRITER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 0 });
  expect(findingOf(status)?.comment_id).toBe(FINDING_ID);
  expect(findingOf(status)?.triage?.tag).toBe("applied");
  expect(status.next_action).toBe("fix");
});

test("a finding marker from a login nobody trusts counts for neither", () => {
  const { gate, status } = both({
    reviewComments: [
      findingComment(),
      {
        ...findingComment(),
        id: 20,
        user: READER,
        body: findingMarker({
          path: "src/forged.ts",
          line: 1,
          headSha: REVIEWED,
          claim: "a forged claim",
        }),
      },
      inlineReply(11, "applied", REVIEWED, LATE, WRITER),
    ],
  });
  expect(gate).toEqual({ blocking: 1, open: 0 });
  expect(status.findings.map((f) => f.path)).toEqual(["src/a.ts"]);
});
