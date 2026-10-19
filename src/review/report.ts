// The human-facing half of local mode (ROADMAP B0): a pure renderer that
// turns a findings document into the markdown a developer actually reads, and
// a pure cost estimator that runs BEFORE the money is spent.
//
// Pure on purpose — no I/O, no git, no clock. The CLI owns every side effect,
// so the report can be re-rendered from an artifact on disk months later and
// come out byte-identical (the lab already replays old findings.json files;
// a renderer that reached for `new Date()` would make that a lie).

import { listPaths } from "#git/refs";
import type { ResolvedModelRoute, ResolvedStepRoute } from "#model/routing";
import {
  type CiMode,
  findingMarker,
  PR_FINDING_MARKER_PREFIX,
  PR_REREVIEW_CLOSED_MARKER_PREFIX,
  prCommentMarker,
} from "#pr/preflight";
import {
  type RecoveredSeverity,
  SEVERITY_UNRECOVERABLE,
} from "#rereview/classify";
import type {
  Finding,
  FindingsDocument,
  RunStatus,
  Severity,
  Tier,
} from "#review/findings";
import {
  clusterByRootCause,
  extractAnchor,
  type RootCauseSummary,
  rootCauseIdByFinding,
} from "#review/root-cause";

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface CostEstimate {
  low: number;
  high: number;
  // Plain-language statement of how coarse this is, meant to be printed next
  // to the numbers so nobody reads the band as a quote.
  basis: string;
}

// Per-hunter marginal cost, fitted to the measured runs (see BAND below).
// Deliberately three transparent coefficients instead of a regression: with
// this few calibration points anything fancier is false precision.
//
// The base is the load-bearing coefficient, recalibrated 2026-08-11 from
// 0.5 to 1.2: a hunter's floor is reading the TREE and the prompt
// machinery, nearly independent of a small diff. The proof was two PR-mode
// runs of the same 7-file / +21 −8 tree billing $4.74 and $3.92 against a
// $1.19–$2.39 band — both ~2x above the top, the exact under-estimate
// failure this band exists to prevent.
const USD_PER_AGENT_BASE = 1.2;
const USD_PER_CHANGED_LINE = 0.00021;
const USD_PER_FILE = 0.008;

// Skewed on purpose. Every recorded overrun was an UNDER-estimate, never
// over, so the upper arm is the wider one: a band that is too generous costs
// a second of hesitation, a band that is too tight costs real money.
const BAND_LOW = 0.65;
const BAND_HIGH = 1.4;

// WHY this function exists at all: the ROADMAP logs two cost overruns in a
// row — "~$21" against an actual bill, and "~$34" against an actual $48.30 —
// and both had the same cause. The estimate was carried over from the
// PREVIOUS arm instead of being computed from the tree about to be reviewed.
// So this estimates from the diff, and only from the diff.
//
// Calibration points, all measured on real runs of the current engine:
//   - PR 1682's tree (7 files / +21 −8, 3 hunters + refuter) billed $4.74
//     and $3.92 across two runs — the per-agent floor evidence;
//   - a 45-file / +2775 −1237 tree with 5 hunters + refuter billed ~$14.78,
//     and the same tree was recorded at ~$11/run elsewhere in the campaign;
//   - the first B0 local run (5 files / +484, 4 hunters + refuter), $3.68.
// A legacy "~$2.61 small tree" point from before PR mode existed was
// RETIRED by the 1682 evidence: two same-engine runs of a comparable tree
// both landed far above it, and a calibration point the instrument itself
// contradicts is decoration. The ~$11 vs ~$14.78 spread on ONE tree is the
// whole argument for returning a band: the same diff, the same agents, a
// 34% swing. A point estimate here would be a fiction with a decimal point.
//
// The refuter is not a separate term: its cost rides in the coefficients,
// because every calibration run had the refuter leg included and a
// refuter's size tracks how much the hunters found, which tracks diff size.
export function estimateCost(
  diffStat: DiffStat,
  hunterCount: number,
  summarizerEnabled = false,
  // ROADMAP-DOORDASH M5. Defaulted OFF so every existing caller keeps its
  // band byte-identical, and so a caller that forgets it under-quotes
  // nothing it did not already under-quote.
  scoutEnabled = false,
  // Item 7 O-5a. Default 0 so every existing caller keeps its band
  // byte-identical. Priced as its own term (not folded into `agents`) so a
  // 40-finding re-review of a 2-file delta is not billed as 40 hunters.
  verificationSteps = 0,
): CostEstimate {
  const files = Math.max(0, diffStat.files);
  const lines =
    Math.max(0, diffStat.insertions) + Math.max(0, diffStat.deletions);
  // A validated ReviewSpec always carries at least one hunter, so a zero here
  // means a caller asked hypothetically. Clamping keeps the band from
  // collapsing to $0–$0, which would read as "this is free".
  // The scout takes a full agent seat, the summarizer's precedent, and that
  // deliberately OVER-quotes: it is diff-only, one attempt, and reads no tree,
  // so its true cost is a fraction of a hunter's. Two reasons it gets the seat
  // anyway. First, this band's own rule — every recorded overrun was an
  // UNDER-estimate, so the generous direction is the cheap one to be wrong in.
  // Second, the scout has NO calibration point of its own: M4 billed $37.00
  // across six prompt versions, two probe defects and a reverted experiment,
  // which is a milestone total and not a per-spawn cost. M6 records cost per
  // arm; that is the number this coefficient gets recalibrated from, and until
  // it exists an invented per-scout coefficient would be false precision.
  const hunterSeats = Math.max(
    0,
    hunterCount + (summarizerEnabled ? 1 : 0) + (scoutEnabled ? 1 : 0),
  );
  const steps = Math.max(0, verificationSteps);
  // A zero-hunter, zero-verify call still needs a band (the hypothetical
  // floor). A skip-discovery re-review with N verify steps must NOT inherit
  // that floor — that would bill a phantom hunter on top of verification.
  const agents = hunterSeats === 0 && steps === 0 ? 1 : hunterSeats;
  // Verification is its OWN term (item 7 O-5a), not folded into `agents`:
  // a verify step reads one prior finding, not the whole tree, so multiplying
  // it by changed-files would price a 40-finding re-review of a 2-file delta
  // as if it were 40 hunters. The seat is the same per-agent floor — generous
  // on purpose, same direction as the scout.
  const mid =
    agents *
      (USD_PER_AGENT_BASE +
        USD_PER_CHANGED_LINE * lines +
        USD_PER_FILE * files) +
    steps * USD_PER_AGENT_BASE;
  return {
    low: round2(mid * BAND_LOW),
    high: round2(mid * BAND_HIGH),
    basis:
      "coarse band from measured runs (a 7-file / +21 −8 tree with 3 " +
      "hunters + refuter, $3.92–$4.74 across two runs; a 45-file / " +
      "+2775 −1237 tree with 5 hunters + refuter, ~$11–$14.78): a " +
      "per-agent floor for hunters + refuter" +
      `${summarizerEnabled ? " + summarizer" : ""}` +
      `${scoutEnabled ? " + scout" : ""}` +
      `${steps > 0 ? ` + ${steps} verification step(s)` : ""} ` +
      "plus changed lines and files. An order-of-magnitude " +
      "guide, not a quote — the same tree has billed 34% apart across runs.",
  };
}

export interface ReportMeta {
  repo: string;
  base: string;
  head: string;
  // The stat of the EFFECTIVE diff — the one the hunters were handed, with
  // generated content already excluded. Never the raw range's stat: a report
  // that claims 5000 changed lines beside a review of 40 of them is lying
  // about what was read.
  diffStat: DiffStat;
  // Paths the exclusion filter dropped from the reviewed diff, if any. Stated
  // in the report because it is a mutation of the input, not a detail.
  excludedPaths?: string[];
  // CASH, and only cash — §8's "Budget enforcement uses cash only". A Claude
  // subscription route reports a truthful $0.00 here.
  costUsd: number;
  // #173 (§8: "Artifacts and reports show cash and notional totals
  // separately"). The list-basis figure the run was NOT charged. Absent means
  // no segment at all, never a `$0.00` one — a runner that reported no
  // normalized usage has no list figure, and printing one it never produced
  // is the fabrication the usage slice exists to prevent.
  notionalUsd?: number;
  wallMs: number;
  // S4: the mode the commit status is set under, which the closing note names.
  // Absent means advisory: a local run, and any caller that never passes it,
  // keeps today's wording byte-identical.
  ciMode?: CiMode;
}

// What the report needs from a per-agent telemetry row. Telemetry.per_agent's
// DECLARED value type is the lab-shared minimum (tokens_total + duration_ms),
// but this engine writes the richer PerAgentUsage, which carries `status`.
// Read through a runtime check rather than widening the shared schema type:
// the report stays useful on a rich document AND on an old lab artifact that
// only ever had the two fields, and neither one throws.
interface AgentRow {
  key: string;
  status: string;
}

