import { describe, expect, test } from "bun:test";
import {
  classifyPrior,
  type PhaseBContext,
  type PriorRecord,
} from "#rereview/classify";
import { priorsFromStateFindings } from "#rereview/prepare";
import {
  assembleLive,
  type GateRow,
  type GateSurvivor,
  materialityReleasedIds,
  parseStateBlock,
  renderStateBlock,
  unresolvedBlockingCount,
} from "#rereview/state";

const HEAD = "8da9fad5bc9f650df38fc8cb0237253d80ff3245";

// One survivor of THIS run, as doc.findings carries it. Only the identity
// fields and the tier are read by the count.
function survivor(
  line: number,
  tier: "blocking" | "advisory",
  path = "src/app.ts",
): GateSurvivor {
  return { path, line, proof_refs: [], tier };
}

function row(id: string, over: Partial<GateRow> = {}): GateRow {
  return {
    id,
    tier: "blocking",
    locs: ["src/app.ts:10"],
    status: "carried",
    claim: `the cached width is scaled twice (${id})`,
    ...over,
  };
}

describe("unresolvedBlockingCount — what the gate counts", () => {
  test("no survivors and no gate rows is zero", () => {
    expect(unresolvedBlockingCount([], [])).toBe(0);
  });

  test("this run's blocking survivors count, advisory survivors do not", () => {
    expect(
      unresolvedBlockingCount(
        [survivor(3, "blocking"), survivor(9, "advisory")],
        [],
      ),
    ).toBe(1);
  });

  test("a carried blocking prior with no survivor counts (case C, untouched)", () => {
    expect(
      unresolvedBlockingCount([], [row("R001", { status: "carried" })]),
    ).toBe(1);
  });

  test("an unconfirmed blocking prior counts (verifier inconclusive or never ran)", () => {
    expect(
      unresolvedBlockingCount([], [row("R001", { status: "unconfirmed" })]),
    ).toBe(1);
  });

  test("a deferred blocking prior counts", () => {
    expect(
      unresolvedBlockingCount([], [row("R001", { status: "deferred" })]),
    ).toBe(1);
  });

  test("a suppressed blocking prior counts: a self-asserted upheld dismissal never lowers the gate", () => {
    expect(
      unresolvedBlockingCount([], [row("R001", { status: "suppressed" })]),
    ).toBe(1);
  });

  test("a verified-gone prior does not count", () => {
    expect(
      unresolvedBlockingCount([], [row("R001", { status: "verified-gone" })]),
    ).toBe(0);
  });

  test("a prior whose every file was deleted does not count (settled verified-gone)", () => {
    // classifyPrior settles a deleted-file prior as verified-gone, and
    // assembleLive keeps that status out of the gate rows entirely.
    const ctx: PhaseBContext = {
      case: "C",
      deletedFiles: new Set(["src/app.ts"]),
      renameMap: new Map(),
      touched: () => false,
      summaryUpdatedAt: null,
    };
    const prior: PriorRecord = {
      id: "R001",
      sev: "CRITICAL",
      tier: "blocking",
      channel: "inline",
      locs: ["src/app.ts:10"],
      claim: "deleted",
      triage: null,
      newThreadReply: false,
    };
    const settled = classifyPrior(prior, ctx);
    const assembled = assembleLive({
      settled: [settled],
      priors: [prior],
      verifyVerdicts: new Map(),
    });
    expect(settled.status).toBe("verified-gone");
    expect(unresolvedBlockingCount([], assembled.gateRows)).toBe(0);
  });

  test("a prior the verifier refuted does not count", () => {
    expect(
      unresolvedBlockingCount([], [row("R001", { status: "verified-gone" })]),
    ).toBe(0);
  });

  test("an advisory prior never counts, whatever its status", () => {
    expect(
      unresolvedBlockingCount(
        [],
        [row("R001", { tier: "advisory", status: "carried" })],
      ),
    ).toBe(0);
  });

  // The recovered tier is `unrecoverable` when no tier could be read back.
  // Fail closed: an unclassified open finding counts as blocking, because a
  // green gate on a finding we cannot classify is the defect S7 forbids. This
  // pins the decision so that a change to it is deliberate and visible.
  test("an unrecoverable-tier open prior counts as blocking (fail closed)", () => {
    expect(
      unresolvedBlockingCount(
        [],
        [row("R001", { tier: "unrecoverable", status: "carried" })],
      ),
    ).toBe(1);
  });

  test("an unrecoverable-tier prior is still cleared by a verifier verdict", () => {
    expect(
      unresolvedBlockingCount(
        [],
        [row("R001", { tier: "unrecoverable", status: "verified-gone" })],
      ),
    ).toBe(0);
  });
});

