// CI headless mode's reporter (ROADMAP Pillar 3, GitHub Actions): the pure
// half turns a review outcome into GitHub Actions workflow-command lines and
// `$GITHUB_STEP_SUMMARY` Markdown; the impure half appends those bytes to
// the two files GitHub Actions hands the job through the environment.
//
// Purity split, mirroring src/ui/primitives.ts's one documented impure pair
// (`styleEnabled()`/`terminalWidth()`): `formatWorkflowCommand`,
// `renderStepSummary`, and `formatCiOutputs` are total functions of their
// inputs — no file I/O, no `process.env` sniffing, no `log()` call. Every
// byte they need arrives as a parameter, so all three stay offline-testable
// and re-renderable from a stored artifact. `appendStepSummary` and
// `appendCiOutputs` are the ONLY functions in this module that touch the
// filesystem, and they do nothing but append the pure functions' output to
// a caller-supplied path — the exact shape GitHub Actions expects for
// `$GITHUB_STEP_SUMMARY` and `$GITHUB_OUTPUT` (both files a step appends to
// across multiple writes in the same job, never overwrites).
//
// Reuses report.ts/review/findings.ts rather than re-deriving their contracts:
// `Finding`/`Severity`/`Tier` (review/findings.ts) for finding shape, and
// `severityEmoji`, `blobUrl`, `formatElapsed`, `PrCommentDelta` (report.ts)
// for the emoji mapping, blob-link builder, compact duration format, and
// the re-review delta's data shape — the same severity glyph and blob URL a
// reader sees on the PR comment must be the one this job summary shows.
// `deltaLine`/`usd`/`code`/`severityRank` stay PRIVATE in report.ts, so this
// module writes small local equivalents rather than exporting report.ts
// internals for a single extra caller.

// Node's fs/promises, not Bun.write: Bun.write always OVERWRITES its target,
// and both $GITHUB_STEP_SUMMARY and $GITHUB_OUTPUT are files a single job
// step may append to more than once (progress groups, then a final summary;
// multiple output keys written across several tool calls). An overwrite here
// would silently destroy an earlier step's contribution to the same file.
import { appendFile } from "node:fs/promises";
import type { CiMode } from "#pr/preflight";
import type { Finding, Severity } from "#review/findings";
import {
  blobUrl,
  formatElapsed,
  type PrCommentDelta,
  severityEmoji,
} from "#review/report";
import { log } from "#ui/primitives";

// ---------------------------------------------------------------------------
// Workflow commands (`::group::`, `::endgroup::`, `::notice::`, `::warning::`,
// `::error::`) — https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions
// ---------------------------------------------------------------------------

export type WorkflowCommandName =
  | "group"
  | "endgroup"
  | "notice"
  | "warning"
  | "error";

export interface WorkflowCommandOptions {
  file?: string;
  line?: number;
  endLine?: number;
  col?: number;
  endColumn?: number;
  title?: string;
}

