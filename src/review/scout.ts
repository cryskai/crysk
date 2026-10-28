// The scout's PURE half — the diff-only pre-hunter stage (ROADMAP-DOORDASH M3,
// `docs/scout-design.md` §3.7-§3.9). Engine source, never prompt-set text: the
// contract string, the caps and the leads block are covered by the engine
// version, not by the prompt-set fingerprint.
//
// WHY this module exists in M4, one milestone before the stage is wired into
// review/pipeline.ts: so the scout-probe measures the SAME parsing, capping and
// rendering the engine will ship in M5. A probe carrying its own parser and its
// own caps would measure the probe's parser — and every number it produced
// about the PROMPT would be confounded by a second implementation that no
// production run ever executes.

import { normalizePath } from "#compare/compare";
import { wrapBlock } from "#review/boundary";

// Prose §3.7 turned into the engine-owned output contract, beside
// HUNTER/REFUTER/SUMMARY_OUTPUT_CONTRACT in review/pipeline.ts. This text is driver
// source: it is covered by the engine version, NOT by the prompt-set
// fingerprint.
export const SCOUT_OUTPUT_CONTRACT = [
  "Your final message must be exactly one JSON object — no prose, no code",
  "fences — of the shape",
  '{"leads":[{"path":"...","line":123,"why":"one sentence"}]}. A lead',
  "carries nothing else: no severity, no evidence class, no proof refs, no",
  'hop trail. If the diff hides no suspicious place, return {"leads":[]} —',
  "an empty array is a valid, expected result, not a failure.",
].join("\n");

export interface ScoutLead {
  path: string;
  line: number;
  why: string;
}

// The scout gets the patch and the contract and NOTHING else — no priors, no
// gotchas, no PR title or body (§3.8). Feeding it the same {{PRIORS}}/
// {{GOTCHAS}} the hunters read would correlate its attention with theirs, and
// the independence of its pass is the entire reason it can add coverage.
// Byte-identical in shape to summarizerPrompt: patch, blank line, contract.
//
// The patch is the ONE attacker-controlled block this prompt carries and it is
// the first thing the scout reads, so it is wrapped in C4's nonced boundary
// tag (`docs/c4-preamble-design.md` §3.3): a diff that adds a line reading
// `</patch>` cannot end its own block and speak as the engine. `nonce` is
// REQUIRED rather than defaulted — a default would let a caller compose an
// unwrapped prompt by omission, which is the whole failure this closes.
export function scoutPrompt(patch: string, nonce: string): string {
  return [wrapBlock("patch", nonce, patch), "", SCOUT_OUTPUT_CONTRACT].join(
    "\n",
  );
}

export class ScoutValidationError extends Error {}

function must(condition: boolean, message: string): void {
  if (!condition) throw new ScoutValidationError(message);
}

