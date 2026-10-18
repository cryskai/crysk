import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertRunMatchesPr } from "#ci/gates";
import { parseComparisonJson, type StoredComparison } from "#compare/ledger";
import { resolveRepoRoot } from "#git/git";
import {
  fetchPostedFindingComments,
  fetchPrReviewComments,
  ghCurrentBranchPr,
  ghPrWebUrl,
  ghRepoNameWithOwner,
  ghRepoWebUrl,
  postIssueTriageComment,
  postReviewCommentReply,
  resolveReviewThreadForComment,
} from "#pr/pr";
import { resolveCurrentPrNumber } from "#pr/preflight";
import { validateFindingsDocument } from "#review/findings";
import type { CliOptions } from "#review/preflight";
import { openProductStore, recordFindingTriage } from "#store/store";
import {
  decideThreadResolve,
  existingTriageAtHead,
  findingIdentityForMarkerMatch,
  matchPostedFindingExact,
} from "#triage/reply";
import {
  renderTriageReplyBody,
  TRIAGE_MARKER_PREFIX,
  type TriageMarkerFields,
  type TriageTag,
  type TriageVerdict,
} from "#triage/triage";
import { applyTriageReplies, type TriageReplyCandidate } from "#triage/write";
import { log } from "#ui/primitives";
import { CliError, CliUsageError } from "../errors";
import { tryOriginRepoId } from "../home";
import { prheroLayout } from "../home-preflight";

// `pr-hero triage --pr <n> --from <run-dir> [--dry-run]` (ROADMAP B6c):
// reads the PR's review-comment threads, binds every triage reply (ROADMAP
// B6b's marker) to its finding's row in that run's comparison.json, and
// writes verdict/reasoning/actor back — the ledger's two null columns
// (pr/preflight.ts's ComparisonRow), filled from the loop instead of by
// hand. Same shell/pure split as postCommand: the binding decision lives in
// triage/write.ts (pure), this function is resolveRepoRoot plus flag
// narrowing; runTriageCommand does the actual read/fetch/write and is
// exported + spawnFn-injectable for the same CRIT-B reason runPostCommand
// is (verify-report-pr3 #3305) — a dry-run branch that could not be proven
// gh-free is not a $0 gate.
export async function triageCommand(options: CliOptions): Promise<number> {
  const operatorRoot = await resolveRepoRoot(options.repo);
  // parseArgs already enforces both of these for the "triage" command; the
  // checks here are the type-narrowing TypeScript needs, not new validation.
  if (options.pr === undefined) {
    throw new CliUsageError("triage requires --pr <n>");
  }
  if (options.from === undefined) {
    throw new CliUsageError("triage requires --from <run-dir>");
  }
  const prNumber =
    options.pr === "current"
      ? resolveCurrentPrNumber(await ghCurrentBranchPr(operatorRoot))
      : options.pr;
  if (options.triage === "reply") {
    if (options.finding === undefined) {
      throw new CliUsageError("triage reply requires --finding <id>");
    }
    if (options.tag === undefined) {
      throw new CliUsageError("triage reply requires --tag <tag>");
    }
    if (options.bodyFile === undefined) {
      throw new CliUsageError("triage reply requires --body-file <path>");
    }
    return runTriageReplyCommand({
      operatorRoot,
      pr: prNumber,
      from: options.from,
      findingId: options.finding,
      tag: options.tag,
      bodyFile: options.bodyFile,
      verdict: options.verdict,
      issue: options.issue,
      dryRun: options.dryRun,
    });
  }
  return runTriageCommand({
    operatorRoot,
    pr: prNumber,
    from: options.from,
    dryRun: options.dryRun,
  });
}

