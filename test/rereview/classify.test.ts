import { describe, expect, test } from "bun:test";
import {
  applyWorsening,
  classifyPrior,
  type HeldStatus,
  type PhaseBContext,
  type PriorRecord,
} from "#rereview/classify";
import type { FindingIdentity } from "#rereview/identity";

function prior(overrides: Partial<PriorRecord> = {}): PriorRecord {
  return {
    id: "R001",
    sev: "CRITICAL",
    tier: "blocking",
    channel: "inline",
    locs: ["src/app.ts:10"],
    claim: "a live defect",
    triage: null,
    newThreadReply: false,
    ...overrides,
  };
}

function ctx(overrides: Partial<PhaseBContext> = {}): PhaseBContext {
  return {
    case: "C",
    deletedFiles: new Set(),
    renameMap: new Map(),
    touched: () => false,
    summaryUpdatedAt: "2026-08-20T12:00:00Z",
    verifyAll: false,
    ...overrides,
  };
}

describe("rule 1 — every location's file deleted", () => {
  test("all files gone is verified-gone without a verification step", () => {
    const result = classifyPrior(
      prior({ locs: ["a.ts:1", "b.ts:2"] }),
      ctx({ deletedFiles: new Set(["a.ts", "b.ts"]) }),
    );
    expect(result.status).toBe("verified-gone");
    expect(result.trigger).toBeUndefined();
  });

  test("one surviving file is not verified-gone", () => {
    const result = classifyPrior(
      prior({ locs: ["a.ts:1", "b.ts:2"] }),
      ctx({
        deletedFiles: new Set(["a.ts"]),
        touched: () => true,
      }),
    );
    expect(result.status).toBe("queued");
    expect(result.trigger).toBe("touched");
  });
});

describe("rule 2 — rename before touched (R2-C1)", () => {
  test("rewrites locs onto the new path before touched() runs", () => {
    const seen: string[][] = [];
    const result = classifyPrior(
      prior({ locs: ["old.ts:10"] }),
      ctx({
        renameMap: new Map([["old.ts", "new.ts"]]),
        touched: (identity: FindingIdentity) => {
          seen.push([...identity.keys()]);
          return false;
        },
      }),
    );
    expect(result.renamed).toBe(true);
    expect(result.locs).toEqual(["new.ts:10"]);
    expect(seen).toEqual([["new.ts"]]);
    expect(result.status).toBe("carried");
  });

  test("a rename whose new path was then deleted is verified-gone", () => {
    const result = classifyPrior(
      prior({ locs: ["old.ts:10"] }),
      ctx({
        renameMap: new Map([["old.ts", "new.ts"]]),
        deletedFiles: new Set(["new.ts"]),
      }),
    );
    expect(result.status).toBe("verified-gone");
    expect(result.locs).toEqual(["new.ts:10"]);
  });
});

describe("rules 3–6 — triage outranks touched (O-3)", () => {
  test("dismissed+upheld is held, not settled, when the site moved", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "dismissed",
          verdict: "upheld",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ touched: () => true }),
    );
    expect(result).toMatchObject({
      status: "queued",
      trigger: "touched",
      held: "suppressed",
    });
  });

  test("dismissed+rejected returns blocking, no verify", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "dismissed",
          verdict: "rejected",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx(),
    );
    expect(result.status).toBe("returned");
  });

  test("deferred without an issue number (S6) is held while the site is touched", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "deferred",
          verdict: "upheld",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ touched: () => true }),
    );
    expect(result).toMatchObject({
      status: "queued",
      trigger: "touched",
      held: "deferred",
    });
  });

  test("misclassified is re-tiered, not re-hunted", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "misclassified",
          verdict: "upheld",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx(),
    );
    expect(result.status).toBe("re-tiered");
  });

  test("dismissed+inconclusive is not suppressed — touched still queues", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "dismissed",
          verdict: "inconclusive",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ touched: () => true }),
    );
    expect(result.status).toBe("queued");
    expect(result.trigger).toBe("touched");
  });
});

