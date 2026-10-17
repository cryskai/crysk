// PR mode's re-review/delta-detection step (ROADMAP D9, rereview-coverage
// fix): step 5 of reviewPr() — last-reviewed head, the two deltas, Phase B
// classification, and the size gate over the discovery range. Relocated out
// of reviewPr() (src/pr/review-pr.ts): identifiers moved onto explicit
// parameters, control flow and WHY comments unchanged.
//
// The three `gh`-backed comment fetches (issueComments/postedFindings/
// reviewComments) stay a Promise.all in reviewPr() itself, on purpose: they
// are the one genuine system boundary in this step, and reviewPr() already
// has no injectable seam for them (same limitation as ci-admission-gate.ts's
// own fetches). Handing this module the ALREADY-FETCHED arrays as data,
// plus a small git adapter for the object-db reads, is what makes the
// re-review MACHINE itself — case classification, discovery widening, and
// Phase B queuing — testable with fakes, even though the fetches around it
// are not.

import { formatWorkflowCommand } from "#ci/reporter";
import type {
  fetchPostedFindingComments,
  fetchPrComments,
  fetchPrReviewComments,
} from "#pr/pr";
import { findMarkedCommentId } from "#pr/preflight";
import {
  adjudicationQueue,
  buildPhaseBQueue,
  decideLastHeadDelta,
  enrichPriorsFromThreads,
  incompleteLastReviewMessage,
  type PreparedDiscovery,
  parseNameStatus,
  prepareDiscovery,
  priorsFromPostedMarkers,
  priorsFromStateFindings,
  type RereviewProvenance,
  shouldAbortEmptyDiscovery,
  skippedDiscoveryMessage,
  toRereviewProvenance,
  unreachableLastHeadMessage,
} from "#rereview/prepare";
import { parseStateBlock } from "#rereview/state";
import type { VerifyQueueEntry } from "#rereview/verify";
import {
  allExcludedMessage,
  emptyDiffMessage,
  resolveMaxVerificationSteps,
} from "#review/preflight";
import type { DiffStat } from "#review/report";
import {
  computeDiffStatAndSizeGate,
  type LoadedRunConfig,
  selectActiveHunters,
} from "#review/run";
import {
  type ExcludedPath,
  evaluateSizeGate,
  filterDiffByIgnoreRules,
  type SizeGateVerdict,
  sizeGateConfigFor,
} from "#review/size-gate";
import type { AgentSpec } from "#review/spec";
import type { AdjudicationSubject } from "#triage/adjudication";
import { parsePrCommentMarker, summaryMarkerFields } from "#watch/preflight";
import { CliError } from "../errors";
import type { IgnoreFileReadResult } from "../ignore-read";

// Invariant 1 (rereview-coverage fix): the ONLY input that may gate which
// hunters run for a re-review is `skipDiscovery` — never a hardcoded
// `case === "B"` special-case, which would defeat the fix by silently
// skipping discovery for every case-B re-review regardless of whether this
// particular one actually has nothing to discover. `agents`/`parityFires`
// flow through unchanged to `selectActiveHunters` (#review/run), shared with
// review()'s own copy.
export function discoveryHunters(params: {
  skipDiscovery: boolean;
  agents: readonly AgentSpec[];
  parityFires: boolean;
}): AgentSpec[] {
  return params.skipDiscovery
    ? []
    : selectActiveHunters(params.agents, params.parityFires);
}

