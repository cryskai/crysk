// Bounded unattended spend (ROADMAP Pillar 3, GitHub Actions CI): the two
// gates that must clear BEFORE a CI run spawns a single agent, and the pure
// CI-mode skip payloads those gates produce when they don't.
//
// Phase 3 additions (this module's scope now covers the whole CI-mode
// policy layer, not just the two spend gates): `planCiSizeSkip`/
// `planCiBudgetSkip` are the ONE call reviewPr's shell makes per gate —
// comment + marker + step-summary markdown + $GITHUB_OUTPUT, all from the
// same numbers, so the shell has no decision left to make beyond "post it /
// write it". `budgetDisabledWarningMessage` covers spec 3.1's disabled-
// ceiling `::warning::` requirement. `ciExitCode` pins the assistant-posture
// exit-code contract (spec 2.1): findings, even blocking ones, never fail
// the job — only a fatal session failure or a genuine posting drop (design
// D6) does.
//
// This module does NOT reimplement the size gate — that gate (deterministic
// line/file counting, exclusion globs, the whole cost-predictability
// rationale) already exists in size-gate.ts and is already wired into local
// review, PR review and the watcher via `sizeGateDisposition`. What CI mode
// needs on top is different: outside CI, an over-limit diff can PROMPT an
// interactive operator or fall back to `--yes`/non-TTY `skip`; inside CI
// there is nobody to prompt AND the run must still exit 0 with a courteous
// PR notice (assistant posture — see proposal.md's Invariants). So this
// module adds exactly that CI-mode handling on top of an already-computed
// `SizeGateVerdict`, plus the budget gate's own threshold check (there is no
// pre-existing budget gate to reuse).
//
// Purity (project rule 1): every function here is a total function of its
// arguments. No file I/O, no `process.env` sniffing, no `log()`, no network,
// no clock. Posting the comment and writing `$GITHUB_STEP_SUMMARY` /
// `$GITHUB_OUTPUT` are impure edges that belong to the CI headless shell
// (Phase 3, src/pr/pr.ts / src/cli.ts) — this module only builds the bytes.
//
// Reuse: `CiSummaryData` (ci/reporter.ts) is the exported contract for the
// step-summary payload. Its `skipped-size`/`skipped-budget` members stay
// UNEXPORTED there by design (see that module's header) — this file names
// them with `Extract<CiSummaryData, { kind: "..." }>` against the exported
// union rather than asking ci/reporter.ts to promote either member. Nothing
// here needed a member exported on its own: an object literal typed against
// the union already type-checks structurally (renderStepSummary's own tests
// construct `CiSummaryData` values in the exact same way), and `Extract`
// gives this module named, narrowed types for its own signatures without
// touching Phase 1's frozen module or its "promote on real need" comment.
// The two skip functions below build their `CiSummaryData` value through the
// SAME code path that also builds the PR comment, so the comment and the
// step summary can never independently drift on the numbers they report.
//
// PR comment marker: design.md's draft proposed a colon-style tag
// (`<!-- pr-hero:skip-size -->`). The convention actually shipped in this
// codebase is hyphenated and namespaced under `pr-hero-<noun>`
// (`PR_COMMENT_MARKER_PREFIX = "<!-- pr-hero-report "`,
// `PR_FINDING_MARKER_PREFIX = "<!-- pr-hero-finding "`,
// `PR_STATE_MARKER_PREFIX = "<!-- pr-hero-state "`,
// `TRIAGE_MARKER_PREFIX = "<!-- pr-hero-triage "` — pr/preflight.ts,
// rereview/state.ts, triage/triage.ts). This module follows the shipped
// convention, not the draft: `<!-- pr-hero-skip-size -->` /
// `<!-- pr-hero-skip-budget -->`. Deliberately WITHOUT a `head=` field —
// unlike `prCommentMarker`, the two `CiSummaryData` skip members this phase
// builds from (already landed in Phase 1) carry no `headSha` at all, and a
// gate skip has no code to anchor a head declaration to. Wiring these
// markers into the idempotent find-or-create flow (`findMarkedCommentId`)
// is Phase 3's job, once a real poster exists to consume them.

import type { CiMode } from "#pr/preflight";
import type { Finding, FindingsDocument } from "#review/findings";
import type { PrCommentDelta } from "#review/report";
import type { SizeGateVerdict } from "#review/size-gate";
import { commandHint, MARKER_OPEN } from "../brand";
import { CliUsageError } from "../errors";
import { envBillsMetered } from "../execution/usage-normalized";
import { CI_REVIEW_COMMENT, ciForceReviewHintLine } from "./force-comment";
import {
  type CiOutputs,
  type CiSummaryData,
  renderStepSummary,
} from "./reporter";
import {
  type CiReviewAdmissionVerdict,
  type CiReviewSkipReason,
  ciAdmissionRemainingBudget,
  ciReviewManualRequiredDetail,
  ciReviewSkipDetail,
} from "./review-admission";
import type { CiReviewPolicyMode } from "./review-policy";
import type { DeltaRiskAssessment } from "./review-risk";
import { OVERRIDE_COMMAND } from "./trigger";

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Budget gate — spec.md 3.1: "If estimated cost exceeds --budget-usd ...".
// The one comparison this module owns outright (no pre-existing gate to
// reuse, unlike size).
// ---------------------------------------------------------------------------

export interface BudgetGateVerdict {
  allowed: boolean;
  // Present only when `allowed` is false — mirrors SizeGateVerdict's own
  // discriminated shape (size-gate.ts) in spirit, kept optional-on-a-flat-
  // object here per the task's own stated signature rather than a second
  // discriminated union for a single string field.
  reason?: string;
}