describe("rule 7 — applied", () => {
  test("case C queues verify for applied", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "applied",
          verdict: null,
          createdAt: "2026-08-19T00:00:00Z",
        },
      }),
      ctx({ case: "C" }),
    );
    expect(result).toMatchObject({ status: "queued", trigger: "applied" });
  });

  test("case B does not re-buy an applied tag older than the summary (R2-S9)", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "applied",
          verdict: null,
          createdAt: "2026-08-19T00:00:00Z",
        },
      }),
      ctx({ case: "B", summaryUpdatedAt: "2026-08-20T12:00:00Z" }),
    );
    expect(result.status).toBe("carried");
  });

  test("case B queues a NEW applied tag", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "applied",
          verdict: null,
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ case: "B", summaryUpdatedAt: "2026-08-20T12:00:00Z" }),
    );
    expect(result).toMatchObject({ status: "queued", trigger: "applied" });
  });
});

describe("rule 7b — case B new reply", () => {
  test("a new thread reply queues verify when there is no new applied tag", () => {
    const result = classifyPrior(
      prior({ newThreadReply: true }),
      ctx({ case: "B" }),
    );
    expect(result).toMatchObject({ status: "queued", trigger: "case_b_reply" });
  });
});

describe("rules 8–9 — touched vs carried", () => {
  test("touched queues verify", () => {
    const result = classifyPrior(prior(), ctx({ touched: () => true }));
    expect(result).toMatchObject({ status: "queued", trigger: "touched" });
  });

  test("untouched with no triage is carried — never resolved from absence", () => {
    const result = classifyPrior(prior(), ctx());
    expect(result.status).toBe("carried");
    expect(result.trigger).toBeUndefined();
  });
});

describe("case D/E — verify-all after triage settles", () => {
  test("an unsettled prior is queued as verify_all", () => {
    const result = classifyPrior(prior(), ctx({ case: "D" }));
    expect(result).toMatchObject({ status: "queued", trigger: "verify_all" });
  });

  test("dismissed+upheld is held as verify_all in case D (O-3 settles it after verification)", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "dismissed",
          verdict: "upheld",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ case: "D" }),
    );
    expect(result).toMatchObject({
      status: "queued",
      trigger: "verify_all",
      held: "suppressed",
    });
  });

  test("a deleted file is still verified-gone, not verify_all", () => {
    const result = classifyPrior(
      prior(),
      ctx({ case: "E", deletedFiles: new Set(["src/app.ts"]) }),
    );
    expect(result.status).toBe("verified-gone");
  });
});

// Rereview-coverage fix wiring gap: `ctx.verifyAll` must force verify_all
// exactly like case D/E do, for ANY case — this is how a forced-full
// re-review (case stays B or C; only discovery widens, per R2-C5) actually
// re-verifies every prior instead of leaving `plan.verifyAll` a documented
// but unread flag. A triage settlement (dismissed/deferred/misclassified) is
// held and queued the same way, so verification can see a fix that touched
// the finding's code; it settles back to the held status only when the
// verifier does not refute the finding (see the held describe block below).
describe("verifyAll (rereview-coverage fix) — forces verify_all outside D/E", () => {
  test("case B with verifyAll queues verify_all even though case B alone would not", () => {
    const result = classifyPrior(prior(), ctx({ case: "B", verifyAll: true }));
    expect(result).toMatchObject({ status: "queued", trigger: "verify_all" });
  });

  test("case C with verifyAll queues verify_all even on an untouched file", () => {
    const result = classifyPrior(
      prior(),
      ctx({ case: "C", verifyAll: true, touched: () => false }),
    );
    expect(result).toMatchObject({ status: "queued", trigger: "verify_all" });
  });

  test("verifyAll holds a triage settlement and queues it as verify_all", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "dismissed",
          verdict: "upheld",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ case: "B", verifyAll: true }),
    );
    expect(result).toMatchObject({
      status: "queued",
      trigger: "verify_all",
      held: "suppressed",
    });
  });

  test("verifyAll does not override verified-gone", () => {
    const result = classifyPrior(
      prior(),
      ctx({
        case: "C",
        verifyAll: true,
        deletedFiles: new Set(["src/app.ts"]),
      }),
    );
    expect(result.status).toBe("verified-gone");
  });
});

