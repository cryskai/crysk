import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import path from "node:path";
import { BoundaryNonceError } from "#review/boundary";
import {
  applyPlan,
  consolidationPrompt,
  enforcePlanInvariants,
  type MergedDraft,
  type PlanEntry,
  validatePlan,
} from "#review/consolidate";
import type { Finding } from "#review/findings";
import { parseAgentSource } from "#review/prompt-set";

function baseFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    category: 1,
    path: "src/review/consolidate.ts",
    line: 42,
    severity: "BLOCKER",
    evidence_class: "deterministic",
    refuter_verdict: "not_submitted",
    causal_disposition: "introduced",
    claim: "stale derived state after mutation",
    proof_refs: ["diff-hunk#1"],
    hunter: "reliability",
    tier: "blocking",
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "consolidate.ts:apply:1",
    ...overrides,
  };
}

const PROMPT_PATH = path.join(
  import.meta.dir,
  "..",
  "..",
  "prompts",
  "consolidate.md",
);

test("the consolidator prompt body is the measured prompt, byte for byte", async () => {
  const parsed = parseAgentSource(await Bun.file(PROMPT_PATH).text());
  const sha = createHash("sha256").update(parsed.body).digest("hex");
  expect(sha).toBe(
    "3e7130f7d42bfe104b6cf2d6167fb68430d10841b7158b1dd591fa5eb9968cd3",
  );
  expect(parsed.model).toBe("sonnet");
  expect(parsed.effort).toBe("high");
});

test("validatePlan accepts a plan covering every id and normalises split to a boolean", () => {
  const plan = validatePlan(
    {
      findings: [
        { primary: "F001", sources: ["F001"], claim: "one defect" },
        { primary: "F002", sources: ["F002"], split: true, claim: "aside" },
      ],
    },
    ["F001", "F002"],
    new Set(),
  );
  expect(plan.map((e) => e.split)).toEqual([false, true]);
});

test("validatePlan throws when an input id is dropped", () => {
  expect(() =>
    validatePlan(
      { findings: [{ primary: "F001", sources: ["F001"], claim: "x" }] },
      ["F001", "F002"],
      new Set(),
    ),
  ).toThrow("dropped F002");
});

test("validatePlan rejects an unknown primary", () => {
  expect(() =>
    validatePlan(
      { findings: [{ primary: "F999", sources: ["F999"], claim: "x" }] },
      ["F001"],
      new Set(),
    ),
  ).toThrow("unknown primary F999");
});

test("validatePlan rejects a primary missing from its sources", () => {
  expect(() =>
    validatePlan(
      { findings: [{ primary: "F001", sources: ["F002"], claim: "x" }] },
      ["F001", "F002"],
      new Set(),
    ),
  ).toThrow("F001: primary missing from sources");
});

test("validatePlan rejects an empty claim", () => {
  expect(() =>
    validatePlan(
      { findings: [{ primary: "F001", sources: ["F001"], claim: "   " }] },
      ["F001"],
      new Set(),
    ),
  ).toThrow("F001: empty claim");
});

test("validatePlan rejects an unknown source", () => {
  expect(() =>
    validatePlan(
      {
        findings: [{ primary: "F001", sources: ["F001", "F404"], claim: "x" }],
      },
      ["F001"],
      new Set(),
    ),
  ).toThrow("unknown source F404");
});

test("applyPlan merge keeps the primary's location, tier and verdict and pools proof refs in sources order", () => {
  const findings = [
    baseFinding({
      id: "F001",
      severity: "WARNING",
      tier: "advisory",
      refuter_verdict: "not_submitted",
      proof_refs: ["diff-hunk#1", "diff-hunk#2"],
    }),
    baseFinding({
      id: "F002",
      severity: "BLOCKER",
      tier: "blocking",
      refuter_verdict: "corroborated",
      path: "src/review/boundary.ts",
      line: 7,
      proof_refs: ["diff-hunk#2", "diff-hunk#3"],
    }),
  ];
  const plan: PlanEntry[] = [
    {
      primary: "F002",
      sources: ["F001", "F002"],
      split: false,
      claim: "merged claim",
    },
  ];
  const [out] = applyPlan(findings, plan, []);
  expect(out).toEqual({
    ...(findings[1] as Finding),
    claim: "merged claim",
    proof_refs: ["diff-hunk#1", "diff-hunk#2", "diff-hunk#3"],
  });
});

test("applyPlan split posts advisory, not_submitted, with the primary's location", () => {
  const primary = baseFinding({
    id: "F001",
    path: "src/a.ts",
    line: 10,
    proof_refs: ["diff-hunk#9"],
  });
  const plan: PlanEntry[] = [
    { primary: "F001", sources: ["F001"], claim: "main defect" },
    { primary: "F001", sources: ["F001"], split: true, claim: "aside one" },
    { primary: "F001", sources: ["F001"], split: true, claim: "aside two" },
  ];
  const out = applyPlan([primary], plan, []);
  const splits = out.slice(1);
  expect(splits.map((f) => f.id)).toEqual(["F001s1", "F001s2"]);
  for (const f of splits) {
    expect(f.tier).toBe("advisory");
    expect(f.refuter_verdict).toBe("not_submitted");
    expect(f.path).toBe("src/a.ts");
    expect(f.line).toBe(10);
    expect(f.proof_refs).toEqual(["diff-hunk#9"]);
  }
});

