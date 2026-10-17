// T5b adjudication leg, pure half (src/triage/adjudication.ts holds the record).
// The CI adjudicator rules on one author dismissal per step. This module owns
// the prompt it is given and the one JSON object it must answer with; the
// pipeline owns the step itself. Clones the verify leg's nonce-wrapped block
// pattern (src/rereview/verify.ts composeVerifyPrompt), so the same forgery
// guard applies to the author's argument.

import { blockForgesNonce, wrapBlock } from "#review/boundary";
import { extractJsonObject } from "#review/drafts";
import type {
  AdjudicationSubject,
  AdjudicationVerdict,
} from "#triage/adjudication";

// Verbatim: the adjudicator's output contract is this sentence, nothing else.
const ADJUDICATION_INSTRUCTION =
  'Rule on the author\'s argument that this finding should be dismissed. Read the repository at the current head yourself. Answer with exactly one JSON object and nothing else: {"verdict": "upheld" | "rejected" | "inconclusive", "evidence": ["path:line", ...]}. "upheld" only if you verified in the repository, yourself, that the finding is not a defect.';

const ADJUDICATION_VERDICT_WORDS: ReadonlySet<string> = new Set<string>([
  "upheld",
  "rejected",
  "inconclusive",
]);

// The most path:line citations kept from one ruling. A ruling that cites more
// is not made less true by the excess; the cap keeps the posted reply bounded.
const MAX_EVIDENCE = 20;

export function composeAdjudicationPrompt(
  subject: AdjudicationSubject,
  nonce: string,
): string | null {
  const finding = JSON.stringify(
    {
      prior_id: subject.priorId,
      severity: subject.sev,
      locs: subject.locs,
      claim: subject.claim,
    },
    null,
    2,
  );
  const blocks = [finding, subject.argument];
  if (blocks.some((block) => blockForgesNonce(block, nonce))) return null;
  return [
    wrapBlock("finding", nonce, finding),
    wrapBlock("author_reply", nonce, subject.argument),
    "",
    ADJUDICATION_INSTRUCTION,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function parseAdjudicationResult(finalText: string): {
  verdict: AdjudicationVerdict;
  evidence: string[];
} {
  const extracted = extractJsonObject(finalText);
  if (
    typeof extracted !== "object" ||
    extracted === null ||
    Array.isArray(extracted)
  ) {
    throw new Error("adjudicator final message has no JSON object");
  }
  const record = extracted as Record<string, unknown>;
  const verdict = record.verdict;
  if (typeof verdict !== "string" || !ADJUDICATION_VERDICT_WORDS.has(verdict)) {
    throw new Error(
      "adjudicator verdict is not upheld, rejected or inconclusive",
    );
  }
  const rawEvidence = record.evidence;
  let evidence: string[] = [];
  if (rawEvidence !== undefined) {
    if (
      !Array.isArray(rawEvidence) ||
      !rawEvidence.every((item) => typeof item === "string")
    ) {
      throw new Error("adjudicator evidence is not an array of strings");
    }
    evidence = (rawEvidence as string[])
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, MAX_EVIDENCE);
  }
  return { verdict: verdict as AdjudicationVerdict, evidence };
}