// Inclusive boundary: a cost exactly AT the ceiling is allowed, matching
// size-gate.ts's own `>` (not `>=`) comparison against its limits.
//
// A non-positive ceiling DISABLES the gate. That is not this module's
// invention — size-gate.ts:20 already settled it for the sibling knobs
// ("<= 0 disables the limit. Both knobs, independently."), and all three
// ship side by side in one action.yml feeding one preflight, so `budget-usd:
// 0` has to mean what `max-changed-lines: 0` means. The external convention
// does cut the other way (a $0 spend cap elsewhere often means "spend
// nothing"), which is why it is written down here rather than assumed.
//
// What settles it is that the failure modes are not symmetric. Read as "no
// ceiling" when the operator meant "spend nothing", being wrong costs one
// visible review, still bounded by the size gate running independently. Read
// as "always skip" when the operator meant "no ceiling", being wrong makes
// pr-hero go dark on every PR while each run still exits 0 green — the same
// shape as a lint gate that checks nothing and passes, which this repo has
// already paid for once (docs/research/scout-design.md:344). A disable is only safe
// when it is loud, so the CI shell warns on a disabled ceiling.
export function evaluateBudgetGate(
  estimatedCostUsd: number,
  budgetUsd: number,
): BudgetGateVerdict {
  if (budgetUsd <= 0) return { allowed: true };
  if (estimatedCostUsd <= budgetUsd) return { allowed: true };
  return {
    allowed: false,
    reason:
      `estimated cost ${usd(estimatedCostUsd)} exceeds the ` +
      `${usd(budgetUsd)} budget ceiling`,
  };
}

// ---------------------------------------------------------------------------
// CI skip payloads — one PR comment + one step-summary payload, built from
// the SAME numbers so the two surfaces can't disagree.
// ---------------------------------------------------------------------------

export interface CiGateSkip {
  // Markdown for the PR comment. Posting it (or not, per `--post`) is the
  // caller's job.
  comment: string;
  // Feeds directly into ci/reporter.ts's `renderStepSummary`.
  summary: CiSummaryData;
}

// Exported (Phase 3): both are legitimate consumers of these exact bytes —
// test/pr/preflight.test.ts's marker-prefix-disjointness registry (proving
// neither collides with PR_COMMENT/PR_FINDING/PR_STATE/TRIAGE, the pattern
// that test already established) and pr/pr.ts's repostMarkedPrComment, which
// keys on the marker so a second CI run on the same still-oversized PR (every
// `synchronize` push) posts a fresh notice at the bottom and deletes the old
// one: never stacked, and never a silent in-place edit. Both are
// self-closing, field-less tags (unlike the four `<!-- pr-hero-<noun> ` +
// trailing-space prefixes above): a skip decision has no code to anchor a
// `head=` declaration to, and no fields to encode — see the module header.
export const SKIP_SIZE_COMMENT_MARKER = `${MARKER_OPEN}skip-size -->`;
export const SKIP_BUDGET_COMMENT_MARKER = `${MARKER_OPEN}skip-budget -->`;
export const SKIP_COVERAGE_COMMENT_MARKER = `${MARKER_OPEN}skip-coverage -->`;
export const MANUAL_REQUIRED_COMMENT_MARKER = `${MARKER_OPEN}manual-required -->`;
// Never posted (planCiExcludedSkip has no comment); kept so the plan shape stays whole.
const SKIP_EXCLUDED_COMMENT_MARKER = `${MARKER_OPEN}skip-excluded -->`;

// Same register as ci/reporter.ts's `skipSizeLines`/`skipBudgetLines` and
// project rule 4 (assistant posture): a gate skip is a courteous notice
// about SPEND, never a verdict on the diff's quality. "Split the PR" reads
// as a practical option, not a correction.
type SkipSizeSummary = Extract<CiSummaryData, { kind: "skipped-size" }>;
type SkipBudgetSummary = Extract<CiSummaryData, { kind: "skipped-budget" }>;
type SkipCoverageSummary = Extract<CiSummaryData, { kind: "skipped-coverage" }>;
type ManualRequiredSummary = Extract<
  CiSummaryData,
  { kind: "manual-required" }
>;

// Same reason as reporter.ts's sizeLimitText: a knob that is off (<= 0) must
// not print as "0 files". Both knobs on keeps the original wording.
function sizeLimitsText(maxLines: number, maxFiles: number): string {
  if (maxLines > 0 && maxFiles > 0) {
    return `max ${maxLines} lines / ${maxFiles} files`;
  }
  const lines = maxLines > 0 ? `max ${maxLines} lines` : "no line limit";
  const files = maxFiles > 0 ? `max ${maxFiles} files` : "no file limit";
  return `${lines} / ${files}`;
}

function buildSizeSkipComment(data: SkipSizeSummary): string {
  const lines = [
    SKIP_SIZE_COMMENT_MARKER,
    "## Crysk review skipped",
    "",
    `⚠️ This diff changes ${data.changedLines} line(s) across ` +
      `${data.changedFiles} file(s), exceeding the configured size gate ` +
      `(${sizeLimitsText(data.maxChangedLines, data.maxChangedFiles)}).`,
    "",
    "Crysk did not run to avoid reviewing an unbounded diff. Split the " +
      "PR or raise `max-changed-lines` / `max-changed-files` to change the " +
      "limit for later pushes.",
    "",
    ciForceReviewHintLine(data.prNumber),
  ];
  return `${lines.join("\n")}\n`;
}