describe("unresolvedBlockingCount — an advisory survivor never clears a blocking prior", () => {
  test("a blocking prior re-found by an advisory survivor at the same location still counts", () => {
    expect(
      unresolvedBlockingCount(
        [survivor(10, "advisory")],
        [row("R001", { status: "carried" })],
      ),
    ).toBe(1);
  });

  test("a blocking prior and an advisory survivor 3 lines apart in the same file still count", () => {
    // The identity match is a 5-line window, so this unrelated advisory
    // finding pairs by location alone. It must not clear the blocking prior.
    expect(
      unresolvedBlockingCount(
        [survivor(13, "advisory")],
        [row("R001", { status: "carried" })],
      ),
    ).toBe(1);
  });

  test("a blocking survivor carries an unrecoverable prior at the same spot: one, not two", () => {
    expect(
      unresolvedBlockingCount(
        [survivor(10, "blocking")],
        [row("R001", { tier: "unrecoverable", status: "carried" })],
      ),
    ).toBe(1);
  });

  test("an advisory survivor cannot take the second blocking prior at one spot", () => {
    expect(
      unresolvedBlockingCount(
        [survivor(10, "blocking"), survivor(10, "advisory")],
        [
          row("R001", { status: "carried" }),
          row("R002", { status: "carried" }),
        ],
      ),
    ).toBe(2);
  });

  test("a self-asserted misclassified prior still counts when no survivor of this run carries it", () => {
    // `misclassified` lands as re-tiered (classify.ts:159-161). The triage tag
    // is the author's own claim, so the gate must not take its word for it.
    expect(
      unresolvedBlockingCount([], [row("R001", { status: "re-tiered" })]),
    ).toBe(1);
  });

  test("a self-asserted misclassified prior is not lowered by an advisory survivor at its spot", () => {
    expect(
      unresolvedBlockingCount(
        [survivor(10, "advisory")],
        [row("R001", { status: "re-tiered" })],
      ),
    ).toBe(1);
  });
});

// A survivor the materiality gate demoted from blocking: advisory, carrying the
// judge's immaterial verdict, exactly as doc.findings holds it.
function demoted(line: number, path = "src/app.ts"): GateSurvivor {
  return {
    ...survivor(line, "advisory", path),
    materiality: { label: "immaterial", reason: "needs a pathological input" },
  };
}

// A survivor #457's causal rule demoted: CRITICAL and corroborated, so it would
// block as introduced, but the PR did not cause it.
function causallyDemoted(
  line: number,
  over: Partial<GateSurvivor> = {},
): GateSurvivor {
  return {
    ...survivor(line, "advisory"),
    severity: "CRITICAL",
    evidence_class: "inferential",
    refuter_verdict: "corroborated",
    causal_disposition: "pre-existing",
    claim: "the cached width is scaled twice",
    ...over,
  };
}

