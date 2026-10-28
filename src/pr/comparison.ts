// PR mode's comparison.json stage, in-process. Relocated out of reviewPr()
// (src/pr/review-pr.ts): the two sequential `if/else` blocks collapsed into
// one early-return guard clause, identifiers renamed to explicit parameters,
// control flow otherwise unchanged. The WHY comments below move with the
// code they explain.
//
// A failure here must NOT fail the run: the review artifacts are already on
// disk and are the product, so a write hiccup degrades to a warning, never an
// exit code. A run where EVERY hunter died writes no comparison at all —
// "pr-hero 0" from a review that never happened would land in B4's ledger as
// a measured miss, and the ledger's honesty outranks the artifact's
// completeness.

import type { PrHeroFindingRef } from "#compare/compare";
import { parseComparisonJson, type StoredComparison } from "#compare/ledger";
import { type ComparisonOutcome, writeComparison } from "#pr/pr";
import type { RunStatus } from "#review/findings";
import { log } from "#ui/primitives";

export interface ComparisonStageResult {
  comparison: ComparisonOutcome | null;
  storedComparison: StoredComparison | null;
}

export async function computeComparison(input: {
  sessionFailed: boolean;
  pr: number;
  headSha: string;
  diffFromSha: string;
  runDir: string;
  runStatus: RunStatus;
  findings: PrHeroFindingRef[];
  // Test-only seam (default: the real writeComparison), so the offline tests
  // can inject a writer that fails or leaves an unreadable file while the
  // read-back below (parseComparisonJson) still runs for real.
  write?: typeof writeComparison;
}): Promise<ComparisonStageResult> {
  const write = input.write ?? writeComparison;
  if (input.sessionFailed) {
    log(
      "comparison skipped: every hunter failed, so there is no review to compare",
    );
    return { comparison: null, storedComparison: null };
  }

  let comparison: ComparisonOutcome | null = null;
  try {
    comparison = await write({
      pr: input.pr,
      headSha: input.headSha,
      diffFromSha: input.diffFromSha,
      runDir: input.runDir,
      // The I/O shell owns the clock; the pure builder just records it.
      generatedAt: new Date().toISOString(),
      runStatus: input.runStatus,
      findings: input.findings,
    });
  } catch (error) {
    log(
      "warning: writing comparison.json failed — the review itself is " +
        `intact: ${(error as Error).message}`,
    );
  }

  // The observability store (W4 / #23). AFTER the comparison write: reads
  // comparison.json back off disk — the artifact IS the source of truth, so
  // this never re-derives the bucketing itself. Fail-soft, same contract as
  // local mode: never turns a successful review into a failed one.
  let storedComparison: StoredComparison | null = null;
  if (comparison) {
    try {
      storedComparison = parseComparisonJson(
        await Bun.file(comparison.jsonPath).text(),
      );
    } catch {
      // Degrades to a run row without comparison children; ingestRun itself
      // throwing is handled (and warned on) by failSoftIngest.
    }
  }

  return { comparison, storedComparison };
}
