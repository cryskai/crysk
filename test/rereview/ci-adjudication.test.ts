import { describe, expect, test } from "bun:test";
import { claimFingerprint } from "#pr/preflight";
import {
  classifyPrior,
  type PhaseBContext,
  type PriorRecord,
  type PriorTriage,
  TIER_UNRECOVERABLE,
} from "#rereview/classify";
import { adjudicationQueue, enrichPriorsFromThreads } from "#rereview/prepare";
import {
  assembleLive,
  type GateRow,
  type GateSurvivor,
  unresolvedBlockingCount,
} from "#rereview/state";
import {
  adjudicationMarker,
  CI_ADJUDICATOR_LOGIN,
  MAX_ADJUDICATIONS_PER_RUN,
} from "#triage/adjudication";
import { triageMarker } from "#triage/triage";

const HEAD = "a".repeat(40);
const FINDING = 22;
const claim = "a live defect";

const ctx: PhaseBContext = {
  case: "C",
  deletedFiles: new Set(),
  renameMap: new Map(),
  touched: () => false,
  summaryUpdatedAt: null,
};

function prior(overrides: Partial<PriorRecord> = {}): PriorRecord {
  return {
    id: "R001",
    sev: "CRITICAL",
    tier: "blocking",
    channel: "inline",
    locs: ["src/app.ts:10"],
    claim,
    triage: null,
    newThreadReply: false,
    ...overrides,
  };
}

function triage(overrides: Partial<PriorTriage> = {}): PriorTriage {
  return {
    tag: "dismissed",
    verdict: "upheld",
    createdAt: null,
    replyId: 11,
    threadId: FINDING,
    argument: "the argument",
    ciVerdict: null,
    ...overrides,
  };
}

const posted = [
  {
    id: FINDING,
    marker: { path: "src/app.ts", line: 10, c: claimFingerprint(claim) },
  },
];

const dismissedReply = {
  id: 11,
  user: "author",
  in_reply_to_id: FINDING,
  body: `${triageMarker({ tag: "dismissed", verdict: "upheld", headSha: HEAD, actor: "agent" })}\nthe argument`,
  created_at: "2026-08-21T12:00:00Z",
};

function adjudicatorReply(
  over: { id?: number; user?: string; reply?: number; text?: string } = {},
) {
  return {
    id: over.id ?? 12,
    user: over.user ?? CI_ADJUDICATOR_LOGIN,
    in_reply_to_id: FINDING,
    body: `${adjudicationMarker({ verdict: "upheld", reply: over.reply ?? 11, head: HEAD })}\n${over.text ?? "the ruling"}`,
    created_at: "2026-08-21T12:05:00Z",
  };
}

function enrich(
  replies: Parameters<typeof enrichPriorsFromThreads>[0]["replies"],
) {
  return enrichPriorsFromThreads({
    priors: [prior()],
    posted,
    replies,
    summaryUpdatedAt: null,
  });
}

describe("enrichPriorsFromThreads — CI adjudication", () => {
  test("a bot verdict naming the latest dismissal sets ciVerdict, replyId, threadId, argument", () => {
    const [out] = enrich([dismissedReply, adjudicatorReply()]);
    expect(out?.triage?.tag).toBe("dismissed");
    expect(out?.triage?.ciVerdict).toBe("upheld");
    expect(out?.triage?.replyId).toBe(11);
    expect(out?.triage?.threadId).toBe(FINDING);
    expect(out?.triage?.argument).toBe("the argument");
  });

  test("the same marker from another user is ignored (ciVerdict null)", () => {
    const [out] = enrich([
      dismissedReply,
      adjudicatorReply({ user: "mallory" }),
    ]);
    expect(out?.triage?.ciVerdict).toBeNull();
  });

  test("a bot verdict naming an older reply does not rule on the latest dismissal", () => {
    const [out] = enrich([
      dismissedReply,
      adjudicatorReply({ reply: 10 }),
      { ...dismissedReply, id: 13 },
    ]);
    expect(out?.triage?.replyId).toBe(13);
    expect(out?.triage?.ciVerdict).toBeNull();
  });
});

