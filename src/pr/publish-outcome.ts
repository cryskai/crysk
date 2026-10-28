// PR mode's post-pipeline tail (ROADMAP B1): the artifact writes, the
// comparison.json, the canonical store, posting, the terminal summary,
// CI publishing, and the CI admission ledger's terminal settlement — all of
// it runs once `runPipeline` has returned. Extracted out of reviewPr()
// (src/pr/review-pr.ts, cli-decomp/review-pr-publish-outcome): identifiers
// moved onto explicit parameters, control flow otherwise unchanged. The WHY
// comments below move with the code they explain, including their original
// step numbers (12-16) from reviewPr()'s own numbered sequence.
//
// The hazard this split has to preserve: reviewPr() declares `let result`
// and `let posted` OUTSIDE its try block because BOTH of its finally blocks
// (settleCommitStatusAndLedger, finalizePrReviewRun) read them on every exit
// path, including a throw partway through this tail. `result` is only ever
// READ here — it is assigned earlier, by the pipeline call this module never
// touches — so it stays a plain input, guarded the same way reviewPr() used
// to guard it. `posted` is WRITTEN here, the instant `postFindingsIfEnabled`
// resolves; a function that only RETURNED it at the end would lose that
// write on a later throw (e.g. from publishCiReviewIfEligible or a
// settleCiAdmissionLedger call), leaving the commit-status finally believing
// nothing was posted when it actually was. `onPosted` is the sink:
// reviewPr()'s own callback assigns its outer `posted` the moment this
// module does, so a throw one line later still leaves the right value
// behind. `ciAdmissionLedger` needs no equivalent sink — settleCiAdmissionLedger
// mutates `state.record` on the SAME object reviewPr() already holds, never
// reassigning the binding itself, so passing the reference through is enough.

import path from "node:path";
import { classifyCliError } from "#ci/classify-error";
import { recordReviewDelivered, writeCliRecord } from "#ci/cli-record";
import { ciExitCode } from "#ci/gates";
import {
  ingestReviewMetrics,
  notionalCostInput,
  persistCanonicalReview,
} from "#config/config";
import { gitRemoteWebUrl } from "#git/git";
import { engineIdentity } from "#git/identity";
import type { FreeRouteBilling } from "#model/free-discovery";
import {
  type CiAdmissionLedgerState,
  settleCiAdmissionLedger,
} from "#pr/admission";
import { publishCiReviewIfEligible } from "#pr/ci-publish";
import { computeComparison } from "#pr/comparison";
import type { PrDiscoveryResult } from "#pr/discovery";
import { type InlinePostOutcome, postingExitCode } from "#pr/inline";
import { type PostingStageResult, postFindingsIfEnabled } from "#pr/posting";
import type { CiMode } from "#pr/preflight";
import { unresolvedBlockingCount } from "#rereview/state";
import type { Telemetry } from "#review/findings";
import type { PipelineResult } from "#review/pipeline";
import type { CliOptions } from "#review/preflight";
import type { ParsedAgent, PromptSetIdentity } from "#review/prompt-set";
import {
  type DiffStat,
  envelopeModel,
  type estimateCost,
} from "#review/report";
import { buildTelemetry, writeRunFindings, writeRunReport } from "#review/run";
import { log, styleEnabled } from "#ui/primitives";
import { type ResultLinks, renderResult } from "#ui/result";
import { freeBillingMode } from "#ui/select";
import { CliError } from "../errors";
import { prheroLayout } from "../home-preflight";