// What a platform repository can do about a budget skip (cryskai/platform#12):
// its workflow listens for `/crysk review` and nothing else, it was never
// scaffolded by `crysk ci init` (so no force workflow, no `budget-usd` input to
// raise), and what a review costs is the model setup chosen in the dashboard.
export const PLATFORM_BUDGET_SKIP_HINT =
  `Comment \`${CI_REVIEW_COMMENT}\` on this pull request to run it anyway. ` +
  "To change what reviews cost, change the model setup in the Crysk dashboard.";

function buildBudgetSkipComment(data: SkipBudgetSummary): string {
  const lines = [
    SKIP_BUDGET_COMMENT_MARKER,
    "## Crysk review skipped",
    "",
    `⚠️ The estimated review cost (${usd(data.estimatedCostUsd)}) exceeds ` +
      `the configured CI budget ceiling (${usd(data.budgetUsd)}).`,
    "",
    ...(data.platformConnected === true
      ? [PLATFORM_BUDGET_SKIP_HINT]
      : [
          "Crysk did not run to stay within the configured `--budget-usd` " +
            "ceiling.",
          "",
          ciForceReviewHintLine(data.prNumber),
        ]),
  ];
  return `${lines.join("\n")}\n`;
}

export interface CiSizeGateSkipInput {
  // Whether this run is in CI headless mode (Phase 3's `isCiEnvironment()`
  // / `--ci`). Outside CI, the existing `sizeGateDisposition` prompt/skip
  // flow (size-gate.ts) already handles an over-limit diff — this function
  // is a no-op there, on purpose, so the two paths cannot both fire.
  isCi: boolean;
  // The already-computed verdict (size-gate.ts's `evaluateSizeGate` /
  // `evaluateSizeGateAggregate`). This module never counts lines or files
  // itself.
  verdict: SizeGateVerdict;
  prNumber: number;
  // The configured ceilings, reported alongside whichever one the verdict
  // actually tripped — a verdict only carries the single `limit` that
  // failed (size-gate.ts), but the summary/comment show both metrics.
  maxChangedLines: number;
  maxChangedFiles: number;
}

// `null` means "nothing to publish": either this isn't a CI run, or the
// gate passed. Callers branch on `=== null`, never on truthiness of a
// partially-built object.
export function ciSizeGateSkip(input: CiSizeGateSkipInput): CiGateSkip | null {
  if (!input.isCi || input.verdict.ok) return null;
  const summary: SkipSizeSummary = {
    kind: "skipped-size",
    prNumber: input.prNumber,
    changedLines: input.verdict.effectiveLines,
    changedFiles: input.verdict.effectiveFiles,
    maxChangedLines: input.maxChangedLines,
    maxChangedFiles: input.maxChangedFiles,
  };
  return { comment: buildSizeSkipComment(summary), summary };
}

export interface CiBudgetGateSkipInput {
  isCi: boolean;
  estimatedCostUsd: number;
  budgetUsd: number;
  prNumber: number;
  // The run came through the Crysk platform (CRYSK_PLATFORM_CONNECTED): the
  // skip names only what applies to a platform repository.
  platformConnected?: boolean;
}

export function ciBudgetGateSkip(
  input: CiBudgetGateSkipInput,
): CiGateSkip | null {
  const verdict = evaluateBudgetGate(input.estimatedCostUsd, input.budgetUsd);
  if (!input.isCi || verdict.allowed) return null;
  const summary: SkipBudgetSummary = {
    kind: "skipped-budget",
    prNumber: input.prNumber,
    estimatedCostUsd: input.estimatedCostUsd,
    budgetUsd: input.budgetUsd,
    ...(input.platformConnected === true ? { platformConnected: true } : {}),
  };
  return { comment: buildBudgetSkipComment(summary), summary };
}

// ---------------------------------------------------------------------------
// Disabled-ceiling warning — spec 3.1: "Because a silent disable is
// indistinguishable from a passing gate, the CI shell MUST emit a
// `::warning::` workflow command noting that the budget ceiling is
// disabled." Only for an EXPLICIT <= 0 — `undefined` (the flag was never
// given) means no ceiling was ever configured, so there is nothing to warn
// about disabling. The shell wraps this message with
// `formatWorkflowCommand("warning", ...)` (ci/reporter.ts); this module only
// decides whether to and builds the text, never the annotation syntax.
// ---------------------------------------------------------------------------

export function budgetDisabledWarningMessage(
  budgetUsd: number | undefined,
): string | null {
  if (budgetUsd === undefined || budgetUsd > 0) return null;
  return (
    "budget-usd ceiling is disabled (<= 0 was configured); estimated cost " +
    "is unconstrained for this CI run. The size gate is resolved " +
    "separately."
  );
}

// ---------------------------------------------------------------------------
// Route-aware ceiling resolution (issue #156). The budget gate compares
// `estimate.high` — a TOKEN-derived figure — against a real-dollar ceiling.
// On a Claude subscription route the real cash cost of a run is $0.00, so the
// shipped $10 default refused to do work over an overrun that cannot happen,
// and a skipped review is indistinguishable from a clean one to anyone
// reading the checks (this module's own doctrine, ~110-115; ci/setup.ts:50-63).
// So: no ceiling by default on a subscription route, the default ceiling on a
// metered one, and an explicit operator value honoured verbatim on either.
// ---------------------------------------------------------------------------

export type CiBillingMode = "subscription" | "metered";

