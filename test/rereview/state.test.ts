import { describe, expect, test } from "bun:test";
import {
  claimFingerprint,
  PR_COMMENT_MARKER_PREFIX,
  PR_FINDING_MARKER_PREFIX,
  parseFindingMarker,
  prCommentMarker,
} from "#pr/preflight";
import {
  applyWorsening,
  classifyPrior,
  type PhaseBContext,
  type PriorRecord,
  SEVERITY_UNRECOVERABLE,
  TIER_UNRECOVERABLE,
} from "#rereview/classify";
import {
  assembleLive,
  capLiveFindings,
  type LiveFinding,
  PR_STATE_MARKER_PREFIX,
  parseStateBlock,
  renderStateBlock,
  type StateFinding,
  stateFinding,
} from "#rereview/state";
import { TRIAGE_MARKER_PREFIX } from "#triage/triage";

const HEAD = "8da9fad5bc9f650df38fc8cb0237253d80ff3245";

function finding(
  id: string,
  overrides: Partial<Omit<StateFinding, "id">> = {},
): StateFinding {
  return stateFinding({
    id,
    sev: "CRITICAL",
    tier: "blocking",
    channel: "inline",
    locs: ["src/app.ts:10"],
    claim: `claim for ${id}`,
    ...overrides,
  });
}

function live(
  id: string,
  status: LiveFinding["status"],
  overrides: Partial<Omit<StateFinding, "id">> = {},
): LiveFinding {
  return { ...finding(id, overrides), status };
}

describe("D5a — parseFindingMarker returns null for the state block", () => {
  test("a state block is not a finding marker", () => {
    const block = renderStateBlock(HEAD, [finding("R001")]);
    expect(parseFindingMarker(block)).toBeNull();
    expect(parseFindingMarker(`${block}\nmore body`)).toBeNull();
  });
});

describe("prefix disjointness", () => {
  test("state prefix is not a prefix of report, finding, or triage — or vice versa", () => {
    const prefixes = [
      PR_COMMENT_MARKER_PREFIX,
      PR_FINDING_MARKER_PREFIX,
      TRIAGE_MARKER_PREFIX,
      PR_STATE_MARKER_PREFIX,
    ];
    for (let i = 0; i < prefixes.length; i++) {
      for (let j = 0; j < prefixes.length; j++) {
        if (i === j) continue;
        expect(prefixes[i]?.startsWith(prefixes[j] as string)).toBe(false);
      }
    }
  });
});

