import { describe, expect, test } from "bun:test";
import {
  type DraftFinding,
  extractJsonObject,
  isVacuousHunt,
  validateHunterDraft,
  validateRefuterResult,
  validateSummary,
} from "#review/drafts";
import type { RunSummary } from "#review/findings";

function draft(overrides: Partial<DraftFinding> = {}): DraftFinding {
  return {
    id: "R1",
    category: 1,
    path: "src/upload.ts",
    line: 42,
    severity: "WARNING",
    evidence_class: "inferential",
    causal_disposition: "introduced",
    claim: "stale derived state after mutation",
    proof_refs: ["diff-hunk#1"],
    hunter: "reliability",
    hops_used: 1,
    hop_trail: [],
    dedupe_key: "src/upload.ts:abortUpload:1",
    ...overrides,
  };
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    prose: "This change improves upload state handling.",
    score: 4,
    score_reason: "The change is focused and the main behavior is covered.",
    ...overrides,
  };
}

describe("extractJsonObject", () => {
  const payload = { findings: [draft()] };

  test("parses a direct JSON-only final message", () => {
    expect(extractJsonObject(JSON.stringify(payload))).toEqual(payload);
  });

  test("parses a ```json fenced final message", () => {
    const text = `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
    expect(extractJsonObject(text)).toEqual(payload);
  });

  test("parses a prose-wrapped final message", () => {
    const text = `Here is the result: ${JSON.stringify(payload)}`;
    expect(extractJsonObject(text)).toEqual(payload);
  });

  test("parses an oversized (>8KB) prose-wrapped draft in full", () => {
    // A multi-finding draft with long claims easily exceeds 8192 chars; the
    // extractor must never operate on a truncated slice of the final text.
    const big = {
      findings: Array.from({ length: 12 }, (_, i) =>
        draft({
          id: `R${i + 1}`,
          claim: `finding ${i} — ${"very long evidence chain ".repeat(40)}`,
        }),
      ),
    };
    const json = JSON.stringify(big);
    expect(json.length).toBeGreaterThan(8192);
    const wrapped = `The draft follows.\n${json}\nDone.`;
    expect(extractJsonObject(wrapped)).toEqual(big);
  });

  // A hunter's closing prose cites the code it read, and code is full of
  // braces: `${id}.${codec}` put the first `{` inside a template literal, the
  // first-to-last-brace slice failed to parse, and a valid two-finding draft
  // (one of them the planted defect) was rejected as a format violation (lab
  // ledger, cost levers v3, musive #965 hybrid r2, 2026-10-21).
  test("parses the draft when the prose before it contains braces", () => {
    const text = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the model's literal prose, braces and all, is the input under test.
      "Confirmed all four backend sites and the object key is `${id}.${codec}` (a UUID).",
      "",
      "I have both sides proven. Final findings.",
      "",
      JSON.stringify(payload),
    ].join("\n");
    expect(extractJsonObject(text)).toEqual(payload);
  });

  test("parses the draft when prose after it contains braces too", () => {
    const text = `Before \`{a}\`.\n${JSON.stringify(payload)}\nAfter, see \`fn() {}\`.`;
    expect(extractJsonObject(text)).toEqual(payload);
  });

  test("returns undefined on garbage", () => {
    expect(extractJsonObject("no findings worth reporting")).toBeUndefined();
    expect(extractJsonObject("broken { not json ] here")).toBeUndefined();
  });
});

describe("validateHunterDraft", () => {
  test("accepts a well-formed draft", () => {
    const candidate = { findings: [draft(), draft({ id: "R2" })] };
    expect(validateHunterDraft(candidate)).toEqual(candidate);
  });

  test("rejects a finding missing a required field", () => {
    const { dedupe_key: _key, ...withoutKey } = draft();
    expect(() => validateHunterDraft({ findings: [withoutKey] })).toThrow();
    expect(() => validateHunterDraft({})).toThrow();
  });

  // 2026-08-23, PR #50: a hunter emitted `"symbol": null` and nothing stopped
  // it — the null was written into findings.json and killed the POST after the
  // pipeline had already billed $3.77. Writing `null` for "this finding has no
  // symbol" is ordinary model behaviour, not a corrupt draft: inline JSON has
  // no way to spell "absent", and the value carries exactly the meaning absent
  // does. So it is normalised here rather than rejected — the same tolerance
  // extractJsonObject already extends to a fenced or prose-wrapped draft, and
  // for the same reason: one `must()` throw discards EVERY other finding in
  // the draft and burns a paid retry, over zero lost information.
  test("normalises a null symbol to absent instead of rejecting the draft", () => {
    const result = validateHunterDraft({
      findings: [{ ...draft(), symbol: null }, draft({ id: "R2" })],
    });
    expect(result.findings).toHaveLength(2);
    expect(Object.hasOwn(result.findings[0] ?? {}, "symbol")).toBe(false);
    expect(result.findings[0]?.symbol).toBeUndefined();
    expect(result.findings[1]?.id).toBe("R2");
  });

  test("normalises a null root_cause_id the same way", () => {
    const result = validateHunterDraft({
      findings: [{ ...draft(), root_cause_id: null }],
    });
    expect(Object.hasOwn(result.findings[0] ?? {}, "root_cause_id")).toBe(
      false,
    );
  });

  test("accepts open specialty slug hunters", () => {
    const result = validateHunterDraft({
      findings: [
        draft({ hunter: "security" }),
        draft({ hunter: "code-quality", id: "R2" }),
      ],
    });
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.hunter).toBe("security");
    expect(result.findings[1]?.hunter).toBe("code-quality");
  });

  test("rejects invalid hunter slugs", () => {
    expect(() =>
      validateHunterDraft({ findings: [draft({ hunter: "Security" })] }),
    ).toThrow(/hunter invalid/);
  });

  test("leaves a real symbol untouched", () => {
    const result = validateHunterDraft({
      findings: [draft({ symbol: "abortUpload" })],
    });
    expect(result.findings[0]?.symbol).toBe("abortUpload");
  });

  // `null` means "absent" and is recoverable; a number does not and is not.
  // Normalising a wrong-typed value would be guessing, so it keeps the house
  // fail-loud default and takes the draft down with it.
  test("rejects a symbol that is present but not a string", () => {
    expect(() =>
      validateHunterDraft({ findings: [{ ...draft(), symbol: 42 }] }),
    ).toThrow();
    expect(() =>
      validateHunterDraft({ findings: [{ ...draft(), root_cause_id: 7 }] }),
    ).toThrow();
  });

  // proof_refs survives `Array.isArray` with null INSIDE it, and every one of
  // its elements is rendered through oneLine() on the same paid posting path
  // (review/report.ts evidence block). Unlike an absent symbol a null element carries
  // no recoverable meaning, so this one rejects.
  test("rejects a null element inside proof_refs", () => {
    expect(() =>
      validateHunterDraft({
        findings: [{ ...draft(), proof_refs: ["diff-hunk#1", null] }],
      }),
    ).toThrow();
  });

  // T1 (odd/tasks/logic-hunter.md): drafts are always merged into a v1.1
  // document by mergeRunEnvelope (review/findings.ts), which stamps
  // SCHEMA_VERSION_V1_1 unconditionally — so the draft validator accepts the
  // full v1.1 range, category 15 ("local logic error") included.
  test("accepts category 15 (local logic error)", () => {
    const result = validateHunterDraft({
      findings: [draft({ category: 15 })],
    });
    expect(result.findings[0]?.category).toBe(15);
  });

  test("rejects category 16", () => {
    expect(() =>
      validateHunterDraft({ findings: [draft({ category: 16 })] }),
    ).toThrow(/category must be 1-15/);
  });
});