function agentRows(doc: FindingsDocument): AgentRow[] {
  const perAgent = doc.telemetry.per_agent;
  if (!perAgent) return [];
  return Object.entries(perAgent).map(([key, value]) => {
    const status = (value as { status?: unknown }).status;
    return { key, status: typeof status === "string" ? status : "ran" };
  });
}

// The coverage sentence behind every incompleteness notice (GitHub #42,
// ROADMAP-DOORDASH M1). Shared with ui/result.ts — exported for the same
// reason blobUrl below is: the public comment and the terminal must name the
// SAME agents from the SAME bytes, and two derivations of "who did not
// finish" is exactly how one surface starts under-reporting the other.
// `quote` is the only difference between them (backticks in markdown, bare
// text on a terminal), so the prose itself is written once.
//
// WHY "agents" and not "hunters", which is the word the issue uses: the
// document does not record roles. `telemetry.per_agent` is keyed by
// AgentSpec.key and carries a status, but nothing in it says which key was a
// hunter — the refuter and the summarizer sit in the same map (review/pipeline.ts
// writes `refuter` and `summary` rows there). Excluding those two keys by
// name would be a hardcoded list that (a) breaks the moment a spec renames
// the refuter and (b) would print "all hunters completed" on a run that went
// partial BECAUSE the refuter died, which is the under-disclosure this whole
// notice exists to prevent. So every agent is named, and the prose says
// agent. Over-naming costs a word; under-naming costs the guarantee.
//
// Statuses are printed VERBATIM rather than bucketed into failed/ok: an old
// lab artifact whose rows predate the `status` field reads as "ran"
// (agentRows' fallback), and bucketing that into "failed" would invent a
// failure the run never recorded.
export function coverageSentence(
  doc: FindingsDocument,
  quote: (key: string) => string,
): string {
  const rows = agentRows(doc);
  const completed = rows.filter((r) => r.status === "ok").map((r) => r.key);
  const lost = rows.filter((r) => r.status !== "ok");
  // A partial run can name nobody at all, and the notice still has to be
  // honest about that instead of printing an empty list: the gotchas
  // early-return produces `run_status: "partial"` with an EMPTY per_agent map
  // (review/pipeline.ts), a pipeline timeout abandons in-flight steps whose rows are
  // never written, and a pre-v2 artifact has no per_agent at all. "Did not
  // complete: (none)" on any of those would read as "everything ran".
  const done =
    completed.length === 0
      ? "No agent is recorded as completed."
      : `Completed: ${completed.map(quote).join(", ")}.`;
  if (lost.length === 0) {
    return `${done} The run record does not name which agents were lost.`;
  }
  const missing = lost.map((r) => `${quote(r.key)} (${r.status})`).join(", ");
  return `${done} Did not complete: ${missing}.`;
}

// The one sentence behind every moved-head notice (GitHub #39,
// ROADMAP-DOORDASH M1), shared with ui/result.ts for coverageSentence's
// reason: the public comment and the terminal must name the SAME two shas
// from the SAME bytes, and `quote` is the only difference between them
// (backticks in markdown, bare text on a terminal).
//
// The wording is M1's own, kept recognizable on purpose — "reviewed `X`;
// head is now `Y`" is the whole reconciliation POLICY this slice owes. What
// a re-review should DO about findings computed on a stale head (re-verify,
// demote, discard) is ROADMAP item 7's design work and is deliberately NOT
// decided here; with `commit_id` pinned, GitHub anchors the comments to X
// and marks them outdated itself, so the only thing left to say is which
// commit the reader is looking at.
//
// Full 40-char shas, not the 8-char short form the headline uses: this is
// the line a reader takes to `git log` to see what landed in between, and a
// short sha is one paste-and-fail away from being useless.
export function movedHeadSentence(
  reviewedSha: string,
  currentSha: string,
  quote: (text: string) => string,
): string {
  return (
    `Reviewed ${quote(reviewedSha)}; the PR head is now ` +
    `${quote(currentSha)}. Everything below describes the reviewed commit.`
  );
}

type RenderableSummary = NonNullable<FindingsDocument["summary"]>;

function summaryLines(summary: RenderableSummary): string[] {
  return [
    "### Summary",
    "",
    oneLine(summary.prose),
    "",
    `**Confidence: ${summary.score}/5** — ${oneLine(summary.score_reason)}`,
  ];
}

export function renderReport(doc: FindingsDocument, meta: ReportMeta): string {
  const summary = doc.debug.root_causes ?? clusterByRootCause(doc.findings);
  const out: string[] = [];
  out.push(`# Review — ${meta.repo} ${meta.base}..${meta.head}`);
  out.push("");
  out.push(...runLines(doc, meta));
  if (doc.summary !== undefined) {
    out.push("");
    out.push(...summaryLines(doc.summary));
  }
  out.push("");
  out.push(...section("Blocking", doc, "blocking", summary));
  out.push("");
  out.push(...section("Advisory", doc, "advisory", summary));
  out.push("");
  out.push(...notReported(doc));
  out.push("");
  out.push(...closing(doc, meta.ciMode ?? "advisory"));
  // Trailing newline: these strings are written straight to report.md, and a
  // file without one makes every diff of a regenerated report noisy.
  return `${out.join("\n").trimEnd()}\n`;
}

// The deterministic delta line (ROADMAP B6, design D5): computed by
// pr/inline.ts's matcher from the live comment stream, never from a stored
// count. `previousHeadSha` is the PRIOR summary marker's `head=` value — free
// because the marker already carries it — and is absent on the very first
// run (no prior marked comment exists yet) or against a pre-B3 markerless
// comment (no `head=` to parse). Both cases render the counts WITHOUT a
// "since <sha>" clause rather than omitting the line: spec's own "First-ever
// run" scenario requires `0 resolved · K new · 0 persist` to be visible, not
// silent, on the first post.
export interface RereviewLiveRow {
  id: string;
  sev: RecoveredSeverity;
  status: string;
  locs: readonly string[];
  claim: string;
}

export interface RereviewDelta {
  verifiedGone: number;
  unconfirmed: number;
  carried: number;
  deferred: number;
  new: number;
  suppressed: number;
  returned: number;
  reTiered: number;
  live?: readonly RereviewLiveRow[];
  capped?: number;
  case?: string;
  worsened?: readonly {
    priorId: string;
    priorSev: RecoveredSeverity;
    discoverySev: Severity;
  }[];
  // GitHub #166: this run's discovery found nothing to look at (case B's
  // same-head re-review, or case C's restricted delta touching none of the
  // PR's own files) — zero DISCOVERY hunters ran (a verifier may still have
  // run — see `queuedForVerification` handling in `skippedDiscoveryMessage`,
  // rereview/plan.ts). Mirrors `RereviewProvenance.discovery_skipped_empty_delta`
  // (rereview/prepare.ts), which used to be computed and threaded onto the
  // artifact but never READ by this renderer — the gap that let a $0/0s skip
  // publish "pr-hero reviewed this PR and found nothing to report" over a
  // real prior summary.
  discoverySkippedEmptyDelta?: boolean;
  // pr-hero review #286 finding: `discoverySkippedEmptyDelta` alone cannot
  // say WHY discovery came up empty, and "no changes since the last review"
  // is false for the other reason — see `RereviewProvenance.discovery_skip_reason`'s
  // own WHY (rereview/prepare.ts). Absent/`"no_delta"` renders the original
  // wording; `"all_excluded"` MUST name what was excluded instead.
  discoverySkipReason?: "no_delta" | "all_excluded";
  discoveryExcludedPaths?: readonly string[];
}

export interface PrCommentDelta {
  resolved: number;
  new: number;
  persist: number;
  previousHeadSha?: string;
  // Item 7: when present, deltaLine and the clean-bill gate read THIS, not
  // MatchResult.resolved (C2, R2-S6). Absent keeps first-review rendering
  // byte-identical.
  rereview?: RereviewDelta;
}

// `row.sev` arrives typed `string` here (this reader also serves raw
// pipeline.json data, see rereview/prepare.ts's readRereviewProvenance) —
// never widen an unrecognized string INTO a real Severity by casting.
// Anything that is not one of the 4 real values or the sentinel itself
// degrades to the sentinel: the WARNING-default this replaces is #206's own
// bug, restated for the read-back path instead of the build path.
function asRecoveredSeverity(sev: string | undefined): RecoveredSeverity {
  switch (sev) {
    case "BLOCKER":
    case "CRITICAL":
    case "WARNING":
    case "SUGGESTION":
      return sev;
    default:
      return SEVERITY_UNRECOVERABLE;
  }
}

