import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertRunMatchesPr } from "#ci/gates";
import { resolveRepoRoot } from "#git/git";
import {
  fetchPostedFindingComments,
  fetchPrComments,
  fetchPrReviewComments,
  ghCurrentBranchPr,
  ghPrWebUrl,
  ghRepoNameWithOwner,
  ghRepoWebUrl,
  postIssueTriageComment,
  postReviewCommentReply,
  resolveReviewThreadForComment,
} from "#pr/pr";
import { buildPrStatus } from "#pr/pr-status";
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
import { log } from "#ui/primitives";
import { matchMarkerPrefix } from "../brand";
import { CliError, CliUsageError } from "../errors";
import { tryOriginRepoId } from "../home";
import { prheroLayout } from "../home-preflight";

// `crysk triage reply --pr <n> [--from <run-dir>] --finding <id> ...`: the
// only triage verb. It posts one triage reply, records the verdict in the
// product store, and resolves the thread. The bare `triage --pr --from` verb
// that bound verdicts into comparison.json is retired: new
// verdicts live only in finding_triage. The shell/pure split is unchanged:
// triage/triage.ts renders the marker, triage/reply.ts decides the binding,
// and runTriageReplyCommand does the read/fetch/write. It is exported and
// spawnFn-injectable for the same CRIT-B reason runPostCommand is
// (verify-report-pr3 #3305): a dry-run branch that could not be proven
// gh-free is not a $0 gate.
export async function triageCommand(options: CliOptions): Promise<number> {
  if (options.triage !== "reply") {
    throw new CliUsageError(
      "triage needs a subcommand: use `crysk triage reply` (the bare " +
        "`triage --pr --from` verb was removed with comparison.json)",
    );
  }
  const operatorRoot = await resolveRepoRoot(options.repo);
  // parseArgs already enforces both of these for the "triage" command; the
  // checks here are the type-narrowing TypeScript needs, not new validation.
  if (options.pr === undefined) {
    throw new CliUsageError("triage requires --pr <n>");
  }
  const prNumber =
    options.pr === "current"
      ? resolveCurrentPrNumber(await ghCurrentBranchPr(operatorRoot))
      : options.pr;
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

// triage-without-skill S2: the finding a reply answers, read off the PR alone. The summary's state block
// names the id, the posted finding comment carries the head it was posted on, and the join is the one
// `crysk status --pr` makes (pr/pr-status.ts), so an agent with no run directory replies by id.
async function postedFindingFromPr(
  operatorRoot: string,
  prNumber: number,
  findingId: string,
  spawnFn: typeof Bun.spawn | undefined,
): Promise<{
  parent: { id: number; channel: "review" | "issue" };
  headSha: string;
}> {
  const issueComments = await fetchPrComments(operatorRoot, prNumber, {
    spawnFn,
  });
  const reviewComments = await fetchPrReviewComments(operatorRoot, prNumber, {
    spawnFn,
  });
  const status = buildPrStatus({
    pr: prNumber,
    head: "",
    nowMs: Date.now(),
    statuses: [],
    issueComments,
    reviewComments,
    adjudicatorTrust: { kind: "local" },
  });
  const finding = status.findings.find((row) => row.id === findingId);
  if (finding === undefined) {
    throw new CliUsageError(
      `PR #${prNumber} has no posted finding ${findingId}: run ` +
        `\`crysk status --pr ${prNumber} --json\` for its R### ids, or pass --from <run-dir> for an F### id`,
    );
  }
  if (finding.comment_id === null || finding.head === null) {
    throw new CliError(
      `${findingId} on PR #${prNumber} has no comment thread to reply to ` +
        "(it lives only in the summary)",
    );
  }
  return {
    parent: {
      id: finding.comment_id,
      channel: finding.channel === "inline" ? "review" : "issue",
    },
    headSha: finding.head,
  };
}

async function readReasoning(bodyFile: string): Promise<string> {
  const bodyPath = path.resolve(bodyFile);
  if (!existsSync(bodyPath)) {
    throw new CliUsageError(`--body-file not found: ${bodyPath}`);
  }
  const reasoning = await Bun.file(bodyPath).text();
  if (matchMarkerPrefix(reasoning, TRIAGE_MARKER_PREFIX) !== undefined) {
    throw new CliUsageError(
      "--body-file must be reasoning prose only — the driver prepends the " +
        "triage marker and badge (do not start the file with " +
        "`<!-- crysk-triage`)",
    );
  }
  return reasoning;
}

// The posted finding a reply binds to and the head its marker names, read from a completed run
// directory: the finding row by id, matched to its posted comment by marker.
async function postedFindingFromRunDir(input: {
  operatorRoot: string;
  prNumber: number;
  runDir: string;
  findingId: string;
  bodyFile: string;
  spawnFn: typeof Bun.spawn | undefined;
}): Promise<{
  parent: { id: number; channel: "review" | "issue" };
  headSha: string;
  reasoning: string;
}> {
  const { operatorRoot, prNumber, runDir, spawnFn } = input;
  const findingsPath = path.join(runDir, "findings.json");
  if (!existsSync(findingsPath)) {
    throw new CliUsageError(
      `${runDir} is missing findings.json — point --from at a completed ` +
        'PR-mode run directory ("crysk review --pr <n>" writes it)',
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
  const reasoning = await readReasoning(input.bodyFile);
  // anchor.patch first, as in post --from: the diff the finding's line is
  // matched against must be the one inline comments anchor on.
  const anchorPath = path.join(runDir, "anchor.patch");
  const diffPath = existsSync(anchorPath)
    ? anchorPath
    : path.join(runDir, "diff.patch");
  if (!existsSync(diffPath)) {
    throw new CliUsageError(
      `${runDir} is missing diff.patch — point --from at a completed ` +
        'PR-mode run directory ("crysk review --pr <n>" writes it)',
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
      `no posted <!-- crysk-finding (or <!-- pr-hero-finding) marker matches ${input.findingId} ` +
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
  return { parent: match.posted, headSha: doc.head_sha, reasoning };
}

export async function runTriageReplyCommand(input: {
  operatorRoot: string;
  pr: number;
  // A completed run directory, or undefined to read the finding off the PR (S2).
  from?: string;
  findingId: string;
  tag: TriageTag;
  bodyFile: string;
  verdict?: TriageVerdict;
  issue?: number;
  dryRun: boolean;
  spawnFn?: typeof Bun.spawn;
}): Promise<number> {
  const { operatorRoot, pr: prNumber, dryRun, spawnFn } = input;
  const runDir =
    input.from === undefined ? undefined : path.resolve(input.from);
  const target =
    runDir === undefined
      ? {
          ...(await postedFindingFromPr(
            operatorRoot,
            prNumber,
            input.findingId,
            spawnFn,
          )),
          reasoning: await readReasoning(input.bodyFile),
        }
      : await postedFindingFromRunDir({
          operatorRoot,
          prNumber,
          runDir,
          findingId: input.findingId,
          bodyFile: input.bodyFile,
          spawnFn,
        });
  const { parent, headSha, reasoning } = target;
  const fields: TriageMarkerFields = {
    tag: input.tag,
    headSha,
    actor: "agent",
    verdict: input.verdict,
    issue: input.issue,
  };
  const body = renderTriageReplyBody(fields, reasoning);
  const reviewComments = await fetchPrReviewComments(operatorRoot, prNumber, {
    spawnFn,
  });
  const already = existingTriageAtHead({
    parentId: parent.id,
    headSha,
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
    // A reply read off the PR has no run to record against.
    if (runDir !== undefined && existsSync(layout.prheroDbPath)) {
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
          "Re-run the same `crysk triage reply` command to retry resolve " +
          "only — same-head skip will not double-post.",
      );
    }
    throw error;
  }
  return 0;
}