export async function runTriageCommand(input: {
  operatorRoot: string;
  pr: number;
  from: string;
  dryRun: boolean;
  spawnFn?: typeof Bun.spawn;
}): Promise<number> {
  const { operatorRoot, pr: prNumber, dryRun, spawnFn } = input;
  const runDir = path.resolve(input.from);
  const comparisonPath = path.join(runDir, "comparison.json");
  if (!existsSync(comparisonPath)) {
    throw new CliUsageError(
      `${runDir} is missing comparison.json — point --from at a completed ` +
        'PR-mode run directory ("pr-hero review --pr <n>" writes it)',
    );
  }
  const raw = await Bun.file(comparisonPath).text();
  let comparison: StoredComparison;
  try {
    comparison = parseComparisonJson(raw);
  } catch (error) {
    // The pure parser names the field; only the shell knows the file.
    if (error instanceof CliUsageError) {
      throw new CliError(`${comparisonPath}: ${error.message}`);
    }
    throw error;
  }
  // Same "don't act on the wrong PR" guard runPostCommand's
  // assertRunMatchesPr gives findings.json — a run-dir named by --from is
  // not the same thing as --pr, and a stale --from must not silently triage
  // the wrong PR's ledger row.
  if (comparison.pr !== prNumber) {
    throw new CliUsageError(
      `${comparisonPath} is for PR ${comparison.pr}, not --pr ${prNumber}`,
    );
  }
  const reviewComments = await fetchPrReviewComments(operatorRoot, prNumber, {
    spawnFn,
  });
  // id -> comment, so a reply's `in_reply_to_id` resolves to its parent in
  // O(1) — both live in the SAME endpoint (pulls/<n>/comments), never
  // fetched separately: reply-threading only exists on inline review
  // comments, GitHub has no `in_reply_to_id` on top-level issue comments.
  const byId = new Map(reviewComments.map((comment) => [comment.id, comment]));
  // `gh api --paginate` returns comments in ascending-id (creation) order —
  // the SAME order applyTriageReplies needs for its last-write-wins rule,
  // so this loop feeds them through unsorted.
  const replies: TriageReplyCandidate[] = [];
  for (const comment of reviewComments) {
    if (comment.in_reply_to_id === null) continue;
    const parent = byId.get(comment.in_reply_to_id);
    // The parent was deleted, or is outside what this fetch saw —
    // applyTriageReplies would reject a missing parent anyway (no body to
    // parse), but skipping here avoids handing it a body that never
    // existed.
    if (parent === undefined) continue;
    replies.push({ parentBody: parent.body, replyBody: comment.body });
  }
  const outcome = applyTriageReplies(comparison.rows, replies);
  if (dryRun) {
    log(
      `plan: ${outcome.bound} row(s) would be triaged, ${outcome.ignored} ` +
        "reply(ies) ignored (not ours, malformed, or no matching row)",
    );
    log("dry run: comparison.json was not written.");
    return 0;
  }
  const updated: StoredComparison = { ...comparison, rows: outcome.rows };
  await Bun.write(comparisonPath, `${JSON.stringify(updated, null, 2)}\n`);
  log(
    `triaged: ${outcome.bound} row(s) written to ${comparisonPath}, ` +
      `${outcome.ignored} reply(ies) ignored`,
  );
  return 0;
}

// The PR's web URL, the base an outside-channel reply's `In reply to:` link is built on. The repo's
// web URL is the first source, as it always was. When that lookup fails, the PR's own URL is
// asked for, then the repo's nameWithOwner on the GitHub host. Only when none of them is known is
// the reply posted without the link. The link is what binds a reply to its finding
// (pr-status.ts repliesTo), so a missing link is the failure this chain exists to avoid.
async function outsidePullUrl(
  operatorRoot: string,
  prNumber: number,
  spawnFn: typeof Bun.spawn | undefined,
): Promise<string | undefined> {
  const repoUrl = await ghRepoWebUrl(operatorRoot, { spawnFn });
  if (repoUrl !== undefined) return `${repoUrl}/pull/${prNumber}`;
  const prUrl = await ghPrWebUrl(operatorRoot, prNumber, { spawnFn });
  if (prUrl !== undefined) return prUrl;
  const nameWithOwner = await ghRepoNameWithOwner(operatorRoot, { spawnFn });
  if (nameWithOwner === undefined) return undefined;
  // `||`, not `??`: an empty GITHUB_SERVER_URL counts as unset here (as in ci/trigger.ts),
  // or the link would have no host.
  const host = process.env.GITHUB_SERVER_URL || "https://github.com";
  return `${host}/${nameWithOwner}/pull/${prNumber}`;
}