export function rereviewDeltaFromProvenance(
  rereview: {
    case?: string;
    live: readonly {
      id?: string;
      sev?: string;
      status: string;
      locs?: readonly string[];
      claim?: string;
    }[];
    resolved_verified?: number;
    verification_capped?: number;
    returned?: number;
    re_tiered?: number;
    worsened?: readonly {
      priorId: string;
      priorSev: RecoveredSeverity;
      discoverySev: Severity;
    }[];
    // Optional, not `RereviewProvenance`'s required boolean: this structural
    // type is also satisfied by hand-built test fixtures and older
    // pipeline.json reads that never carried the field (schema tolerance).
    discovery_skipped_empty_delta?: boolean;
    // Same optionality reasoning, for the pr-hero review #286 fields — an
    // artifact written before that fix has neither.
    discovery_skip_reason?: "no_delta" | "all_excluded";
    discovery_excluded_paths?: readonly string[];
  },
  newFindings: number,
): RereviewDelta {
  const count = (status: string): number =>
    rereview.live.filter((row) => row.status === status).length;
  return {
    verifiedGone: rereview.resolved_verified ?? 0,
    unconfirmed: count("unconfirmed"),
    carried: count("carried"),
    deferred: count("deferred"),
    new: newFindings,
    suppressed: count("suppressed"),
    returned: rereview.returned ?? 0,
    reTiered: rereview.re_tiered ?? 0,
    live: rereview.live.map((row) => ({
      id: row.id ?? "",
      sev: asRecoveredSeverity(row.sev),
      status: row.status,
      locs: row.locs ?? [],
      claim: row.claim ?? "",
    })),
    capped: rereview.verification_capped ?? 0,
    ...(rereview.case === undefined ? {} : { case: rereview.case }),
    ...(rereview.worsened === undefined ? {} : { worsened: rereview.worsened }),
    ...(rereview.discovery_skipped_empty_delta === true
      ? { discoverySkippedEmptyDelta: true }
      : {}),
    ...(rereview.discovery_skip_reason === undefined
      ? {}
      : { discoverySkipReason: rereview.discovery_skip_reason }),
    ...(rereview.discovery_excluded_paths === undefined ||
    rereview.discovery_excluded_paths.length === 0
      ? {}
      : { discoveryExcludedPaths: rereview.discovery_excluded_paths }),
  };
}

// One consistent severity → emoji mapping (Juanma's PR #2 feedback), shared
// by the summary's headline/index AND every per-finding body — a reader
// who learns 🔴 means BLOCKER/CRITICAL in one place must see the SAME
// mapping everywhere, or the emoji becomes noise instead of a scan aid.
// BLOCKER and CRITICAL share one glyph on purpose: both are the severities
// that can ever reach `tier: "blocking"` (deriveTier, review/findings.ts), so this
// is the same grouping the engine's own gate already makes. Used by the
// summary HEADLINE, which still counts by hunter severity (PR #2: a
// tier-based "0 blocking" hid that both findings were genuinely CRITICAL).
export function severityEmoji(severity: Severity): string {
  switch (severity) {
    case "BLOCKER":
    case "CRITICAL":
      return "🔴";
    case "WARNING":
      return "🟡";
    case "SUGGESTION":
      return "🔵";
  }
}

// GitHub #19 W0: the posted scan aid follows `tier`, not hunter severity.
// A BLOCKER/CRITICAL that deriveTier already made advisory must not scream
// 🔴 — that glyph is reserved for findings that can still block. SUGGESTION
// keeps its own 🔵 so hygiene stays distinct from a real-but-not-blocking
// WARNING (or a demoted CRITICAL). Does not change what was found; the
// hunter's severity word still sits in the header after the tier.
export function scanAidEmoji(
  finding: Pick<Finding, "severity" | "tier">,
): string {
  if (finding.tier === "blocking") return "🔴";
  if (finding.severity === "SUGGESTION") return "🔵";
  return "🟡";
}

// Priority order for the summary's compact index (Juanma: "priority ordering
// actually works" here — inline comments themselves sort by GitHub's own
// file/line order, not ours). Lower rank sorts first.
function severityRank(severity: Severity): number {
  switch (severity) {
    case "BLOCKER":
      return 0;
    case "CRITICAL":
      return 1;
    case "WARNING":
      return 2;
    case "SUGGESTION":
      return 3;
  }
}

const LEAD_IN_MAX = 100;

