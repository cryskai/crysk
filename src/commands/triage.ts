import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertRunMatchesPr } from "#ci/gates";
import { resolveRepoRoot } from "#git/git";
import {
  fetchPostedFindingComments,
  fetchPrComments,
  fetchPrReviewComments,
  ghCollaboratorPermissionRetried,
  ghCurrentBranchPr,
  ghPrWebUrl,
  ghRepoNameWithOwner,
  ghRepoWebUrl,
  postIssueTriageComment,
  postReviewCommentReply,
  resolveReviewThreadForComment,
} from "#pr/pr";
import { buildPrStatus } from "#pr/pr-status";
import { findMarkedCommentId, resolveCurrentPrNumber } from "#pr/preflight";
import { validateFindingsDocument } from "#review/findings";
import type { CliOptions } from "#review/preflight";
import { openProductStore, recordFindingTriage } from "#store/store";
import {
  decideThreadResolve,
  findingIdentityForMarkerMatch,
  matchPostedFindingExact,
  rowTriageAuthorsAtHead,
  triageAuthorsAtHead,
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

// triage-without-skill S2: the finding a reply answers, read off the PR alone. The summary's state block
// names the id, the summary carries the head the review ran on, and the join is the one
// `crysk status --pr` makes (pr/pr-status.ts), so an agent with no run directory replies by id.
async function postedFindingFromPr(
  operatorRoot: string,
  prNumber: number,
  findingId: string,
  spawnFn: typeof Bun.spawn | undefined,
): Promise<{
  target: ReplyTarget;
  headSha: string;
  issueComments: Awaited<ReturnType<typeof fetchPrComments>>;
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
      issueComments,
    };
  }
  const summaryId = findMarkedCommentId(issueComments);
  if (
    summaryId === null ||
    status.report.head === null ||
    finding.id === null
  ) {
    throw new CliError(
      `${findingId} on PR #${prNumber} has no comment and the pull request has no review summary to answer it in`,
    );
  }
  return {
    target: {
      kind: "row",
      rowId: finding.id,
      summaryId,
      path: finding.path,
      line: finding.line,
    },
    headSha: status.report.head,
    issueComments,
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
}): Promise<string> {
  try {
    const issueComments = await fetchPrComments(
      input.operatorRoot,
      input.prNumber,
      {
        spawnFn: input.spawnFn,
      },
    );
    const reviewComments = await fetchPrReviewComments(
      input.operatorRoot,
      input.prNumber,
      { spawnFn: input.spawnFn },
    );
    const status = buildPrStatus({
      pr: input.prNumber,
      head: "",
      nowMs: Date.now(),
      statuses: [],
      issueComments,
      reviewComments,
      adjudicatorTrust: { kind: "local" },
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
}): Promise<{
  target: ReplyTarget;
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
    const carried = await carriedRowsHint({
      operatorRoot,
      prNumber,
      findingPath: finding.path,
      spawnFn,
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
  return {
    target: {
      kind: "thread",
      parent: { id: match.posted.id, channel: match.posted.channel },
    },
    headSha: doc.head_sha,
    reasoning,
  };
}

// Whether one of these logins may answer a finding: the gate counts a triage reply only from a
// login with write access (pr/answered-findings.ts trustedComments), so a marker-shaped comment
// from anyone else is not an answer. Counting it would skip the real reply, and the finding would
// stay open with no reply the gate reads and no way to post one.
// WHY a permission that does not read stops the command: both guesses are wrong. Taking it for
// "no access" posts a duplicate of a real reply, and a second `dismissed` makes an earlier CI
// ruling stop matching; taking it for "access" lets a forged marker block the real reply. Nothing
// is posted and the message says to run it again.
async function someoneMayAnswer(input: {
  operatorRoot: string;
  prNumber: number;
  findingId: string;
  authors: readonly (string | undefined)[];
  spawnFn: typeof Bun.spawn | undefined;
  sleepFn: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const logins = new Set(
    input.authors.filter((login): login is string => login !== undefined),
  );
  const unread: string[] = [];
  for (const login of logins) {
    const permission = await ghCollaboratorPermissionRetried(
      input.operatorRoot,
      login,
      input.spawnFn,
      input.sleepFn,
    );
    if (permission === "admin" || permission === "write") return true;
    if (permission === null) unread.push(login);
  }
  if (unread.length > 0) {
    throw new CliError(
      `${input.findingId} on PR #${input.prNumber} already has a triage reply for this review from ` +
        `${unread.join(", ")}, and GitHub did not return whether that login may answer. ` +
        "Nothing was posted: run the same command again",
    );
  }
  return false;
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
}): Promise<number> {
  const { operatorRoot, pr: prNumber, dryRun, spawnFn } = input;
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
          })),
          issueComments: undefined,
        };
  const { target: replyTarget, headSha, reasoning, issueComments } = found;
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
  let already: boolean;
  if (replyTarget.kind === "thread") {
    const reviewComments = await fetchPrReviewComments(operatorRoot, prNumber, {
      spawnFn,
    });
    already = await someoneMayAnswer({
      operatorRoot,
      prNumber,
      findingId: input.findingId,
      authors: triageAuthorsAtHead({
        parentId: replyTarget.parent.id,
        headSha,
        replies: reviewComments,
      }),
      spawnFn,
      sleepFn: input.sleepFn ?? Bun.sleep,
    });
  } else {
    // The row's replies are top-level comments, read with the summary, so no second fetch.
    if (issueComments === undefined) {
      throw new Error(
        "triage reply: a summary-row target carries the PR's comments",
      );
    }
    already = await someoneMayAnswer({
      operatorRoot,
      prNumber,
      findingId: input.findingId,
      authors: rowTriageAuthorsAtHead({
        rowId: replyTarget.rowId,
        headSha,
        comments: issueComments,
      }),
      spawnFn,
      sleepFn: input.sleepFn ?? Bun.sleep,
    });
  }
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
