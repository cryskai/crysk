// budget-exhausted-carry S3-S5: when a skip carries a blocking red, whether every blocking finding of the
// reviewed head is answered by someone allowed to answer it.
import { describe, expect, test } from "bun:test";
import {
  type AnswerIssueComment,
  type AnswerReviewComment,
  answeredBlockingFindings,
  triageReplyAuthors,
} from "#pr/answered-findings";
import { findingMarker } from "#pr/preflight";
import { renderStateBlock, stateFinding } from "#rereview/state";
import { adjudicationMarker, CI_ADJUDICATOR_LOGIN } from "#triage/adjudication";
import { type TriageTag, triageMarker } from "#triage/triage";

const REVIEWED = "1".repeat(40);
const BOT = CI_ADJUDICATOR_LOGIN;
const AUTHOR = "juanma";
const STRANGER = "drive-by";

function summary(rows: { id: string; loc: string; claim: string }[]): string {
  return [
    `<!-- pr-hero-report head=${REVIEWED} -->`,
    "",
    renderStateBlock(
      REVIEWED,
      rows.map((r) =>
        stateFinding({
          id: r.id,
          sev: "CRITICAL",
          tier: "blocking",
          channel: "inline",
          locs: [r.loc],
          claim: r.claim,
        }),
      ),
    ),
  ].join("\n");
}

function finding(
  id: number,
  line: number,
  claim: string,
  head: string = REVIEWED,
): AnswerReviewComment {
  const marker = findingMarker({
    path: "src/a.ts",
    line,
    headSha: head,
    claim,
  });
  return {
    id,
    user: BOT,
    body: [
      marker,
      "",
      "🔴 blocking · CRITICAL · introduced · reliability",
      "",
      `\`src/a.ts:${line}\``,
      "",
      claim,
    ].join("\n"),
    in_reply_to_id: null,
    path: "src/a.ts",
    line,
  };
}

function reply(
  id: number,
  parent: number,
  tag: TriageTag,
  options: { user?: string; head?: string; at?: string } = {},
): AnswerReviewComment {
  return {
    id,
    user: options.user ?? AUTHOR,
    ...(options.at === undefined ? {} : { created_at: options.at }),
    body: `${triageMarker({
      tag,
      headSha: options.head ?? REVIEWED,
      actor: "agent",
      ...(tag === "applied" ? {} : { verdict: "upheld" as const }),
    })}\n\nreasoning`,
    in_reply_to_id: parent,
  };
}

function ruling(
  id: number,
  parent: number,
  replyId: number,
  verdict: "upheld" | "rejected",
): AnswerReviewComment {
  return {
    id,
    user: BOT,
    body: `${adjudicationMarker({ verdict, reply: replyId, head: REVIEWED })}\n\nruling`,
    in_reply_to_id: parent,
  };
}

const OLD = "2".repeat(40);
const VERDICT_AT = "2026-10-30T10:00:00Z";
const BEFORE = "2026-10-30T09:00:00Z";
const AFTER = "2026-10-30T11:00:00Z";
const CLAIM_A = "the value is stored in seconds and read as milliseconds";
const CLAIM_B = "the retry loop never stops on a permanent error";

function read(options: {
  reviewComments: AnswerReviewComment[];
  writers?: Record<string, boolean | null>;
  trustedActors?: ReadonlySet<string>;
  issueComments?: AnswerIssueComment[];
  verdictAt?: string | null;
}) {
  return answeredBlockingFindings({
    pr: 12,
    reviewedHead: REVIEWED,
    issueComments: options.issueComments ?? [
      {
        id: 1,
        user: BOT,
        body: summary([
          { id: "R001", loc: "src/a.ts:10", claim: CLAIM_A },
          { id: "R002", loc: "src/a.ts:40", claim: CLAIM_B },
        ]),
      },
    ],
    reviewComments: options.reviewComments,
    trustedActors: options.trustedActors ?? new Set([AUTHOR]),
    writers: new Map(Object.entries(options.writers ?? { [AUTHOR]: true })),
    verdictAt: options.verdictAt === undefined ? VERDICT_AT : options.verdictAt,
  });
}

const TWO_FINDINGS = [finding(10, 10, CLAIM_A), finding(20, 40, CLAIM_B)];