// Structural validation BEFORE anything reaches the driver — the same role
// validateHunterDraft plays for a hunter's draft. A step whose final message
// does not survive these checks is "not delivered".
export function validateScoutLeads(candidate: unknown): ScoutLead[] {
  must(
    typeof candidate === "object" && candidate !== null,
    "scout output must be an object",
  );
  const d = candidate as Record<string, unknown>;
  // An ABSENT `leads` key is a failure, never an empty list: the contract makes
  // {"leads":[]} the way a scout says "nothing suspicious here", so a model
  // that omitted the key did not tell us it found nothing — it told us nothing.
  must(Array.isArray(d.leads), "scout output .leads must be an array");
  return (d.leads as unknown[]).map((entry, i) => {
    must(
      typeof entry === "object" && entry !== null,
      `scout leads[${i}] must be an object`,
    );
    const lead = entry as Record<string, unknown>;
    must(
      typeof lead.path === "string" && lead.path.length > 0,
      `scout leads[${i}].path required`,
    );
    must(
      typeof lead.path === "string" && lead.path.length <= 400,
      `scout leads[${i}].path must be at most 400 characters`,
    );
    // Git diff notation is not a path. A scout that writes `b/src/x.ts` copied
    // the `+++ b/...` header it was given — it is being literal, not wrong —
    // and the prompt's Coordinates section asks for the bare path. Stripping
    // the prefix HERE, at the one boundary every lead crosses, is what makes
    // that slip free: the caps' per-path grouping, the block the hunters read,
    // §3.10's hunk metric and §3.9's ±25 attribution then all see one spelling.
    // Left unstripped, a correct suspicion at the right line scores as a
    // coverage MISS and the M4 gate silently measures prompt formatting
    // instead of scouting. `compare/compare.ts`'s normalizePath is deliberately NOT
    // the place for this: it defines "the same path" for the PR
    // comparison rows, and widening it there would invent matches across
    // `packages/`.
    const leadPath = (lead.path as string).replace(/^[ab]\//, "");
    must(leadPath.length > 0, `scout leads[${i}].path required`);
    must(
      typeof lead.line === "number" &&
        Number.isInteger(lead.line) &&
        lead.line >= 1,
      `scout leads[${i}].line must be an integer >= 1`,
    );
    must(
      typeof lead.why === "string" && lead.why.length > 0,
      `scout leads[${i}].why required`,
    );
    // NO maximum on `why` here on purpose. The 240-char ceiling is a DRIVER cap
    // applied in capScoutLeads, not grounds to discard a whole step's output:
    // one over-long sentence would otherwise delete eleven good leads and the
    // paid spawn that produced them.
    //
    // Extra keys are IGNORED, never rejected — the return value is narrowed to
    // exactly {path, line, why}. A model that volunteers a `severity` has not
    // failed the contract; silently dropping the key is what keeps the scout
    // structurally incapable of producing a finding (§3.5 mechanism 3), and
    // rejecting it instead would trade that guarantee for a lost step.
    return {
      path: leadPath,
      line: lead.line as number,
      why: lead.why as string,
    };
  });
}

// The ceiling (§3.8). Hard, enforced by the driver, never by the prompt alone —
// a prompt-only cap is a request, and the failure mode DashBench names is a
// scout that leads on everything.
export const MAX_LEADS = 12; // above this it is a filter of nothing
export const MAX_LEADS_PER_PATH = 3; // stops one interesting file absorbing the whole budget
export const MAX_WHY_CHARS = 240; // one sentence; a paragraph is a finding in disguise
export const MAX_LEADS_BLOCK_CHARS = 3000; // bounded prompt growth per hunter, x4 hunters

// The verbatim block shape from §3.8. The header paragraph is the
// anti-anchoring guard, and it is what keeps §3.4's "bias" from decaying into
// "replace" in practice: without it a hunter reads a lead list as a work order
// and stops scanning the rest of the diff.
const LEADS_BLOCK_HEADER = [
  "Scout leads — UNVERIFIED suspicions from a diff-only pass that read no",
  "code. They are not findings, they carry no evidence, and confirming one",
  "still requires your own proof_refs. Their absence is not evidence of",
  "absence: your own scan of the whole diff is unchanged.",
].join("\n");

// Empty leads render to the EMPTY STRING, not to a header with no bullets: the
// block must be absent byte for byte when there is nothing to say. That is what
// makes M6's control arm a control arm — a scout run that found nothing must
// produce a hunter prompt identical to an unled run's.
export function renderLeadsBlock(leads: ScoutLead[]): string {
  if (leads.length === 0) return "";
  const bullets = leads.map((l) => `- ${l.path}:${l.line} — ${l.why}`);
  return [LEADS_BLOCK_HEADER, "", ...bullets].join("\n");
}

export interface CappedLeads {
  leads: ScoutLead[];
  dropped: number;
  whyTruncated: number;
}

// Deterministic, INPUT ORDER, no re-ranking. Re-ranking would make the scout a
// filter rather than a bias, and a filter's cost lands entirely in the blind
// spot where neither M6 arm can see it: a lead ranked out is a place no hunter
// was pointed at and no artifact records.
//
// A truncation that fires routinely is a PROMPT defect to fix, never a cap to
// raise (§3.8) — which is why the probe reports raw and capped counts side by
// side instead of only what survived.
export function capScoutLeads(leads: ScoutLead[]): CappedLeads {
  let whyTruncated = 0;
  // (a) per-lead `why` truncation. Counted for every lead it fires on, even one
  // a later step drops — the count answers "is the prompt writing paragraphs?",
  // which is a property of the scout's output, not of what survived the caps.
  const truncated = leads.map((lead) => {
    if (lead.why.length <= MAX_WHY_CHARS) return lead;
    whyTruncated++;
    return { ...lead, why: lead.why.slice(0, MAX_WHY_CHARS) };
  });

  // (b) per-path: the first MAX_LEADS_PER_PATH per distinct path. Exact string
  // equality, no normalization — the scout is instructed to use the diff's own
  // path spelling (§3.7 Coordinates), so two spellings of one file are a prompt
  // failure to see, not a cap to paper over.
  const perPath = new Map<string, number>();
  const pathCapped: ScoutLead[] = [];
  for (const lead of truncated) {
    const seen = perPath.get(lead.path) ?? 0;
    if (seen >= MAX_LEADS_PER_PATH) continue;
    perPath.set(lead.path, seen + 1);
    pathCapped.push(lead);
  }

  // (c) total.
  const kept = pathCapped.slice(0, MAX_LEADS);

  // (d) block size, measured on the RENDERED block rather than on a sum of
  // field lengths — the header and the bullet punctuation are prompt bytes too.
  // Dropping from the END keeps input order meaningful: the leads that survive
  // are always a prefix of what the scout emitted.
  while (
    kept.length > 0 &&
    renderLeadsBlock(kept).length > MAX_LEADS_BLOCK_CHARS
  ) {
    kept.pop();
  }

  return { leads: kept, dropped: leads.length - kept.length, whyTruncated };
}

export interface HunkRange {
  path: string;
  start: number;
  end: number;
}

// Right-side (new-file) line ranges, one per hunk, in order of appearance.
// Both captures matter here, unlike pr/inline.ts's anchor scan: `d` is what turns
// a header into a RANGE, and `d === 0` is what marks a hunk with no right side.
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const TARGET_HEADER = /^\+\+\+ (.+)$/;

// Parsed from the `+++ b/...` headers plus each `@@` header's right-side counts.
//
// WHY a header scan and not pr/inline.ts's splitDiffRecords: this metric needs the
// hunk BOUNDARIES (a lead lands "inside hunk 3 of 7"), which the anchor-set
// representation deliberately throws away. The cost is the one structural hole
// splitDiffRecords closes for free — an ADDED body line whose own content
// starts with `++` renders as `+++ ...` and reads exactly like a target header.
// Guarded with state: a `+++` line only counts as a header when we are not
// inside a hunk body, and a `diff --git` line resets that state.
export function parseHunkRanges(patch: string): HunkRange[] {
  const ranges: HunkRange[] = [];
  let target: string | undefined;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      target = undefined;
      inHunk = false;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      inHunk = true;
      if (target === undefined) continue;
      const start = Number.parseInt(header[1] as string, 10);
      // An absent count means exactly one line (`@@ -1 +1 @@`), which is git's
      // own shorthand, not a malformed header.
      const count =
        header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
      // A pure-deletion hunk (`+12,0`) has NO right-side line at all. Skipped
      // rather than recorded as an empty range: a lead cannot land on a line
      // that does not exist in the new file, so counting it as a hunk the scout
      // failed to cover would penalise the scout for the impossible.
      if (count === 0) continue;
      ranges.push({ path: target, start, end: start + count - 1 });
      continue;
    }
    if (inHunk) continue;
    const found = TARGET_HEADER.exec(line);
    if (found === null) continue;
    const raw = (found[1] as string).trim();
    // `+++ /dev/null` is a deleted file: it contributes no right-side hunk, and
    // leaving `target` undefined makes its `@@` headers fall through above.
    target = raw === "/dev/null" ? undefined : raw.replace(/^[ab]\//, "");
  }
  return ranges;
}

