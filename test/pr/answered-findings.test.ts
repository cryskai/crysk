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
import { replyAnswersReview } from "#triage/reply";
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

function rowReply(
  id: number,
  row: string,
  tag: TriageTag,
  options: { user?: string; head?: string; at?: string } = {},
): AnswerIssueComment {
  return {
    id,
    user: options.user ?? AUTHOR,
    ...(options.at === undefined ? {} : { created_at: options.at }),
    body: `${triageMarker({
      tag,
      headSha: options.head ?? REVIEWED,
      actor: "agent",
      row,
      ...(tag === "applied" ? {} : { verdict: "upheld" as const }),
    })}\n\nreasoning`,
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

describe("answeredBlockingFindings — a summary row with no comment", () => {
  const ROW_R001 = { id: "R001", loc: "src/a.ts:10", claim: CLAIM_A };
  const ROW_R002 = { id: "R002", loc: "src/a.ts:40", claim: CLAIM_B };
  const rowSummary = (rows: { id: string; loc: string; claim: string }[]) => ({
    id: 1,
    user: BOT,
    body: summary(rows),
  });
  const rowRead = (
    replies: AnswerIssueComment[],
    options: {
      writers?: Record<string, boolean | null>;
      rows?: { id: string; loc: string; claim: string }[];
      reviewComments?: AnswerReviewComment[];
    } = {},
  ) =>
    read({
      issueComments: [rowSummary(options.rows ?? [ROW_R001]), ...replies],
      reviewComments: options.reviewComments ?? [],
      ...(options.writers === undefined ? {} : { writers: options.writers }),
    });

  test("no reply: open", () => {
    expect(rowRead([])).toEqual({ blocking: 1, open: 1 });
  });

  test("an applied reply that names the row, at the reviewed head, from a writer: answered", () => {
    expect(rowRead([rowReply(2, "R001", "applied")])).toEqual({
      blocking: 1,
      open: 0,
    });
  });

  test("a reply at another head stays open, even when it is newer than the verdict", () => {
    expect(
      rowRead([rowReply(2, "R001", "applied", { head: OLD, at: AFTER })]),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("a reply from a login without write access is dropped", () => {
    expect(
      rowRead([rowReply(2, "R001", "applied", { user: STRANGER })], {
        writers: { [AUTHOR]: true, [STRANGER]: false },
      }),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("a reply from a login whose permission was never read fails the whole read", () => {
    expect(
      rowRead([rowReply(2, "R001", "applied", { user: STRANGER })], {
        writers: { [AUTHOR]: true },
      }),
    ).toBeNull();
  });

  test("a reply that names another row does not answer this one", () => {
    expect(rowRead([rowReply(2, "R002", "applied")])).toEqual({
      blocking: 1,
      open: 1,
    });
  });

  test("a dismissed reply stays open: a row has no thread a CI ruling could sit on", () => {
    expect(rowRead([rowReply(2, "R001", "dismissed")])).toEqual({
      blocking: 1,
      open: 1,
    });
  });

  test("a deferred reply stays open", () => {
    expect(rowRead([rowReply(2, "R001", "deferred")])).toEqual({
      blocking: 1,
      open: 1,
    });
  });

  test("a top-level applied marker with no row answers nothing", () => {
    expect(
      rowRead([
        {
          id: 2,
          user: AUTHOR,
          body: `${triageMarker({ tag: "applied", headSha: REVIEWED, actor: "agent" })}\n\nreasoning`,
        },
      ]),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("two rows, one answered", () => {
    expect(
      rowRead([rowReply(2, "R001", "applied")], {
        rows: [ROW_R001, ROW_R002],
      }),
    ).toEqual({ blocking: 2, open: 1 });
  });

  test("a row and a threaded finding, both answered", () => {
    expect(
      rowRead([rowReply(2, "R001", "applied")], {
        rows: [ROW_R001, ROW_R002],
        reviewComments: [finding(20, 40, CLAIM_B), reply(21, 20, "applied")],
      }),
    ).toEqual({ blocking: 2, open: 0 });
  });

  test("an applied reply followed by a newer dismissed one stays open", () => {
    expect(
      rowRead([
        rowReply(2, "R001", "applied"),
        rowReply(3, "R001", "dismissed"),
      ]),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("an applied reply followed by a newer deferred one stays open", () => {
    expect(
      rowRead([
        rowReply(2, "R001", "applied"),
        rowReply(3, "R001", "deferred"),
      ]),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("a marker on the second line of a comment answers nothing", () => {
    expect(
      rowRead([
        {
          id: 2,
          user: AUTHOR,
          body: `some text\n${triageMarker({ tag: "applied", headSha: REVIEWED, actor: "agent", row: "R001" })}\n\nreasoning`,
        },
      ]),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("a thread reply that names a row does not answer the threaded finding", () => {
    expect(
      read({
        issueComments: [rowSummary([ROW_R001])],
        reviewComments: [
          finding(10, 10, CLAIM_A),
          {
            id: 11,
            user: AUTHOR,
            in_reply_to_id: 10,
            body: `${triageMarker({ tag: "applied", headSha: REVIEWED, actor: "agent", row: "R009" })}\n\nreasoning`,
          },
        ],
      }),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("the author of a row reply is among the logins whose permission is looked up", () => {
    expect(
      triageReplyAuthors([
        rowSummary([ROW_R001]),
        rowReply(2, "R001", "applied", { user: "someone" }),
      ]),
    ).toContain("someone");
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

// triage-without-skill S1: a team without the crysk-loop skill answers with a plain comment. A reply in the
// finding's thread that starts with "applied", from a writer, counts as the marker `crysk triage reply` writes.
function plain(
  id: number,
  parent: number,
  body: string,
  options: { user?: string; at?: string } = {},
): AnswerReviewComment {
  return {
    id,
    user: options.user ?? AUTHOR,
    ...(options.at === undefined ? {} : { created_at: options.at }),
    body,
    in_reply_to_id: parent,
  };
}

describe("answeredBlockingFindings: plain applied replies", () => {
  test("plain replies starting with applied answer both findings", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          plain(11, 10, "applied"),
          plain(21, 20, "Applied: fixed in 1a2b3c4, the loop now stops."),
        ],
      }),
    ).toEqual({ blocking: 2, open: 0 });
  });

  test("a plain reply that does not start with applied answers nothing", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          plain(11, 10, "applied"),
          plain(21, 20, "thanks, I think this is applied now"),
        ],
      }),
    ).toEqual({ blocking: 2, open: 1 });
  });

  test("a word that only starts like applied answers nothing", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          plain(11, 10, "applied"),
          plain(21, 20, "appliedness is not a word"),
        ],
      }),
    ).toEqual({ blocking: 2, open: 1 });
  });

  test("a plain applied from a login with no write access is ignored", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          plain(11, 10, "applied"),
          plain(21, 20, "applied", { user: STRANGER }),
        ],
        writers: { [AUTHOR]: true, [STRANGER]: false },
      }),
    ).toEqual({ blocking: 2, open: 1 });
  });

  test("a plain applied whose author's permission did not read fails closed", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          plain(11, 10, "applied"),
          plain(21, 20, "applied"),
        ],
        writers: {},
      }),
    ).toBeNull();
  });

  test("a plain applied newer than a deferred marker answers the finding", () => {
    expect(
      read({
        reviewComments: [
          ...TWO_FINDINGS,
          reply(11, 10, "deferred"),
          plain(12, 10, "applied"),
          plain(21, 20, "applied"),
        ],
      }),
    ).toEqual({ blocking: 2, open: 0 });
  });

  test("an older head's plain applied counts only after the carried verdict", () => {
    const comments = (at: string) => [
      finding(10, 10, CLAIM_A, OLD),
      finding(20, 40, CLAIM_B),
      plain(11, 10, "applied", { at }),
      plain(21, 20, "applied"),
    ];
    expect(read({ reviewComments: comments(BEFORE) })).toEqual({
      blocking: 2,
      open: 1,
    });
    expect(read({ reviewComments: comments(AFTER) })).toEqual({
      blocking: 2,
      open: 0,
    });
  });

  test("triageReplyAuthors lists a plain applied author, not a plain commenter", () => {
    expect(
      triageReplyAuthors([
        ...TWO_FINDINGS,
        plain(11, 10, "applied"),
        plain(21, 20, "looks good", { user: STRANGER }),
      ]),
    ).toEqual([AUTHOR]);
  });
});

describe("answeredBlockingFindings — a reply stamped with the reviewed head", () => {
  // The finding is carried from an older head; its comment keeps that head.
  const carried = [finding(10, 10, CLAIM_A, OLD)];
  const summaryRows = [{ id: "R001", loc: "src/a.ts:10", claim: CLAIM_A }];
  const carriedRead = (
    reviewComments: AnswerReviewComment[],
    options: {
      writers?: Record<string, boolean | null>;
      verdictAt?: string | null;
    } = {},
  ) =>
    read({
      issueComments: [{ id: 1, user: BOT, body: summary(summaryRows) }],
      reviewComments: [...carried, ...reviewComments],
      ...options,
    });

  test("an applied reply stamped with the reviewed head answers a carried finding", () => {
    expect(
      carriedRead([reply(11, 10, "applied", { head: REVIEWED, at: BEFORE })]),
    ).toEqual({ blocking: 1, open: 0 });
  });

  test("with no time at all it still answers", () => {
    expect(
      carriedRead([reply(11, 10, "applied", { head: REVIEWED })], {
        verdictAt: null,
      }),
    ).toEqual({ blocking: 1, open: 0 });
  });

  test("a dismissal stamped with the reviewed head and upheld by CI answers it", () => {
    expect(
      carriedRead([
        reply(11, 10, "dismissed", { head: REVIEWED }),
        ruling(12, 10, 11, "upheld"),
      ]),
    ).toEqual({ blocking: 1, open: 0 });
  });

  test("a dismissal stamped with the reviewed head and not ruled on stays open", () => {
    expect(
      carriedRead([reply(11, 10, "dismissed", { head: REVIEWED })]),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("a reply stamped with a head that is neither the posted nor the reviewed one stays open", () => {
    expect(
      carriedRead([
        reply(11, 10, "applied", { head: "3".repeat(40), at: AFTER }),
      ]),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("an earlier-round reply followed by a reviewed-head reply: the newer one answers", () => {
    expect(
      carriedRead([
        reply(11, 10, "applied", { head: OLD, at: BEFORE }),
        reply(12, 10, "applied", { head: REVIEWED, at: AFTER }),
      ]),
    ).toEqual({ blocking: 1, open: 0 });
  });

  test("a reader's reply stamped with the reviewed head does not answer", () => {
    expect(
      carriedRead(
        [reply(11, 10, "applied", { head: REVIEWED, user: STRANGER })],
        { writers: { [AUTHOR]: true, [STRANGER]: false } },
      ),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("an applied reply in another finding's thread does not answer it", () => {
    expect(
      read({
        reviewComments: [
          finding(10, 10, CLAIM_A, OLD),
          finding(20, 40, CLAIM_B, OLD),
          reply(21, 20, "applied", { head: REVIEWED }),
        ],
      }),
    ).toEqual({ blocking: 2, open: 1 });
  });

  test("a deferred reply stamped with the reviewed head stays open", () => {
    expect(
      carriedRead([reply(11, 10, "deferred", { head: REVIEWED })]),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("an applied reply followed by a newer unruled dismissal stays open", () => {
    expect(
      carriedRead([
        reply(11, 10, "applied", { head: REVIEWED }),
        reply(12, 10, "dismissed", { head: REVIEWED }),
      ]),
    ).toEqual({ blocking: 1, open: 1 });
  });

  test("a reply from a login whose permission was never read fails the whole read", () => {
    expect(
      carriedRead(
        [reply(11, 10, "applied", { head: REVIEWED, user: STRANGER })],
        { writers: { [AUTHOR]: true } },
      ),
    ).toBeNull();
  });
});

describe("answeredBlockingFindings agrees with replyAnswersReview", () => {
  const HEADS: Record<string, string> = {
    [REVIEWED]: "REVIEWED",
    [OLD]: "OLD",
    ["3".repeat(40)]: "OTHER",
  };
  const POSTED_HEADS = [REVIEWED, OLD];
  const REPLY_HEADS = [REVIEWED, OLD, "3".repeat(40)];
  const REPLY_TIMES: (string | undefined)[] = [BEFORE, AFTER, undefined];
  const timeLabel = (at: string | undefined) =>
    at === BEFORE ? "BEFORE" : at === AFTER ? "AFTER" : "no-time";

  for (const postedHead of POSTED_HEADS) {
    for (const replyHead of REPLY_HEADS) {
      for (const at of REPLY_TIMES) {
        const name = `posted=${HEADS[postedHead]} reply=${HEADS[replyHead]} at=${timeLabel(at)}`;
        test(name, () => {
          const result = read({
            issueComments: [
              {
                id: 1,
                user: BOT,
                body: summary([
                  { id: "R001", loc: "src/a.ts:10", claim: CLAIM_A },
                ]),
              },
            ],
            reviewComments: [
              finding(10, 10, CLAIM_A, postedHead),
              reply(11, 10, "applied", { head: replyHead, at }),
            ],
          });
          expect(result?.open === 0).toBe(
            replyAnswersReview({
              replyHead,
              replyCreatedAt: at,
              findingHead: postedHead,
              reviewedHead: REVIEWED,
              verdictAt: Date.parse(VERDICT_AT),
            }),
          );
        });
      }
    }
  }
});
