// Hunter/refuter output handling: extraction from a session's final message
// and structural validation BEFORE anything reaches the pipeline. A step whose
// final text does not survive these checks is "not delivered" — the same role
// v1's draftDelivered() played for the monolithic session, applied per step.

import type {
  CausalDisposition,
  EvidenceClass,
  Finding,
  RunSummary,
  Severity,
} from "./findings";
import { unresolvedProofRefs } from "./proof-refs";
import { isSafeSlug } from "./spec";

// What a hunter emits: a Finding minus the two fields the pipeline assigns
// later (tier at Step 7, refuter_verdict at Step 6).
export type DraftFinding = Omit<Finding, "tier" | "refuter_verdict">;

export interface HunterDraft {
  findings: DraftFinding[];
}

// #214, widened by #299: a hunt that was given tools and whose transport
// observed zero tool calls is not a legal SUCCESS, whatever it returned. It is
// a review that did not look.
//
// #214 gated only the EMPTY array: a clean bill with no reading behind it.
// #299 (2026-10-01) closes the other half. The hunter contract
// (HUNTER_READ_REQUIREMENT, pipeline.ts) now requires reading the code, and
// says a finding whose proof was not read with a tool is not admissible; this
// gate is where the engine ENFORCES that contract. Observed 2026-10-01 in run
// `df63033a-2`: a logic hunter returned 1 finding with 0 tool calls,
// self-described as "inferred from the diff", and passed the empty-only gate.
//
// The cost is stated, not hidden: a rare real finding that was reachable from
// the diff alone is lost for that run. It is never lost silently. The step
// fails, the run goes partial, and no clean bill is posted.
//
// Unknown counts stay ungated: a transport that cannot observe tools must
// not invent a failure, and must not invent a pass by stamping a 0 it did
// not see. OpenCode stamps the count (including 0). Claude Code derives it from
// the CLI result's `num_turns` (#299) and omits it when that is not a valid
// integer. Scout is out of this rule because the engine forces `tools: []`.
//
// Only a parsed `{ findings: [...] }` can trip it. The refuter and verifier
// emit `results`, the summarizer `prose`/`score`, and the scout a bare lead
// list; none of them has a `findings` array, so none of them is reached.
export function isVacuousHunt(input: {
  readonly tools: readonly string[];
  readonly toolInvocations: number | undefined;
  readonly parsed: unknown;
}): boolean {
  if (input.toolInvocations === undefined) return false;
  if (input.tools.length === 0) return false;
  if (input.toolInvocations !== 0) return false;
  if (typeof input.parsed !== "object" || input.parsed === null) {
    return false;
  }
  return Array.isArray((input.parsed as { findings?: unknown }).findings);
}

// `downgraded-latent` (ROADMAP A2): the claim holds as a real defect, but
// nothing can execute it at this commit. Distinct from `refuted`, which
// deletes the finding — the G6 lesson is that a latent defect must stay
// visible. Maps to the same-named RefuterVerdict and lands advisory.
export type RefuterOutcome =
  | "corroborated"
  | "refuted"
  | "inconclusive"
  | "downgraded-latent";

export interface RefuterResult {
  results: Array<{
    finding_id: string;
    outcome: RefuterOutcome;
    proof_refs: string[];
  }>;
}

// #152: the reviewed tree arrives as a predicate, never as a filesystem
// call from here — this module stays pure and the offline suite stays offline.
export interface DraftValidationOptions {
  // Answers "does the reviewed tree contain this repo-relative path". ABSENT
  // means the resolvability rule does not run at all, which is what keeps the
  // lab, the probes and every offline caller behaving exactly as before.
  resolveProofRef?: (path: string) => boolean;
}

export class DraftValidationError extends Error {}