describe("unresolvedBlockingCount — a causally demoted survivor releases its blocking prior (#457)", () => {
  test("a blocking prior re-found as pre-existing no longer counts", () => {
    expect(
      unresolvedBlockingCount(
        [causallyDemoted(10)],
        [row("R001", { status: "carried" })],
      ),
    ).toBe(0);
  });

  test("a pre-existing survivor that would not have blocked anyway releases nothing", () => {
    expect(
      unresolvedBlockingCount(
        [causallyDemoted(10, { refuter_verdict: "not_submitted" })],
        [row("R001", { status: "carried" })],
      ),
    ).toBe(1);
  });

  test("a survivor without its causal fields releases nothing (fail closed)", () => {
    expect(
      unresolvedBlockingCount(
        [survivor(10, "advisory")],
        [row("R001", { status: "carried" })],
      ),
    ).toBe(1);
  });

  test("a protected prior is never released by a causal demotion", () => {
    expect(
      unresolvedBlockingCount(
        [causallyDemoted(10)],
        [
          row("R001", {
            status: "carried",
            claim: "the session token is written to the log",
          }),
        ],
      ),
    ).toBe(1);
  });
});

describe("unresolvedBlockingCount — a materiality-demoted survivor releases its blocking prior", () => {
  test("a blocking prior re-found and demoted by the materiality gate no longer counts", () => {
    expect(
      unresolvedBlockingCount(
        [demoted(10)],
        [row("R001", { status: "carried" })],
      ),
    ).toBe(0);
  });

  test("a demoted survivor releases one blocking prior only: a second at the same spot still counts", () => {
    expect(
      unresolvedBlockingCount(
        [demoted(10)],
        [
          row("R001", { status: "carried" }),
          row("R002", { status: "carried" }),
        ],
      ),
    ).toBe(1);
  });

  test("a demoted survivor never releases an unrecoverable prior (fail closed)", () => {
    expect(
      unresolvedBlockingCount(
        [demoted(10)],
        [row("R001", { tier: "unrecoverable", status: "carried" })],
      ),
    ).toBe(1);
  });

  test("an advisory survivor with a material verdict does not release the prior", () => {
    expect(
      unresolvedBlockingCount(
        [
          {
            ...survivor(10, "advisory"),
            materiality: { label: "material", reason: "reachable" },
          },
        ],
        [row("R001", { status: "carried" })],
      ),
    ).toBe(1);
  });

  test("a demoted survivor on another file does not release the prior", () => {
    expect(
      unresolvedBlockingCount(
        [demoted(10, "src/other.ts")],
        [row("R001", { status: "carried" })],
      ),
    ).toBe(1);
  });

  test("a prior the materiality safety guard protects is never released, even by a demoted survivor at its spot", () => {
    // The guard read only the survivor's claim. The window can pair it with a
    // different prior, and this one names a leaked session token.
    const rows = [
      row("R001", {
        claim: "the session token is written to the debug log on every request",
      }),
    ];
    expect(unresolvedBlockingCount([demoted(10)], rows)).toBe(1);
    expect(materialityReleasedIds([demoted(10)], rows)).toEqual([]);
  });

  test("a prior whose path the safety guard protects is never released", () => {
    const rows = [row("R001", { locs: ["src/auth/session.ts:10"] })];
    expect(
      unresolvedBlockingCount([demoted(10, "src/auth/session.ts")], rows),
    ).toBe(1);
  });

  test("a prior with no known claim is never released (fail closed)", () => {
    const rows = [row("R001", { claim: undefined })];
    expect(unresolvedBlockingCount([demoted(10)], rows)).toBe(1);
  });

  test("a prior whose claim is blank is never released: the codebase writes an unknown claim as an empty string", () => {
    for (const claim of ["", "   "]) {
      const rows = [row("R001", { claim })];
      expect(unresolvedBlockingCount([demoted(10)], rows)).toBe(1);
    }
  });

  test("blocking survivors pair first, so a demoted survivor cannot take the row an unrecoverable prior relies on", () => {
    // The blocking survivor matches both rows and prefers the blocking one. If
    // the demoted survivor went first it would take that row, push the
    // blocking survivor onto the unrecoverable row, and the count would drop.
    expect(
      unresolvedBlockingCount(
        [demoted(10), survivor(10, "blocking")],
        [
          row("R001", { status: "carried" }),
          row("R002", { tier: "unrecoverable", status: "carried" }),
        ],
      ),
    ).toBe(2);
  });
});