describe("validateSummary", () => {
  test("accepts a well-formed summary", () => {
    expect(validateSummary(summary())).toEqual(summary());
  });

  test("accepts inclusive length limits and score endpoints", () => {
    const candidate = summary({
      prose: "x".repeat(1200),
      score: 1,
      score_reason: "x".repeat(400),
    });
    expect(validateSummary(candidate)).toEqual(candidate);
    expect(validateSummary({ ...candidate, score: 5 })).toEqual({
      ...candidate,
      score: 5,
    });
  });

  test("rejects empty prose and score reason", () => {
    expect(() => validateSummary(summary({ prose: "" }))).toThrow();
    expect(() => validateSummary(summary({ score_reason: "" }))).toThrow();
  });

  test("rejects prose over 1200 characters", () => {
    expect(() =>
      validateSummary(summary({ prose: "x".repeat(1201) })),
    ).toThrow();
  });

  test("rejects score reasons over 400 characters", () => {
    expect(() =>
      validateSummary(summary({ score_reason: "x".repeat(401) })),
    ).toThrow();
  });

  test("rejects non-integer and out-of-range scores", () => {
    expect(() => validateSummary(summary({ score: 2.5 }))).toThrow();
    expect(() => validateSummary(summary({ score: 0 }))).toThrow();
    expect(() => validateSummary(summary({ score: 6 }))).toThrow();
  });

  test("rejects HTML comment markers in either string", () => {
    expect(() =>
      validateSummary(summary({ prose: "before <!-- after" })),
    ).toThrow();
    expect(() =>
      validateSummary(summary({ score_reason: "before --> after" })),
    ).toThrow();
  });
});