test("applyPlan never raises the blocking count for a merge and split over a BLOCKER primary", () => {
  const findings = [
    baseFinding({ id: "F001", severity: "BLOCKER", tier: "blocking" }),
    baseFinding({
      id: "F002",
      severity: "WARNING",
      tier: "advisory",
      refuter_verdict: "not_submitted",
    }),
  ];
  const plan: PlanEntry[] = [
    { primary: "F001", sources: ["F001", "F002"], claim: "merged" },
    { primary: "F001", sources: ["F001"], split: true, claim: "aside" },
  ];
  const blockingBefore = findings.filter((f) => f.tier === "blocking").length;
  const out = applyPlan(findings, plan, [] as MergedDraft[]);
  const blockingAfter = out.filter((f) => f.tier === "blocking").length;
  expect(blockingAfter).toBeLessThanOrEqual(blockingBefore);
});

test("consolidationPrompt wraps the input JSON in the nonce boundary with exactly the consolidator's keys", () => {
  const findings = [
    baseFinding({ id: "F001" }),
    baseFinding({ id: "F002", hunter: "resilience", line: 99 }),
  ];
  const prompt = consolidationPrompt(findings, "abcd1234");
  const prefix = "Findings:\n<findings abcd1234>\n";
  const suffix = "\n</findings abcd1234>";
  expect(prompt.startsWith(prefix)).toBe(true);
  expect(prompt.endsWith(suffix)).toBe(true);
  const parsed = JSON.parse(
    prompt.slice(prefix.length, prompt.length - suffix.length),
  ) as Record<string, unknown>[];
  expect(parsed.length).toBe(2);
  for (const obj of parsed) {
    expect(Object.keys(obj).sort()).toEqual(
      ["claim", "hunter", "id", "line", "path", "severity"].sort(),
    );
  }
});

test("consolidationPrompt throws BoundaryNonceError when a claim carries the nonce", () => {
  const findings = [
    baseFinding({ claim: "a claim that mentions abcd1234 by accident" }),
  ];
  expect(() => consolidationPrompt(findings, "abcd1234")).toThrow(
    BoundaryNonceError,
  );
});

// enforcePlanInvariants: the engine-side guard finish() runs between
// validatePlan and applyPlan, where tiers are known.
const blockingF = (id: string) =>
  baseFinding({ id, tier: "blocking", claim: `blocking ${id}` });
const advisoryF = (id: string) =>
  baseFinding({
    id,
    severity: "WARNING",
    tier: "advisory",
    claim: `advisory ${id}`,
  });

test("enforcePlanInvariants rule 1: a WARNING primary absorbing a blocking source hands it the lead", () => {
  const findings = [advisoryF("F001"), blockingF("F002")];
  const stats = { repairs: 0 };
  const out = enforcePlanInvariants(
    [{ primary: "F001", sources: ["F001", "F002"], split: false, claim: "m" }],
    findings,
    stats,
  );
  expect(out).toEqual([
    { primary: "F002", sources: ["F001", "F002"], split: false, claim: "m" },
  ]);
  expect(stats.repairs).toBe(1);
});

test("enforcePlanInvariants rule 2: two non-split entries with one primary fold into the first", () => {
  const findings = [blockingF("F001"), advisoryF("F002"), advisoryF("F003")];
  const stats = { repairs: 0 };
  const out = enforcePlanInvariants(
    [
      {
        primary: "F001",
        sources: ["F001", "F002"],
        split: false,
        claim: "one",
      },
      {
        primary: "F001",
        sources: ["F001", "F003"],
        split: false,
        claim: "two",
      },
      { primary: "F001", sources: ["F001"], split: true, claim: "aside" },
    ],
    findings,
    stats,
  );
  expect(out).toEqual([
    {
      primary: "F001",
      sources: ["F001", "F002", "F003"],
      split: false,
      claim: "one",
    },
    { primary: "F001", sources: ["F001"], split: true, claim: "aside" },
  ]);
  expect(stats.repairs).toBe(1);
});

test("enforcePlanInvariants rule 3: a blocking finding carried only by a split is appended", () => {
  const findings = [blockingF("F001"), advisoryF("F002")];
  const stats = { repairs: 0 };
  const out = enforcePlanInvariants(
    [
      { primary: "F002", sources: ["F002"], split: false, claim: "w" },
      { primary: "F001", sources: ["F001"], split: true, claim: "aside" },
    ],
    findings,
    stats,
  );
  expect(out).toEqual([
    { primary: "F002", sources: ["F002"], split: false, claim: "w" },
    { primary: "F001", sources: ["F001"], split: true, claim: "aside" },
    {
      primary: "F001",
      sources: ["F001"],
      split: false,
      claim: "blocking F001",
    },
  ]);
  expect(stats.repairs).toBe(1);
});

test("enforcePlanInvariants: a plan that keeps every rule comes back deep-equal, 0 repairs", () => {
  const findings = [blockingF("F001"), advisoryF("F002"), advisoryF("F003")];
  const plan: PlanEntry[] = [
    { primary: "F001", sources: ["F001", "F002"], split: false, claim: "m" },
    { primary: "F001", sources: ["F001"], split: true, claim: "aside" },
    { primary: "F003", sources: ["F003"], split: false, claim: "c" },
  ];
  const stats = { repairs: -1 };
  expect(enforcePlanInvariants(plan, findings, stats)).toEqual(plan);
  expect(stats.repairs).toBe(0);
});
