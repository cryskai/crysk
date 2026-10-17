import { describe, expect, test } from "bun:test";
import { claimFingerprint } from "#pr/preflight";
import {
  droppedStateNote,
  type FreshStateFinding,
  type LiveFinding,
  mergeStateFindings,
  pairBlockingSurvivors,
  parseStateBlock,
  renderStateBlock,
  type StateFinding,
  stateFinding,
} from "#rereview/state";

const HEAD = "8da9fad5bc9f650df38fc8cb0237253d80ff3245";
const BIG_BUDGET = 1_000_000;

function live(
  id: string,
  status: LiveFinding["status"],
  overrides: Partial<Omit<StateFinding, "id">> = {},
): LiveFinding {
  return {
    ...stateFinding({
      id,
      sev: "CRITICAL",
      tier: "blocking",
      channel: "inline",
      locs: ["src/app.ts:10"],
      claim: `claim for ${id}`,
      ...overrides,
    }),
    status,
  };
}

function fresh(
  line: number,
  tier: "blocking" | "advisory",
  over: Partial<FreshStateFinding> = {},
): FreshStateFinding {
  return {
    path: "src/app.ts",
    line,
    proof_refs: [],
    tier,
    severity: tier === "blocking" ? "BLOCKER" : "SUGGESTION",
    claim: `fresh claim at ${line}`,
    channel: "inline",
    ...over,
  };
}

function merge(
  input: Partial<Parameters<typeof mergeStateFindings>[0]> & {
    live: readonly LiveFinding[];
    fresh: readonly FreshStateFinding[];
  },
) {
  return mergeStateFindings({
    headSha: HEAD,
    reviews: 2,
    previous: null,
    stateBudget: BIG_BUDGET,
    ...input,
  });
}

describe("S2 — pairBlockingSurvivors returns survivor-to-row pairs", () => {
  test("a blocking survivor pairs with the row at its spot, one-to-one", () => {
    const pairs = pairBlockingSurvivors(
      [fresh(11, "blocking"), fresh(12, "blocking")],
      [{ tier: "blocking", locs: ["src/app.ts:10"] }],
    );
    expect(pairs).toEqual([{ survivor: 0, row: 0 }]);
  });

  test("an advisory survivor never pairs", () => {
    const pairs = pairBlockingSurvivors(
      [fresh(10, "advisory")],
      [{ tier: "advisory", locs: ["src/app.ts:10"] }],
    );
    expect(pairs).toEqual([]);
  });
});

describe("S2 — a fresh survivor that pairs updates its row in place", () => {
  test("a fresh blocking survivor keeps the prior id and takes the fresh locs and claim", () => {
    const merged = merge({
      live: [live("R001", "carried", { claim: "stale claim" })],
      fresh: [fresh(12, "blocking", { claim: "current claim" })],
    });
    expect(merged.rows.map((r) => r.id)).toEqual(["R001"]);
    expect(merged.rows[0]).toMatchObject({
      id: "R001",
      locs: ["src/app.ts:12"],
      claim: "current claim",
      sev: "BLOCKER",
      tier: "blocking",
      channel: "inline",
      status: "carried",
      c: claimFingerprint("current claim"),
    });
  });

  test("a suppressed prior keeps its sev when a fresh survivor pairs with it", () => {
    const merged = merge({
      live: [live("R001", "suppressed", { sev: "CRITICAL" })],
      fresh: [fresh(10, "blocking", { severity: "WARNING" })],
    });
    expect(merged.rows[0]).toMatchObject({
      id: "R001",
      sev: "CRITICAL",
      tier: "blocking",
      status: "suppressed",
    });
  });
});