// A short, single-line preview of a finding's claim for the summary's
// index — the claim's full text belongs on the finding's own comment, not
// duplicated here (the ROADMAP B6 "one finding, one place" decision this
// index partially reinstates — see renderPrComment's own WHY). Truncates at
// a word boundary so the ellipsis never lands mid-word.
function leadIn(claim: string): string {
  const text = oneLine(claim);
  if (text.length <= LEAD_IN_MAX) return text;
  const truncated = text.slice(0, LEAD_IN_MAX);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut}…`;
}

// What a live row prints where its claim would go when there is no claim to
// print. A prior rebuilt from a posted `<!-- pr-hero-finding -->` marker
// carries none: the marker never stored one, and `priorsFromPostedMarkers`
// (rereview/prepare.ts) sets `claim: ""` DELIBERATELY so `claimFingerprint("")`
// — the single constant every claim-less prior shares — can never act as a
// tie-break in prior→comment matching (that module's WHY at :534, :570-578
// and :736-745). That limitation is intentional and stays; what was broken is
// the RENDER. `leadIn("")` returns "", so the row printed its separator with
// nothing after it — "- `carried` 🟡 `src/wizard.ts:721` —  (R002)" on PR
// #179's second review — which reads as a finding whose description is empty
// rather than one whose claim this surface simply cannot recover. Italic, so
// it cannot be mistaken for the claim itself, and it says nothing about
// status or severity: those are on the same line and are known. The reader
// keeps the location and the id, and the finding's OWN comment — the thing
// the marker was parsed out of — does carry the claim.
const CLAIM_UNAVAILABLE =
  "_claim text unavailable; see this finding's own comment on the PR_";

// `leadIn` is left alone on purpose: every non-empty claim renders exactly as
// it did, byte for byte.
function liveClaimText(claim: string): string {
  const text = leadIn(claim);
  return text === "" ? CLAIM_UNAVAILABLE : text;
}

// The summary's one-line-per-finding index (Juanma's PR #2 feedback item 1:
// the earlier "one finding, one place" decision stripped this list entirely,
// leaving counts + delta + footer — on first contact that reads as empty).
// This partially reverses that decision, but the coherence obligation it
// reinstates is much smaller than the pre-B6 shape: a ONE-LINE index plus
// links, not a duplicated claim/evidence body, and the delta already had to
// be correct. `commentUrlByFindingId` is absent (or a finding's id is
// missing from it) before ids exist — the FIRST render of a freshly created
// summary, before any per-finding comment has been posted — in which case
// the line renders without a link; the closing PATCH (cli.ts) supplies the
// map once posting has happened.
function findingIndexLines(
  findings: Finding[],
  commentUrlByFindingId: ReadonlyMap<string, string> | undefined,
): string[] {
  const sorted = [...findings].sort((a, b) => {
    const rankDiff = severityRank(a.severity) - severityRank(b.severity);
    if (rankDiff !== 0) return rankDiff;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
  return sorted.map((f) => {
    const loc = code(`${f.path}:${f.line}`);
    const url = commentUrlByFindingId?.get(f.id);
    const locRef = url === undefined ? loc : `[${loc}](${url})`;
    return `${scanAidEmoji(f)} ${locRef} — ${leadIn(f.claim)}`;
  });
}

// The PR-comment renderer (ROADMAP B2): the same findings document, shaped
// for a public GitHub comment instead of a run artifact. Pure for the same
// reason renderReport is — a posted comment must be re-renderable from the
// artifact and come out identical.
//
// Deliberately SPARSER than report.md: NO cost, NO token counts, no
// telemetry of any kind — the engine's internal economics never reach a
// public comment.
//
// The first line is the pr-hero marker carrying doc.head_sha: postPrComment
// (pr/pr.ts) finds the previous comment by the marker PREFIX and updates it in
// place, so this renderer and that finder share one contract and posting
// stays idempotent — while the declared head lets the watch guard (B3) tell
// which head a posted comment covers.
//
// The summary line (not the footer) names the exact range reviewed:
// doc.base_sha IS the diff-from commit — the recorded rule in cli.ts.
//
// `repoWebUrl` (e.g. https://github.com/org/repo) turns locations into
// links pinned to doc.head_sha. It is OPTIONAL and cosmetic by contract:
// absent, the comment renders as plain code spans, byte-identical to the
// linkless shape — the renderer stays offline-testable and a posted comment
// stays re-renderable from the artifact alone.
//
// ROADMAP B6 reshape, W2 (issues #16/#17): the index stays one-liners;
// anchorable findings live on the review; un-anchorable (and 422-demoted)
// findings render their full body in this summary's Comments Outside Diff
// section — Greptile-shaped, never as standalone issue comments. `delta`
// may be absent — a caller with no prior-state knowledge (or a same-run
// first post) still gets a valid comment, just without the delta line —
// but the PARAMETER itself is REQUIRED, not optional (PR2 verification
// WARN-3, same fix shape as `consumedCommentIds` on `postPrReview`,
// a3b3d3a): an optional third argument is one a PR3 wiring call can
// simply forget, and the summary would then render silently without the
// delta line spec R13 requires. `delta: PrCommentDelta | undefined`
// forces every call site to say so explicitly, so the type system — not a
// missed review comment — catches the omission.
// `outsideDiffFindings` is the same WARN-3 shape: REQUIRED, not optional.
// An optional fourth argument is one a caller can forget, and the summary
// would then silently omit the Outside Diff bucket those findings reached.
// Pass `[]` when there are none — the section is omitted only when the
// array is empty, never because a call site skipped the argument.
// `commentUrlByFindingId` stays the last, OPTIONAL parameter (ROADMAP B6
// rework, Juanma's PR #2 feedback): a finding id → its own posted
// review-comment URL, so the index above can link straight to it. Absent
// on the summary's FIRST creation (pr/pr.ts creates the summary BEFORE any
// per-finding comment exists, to fix its position in the PR timeline —
// see pr/pr.ts's postInlineFindings WHY) and present on the closing PATCH
// once posting finished. Un-anchorable findings have no review-comment
// URL; their index line stays unlinked and the bucket below has the full
// body. A caller that omits the map gets a correct, link-free index —
// never a broken or empty one — so this stays additive, unlike `delta`
// and `outsideDiffFindings` above: a missing link map degrades the
// index's usefulness, it does not make the comment lie.
//
// `movedHeadSha` (GitHub #39) is REQUIRED `string | undefined`, on `delta`'s
// side of that dividing line rather than `commentUrlByFindingId`'s, and it
// sits BEFORE the link map so the type system says so. It is the PR's head
// as GitHub reported it moments before posting, and it is set ONLY on a
// confirmed mismatch with `doc.head_sha` — the caller does the comparison
// once (pr/pr.ts's postInlineFindings) so two surfaces cannot derive two
// different answers from it, and this renderer is dumb: present means moved,
// absent means unmoved OR unverifiable. An issue-mandated element whose
// omission is SILENT is exactly the argument that made `delta` required; a
// caller that forgot this one would publish a comment about code the PR no
// longer has, with nothing on the page saying so.
export function renderPrComment(
  doc: FindingsDocument,
  repoWebUrl: string | undefined,
  delta: PrCommentDelta | undefined,
  outsideDiffFindings: readonly Finding[],
  movedHeadSha: string | undefined,
  commentUrlByFindingId?: ReadonlyMap<string, string>,
  // S4: the footer's disclaimer follows the gate mode. Omitted means advisory,
  // the wording every caller has today, until a caller passes its mode.
  ciMode: CiMode = "advisory",
  // S1b: Outside Diff entries at this index and after render compact (the
  // linked location only). WHY an index and not a flag: the size fallback
  // compacts from the last entry backwards, one entry at a time, until the
  // body fits. Omitted or past the end, the section is byte-identical.
  compactFrom?: number,
): string {
  // Normalize away one trailing slash so `gh repo view` output and a
  // hand-typed URL build the same links.
  const webUrl = repoWebUrl?.endsWith("/")
    ? repoWebUrl.slice(0, -1)
    : repoWebUrl;
  // Counted by SEVERITY, not tier (Juanma's PR #2 feedback item 3: the old
  // tier-based "0 blocking · 2 advisory" headline hid that both findings
  // were actually CRITICAL, just downgraded — the exact contradiction that
  // made "CRITICAL (advisory)" read as a bug on the finding body itself).
  // SUGGESTION is deliberately excluded from the headline, mirroring the
  // two-bucket 🔴/🟡 shape Juanma specified — a SUGGESTION still appears in
  // the index below, just not double-counted in the headline.
  const liveRows = delta?.rereview?.live ?? [];
  const liveForHeadline = liveRows.filter((row) => row.status !== "suppressed");
  const headlineSev = [
    ...doc.findings.map((f) => f.severity),
    ...liveForHeadline.map((row) => row.sev),
  ];
  const critical = headlineSev.filter(
    (sev) => sev === "BLOCKER" || sev === "CRITICAL",
  ).length;
  const warning = headlineSev.filter((sev) => sev === "WARNING").length;
  // #206: a carried prior whose real severity could not be recovered must
  // never fall into `warning` by default — that IS the bug (a live BLOCKER
  // rendering as "0 critical · 1 warning"). It also must not vanish from the
  // headline entirely: silence here would just move the undercount from
  // "wrong bucket" to "no bucket", still hiding that something needs a
  // human's eyes. So it gets its own headline term instead.
  const severityUnavailable = headlineSev.filter(
    (sev) => sev === SEVERITY_UNRECOVERABLE,
  ).length;
  const headSha8 = code(doc.head_sha.slice(0, 8));
  const headRef =
    webUrl === undefined
      ? headSha8
      : `[${headSha8}](${webUrl}/commit/${doc.head_sha})`;
  // The marker keeps carrying the REVIEWED head, never `movedHeadSha`
  // (GitHub #39): the watch guard (B3) reads this marker to learn which head
  // a posted comment covers, and writing the CURRENT head here would tell the
  // watcher that the new head was reviewed — the same silent lie the pin and
  // the notice below exist to kill, just relocated into the machine-readable
  // half of the comment.
  // Rereview-coverage fix: a PARTIAL run's marker carries the
  // coverage=partial token so the NEXT `pr-hero review --pr N` can tell (via
  // parsePrCommentMarker) that this run never finished and must not trust
  // L===H the way a clean case B/C would. A COMPLETE run's marker stays
  // byte-identical to before — the self-healing property: a forced-full
  // re-run that is ITSELF partial writes coverage=partial again, so coverage
  // stays forced until a run actually completes.
  const out: string[] = [
    prCommentMarker(doc.head_sha, doc.run_status !== "partial"),
  ];
  out.push("## pr-hero review");
  out.push("");
  // GitHub #39, and it goes FIRST — above the #42 incompleteness notice and
  // therefore above everything. The two notices qualify different things and
  // the order follows the scope of what they qualify: this one says WHICH
  // CODE the whole comment describes (the coverage sentence below included),
  // #42's says how much of that code was actually looked at. A reader who
  // learns on line 9 that the counts are a floor, and only on line 12 that
  // they were computed against a commit the PR no longer points at, has read
  // the two in the wrong order.
  //
  // Set only on a CONFIRMED mismatch (cli.ts re-reads the head immediately
  // before posting and compares once). Unmoved and unverifiable both render
  // nothing, and neither is a lie: the headline below names the reviewed sha
  // outright and never claims it is current, so silence here says "nothing
  // to add", not "this is the head".
  if (movedHeadSha !== undefined) {
    out.push(
      "⚠️ **The PR moved while this review ran.** The comments are pinned to " +
        "the commit that was reviewed, so GitHub will mark them outdated as " +
        "the lines move; they are not a statement about the current head.",
    );
    out.push("");
    out.push(movedHeadSentence(doc.head_sha, movedHeadSha, code));
    out.push("");
  }
  if (delta?.rereview?.case === "D") {
    out.push(
      "⚠️ **Last reviewed head is not an ancestor of this head.** " +
        "Reviewing the full PR range (force-push / rebase / amend).",
    );
    out.push("");
  }
  if ((delta?.rereview?.capped ?? 0) > 0) {
    out.push(
      `⚠️ **${delta?.rereview?.capped} prior finding(s) not verified:** ` +
        "verification cap (`max_verification_steps`) bound this run (a dismissed or deferred one keeps its triage); " +
        "`--yes` does not bypass it.",
    );
    out.push("");
  }
  // GitHub #42. The defect: a run where SOME agents died and the survivors
  // found nothing posted "🔴 0 critical · 🟡 0 warning" followed by a ✅ clean
  // bill, and the only trace of the incompleteness was the word `partial`
  // inside the <sub> footer at the very bottom. A reader takes a green check
  // at face value; nobody audits a footer.
  //
  // So the notice goes ABOVE the counts, not below them and not in the
  // footer: the counts are the thing being qualified, and a qualifier a
  // reader meets after the number it qualifies has already done its damage.
  //
  // The decision the issue left open — should such a run post at all — is
  // POST (Juanma, ROADMAP-DOORDASH M1): "post, stating the incompleteness and
  // naming the hunters that did not run — visible noise beats invisible
  // loss". Direction of error: posting nothing hides that a review was even
  // attempted, and an invisible loss is the failure this project's own rule
  // ranks worst; a loud incomplete notice is merely noisy, and noise can be
  // read and dismissed. The two extremes stay where they were — every agent
  // dead is `sessionFailed` and never posts (cli.ts), a complete run keeps
  // its ✅ untouched. This is the middle case only.
  //
  // Unconditional on `partial`, NOT gated on zero findings: a partial run
  // that found three things is also reporting a floor, not a verdict. The
  // zero-findings branch below is only where the ✅ has to be replaced.
  if (doc.run_status === "partial") {
    out.push(
      "⚠️ **This review is incomplete.** At least one agent did not finish, " +
        "so the counts below are a floor, not a verdict: whatever the " +
        "missing agents would have found is missing with them.",
    );
    out.push("");
    out.push(coverageSentence(doc, code));
    out.push("");
  }
  out.push(
    `🔴 ${critical} critical · 🟡 ${warning} warning` +
      (severityUnavailable > 0
        ? ` · ⚠️ ${severityUnavailable} severity unavailable`
        : "") +
      ` — ${headRef}, diff from ${code(doc.base_sha.slice(0, 8))}`,
  );
  out.push("");
  if (doc.summary !== undefined) {
    out.push(...summaryLines(doc.summary));
    out.push("");
  }
  if (doc.findings.length === 0) {
    // The ✅ is a statement about COVERAGE, not about the findings array: it
    // claims every hunter looked and nobody found anything. On a partial run
    // that claim is false, so the glyph is withdrawn and the line points back
    // at the notice above rather than leaving the body to jump from a zero
    // count straight to the footer (GitHub #42).
    //
    // Item 7 C7: zero new findings is also not a clean bill when priors
    // remain live (carried / unconfirmed / deferred / suppressed) or this
    // run returned / re-tiered a prior. MatchResult.resolved cannot say so.
    out.push(cleanBillLine(doc.run_status, delta?.rereview));
    out.push("");
  } else {
    out.push(...findingIndexLines(doc.findings, commentUrlByFindingId));
    out.push("");
  }
  out.push(...liveFindingLines(delta?.rereview));
  if (outsideDiffFindings.length > 0) {
    out.push(
      ...outsideDiffSection(
        outsideDiffFindings,
        doc.head_sha,
        webUrl,
        compactFrom,
      ),
    );
    out.push("");
  }
  // Omit the "since <sha>" clause when the previous head equals the current
  // one (Juanma's PR #2 feedback: "Δ since f933fda8" printed on head
  // f933fda8 is noise) — a re-run on an unchanged head, not a genuinely
  // absent prior state (which deltaLine already renders bare).
  const normalizedDelta =
    delta && delta.previousHeadSha === doc.head_sha
      ? { ...delta, previousHeadSha: undefined }
      : delta;
  if (normalizedDelta) {
    out.push(deltaLine(normalizedDelta));
    out.push("");
  }
  out.push("---");
  out.push("");
  // The footer keeps the report's public register: a comment that says
  // "blocking" without the not-a-merge-gate sentence would overstate the
  // tool's own contract. Comment voice: no em dashes in prose — the
  // disclaimer joins with a colon.
  out.push(
    `<sub>run ${doc.run_status} · ${engineLabel(doc)} · ${commentDisclaimer(ciMode)}</sub>`,
  );
  return `${out.join("\n").trimEnd()}\n`;
}

function liveFindingLines(rereview: RereviewDelta | undefined): string[] {
  if (rereview === undefined) return [];
  const out: string[] = [];
  if (rereview.worsened !== undefined && rereview.worsened.length > 0) {
    for (const hit of rereview.worsened) {
      out.push(
        `returned ${hit.priorId}: ${hit.priorSev} → ${hit.discoverySev}`,
      );
    }
    out.push("");
  }
  const listed = (rereview.live ?? []).filter(
    (row) => row.status !== "suppressed",
  );
  if (listed.length > 0) {
    out.push("Still live:");
    for (const row of listed) {
      const loc = row.locs[0] ?? row.id;
      // #206: never run an unrecoverable severity through severityEmoji —
      // its 4-case switch has no branch for the sentinel, and reusing 🟡 by
      // accident is exactly the silent downgrade this issue is about. A
      // distinct glyph AND word, never one of 🔴/🟡/🔵, so the row cannot be
      // mistaken for a real (if low) severity.
      const badge =
        row.sev === SEVERITY_UNRECOVERABLE
          ? "⚠️ severity unavailable"
          : severityEmoji(row.sev);
      out.push(
        `- \`${row.status}\` ${badge} \`${loc}\` — ${liveClaimText(row.claim)} (${row.id})`,
      );
    }
    out.push("");
  }
  if (rereview.suppressed > 0) {
    out.push(
      `${rereview.suppressed} finding${rereview.suppressed === 1 ? "" : "s"} suppressed.`,
    );
    out.push("");
  }
  return out;
}