// GitHub's documented data-escaping table for a command's message body.
function escapeData(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

// The property-value table additionally escapes `:` and `,` — those are the
// two characters the `key=value,key=value` property list itself uses as
// delimiters, so a raw one in a value (a Windows path's drive colon, a
// title with a comma) would silently split into the wrong property.
function escapeProperty(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

// Fixed emission order so the same options object always renders the same
// property string — a test asserting an exact command line would otherwise
// be at the mercy of `Object.entries`' insertion order at each call site.
const PROPERTY_ORDER = [
  "file",
  "line",
  "endLine",
  "col",
  "endColumn",
  "title",
] as const satisfies readonly (keyof WorkflowCommandOptions)[];

// Pure emitter for one GitHub Actions workflow-command line. `group` carries
// its title as the message (GitHub's own convention — `::group::<title>`
// has no property list); `endgroup` takes neither message nor properties.
export function formatWorkflowCommand(
  command: WorkflowCommandName,
  message = "",
  options?: WorkflowCommandOptions,
): string {
  if (command === "endgroup") return "::endgroup::";
  if (command === "group") return `::group::${escapeData(message)}`;
  const props = PROPERTY_ORDER.filter(
    (key) => options?.[key] !== undefined,
  ).map((key) => `${key}=${escapeProperty(String(options?.[key]))}`);
  const head =
    props.length > 0 ? `::${command} ${props.join(",")}::` : `::${command}::`;
  return `${head}${escapeData(message)}`;
}

// ---------------------------------------------------------------------------
// $GITHUB_STEP_SUMMARY — the job summary Markdown (spec 2.1).
// ---------------------------------------------------------------------------

// The three CiSummaryData members stay UNEXPORTED: `CiSummaryData` itself is
// the whole public contract a caller needs — a discriminated-union literal
// (`{ kind: "reviewed", ... }`) type-checks against it directly, exactly as
// every renderStepSummary test below constructs one. Exporting the members
// individually before a real caller needs to name one on its own would be
// an export for a hypothetical consumer (project rule 2) — Phase 3 either
// keeps using the union the same way or promotes exactly the member it
// needs, once it exists.
interface CiReviewSummary {
  kind: "reviewed";
  prNumber: number;
  headSha: string;
  findings: readonly Finding[];
  costUsdEst: number;
  wallMs: number;
  model: string;
  // Cosmetic and optional, same contract as renderPrComment's repoWebUrl
  // (report.ts): absent renders plain code spans instead of blob links.
  repoWebUrl?: string;
  delta?: PrCommentDelta;
}

interface CiSkipSizeSummary {
  kind: "skipped-size";
  prNumber: number;
  changedLines: number;
  changedFiles: number;
  maxChangedLines: number;
  maxChangedFiles: number;
}

interface CiSkipBudgetSummary {
  kind: "skipped-budget";
  prNumber: number;
  estimatedCostUsd: number;
  budgetUsd: number;
}

interface CiSkipCoverageSummary {
  kind: "skipped-coverage";
  prNumber: number;
  reason: string;
  detail: string;
  priorScore: number;
  minScore: number;
  reviewCount: number;
  maxAttempts: number;
  decision?: "skip";
  admissionReason?: string;
  currentHead?: string;
  reviewedHead?: string | null;
  riskClass?: string;
  riskReason?: string;
  remainingBudget?: number;
  policyMode?: string;
  policyHash?: string;
}

interface CiManualRequiredSummary {
  kind: "manual-required";
  prNumber: number;
  reason: string;
  detail: string;
  priorScore: number;
  reviewCount: number;
  maxAttempts: number;
  decision?: "manual-required";
  admissionReason?: string;
  currentHead?: string;
  reviewedHead?: string | null;
  riskClass?: string;
  riskReason?: string;
  remainingBudget?: number;
  policyMode?: string;
  policyHash?: string;
}

export type CiSummaryData =
  | CiReviewSummary
  | CiSkipSizeSummary
  | CiSkipBudgetSummary
  | CiSkipCoverageSummary
  | CiManualRequiredSummary;

// Footer attributing pr-hero as an AI code review assistant (spec 2.1), shared
// by all five variants. Advisory keeps the "not a merge gate" register the PR
// comment's own footer has (renderPrComment, report.ts). Gate says the report
// backs the commit status that is the required check (S4), because a gate
// that disclaims being one would contradict its own red status.
const ADVISORY_FOOTER =
  "<sub>Crysk — AI code review assistant. Assistant report, not a merge gate.</sub>";
const GATE_FOOTER =
  "<sub>Crysk — AI code review assistant. Assistant report backing the crysk commit status, the required check in gate mode.</sub>";

function footerFor(ciMode: CiMode): string {
  return ciMode === "gate" ? GATE_FOOTER : ADVISORY_FOOTER;
}

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

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Grouped by file (spec 2.1: "grouped by file and severity tier"), sorted
// so the summary is deterministic regardless of hunter fan-out order: path
// ascending, then severity rank, then line. Map preserves insertion order,
// and every finding for a path is inserted contiguously because the source
// array is pre-sorted by path first — so iterating the map yields paths in
// alphabetical order without a second sort pass.
function groupFindingsByPath(
  findings: readonly Finding[],
): Map<string, Finding[]> {
  const sorted = [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    const rankDiff = severityRank(a.severity) - severityRank(b.severity);
    if (rankDiff !== 0) return rankDiff;
    return a.line - b.line;
  });
  const groups = new Map<string, Finding[]>();
  for (const finding of sorted) {
    const existing = groups.get(finding.path);
    if (existing) existing.push(finding);
    else groups.set(finding.path, [finding]);
  }
  return groups;
}

function findingLine(
  finding: Finding,
  headSha: string,
  webUrl: string | undefined,
): string {
  const loc = `${finding.path}:${finding.line}`;
  const linked =
    webUrl === undefined
      ? `\`${loc}\``
      : `[\`${loc}\`](${blobUrl(webUrl, headSha, finding.path, `L${finding.line}`)})`;
  return (
    `- ${severityEmoji(finding.severity)} ${finding.severity} · ` +
    `${finding.tier} — ${linked} — ${oneLine(finding.claim)}`
  );
}

// Local equivalent of report.ts's private `deltaLine` — same PrCommentDelta
// shape and wording, kept in sync by convention since that helper is not
// exported for a single extra caller (see module header).
function formatDeltaLine(delta: PrCommentDelta): string {
  const since =
    delta.previousHeadSha === undefined
      ? "Δ"
      : `Δ since \`${delta.previousHeadSha.slice(0, 8)}\``;
  if (delta.rereview !== undefined) {
    const r = delta.rereview;
    const parts: string[] = [];
    if (r.verifiedGone > 0) parts.push(`${r.verifiedGone} resolved (verified)`);
    parts.push(`${r.unconfirmed} unconfirmed`);
    parts.push(`${r.carried} carried`);
    parts.push(`${r.deferred} deferred`);
    parts.push(`${r.new} new`);
    return `${since}: ${parts.join(" · ")}`;
  }
  return `${since}: ${delta.resolved} resolved · ${delta.new} new · ${delta.persist} persist`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// A size limit <= 0 means that knob is off (review/size-gate.ts). Printed as
// a number it reads "limit 0", a limit every diff exceeds, and a subscription
// route now turns a knob off by default (resolveCiSizeLimits), so the other
// knob tripping would show it.
export function sizeLimitText(limit: number): string {
  return limit > 0 ? `limit ${limit}` : "no limit";
}

function skipSizeLines(data: CiSkipSizeSummary): string[] {
  return [
    `### ⚠️ Crysk Review Skipped — PR #${data.prNumber}`,
    "",
    "**Reason:** the diff exceeds the configured size gate limits.",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Changed lines | ${data.changedLines} (${sizeLimitText(data.maxChangedLines)}) |`,
    `| Changed files | ${data.changedFiles} (${sizeLimitText(data.maxChangedFiles)}) |`,
    "",
    "Crysk did not run to avoid reviewing an unbounded diff. Split the " +
      "PR or raise `max-changed-lines` / `max-changed-files`.",
  ];
}

function skipBudgetLines(data: CiSkipBudgetSummary): string[] {
  return [
    `### ⚠️ Crysk Review Skipped — PR #${data.prNumber}`,
    "",
    "**Reason:** the estimated cost exceeds the configured budget ceiling.",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Estimated cost | ${usd(data.estimatedCostUsd)} (budget ${usd(data.budgetUsd)}) |`,
    "",
    "Crysk did not run to stay within the configured `--budget-usd` " +
      "ceiling.",
  ];
}

function admissionMetricRows(
  data: CiSkipCoverageSummary | CiManualRequiredSummary,
): string[] {
  const rows: string[] = [];
  if (data.decision !== undefined) {
    rows.push(`| Decision | ${data.decision} |`);
  }
  if (data.admissionReason !== undefined) {
    rows.push(`| Admission reason | ${data.admissionReason} |`);
  }
  if (data.currentHead !== undefined) {
    rows.push(`| Current head | \`${data.currentHead.slice(0, 8)}\` |`);
  }
  if (data.reviewedHead !== undefined) {
    rows.push(
      `| Reviewed head | ${
        data.reviewedHead === null
          ? "none"
          : `\`${data.reviewedHead.slice(0, 8)}\``
      } |`,
    );
  }
  if (data.riskClass !== undefined) {
    rows.push(`| Risk class | ${data.riskClass} |`);
  }
  if (data.riskReason !== undefined && data.riskReason.length > 0) {
    rows.push(`| Risk detail | ${data.riskReason} |`);
  }
  if (data.remainingBudget !== undefined) {
    rows.push(`| Remaining budget | ${data.remainingBudget} |`);
  }
  if (data.policyMode !== undefined) {
    rows.push(`| Policy mode | ${data.policyMode} |`);
  }
  if (data.policyHash !== undefined) {
    rows.push(`| Policy hash | \`${data.policyHash.slice(0, 8)}\` |`);
  }
  return rows;
}