describe("S2 — an unpaired fresh survivor appends with the next id", () => {
  test("a fresh advisory near a blocking prior appends and the blocking row stays", () => {
    const merged = merge({
      live: [live("R001", "carried")],
      fresh: [fresh(11, "advisory")],
    });
    expect(merged.rows.map((r) => [r.id, r.tier])).toEqual([
      ["R001", "blocking"],
      ["R002", "advisory"],
    ]);
  });

  test("a re-found advisory updates its advisory row in place instead of appending", () => {
    const merged = merge({
      live: [
        live("R001", "carried", {
          tier: "advisory",
          sev: "SUGGESTION",
          locs: ["src/app.ts:11"],
        }),
      ],
      fresh: [fresh(11, "advisory", { claim: "reworded" })],
    });
    expect(merged.rows.map((r) => [r.id, r.tier, r.claim])).toEqual([
      ["R001", "advisory", "reworded"],
    ]);
    expect(merged.hw).toBe(1);
  });

  test("an advisory survivor never takes a blocking row, even with an advisory row beside it", () => {
    const merged = merge({
      live: [
        live("R001", "carried", { locs: ["src/app.ts:11"] }),
        live("R002", "carried", {
          tier: "advisory",
          sev: "SUGGESTION",
          locs: ["src/app.ts:11"],
        }),
      ],
      fresh: [fresh(11, "advisory")],
    });
    expect(merged.rows.map((r) => [r.id, r.tier])).toEqual([
      ["R001", "blocking"],
      ["R002", "advisory"],
    ]);
    expect(merged.rows[0]?.claim).toBe("claim for R001");
  });

  test("a fresh blocking survivor with no prior at its spot appends", () => {
    const merged = merge({
      live: [live("R001", "carried", { locs: ["src/other.ts:1"] })],
      fresh: [fresh(40, "blocking")],
    });
    expect(merged.rows.map((r) => r.id)).toEqual(["R001", "R002"]);
  });
});

describe("S5 — the high-water id mark", () => {
  test("renderStateBlock always writes hw, defaulting to the highest row id", () => {
    const block = renderStateBlock(HEAD, [
      stateFinding({
        id: "R002",
        sev: "BLOCKER",
        tier: "blocking",
        channel: "inline",
        locs: ["a.ts:1"],
        claim: "x",
      }),
    ]);
    expect(block).toContain('"hw":2');
    expect(parseStateBlock(block)?.hw).toBe(2);
  });

  test("an explicit hw is written and read back", () => {
    const block = renderStateBlock(HEAD, [], undefined, 7);
    expect(parseStateBlock(block)?.hw).toBe(7);
    expect(parseStateBlock(block)?.findings).toEqual([]);
  });

  test("a block without hw still parses, and hw falls back to the highest row id", () => {
    const body =
      `<!-- pr-hero-state v=1 head=${HEAD} -->\n` +
      '<!-- {"findings":[{"id":"R001","sev":"BLOCKER","tier":"blocking",' +
      '"channel":"inline","locs":["a.ts:1"],"c":"aaaaaaaaaaaa","claim":"old"},' +
      '{"id":"R004","sev":"WARNING","tier":"advisory","channel":"inline",' +
      '"locs":["a.ts:2"],"c":"aaaaaaaaaaaa","claim":"newer"}]} -->';
    const parsed = parseStateBlock(body);
    expect(parsed?.findings.length).toBe(2);
    expect(parsed?.hw).toBe(4);
  });

  test("a block with no rows and no hw falls back to zero", () => {
    const body = `<!-- pr-hero-state v=1 head=${HEAD} -->\n<!-- {"findings":[]} -->`;
    expect(parseStateBlock(body)?.hw).toBe(0);
  });

  test("a malformed hw is rejected the way other malformed fields are", () => {
    for (const bad of ['"3"', "-1", "1.5", "null"]) {
      const body =
        `<!-- pr-hero-state v=1 head=${HEAD} -->\n` +
        `<!-- {"findings":[],"hw":${bad}} -->`;
      expect(parseStateBlock(body)).toBeNull();
    }
  });

  test("a retired max id is never reused, even when its row is gone", () => {
    const previous: StateFinding[] = [
      stateFinding({
        id: "R001",
        sev: "WARNING",
        tier: "advisory",
        channel: "inline",
        locs: ["a.ts:1"],
        claim: "kept",
      }),
    ];
    const merged = merge({
      live: [live("R001", "carried", { tier: "advisory", sev: "WARNING" })],
      previous: { findings: previous, hw: 5 },
      fresh: [fresh(40, "blocking")],
    });
    expect(merged.rows.map((r) => r.id)).toEqual(["R001", "R006"]);
    expect(merged.hw).toBe(6);
  });

  test("the new id clears a retired row that the live set no longer holds", () => {
    const merged = merge({
      live: [],
      previous: {
        findings: [
          stateFinding({
            id: "R003",
            sev: "WARNING",
            tier: "advisory",
            channel: "inline",
            locs: ["a.ts:1"],
            claim: "retired",
          }),
        ],
        hw: 3,
      },
      fresh: [fresh(40, "blocking")],
    });
    expect(merged.rows.map((r) => r.id)).toEqual(["R004"]);
  });
});