function rereviewIsClean(rereview: RereviewDelta | undefined): boolean {
  if (rereview === undefined) return true;
  return (
    rereview.unconfirmed === 0 &&
    rereview.carried === 0 &&
    rereview.deferred === 0 &&
    rereview.suppressed === 0 &&
    rereview.returned === 0 &&
    rereview.reTiered === 0
  );
}

// Shared by both non-clean cleanBillLine branches below (the ordinary
// re-review one and the skipped-discovery one, GitHub #166) so the two
// wordings can never drift on what "live" means.
function liveBits(rereview: RereviewDelta): string[] {
  const bits: string[] = [];
  if (rereview.carried > 0) bits.push(`${rereview.carried} carried`);
  if (rereview.unconfirmed > 0)
    bits.push(`${rereview.unconfirmed} unconfirmed`);
  if (rereview.deferred > 0) bits.push(`${rereview.deferred} deferred`);
  if (rereview.suppressed > 0) bits.push(`${rereview.suppressed} suppressed`);
  if (rereview.returned > 0) bits.push(`${rereview.returned} returned`);
  if (rereview.reTiered > 0) bits.push(`${rereview.reTiered} re-tiered`);
  return bits;
}

// pr-hero review #286 finding: `discoverySkippedEmptyDelta` alone cannot say
// WHY discovery is empty, and "no changes" was flatly wrong for the OTHER
// reason it can be set — a real, non-empty delta whose every file was
// excluded by the size gate / `.prheroignore` (`filterDiffByIgnoreRules`'s
// `droppedPaths`, threaded as `discoveryExcludedPaths`). This picks the
// sentence the data actually supports; it never says "nothing changed" when
// something plainly did.
function discoverySkipSentence(rereview: RereviewDelta): string {
  if (rereview.discoverySkipReason === "all_excluded") {
    const paths = rereview.discoveryExcludedPaths ?? [];
    const named = paths.length > 0 ? ` (${listPaths([...paths])})` : "";
    return `Every changed file was excluded from review${named}, so the effective diff is empty.`;
  }
  return "No changes since the last review of this head.";
}

// GitHub #166, corrected by pr-hero review #286: a re-review whose discovery
// skipped for lack of anything new (case B's same head, or case C's
// restricted delta touching none of the PR's own files — or, per the
// sentence above, a real delta excluded entirely) ran ZERO DISCOVERY
// hunters — the two branches below both describe what a review CONCLUDED,
// and this run concluded nothing from discovery; it never looked. That is
// still all this function may claim:
//
// - it must never say "hunter" unqualified, since a VERIFIER can still run
//   in the same pass (case B's `applied`/`case_b_reply` triggers, case C's
//   `touched()` — rereview/classify.ts) and did not run zero of anything;
// - it must never claim what "the last review reported" — this run only
//   ever reads the CARRIED state (`rereview.live[]` and `verifiedGone`), not
//   the last review's own content, so every sentence stays grounded in that;
// - `verifiedGone` (review #286's third finding) MUST gate the "nothing to
//   report" framing: `rereviewIsClean` alone ignores it, and a run whose
//   verifier resolved every prior this pass is not "nothing happened" — it
//   is a resolution, and erasing it would repeat the same class of false
//   clean bill #166 reported in the first place.
function skippedDiscoveryCleanBillLine(rereview: RereviewDelta): string {
  const sentences: string[] = [
    discoverySkipSentence(rereview),
    "No discovery hunter ran this pass.",
  ];
  if (rereview.verifiedGone > 0) {
    sentences.push(
      `${rereview.verifiedGone} prior finding${rereview.verifiedGone === 1 ? "" : "s"} ` +
        "resolved (verified) this pass.",
    );
  }
  const bits = liveBits(rereview);
  if (bits.length > 0) {
    sentences.push(`Still live: ${bits.join(" · ")}.`);
  }
  if (sentences.length === 2) {
    sentences.push("No live findings are carried from the previous review.");
  }
  return sentences.join(" ");
}

function cleanBillLine(
  runStatus: FindingsDocument["run_status"],
  rereview: RereviewDelta | undefined,
): string {
  if (runStatus === "partial") {
    return (
      "The agents that completed reported nothing. That is not a clean " +
      "bill: read it against the coverage above."
    );
  }
  if (rereview?.discoverySkippedEmptyDelta === true) {
    return skippedDiscoveryCleanBillLine(rereview);
  }
  if (!rereviewIsClean(rereview) && rereview !== undefined) {
    return `No new findings this delta. Live: ${liveBits(rereview).join(" · ")}.`;
  }
  return "✅ pr-hero reviewed this PR and found nothing to report.";
}

function deltaLine(delta: PrCommentDelta): string {
  const since =
    delta.previousHeadSha === undefined
      ? "Δ"
      : `Δ since ${code(delta.previousHeadSha.slice(0, 8))}`;
  if (delta.rereview !== undefined) {
    const r = delta.rereview;
    const parts: string[] = [];
    if (r.verifiedGone > 0) {
      parts.push(`${r.verifiedGone} resolved (verified)`);
    }
    parts.push(`${r.unconfirmed} unconfirmed`);
    parts.push(`${r.carried} carried`);
    parts.push(`${r.deferred} deferred`);
    parts.push(`${r.new} new`);
    return `${since}: ${parts.join(" · ")}`;
  }
  return `${since}: ${delta.resolved} resolved · ${delta.new} new · ${delta.persist} persist`;
}