describe("render / parse round-trip", () => {
  test("recovers head and findings from a body that starts with the report marker", () => {
    const stored = [
      finding("R001", { channel: "inline", locs: ["a.ts:1-4"] }),
      finding("R002", {
        channel: "outside",
        claim: "the only copy of an Outside Diff finding",
      }),
    ];
    const body = `${prCommentMarker(HEAD)}\nvisible report\n${renderStateBlock(HEAD, stored)}`;
    expect(body.startsWith(PR_COMMENT_MARKER_PREFIX)).toBe(true);
    const parsed = parseStateBlock(body);
    expect(parsed?.headSha).toBe(HEAD);
    expect(parsed?.findings).toEqual(stored);
  });

  test("D5e — a claim containing --> and quotes round-trips", () => {
    const stored = [
      finding("R001", {
        claim: 'foo --> bar "quoted" and a \\ slash',
        locs: ["a.ts:1"],
      }),
    ];
    const rendered = renderStateBlock(HEAD, stored);
    expect(rendered).not.toContain("--> bar");
    expect(parseStateBlock(rendered)?.findings[0]?.claim).toBe(
      stored[0]?.claim,
    );
  });

  test("malformed JSON is a match failure, not a throw", () => {
    const body = `${stateish()}\n<!-- {not json} -->`;
    expect(parseStateBlock(body)).toBeNull();
  });

  test("reviews counter round-trips", () => {
    const body = renderStateBlock(HEAD, [finding("R001")], 2);
    expect(parseStateBlock(body)?.reviews).toBe(2);
  });

  // #206 constraint: the JSON shape a state block already posted before this
  // fix — real Severity/Tier values only, never the new sentinels — must
  // still parse unchanged. Hand-built, not run through `renderStateBlock`,
  // so this is genuinely the OLD wire format and not just today's renderer
  // exercising its own parser.
  test("#206 — an old-format block (real sev/tier only, no sentinel) still parses", () => {
    const body =
      `${stateish()}\n` +
      '<!-- {"findings":[{"id":"R001","sev":"BLOCKER","tier":"blocking",' +
      '"channel":"inline","locs":["a.ts:1"],"c":"aaaaaaaaaaaa","claim":"old"}]} -->';
    expect(parseStateBlock(body)?.findings).toEqual([
      {
        id: "R001",
        sev: "BLOCKER",
        tier: "blocking",
        channel: "inline",
        locs: ["a.ts:1"],
        c: "aaaaaaaaaaaa",
        claim: "old",
      },
    ]);
  });

  // Additive-only widening, the other direction: a block a POST-fix run
  // wrote, carrying the sentinel, must also parse — `isRecoveredSeverity`/
  // `isRecoveredTier` accept it on top of the 4/2 real values.
  test("#206 — a block carrying the UNRECOVERABLE sentinel parses too", () => {
    const body =
      `${stateish()}\n` +
      `<!-- {"findings":[{"id":"R001","sev":"${SEVERITY_UNRECOVERABLE}",` +
      `"tier":"${TIER_UNRECOVERABLE}","channel":"inline","locs":["a.ts:1"],` +
      '"c":"bbbbbbbbbbbb","claim":""}]} -->';
    expect(parseStateBlock(body)?.findings[0]).toEqual({
      id: "R001",
      sev: SEVERITY_UNRECOVERABLE,
      tier: TIER_UNRECOVERABLE,
      channel: "inline",
      locs: ["a.ts:1"],
      c: "bbbbbbbbbbbb",
      claim: "",
    });
  });
});

describe("D5b — cap evicts unconfirmed then carried, never suppressed or deferred", () => {
  test("drops unconfirmed before carried, and keeps suppressed + deferred", () => {
    const entries = [
      live("R001", "suppressed"),
      live("R002", "deferred"),
      live("R003", "carried", { claim: "c".repeat(80), tier: "advisory" }),
      live("R004", "unconfirmed", { claim: "u".repeat(80), tier: "advisory" }),
    ];
    const prefix = "x".repeat(200);
    const result = capLiveFindings(entries, prefix, HEAD, 400);
    expect(result.kept.map((e) => e.id)).not.toContain("R004");
    expect(result.droppedUnconfirmed).toBeGreaterThan(0);
    expect(result.kept.some((e) => e.status === "suppressed")).toBe(true);
    expect(result.kept.some((e) => e.status === "deferred")).toBe(true);
    expect(result.kept.some((e) => e.status === "unconfirmed")).toBe(false);
  });

  test("never drops suppressed even when they are the only entries left", () => {
    const entries = [live("R001", "suppressed"), live("R002", "deferred")];
    const result = capLiveFindings(entries, "x".repeat(500), HEAD, 100);
    expect(result.kept.map((e) => e.id)).toEqual(["R001", "R002"]);
    expect(result.droppedUnconfirmed).toBe(0);
    expect(result.droppedCarried).toBe(0);
  });
});

function stateish(): string {
  return `<!-- pr-hero-state v=1 head=${HEAD} -->`;
}