export interface PrDiscoveryGit {
  commitExists(sha: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  nameOnly(from: string, to: string): Promise<string[]>;
  nameStatus(from: string, to: string): Promise<string>;
  // The raw `git diff` primitive, repo already bound by the caller — used
  // for the discovery-range diff itself and (via computeDiffStatAndSizeGate)
  // its numstat variants. Matches computeDiffStatAndSizeGate's own `runGit`
  // shape (#review/run) so both share one fake in tests.
  runGit(
    args: string[],
  ): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

export interface PrDiscoveryResult {
  prepared: PreparedDiscovery;
  skipDiscovery: boolean;
  rawDiff: string;
  effectiveDiff: {
    patch: string;
    droppedPaths: string[];
    exclusions: ExcludedPath[];
  };
  gateConfig: ReturnType<typeof sizeGateConfigFor>;
  rereview: RereviewProvenance | undefined;
  verifyQueue: VerifyQueueEntry[];
  overlapCandidates: VerifyQueueEntry[];
  // T5b: the pending dismissals the CI adjudicator rules on. Empty unless
  // `adjudicate` was set.
  adjudicationQueue: AdjudicationSubject[];
  phaseB:
    | {
        settled: ReturnType<typeof buildPhaseBQueue>["settled"];
        priors: ReturnType<typeof priorsFromStateFindings>;
      }
    | undefined;
  diffStat: DiffStat;
  sizeGate: SizeGateVerdict;
}

export async function resolvePrDiscovery(params: {
  diffFromSha: string;
  headSha: string;
  full: boolean;
  // T5b: `--adjudicate`. Absent or false queues no adjudication.
  adjudicate?: boolean;
  baseRef: string;
  headLabel: string;
  isCi: boolean;
  sizeGateOverrides: { maxChangedLines?: number; maxChangedFiles?: number };
  config: LoadedRunConfig["config"];
  prIgnore: IgnoreFileReadResult;
  issueComments: Awaited<ReturnType<typeof fetchPrComments>>;
  postedFindings: Awaited<ReturnType<typeof fetchPostedFindingComments>>;
  reviewComments: Awaited<ReturnType<typeof fetchPrReviewComments>>;
  git: PrDiscoveryGit;
  log: (line?: string) => void;
}): Promise<PrDiscoveryResult> {
  const {
    diffFromSha,
    headSha,
    full,
    adjudicate,
    baseRef,
    headLabel,
    isCi,
    sizeGateOverrides,
    config,
    prIgnore,
    issueComments,
    postedFindings,
    reviewComments,
    git,
    log,
  } = params;

  // parsePrCommentMarker, not parseMarkerHead: this is the ONE call site
  // that decides whether the L this run is about to trust actually
  // finished (rereview-coverage fix). A missing or unparseable
  // marker means "nothing to distrust" — summaryMarkerFields defaults
  // summaryComplete true and it is then ignored anyway, since
  // resolveLastReviewedHead only consults it when summaryHead itself is
  // non-null.
  const existingSummaryId = findMarkedCommentId(issueComments);
  const summaryMarker =
    existingSummaryId === null
      ? null
      : parsePrCommentMarker(
          issueComments.find((c) => c.id === existingSummaryId)?.body ?? "",
        );
  const { summaryHead, summaryComplete } = summaryMarkerFields(summaryMarker);
  const prepared = await prepareDiscovery({
    B: diffFromSha,
    H: headSha,
    full,
    summaryHead,
    summaryComplete,
    findingMarkers: postedFindings.map((p) => ({
      headSha: p.marker.headSha,
      createdAt: p.created_at ?? "",
    })),
    git: {
      commitExists: git.commitExists,
      isAncestor: git.isAncestor,
      nameOnly: git.nameOnly,
    },
  });
  const discoveryRange = `${prepared.discoveryFrom}..${prepared.discoveryTo}`;
  const pathArgs =
    prepared.discoveryPaths !== null && prepared.discoveryPaths.length > 0
      ? ["--", ...prepared.discoveryPaths]
      : [];
  const skipPlannedDiscovery =
    prepared.plan.skipDiscovery || prepared.discoverySkippedEmptyDelta;

  let rawDiff = "";
  if (!skipPlannedDiscovery) {
    const diff = await git.runGit(["diff", discoveryRange, ...pathArgs]);
    if (!diff.ok) throw new CliError(`git diff failed: ${diff.stderr}`);
    rawDiff = diff.stdout;
  }
  if (shouldAbortEmptyDiscovery(prepared.plan, rawDiff)) {
    throw new CliError(emptyDiffMessage(baseRef, headLabel, false));
  }
  const gateConfig = sizeGateConfigFor(sizeGateOverrides, config, prIgnore);
  const effectiveDiff = skipPlannedDiscovery
    ? {
        patch: "",
        droppedPaths: [] as string[],
        exclusions: [] as ExcludedPath[],
      }
    : filterDiffByIgnoreRules(rawDiff, gateConfig.excludeRules);
  if (
    prepared.plan.emptyDeltaIsError &&
    effectiveDiff.patch.trim().length === 0
  ) {
    throw new CliError(
      effectiveDiff.droppedPaths.length > 0
        ? allExcludedMessage(effectiveDiff.droppedPaths)
        : emptyDiffMessage(baseRef, headLabel, false),
    );
  }
  const skipDiscovery =
    skipPlannedDiscovery || effectiveDiff.patch.trim().length === 0;
  const rereview = toRereviewProvenance(prepared, postedFindings.length);
  if (rereview !== undefined && skipDiscovery) {
    rereview.discovery_skipped_empty_delta = true;
    // pr-hero review #286 finding: this flag alone cannot tell a reader WHY
    // discovery is empty, and the two reasons need different wording — see
    // `RereviewProvenance.discovery_skip_reason`'s own WHY. `skipPlannedDiscovery`
    // is the (a) branch (case B / case C's empty restricted intersection,
    // decided before any diff was even read); anything reaching here with
    // `skipPlannedDiscovery` false got a REAL diff that `filterDiffByIgnoreRules`
    // then emptied out — but ONLY when it actually dropped something. A
    // `git diff` that came back empty on its own (no exclusions recorded)
    // is still "nothing to discover", not "everything was excluded".
    rereview.discovery_skip_reason =
      !skipPlannedDiscovery && effectiveDiff.droppedPaths.length > 0
        ? "all_excluded"
        : "no_delta";
    if (rereview.discovery_skip_reason === "all_excluded") {
      rereview.discovery_excluded_paths = effectiveDiff.droppedPaths;
    }
  }

  let verifyQueue: ReturnType<typeof buildPhaseBQueue>["queued"] = [];
  let overlapCandidates: ReturnType<
    typeof buildPhaseBQueue
  >["overlapCandidates"] = [];
  let phaseB: PrDiscoveryResult["phaseB"];
  let adjudicationSubjects: AdjudicationSubject[] = [];
  const lastHeadDelta = decideLastHeadDelta({
    case: prepared.case,
    L: prepared.last.L,
  });
  if (lastHeadDelta.kind !== "none") {
    // A force-pushed L is gone from this clone, so there is no L..H delta to
    // read and asking git for one is the crash this branch exists to avoid.
    // Case E already planned a FULL review; an empty name-status keeps Phase
    // B running over it, and classifyPrior's D/E branch queues every prior
    // for verification before it would ever consult `touched`. Losing the
    // deletion/rename settling that a real name-status buys therefore costs
    // a verify spawn, never a dropped prior.
    if (lastHeadDelta.kind === "unreachable") {
      const degraded = unreachableLastHeadMessage(lastHeadDelta.sha);
      log(isCi ? formatWorkflowCommand("notice", degraded) : degraded);
    } else if (lastHeadDelta.kind === "diff" && !prepared.last.lastComplete) {
      // The incomplete-review notice, same mechanism and "said once, in CI
      // and out" rule as the unreachable one above — case E's unreachable
      // message already explains "full review, re-verify everything" for
      // that case, so this covers exactly the cases the unreachable branch
      // does not: a forced-full B/C re-review because the LAST review (not
      // this one) never finished.
      const incomplete = incompleteLastReviewMessage(lastHeadDelta.from);
      log(isCi ? formatWorkflowCommand("notice", incomplete) : incomplete);
    }
    const nameStatus = parseNameStatus(
      lastHeadDelta.kind === "diff"
        ? await git.nameStatus(lastHeadDelta.from, headSha)
        : "",
    );
    const summaryComment =
      existingSummaryId === null
        ? undefined
        : issueComments.find((c) => c.id === existingSummaryId);
    const summaryUpdatedAt = summaryComment?.updated_at ?? null;
    const state = parseStateBlock(summaryComment?.body ?? "");
    // #206: `postedFindings` (PostedFindingComment[]) never carries the raw
    // comment body — only the parsed marker fields (findingMarker signs the
    // claim's fingerprint, never the claim text) — so recovering a fallback
    // prior's real sev/tier/claim needs the body looked up from whichever
    // fetch actually produced this comment. Built once, not per-item.
    //
    // Two maps, never one: review comments and issue comments are different
    // GitHub resources from different endpoints, and nothing documents that
    // their numeric ids share a namespace. A single map keyed by id alone
    // would let a colliding issue comment silently hand this prior ANOTHER
    // finding's sev/tier/claim — a plausible wrong value, which is worse than
    // the UNRECOVERABLE sentinel this recovery exists to fall back on.
    // `p.channel` already says which endpoint produced each posted finding.
    const reviewBodyById = new Map<number, string>(
      reviewComments.map((c) => [c.id, c.body] as const),
    );
    const issueBodyById = new Map<number, string>(
      issueComments.map((c) => [c.id, c.body] as const),
    );
    const rawPriors =
      state === null
        ? priorsFromPostedMarkers(
            postedFindings.map((p) => ({
              path: p.livePath ?? p.marker.path,
              line: p.liveLine ?? p.marker.line,
              channel: p.channel === "issue" ? "outside" : "inline",
              body:
                (p.channel === "issue"
                  ? issueBodyById.get(p.id)
                  : reviewBodyById.get(p.id)) ?? "",
            })),
          )
        : priorsFromStateFindings(state.findings);
    const priors = enrichPriorsFromThreads({
      priors: rawPriors,
      posted: postedFindings,
      replies: reviewComments,
      summaryUpdatedAt,
    });
    const classified = buildPhaseBQueue({
      case: prepared.case,
      priors,
      nameStatus,
      summaryUpdatedAt,
      // Rereview-coverage wiring fix: `plan.verifyAll` was computed but
      // never read anywhere in production — classifyPrior only ever forced
      // verify_all off `case === "D" || "E"`, and decideRereviewCase stays
      // UNCHANGED by this fix (the case stays B/C, only discovery widens,
      // per R2-C5). Without this, `verifyAll: true` on a forced-full case
      // B/C would be a silent no-op and the refuter-failed prior would
      // never be re-verified.
      verifyAll: prepared.plan.verifyAll,
    });
    verifyQueue = classified.queued;
    overlapCandidates = classified.overlapCandidates;
    phaseB = { settled: classified.settled, priors };
    // T5b: only a `--adjudicate` run pays for adjudicator calls. The priors
    // here are the enriched ones, so a dismissal's thread and CI verdict are
    // already bound.
    adjudicationSubjects = adjudicate === true ? adjudicationQueue(priors) : [];
    if (rereview !== undefined) {
      rereview.prior_findings = priors.length;
      rereview.settled_deterministically = classified.settled.filter(
        (s) => s.status !== "queued",
      ).length;
    }
  }

  // pr-hero review #286 finding: the discovery-skip notice used to print
  // BEFORE this block ran, when `verifyQueue` did not exist yet — an empty
  // notice claiming "not re-verified now" while case B's `applied`/
  // `case_b_reply` triggers or case C's `touched()` (rereview/classify.ts)
  // may have just queued priors for the SAME pass's verifier. Printed here,
  // after the queue is a real, final number, the same "said once, in CI and
  // out" rule as the unreachable/incomplete notices above.
  if (rereview !== undefined && skipDiscovery) {
    const skipped = skippedDiscoveryMessage({
      headSha,
      reason: rereview.discovery_skip_reason ?? "no_delta",
      excludedPaths: rereview.discovery_excluded_paths ?? [],
      queuedForVerification: verifyQueue.length,
      maxVerificationSteps: resolveMaxVerificationSteps(config),
    });
    log(isCi ? formatWorkflowCommand("notice", skipped) : skipped);
  }

  let diffStat: DiffStat;
  let sizeGate: SizeGateVerdict;
  if (skipDiscovery) {
    diffStat = { files: 0, insertions: 0, deletions: 0 };
    sizeGate = evaluateSizeGate([], gateConfig);
  } else {
    // See computeDiffStatAndSizeGate (src/review/run.ts) for the full
    // rationale.
    ({ diffStat, sizeGate } = await computeDiffStatAndSizeGate({
      runGit: git.runGit,
      range: discoveryRange,
      pathArgs,
      gateConfig,
    }));
  }

  return {
    prepared,
    skipDiscovery,
    rawDiff,
    effectiveDiff,
    gateConfig,
    rereview,
    verifyQueue,
    overlapCandidates,
    adjudicationQueue: adjudicationSubjects,
    phaseB,
    diffStat,
    sizeGate,
  };
}