export interface HunkCoverage {
  hunks: number;
  hunksWithLead: number;
  coverage: number;
  unmatchedLeads: number;
}

// M4's RESTRAINT metric (§3.10 assertion 2). It measures SELECTIVITY — a
// property of the scout — precisely because cleanliness is a property of a PR
// we have not triaged: the six restraint PRs carry untriaged `prhero_only`
// rows, so "this PR is clean" is not a claim this project owns, and a
// precision number computed against it would be fiction.
//
// Stated as what it is: a PROXY. The failure mode DashBench names is not
// "flagged a clean PR", it is filtering nothing — being loud everywhere — and
// the fraction of changed hunks carrying a lead measures exactly that without
// knowing a single defect count.
//
// `unmatchedLeads` is the diagnostic beside it: a lead inside no hunk at all is
// either a miscounted line number (a prompt defect in the Coordinates section)
// or a suspicion about unchanged code (out of contract). Both are worth seeing,
// and neither is visible in the coverage fraction alone.
export function hunkCoverage(patch: string, leads: ScoutLead[]): HunkCoverage {
  const hunks = parseHunkRanges(patch);
  const normalizedLeads = leads.map((l) => ({
    path: normalizePath(l.path),
    line: l.line,
  }));
  const matchedLeads = new Set<number>();
  let hunksWithLead = 0;
  for (const hunk of hunks) {
    const hunkPath = normalizePath(hunk.path);
    let carries = false;
    for (const [i, lead] of normalizedLeads.entries()) {
      if (lead.path !== hunkPath) continue;
      if (lead.line < hunk.start || lead.line > hunk.end) continue;
      // Both loops run to completion: a hunk is counted once no matter how many
      // leads land in it, and every lead that lands anywhere is marked so the
      // unmatched tally stays a per-LEAD number.
      matchedLeads.add(i);
      carries = true;
    }
    if (carries) hunksWithLead++;
  }
  return {
    hunks: hunks.length,
    hunksWithLead,
    // A patch with zero hunks is 0, never NaN — the restraint mean is averaged
    // over runs, and one NaN would poison the whole gate silently.
    coverage: hunks.length === 0 ? 0 : hunksWithLead / hunks.length,
    unmatchedLeads: leads.length - matchedLeads.size,
  };
}