describe("W-worse — phase E lifts suppression only on strictly higher sev", () => {
  test("same-severity discovery stays suppressed", () => {
    const { settled, hits } = applyWorsening({
      settled: [
        {
          id: "R001",
          status: "suppressed",
          locs: ["src/app.ts:10"],
          renamed: false,
        },
      ],
      priors: [prior({ sev: "CRITICAL" })],
      survivors: [
        {
          path: "src/app.ts",
          line: 10,
          proof_refs: [],
          severity: "CRITICAL",
        },
      ],
    });
    expect(settled[0]?.status).toBe("suppressed");
    expect(hits).toEqual([]);
  });

  test("strictly higher discovery returns the prior", () => {
    const { settled, hits } = applyWorsening({
      settled: [
        {
          id: "R001",
          status: "suppressed",
          locs: ["src/app.ts:10"],
          renamed: false,
        },
      ],
      priors: [prior({ sev: "WARNING" })],
      survivors: [
        {
          path: "src/app.ts",
          line: 12,
          proof_refs: ["src/app.ts:10"],
          severity: "CRITICAL",
        },
      ],
    });
    expect(settled[0]?.status).toBe("returned");
    expect(hits).toEqual([
      { priorId: "R001", priorSev: "WARNING", discoverySev: "CRITICAL" },
    ]);
  });
});

// A held settlement is a triage outcome the prior would take without
// verification. A push that touches the finding's code (or a verify-all
// case) queues it, so a fix the author pushed is verified before the gate
// counts the finding. The held status is what the verifier's "still present"
// or "inconclusive" answer settles to (assembleLive in rereview/state.ts).
describe("held triage — a touching push queues the settlement for verification", () => {
  const triaged: Array<[string, PriorRecord["triage"], HeldStatus]> = [
    [
      "dismissed+rejected",
      {
        tag: "dismissed",
        verdict: "rejected",
        createdAt: "2026-08-21T00:00:00Z",
      },
      "returned",
    ],
    [
      "dismissed+upheld",
      {
        tag: "dismissed",
        verdict: "upheld",
        createdAt: "2026-08-21T00:00:00Z",
      },
      "suppressed",
    ],
    [
      "deferred",
      { tag: "deferred", verdict: "upheld", createdAt: "2026-08-21T00:00:00Z" },
      "deferred",
    ],
    [
      "misclassified",
      {
        tag: "misclassified",
        verdict: "upheld",
        createdAt: "2026-08-21T00:00:00Z",
      },
      "re-tiered",
    ],
  ];
  for (const [name, triage, held] of triaged) {
    test(`${name}: untouched stays ${held} and is not queued`, () => {
      const result = classifyPrior(prior({ triage }), ctx());
      expect(result).toEqual({
        id: "R001",
        status: held,
        locs: ["src/app.ts:10"],
        renamed: false,
      });
    });

    test(`${name}: touched is queued as touched, holding ${held}`, () => {
      const result = classifyPrior(
        prior({ triage }),
        ctx({ touched: () => true }),
      );
      expect(result).toMatchObject({
        status: "queued",
        trigger: "touched",
        held,
      });
    });

    test(`${name}: case D is queued as verify_all, holding ${held}`, () => {
      const result = classifyPrior(prior({ triage }), ctx({ case: "D" }));
      expect(result).toMatchObject({
        status: "queued",
        trigger: "verify_all",
        held,
      });
    });
  }

  test("ci-dismissed keeps its precedence over a touched site: never queued", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "dismissed",
          verdict: "upheld",
          ciVerdict: "upheld",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ case: "D", touched: () => true }),
    );
    expect(result.status).toBe("ci-dismissed");
    expect(result.held).toBeUndefined();
  });

  test("a deleted file keeps verified-gone precedence over a held settlement", () => {
    const result = classifyPrior(
      prior({
        triage: {
          tag: "deferred",
          verdict: "upheld",
          createdAt: "2026-08-21T00:00:00Z",
        },
      }),
      ctx({ deletedFiles: new Set(["src/app.ts"]), touched: () => true }),
    );
    expect(result.status).toBe("verified-gone");
  });

  // applyWorsening runs before verification and used to see only a `suppressed`
  // row. A held suppressed row must still be worsened: it stays queued (the
  // verifier still runs on the touched code) and holds `returned`.
  test("a worsening survivor turns a held suppressed row into a held returned row", () => {
    const suppressed = prior({
      triage: {
        tag: "dismissed",
        verdict: "upheld",
        createdAt: "2026-08-21T00:00:00Z",
      },
    });
    const worsened = applyWorsening({
      settled: [classifyPrior(suppressed, ctx({ touched: () => true }))],
      priors: [suppressed],
      survivors: [
        { path: "src/app.ts", line: 10, proof_refs: [], severity: "BLOCKER" },
      ],
    });
    expect(worsened.hits).toHaveLength(1);
    expect(worsened.settled[0]).toMatchObject({
      status: "queued",
      trigger: "touched",
      held: "returned",
    });
  });
});