export interface PublishRunOutcomeInput {
  result: PipelineResult | undefined;
  started: number;
  indexMs: number;
  runDir: string;
  prNumber: number;
  diffFromSha: string;
  headSha: string;
  options: CliOptions;
  agentFiles: Map<string, ParsedAgent>;
  promptSet: PromptSetIdentity;
  operatorRoot: string;
  baseRef: string;
  diffStat: DiffStat;
  droppedPaths: string[];
  diffPatch: string;
  home: string;
  repoId: string | null;
  postEnabled: boolean;
  rereview: PrDiscoveryResult["rereview"];
  phaseB: PrDiscoveryResult["phaseB"];
  gitDirOwner: string;
  worktreePath: string;
  isCi: boolean;
  // The run's one resolved CI mode (resolveCiMode, reviewPr). The report, the
  // summary comment and the step summary all name it; nothing re-resolves it.
  ciMode: CiMode;
  estimate: ReturnType<typeof estimateCost>;
  // W3-FOOTER: the plan's free-route count. Absent means no free share, and the
  // footer keeps its subscription wording.
  freeRoute?: FreeRouteBilling;
  ciAdmissionLedger: CiAdmissionLedgerState | null;
  // Fired the instant `posted` would have been assigned inside reviewPr()
  // itself — see the header above.
  onPosted: (posted: InlinePostOutcome | null) => void;
  // S4's sibling sink, for the same reason as onPosted: the commit status
  // (settleCommitStatusAndLedger) reads this count in reviewPr()'s finally,
  // and a throw later in this tail must not leave it unknown. The count is the
  // gate's UNRESOLVED blocking count (rereview/state.ts), not this run's survivors.
  onBlockingCount: (count: number) => void;
  // Test-only seam (default: the real postFindingsIfEnabled). The posting stage
  // reaches gh with no offline seam of its own, so the suite passes a fake that
  // rejects or resolves, the way it drives the throw and the delivery point.
  postFindings?: typeof postFindingsIfEnabled;
}

