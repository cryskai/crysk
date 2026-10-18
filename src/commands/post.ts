import { existsSync } from "node:fs";
import path from "node:path";
import { assertRunMatchesPr } from "#ci/gates";
import { resolveRepoRoot } from "#git/git";
import { postingExitCode } from "#pr/inline";
import {
  ghCurrentBranchPr,
  ghRepoWebUrl,
  missingRereviewBlockMessage,
  postInlineFindings,
  resolveInlinePostPlan,
  vanishedPriorSummaryMessage,
  writePostReceipt,
} from "#pr/pr";
import { resolveCurrentPrNumber } from "#pr/preflight";
import {
  type RereviewProvenance,
  readRereviewProvenance,
} from "#rereview/prepare";
import { validateFindingsDocument } from "#review/findings";
import type { CliOptions } from "#review/preflight";
import { log } from "#ui/primitives";
import { CliError, CliUsageError } from "../errors";

// `pr-hero post --pr <n> --from <run-dir> [--dry-run]` (ROADMAP B6, spec
// "Offline replay via `post` verb"): the `ledger` verb's precedent — read a
// prior run's artifacts off disk — applied to publishing instead of
// aggregating. Exists because PR-mode `--dry-run` returns at reviewPr's own
// step 3, BEFORE any findings exist (see the comment there): it is
// structurally impossible for `--pr --dry-run` to preview a comment plan, so
// this verb is the only way to preview one at $0.
//
// `postCommand` itself stays unexported and untestable on purpose — it is
// nothing but `resolveRepoRoot` (a real `git rev-parse`) plus flag
// narrowing. Everything that can actually go wrong (dry-run vs live, the
// run-status guard, `assertRunMatchesPr`, the receipt) lives in
// `runPostCommand`, exported and `spawnFn`-injectable on EVERY gh-touching
// path including dry-run (CRIT-B, verify-report-pr3 #3305: an unexported
// verb whose dry-run branch never threaded spawnFn could not be proven not
// to reach a real `gh` — this is the $0 gate standing in front of the first
// live GitHub write this project will ever make, and it must not be
// possible to invert it with a green suite).
export async function postCommand(options: CliOptions): Promise<number> {
  const operatorRoot = await resolveRepoRoot(options.repo);
  // parseArgs already enforces both of these for the "post" command; the
  // checks here are the type-narrowing TypeScript needs, not new validation.
  if (options.pr === undefined) {
    throw new CliUsageError("post requires --pr <n>");
  }
  if (options.from === undefined) {
    throw new CliUsageError("post requires --from <run-dir>");
  }
  const prNumber =
    options.pr === "current"
      ? resolveCurrentPrNumber(await ghCurrentBranchPr(operatorRoot))
      : options.pr;
  return runPostCommand({
    operatorRoot,
    pr: prNumber,
    from: options.from,
    dryRun: options.dryRun,
  });
}