describe("S6 — the cap evicts only prior advisory rows", () => {
  test("unconfirmed advisory priors go first, then carried, and the fresh row stays", () => {
    const rows = [
      live("R001", "unconfirmed", { tier: "advisory", sev: "WARNING" }),
      live("R002", "carried", { tier: "advisory", sev: "WARNING" }),
      live("R003", "carried"),
    ];
    const withFresh = merge({
      live: rows,
      fresh: [fresh(40, "blocking")],
    });
    const newRow = withFresh.rows.find((r) => r.id === "R004");
    expect(newRow).toBeDefined();

    // A budget that fits exactly R003 and the fresh R004: both advisory
    // priors must go, unconfirmed first, and the blocking row is kept.
    const budget = renderStateBlock(
      HEAD,
      [rows[2] as LiveFinding, newRow as LiveFinding],
      2,
      4,
    ).length;
    const capped = merge({
      live: rows,
      fresh: [fresh(40, "blocking")],
      stateBudget: budget,
    });
    expect(capped.rows.map((r) => r.id)).toEqual(["R003", "R004"]);
    expect(capped.dropped).toBe(2);
  });

  test("with a budget that fits one advisory prior, the carried one survives", () => {
    const rows = [
      live("R001", "unconfirmed", { tier: "advisory", sev: "WARNING" }),
      live("R002", "carried", { tier: "advisory", sev: "WARNING" }),
    ];
    const budget = renderStateBlock(
      HEAD,
      [rows[1] as LiveFinding],
      2,
      2,
    ).length;
    const capped = merge({ live: rows, fresh: [], stateBudget: budget });
    expect(capped.rows.map((r) => r.id)).toEqual(["R002"]);
    expect(capped.dropped).toBe(1);
  });

  test("blocking priors and fresh rows are kept even over budget", () => {
    const merged = merge({
      live: [live("R001", "carried"), live("R002", "unconfirmed")],
      fresh: [fresh(40, "blocking")],
      stateBudget: 10,
    });
    expect(merged.rows.map((r) => r.id)).toEqual(["R001", "R002", "R003"]);
    expect(merged.dropped).toBe(0);
  });

  test("suppressed and deferred advisory rows are never evicted", () => {
    const merged = merge({
      live: [
        live("R001", "suppressed", { tier: "advisory", sev: "WARNING" }),
        live("R002", "deferred", { tier: "advisory", sev: "WARNING" }),
      ],
      fresh: [],
      stateBudget: 10,
    });
    expect(merged.rows.map((r) => r.id)).toEqual(["R001", "R002"]);
    expect(merged.dropped).toBe(0);
  });
});

describe("S6 — the dropped note names the identities dropped from the state", () => {
  test("nothing is said when nothing was dropped", () => {
    expect(droppedStateNote(0)).toBe("");
  });

  test("one line that counts the dropped identities", () => {
    const note = droppedStateNote(3);
    expect(note).toContain("3 finding identities");
    expect(note.split("\n").filter((l) => l.length > 0).length).toBe(1);
  });
});

describe("S7 — the merge is pure and deterministic", () => {
  test("identical inputs produce identical rows, hw and dropped count", () => {
    const input = {
      live: [
        live("R001", "carried"),
        live("R002", "unconfirmed", { tier: "advisory", sev: "WARNING" }),
      ],
      fresh: [fresh(12, "blocking"), fresh(40, "advisory")],
      previous: null,
      stateBudget: 400,
    };
    expect(merge(input)).toEqual(merge(input));
    const a = renderStateBlock(HEAD, merge(input).rows, 2, merge(input).hw);
    const b = renderStateBlock(HEAD, merge(input).rows, 2, merge(input).hw);
    expect(a).toBe(b);
  });
});