// The re-review closing comment (pr/pr.ts's postInlineFindings): a short,
// NEW issue comment posted after the summary's closing PATCH. The summary is
// edited in place on a re-review, and an edit is invisible on GitHub (no
// notification, no move down the timeline), so without this a clean
// re-review looked exactly like a run that never happened. The delta line is
// the summary's own `deltaLine`, so the two comments cannot disagree on the
// numbers.
export function renderRereviewClosedComment(input: {
  headSha: string;
  delta: PrCommentDelta;
  // Findings this pass actually published (fresh review comments plus fresh
  // Outside Diff entries). NOT the delta's `new`: on a re-review that number
  // is the discovery count and includes findings that persisted onto an
  // existing comment, so a sentence built from it could say "no new" right
  // under a delta line that says "1 new".
  newPosted: number;
  // Every finding this pass reported, posted or kept.
  totalFindings: number;
  runStatus: RunStatus;
  summaryUrl: string | undefined;
}): string {
  const sha = code(input.headSha.slice(0, 8));
  const complete = input.runStatus === "complete";
  // The heading is what the notification and the timeline preview show, so
  // a partial pass never gets the green "complete": the summary already
  // refuses a clean bill to a partial run (issue #42), and this comment must
  // not hand one back.
  const lines = [
    `${PR_REREVIEW_CLOSED_MARKER_PREFIX}head=${input.headSha} -->`,
    complete
      ? `### ✅ pr-hero re-review complete — ${sha}`
      : `### ⚠️ pr-hero re-review finished with partial coverage — ${sha}`,
    "",
  ];
  if (!complete) {
    lines.push(
      "⚠️ Partial coverage: some review steps failed, so this pass may have missed findings.",
      "",
    );
  }
  lines.push(deltaLine(input.delta), "");
  if (input.newPosted > 0) {
    lines.push(`${input.newPosted} new finding(s) posted in this pass.`);
  } else if (input.totalFindings > 0) {
    lines.push(
      "Nothing new was posted in this pass; findings already on the PR were kept.",
    );
  } else if (complete) {
    lines.push("No findings in this pass.");
  } else {
    lines.push("No findings reported by the steps that completed.");
  }
  lines.push(
    "",
    input.summaryUrl === undefined
      ? "The summary comment above was updated."
      : `The summary comment was updated: [view summary](${input.summaryUrl})`,
  );
  return `${lines.join("\n")}\n`;
}

// Greptile-shaped bucket (issues #16/#17): un-anchorable and 422-demoted
// findings live HERE, inside the one summary, never as `POST .../issues/<n>/comments`.
// Rendered only when N>0. Full per-finding body (header, blob-linked location,
// claim, tier explanation, evidence, prompt-to-fix) — the same shape as
// renderIssueFindingComment minus the finding marker (that marker would make
// fetchPostedFindingComments treat this summary as a finding comment) and
// minus the "Posted as a standalone comment" footer (#17's smell).
function outsideDiffSection(
  findings: readonly Finding[],
  headSha: string,
  webUrl: string | undefined,
  compactFrom: number | undefined,
): string[] {
  const out: string[] = [`### Comments Outside Diff (${findings.length})`, ""];
  for (const [i, finding] of findings.entries()) {
    if (i > 0) out.push("");
    // A compact entry keeps only its tier and linked location: no claim,
    // evidence, or prompt-to-fix body. WHY the tier stays: without it a reader
    // (or the sandbox's report parser) cannot tell a compacted blocking entry
    // from an advisory one.
    if (compactFrom !== undefined && i >= compactFrom) {
      out.push(
        `${scanAidEmoji(finding)} ${finding.tier} · ` +
          findingLocationLine(finding, headSha, webUrl, true),
      );
      continue;
    }
    out.push(...findingBodyLines(finding, headSha, webUrl, true));
  }
  return out;
}

// Per-finding comment bodies (ROADMAP B6, reworked per Juanma's PR #2
// feedback items 2-5). Every posted finding — anchored inline or standalone
// — carries the pr/preflight.ts identity marker as its FIRST line, mirroring
// prCommentMarker's own contract, so a second run can tell "already posted"
// from "new" (pr/inline.ts's matcher) without ever touching dedupe_key or
// root_cause_id. Deliberately as sparse as renderPrComment on economics: no
// cost, no tokens, nothing internal.
//
// Shape (both renderers, `linkLocation` is the only structural difference —
// see below):
//   <marker>
//
//   🔴 blocking · CRITICAL · introduced · lifecycle
//   `path:line` — symbol()
//
//   <claim, as a single unbroken-but-readable paragraph — item 5: "es solo
//   texto y no se entiende bien" was the old five-line wall>
//
//   ⚖️ Downgraded to advisory — the refuter returned `downgraded-latent`
//      (only when tier disagrees with severity — item 3/4)
//
//   <details>Evidence (N)</details>
//   <details>Prompt to fix with AI</details>
function findingHeaderLine(finding: Finding): string {
  return (
    `${scanAidEmoji(finding)} ${finding.tier} · ${finding.severity} · ` +
    `${finding.causal_disposition} · ${finding.hunter}`
  );
}

function findingLocationLine(
  finding: Finding,
  headSha: string,
  webUrl: string | undefined,
  linkLocation: boolean,
): string {
  const loc = code(`${finding.path}:${finding.line}`);
  const linked =
    linkLocation && webUrl !== undefined
      ? `[${loc}](${blobUrl(webUrl, headSha, finding.path, `L${finding.line}`)})`
      : loc;
  // A POSITIVE type test, not `=== undefined`. Defence in depth: the draft and
  // artifact validators now normalise a null symbol away, so this should be
  // unreachable — but the old `=== undefined` guard let `"symbol": null` walk
  // straight into oneLine() and the TypeError killed a POST the pipeline had
  // already billed $3.77 for (PR #50, 2026-08-23). A renderer that throws
  // loses paid work; one that renders loses a symbol. oneLine() itself is
  // deliberately left strict — hardening it would mask this class everywhere.
  // Empty strings fall to the same branch, which drops the trailing "— ".
  return typeof finding.symbol === "string" && finding.symbol.length > 0
    ? `${linked} — ${oneLine(finding.symbol)}`
    : linked;
}

// Item 3/4 (Juanma's PR #2 feedback): "CRITICAL (advisory)" on screen with no
// explanation reads as a contradiction, and `causal_disposition` was never
// shown anywhere. This line closes both — but ONLY when severity and tier
// actually disagree (a CRITICAL/BLOCKER landed advisory); printing it when
// they agree would be a tautology ("CRITICAL, still CRITICAL"). Mirrors
// deriveTier's own gate (review/findings.ts): only BLOCKER/CRITICAL can ever
// disagree with their tier, since every other severity is advisory by
// definition and never needs explaining.
function tierExplanationLines(finding: Finding): string[] {
  const isBlockerClass =
    finding.severity === "BLOCKER" || finding.severity === "CRITICAL";
  if (!isBlockerClass || finding.tier !== "advisory") return [];
  const lines = [
    "⚖️ Downgraded to advisory — the refuter returned " +
      `\`${finding.refuter_verdict}\``,
  ];
  // `downgraded-latent` is the one verdict with a documented, human-legible
  // meaning worth spelling out inline (review/findings.ts's own WHY comment on the
  // type): a real defect the refuter could not currently trigger. The other
  // verdicts that can also land here (`inconclusive`; `not_submitted`, either
  // unrefuted-inferential or demoted because the run was truncated before the
  // refuter leg ran; or an `insufficient` evidence_class regardless of
  // verdict) have no equally short gloss, so they render with just the verdict
  // name rather than a guessed one.
  if (finding.refuter_verdict === "downgraded-latent") {
    lines.push("   (real, but no live trigger today)");
  }
  return lines;
}

// Item "Prompt to fix with AI" (Juanma's PR #2 feedback): a copy-pasteable
// prompt, not a deep link — Greptile's equivalent hands off to a hosted IDE
// integration this project does not have, and inventing a link to a service
// that does not exist would be worse than omitting the feature.
function promptToFixBlock(finding: Finding): string[] {
  return [
    "",
    "<details><summary>Prompt to fix with AI</summary>",
    "",
    "```",
    `Fix this issue in ${finding.path} at line ${finding.line}:`,
    "",
    oneLine(finding.claim),
    "```",
    "",
    "</details>",
  ];
}

function findingBodyLines(
  finding: Finding,
  headSha: string,
  webUrl: string | undefined,
  linkLocation: boolean,
): string[] {
  const out: string[] = [
    findingHeaderLine(finding),
    findingLocationLine(finding, headSha, webUrl, linkLocation),
    "",
    oneLine(finding.claim),
  ];
  const tierLines = tierExplanationLines(finding);
  if (tierLines.length > 0) {
    out.push("");
    out.push(...tierLines);
  }
  out.push(...evidenceBlock(finding, headSha, webUrl));
  out.push(...promptToFixBlock(finding));
  return out;
}