describe("answeredBlockingFindings", () => {
  test("two blocking findings, both applied by a writer: nothing open", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          reply(11, 10, "applied"),
          reply(21, 20, "applied"),
        ],
      }),
    ).toEqual({ blocking: 2, open: 0 });
  });

  test("an upheld dismissal answers; a rejected one does not", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          reply(11, 10, "dismissed"),
          ruling(12, 10, 11, "upheld"),
          reply(21, 20, "dismissed"),
          ruling(22, 20, 21, "rejected"),
        ],
      }),
    ).toEqual({ blocking: 2, open: 1 });
  });

  test.each(["deferred", "misclassified"] as const)(
    "%s keeps a finding open: it names a real finding",
    (tag) => {
      expect(
        read({
          reviewComments: [
            ...TWO_FINDINGS,
            reply(11, 10, "applied"),
            reply(21, 20, tag),
          ],
        }),
      ).toEqual({ blocking: 2, open: 1 });
    },
  );

  test("no reply keeps a finding open", () => {
    expect(
      read({ reviewComments: [...TWO_FINDINGS, reply(11, 10, "applied")] }),
    ).toEqual({ blocking: 2, open: 1 });
  });

  test("the newest reply decides: applied then deferred is open", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          reply(11, 10, "applied"),
          reply(13, 10, "deferred"),
          reply(21, 20, "applied"),
        ],
      }),
    ).toEqual({ blocking: 2, open: 1 });
  });

  test("a reply at another head does not answer the finding", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          reply(11, 10, "applied", { head: "9".repeat(40) }),
          reply(21, 20, "applied"),
        ],
      }),
    ).toEqual({ blocking: 2, open: 1 });
  });

  // S4: an `applied` from a login without write access is not an answer, so it cannot turn the gate green.
  test("a reply from a login with no write access is ignored", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          reply(11, 10, "applied"),
          reply(21, 20, "applied", { user: STRANGER }),
        ],
        writers: { [AUTHOR]: true, [STRANGER]: false },
      }),
    ).toEqual({ blocking: 2, open: 1 });
  });

  test("a stranger's newer reply cannot override the writer's: the writer's reply stands", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          reply(11, 10, "deferred"),
          reply(12, 10, "applied", { user: STRANGER }),
          reply(21, 20, "applied"),
        ],
        writers: { [AUTHOR]: true, [STRANGER]: false },
      }),
    ).toEqual({ blocking: 2, open: 1 });
  });

  // S5: a permission that did not read fails the whole read closed.
  test.each([
    ["null", { [AUTHOR]: null }],
    ["never looked up", {}],
  ] as const)(
    "a reply author whose permission is %s fails closed",
    (_name, writers) => {
      expect(
        read({
          reviewComments: [
            ...TWO_FINDINGS,
            reply(11, 10, "applied"),
            reply(21, 20, "applied"),
          ],
          writers,
        }),
      ).toBeNull();
    },
  );

  test("a forged finding comment from an untrusted login is not counted", () => {
    const forged = { ...finding(30, 70, "a forged claim"), user: STRANGER };
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          forged,
          reply(11, 10, "applied"),
          reply(21, 20, "applied"),
        ],
      }),
    ).toEqual({ blocking: 2, open: 0 });
  });

  test("a live row with no comment thread cannot be answered, so it stays open", () => {
    expect(
      read({
        issueComments: [
          {
            id: 1,
            user: BOT,
            body: summary([
              { id: "R001", loc: "src/a.ts:10", claim: CLAIM_A },
              { id: "R002", loc: "src/b.ts:5", claim: "summary-only claim" },
            ]),
          },
        ],
        reviewComments: [finding(10, 10, CLAIM_A), reply(11, 10, "applied")],
      }),
    ).toEqual({ blocking: 2, open: 1 });
  });
});

describe("triageReplyAuthors", () => {
  test("lists each triage reply author once, and nobody else", () => {
    expect(
      triageReplyAuthors([
        ...TWO_FINDINGS,
        reply(11, 10, "applied"),
        reply(21, 20, "applied"),
        reply(22, 20, "deferred", { user: STRANGER }),
        { id: 30, user: "commenter", body: "looks good" },
      ]),
    ).toEqual([AUTHOR, STRANGER]);
  });
});

// Verifier probes P1 and P3, kept as regressions.
describe("answeredBlockingFindings: what cannot unlock the gate", () => {
  // A finding posted on an older head stays live on the reviewed head through the summary's row. Its
  // reply carries the older head, so only its time says whether it answers the review that kept it.
  const olderHeadFinding = (replyAt: string | undefined) =>
    read({
      issueComments: [
        {
          id: 1,
          user: BOT,
          body: summary([{ id: "R001", loc: "src/a.ts:10", claim: CLAIM_A }]),
        },
      ],
      reviewComments: [
        finding(10, 10, CLAIM_A, OLD),
        reply(11, 10, "applied", {
          head: OLD,
          ...(replyAt === undefined ? {} : { at: replyAt }),
        }),
      ],
    });

  test("an older head's applied from before the carried verdict is stale: the review kept the finding", () => {
    expect(olderHeadFinding(BEFORE)).toEqual({ blocking: 1, open: 1 });
  });

  test("an older head's applied from after the carried verdict answers it", () => {
    expect(olderHeadFinding(AFTER)).toEqual({ blocking: 1, open: 0 });
  });

  test("an older head's reply with no time, or no verdict time, is stale (fail closed)", () => {
    expect(olderHeadFinding(undefined)).toEqual({ blocking: 1, open: 1 });
    expect(
      read({
        verdictAt: null,
        issueComments: [
          {
            id: 1,
            user: BOT,
            body: summary([{ id: "R001", loc: "src/a.ts:10", claim: CLAIM_A }]),
          },
        ],
        reviewComments: [
          finding(10, 10, CLAIM_A, OLD),
          reply(11, 10, "applied", { head: OLD, at: AFTER }),
        ],
      }),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("a reply at the reviewed head answers whatever its time", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          reply(11, 10, "applied", { at: BEFORE }),
          reply(21, 20, "applied", { at: BEFORE }),
        ],
      }),
    ).toEqual({ blocking: 2, open: 0 });
  });

  test("a finding whose tier cannot be read fails the read closed, applied or not", () => {
    const noBadge: AnswerReviewComment = {
      id: 10,
      user: BOT,
      body: `${findingMarker({ path: "src/a.ts", line: 10, headSha: REVIEWED, claim: CLAIM_A })}\n\n${CLAIM_A}`,
      in_reply_to_id: null,
      path: "src/a.ts",
      line: 10,
    };
    expect(
      read({
        issueComments: [],
        reviewComments: [noBadge, reply(11, 10, "applied")],
      }),
    ).toBeNull();
  });
});