describe("validateRefuterResult", () => {
  const verdict = (finding_id: string) => ({
    finding_id,
    outcome: "corroborated" as const,
    proof_refs: ["src/upload.ts:42"],
  });

  test("accepts one verdict per submitted id, exactly", () => {
    const candidate = { results: [verdict("F001"), verdict("F002")] };
    expect(validateRefuterResult(candidate, ["F001", "F002"])).toEqual(
      candidate,
    );
  });

  test("rejects a missing verdict", () => {
    const candidate = { results: [verdict("F001")] };
    expect(() => validateRefuterResult(candidate, ["F001", "F002"])).toThrow();
  });

  test("rejects a verdict for a never-submitted id", () => {
    const candidate = { results: [verdict("F001"), verdict("F999")] };
    expect(() => validateRefuterResult(candidate, ["F001"])).toThrow();
  });

  test("rejects a duplicate verdict", () => {
    const candidate = { results: [verdict("F001"), verdict("F001")] };
    expect(() => validateRefuterResult(candidate, ["F001"])).toThrow();
  });

  test("rejects an invalid outcome", () => {
    const candidate = { results: [{ ...verdict("F001"), outcome: "maybe" }] };
    expect(() => validateRefuterResult(candidate, ["F001"])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// #152: proof_refs resolvability. The resolver is OPTIONAL, and its absence
// must leave every pre-existing caller (the lab, the probes, the offline
// suite) behaving exactly as before — the check is opt-in wiring, not a new
// unconditional rule the shared schema quietly grew.
// ---------------------------------------------------------------------------
describe("proof_refs resolvability", () => {
  const tree = new Set(["src/upload.ts", "src/authz.ts"]);
  const resolveProofRef = (p: string): boolean => tree.has(p);

  test("without a resolver, an unresolvable ref still validates", () => {
    const candidate = {
      findings: [draft({ proof_refs: ["src/nowhere.ts:7-20"] })],
    };
    expect(validateHunterDraft(candidate)).toEqual(candidate);
    const verdicts = {
      results: [
        {
          finding_id: "F001",
          outcome: "corroborated" as const,
          proof_refs: ["src/nowhere.ts:7-20"],
        },
      ],
    };
    expect(validateRefuterResult(verdicts, ["F001"])).toEqual(verdicts);
  });

  test("with a resolver, a resolvable draft ref passes", () => {
    const candidate = {
      findings: [draft({ proof_refs: ["src/upload.ts:42", "b/src/authz.ts"] })],
    };
    expect(validateHunterDraft(candidate, { resolveProofRef })).toEqual(
      candidate,
    );
  });

  test("with a resolver, an empty evidence list still passes", () => {
    // Emptiness is a separate question with its own answer elsewhere; this
    // rule is only about refs that name something unfindable.
    const candidate = { findings: [draft({ proof_refs: [] })] };
    expect(validateHunterDraft(candidate, { resolveProofRef })).toEqual(
      candidate,
    );
  });

  test("rejects a hunter draft citing a path the tree does not have", () => {
    const candidate = {
      findings: [
        draft({ proof_refs: ["src/upload.ts:42", "package.json:15-20"] }),
      ],
    };
    expect(() => validateHunterDraft(candidate, { resolveProofRef })).toThrow(
      /package\.json:15-20/,
    );
  });

  test("rejects a refuter verdict citing a path the tree does not have", () => {
    // The observed #152 failure, verbatim: a verdict whose whole evidentiary
    // record was invented, on a repo that contained neither file.
    const candidate = {
      results: [
        {
          finding_id: "F001",
          outcome: "inconclusive" as const,
          proof_refs: ["src/index.ts:7-20", "package.json:15-20"],
        },
      ],
    };
    expect(() =>
      validateRefuterResult(candidate, ["F001"], { resolveProofRef }),
    ).toThrow(/src\/index\.ts:7-20/);
  });

  test("names the offending finding, not just the ref", () => {
    const candidate = {
      findings: [
        draft({ id: "R1", proof_refs: ["src/upload.ts:42"] }),
        draft({ id: "R2", proof_refs: ["src/ghost.ts:1"] }),
      ],
    };
    expect(() => validateHunterDraft(candidate, { resolveProofRef })).toThrow(
      /findings\[1\]/,
    );
  });
});

describe("isVacuousHunt (#214, #299)", () => {
  const empty = { findings: [] };
  const found = { findings: [draft()] };

  test("tools given, zero invocations, empty findings — vacuous", () => {
    expect(
      isVacuousHunt({
        tools: ["Read", "Grep"],
        toolInvocations: 0,
        parsed: empty,
      }),
    ).toBe(true);
  });

  test("looked and found nothing is not vacuous", () => {
    expect(
      isVacuousHunt({
        tools: ["Read"],
        toolInvocations: 1,
        parsed: empty,
      }),
    ).toBe(false);
  });

  test("unknown count stays ungated", () => {
    expect(
      isVacuousHunt({
        tools: ["Read"],
        toolInvocations: undefined,
        parsed: empty,
      }),
    ).toBe(false);
  });

  test("scout tools:[] is out of the rule even at zero invocations", () => {
    expect(
      isVacuousHunt({
        tools: [],
        toolInvocations: 0,
        parsed: empty,
      }),
    ).toBe(false);
  });

  // #299: the gate used to look only at EMPTY findings, so a logic hunter that
  // returned one finding "inferred from the diff" with zero tool calls
  // (run df63033a-2) passed. Under the engine's read requirement a finding
  // whose proof was never read is inadmissible, at any findings count.
  test("tools given, zero invocations, findings present — vacuous too", () => {
    expect(
      isVacuousHunt({
        tools: ["Read"],
        toolInvocations: 0,
        parsed: found,
      }),
    ).toBe(true);
    expect(
      isVacuousHunt({
        tools: ["Read"],
        toolInvocations: 0,
        parsed: { findings: [draft(), draft({ id: "F002" })] },
      }),
    ).toBe(true);
  });

  test("findings backed by at least one tool call are not vacuous", () => {
    expect(
      isVacuousHunt({
        tools: ["Read"],
        toolInvocations: 1,
        parsed: found,
      }),
    ).toBe(false);
  });

  test("unknown count stays ungated whatever the findings count", () => {
    expect(
      isVacuousHunt({
        tools: ["Read"],
        toolInvocations: undefined,
        parsed: found,
      }),
    ).toBe(false);
  });

  test("a tool-less step is out of the rule at any findings count", () => {
    expect(
      isVacuousHunt({
        tools: [],
        toolInvocations: 0,
        parsed: found,
      }),
    ).toBe(false);
  });

  test("a findings field that is not an array is not this gate's concern", () => {
    expect(
      isVacuousHunt({
        tools: ["Read"],
        toolInvocations: 0,
        parsed: { findings: "none" },
      }),
    ).toBe(false);
  });

  test("refuter and scout shapes have no findings array, so they do not trip", () => {
    expect(
      isVacuousHunt({
        tools: ["Read"],
        toolInvocations: 0,
        parsed: { results: [] },
      }),
    ).toBe(false);
    expect(
      isVacuousHunt({
        tools: ["Read"],
        toolInvocations: 0,
        parsed: { leads: [] },
      }),
    ).toBe(false);
  });
});