export async function publishRunOutcome(
  input: PublishRunOutcomeInput,
): Promise<number> {
  if (input.result === undefined) {
    // An engine invariant, not the reader's configuration: the record names it as
    // the pr-hero defect class (T2d-1).
    throw new CliError("internal: pipeline returned no result", {
      cls: { kind: "invariant" },
    });
  }
  const result = input.result;
  const wallMs = Math.round(performance.now() - input.started);

  // 12 — the artifact and the report, exactly as local mode writes them.
  // Unlike local mode's hardcoded 0, PR mode BUILDS the worktree's index
  // when it is missing, so the init cost is real and measured. Disk stays
  // unreported, and the mode is the same synchronous build.
  const telemetry: Telemetry = buildTelemetry(result, wallMs, input.indexMs);
  const { doc, findingsPath } = await writeRunFindings({
    runDir: input.runDir,
    result,
    pr: input.prNumber,
    baseSha: input.diffFromSha,
    headSha: input.headSha,
    options: input.options,
    agentFiles: input.agentFiles,
    promptSet: input.promptSet,
    engine: await engineIdentity(),
    telemetry,
  });
  // S4: the gate's unresolved count, read by the commit status in teardown.
  // It is this run's blocking survivors PLUS every live blocking prior that no
  // verifier verdict and no deletion cleared (rereview/state.ts owns the rule and
  // its dedupe key). Counting only this run's survivors read green on a
  // same-head forced re-review and on any re-review that carried a blocking
  // prior. Computed once here, and fired the moment the doc exists, so a later
  // throw still leaves the gate a count to read.
  const blockingCount = unresolvedBlockingCount(
    doc.findings,
    result.gatePriors ?? [],
  );
  input.onBlockingCount(blockingCount);
  const reportPath = await writeRunReport({
    runDir: input.runDir,
    doc,
    repo: path.basename(input.operatorRoot),
    base: input.baseRef,
    head: `PR #${input.prNumber}`,
    diffStat: input.diffStat,
    droppedPaths: input.droppedPaths,
    result,
    wallMs,
    ciMode: input.ciMode,
  });
  // The delivery point when posting is off: nothing is posted, so the written
  // artifacts are the delivery. Written after writeRunReport, never before, so a
  // failed artifact write leaves no record of a delivery. A failed session keeps the
  // hunters-failed record that reviewPr wrote when the pipeline returned.
  if (!input.postEnabled && !result.sessionFailed) {
    recordReviewDelivered(input.headSha);
  }

  // 13 — the comparison.json write, then (13b) its read-back for the
  // observability store. See computeComparison (src/pr/comparison.ts) for the
  // full rationale.
  const { storedComparison } = await computeComparison({
    sessionFailed: result.sessionFailed,
    pr: input.prNumber,
    headSha: input.headSha,
    diffFromSha: input.diffFromSha,
    runDir: input.runDir,
    runStatus: doc.run_status,
    findings: doc.findings.map((f) => ({
      id: f.id,
      path: f.path,
      line: f.line,
      claim: f.claim,
      tier: f.tier,
    })),
  });
  // 13b — canonical product store & observability metrics.
  persistCanonicalReview({
    home: input.home,
    repoId: input.repoId,
    runDir: input.runDir,
    checkoutPath: input.operatorRoot,
    doc,
    perAgent: result.perAgent,
    comparison: storedComparison,
    log,
  });
  ingestReviewMetrics({
    dbPath: prheroLayout(input.home).metricsDbPath,
    repoId: input.repoId,
    runDir: input.runDir,
    checkoutPath: input.operatorRoot,
    doc,
    perAgent: result.perAgent,
    comparison: storedComparison,
    log,
  });

  // 14 — the posting, only when asked. Hoisted `postedWebUrl` out of the
  // stage ONLY so step 15 can reuse it: when posting ran, the terminal's
  // links must be built from the SAME web url the comments were
  // published against. See postFindingsIfEnabled (src/pr/posting.ts) for
  // the full rationale.
  // Only the posting call is wrapped. A throw before the delivery point is the
  // posting's own failure, so its record names the step and the publisher can say
  // the review stopped while posting. A throw after it keeps reviewed (see
  // onDelivered below), so no posting record replaces it.
  // The error is rethrown unchanged, and no stage around this call is wrapped.
  let postingResult: PostingStageResult;
  let delivered = false;
  try {
    postingResult = await (input.postFindings ?? postFindingsIfEnabled)({
      postEnabled: input.postEnabled,
      sessionFailed: result.sessionFailed,
      operatorRoot: input.operatorRoot,
      pr: input.prNumber,
      headSha: input.headSha,
      doc,
      diffPatch: input.diffPatch,
      runDir: input.runDir,
      rereview: input.rereview,
      rereviewPriors: input.phaseB?.priors,
      // A comment-triggered run: its summary counter stays where it was.
      force: input.options.force === true,
      // THE delivery point when posting is on: the findings POST has resolved, so
      // the review is delivered. It fires before the local receipt is written, so a
      // receipt write that throws is a failure after delivery. A failed session never
      // reaches it.
      onDelivered: () => {
        recordReviewDelivered(input.headSha);
        delivered = true;
      },
      ciMode: input.ciMode,
    });
  } catch (error) {
    if (!delivered) {
      writeCliRecord({
        v: 1,
        outcome: "error",
        cls: classifyCliError(error),
        params: { step: "posting the review" },
      });
    }
    throw error;
  }
  // The hazard this whole module exists for: fire the sink IMMEDIATELY, at
  // the exact point reviewPr() used to assign its own `posted` variable —
  // not at the end of this function, and not via the return value — so a
  // throw from anything below (publishCiReviewIfEligible, a
  // settleCiAdmissionLedger call) still leaves reviewPr()'s outer `posted`
  // correct for its finally block.
  const posted = postingResult.posted;
  input.onPosted(posted);
  const postedWebUrl = postingResult.postedWebUrl;

  // 15 — the summary. One shared renderer with local mode; the mode-specific parts
  // (the worktree hint) ride in as optional inputs. The `posted:` line that
  // used to sit here is GONE on purpose: step 14 already printed a richer one
  // at the moment it happened, and two differently-worded reports of the same
  // POST read as two postings. What this block keeps is the durable trace —
  // post.json in the artifact list below.
  //
  // The links, in the order that keeps them honest: `gh`'s answer when posting
  // already paid for it, otherwise the free git-remote derivation — so a run
  // WITHOUT --post still prints a clickable url for every finding, which is
  // the whole reason repoWebUrlFromRemote exists. No pushed-ness check here
  // (unlike local mode): a PR head came out of `refs/pull/<n>/head`, so origin
  // has it by construction.
  const webUrl = postedWebUrl ?? (await gitRemoteWebUrl(input.operatorRoot));
  const links: ResultLinks | undefined =
    webUrl === undefined
      ? undefined
      : {
          webUrl,
          headSha: input.headSha,
          pr: input.prNumber,
          // Only when this run actually posted: a comment url for a comment
          // that does not exist is the dead link the whole degradation rule
          // exists to prevent. Absent ids fall through to a blob link.
          ...(posted ? { commentUrls: posted.commentUrls } : {}),
        };
  for (const line of renderResult({
    doc,
    costUsd: result.usage.cost_usd_est,
    ...notionalCostInput(result),
    ...(input.freeRoute === undefined
      ? {}
      : { billing: freeBillingMode(input.freeRoute) }),
    wallMs,
    estimate: { low: input.estimate.low, high: input.estimate.high },
    runDir: input.runDir,
    artifacts: [
      path.basename(reportPath),
      path.basename(findingsPath),
      ...(posted ? ["post.json"] : []),
    ],
    worktree: {
      gitDirOwner: input.gitDirOwner,
      worktreePath: input.worktreePath,
    },
    ...(links === undefined ? {} : { links }),
    // GitHub #39. Only a run that actually POSTED can know this — the
    // re-read lives in the posting sequence — so a run without --post
    // never claims the head moved, which is correct: it published nothing
    // that could go stale.
    ...(posted?.movedHeadSha === undefined
      ? {}
      : { movedHeadSha: posted.movedHeadSha }),
    sessionFailed: result.sessionFailed,
    ...(result.unresolved.length > 0 ? { unresolved: result.unresolved } : {}),
    styles: styleEnabled(),
  })) {
    log(line);
  }
  // 16 — CI headless publishing (ROADMAP Pillar 3). `posted?.delta`
  // reuses postInlineFindings' own re-review delta — no separate
  // computation. See publishCiReviewIfEligible (src/pr/ci-publish.ts)
  // for the full rationale.
  await publishCiReviewIfEligible({
    isCi: input.isCi,
    sessionFailed: result.sessionFailed,
    prNumber: input.prNumber,
    headSha: input.headSha,
    findings: doc.findings,
    costUsdEst: result.usage.cost_usd_est,
    wallMs,
    model: envelopeModel(input.options, input.agentFiles),
    webUrl,
    delta: posted?.delta,
    runDir: input.runDir,
    stepSummaryFlag: input.options.stepSummary,
    ciMode: input.ciMode,
  });
  if (result.sessionFailed) {
    await settleCiAdmissionLedger(
      input.ciAdmissionLedger,
      "failed",
      "every hunter failed",
    );
    return 1;
  }
  await settleCiAdmissionLedger(
    input.ciAdmissionLedger,
    "completed",
    "review complete",
  );
  // Assistant posture (spec 2.1): in CI mode, exit 0 even with blocking
  // findings — ciExitCode only fails on a fatal session failure (already
  // returned above) or a genuine posting drop (design D6). Outside CI,
  // postingExitCode keeps its existing behavior unchanged.
  return input.isCi
    ? ciExitCode({
        sessionFailed: result.sessionFailed,
        droppedFindingIds: posted?.droppedFindingIds.length ?? 0,
        blockingCount,
      })
    : postingExitCode(posted);
}
