// The materiality judge's pure half (Stage 2 noise yardstick, step 1).
//
// One question per claim: assuming the claim is true, would a senior reviewer
// want it posted on this PR? Truth is not asked here; the refuter owns it and
// refuter-probe tests it. Asking both at once would need a checkout per run
// and would blur "wrong" with "true but not worth saying".
//
// The judge sees the PR title and the claim text, nothing else. Severity,
// tier, hunter, category and where the claim came from stay hidden, so the
// label cannot echo the hunter's own rating or the anchor's source.
//
// Before the judge measures anything it must pass an exam on anchors with a
// known answer (`scoreExam`). The pass bar is fixed here, before any result
// was seen, and a judge that misses it is not used.
//
// The impure half (spawning the judge) is scripts/materiality-probe.ts.

import { createHash } from "node:crypto";
import type { MartianGoldenPr } from "#compare/martian-adapter";

export type MaterialityLabel = "material" | "immaterial";

export interface MaterialityVerdict {
  label: MaterialityLabel;
  reason: string;
}

// `gating` anchors decide pass/fail. `secondary` ones are reported only: the
// Martian Low style/speculative/doc_defect comments were still posted by a
// human reviewer, so they are a weak immaterial signal, not a known answer.
export type AnchorRole = "gating" | "secondary";

export interface Anchor {
  id: string;
  source: "martian-golden" | "planted";
  role: AnchorRole;
  expected: MaterialityLabel;
  prTitle: string;
  claim: string;
}

export const PASS_BAR = {
  material: 0.9,
  immaterial: 0.8,
  stability: 0.9,
} as const;

// The judge never sees more than this of a claim. Long engine claims carry
// evidence paragraphs a short golden never has, and that length difference
// alone could become the signal.
export const CLAIM_CHAR_CAP = 600;

export function normalizeClaim(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= CLAIM_CHAR_CAP) return flat;
  return `${flat.slice(0, CLAIM_CHAR_CAP - 1).trimEnd()}…`;
}

export const JUDGE_SYSTEM = `You are a senior software engineer deciding whether one code review comment is worth posting on a pull request.

Assume the comment is factually correct. Do not try to verify it, and do not lower your answer because you cannot see the code. Decide only whether a careful reviewer who respects the author's time would post it.

Answer "material" when the issue, if left in, would plausibly cause harm under normal use of this code: wrong results, a crash or hang, lost or corrupted data, a security or privacy exposure, a broken contract for callers, a leak or slowdown that normal traffic reaches, or a race that ordinary concurrency triggers. A concrete, plausible scenario with visible harm is enough.

Answer "immaterial" when, even granting the comment is true, posting it would not change anything that matters: the harm needs conditions this code will not meet in practice, the point is about naming, formatting, wording or taste, it asks for defensive code without a concrete way to fail, or the effect is too small for anyone to notice.

Reply with one JSON object and nothing else:
{"label": "material" | "immaterial", "reason": "<one sentence>"}`;

export function judgeSystemSha256(): string {
  return createHash("sha256").update(JUDGE_SYSTEM).digest("hex");
}

export function renderJudgePrompt(prTitle: string, claim: string): string {
  return [
    `Pull request: ${prTitle.replace(/\s+/g, " ").trim()}`,
    "",
    "Review comment:",
    normalizeClaim(claim),
  ].join("\n");
}

export function parseJudgeVerdict(finalText: string): MaterialityVerdict {
  const trimmed = finalText.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("judge returned no JSON object");
  }
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("judge JSON is not an object");
  }
  const { label, reason } = parsed as Record<string, unknown>;
  if (label !== "material" && label !== "immaterial") {
    throw new Error(`judge label is not material|immaterial: ${String(label)}`);
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error("judge reason is missing");
  }
  return { label, reason: reason.trim() };
}

const SECONDARY_LOW_CATEGORIES = new Set([
  "style",
  "speculative",
  "doc_defect",
]);