// A citation nobody can resolve is not weaker evidence, it is NO evidence
// wearing the shape of some (#152) — so it fails the step the same way a
// duplicate verdict or a malformed draft does, and takes the existing retry.
function mustResolveProofRefs(
  refs: readonly string[],
  options: DraftValidationOptions | undefined,
  label: string,
): void {
  const resolve = options?.resolveProofRef;
  if (resolve === undefined) return;
  const unresolved = unresolvedProofRefs(refs, resolve);
  must(
    unresolved.length === 0,
    `${label} cite paths absent from the reviewed tree: ${unresolved.join(", ")}`,
  );
}

function must(condition: boolean, message: string): void {
  if (!condition) throw new DraftValidationError(message);
}

// An optional string field the model filled with `null`. Inline JSON gives a
// model no way to spell "absent", so `null` here means exactly what an absent
// key means — and it is NORMALISED away rather than rejected.
//
// That is a deliberate exception to this file's fail-loud default, on the same
// reasoning extractJsonObject already tolerates a fenced or prose-wrapped
// draft: the value is unambiguous, refusing it recovers nothing, and one
// must() throw discards every OTHER finding in the same draft and burns a paid
// retry. A hunter writing `"symbol": null` is ordinary model behaviour, not a
// corrupt draft.
//
// A present-but-wrong-typed value is NOT normalised. There is nothing to
// recover from `symbol: 42`, and left in place it reaches the renderer and
// throws the same TypeError this rule exists to prevent.
//
// PAID-FOR FAILURE (PR #50, 2026-08-23): a hunter emitted `"symbol": null`,
// neither validator looked at the field, the null was written into
// findings.json — the artifact the sibling lab validates — and then killed the
// POST at review/report.ts's oneLine(). The pipeline had already billed $3.77.
//
// Mutates IN PLACE: validateHunterDraft discards this function's return value,
// so rebuilding here would be silently inert. review/pipeline.ts stamps `hunter` onto
// the same extracted object the same way.
function normalizeOptionalString(
  f: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (f[key] === null) {
    delete f[key];
    return;
  }
  must(
    f[key] === undefined || typeof f[key] === "string",
    `${label} must be a string when present`,
  );
}

// Fence/prose-tolerant JSON extraction. Models occasionally wrap the mandated
// JSON-only final message in a code fence or a sentence of prose; both are
// recoverable without a retry. Anything not confidently readable returns
// undefined (never a guess) — the caller treats that as "not delivered".
export function extractJsonObject(finalText: string): unknown {
  const direct = tryParse(finalText.trim());
  if (direct !== undefined) return direct;

  const fenced = finalText.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Last resort: the largest balanced `{...}` span that parses. Covers "Here is
  // the result: {...}". It used to be first-`{`-to-last-`}`, which a single
  // brace in the surrounding prose broke: a hunter's closing note cited
  // `${id}.${codec}`, the slice started inside that template literal, and a
  // valid two-finding draft (one of them the planted defect) was rejected as a
  // format violation (lab ledger, cost levers v3, musive #965, 2026-10-21).
  // Largest, not first: a stray `{}` in the prose also parses, and must never
  // win over the draft.
  let best: { length: number; end: number; value: unknown } | undefined;
  for (let start = finalText.indexOf("{"); start !== -1; ) {
    const end = matchingBrace(finalText, start);
    if (end !== -1 && (best === undefined || end - start + 1 > best.length)) {
      const value = tryParse(finalText.slice(start, end + 1));
      if (value !== undefined) best = { length: end - start + 1, end, value };
    }
    // Braces inside an object already parsed (a claim quoting code) cannot
    // start a larger one, so they are skipped rather than rescanned.
    const from = best !== undefined && best.end > start ? best.end : start;
    start = finalText.indexOf("{", from + 1);
  }
  return best?.value;
}