describe("classifyPrior — ci-dismissed (D5)", () => {
  test("a dismissal the CI adjudicator upheld leaves as ci-dismissed", () => {
    const out = classifyPrior(
      prior({ triage: triage({ ciVerdict: "upheld" }) }),
      ctx,
    );
    expect(out.status).toBe("ci-dismissed");
  });

  test("a dismissal the CI adjudicator did not uphold stays suppressed when the local verdict upheld", () => {
    for (const ciVerdict of ["rejected", "inconclusive", null] as const) {
      const out = classifyPrior(prior({ triage: triage({ ciVerdict }) }), ctx);
      expect(out.status).toBe("suppressed");
    }
  });

  test("deferred and misclassified keep their status under a CI upheld verdict", () => {
    expect(
      classifyPrior(
        prior({
          triage: triage({
            tag: "deferred",
            verdict: null,
            ciVerdict: "upheld",
          }),
        }),
        ctx,
      ).status,
    ).toBe("deferred");
    expect(
      classifyPrior(
        prior({
          triage: triage({
            tag: "misclassified",
            verdict: null,
            ciVerdict: "upheld",
          }),
        }),
        ctx,
      ).status,
    ).toBe("re-tiered");
  });
});

describe("unresolvedBlockingCount — ci-dismissed", () => {
  const survivor: GateSurvivor = {
    path: "src/app.ts",
    line: 10,
    proof_refs: [],
    tier: "blocking",
  };
  const row = (status: GateRow["status"]): GateRow => ({
    id: "R001",
    tier: "blocking",
    locs: ["src/app.ts:10"],
    status,
  });

  test("a ci-dismissed blocking row with no survivors counts 0", () => {
    expect(unresolvedBlockingCount([], [row("ci-dismissed")])).toBe(0);
  });

  test("the same row as suppressed still counts 1", () => {
    expect(unresolvedBlockingCount([], [row("suppressed")])).toBe(1);
  });

  test("a blocking survivor at a ci-dismissed row's spot still counts 1", () => {
    expect(unresolvedBlockingCount([survivor], [row("ci-dismissed")])).toBe(1);
  });
});

describe("adjudicationQueue", () => {
  const dismissedBlocking = (id: string, over: Partial<PriorTriage> = {}) =>
    prior({ id, triage: triage(over) });

  test("includes a blocking dismissal with no CI verdict, in input order", () => {
    const queue = adjudicationQueue([
      dismissedBlocking("R001", { argument: "first" }),
      dismissedBlocking("R002", {
        replyId: 21,
        threadId: 30,
        argument: "second",
      }),
    ]);
    expect(queue).toEqual([
      {
        priorId: "R001",
        threadId: FINDING,
        replyId: 11,
        sev: "CRITICAL",
        locs: ["src/app.ts:10"],
        claim,
        argument: "first",
      },
      {
        priorId: "R002",
        threadId: 30,
        replyId: 21,
        sev: "CRITICAL",
        locs: ["src/app.ts:10"],
        claim,
        argument: "second",
      },
    ]);
  });

  test("includes an unrecoverable-tier blocking dismissal", () => {
    const queue = adjudicationQueue([
      prior({ id: "R009", tier: TIER_UNRECOVERABLE, triage: triage() }),
    ]);
    expect(queue.map((s) => s.priorId)).toEqual(["R009"]);
  });

  test("excludes advisory, already-adjudicated, and deferred priors", () => {
    const queue = adjudicationQueue([
      prior({ id: "A", tier: "advisory", triage: triage() }),
      prior({ id: "B", triage: triage({ ciVerdict: "upheld" }) }),
      prior({ id: "C", triage: triage({ tag: "deferred", verdict: null }) }),
    ]);
    expect(queue).toEqual([]);
  });

  test("caps the queue at MAX_ADJUDICATIONS_PER_RUN", () => {
    expect(MAX_ADJUDICATIONS_PER_RUN).toBe(5);
    const many = Array.from({ length: 7 }, (_, i) =>
      dismissedBlocking(`R${String(i + 1).padStart(3, "0")}`),
    );
    expect(adjudicationQueue(many)).toHaveLength(5);
  });
});

describe("assembleLive — ci-dismissed", () => {
  test("a settled ci-dismissed row gates as ci-dismissed and persists as suppressed", () => {
    const p = prior({ triage: triage({ ciVerdict: "upheld" }) });
    const settled = classifyPrior(p, ctx);
    const assembled = assembleLive({
      settled: [settled],
      priors: [p],
      verifyVerdicts: new Map(),
    });
    expect(assembled.gateRows).toEqual([
      {
        id: "R001",
        tier: "blocking",
        locs: ["src/app.ts:10"],
        status: "ci-dismissed",
      },
    ]);
    expect(assembled.live).toHaveLength(1);
    expect(assembled.live[0]?.status).toBe("suppressed");
    expect(unresolvedBlockingCount([], assembled.gateRows)).toBe(0);
  });
});