const FINDING_HEADER_BADGE =
  /^\S+\s+(blocking|advisory)\s+·\s+(BLOCKER|CRITICAL|WARNING|SUGGESTION)\s+·/;

export interface RecoveredFindingBadge {
  sev: Severity;
  tier: Tier;
  claim: string;
}

// #206's recovery path: when a re-review's `pr-hero-state` block cannot
// supply a carried prior's `sev`/`tier`/`claim` (missing, unparseable, or —
// the routine case — a FIRST review never writes one at all, see
// `postInlineFindings`'s `framing === undefined` branch in src/pr/pr.ts),
// the finding's OWN posted comment still carries the truth: `findingMarker`
// signs only the claim's FINGERPRINT, never the claim text itself, but
// `findingBodyLines` above writes the real header/location/claim right
// after it. This is that renderer's exact structural inverse — it does NOT
// re-derive the format independently, so the two cannot silently drift
// apart (see the round-trip test in test/review/report.test.ts).
//
// Deliberately all-or-nothing: `findingBodyLines`' header/location/blank/
// claim order is fixed by construction, so a body that does not match it
// closely enough to recover the header cannot be trusted to have the claim
// in the expected place either. A caller that gets `null` back must not
// invent a value — see rereview/classify.ts's `SEVERITY_UNRECOVERABLE` /
// `TIER_UNRECOVERABLE` sentinels, which exist for exactly this return.
export function parseFindingCommentBadge(
  body: string,
): RecoveredFindingBadge | null {
  if (!body.includes(PR_FINDING_MARKER_PREFIX)) return null;
  const lines = body.split("\n");
  const markerIndex = lines.findIndex((line) =>
    line.startsWith(PR_FINDING_MARKER_PREFIX),
  );
  if (markerIndex === -1) return null;
  let i = markerIndex + 1;
  while (i < lines.length && (lines[i]?.trim() ?? "") === "") i++;
  const headerLine = lines[i];
  if (headerLine === undefined) return null;
  const match = FINDING_HEADER_BADGE.exec(headerLine.trim());
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const tier = match[1] as Tier;
  const sev = match[2] as Severity;
  // findingBodyLines' fixed shape from here: the location line (exactly
  // one, whatever it contains — never parsed, its content is not needed),
  // one blank line, then the claim. Order never varies; only the OPTIONAL
  // blocks after the claim (tier explanation / evidence / prompt) do.
  i++;
  if (lines[i] === undefined) return null;
  i++;
  while (i < lines.length && (lines[i]?.trim() ?? "") === "") i++;
  const claimLine = lines[i];
  if (claimLine === undefined) return null;
  const claim = claimLine.trim();
  if (claim.length === 0) return null;
  return { sev, tier, claim };
}

export function renderInlineComment(
  finding: Finding,
  headSha: string,
  webUrl?: string,
): string {
  const out: string[] = [
    findingMarker({
      path: finding.path,
      line: finding.line,
      headSha,
      claim: finding.claim,
    }),
    "",
    // No link on the location line: GitHub already anchors this comment to
    // the diff line itself, so a self-referential link would be redundant —
    // unlike the un-anchorable twin below, which has no anchor to point at.
    ...findingBodyLines(finding, headSha, webUrl, false),
  ];
  return `${out.join("\n").trimEnd()}\n`;
}

// Kept for postIssueComment (src/pr/pr.ts) and its tests: leftover W1 orphans
// from old runs still have this body shape. New posting (W2, issues #16/#17)
// does not call this — un-anchorable findings go into the summary Outside
// Diff section, which reuses findingBodyLines without the marker or this
// standalone-comment footer (#17's smell).
export function renderIssueFindingComment(
  finding: Finding,
  headSha: string,
  webUrl?: string,
): string {
  const out: string[] = [
    findingMarker({
      path: finding.path,
      line: finding.line,
      headSha,
      claim: finding.claim,
    }),
    "",
    ...findingBodyLines(finding, headSha, webUrl, true),
    "",
    "<sub>Posted as a standalone comment: pr-hero could not anchor this " +
      "finding to a line in the current diff.</sub>",
  ];
  return `${out.join("\n").trimEnd()}\n`;
}

// Shared Evidence <details> block, extracted from the pre-B6
// commentTierSection so both per-finding renderers stay byte-identical on
// the blank-line discipline GitHub requires around <details> markdown.
function evidenceBlock(
  finding: Finding,
  headSha: string,
  webUrl: string | undefined,
): string[] {
  if (finding.proof_refs.length === 0) return [];
  const out: string[] = [
    "",
    `<details><summary>Evidence (${finding.proof_refs.length})</summary>`,
    "",
  ];
  for (const ref of finding.proof_refs) {
    out.push(`- ${renderRef(ref, headSha, webUrl)}`);
  }
  out.push("");
  out.push("</details>");
  return out;
}

// One Evidence bullet. With a web URL, the ref's leading `path:line` /
// `path:start-end` anchor becomes a blob link and the trailing prose stays
// plain text; a ref whose anchor does not parse falls back to the plain
// backtick-guarded rendering — a broken link would be worse than none.
function renderRef(
  ref: string,
  headSha: string,
  webUrl: string | undefined,
): string {
  if (webUrl === undefined) return code(ref);
  const parsed = parseRefAnchor(ref);
  if (parsed === null) return code(ref);
  const fragment =
    parsed.end === undefined
      ? `L${parsed.start}`
      : `L${parsed.start}-L${parsed.end}`;
  const url = blobUrl(webUrl, headSha, parsed.path, fragment);
  const link = `[${code(`${parsed.path}:${parsed.lines}`)}](${url})`;
  return parsed.prose === "" ? link : `${link} ${oneLine(parsed.prose)}`;
}

// Splits one proof_ref into its leading location anchor and trailing prose,
// REUSING extractAnchor (review/root-cause.ts) so the comment and the root-cause
// clustering read the exact same token as "the location" — two parsers for
// one format would drift. On top of the shared token this only checks that
// the line part is numeric (`19` or `19-20`): extractAnchor accepts any
// non-empty text after the colon, but only numbers make a #L fragment.
function parseRefAnchor(ref: string): {
  path: string;
  lines: string;
  start: number;
  end?: number;
  prose: string;
} | null {
  const anchor = extractAnchor([ref]);
  if (anchor === null) return null;
  const colon = anchor.lastIndexOf(":");
  const path = anchor.slice(0, colon);
  const lines = anchor.slice(colon + 1);
  const match = /^(\d+)(?:-(\d+))?$/.exec(lines);
  if (path.length === 0 || match?.[1] === undefined) return null;
  return {
    path,
    lines,
    start: Number(match[1]),
    end: match[2] === undefined ? undefined : Number(match[2]),
    prose: ref.trim().slice(anchor.length).trim(),
  };
}

// Exported for ui/result.ts, the second surface that links a finding to its
// source. Deliberately SHARED rather than re-derived: the markdown report and
// the terminal block must point a reader at the same bytes, and two copies of
// `/blob/<sha>/<path>#<fragment>` is exactly how the pinned line of one
// surface drifts from the other.
export function blobUrl(
  webUrl: string,
  sha: string,
  path: string,
  fragment: string,
): string {
  return `${webUrl}/blob/${sha}/${path}#${fragment}`;
}

function runLines(doc: FindingsDocument, meta: ReportMeta): string[] {
  const { files, insertions, deletions } = meta.diffStat;
  // #173: cash first and unqualified, notional after it and never without its
  // basis spelled out — §8 allows notional in a report "only when clearly
  // labelled", and two bare dollar figures side by side is precisely the
  // mixing it forbids.
  const notional =
    meta.notionalUsd === undefined
      ? ""
      : ` (${usd(meta.notionalUsd)} at list price, not charged)`;
  const lines = [
    `${files} file${files === 1 ? "" : "s"}, +${insertions} −${deletions}` +
      ` · run ${doc.run_status} · ${usd(meta.costUsd)}${notional} · ${duration(meta.wallMs)}`,
  ];
  const excluded = meta.excludedPaths ?? [];
  if (excluded.length > 0) {
    lines.push("");
    lines.push(
      `${excluded.length} file${excluded.length === 1 ? " was" : "s were"} ` +
        `excluded from the reviewed diff: ${excluded.join(", ")}. The counts ` +
        "above, and the diff the hunters read, are after that exclusion " +
        "(`diff.raw.patch` holds the unfiltered diff).",
    );
  }
  const rows = agentRows(doc);
  if (rows.length > 0) {
    lines.push("");
    lines.push(
      `Agents: ${rows.map((r) => `${r.key} ${r.status}`).join(" · ")}`,
    );
  }
  if (!doc.parity_hunter_fired) {
    lines.push("");
    lines.push(
      "The parity hunter did not fire: no changed path matched its trigger.",
    );
  }
  return lines;
}