// The index of the `}` closing the `{` at `start`, skipping braces inside JSON
// strings (a claim quoting `fn() {}` must not close the object early), or -1
// when the text ends first.
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParse(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const SEVERITIES: Severity[] = ["BLOCKER", "CRITICAL", "WARNING", "SUGGESTION"];
const EVIDENCE_CLASSES: EvidenceClass[] = [
  "deterministic",
  "inferential",
  "insufficient",
];
const CAUSAL_DISPOSITIONS: CausalDisposition[] = [
  "introduced",
  "behavior-activated",
  "worsened",
  "pre-existing",
  "base-only",
  "unknown",
];
const REFUTER_OUTCOMES: RefuterOutcome[] = [
  "corroborated",
  "refuted",
  "inconclusive",
  "downgraded-latent",
];

export function validateSummary(candidate: unknown): RunSummary {
  must(
    typeof candidate === "object" && candidate !== null,
    "summary must be an object",
  );
  const summary = candidate as Record<string, unknown>;
  must(
    typeof summary.prose === "string" && summary.prose.length > 0,
    "summary.prose required",
  );
  must(
    typeof summary.prose === "string" && summary.prose.length <= 1200,
    "summary.prose must be at most 1200 characters",
  );
  must(
    typeof summary.score === "number" &&
      Number.isInteger(summary.score) &&
      summary.score >= 1 &&
      summary.score <= 5,
    "summary.score must be an integer 1-5",
  );
  must(
    typeof summary.score_reason === "string" && summary.score_reason.length > 0,
    "summary.score_reason required",
  );
  must(
    typeof summary.score_reason === "string" &&
      summary.score_reason.length <= 400,
    "summary.score_reason must be at most 400 characters",
  );
  const prose = summary.prose as string;
  const scoreReason = summary.score_reason as string;
  must(
    !prose.includes("<!--") &&
      !prose.includes("-->") &&
      !scoreReason.includes("<!--") &&
      !scoreReason.includes("-->"),
    "summary strings must not contain HTML comment markers",
  );
  return summary as unknown as RunSummary;
}

export function validateDraftFinding(
  candidate: unknown,
  index: number,
  options?: DraftValidationOptions,
): DraftFinding {
  must(
    typeof candidate === "object" && candidate !== null,
    `draft findings[${index}] must be an object`,
  );
  const f = candidate as Record<string, unknown>;
  must(
    typeof f.id === "string" && f.id.length > 0,
    `draft findings[${index}].id required`,
  );
  // Drafts are always merged into a v1.1 document: mergeRunEnvelope
  // (review/findings.ts) stamps SCHEMA_VERSION_V1_1 unconditionally, with no
  // v1.0 production writer left (odd/tasks/logic-hunter.md T1 verified this
  // in code before relying on it). So the draft validator accepts the full
  // v1.1 range, 1-15, category 15 = "local logic error" included.
  must(
    typeof f.category === "number" && f.category >= 1 && f.category <= 15,
    `draft findings[${index}].category must be 1-15`,
  );
  must(
    typeof f.path === "string" && f.path.length > 0,
    `draft findings[${index}].path required`,
  );
  must(
    typeof f.line === "number",
    `draft findings[${index}].line must be a number`,
  );
  must(
    SEVERITIES.includes(f.severity as Severity),
    `draft findings[${index}].severity invalid`,
  );
  must(
    EVIDENCE_CLASSES.includes(f.evidence_class as EvidenceClass),
    `draft findings[${index}].evidence_class invalid`,
  );
  must(
    CAUSAL_DISPOSITIONS.includes(f.causal_disposition as CausalDisposition),
    `draft findings[${index}].causal_disposition invalid`,
  );
  must(
    typeof f.claim === "string" && f.claim.length > 0,
    `draft findings[${index}].claim required`,
  );
  must(
    Array.isArray(f.proof_refs),
    `draft findings[${index}].proof_refs must be an array`,
  );
  must(
    typeof f.hunter === "string" && isSafeSlug(f.hunter),
    `draft findings[${index}].hunter invalid`,
  );
  must(
    typeof f.hops_used === "number",
    `draft findings[${index}].hops_used must be a number`,
  );
  must(
    Array.isArray(f.hop_trail),
    `draft findings[${index}].hop_trail must be an array`,
  );
  must(
    typeof f.dedupe_key === "string" && f.dedupe_key.length > 0,
    `draft findings[${index}].dedupe_key required`,
  );
  // Array.isArray above says nothing about what is INSIDE, and every element
  // is rendered through oneLine() on the same paid posting path the null
  // symbol crashed. Unlike an absent symbol a null element carries no
  // recoverable meaning, so this one rejects.
  must(
    (f.proof_refs as unknown[]).every((ref) => typeof ref === "string"),
    `draft findings[${index}].proof_refs must contain only strings`,
  );
  mustResolveProofRefs(
    f.proof_refs as string[],
    options,
    `draft findings[${index}].proof_refs`,
  );
  // The only two optional keys on a DraftFinding. `root_cause_id` is normally
  // engine-assigned (review/pipeline.ts), which does not stop a hunter emitting it.
  normalizeOptionalString(f, "symbol", `draft findings[${index}].symbol`);
  normalizeOptionalString(
    f,
    "root_cause_id",
    `draft findings[${index}].root_cause_id`,
  );
  return f as unknown as DraftFinding;
}

export function validateHunterDraft(
  candidate: unknown,
  options?: DraftValidationOptions,
): HunterDraft {
  must(
    typeof candidate === "object" && candidate !== null,
    "hunter draft must be an object",
  );
  const d = candidate as Record<string, unknown>;
  must(Array.isArray(d.findings), "hunter draft .findings must be an array");
  (d.findings as unknown[]).forEach((f, i) => {
    validateDraftFinding(f, i, options);
  });
  return d as unknown as HunterDraft;
}

// The prose contract is "one verdict per finding, never implied". Here that
// stops being an instruction and becomes an invariant: the id sets must match
// EXACTLY — a missing verdict, a duplicate, or a verdict for a finding never
// submitted each reject the whole result (→ step not delivered → retry path).
export function validateRefuterResult(
  candidate: unknown,
  submittedIds: string[],
  options?: DraftValidationOptions,
): RefuterResult {
  must(
    typeof candidate === "object" && candidate !== null,
    "refuter result must be an object",
  );
  const d = candidate as Record<string, unknown>;
  must(Array.isArray(d.results), "refuter result .results must be an array");
  const seen = new Set<string>();
  for (const [i, entry] of (d.results as unknown[]).entries()) {
    must(
      typeof entry === "object" && entry !== null,
      `refuter results[${i}] must be an object`,
    );
    const r = entry as Record<string, unknown>;
    must(
      typeof r.finding_id === "string" && r.finding_id.length > 0,
      `refuter results[${i}].finding_id required`,
    );
    must(
      REFUTER_OUTCOMES.includes(r.outcome as RefuterOutcome),
      `refuter results[${i}].outcome invalid`,
    );
    must(
      Array.isArray(r.proof_refs),
      `refuter results[${i}].proof_refs must be an array`,
    );
    // Preventive, not a live crash vector: only `outcome` is read off a
    // refuter result today (review/pipeline.ts). Kept symmetric with the draft rule
    // above so a future consumer cannot inherit the same class of defect.
    must(
      (r.proof_refs as unknown[]).every((ref) => typeof ref === "string"),
      `refuter results[${i}].proof_refs must contain only strings`,
    );
    mustResolveProofRefs(
      r.proof_refs as string[],
      options,
      `refuter results[${i}].proof_refs`,
    );
    const id = r.finding_id as string;
    must(!seen.has(id), `refuter results duplicate verdict for ${id}`);
    must(
      submittedIds.includes(id),
      `refuter results verdict for never-submitted ${id}`,
    );
    seen.add(id);
  }
  for (const id of submittedIds) {
    must(seen.has(id), `refuter results missing verdict for ${id}`);
  }
  return d as unknown as RefuterResult;
}