function skipCoverageLines(data: CiSkipCoverageSummary): string[] {
  // A stop is a maintainer's decision, not a score (same wording rule as the
  // PR comment, gates.ts buildCoverageSkipComment).
  const stopped = data.admissionReason === "stopped";
  return [
    `### ⚠️ Crysk Review Skipped — PR #${data.prNumber}`,
    "",
    stopped
      ? "**Reason:** a maintainer stopped automatic reviews on this pull request."
      : "**Reason:** this push does not justify another review run.",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Skip reason | ${data.reason} |`,
    ...(stopped
      ? []
      : [`| Prior score | ${data.priorScore} (minimum ${data.minScore}) |`]),
    `| Attempts used | ${data.reviewCount}/${data.maxAttempts} |`,
    ...admissionMetricRows(data),
    "",
    data.detail,
  ];
}

function manualRequiredLines(data: CiManualRequiredSummary): string[] {
  return [
    `### 🛑 Crysk Review — Manual Override Required — PR #${data.prNumber}`,
    "",
    "**Reason:** automatic review did not run on this push.",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Block reason | ${data.reason} |`,
    `| Prior score | ${data.priorScore} |`,
    `| Attempts used | ${data.reviewCount}/${data.maxAttempts} |`,
    ...admissionMetricRows(data),
    "",
    data.detail,
  ];
}

function reviewedLines(data: CiReviewSummary): string[] {
  const blocking = data.findings.filter((f) => f.tier === "blocking");
  const advisory = data.findings.filter((f) => f.tier === "advisory");
  const out = [
    `### 🔍 Crysk Review — PR #${data.prNumber}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Findings | ${data.findings.length} (${blocking.length} blocking · ` +
      `${advisory.length} advisory) |`,
    `| Estimated cost | ${usd(data.costUsdEst)} |`,
    `| Duration | ${formatElapsed(data.wallMs)} |`,
    `| Model | ${data.model} |`,
    "",
  ];
  if (data.findings.length === 0) {
    out.push("✅ No findings detected.");
  } else {
    out.push("#### Findings", "");
    for (const [filePath, group] of groupFindingsByPath(data.findings)) {
      out.push(`**\`${filePath}\`**`);
      for (const finding of group) {
        out.push(findingLine(finding, data.headSha, data.repoWebUrl));
      }
      out.push("");
    }
  }
  if (data.delta !== undefined) {
    out.push(formatDeltaLine(data.delta));
    out.push("");
  }
  return out;
}