// A non-empty ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN means metered.
// Everything else, including an OAuth token, means subscription.
//
// 2026-09-02, #177: the RULE now lives in `envBillsMetered`
// (execution/usage-normalized.ts) and this function only narrows it into
// `CiBillingMode`. It moved because a SECOND caller appeared — the Claude CLI
// transport, which stamps the billing mode on every usage record it emits —
// and two copies were two chances for the ceiling and the records to disagree
// about whether one run bills. They already had: this gate called an API-key
// route metered while the transport filed that user's real spend as notional
// ("at list price, not charged"), so budget enforcement, which is cash-only,
// saw a $0 ceiling.
//
// ANTHROPIC_AUTH_TOKEN joined the signal in the same move. It was never
// excluded by a decision — the doctrine below never mentions it — and
// `ENV_PASSTHROUGH` (harness.ts) projects it into the child immediately beside
// ANTHROPIC_API_KEY as the same per-token credential class, so the presence rule
// that stood below (retired by S5) already covered it. It cannot reach a run's
// ceiling any more: the action takes Claude credentials only from the CRYSK_CLAUDE_*
// secrets in its crysk-secrets input (S8, U5) and empties the CLI's own variables,
// and the run env (claudeRunEnv) removes ANTHROPIC_AUTH_TOKEN whatever its source.
//
// S5 (2026-11-06) retired the rule that stood here: "the mere PRESENCE of a key keeps
// the ceiling", written while nobody chose which credential billed when both were set
// (the CLI preferred the key, observed on CLI 2.1.312). Now the run chooses: the first
// credential in `credentials.claude` (default subscription, then api_key) that is
// present, once at run start (security/claude-credential.ts). The env this function
// receives is that run's env, which holds the chosen Claude credential and no other,
// so `metered` here means the run uses the API key, and a repo holding both secrets
// with the default order runs on the subscription with no ceiling. A caller that
// passes the raw process env instead gets the old presence answer.
//
// Trimming is load-bearing. An empty value never needed it: `""` is already
// falsy, and it is what the action binds the CLI's Claude variables to and how
// GitHub renders a secret the repository does not have. What the trim catches is
// a WHITESPACE-ONLY value, which is truthy and would otherwise impose a ceiling
// on a subscription route, for a caller that passes a raw env (the run env never
// holds one: claudeCredentialPresence trims the same way and drops it).
// `test/ci/gates.test.ts` asserts both cases separately, and only the
// whitespace ones flip when the trim is removed.
//
// This is deliberately NOT `model/provider-capabilities.ts`'s
// `CLAUDE_CAPABILITY_STATICS.billingMode`, and the two must not be "unified"
// later — but the REASON changed under it, so do not quote the old one.
//
// Until #197 the reason was an ADMISSION hazard: metered →
// `pricingApplicability: "required"` → `tokenPricingAvailable`, which nothing
// could answer for a claude-code route (`pricingReady` was false on both the
// CLI transport and the backend-wide producer, and the bundled table was keyed
// per model) → `pricing_table_missing`, blocking. #197 flipped that flag to
// `true` on the strength of the CLI's own `total_cost_usd`, so a metered
// claude-code route is no longer refused for lack of pricing and the hazard is
// gone.
//
// The separation stands on ownership instead: how a route bills follows from
// which credential it runs on, which is `credentialKindForRoute`'s single
// decision (#161, landed). This one answers a narrower question — "should CI
// impose a spend ceiling?" — and reaches nothing but the ceiling.
//
// `envBillsMetered` carries the matching ADMISSION WIRING paragraph, and it
// is worth reading precisely because #161 changed its shape: this predicate
// now has a SANCTIONED second caller (`credentialKindForRoute`), named
// rather than forbidden, because admission and usage filing must answer from
// the same function or they can disagree about one attempt. What stays
// forbidden is a THIRD caller deriving from env directly instead of going
// through that one decision — this CI gate is not that caller, and never
// should be.
//
// Optional `openCodeBillsMetered` is the OpenCode half of the same ceiling
// question — "could this run invoice?" — ORed beside the Anthropic env
// predicate, never folded into it. `envBillsMetered` stamps Claude CLI
// usage and must stay Anthropic-env-only. Omit the option (or leave it
// undefined/false) and this function stays env-only. The caller derives it
// from the routes the models name (openCodeModelsBillMetered, ci/setup.ts):
// an OpenCode provider bound to an API key can invoice; an auth file that only
// holds providers no model uses cannot (cryskai/platform#12).
export function deriveCiBillingMode(
  env: Record<string, string | undefined>,
  opts?: { openCodeBillsMetered?: boolean },
): CiBillingMode {
  return envBillsMetered(env) || opts?.openCodeBillsMetered === true
    ? "metered"
    : "subscription";
}

export const CI_DEFAULT_METERED_BUDGET_USD = 10;

export interface CiBudgetCeiling {
  // `undefined` means NO ceiling — the gate does not run at all. Distinct from
  // a `0` ceiling, which reaches `evaluateBudgetGate` and is allowed there by
  // the `<= 0` convention; the two arrive by different routes and the shell
  // announces them with different messages.
  budgetUsd: number | undefined;
  source: "operator" | "default-metered" | "unlimited-subscription";
}