export async function runTriageReplyCommand(input: {
  operatorRoot: string;
  pr: number;
  from: string;
  findingId: string;
  tag: TriageTag;
  bodyFile: string;
  verdict?: TriageVerdict;
  issue?: number;
  dryRun: boolean;
  spawnFn?: typeof Bun.spawn;
}): Promise<number> {
  const { operatorRoot, pr: prNumber, dryRun, spawnFn } = input;
  const runDir = path.resolve(input.from);
  const findingsPath = path.join(runDir, "findings.json");
  if (!existsSync(findingsPath)) {
    throw new CliUsageError(
      `${runDir} is missing findings.json — point --from at a completed ` +
        'PR-mode run directory ("pr-hero review --pr <n>" writes it)',
    );
  }
  const doc = validateFindingsDocument(
    JSON.parse(await Bun.file(findingsPath).text()),
  );
  assertRunMatchesPr(doc, prNumber, runDir);
  const finding = doc.findings.find((row) => row.id === input.findingId);
  if (finding === undefined) {
    throw new CliUsageError(
      `${findingsPath} has no finding ${input.findingId}`,
    );
  }
  const bodyPath = path.resolve(input.bodyFile);
  if (!existsSync(bodyPath)) {
    throw new CliUsageError(`--body-file not found: ${bodyPath}`);
  }
  const reasoning = await Bun.file(bodyPath).text();
  if (reasoning.startsWith(TRIAGE_MARKER_PREFIX)) {
    throw new CliUsageError(
      "--body-file must be reasoning prose only — the driver prepends the " +
        "triage marker and badge (do not start the file with " +
        "`<!-- pr-hero-triage`)",
    );
  }
  // anchor.patch first, as in post --from: the diff the finding's line is
  // matched against must be the one inline comments anchor on.
  const anchorPath = path.join(runDir, "anchor.patch");
  const diffPath = existsSync(anchorPath)
    ? anchorPath
    : path.join(runDir, "diff.patch");
  if (!existsSync(diffPath)) {
    throw new CliUsageError(
      `${runDir} is missing diff.patch — point --from at a completed ` +
        'PR-mode run directory ("pr-hero review --pr <n>" writes it)',
    );
  }
  const diffPatch = await Bun.file(diffPath).text();
  const { identity, findingsLine } = findingIdentityForMarkerMatch({
    path: finding.path,
    line: finding.line,
    claim: finding.claim,
    proof_refs: finding.proof_refs,
    diffPatch,
  });
  const fields: TriageMarkerFields = {
    tag: input.tag,
    headSha: doc.head_sha,
    actor: "agent",
    verdict: input.verdict,
    issue: input.issue,
  };
  const body = renderTriageReplyBody(fields, reasoning);
  const posted = await fetchPostedFindingComments(operatorRoot, prNumber, {
    spawnFn,
  });
  const match = matchPostedFindingExact({
    finding: identity,
    headSha: doc.head_sha,
    posted,
  });
  if (match.kind === "none") {
    const lineHint =
      identity.line === findingsLine
        ? `${finding.path}:${identity.line}`
        : `${finding.path}: post line ${identity.line} ` +
          `(findings.json:${findingsLine})`;
    throw new CliError(
      `no posted <!-- pr-hero-finding marker matches ${input.findingId} ` +
        `on PR #${prNumber} (${lineHint}, head ${doc.head_sha.slice(0, 8)}). ` +
        "Bind by marker, never by a GitHub comment id or the nearest line",
    );
  }
  if (match.kind === "ambiguous") {
    throw new CliError(
      `multiple posted finding comments match ${input.findingId} ` +
        `(ids ${match.ids.join(", ")}) — will not pick by proximity`,
    );
  }
  const parent = match.posted;
  const reviewComments = await fetchPrReviewComments(operatorRoot, prNumber, {
    spawnFn,
  });
  const already = existingTriageAtHead({
    parentId: parent.id,
    headSha: doc.head_sha,
    replies: reviewComments,
  });
  const resolveDecision = decideThreadResolve({
    channel: parent.channel,
    verdict: input.verdict,
  });
  if (dryRun) {
    log(
      `plan: reply to ${parent.channel} comment ${parent.id} ` +
        `(${input.findingId}, marker match) as ${input.tag}` +
        (already ? " — already triaged at this head, would skip post" : ""),
    );
    if (resolveDecision === "resolve") {
      log("plan: would resolve the review thread after posting");
    } else if (resolveDecision === "skip-inconclusive") {
      log("plan: would leave the thread open (adjudicator inconclusive)");
    } else {
      log("plan: no review thread to resolve (issue-comment finding)");
    }
    log("dry run: nothing was posted.");
    return 0;
  }
  if (!already) {
    if (parent.channel === "review") {
      await postReviewCommentReply({
        operatorRoot,
        pr: prNumber,
        inReplyTo: parent.id,
        body,
        spawnFn,
      });
    } else {
      const pullUrl = await outsidePullUrl(operatorRoot, prNumber, spawnFn);
      const withLink =
        pullUrl === undefined
          ? body
          : `${body.trimEnd()}\n\nIn reply to: ${pullUrl}#issuecomment-${parent.id}\n`;
      await postIssueTriageComment({
        operatorRoot,
        pr: prNumber,
        body: withLink,
        spawnFn,
      });
    }
    log(
      `posted: ${input.tag} on ${input.findingId} ` +
        `(${parent.channel} comment ${parent.id})`,
    );
  } else {
    log(
      `skip post: ${input.findingId} already triaged at this head ` +
        `(${parent.channel} comment ${parent.id})`,
    );
  }

  // Persist triage record to canonical product store (idempotent upsert)
  try {
    const layout = prheroLayout(os.homedir());
    if (existsSync(layout.prheroDbPath)) {
      const repoId = await tryOriginRepoId(operatorRoot);
      if (repoId) {
        const db = openProductStore(layout.prheroDbPath);
        try {
          const runDirBasename = path.basename(runDir);
          const runRow = db
            .query(
              "SELECT id FROM runs WHERE repo_id = ? AND run_dir = ? LIMIT 1",
            )
            .get(repoId, runDirBasename) as { id: number } | null;
          if (runRow) {
            recordFindingTriage(db, {
              run_id: runRow.id,
              finding_id: input.findingId,
              comment_id: parent.id,
              tag: input.tag,
              verdict: input.verdict,
              actor: "agent",
              reasoning,
              issue_number: input.issue,
              created_at: new Date().toISOString(),
            });
          }
        } finally {
          db.close();
        }
      }
    }
  } catch (err) {
    log(
      `warning: failed to record triage in product store: ${(err as Error).message}`,
    );
  }

  if (resolveDecision !== "resolve") {
    return 0;
  }
  // Live #34: the reply POST succeeded, then GraphQL resolve threw and the
  // process exited 1. The skill's rule is never `gh` — say the reply is
  // already on GitHub and the same command retries resolve only.
  try {
    const resolveOutcome = await resolveReviewThreadForComment({
      operatorRoot,
      pr: prNumber,
      commentId: parent.id,
      spawnFn,
    });
    if (resolveOutcome === "resolved") {
      log(`resolved: review thread for ${input.findingId}`);
    } else if (resolveOutcome === "already-resolved") {
      log(`resolved: thread already closed for ${input.findingId}`);
    } else {
      log(`resolve skipped: no review thread found for comment ${parent.id}`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(
        `resolve failed after the reply was on GitHub (${error.message}). ` +
          "Re-run the same `pr-hero triage reply` command to retry resolve " +
          "only — same-head skip will not double-post.",
      );
    }
    throw error;
  }
  return 0;
}