// Formatted Markdown for `$GITHUB_STEP_SUMMARY` (spec 2.1). Pure — the
// caller supplies every byte, so the summary is re-renderable from a stored
// findings.json months later, same contract as
// renderReport/renderPrComment (report.ts).
// `ciMode` picks the footer only. Omitted means advisory: the footer every
// caller has today, until a caller passes the mode its status was set under.
export function renderStepSummary(
  data: CiSummaryData,
  ciMode: CiMode = "advisory",
): string {
  const body =
    data.kind === "skipped-size"
      ? skipSizeLines(data)
      : data.kind === "skipped-budget"
        ? skipBudgetLines(data)
        : data.kind === "skipped-coverage"
          ? skipCoverageLines(data)
          : data.kind === "manual-required"
            ? manualRequiredLines(data)
            : reviewedLines(data);
  const out = [...body, "---", "", footerFor(ciMode)];
  return `${out.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// $GITHUB_OUTPUT — the action's structured outputs (spec 1.1).
// ---------------------------------------------------------------------------

export interface CiOutputs {
  status: string;
  findings_count: number;
  blocking_count: number;
  advisory_count: number;
  // Spec 1.1: "cost-usd-est: ... (float string, e.g. `"2.45"`)" — formatted
  // to 2 decimals here so every consumer of $GITHUB_OUTPUT reads the same
  // fixed-precision string the action.yml output contract promises.
  cost_usd_est: number;
  run_dir: string;
}

// Pure `key=value` line formatter for `$GITHUB_OUTPUT`. One name per line,
// GitHub Actions' own format for scalar outputs (no multiline heredoc
// delimiter needed — every value here is a single-line scalar).
export function formatCiOutputs(outputs: CiOutputs): string {
  const lines = [
    `status=${outputs.status}`,
    `findings_count=${outputs.findings_count}`,
    `blocking_count=${outputs.blocking_count}`,
    `advisory_count=${outputs.advisory_count}`,
    `cost_usd_est=${outputs.cost_usd_est.toFixed(2)}`,
    `run_dir=${outputs.run_dir}`,
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Impure edge — the ONLY functions in this module that touch the filesystem.
// ---------------------------------------------------------------------------

// Appends `markdown` to the file `$GITHUB_STEP_SUMMARY` points at, adding
// exactly one trailing newline when the caller's Markdown does not already
// end with one — GitHub renders the file as-is, and two summaries glued
// together without a newline between them would merge into one line.
export async function appendStepSummary(
  summaryFilePath: string,
  markdown: string,
): Promise<void> {
  const text = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  await appendFile(summaryFilePath, text);
}

// Appends `formatCiOutputs(outputs)` to the file `$GITHUB_OUTPUT` points at.
export async function appendCiOutputs(
  outputFilePath: string,
  outputs: CiOutputs,
): Promise<void> {
  await appendFile(outputFilePath, formatCiOutputs(outputs));
}

// ---------------------------------------------------------------------------
// CI headless shell composition (ROADMAP Pillar 3) — the `::group::` wrapper
// built on `formatWorkflowCommand` above, and the fatal-error reporter built
// on `appendCiOutputs` above. Extracted from cli.ts (cli-decomp S2,
// Cluster B): neither touches the filesystem directly (`appendCiOutputs`
// remains the only function here that does), so the module header's purity
// split still holds for its own two functions — these two compose them.
// ---------------------------------------------------------------------------

// Spec 2.1's `::group::` / `::endgroup::` pairing, owned by ONE function so
// the arm and the close cannot drift apart. An unclosed group is not
// cosmetic: GitHub folds every line logged after it into a collapsed section,
// so a crash mid-review hides its own `::error::` annotation from the reader
// who most needs it. Putting the arm at the call site and the close in some
// later `finally` leaves a window — whatever runs in between — where a throw
// escapes with the group still open; here there is no in-between.
//
// `emit` is a parameter rather than this module's `log`: a guarantee nothing
// can observe is a guarantee nobody can test, and the failure path is exactly
// the one that has to be proven.
export async function withCiWorkflowGroup<T>(
  isCi: boolean,
  name: string,
  emit: (line: string) => void,
  body: () => Promise<T>,
): Promise<T> {
  if (!isCi) return await body();
  emit(formatWorkflowCommand("group", name));
  try {
    return await body();
  } finally {
    emit(formatWorkflowCommand("endgroup"));
  }
}

// Spec 1.1's `status` output enum names `error` alongside `reviewed` /
// `skipped-size` / `skipped-budget`, but before this function nothing ever
// wrote it: main()'s own catch only handles CliError/CliUsageError (exit 1,
// no $GITHUB_OUTPUT write); every OTHER thrown error — a genuine fatal
// failure, e.g. bad credentials deep inside reviewPr() — was simply
// rethrown, crashing the process with no output at all. A workflow branching
// on `steps.x.outputs.status == 'error'` could then never fire.
//
// $GITHUB_OUTPUT existing at all is itself the CI signal here: GitHub sets it
// unconditionally for every job step, before any of this repo's own flags
// are parsed, so this needs no separate isCiEnvironment() computation — and
// it fails closed for a genuinely local crash (outputPath undefined), which
// runCli()'s caller rethrows so the developer still sees a full stack trace
// instead of a swallowed one-line message.
export async function reportFatalCiError(
  error: unknown,
  outputPath: string | undefined,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (outputPath !== undefined && outputPath.length > 0) {
    // Best-effort: an unwritable $GITHUB_OUTPUT must not mask the original
    // fatal error or suppress the ::error:: annotation below.
    await appendCiOutputs(outputPath, {
      status: "error",
      findings_count: 0,
      blocking_count: 0,
      advisory_count: 0,
      cost_usd_est: 0,
      run_dir: "",
    }).catch(() => {});
  }
  log(formatWorkflowCommand("error", message));
}

// main()'s two internal catches RETURN rather than throw, so runCli()'s catch
// — the only thing that has ever written `status=error` — never saw them. Both
// are failures docs/github-actions.md names as reasons the job goes red: a
// malformed argument (parseArgs, exit 2) and a CliError/CliUsageError from a
// command body (exit 1) — which is precisely what a missing or expired
// GITHUB_TOKEN produces, since pr/pr.ts raises CliError for `gh not found on
// PATH` and for a failed `gh pr view`. A consumer branching on
// `outputs.status == 'error'` therefore never saw it fire for the two most
// common failures; it saw `status` unset, indistinguishable from a step whose
// outputs were never read.
//
// $GITHUB_OUTPUT's mere presence is the CI signal here, exactly as it is for
// reportFatalCiError: GitHub sets it for every job step before any of this
// repo's own flags are parsed. Guarding the CALL rather than only the write is
// deliberate — reportFatalCiError also emits an `::error::` annotation, and
// printing workflow-command syntax on a developer's terminal after a plain
// typo is noise, not diagnostics. Exit codes are untouched; only the write is
// new.
export async function reportFatalCiErrorIfInJobStep(
  error: unknown,
): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath.length === 0) return;
  await reportFatalCiError(error, outputPath);
}