describe("assembleLive", () => {
  test("queued priors take the verify verdict; capped ones stay unconfirmed", () => {
    const priors = [
      {
        id: "R001",
        sev: "CRITICAL" as const,
        tier: "blocking" as const,
        channel: "inline" as const,
        locs: ["src/app.ts:10"],
        claim: "still live",
        triage: null,
        newThreadReply: false,
      },
      {
        id: "R002",
        sev: "WARNING" as const,
        tier: "advisory" as const,
        channel: "inline" as const,
        locs: ["src/b.ts:1"],
        claim: "capped",
        triage: null,
        newThreadReply: false,
      },
    ];
    const assembled = assembleLive({
      settled: [
        {
          id: "R001",
          status: "queued",
          locs: ["src/app.ts:10"],
          renamed: false,
          trigger: "touched",
        },
        {
          id: "R002",
          status: "queued",
          locs: ["src/b.ts:1"],
          renamed: false,
          trigger: "verify_all",
        },
      ],
      priors,
      verifyVerdicts: new Map([["R001", "verified-gone"]]),
    });
    expect(assembled.verifiedGone).toBe(1);
    expect(assembled.verifiedGoneIds).toEqual(["R001"]);
    expect(assembled.live.map((row) => `${row.id}:${row.status}`)).toEqual([
      "R002:unconfirmed",
    ]);
  });

  // #206's second-order bug: `claimFingerprint("")` is a REAL constant
  // (e3b0c44298fc), not an absence marker. Two distinct claim-less priors
  // (e.g. two posted-marker recoveries whose comment bodies both failed to
  // parse) must never collapse onto that one shared `c`.
  test("#206 — two claim-less carried rows never collide on `c`", () => {
    const priors = [
      {
        id: "R001",
        sev: SEVERITY_UNRECOVERABLE,
        tier: TIER_UNRECOVERABLE,
        channel: "inline" as const,
        locs: ["src/a.ts:1"],
        claim: "",
        triage: null,
        newThreadReply: false,
      },
      {
        id: "R002",
        sev: SEVERITY_UNRECOVERABLE,
        tier: TIER_UNRECOVERABLE,
        channel: "inline" as const,
        locs: ["src/b.ts:2"],
        claim: "",
        triage: null,
        newThreadReply: false,
      },
    ];
    const assembled = assembleLive({
      settled: [
        { id: "R001", status: "carried", locs: ["src/a.ts:1"], renamed: false },
        { id: "R002", status: "carried", locs: ["src/b.ts:2"], renamed: false },
      ],
      priors,
      verifyVerdicts: new Map(),
    });
    const [row1, row2] = assembled.live;
    expect(row1?.c).not.toBe(claimFingerprint(""));
    expect(row2?.c).not.toBe(claimFingerprint(""));
    expect(row1?.c).not.toBe(row2?.c);
  });

  // The gate reads every prior that is not verified gone, so it keeps the
  // returned and re-tiered rows. `live` keeps the re-tiered one (triage-driven,
  // persisted as carried) and drops the worsening return (R003, no triage). Only
  // a verifier verdict (or a deleted file) takes a row out of the gate.
  test("gateRows keep every returned and re-tiered row; live keeps the re-tiered one and drops the worsening return", () => {
    const mk = (id: string) => ({
      id,
      sev: "CRITICAL" as const,
      tier: "blocking" as const,
      channel: "inline" as const,
      locs: [`src/${id}.ts:1`],
      claim: id,
      triage: null,
      newThreadReply: false,
    });
    const priors = ["R001", "R002", "R003", "R004", "R005"].map(mk);
    const assembled = assembleLive({
      settled: [
        {
          id: "R001",
          status: "carried",
          locs: ["src/R001.ts:1"],
          renamed: false,
        },
        {
          id: "R002",
          status: "re-tiered",
          locs: ["src/R002.ts:1"],
          renamed: false,
        },
        {
          id: "R003",
          status: "returned",
          locs: ["src/R003.ts:1"],
          renamed: false,
        },
        {
          id: "R004",
          status: "verified-gone",
          locs: ["src/R004.ts:1"],
          renamed: false,
        },
        {
          id: "R005",
          status: "queued",
          locs: ["src/R005.ts:1"],
          renamed: false,
          trigger: "touched",
        },
      ],
      priors,
      verifyVerdicts: new Map([["R005", "verified-gone"]]),
    });
    expect(assembled.live.map((row) => row.id)).toEqual(["R001", "R002"]);
    expect(assembled.gateRows.map((row) => `${row.id}:${row.status}`)).toEqual([
      "R001:carried",
      "R002:re-tiered",
      "R003:returned",
    ]);
    expect(assembled.gateRows.every((row) => row.tier === "blocking")).toBe(
      true,
    );
  });

  // The state block is the only memory the next run has. A triage-driven
  // prior (misclassified, or a rejected dismissal) must persist as `carried`
  // with its own tier, or two pushes would clear a blocking finding (S7).
  const NO_CHANGE: PhaseBContext = {
    case: "C",
    deletedFiles: new Set(),
    renameMap: new Map(),
    touched: () => false,
    summaryUpdatedAt: null,
  };

  function blockingPrior(triage: PriorRecord["triage"]): PriorRecord {
    return {
      id: "R001",
      sev: "CRITICAL",
      tier: "blocking",
      channel: "inline",
      locs: ["src/app.ts:10"],
      claim: "blocking prior",
      triage,
      newThreadReply: false,
    };
  }

  // A persisted prior counts once, as carried. The delta line draws carried,
  // re-tiered and returned as disjoint buckets, so counting it again as
  // re-tiered rendered one finding as "1 carried · 1 re-tiered".
  test("a misclassified blocking prior stays in live as carried, with its own tier, and does not count as re-tiered", () => {
    const prior = blockingPrior({
      tag: "misclassified",
      verdict: null,
      createdAt: null,
    });
    const assembled = assembleLive({
      settled: [classifyPrior(prior, NO_CHANGE)],
      priors: [prior],
      verifyVerdicts: new Map(),
    });
    expect(assembled.reTiered).toBe(0);
    expect(
      assembled.live.map((row) => `${row.id}:${row.status}:${row.tier}`),
    ).toEqual(["R001:carried:blocking"]);
  });

  test("a blocking prior whose rejected dismissal reopened it stays in live as carried, and does not count as returned", () => {
    const prior = blockingPrior({
      tag: "dismissed",
      verdict: "rejected",
      createdAt: null,
    });
    const assembled = assembleLive({
      settled: [classifyPrior(prior, NO_CHANGE)],
      priors: [prior],
      verifyVerdicts: new Map(),
    });
    expect(assembled.returned).toBe(0);
    expect(
      assembled.live.map((row) => `${row.id}:${row.status}:${row.tier}`),
    ).toEqual(["R001:carried:blocking"]);
  });

  // Pins the previous behaviour. A worsening return is this run's own stronger
  // survivor, which carries the finding into the next run, so the prior stays
  // out of live. Production reaches it through an upheld dismissal (only a
  // suppressed row can be worsened, classify.ts applyWorsening).
  test("a worsening return of an upheld dismissal stays out of live; it is counted as returned", () => {
    const prior = blockingPrior({
      tag: "dismissed",
      verdict: "upheld",
      createdAt: null,
    });
    const worsened = applyWorsening({
      settled: [classifyPrior(prior, NO_CHANGE)],
      priors: [prior],
      survivors: [
        {
          path: "src/app.ts",
          line: 10,
          proof_refs: [],
          severity: "BLOCKER",
        },
      ],
    });
    const assembled = assembleLive({
      settled: worsened.settled,
      priors: [prior],
      verifyVerdicts: new Map(),
    });
    expect(worsened.settled[0]?.status).toBe("returned");
    expect(assembled.returned).toBe(1);
    expect(assembled.live).toEqual([]);
  });

  test("a returned prior with no triage marker stays out of live: only a rejected dismissal persists", () => {
    const prior = blockingPrior(null);
    const assembled = assembleLive({
      settled: [
        {
          id: "R001",
          status: "returned",
          locs: ["src/app.ts:10"],
          renamed: false,
        },
      ],
      priors: [prior],
      verifyVerdicts: new Map(),
    });
    expect(assembled.returned).toBe(1);
    expect(assembled.live).toEqual([]);
  });
});