// Total over the four cases. `source` exists so the caller can tell the two
// no-ceiling outcomes apart without re-deriving why.
//
// An explicitly configured value is honoured verbatim on ANY route — that is
// how an operator imposes a ceiling on a subscription (`budget-usd: 5`) or
// removes one on a metered route (`budget-usd: 0`, which still reaches
// `budgetDisabledWarningMessage`). The `configured !== undefined` test is what
// keeps 0 and negatives on the operator branch: falling back to a truthiness
// check would swallow the explicit disable and silently reimpose the $10 the
// operator just removed.
export function resolveCiBudgetCeiling(input: {
  configured: number | undefined;
  billingMode: CiBillingMode;
}): CiBudgetCeiling {
  if (input.configured !== undefined) {
    return { budgetUsd: input.configured, source: "operator" };
  }
  if (input.billingMode === "metered") {
    return {
      budgetUsd: CI_DEFAULT_METERED_BUDGET_USD,
      source: "default-metered",
    };
  }
  return { budgetUsd: undefined, source: "unlimited-subscription" };
}

// The loudness half. `unlimited-subscription` produces no ceiling and would
// otherwise be silent, which is the exact shape this module already refuses
// for the `<= 0` case: a disable is only safe when it is loud.
//
// Kept SEPARATE from `budgetDisabledWarningMessage`, and separate in register
// too — a NOTE, not a warning. The operator chose nothing wrong here; they
// configured nothing and the policy resolved. Merging the two would tell
// someone who never set `budget-usd` that they disabled something.
export function budgetUnlimitedNoticeMessage(
  ceiling: CiBudgetCeiling,
): string | null {
  if (ceiling.source !== "unlimited-subscription") return null;
  return (
    "no budget-usd ceiling was applied: this route has no per-token invoice " +
    "credential (a Claude subscription or a free route), so a run draws on " +
    "quota rather than a per-token invoice and the estimated cost is not a " +
    "dollar figure to gate on. The size gate resolves from the route separately. " +
    "Set `budget-usd: <n>` to impose a ceiling anyway."
  );
}

// ---------------------------------------------------------------------------
// Route-aware size limits — the size gate's half of the #156 policy above.
// The size gate is a COST and predictability gate (review/size-gate.ts's own
// header), and on a subscription route a run's cash cost is $0. Skipping the
// largest PRs there saved nothing and left the riskiest changes unreviewed:
// on musive, 20 PRs in two months got no review at all. So, per knob: an
// explicit flag wins; a value in the repo config is left for sizeGateConfig
// to apply; otherwise a subscription route gets no limit (0) and a metered
// route keeps the limits the action used to hard-code.
// ---------------------------------------------------------------------------

// The action's former `max-changed-files` default. Kept for metered routes so
// unsetting the action input changes nothing for anyone who pays per token.
// Lines need no constant: the engine default (DEFAULT_SIZE_GATE, 4000) already
// equals the action's former `max-changed-lines` default.
export const CI_DEFAULT_METERED_MAX_CHANGED_FILES = 50;

export interface CiSizeLimits {
  // `undefined` means "not decided here": sizeGateConfig then applies the
  // repo config value, or the engine default.
  maxChangedLines: number | undefined;
  maxChangedFiles: number | undefined;
  // The knobs THIS policy turned off. Non-empty only on a subscription route,
  // and only for knobs neither the flags nor the repo config set. It feeds the
  // notice below, because a gate that silently stops running is a defect in
  // this module's doctrine.
  defaultedOff: Array<"lines" | "files">;
}

export function resolveCiSizeLimits(input: {
  flags: { maxChangedLines?: number; maxChangedFiles?: number };
  config:
    | { max_changed_lines?: number; max_changed_files?: number }
    | undefined;
  billingMode: CiBillingMode;
}): CiSizeLimits {
  const defaultedOff: Array<"lines" | "files"> = [];
  const knob = (
    flag: number | undefined,
    configured: number | undefined,
    meteredDefault: number | undefined,
    name: "lines" | "files",
  ): number | undefined => {
    if (flag !== undefined) return flag;
    if (configured !== undefined) return undefined;
    if (input.billingMode === "metered") return meteredDefault;
    defaultedOff.push(name);
    return 0;
  };
  const maxChangedLines = knob(
    input.flags.maxChangedLines,
    input.config?.max_changed_lines,
    undefined,
    "lines",
  );
  const maxChangedFiles = knob(
    input.flags.maxChangedFiles,
    input.config?.max_changed_files,
    CI_DEFAULT_METERED_MAX_CHANGED_FILES,
    "files",
  );
  return { maxChangedLines, maxChangedFiles, defaultedOff };
}

// A NOTE, like budgetUnlimitedNoticeMessage: nobody chose anything wrong, but
// a gate that did not run is still announced.
export function sizeGateUnlimitedNoticeMessage(
  limits: CiSizeLimits,
): string | null {
  if (limits.defaultedOff.length === 0) return null;
  const what = limits.defaultedOff
    .map((k) => (k === "lines" ? "changed-lines" : "changed-files"))
    .join(" or ");
  return (
    `crysk size gate: no ${what} limit on a Claude subscription route — ` +
    "a run draws on quota, not a per-token invoice, so large PRs are " +
    "reviewed instead of skipped. Set `max-changed-lines` / " +
    "`max-changed-files` to impose a limit."
  );
}

// ---------------------------------------------------------------------------
// CI skip plan — the ONE call reviewPr's shell makes per gate. Composes
// ciSizeGateSkip/ciBudgetGateSkip's {comment, summary} with renderStepSummary
// (ci/reporter.ts) and the $GITHUB_OUTPUT contract into everything the shell
// needs to publish, so the shell's own job is pure mechanical glue: post
// `comment` under `markerPrefix` if `--post`, append `summaryMarkdown` if
// step-summary is on, append `outputs` if $GITHUB_OUTPUT is set, return 0.
// ---------------------------------------------------------------------------