describe("materialityReleasedIds — the ids the count released, for the state merge", () => {
  test("names the blocking prior a demoted survivor released", () => {
    expect(
      materialityReleasedIds(
        [demoted(10)],
        [row("R001", { status: "carried" })],
      ),
    ).toEqual(["R001"]);
  });

  test("names nothing for a plain advisory survivor, or a prior a blocking survivor carries", () => {
    expect(
      materialityReleasedIds(
        [survivor(10, "advisory"), survivor(30, "blocking")],
        [
          row("R001", { status: "carried" }),
          row("R002", { status: "carried", locs: ["src/app.ts:30"] }),
        ],
      ),
    ).toEqual([]);
  });

  test("skips a ci-dismissed prior the count skips, and names the carried one beside it", () => {
    // The state merge sees the ci-dismissed row as suppressed. Pairing again
    // there would take it first and leave the carried row blocking, while the
    // count already released the carried one.
    const rows = [
      row("R001", { status: "ci-dismissed" }),
      row("R002", { status: "carried" }),
    ];
    expect(unresolvedBlockingCount([demoted(10)], rows)).toBe(0);
    expect(materialityReleasedIds([demoted(10)], rows)).toEqual(["R002"]);
  });

  test("names a returned prior the count released, even though the state no longer holds it", () => {
    const rows = [
      row("R001", { status: "returned" }),
      row("R002", { status: "carried" }),
    ];
    expect(unresolvedBlockingCount([demoted(10)], rows)).toBe(1);
    expect(materialityReleasedIds([demoted(10)], rows)).toEqual(["R001"]);
  });
});

describe("unresolvedBlockingCount — dedupe, each finding counted once", () => {
  test("a carried prior re-found as a blocking survivor counts once", () => {
    expect(
      unresolvedBlockingCount(
        [survivor(10, "blocking")],
        [row("R001", { status: "carried" })],
      ),
    ).toBe(1);
  });

  test("a returned prior re-raised as a blocking survivor counts once, not twice", () => {
    expect(
      unresolvedBlockingCount(
        [survivor(10, "blocking")],
        [row("R001", { status: "returned" })],
      ),
    ).toBe(1);
  });

  test("a returned prior with no survivor still counts: a rejected dismissal reopens it", () => {
    expect(
      unresolvedBlockingCount([], [row("R001", { status: "returned" })]),
    ).toBe(1);
  });

  test("the same prior id appearing twice counts once", () => {
    expect(
      unresolvedBlockingCount(
        [],
        [
          row("R001", { status: "carried" }),
          row("R001", { status: "carried" }),
        ],
      ),
    ).toBe(1);
  });

  test("one survivor absorbs one prior only: a second prior at the same spot still counts", () => {
    expect(
      unresolvedBlockingCount(
        [survivor(10, "blocking")],
        [
          row("R001", { status: "carried" }),
          row("R002", { status: "carried" }),
        ],
      ),
    ).toBe(2);
  });

  test("a survivor pairs with the prior of its own tier before another prior at the same spot", () => {
    // S is blocking. A is an advisory prior at the same spot, B is blocking.
    // S pairs with B, so only the survivor counts, and A is not blocking.
    expect(
      unresolvedBlockingCount(
        [survivor(10, "blocking")],
        [
          row("R001", { tier: "advisory", status: "carried" }),
          row("R002", { tier: "blocking", status: "carried" }),
        ],
      ),
    ).toBe(1);
  });

  test("a prior on another file is not matched by a survivor", () => {
    expect(
      unresolvedBlockingCount(
        [survivor(10, "blocking", "src/other.ts")],
        [row("R001", { status: "carried", locs: ["src/app.ts:10"] })],
      ),
    ).toBe(2);
  });
});

