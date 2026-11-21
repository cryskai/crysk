import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertRunMatchesPr } from "#ci/gates";
import { resolveRepoRoot } from "#git/git";
import {
  fetchPostedFindingComments,
  ghCurrentBranchPr,
  ghPrWebUrl,
  ghRepoNameWithOwner,
  ghRepoWebUrl,
  postIssueTriageComment,
  postReviewCommentReply,
  resolveReviewThreadForComment,
} from "#pr/pr";
import type { PrStatusFinding } from "#pr/pr-status";
import {
  findTrustedMarkedCommentId,
  resolveCurrentPrNumber,
} from "#pr/preflight";
import { validateFindingsDocument } from "#review/findings";
import type { CliOptions } from "#review/preflight";
import { openProductStore, recordFindingTriage } from "#store/store";
import {
  decideThreadResolve,
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
import { type MarkerTrust, markerTrust } from "../trust/marker-trust";
import { resolveMarkerTrust } from "../trust/resolve";
import { readPrStatus } from "./status";

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

// Where a reply goes: the finding's own comment thread, or, for a finding with no comment of its own,
// a top-level comment that names the summary row it is listed in.
type ReplyTarget =
  | { kind: "thread"; parent: { id: number; channel: "review" | "issue" } }
  // A finding with no comment of its own: answered by a top-level comment that names its row.
  | {
      kind: "row";
      rowId: string;
      summaryId: number;
      path: string;
      line: number;
    };

// The tag this finding is already answered with at `headSha`, or null. Only the newest reply the gate
// counts makes a second one a repeat: status's `triage` is that reply, read with the same verdict time
// and the same author rule as the gate.
function answeredTagAt(
  finding: Pick<PrStatusFinding, "triage"> | undefined,
  headSha: string,
): TriageTag | null {
  const triage = finding?.triage ?? null;
  return triage !== null && triage.head === headSha ? triage.tag : null;
}

// triage-without-skill S2: the finding a reply answers, read off the PR alone. The summary's state block
// names the id, the summary carries the head the review ran on, and the join is the one
// `crysk status --pr` makes (pr/pr-status.ts), so an agent with no run directory replies by id.
async function postedFindingFromPr(
  operatorRoot: string,
  prNumber: number,
  findingId: string,
  spawnFn: typeof Bun.spawn | undefined,
  sleepFn: (ms: number) => Promise<void>,
): Promise<{
  target: ReplyTarget;
  headSha: string;
  answeredTag: TriageTag | null;
  blocking: boolean;
}> {
  // The read `crysk status` makes, so the reply is decided on the replies the gate counts.
  const read = await readPrStatus({
    operatorRoot,
    pr: prNumber,
    nowMs: Date.now(),
    spawnFn,
    sleepFn,
    memo: { writers: new Map() },
    countForcedRuns: false,
  });
  const status = read.status;
  const issueComments = read.issueComments;
  const finding = status.findings.find((row) => row.id === findingId);
  if (finding === undefined) {
    throw new CliUsageError(
      `PR #${prNumber} has no posted finding ${findingId}: run ` +
        `\`crysk status --pr ${prNumber} --json\` for its R### ids, or pass --from <run-dir> for an F### id`,
    );
  }
  if (finding.comment_id !== null) {
    // WHY the summary's head and not the comment's: a finding carried from an earlier review keeps the
    // comment, and so the head, of the review that first posted it. A reply names the review it answers;
    // stamped with the comment's head, a second round would find the first round's reply and skip, and
    // the finding could never be answered again. With no summary there is only the comment's head.
    const headSha = status.report.head ?? finding.head;
    if (headSha === null) {
      throw new CliError(
        `${findingId} on PR #${prNumber} has no review head to answer under`,
      );
    }
    return {
      target: {
        kind: "thread",
        parent: {
          id: finding.comment_id,
          channel: finding.channel === "inline" ? "review" : "issue",
        },
      },
      headSha,
      answeredTag: answeredTagAt(finding, headSha),
      blocking: finding.blocking,
    };
  }
  // The summary status read: a summary-shaped comment from anyone else is not linked to.
  const summaryId = findTrustedMarkedCommentId(
    issueComments,
    markerTrust(read.trustedActors),
  );
  if (
    summaryId === null ||
    status.report.head === null ||
    finding.id === null
  ) {
    throw new CliError(
      `${findingId} on PR #${prNumber} has no comment and the pull request has no review summary to answer it in`,
    );
  }
  const headSha = status.report.head;
  return {
    target: {
      kind: "row",
      rowId: finding.id,
      summaryId,
      path: finding.path,
      line: finding.line,
    },
    headSha,
    // A summary-row reply is answered by the newest counted reply that names the row, at this head.
    answeredTag: answeredTagAt(finding, headSha),
    blocking: finding.blocking,
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

// The summary's live rows with a comment on this path, for the message of a finding no comment of
// this run carries. Best effort: the message stands without it.
async function carriedRowsHint(input: {
  operatorRoot: string;
  prNumber: number;
  findingPath: string;
  spawnFn: typeof Bun.spawn | undefined;
  sleepFn: (ms: number) => Promise<void>;
}): Promise<string> {
  try {
    const { status } = await readPrStatus({
      operatorRoot: input.operatorRoot,
      pr: input.prNumber,
      nowMs: Date.now(),
      spawnFn: input.spawnFn,
      sleepFn: input.sleepFn,
      memo: { writers: new Map() },
      countForcedRuns: false,
    });
    const rows = status.findings
      .filter((row) => row.id !== null && row.path === input.findingPath)
      .map((row) => `${row.id} (${row.path}:${row.line})`);
    return rows.length === 0 ? "" : ` On this path: ${rows.join(", ")}.`;
  } catch {
    return "";
  }
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
  sleepFn: (ms: number) => Promise<void>;
  markerTrust: MarkerTrust | undefined;
}): Promise<{
  target: ReplyTarget;
  headSha: string;
  reasoning: string;
  answeredTag: TriageTag | null;
  blocking: boolean;
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
  // Only a trusted author's finding comment can be bound (src/trust/marker-trust.ts), so the poster
  // `trustPosterOf` adds below is never someone who typed the marker by hand.
  const trust =
    input.markerTrust ?? (await resolveMarkerTrust({ operatorRoot, spawnFn }));
  const posted = await fetchPostedFindingComments(
    operatorRoot,
    prNumber,
    trust,
    {
      spawnFn,
    },
  );
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
    const carried = await carriedRowsHint({
      operatorRoot,
      prNumber,
      findingPath: finding.path,
      spawnFn,
      sleepFn: input.sleepFn,
    });
    throw new CliError(
      `no posted <!-- crysk-finding (or <!-- pr-hero-finding) marker matches ${input.findingId} ` +
        `on PR #${prNumber} (${lineHint}, head ${doc.head_sha.slice(0, 8)}). ` +
        "A finding with no comment on this head (carried from an earlier review, or listed only in the summary) " +
        "is answered by its R### id, without --from " +
        `(\`crysk status --pr ${prNumber} --json\` lists the ids).${carried} ` +
        "Bind by marker, never by a GitHub comment id or the nearest line",
    );
  }
  if (match.kind === "ambiguous") {
    throw new CliError(
      `multiple posted finding comments match ${input.findingId} ` +
        `(ids ${match.ids.join(", ")}) — will not pick by proximity`,
    );
  }
  // The same read `crysk status` makes: a repeat only when the newest reply the gate counts for this
  // finding already answers this review.
  const read = await readPrStatus({
    operatorRoot,
    pr: prNumber,
    nowMs: Date.now(),
    spawnFn,
    sleepFn: input.sleepFn,
    memo: { writers: new Map() },
    countForcedRuns: false,
    trustPosterOf: { id: match.posted.id, channel: match.posted.channel },
  });
  // WHY the channel too: a review comment's id and an issue comment's id are different id spaces,
  // so the bare number could name another finding's comment.
  const postedChannel = match.posted.channel === "issue" ? "outside" : "inline";
  const postedRow = read.status.findings.find(
    (row) =>
      row.comment_id === match.posted.id && row.channel === postedChannel,
  );
  return {
    target: {
      kind: "thread",
      parent: { id: match.posted.id, channel: match.posted.channel },
    },
    headSha: doc.head_sha,
    reasoning,
    answeredTag: answeredTagAt(postedRow, doc.head_sha),
    // The status row's tier when there is one, else the run's own: unknown blocks (fail closed).
    blocking: postedRow?.blocking ?? finding.tier !== "advisory",
  };
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
  // The wait between the two permission asks. Tests pass an immediate one.
  sleepFn?: (ms: number) => Promise<void>;
  // Who may have written the finding comment `--from` binds to. A seam, like `spawnFn`: absent, it
  // is resolved (src/trust/resolve.ts), the signed-in gh login included.
  markerTrust?: MarkerTrust;
}): Promise<number> {
  const { operatorRoot, pr: prNumber, dryRun, spawnFn } = input;
  // WHY refused: `rejected` says the dismissal does not hold, yet the reply would still read as an
  // answer, resolve the thread and invite a recheck.
  if (input.tag === "dismissed" && input.verdict === "rejected") {
    throw new CliUsageError(
      "--tag dismissed --verdict rejected is refused and nothing was posted: the adjudicator " +
        "rejected the dismissal, so the finding stands. Fix it, or answer it with another tag",
    );
  }
  const runDir =
    input.from === undefined ? undefined : path.resolve(input.from);
  const found =
    runDir === undefined
      ? {
          ...(await postedFindingFromPr(
            operatorRoot,
            prNumber,
            input.findingId,
            spawnFn,
            input.sleepFn ?? Bun.sleep,
          )),
          reasoning: await readReasoning(input.bodyFile),
        }
      : {
          ...(await postedFindingFromRunDir({
            operatorRoot,
            prNumber,
            runDir,
            findingId: input.findingId,
            bodyFile: input.bodyFile,
            spawnFn,
            sleepFn: input.sleepFn ?? Bun.sleep,
            markerTrust: input.markerTrust,
          })),
        };
  const { target: replyTarget, headSha, reasoning, answeredTag } = found;
  // WHY only on a blocking finding: deferred and misclassified never clear the gate, so on an
  // advisory finding an adjudicator rules on nothing. On a blocking one the ruling is the record a
  // maintainer reads before overriding. A finding whose tier cannot be read counts as blocking.
  if (
    (input.tag === "deferred" || input.tag === "misclassified") &&
    input.verdict === undefined &&
    found.blocking
  ) {
    throw new CliUsageError(
      `${input.findingId} is blocking, so --tag ${input.tag} requires --verdict ` +
        "(upheld, rejected, or inconclusive) from the isolated adjudicator, and nothing was posted",
    );
  }
  // WHY refused rather than skipped: the skip below is the retry path of the same answer, and a changed
  // answer dropped there exits 0 while GitHub keeps the old one. A dry run reports the same refusal.
  if (answeredTag !== null && answeredTag !== input.tag) {
    throw new CliError(
      `${input.findingId} is already answered ${answeredTag} at head ${headSha.slice(0, 7)}, so --tag ${input.tag} was refused and nothing was posted. A finding keeps one answer per review: it can be answered again after the next review`,
    );
  }
  const already = answeredTag !== null;
  const fields: TriageMarkerFields = {
    tag: input.tag,
    headSha,
    actor: "agent",
    verdict: input.verdict,
    issue: input.issue,
    ...(replyTarget.kind === "row" ? { row: replyTarget.rowId } : {}),
  };
  // The visible line a summary-row reply carries in place of the thread it does not have: it names
  // the row and links the summary, the only place the finding is listed.
  let subject: string | undefined;
  if (replyTarget.kind === "row") {
    const pullUrl = await outsidePullUrl(operatorRoot, prNumber, spawnFn);
    const summaryLink =
      pullUrl === undefined
        ? "listed in the review summary"
        : `listed in the [review summary](${pullUrl}#issuecomment-${replyTarget.summaryId})`;
    subject =
      `Finding ${replyTarget.rowId} · \`${replyTarget.path}:${replyTarget.line}\` · ` +
      `outside the diff, ${summaryLink}`;
  }
  const body =
    subject === undefined
      ? renderTriageReplyBody(fields, reasoning)
      : renderTriageReplyBody(fields, reasoning, subject);
  const resolveDecision = decideThreadResolve({
    channel: replyTarget.kind === "row" ? "issue" : replyTarget.parent.channel,
    verdict: input.verdict,
  });
  if (dryRun) {
    if (replyTarget.kind === "row") {
      log(
        `plan: reply to summary row ${replyTarget.rowId} (top-level comment) as ${input.tag}` +
          (already ? " — already triaged at this head, would skip post" : ""),
      );
      log("plan: no review thread to resolve (summary row)");
    } else {
      log(
        `plan: reply to ${replyTarget.parent.channel} comment ${replyTarget.parent.id} ` +
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
    }
    log("dry run: nothing was posted.");
    return 0;
  }
  if (already) {
    log(
      replyTarget.kind === "row"
        ? `skip post: ${input.findingId} already triaged at this head (summary row)`
        : `skip post: ${input.findingId} already triaged at this head ` +
            `(${replyTarget.parent.channel} comment ${replyTarget.parent.id})`,
    );
  } else if (replyTarget.kind === "row") {
    await postIssueTriageComment({
      operatorRoot,
      pr: prNumber,
      body,
      spawnFn,
    });
    log(
      `posted: ${input.tag} on ${input.findingId} (summary row, top-level comment)`,
    );
  } else {
    const parent = replyTarget.parent;
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
  }

  // Persist triage record to canonical product store (idempotent upsert)
  try {
    const layout = prheroLayout(os.homedir());
    // A reply read off the PR has no run to record against, and a summary-row reply has no comment
    // the store could key on.
    if (
      replyTarget.kind === "thread" &&
      runDir !== undefined &&
      existsSync(layout.prheroDbPath)
    ) {
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
              comment_id: replyTarget.parent.id,
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

  // A summary-row reply has no review thread; its decision is always skip-issue-channel.
  if (replyTarget.kind === "row" || resolveDecision !== "resolve") {
    return 0;
  }
  const parent = replyTarget.parent;
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