export interface CiGateSkipPlan {
  comment: string;
  // Fed to pr/pr.ts's postPrComment as its `markerPrefix` — idempotent per gate
  // kind, so a repeat CI run on the same still-failing PR updates the
  // existing skip comment instead of stacking a new one on every push.
  markerPrefix: string;
  summaryMarkdown: string;
  outputs: CiOutputs;
  // False for a skip that never posts a PR comment, even under --post (#317:
  // nothing to review). Absent posts `comment` as every other skip does.
  postsComment?: false;
}

// Spec 1.1's $GITHUB_OUTPUT contract for a skip: no review ran, so every
// finding count is 0 and there is no run dir. `estimatedCostUsd` is 0 for a
// size skip (the gate fires before any cost estimate exists) and the
// estimate that tripped the ceiling for a budget skip — the same number the
// comment and summary already show (this module's own "same numbers"
// doctrine, see the module header).
export function ciGateSkipOutputs(
  status:
    | "skipped-size"
    | "skipped-budget"
    | "skipped-coverage"
    | "skipped-excluded"
    | "manual-required",
  estimatedCostUsd: number,
): CiOutputs {
  return {
    status,
    findings_count: 0,
    blocking_count: 0,
    advisory_count: 0,
    cost_usd_est: estimatedCostUsd,
    run_dir: "",
  };
}

export function planCiSizeSkip(
  input: CiSizeGateSkipInput & { ciMode: CiMode },
): CiGateSkipPlan | null {
  const skip = ciSizeGateSkip(input);
  if (skip === null) return null;
  return {
    comment: skip.comment,
    markerPrefix: SKIP_SIZE_COMMENT_MARKER,
    summaryMarkdown: renderStepSummary(skip.summary, input.ciMode),
    outputs: ciGateSkipOutputs("skipped-size", 0),
  };
}

// #317: every changed file is excluded by the ignore rules, so there is nothing
// to review. Unlike a size or budget skip this is not a review held back, so it
// posts no PR comment: a lockfile-only PR would otherwise collect one per push.
// The step summary and the commit status (admission.ts) say what happened.
export function planCiExcludedSkip(input: {
  prNumber: number;
  excludedPaths: readonly string[];
  ciMode: CiMode;
}): CiGateSkipPlan {
  return {
    comment: "",
    postsComment: false,
    markerPrefix: SKIP_EXCLUDED_COMMENT_MARKER,
    summaryMarkdown: renderStepSummary(
      {
        kind: "skipped-excluded",
        prNumber: input.prNumber,
        excludedPaths: [...input.excludedPaths],
      },
      input.ciMode,
    ),
    outputs: ciGateSkipOutputs("skipped-excluded", 0),
  };
}

export function planCiBudgetSkip(
  input: CiBudgetGateSkipInput & { force: boolean; ciMode: CiMode },
): CiGateSkipPlan | null {
  // CI `--force` is the `/crysk review` comment. It answers "run this one
  // anyway" for every CI skip, including the spend ceiling. Outside that
  // explicit comment the ceiling still holds. Local `--force` never reaches
  // here: the caller only invokes this plan when `isCi` is set.
  if (input.force) return null;
  const skip = ciBudgetGateSkip(input);
  if (skip === null) return null;
  return {
    comment: skip.comment,
    markerPrefix: SKIP_BUDGET_COMMENT_MARKER,
    summaryMarkdown: renderStepSummary(skip.summary, input.ciMode),
    outputs: ciGateSkipOutputs("skipped-budget", input.estimatedCostUsd),
  };
}

const COVERAGE_REASON_LABEL: Record<
  Extract<CiReviewAdmissionVerdict, { action: "skip" }>["reason"],
  string
> = {
  "same-head": "already reviewed at this commit",
  "once-per-pr": "once_per_pr policy allows one automatic review",
  "below-threshold": "prior findings below the re-review score floor",
  "low-risk-delta": "delta touches only low-risk paths",
  stopped: "automatic reviews stopped by a maintainer",
};

function buildCoverageSkipComment(
  data: SkipCoverageSummary,
  reason: CiReviewSkipReason,
): string {
  // A stop is a maintainer's decision, not a score: the score line would
  // blame the push for a skip it did not cause.
  const stopped = reason === "stopped";
  const lines = [
    SKIP_COVERAGE_COMMENT_MARKER,
    "## Crysk review skipped",
    "",
    stopped
      ? "⏸️ A maintainer stopped automatic reviews on this pull request."
      : "⚠️ This push did not justify another review run.",
    "",
    `**${data.detail}**`,
    "",
    stopped
      ? `Attempts on this PR: ${data.reviewCount}/${data.maxAttempts}.`
      : `Prior score: ${data.priorScore} (re-review needs ≥ ${data.minScore}). ` +
        `Attempts on this PR: ${data.reviewCount}/${data.maxAttempts}.`,
    "",
    "The existing review comment still describes the last head Crysk " +
      "reviewed.",
    "",
    ciForceReviewHintLine(data.prNumber),
  ];
  return `${lines.join("\n")}\n`;
}