export async function runPostCommand(input: {
  operatorRoot: string;
  pr: number;
  from: string;
  dryRun: boolean;
  spawnFn?: typeof Bun.spawn;
}): Promise<number> {
  const { operatorRoot, pr: prNumber, dryRun, spawnFn } = input;
  const runDir = path.resolve(input.from);
  const findingsPath = path.join(runDir, "findings.json");
  // anchor.patch is the full PR diff inline comments anchor against; run dirs
  // from before it existed only have diff.patch (the push delta on a re-review).
  const anchorPath = path.join(runDir, "anchor.patch");
  const diffPath = existsSync(anchorPath)
    ? anchorPath
    : path.join(runDir, "diff.patch");
  if (!existsSync(findingsPath) || !existsSync(diffPath)) {
    throw new CliUsageError(
      `${runDir} is missing findings.json or diff.patch — point --from at ` +
        'a completed run directory ("pr-hero review --pr <n>" writes both)',
    );
  }
  const doc = validateFindingsDocument(
    JSON.parse(await Bun.file(findingsPath).text()),
  );
  // Design Threat Matrix, "Git repository selection" row (deferred from
  // PR2's verification, WARN-1's scope note): --from names a directory, and
  // a directory is not the PR it was reviewed for — reject a run-dir whose
  // OWN artifact disagrees with --pr rather than silently publishing PR
  // #17's findings to PR #18 because someone reused a stale --from.
  assertRunMatchesPr(doc, prNumber, runDir);
  const diffPatch = await Bun.file(diffPath).text();
  // Juanma's decision (verify-report-pr3, #3305): guard on the PERSISTED
  // `sessionFailed`, matching `--pr --post` (cli.ts's `postInlineIfEligible`
  // call, guarded on `result.sessionFailed`) exactly — a partial run with
  // findings from SOME hunters still publishes, same as the live path.
  //
  // Back-compat is mandatory: `sessionFailed` is additive/optional
  // (review/findings.ts), so a run written before this change has no such field.
  // Absent MUST mean "unknown", never "false" — falling back to `false`
  // would publish a dead run's clean bill. The fallback is today's
  // conservative proxy, `run_status !== "complete"`: every genuinely
  // sessionFailed run IS "partial" (mergeRunEnvelope forces it), so the
  // proxy never UNDER-fires; it can only OVER-fire on a partial run that
  // failed for some other reason, which is still the honest "do not publish
  // this as a clean review" answer.
  const sessionFailedEquivalent =
    doc.sessionFailed ?? doc.run_status !== "complete";
  if (sessionFailedEquivalent) {
    log(
      `post skipped: ${findingsPath} is not a complete run ` +
        `(run_status=${doc.run_status}), so there is no review to publish`,
    );
    return dryRun ? 0 : 1;
  }

  // Item 7, and the reason this block exists at all: a re-review's case,
  // `live[]` and verified-gone count live ONLY in the run's `pipeline.json`
  // once the process that computed them has exited. Read back here, they make
  // `post --from`'s summary say what the review actually checked; NOT read
  // back — the defect this repairs — the summary silently falls through to
  // `MatchResult.resolved`, prints "3 resolved" for 2 checks, and writes no
  // state block, which then costs the NEXT run its priors as well.
  //
  // Validated rather than trusted: a block that half-parses would feed the
  // same fallback with none of the noise. Absent is a legitimate answer (a
  // first review, or a run dir from before item 7) — the precondition inside
  // `postInlineFindings` is what tells those apart from a re-review whose
  // block went missing, because only it can see whether the PR already has a
  // summary.
  const pipelinePath = path.join(runDir, "pipeline.json");
  let rereview: RereviewProvenance | undefined;
  if (existsSync(pipelinePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Bun.file(pipelinePath).text());
    } catch (error) {
      throw new CliError(
        `${pipelinePath} is not valid JSON (${(error as Error).message}) — ` +
          "a re-review's case and live findings are only recoverable from it",
      );
    }
    const read = readRereviewProvenance(parsed);
    if (read.kind === "invalid") {
      throw new CliError(
        `${pipelinePath} has an unreadable re-review block (${read.problem}) — ` +
          "publishing it would report the old absence matcher's counts and " +
          `write no state block. Re-run \`pr-hero review --pr ${prNumber} --post\`.`,
      );
    }
    if (read.kind === "ok") rereview = read.rereview;
  }

  // The one field of the `--pr --post` call that a run directory genuinely
  // cannot supply. Collapse binds every verified-gone id to its review thread
  // through the FULL prior set (`bindPriorsToPosted`, one-to-one over carried
  // priors too) — and `live[]` is not that set: `assembleLive` retires a
  // verified-gone entry from it, by design (§3.6), so the very rows collapse
  // needs are the rows the artifact no longer holds. Re-deriving them from
  // the PR at post time is not a substitute either: the `state === null`
  // fallback renumbers `R###` positionally, so ids from `resolved_ids` would
  // point at whichever comments happen to sit in those positions now — the
  // exact over-match that puts "✅ RESOLVED · verified gone" on a live
  // finding.
  //
  // So: nothing verified gone → `[]` is the whole truth and collapse is a
  // no-op. Something verified gone → refuse, loudly, and name the path that
  // still holds the priors in memory. A `post --from` that published the
  // right summary and silently skipped the collapse it cannot compute would
  // be the third thing this feature forbids.
  const verifiedGoneIds = rereview?.resolved_ids ?? [];
  if (verifiedGoneIds.length > 0) {
    throw new CliError(
      `${pipelinePath} records ${verifiedGoneIds.length} verified-gone ` +
        `finding(s) (${verifiedGoneIds.join(", ")}), and their prior records ` +
        "are not in the run directory — `live[]` retires a verified-gone " +
        "entry — so `post --from` cannot bind them to their review threads " +
        `to collapse them. Re-run \`pr-hero review --pr ${prNumber} --post\`, ` +
        "which holds the priors from the run that checked them.",
    );
  }

  if (dryRun) {
    const { plan, previousHeadSha, existingSummaryId } =
      await resolveInlinePostPlan({
        operatorRoot,
        pr: prNumber,
        headSha: doc.head_sha,
        doc,
        diffPatch,
        spawnFn,
      });
    // The preview refuses whatever the post would refuse. A dry run that
    // prints a plan for a run dir the live path then rejects is a $0 gate
    // that answered a different question than the one asked.
    if (rereview === undefined && existingSummaryId !== null) {
      throw new CliError(
        missingRereviewBlockMessage(prNumber, existingSummaryId),
      );
    }
    // Both directions, or the preview is only half a gate — and narrowed to
    // `summary_marker` for the same reason the live guard is (S-A).
    if (
      rereview?.last_head_source === "summary_marker" &&
      existingSummaryId === null
    ) {
      throw new CliError(vanishedPriorSummaryMessage(prNumber));
    }
    log(
      `plan: ${plan.reviewComments.length} review comment(s), ` +
        `${plan.issueComments.length} outside diff, ` +
        `${plan.persisting.length} already posted (skipped)` +
        (previousHeadSha === undefined
          ? `, ${plan.resolved.length} resolved`
          : ""),
    );
    if (previousHeadSha === undefined) {
      log(
        `delta: ${plan.delta.resolved} resolved · ${plan.delta.new} new · ` +
          `${plan.delta.persist} persist`,
      );
    } else {
      log(
        `delta: re-review (MatchResult.resolved not shown; gate outcomes only)`,
      );
    }
    for (const finding of plan.reviewComments) {
      log(`  review  ${finding.path}:${finding.line} ${finding.id}`);
    }
    for (const finding of plan.issueComments) {
      log(`  outside ${finding.path}:${finding.line} ${finding.id}`);
    }
    log("dry run: nothing was fetched-for-mutation or posted.");
    return 0;
  }

  const repoWebUrl = await ghRepoWebUrl(operatorRoot, { spawnFn });
  if (repoWebUrl === undefined) {
    log("repo web url unavailable: posting plain locations");
  }
  const outcome = await postInlineFindings({
    operatorRoot,
    pr: prNumber,
    headSha: doc.head_sha,
    doc,
    diffPatch,
    webUrl: repoWebUrl,
    spawnFn,
    ...(rereview === undefined ? {} : { rereview, rereviewPriors: [] }),
    requireRereviewOnPriorSummary: true,
    refuseOnVanishedPriorSummary: true,
  });
  await writePostReceipt(runDir, prNumber, doc.head_sha, outcome);
  log(
    `posted: review ${outcome.reviewOutcome} (${outcome.reviewFindingCount} ` +
      `finding(s)), ${outcome.outsideDiffCount} outside diff, ` +
      `summary ${outcome.summary.action} comment ${outcome.summary.commentId}`,
  );
  // GitHub #39: `post --from` reaches the same `movedHeadSha` re-read inside
  // the post sequence, so it can carry the same disclosure. Unconditional,
  // not chained into the else-if below — a moved head is orthogonal to both a
  // dropped finding and a 422, and can happen alongside either.
  //
  // "Same sequence, therefore same everything" is what this comment used to
  // say, and it was false in a way that cost a live run: the sequence is
  // shared, its INPUTS are not. `--pr --post` hands over the `rereview` block
  // and the phase-B priors it is still holding; this path has only a
  // directory, so it reconstructs the block from `pipeline.json` above,
  // refuses when that block is unreadable or when collapse would need priors
  // it does not have, and passes `requireRereviewOnPriorSummary` so a missing
  // block on a PR that already has a summary cannot be published as a first
  // review. Equivalence here is enforced, never assumed.
  //
  // `refuseOnVanishedPriorSummary` is the other half of that, and it is where
  // the two paths are enforced UNEQUAL: a re-review whose summary has
  // vanished costs this caller nothing to refuse (re-run `review --pr <n>
  // --post` and the answer is correct), while refusing it on `--pr --post`
  // would discard a review already paid for. Set here, unset there.
  if (outcome.movedHeadSha) {
    log(
      `warning: the PR head moved while the review ran — reviewed ` +
        `${doc.head_sha}, head is now ${outcome.movedHeadSha}; the comments ` +
        "are pinned to the reviewed commit",
    );
  }
  if (outcome.droppedFindingIds.length > 0) {
    log(
      `error: ${outcome.droppedFindingIds.length} finding(s) reached ` +
        `neither channel: ${outcome.droppedFindingIds.join(", ")}`,
    );
  } else if (outcome.reviewOutcome === "demoted") {
    log(
      "warning: the review submission was rejected (422) and recovered " +
        "into the summary Outside Diff bucket",
    );
  }
  return postingExitCode(outcome);
}