// Martian goldens as anchors: High/Critical are material (gating); Low with a
// style/speculative/doc_defect category are immaterial (secondary). Medium and
// the rest of Low are left out: Martian's Low includes crashes, so its
// severity alone is not a known answer.
export function goldenAnchors(
  corpus: string,
  goldens: MartianGoldenPr[],
): Anchor[] {
  const out: Anchor[] = [];
  goldens.forEach((pr, prIndex) => {
    pr.comments.forEach((comment, commentIndex) => {
      const id = `${corpus}-${prIndex}-${commentIndex}`;
      const base = {
        id,
        source: "martian-golden" as const,
        prTitle: pr.pr_title,
        claim: comment.comment,
      };
      if (comment.severity === "High" || comment.severity === "Critical") {
        out.push({ ...base, role: "gating", expected: "material" });
      } else if (
        comment.severity === "Low" &&
        SECONDARY_LOW_CATEGORIES.has(comment.category)
      ) {
        out.push({ ...base, role: "secondary", expected: "immaterial" });
      }
    });
  });
  return out;
}

export interface PlantedAnchor {
  id: string;
  prTitle: string;
  claim: string;
}

export function plantedAnchors(planted: PlantedAnchor[]): Anchor[] {
  return planted.map((p) => ({
    id: `planted-${p.id}`,
    source: "planted",
    role: "gating",
    expected: "immaterial",
    prTitle: p.prTitle,
    claim: p.claim,
  }));
}

// The stability subset: the first `perLabel` gating anchors of each expected
// label, in input order, so the same subset is picked on every run.
export function stabilitySubset(anchors: Anchor[], perLabel: number): string[] {
  const pick = (label: MaterialityLabel) =>
    anchors
      .filter((a) => a.role === "gating" && a.expected === label)
      .slice(0, perLabel)
      .map((a) => a.id);
  return [...pick("material"), ...pick("immaterial")];
}

export interface JudgeRun {
  anchorId: string;
  replicate: number;
  label: MaterialityLabel | null; // null: the spawn or parse failed
  reason?: string;
  error?: string;
}

export interface RateRow {
  hits: number;
  judged: number;
  failed: number;
  rate: number | null;
}

export interface ExamScore {
  material: RateRow;
  immaterial: RateRow;
  secondaryImmaterial: RateRow;
  stability: RateRow;
  passed: boolean;
  reasons: string[];
}

function rate(hits: number, judged: number): number | null {
  return judged === 0 ? null : hits / judged;
}

// Rates read replicate 0 only, so the stability subset's extra runs do not
// weigh those anchors twice. A failed spawn counts as a miss: a judge that
// cannot answer has not passed.
export function scoreExam(anchors: Anchor[], runs: JudgeRun[]): ExamScore {
  const byId = new Map(anchors.map((a) => [a.id, a]));
  const row = (pick: (a: Anchor) => boolean): RateRow => {
    let hits = 0;
    let judged = 0;
    let failed = 0;
    for (const run of runs) {
      if (run.replicate !== 0) continue;
      const anchor = byId.get(run.anchorId);
      if (anchor === undefined || !pick(anchor)) continue;
      judged += 1;
      if (run.label === null) failed += 1;
      else if (run.label === anchor.expected) hits += 1;
    }
    return { hits, judged, failed, rate: rate(hits, judged) };
  };

  const material = row((a) => a.role === "gating" && a.expected === "material");
  const immaterial = row(
    (a) => a.role === "gating" && a.expected === "immaterial",
  );
  const secondaryImmaterial = row((a) => a.role === "secondary");

  const labelsById = new Map<string, (MaterialityLabel | null)[]>();
  for (const run of runs) {
    const list = labelsById.get(run.anchorId) ?? [];
    list.push(run.label);
    labelsById.set(run.anchorId, list);
  }
  let stableHits = 0;
  let stableJudged = 0;
  let stableFailed = 0;
  for (const labels of labelsById.values()) {
    if (labels.length < 2) continue;
    stableJudged += 1;
    if (labels.includes(null)) stableFailed += 1;
    else if (labels.every((l) => l === labels[0])) stableHits += 1;
  }
  const stability: RateRow = {
    hits: stableHits,
    judged: stableJudged,
    failed: stableFailed,
    rate: rate(stableHits, stableJudged),
  };

  const reasons: string[] = [];
  const check = (name: keyof typeof PASS_BAR, r: RateRow) => {
    if (r.rate === null) reasons.push(`${name}: nothing judged`);
    else if (r.rate < PASS_BAR[name]) {
      reasons.push(
        `${name}: ${(r.rate * 100).toFixed(1)}% < ${PASS_BAR[name] * 100}%`,
      );
    }
  };
  check("material", material);
  check("immaterial", immaterial);
  check("stability", stability);

  return {
    material,
    immaterial,
    secondaryImmaterial,
    stability,
    passed: reasons.length === 0,
    reasons,
  };
}