// budget-exhausted-carry S10: the comment a PR gets once no automatic review is left. It says so, explains
// it by the repository's own rules, says what the gate does with the next pushes, and how to ask for more.
// Stage 2 #12: no review reads those pushes, so the gate holds a green instead of carrying it, and the
// override is how a human merges a head no review verified.
function buildManualRequiredComment(data: ManualRequiredSummary): string {
  const manualOnly = data.admissionReason === "manual-only-policy";
  const rules = [
    ...(data.policyMode === undefined
      ? []
      : [`- Review policy: \`${data.policyMode}\` (\`ci_review_policy\`).`]),
    manualOnly
      ? "- This repository reviews automatically once per pull request; every later review is on request."
      : `- Automatic reviews used: ${data.reviewCount}/${data.maxAttempts} (\`ci_max_attempts\`).`,
    ...(data.reviewedHead === undefined || data.reviewedHead === null
      ? []
      : [`- Last reviewed head: \`${data.reviewedHead.slice(0, 7)}\`.`]),
  ];
  const lines = [
    MANUAL_REQUIRED_COMMENT_MARKER,
    "## Crysk: automatic reviews are done for this pull request",
    "",
    "⏹️ No more automatic reviews will run on this pull request.",
    "",
    `**${data.detail}**`,
    "",
    "How it got here, by this repository's rules:",
    "",
    ...rules,
    "",
    "What the gate does with the next pushes: no review reads them, so it never turns green on its own. " +
      "A red verdict stays red while a blocking finding is unanswered. A green verdict, or a red one whose " +
      "blocking findings all have a reply from someone with write access (`applied`, or a `dismissed` the " +
      "CI adjudicator upheld), waits as `pending` until a review verifies the head or " +
      `${commandHint(OVERRIDE_COMMAND)} merges it unverified. Reply before you push: the gate reads the ` +
      "replies when the push arrives.",
    "",
    "The existing review comment still describes the last head Crysk reviewed.",
    "",
    `Want more review rounds? ${ciForceReviewHintLine(data.prNumber)}`,
  ];
  return `${lines.join("\n")}\n`;
}

export interface AdmissionContext {
  currentHead: string;
  reviewedHead: string | null;
  policyMode: CiReviewPolicyMode;
  policyHash: string;
  deltaRisk?: DeltaRiskAssessment | null;
}

function skipAdmissionSummaryFields(
  verdict: Extract<CiReviewAdmissionVerdict, { action: "skip" }>,
  context?: AdmissionContext,
): Partial<SkipCoverageSummary> {
  if (context === undefined) return {};
  return {
    decision: "skip",
    admissionReason: verdict.reason,
    currentHead: context.currentHead,
    reviewedHead: context.reviewedHead,
    riskClass: context.deltaRisk?.class,
    riskReason: context.deltaRisk?.reason,
    remainingBudget: ciAdmissionRemainingBudget(
      verdict.reviewCount,
      verdict.maxAttempts,
    ),
    policyMode: context.policyMode,
    policyHash: context.policyHash,
  };
}

function manualAdmissionSummaryFields(
  verdict: Extract<CiReviewAdmissionVerdict, { action: "manual-required" }>,
  context?: AdmissionContext,
): Partial<ManualRequiredSummary> {
  if (context === undefined) return {};
  return {
    decision: "manual-required",
    admissionReason: verdict.reason,
    currentHead: context.currentHead,
    reviewedHead: context.reviewedHead,
    riskClass: context.deltaRisk?.class,
    riskReason: context.deltaRisk?.reason,
    remainingBudget: ciAdmissionRemainingBudget(
      verdict.reviewCount,
      verdict.maxAttempts,
    ),
    policyMode: context.policyMode,
    policyHash: context.policyHash,
  };
}

export function planCiReviewSkip(input: {
  prNumber: number;
  verdict: Extract<CiReviewAdmissionVerdict, { action: "skip" }>;
  admission?: AdmissionContext;
  ciMode: CiMode;
}): CiGateSkipPlan {
  const detail = ciReviewSkipDetail(input.verdict);
  const summary: SkipCoverageSummary = {
    kind: "skipped-coverage",
    prNumber: input.prNumber,
    reason: COVERAGE_REASON_LABEL[input.verdict.reason],
    detail,
    priorScore: input.verdict.prior.score,
    minScore: input.verdict.minScore,
    reviewCount: input.verdict.reviewCount,
    maxAttempts: input.verdict.maxAttempts,
    ...skipAdmissionSummaryFields(input.verdict, input.admission),
  };
  return {
    comment: buildCoverageSkipComment(summary, input.verdict.reason),
    markerPrefix: SKIP_COVERAGE_COMMENT_MARKER,
    summaryMarkdown: renderStepSummary(summary, input.ciMode),
    outputs: ciGateSkipOutputs("skipped-coverage", 0),
  };
}

export function planCiReviewManualRequired(input: {
  prNumber: number;
  verdict: Extract<CiReviewAdmissionVerdict, { action: "manual-required" }>;
  admission?: AdmissionContext;
  ciMode: CiMode;
}): CiGateSkipPlan {
  const detail = ciReviewManualRequiredDetail(input.verdict);
  const summary: ManualRequiredSummary = {
    kind: "manual-required",
    prNumber: input.prNumber,
    reason:
      input.verdict.reason === "max-attempts-exhausted"
        ? "automatic attempt budget exhausted"
        : "manual_only policy",
    detail,
    priorScore: input.verdict.prior.score,
    reviewCount: input.verdict.reviewCount,
    maxAttempts: input.verdict.maxAttempts,
    ...manualAdmissionSummaryFields(input.verdict, input.admission),
  };
  return {
    comment: buildManualRequiredComment(summary),
    markerPrefix: MANUAL_REQUIRED_COMMENT_MARKER,
    summaryMarkdown: renderStepSummary(summary, input.ciMode),
    outputs: ciGateSkipOutputs("manual-required", 0),
  };
}