// Grouping is the entire point of this section. ONE systemic defect reported
// at N call sites is one thing to fix, and a flat list of N findings reads as
// N problems — the same misreading that turns a correct review into an
// apparent precision collapse (see the note on clusterByRootCause). So the
// cluster is the unit of presentation here, and the finding is a site inside
// it.
function section(
  title: string,
  doc: FindingsDocument,
  tier: Tier,
  summary: RootCauseSummary,
): string[] {
  const findings = doc.findings.filter((f) => f.tier === tier);
  const byFinding = rootCauseIdByFinding(summary);
  const anchorById = new Map(summary.clusters.map((c) => [c.id, c.anchor]));
  // Clusters can straddle the tier split (two sites blocking, one advisory).
  // Group WITHIN the section: a section must never claim sites it is not
  // showing, so K counts the sites rendered right here.
  const groups: Array<{ key: string; findings: Finding[] }> = [];
  const index = new Map<string, { key: string; findings: Finding[] }>();
  for (const finding of findings) {
    // A finding the clusterer never placed is its own group, keyed by its own
    // id — an unclustered finding must never fall into a shared bucket.
    const key = byFinding.get(finding.id) ?? `finding:${finding.id}`;
    const existing = index.get(key);
    if (existing) {
      existing.findings.push(finding);
      continue;
    }
    const group = { key, findings: [finding] };
    index.set(key, group);
    groups.push(group);
  }
  const out = [
    `## ${title} (${findings.length} finding${findings.length === 1 ? "" : "s"}` +
      `, ${groups.length} root cause${groups.length === 1 ? "" : "s"})`,
  ];
  if (findings.length === 0) {
    out.push("");
    out.push(`_Nothing ${title.toLowerCase()}._`);
    return out;
  }
  for (const group of groups) {
    out.push("");
    const first = group.findings[0];
    if (!first) continue;
    if (group.findings.length === 1) {
      out.push(...renderSingleton(first));
      continue;
    }
    out.push(
      ...renderFanOut(
        group.findings,
        anchorById.get(group.key) ?? null,
        group.key,
      ),
    );
  }
  return out;
}

function renderFanOut(
  findings: Finding[],
  anchor: string | null,
  clusterId: string,
): string[] {
  const label = anchor === null ? "(no shared anchor)" : code(anchor);
  const out = [
    `### ${clusterId} — ${label}`,
    "",
    `One defect reported at ${findings.length} sites — fix the root cause ` +
      "once and every site below goes with it.",
    "",
  ];
  for (const finding of findings) {
    out.push(
      `- ${finding.id} ${code(`${finding.path}:${finding.line}`)} — ` +
        `${oneLine(finding.claim)} (${finding.severity}, ${finding.hunter})`,
    );
  }
  return out;
}

function renderSingleton(finding: Finding): string[] {
  const symbol = finding.symbol ? ` (${oneLine(finding.symbol)})` : "";
  const out = [
    `### ${finding.id} — ${code(`${finding.path}:${finding.line}`)}${symbol}`,
    "",
    oneLine(finding.claim),
    "",
    `- ${finding.severity} · evidence ${finding.evidence_class} · ` +
      `${finding.causal_disposition} · hunter ${finding.hunter} · ` +
      `refuter ${finding.refuter_verdict}`,
  ];
  if (finding.proof_refs.length === 0) {
    out.push("- Proof: none cited");
    return out;
  }
  out.push("- Proof:");
  for (const ref of finding.proof_refs) out.push(`  - ${oneLine(ref)}`);
  return out;
}

// The audit trail. A finding the engine dropped is invisible in findings[],
// and an invisible drop is an unattributable miss: "no hunter saw it" and "a
// hunter saw it and the refuter killed it" must not look the same to a human
// reading this file.
function notReported(doc: FindingsDocument): string[] {
  const refuted = doc.debug.refuted;
  const deduped = doc.debug.deduped ?? [];
  const out = ["## Not reported", ""];
  if (refuted.length === 0 && deduped.length === 0) {
    out.push("Nothing was refuted, and nothing was merged as a duplicate.");
    return out;
  }
  out.push(
    `${refuted.length} refuted, ${deduped.length} merged as duplicates.`,
  );
  if (refuted.length > 0) out.push("");
  for (const finding of refuted) {
    out.push(
      `- ${finding.id} ${code(`${finding.path}:${finding.line}`)} — ` +
        `${oneLine(finding.claim)} — ${finding.refuter_verdict}`,
    );
  }
  // A severe claim discarded as a duplicate used to leave nothing here but a
  // number, and issue #153 is what that cost: an authorization-bypass BLOCKER
  // was merged into a claim about a DIFFERENT defect and vanished from the
  // report, while debug.deduped[] had recorded it the whole time. A count is
  // not a trace. Advisory losers stay counted only — this exists to make a
  // lost BLOCKER visible, not to reprint every merge.
  //
  // No id: a loser keeps its hunter-assigned draft id, which names nothing a
  // reader can look up, so the location is the anchor.
  const severe = deduped.filter(
    (loser) => loser.severity === "BLOCKER" || loser.severity === "CRITICAL",
  );
  if (severe.length > 0) {
    out.push("");
    for (const loser of severe) {
      out.push(
        `- ${code(`${loser.path}:${loser.line}`)} — ` +
          `${oneLine(loser.claim)} — merged into ${loser.merged_into}`,
      );
    }
  }
  return out;
}

// The engine identity as prose, shared by the report's closing note and the
// PR comment's footer: absent engine info degrades to a name, never a lie.
function engineLabel(doc: FindingsDocument): string {
  return doc.engine
    ? `${doc.engine.name} ${doc.engine.version}`
    : "pr-hero (version not recorded)";
}

// The report's closing note by gate mode. Advisory is today's wording, byte for
// byte. Gate says the report backs the required status, and it does not claim
// the merge is never blocked: under a required check it can be.
function closing(doc: FindingsDocument, ciMode: CiMode): string[] {
  if (ciMode === "gate") {
    return [
      "---",
      "",
      `Generated by ${engineLabel(doc)}. This report backs the pr-hero commit status, ` +
        "the required check in gate mode: every line above is a claim to verify. " +
        "A blocking finding sets that status to failure. Whether it blocks the merge " +
        "is up to branch protection.",
    ];
  }
  return [
    "---",
    "",
    `Generated by ${engineLabel(doc)}. This is an assistant report, not a merge gate: ` +
      'every line above is a claim to verify, and `blocking` means "a human ' +
      'should look before this ships", never "the merge is blocked".',
  ];
}

// The PR comment footer's disclaimer by gate mode, kept in the comment's own
// voice: no em dashes, the disclaimer joins with a colon.
function commentDisclaimer(ciMode: CiMode): string {
  return ciMode === "gate"
    ? "Assistant report backing the pr-hero commit status, the required check in gate mode: every line above is a claim to verify."
    : "Assistant report, not a merge gate: every line above is a claim to verify.";
}

// Hunter-authored text lands inside code spans and list items. A stray
// backtick in a path or proof_ref would break out of its span and mangle
// every line after it, so spans are built here and never by hand.
function code(text: string): string {
  return `\`${oneLine(text).replaceAll("`", "'")}\``;
}

// Claims arrive as free prose and sometimes carry newlines; a raw newline
// inside a list item silently ends the item.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// Elapsed time as the compact `3m12s` the CLI's live progress prefixes onto
// every event line. Floor, never round: 59.9s read as "60s" would tick the
// minute early. Minutes deliberately never roll into hours — a review past
// the hour reading "61m..." is itself information.
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0
    ? `${seconds}s`
    : `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function duration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0
    ? `${seconds}s`
    : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatModelRoute(
  route: ResolvedModelRoute,
  logicalIdentity?: string,
): string {
  const variant = route.modelVariant ? `#${route.modelVariant}` : "";
  const modelName = route.modelSnapshot || route.modelFamily;
  const target = `${route.provider}/${modelName}${variant}`;
  const gateway = route.gateway ?? "direct";
  const dims = `[${gateway}, ${route.backend}]`;
  if (logicalIdentity && logicalIdentity !== target) {
    return `${logicalIdentity} -> ${target} ${dims}`;
  }
  return `${target} ${dims}`;
}

export function formatStepRoute(
  step: ResolvedStepRoute,
  rawLogical?: string,
): string {
  return formatModelRoute(step.route, rawLogical ?? step.logicalIdentity);
}

// The envelope needs ONE model string. With no --model override each agent
// carries its own frontmatter model, so report what actually ran rather than
// inventing a single value: identical models collapse to one name, a mixed
// set is recorded as a mix instead of as a lie.
export function envelopeModel(
  options: { model?: string },
  agentFiles: Map<string, { model?: string }>,
): string {
  if (options.model) return options.model;
  const models = new Set<string>();
  for (const agent of agentFiles.values()) {
    if (agent.model) models.add(agent.model);
  }
  if (models.size === 0) return "unspecified";
  return [...models].sort().join("+");
}