// S7 pin. No triage marker content can lower the gate count. Every status a
// triage marker can produce, and the self-asserted verdict on it, must leave
// the count where it was. Only a verifier verdict or a deleted file lowers it.
describe("S7 — self-asserted triage never lowers the gate", () => {
  const ctx: PhaseBContext = {
    case: "C",
    deletedFiles: new Set(),
    renameMap: new Map(),
    touched: () => false,
    summaryUpdatedAt: null,
  };

  const base: PriorRecord = {
    id: "R001",
    sev: "CRITICAL",
    tier: "blocking",
    channel: "inline",
    locs: ["src/app.ts:10"],
    claim: "blocking prior",
    triage: null,
    newThreadReply: false,
  };

  const cases: readonly { name: string; triage: PriorRecord["triage"] }[] = [
    { name: "none", triage: null },
    {
      name: "dismissed + upheld",
      triage: { tag: "dismissed", verdict: "upheld", createdAt: null },
    },
    {
      name: "dismissed + rejected",
      triage: { tag: "dismissed", verdict: "rejected", createdAt: null },
    },
    {
      name: "deferred",
      triage: { tag: "deferred", verdict: null, createdAt: null },
    },
    {
      name: "misclassified",
      triage: { tag: "misclassified", verdict: null, createdAt: null },
    },
    {
      name: "applied (no verifier verdict yet)",
      triage: { tag: "applied", verdict: null, createdAt: null },
    },
  ];

  for (const c of cases) {
    test(`triage "${c.name}" with no verifier verdict keeps the blocking prior counted`, () => {
      const prior = { ...base, triage: c.triage };
      const settled = classifyPrior(prior, ctx);
      const assembled = assembleLive({
        settled: [settled],
        priors: [prior],
        verifyVerdicts: new Map(),
      });
      expect(unresolvedBlockingCount([], assembled.gateRows)).toBe(1);
    });
  }
});

// S7 across pushes. The author's triage stays on the thread, so every run
// re-reads it. The only memory a run hands the next one is the state block, so
// the round trip goes through renderStateBlock and parseStateBlock, the same
// seam the next run reads.
describe("S7 — a triage-returned blocking prior stays open across pushes", () => {
  const ctx: PhaseBContext = {
    case: "C",
    deletedFiles: new Set(),
    renameMap: new Map(),
    touched: () => false,
    summaryUpdatedAt: null,
  };

  const triages: readonly { name: string; triage: PriorRecord["triage"] }[] = [
    {
      name: "misclassified",
      triage: { tag: "misclassified", verdict: null, createdAt: null },
    },
    {
      name: "dismissed + rejected",
      triage: { tag: "dismissed", verdict: "rejected", createdAt: null },
    },
  ];

  for (const t of triages) {
    test(`${t.name}: run N and run N+1 both count the prior`, () => {
      const runNPrior: PriorRecord = {
        id: "R001",
        sev: "CRITICAL",
        tier: "blocking",
        channel: "inline",
        locs: ["src/app.ts:10"],
        claim: "a live defect",
        triage: t.triage,
        newThreadReply: false,
      };
      const runN = assembleLive({
        settled: [classifyPrior(runNPrior, ctx)],
        priors: [runNPrior],
        verifyVerdicts: new Map(),
      });
      expect(unresolvedBlockingCount([], runN.gateRows)).toBe(1);
      expect(runN.live.map((row) => row.status)).toEqual(["carried"]);

      const stored = parseStateBlock(renderStateBlock(HEAD, runN.live));
      const restored = priorsFromStateFindings(stored?.findings ?? []);
      expect(restored.map((p) => p.id)).toEqual(["R001"]);
      const runN1Priors = restored.map((p) => ({ ...p, triage: t.triage }));
      const runN1 = assembleLive({
        settled: runN1Priors.map((p) => classifyPrior(p, ctx)),
        priors: runN1Priors,
        verifyVerdicts: new Map(),
      });
      expect(unresolvedBlockingCount([], runN1.gateRows)).toBe(1);
    });
  }
});