// ---------------------------------------------------------------------------
// Assistant posture — spec 2.1: "The CLI MUST NOT exit with a non-zero code
// merely because findings (even `blocking` ones) were discovered ... exit
// non-zero ONLY on fatal execution failures." `blockingCount` is accepted
// and deliberately NEVER read: its only job is to let a test construct a
// high-blocking-count input and assert the result is still 0, so a future
// change that wires it into this function's logic (the exact regression
// this rule guards against) fails that test rather than shipping silently.
// ---------------------------------------------------------------------------

export function ciExitCode(input: {
  sessionFailed: boolean;
  droppedFindingIds: number;
  blockingCount: number;
}): 0 | 1 {
  if (input.sessionFailed) return 1;
  if (input.droppedFindingIds > 0) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// CI headless shell's "reviewed" (non-skip) outcome (ROADMAP Pillar 3,
// GitHub Actions) — the summary + outputs, and the pure "should I write"
// gates the shell checks before touching $GITHUB_STEP_SUMMARY/$GITHUB_OUTPUT.
// planCiReviewSkip/planCiReviewManualRequired above cover the two admission
// outcomes the same way; planCiReview is their sibling for a review that
// actually ran. Extracted from cli.ts (cli-decomp S2, Cluster B) — this
// module's own purity rule holds unchanged, every function below is a total
// function of its arguments.
// ---------------------------------------------------------------------------

// Spec 2.1's "reviewed" step-summary + spec 1.1's $GITHUB_OUTPUT contract,
// from the SAME findings array — so the two can never disagree on counts.
// `delta`/`repoWebUrl` are optional pass-throughs (posted.delta when a run
// posted; undefined renders plain code spans / omits the delta line).
export function planCiReview(input: {
  prNumber: number;
  headSha: string;
  findings: readonly Finding[];
  costUsdEst: number;
  wallMs: number;
  model: string;
  repoWebUrl?: string;
  delta?: PrCommentDelta;
  runDir: string;
  ciMode: CiMode;
}): { summaryMarkdown: string; outputs: CiOutputs } {
  const blockingCount = input.findings.filter(
    (f) => f.tier === "blocking",
  ).length;
  const summary: CiSummaryData = {
    kind: "reviewed",
    prNumber: input.prNumber,
    headSha: input.headSha,
    findings: input.findings,
    costUsdEst: input.costUsdEst,
    wallMs: input.wallMs,
    model: input.model,
    ...(input.repoWebUrl === undefined ? {} : { repoWebUrl: input.repoWebUrl }),
    ...(input.delta === undefined ? {} : { delta: input.delta }),
  };
  return {
    summaryMarkdown: renderStepSummary(summary, input.ciMode),
    outputs: {
      status: "reviewed",
      findings_count: input.findings.length,
      blocking_count: blockingCount,
      advisory_count: input.findings.length - blockingCount,
      cost_usd_est: input.costUsdEst,
      run_dir: input.runDir,
    },
  };
}

// Design D6, applied to the CI headless channel: a failed session publishes
// NOTHING. `sessionFailed` means every hunter died, which leaves the merged
// document with zero findings — so the "reviewed" payload built from it would
// claim `status=reviewed` + a "No findings detected" step summary for a review
// that never ran. The job exits non-zero either way, but a human reads the job
// summary, not the exit code, and postInlineIfEligible already suppresses PR
// posting on exactly this condition; the CI channel must not be the one place
// a crashed run still asserts a clean tree.
export function shouldPublishCiReview(
  isCi: boolean,
  sessionFailed: boolean,
): boolean {
  return isCi && !sessionFailed;
}

// Spec 1.1: "Output parameter writing when $GITHUB_OUTPUT is provided" —
// the outputs are core to the Action's own contract (declared unconditionally
// in action.yml), so nothing beyond CI mode + a real path gates them.
export function shouldWriteCiOutputs(
  isCi: boolean,
  outputPath: string | undefined,
): boolean {
  return isCi && outputPath !== undefined && outputPath.length > 0;
}

// Spec 2.1: step-summary writing is additionally gated on the tri-state
// `--step-summary`/`--no-step-summary` flag (`stepSummary`), unset meaning
// the shell's own default of on — mirroring `summary`/`scout`'s own
// unset-means-default convention (preflight.ts's CliOptions).
export function shouldWriteStepSummary(
  isCi: boolean,
  stepSummaryFlag: boolean | undefined,
  summaryPath: string | undefined,
): boolean {
  return (
    isCi &&
    (stepSummaryFlag ?? true) &&
    summaryPath !== undefined &&
    summaryPath.length > 0
  );
}

// Pure on purpose (design Threat Matrix, "Git repository selection" row,
// deferred from PR2's verification): --from names a directory on disk, and
// nothing stops it from pointing at a DIFFERENT PR's run than --pr names.
// findings.json's own `pr` field is the one thing that cannot lie about
// which review it came from — checked here, before any fetch or post,
// rather than trusting the operator to keep --pr and --from in sync by hand.
export function assertRunMatchesPr(
  doc: FindingsDocument,
  pr: number,
  runDir: string,
): void {
  if (doc.pr !== pr) {
    throw new CliUsageError(
      `${runDir} is a run of PR #${doc.pr}, not PR #${pr} — point --from ` +
        "at a run directory for the PR you are posting to",
    );
  }
}
