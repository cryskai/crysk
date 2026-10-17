// A phase-aware fake of the sandbox repository, for the scenario runner. Unlike
// the scripted fakes in fakes.ts, it reacts the way GitHub does: a PR's first push
// or a later push starts a pull_request run on that head, and a PR comment starts
// an issue_comment run that executes main's workflow. The outcome each run posts
// is decided from the workflow on its head, so the runner's expectations are
// checked against what a run would have left behind, not against a script.
//
// The product behaviour it encodes is the minimum the scenarios rely on: no model
// credential input gives PRH-CRED-MISSING, a malformed routing literal gives
// PRH-ROUTING-INVALID, a scaffold gotchas file on the head gives PRH-GOTCHAS-MISSING,
// a review upserts the report for its head and removes the
// outcome comments of earlier runs. Live runs are the proof of the product; this
// fake is the proof of the runner's sequencing and its reads.

import { CANCELLED_STATUS_DESCRIPTION } from "#ci/publish";
import {
  blockingCommitStatusRequest,
  skipCommitStatusRequest,
} from "#pr/preflight";
import { gotchasUnusableReason } from "#review/preflight";
import {
  OVERRIDE_MARKER_PREFIX,
  RUN_STEP_NAME,
  SKIP_MARKERS,
  WORKFLOW_NAME,
} from "../../scripts/sandbox/markers";
import type { GhResult, GitResult } from "../../scripts/sandbox/ports";
import { SANDBOX_REMOTE_URL, SANDBOX_REPO } from "../../scripts/sandbox/rails";
import {
  GOTCHAS_PATH,
  MUTE_PATH,
  sandboxFiles,
  WORKFLOW_PATH,
} from "../../scripts/sandbox/seed";
import {
  fail,
  gitOk,
  type Harness,
  harness,
  type MemoryRunLock,
  ok,
} from "./fakes";

const MAIN_SHA = "f".repeat(40);
const REPO_URL = `https://github.com/${SANDBOX_REPO}`;
const OUTCOME_PREFIX = "<!-- pr-hero-outcome";
const REPORT_PREFIX = "<!-- pr-hero-report";
// How long a fake run takes on the fake clock. Five minutes is well past the
// comment-run clock skew (scripts/sandbox/observe.ts), as a real run is.
const RUN_DURATION_MS = 5 * 60_000;
// A posted blocking finding, shaped the way the product posts one: its marker,
// then the header whose tier word the classifier reads (report.ts findingHeaderLine).
// The head is the reviewed sha, as findingMarker writes it (src/pr/preflight.ts).
const blockingFinding = (head: string): string =>
  `<!-- pr-hero-finding id=F001 path=src/a.ts line=3 head=${head} -->\n\n🔴 blocking · BLOCKER · introduced · reliability`;

interface RunRow {
  databaseId: number;
  headSha: string;
  headBranch: string;
  event: string;
  status: string;
  conclusion: string | null;
  workflowName: string;
  url: string;
  stepConclusion: string;
  prNumber: number;
  reviewSha: string;
  // gh's displayTitle: a PR-triggered run shows its PR's title, and so does a
  // comment run started on that PR (checked against GitHub, pr-hero-sandbox).
  displayTitle: string;
  // SB3: stays in progress until a cancel, with the head's status pending.
  pendingUntilCancel?: boolean;
  createdAt: string;
  // A near miss's trigger decided it runs nothing, so its run uploads no artifact.
  // Its step conclusion is success, as GitHub reports the composite step.
  nearMiss?: true;
}

interface PrRow {
  number: number;
  headRefName: string;
  url: string;
  closed: boolean;
  title: string;
  createdAt: string;
}

interface CommentRow {
  id: number;
  body: string;
  createdAt: string;
}

// What a run leaves behind. `hunters-failed` is the free model's flake: every
// hunter returned nothing, so the publisher posts PRH-HUNTERS-FAILED.
// `review-advisory` is a review under `mode: advisory`: the same comments, a
// success status whatever it finds. `size-skip` is a pull_request run over the
// size gate: the skip marker and a failure status, and no report.
// `override` is a `/pr-hero override` comment run: the audit comment and a success
// status naming the actor, and no report and no outcome (S8). `near-miss` is a
// comment that starts like a command but is not one: its run's review step is
// skipped inside a step that still concludes success, and it leaves nothing on the PR
// (T2e).
type Outcome =
  | "credential"
  | "routing"
  | "gotchas"
  | "review"
  | "review-advisory"
  | "size-skip"
  | "override"
  | "near-miss"
  | "hunters-failed";

// The actor the fake gives an override: the sandbox owner's login.
const FAKE_ACTOR = "juanmaagd";

// The reaction the trigger gives a comment (src/ci/trigger.ts). An exact command is
// accepted, so it gets eyes. A comment the workflow's own `startsWith` filter starts
// but that is not an exact command is a near miss, so it gets confused. Any other
// comment starts no run and gets no reaction.
function triggerReaction(body: string): "eyes" | "confused" | undefined {
  if (
    body === "/pr-hero review" ||
    body === "/pr-hero review --full" ||
    body === "/pr-hero recheck" ||
    body === "/pr-hero override"
  ) {
    return "eyes";
  }
  if (
    body.startsWith("/pr-hero review") ||
    body.startsWith("/pr-hero override")
  ) {
    return "confused";
  }
  return undefined;
}

const OUTCOME_CODE: Record<
  Exclude<
    Outcome,
    "review" | "review-advisory" | "size-skip" | "override" | "near-miss"
  >,
  string
> = {
  credential: "PRH-CRED-MISSING",
  routing: "PRH-ROUTING-INVALID",
  gotchas: "PRH-GOTCHAS-MISSING",
  "hunters-failed": "PRH-HUNTERS-FAILED",
};

// The owner lead the real summary opens with (src/ci/outcome.ts). The fake writes it
// for the outcomes whose lead a scenario checks, so the check reads the same line.
const OUTCOME_LEAD: Partial<Record<Outcome, string>> = {
  gotchas: "Your configuration:",
};

export interface WorldOptions {
  ref: string;
  // main's workflow; defaults to the scaffold pinned to `ref`.
  mainWorkflow?: string;
  // Every run decides `credential`, whatever its workflow says. Used to make an
  // expectation fail on purpose.
  forceCredentialOutcome?: boolean;
  // The outcomes of the first runs, in the order the runs start (the pull_request
  // run of a PR's first push, then each later push or comment). A run past the
  // list decides from its workflow as usual.
  runOutcomes?: readonly Outcome[];
  // A review does not remove the outcome comments of earlier runs, so the
  // runner's cleanup assertion has something to catch.
  keepOutcomeComments?: boolean;
  // A PR comment fails at the transport, so the scenario ends early.
  failComment?: boolean;
  // The reactions read of a comment fails, as a 5xx would: the reaction check must
  // then fail on what it could not read, never pass.
  reactionsUnreadable?: boolean;
  // A comment run reports success and reviews, but uploads no artifact: the
  // evidence a trigger that ignored the command would lack.
  commentRunsLeaveNoArtifact?: boolean;
  // An issue_comment run stays in progress, and posts nothing, until it is
  // cancelled: a run that outlives the poll.
  stuckCommentRuns?: boolean;
  // A cancel is accepted but the run keeps going: a run that outlives the cancel too.
  ignoreCancel?: boolean;
  // SB3: a pull_request run stays in progress with the head's pr-hero status pending
  // until a `run cancel` arrives; the cancel completes it as cancelled and the head's
  // status becomes error PRH-CANCELLED (the publisher's cancel settle, runCancelSettle).
  pendingThenCancellable?: boolean;
  // SB3: with pendingThenCancellable, the cancel completes the run but leaves the head's
  // status pending: the stuck gate the cancel probe must catch.
  cancelLeavesPending?: boolean;
  // An issue_comment run that skips on size: it posts the skip marker, and nothing
  // else (no report, no outcome, no artifact).
  commentRunsSkipSize?: boolean;
  // A review run whose review step fails, though the head still reads as reviewed
  // from the status and report it left behind.
  stepFailsOnReview?: boolean;
  // A hunters-failed run rendered with its hunters' shared cause instead of
  // PRH-HUNTERS-FAILED (publish.ts huntersFailedRendering): the code and the sentence
  // its outcome and status carry.
  huntersFailedAs?: { code: string; sentence: string };
  // S4: a review posts one blocking finding comment. Under the gate (no
  // `mode: advisory`) its status is failure, the way the product's gate writes it.
  blockingFindings?: boolean;
  // The mutation the consistency check must catch: with blockingFindings on, the
  // gate's status stays success anyway.
  statusIgnoresFindings?: boolean;
  // D3: a report on a head whose branch carries src/mute.ts gets a state block that
  // names it. This drops that block, the mutation the state-row check must catch.
  omitStateRows?: boolean;
  // T5b: the verdict the CI adjudicator's reply to a `/pr-hero recheck` carries, with
  // blockingFindings on. Unset, it is `rejected`; `upheld` is the mutation the
  // adjudication check must catch.
  adjudicationVerdict?: string;
}

// The gate's own status texts, from the product's request builders, so the fake
// cannot drift from the words the runner's checks read.
function blockingStatus(): { state: string; description: string } {
  const request = blockingCommitStatusRequest({
    blockingCount: 1,
    targetUrl: undefined,
  });
  return { state: request.state, description: request.description };
}

function skipStatus(): { state: string; description: string } {
  const request = skipCommitStatusRequest({
    kind: "size",
    targetUrl: undefined,
  });
  return { state: request.state, description: request.description };
}

export class FakeGithub {
  // The ordered remote and observation events: `push <sha>`, `run <id> ...`,
  // `observe status <sha>`, `comment <body>`. Tests read the order from here.
  readonly events: string[] = [];
  readonly prs = new Map<number, PrRow>();
  readonly branches = new Map<string, string>();
  readonly runs: RunRow[] = [];
  readonly statuses = new Map<string, { state: string; description: string }>();
  readonly comments = new Map<number, CommentRow[]>();
  // The review (inline) comments of each PR: the blocking findings and the replies to
  // them, which GitHub lists apart from the issue comments.
  readonly inline = new Map<number, CommentRow[]>();
  readonly mainFiles: Map<string, string>;
  private readonly options: WorldOptions;
  private nextId = 100;
  private shaCounter = 0;
  // A fake clock: every event takes one second, so the order of runs and comments
  // is the order of the calls, as on GitHub.
  private clock = Date.parse("2026-10-16T12:00:00Z");
  private readonly cwdHead = new Map<string, string>();
  private readonly pushedWorkflow = new Map<string, string>();
  // The gotchas file each pushed head carries, for the CLI's gate (decide).
  private readonly pushedGotchas = new Map<string, string>();
  // The heads whose branch carries the D3 mute file, for the state block of their report.
  private readonly muteHeads = new Set<string>();
  // The reactions on each comment, by comment id: what the trigger gave it.
  private readonly reactions = new Map<number, string[]>();
  private readonly queued: Outcome[];

  constructor(options: WorldOptions) {
    this.options = options;
    this.queued = [...(options.runOutcomes ?? [])];
    this.mainFiles = sandboxFiles(options.ref);
    if (options.mainWorkflow !== undefined) {
      this.mainFiles.set(WORKFLOW_PATH, options.mainWorkflow);
    }
  }

  // A test that models a second invocation on the same machine passes the lock it shares.
  harness(lock?: MemoryRunLock): Harness {
    return harness({
      gh: (args, h) => this.gh(args, h),
      git: (args, cwd, h) => this.git(args, cwd, h),
      lock,
    });
  }

  // A foreign scenario PR, open before the run starts. Created long before the fake
  // clock's start unless a test says otherwise, so it reads as an old PR.
  openForeignPr(
    number: number,
    headRefName: string,
    createdAt = "2026-10-01T00:00:00.000Z",
  ): void {
    this.prs.set(number, {
      number,
      headRefName,
      url: `${REPO_URL}/pull/${number}`,
      closed: false,
      title: `pr-hero sandbox foreign ${headRefName}`,
      createdAt,
    });
    this.comments.set(number, []);
  }

  // A run the runner did not start, such as one left by an earlier attempt. It is
  // in the repository's run list like any other. `status` defaults to completed.
  addRun(run: {
    event: "pull_request" | "issue_comment";
    displayTitle: string;
    createdAt: string;
    status?: "completed" | "in_progress";
  }): number {
    const id = this.nextId++;
    const inProgress = run.status === "in_progress";
    this.runs.push({
      databaseId: id,
      headSha: MAIN_SHA,
      headBranch: "main",
      event: run.event,
      status: run.status ?? "completed",
      conclusion: inProgress ? null : "success",
      workflowName: WORKFLOW_NAME,
      url: `${REPO_URL}/actions/runs/${id}`,
      stepConclusion: "success",
      prNumber: 0,
      reviewSha: MAIN_SHA,
      displayTitle: run.displayTitle,
      createdAt: run.createdAt,
    });
    return id;
  }

  private stamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private shaFor(counter: number): string {
    return counter.toString(16).padStart(40, "0");
  }

  private decide(
    workflow: string,
    event: "pull_request" | "issue_comment",
    gotchas: string | undefined,
  ): Outcome {
    if (this.options.forceCredentialOutcome === true) return "credential";
    if (
      !/^\s+(?:opencode-auth|anthropic-api-key|claude-token):/m.test(workflow)
    ) {
      return "credential";
    }
    if (/^\s+routing: "\{not json"$/m.test(workflow)) return "routing";
    // The CLI's gate reads the gotchas file (review-pr.ts validateGotchas), after
    // routing and before any spend.
    if (gotchas !== undefined && gotchasUnusableReason(gotchas) !== undefined) {
      return "gotchas";
    }
    // A pull_request run over a size gate of 1 skips. A /pr-hero review comment
    // is forced past the gate, so it never skips on size.
    if (
      event === "pull_request" &&
      /^\s+max-changed-lines: 1$/m.test(workflow)
    ) {
      return "size-skip";
    }
    return /^\s+mode: advisory$/m.test(workflow) ? "review-advisory" : "review";
  }

  private startRun(
    event: "pull_request" | "issue_comment",
    prNumber: number,
    headBranch: string,
    headSha: string,
    reviewSha: string,
    workflow: string,
    // A run whose outcome is fixed by its trigger (an override), which does not
    // consume the queue of the runs a scenario scripted.
    forced?: Outcome,
  ): void {
    const id = this.nextId++;
    // A pull_request run checks out the PR, so it reads that head's gotchas. A
    // comment run reads the base branch (the ERROR_CATALOG fix text says so), which
    // this fake does not model: it passes no gotchas, so the gate does not fire.
    const outcome =
      forced ??
      this.queued.shift() ??
      this.decide(
        workflow,
        event,
        event === "pull_request" ? this.pushedGotchas.get(headSha) : undefined,
      );
    // A run whose hunters all failed fails its review step, as the engine exits non-zero.
    const failed = outcome === "hunters-failed";
    const stepFails =
      failed ||
      (outcome === "review" && this.options.stepFailsOnReview === true);
    const displayTitle = this.prs.get(prNumber)?.title ?? "";
    const pendingUntilCancel =
      event === "pull_request" && this.options.pendingThenCancellable === true;
    const stuck =
      (event === "issue_comment" && this.options.stuckCommentRuns === true) ||
      pendingUntilCancel;
    this.runs.push({
      displayTitle,
      createdAt: this.stamp(),
      databaseId: id,
      headSha,
      headBranch,
      event,
      status: stuck ? "in_progress" : "completed",
      conclusion: stuck ? null : failed ? "failure" : "success",
      workflowName: WORKFLOW_NAME,
      url: `${REPO_URL}/actions/runs/${id}`,
      // The composite `Run pr-hero` step is one step with no `if:`, so it concludes
      // success even on a near miss, whose trigger skipped the steps inside it. GitHub
      // reports it that way (T2e), so the fake must too.
      stepConclusion: stepFails ? "failure" : "success",
      prNumber,
      reviewSha,
      ...(outcome === "near-miss" ? { nearMiss: true as const } : {}),
      ...(pendingUntilCancel ? { pendingUntilCancel: true } : {}),
    });
    if (pendingUntilCancel) {
      this.statuses.set(headSha, {
        state: "pending",
        description: "pr-hero reviewing",
      });
    }
    if (stuck) {
      this.events.push(`run ${id} ${event} in_progress`);
      return;
    }
    this.events.push(`run ${id} ${event} completed`);
    if (
      event === "issue_comment" &&
      this.options.commentRunsSkipSize === true
    ) {
      const list = this.comments.get(prNumber) ?? [];
      list.push(this.comment(SKIP_MARKERS.size));
      this.comments.set(prNumber, list);
    } else {
      this.post(outcome, prNumber, reviewSha, id);
    }
    // A run takes minutes, and the runner's next comment comes after it. The
    // one-second step only orders events within a run, so the next phase's
    // trigger is stamped a run's length after this run's own comments.
    this.clock += RUN_DURATION_MS;
  }

  // The state block a report on this head carries when its branch has the D3 mute
  // file: one finding at that file, the shape the product writes (observe.ts).
  private stateBlock(sha: string): string {
    if (!this.muteHeads.has(sha) || this.options.omitStateRows === true)
      return "";
    return `\n<!-- pr-hero-state v=1 head=${sha} -->\n<!-- {"findings":[{"id":"R001","locs":["src/mute.ts:3"]}],"reviews":2,"hw":1} -->`;
  }

  private comment(body: string): CommentRow {
    return { id: this.nextId++, body, createdAt: this.stamp() };
  }

  private inlineOf(prNumber: number): CommentRow[] {
    const list = this.inline.get(prNumber) ?? [];
    this.inline.set(prNumber, list);
    return list;
  }

  // What the publisher leaves on the PR for one run's outcome.
  private post(outcome: Outcome, prNumber: number, sha: string, runId: number) {
    // A near miss runs nothing, so it leaves no report, outcome or status (T2e).
    if (outcome === "near-miss") return;
    const list = this.comments.get(prNumber) ?? [];
    if (outcome === "review" || outcome === "review-advisory") {
      const report = `${REPORT_PREFIX} head=${sha} -->\n\n# pr-hero review${this.stateBlock(sha)}`;
      const at = list.findIndex((c) =>
        c.body.startsWith(`${REPORT_PREFIX} head=${sha}`),
      );
      if (at >= 0) list[at] = this.comment(report);
      else list.push(this.comment(report));
      // Cleanup: the outcome comments of earlier runs are removed once a review completes.
      if (this.options.keepOutcomeComments !== true) {
        const kept = list.filter((c) => !c.body.startsWith(OUTCOME_PREFIX));
        list.splice(0, list.length, ...kept);
      }
      // S4: the status is the gate's verdict on the posted findings. A blocking
      // finding under the gate is failure; advisory is success whatever it finds,
      // and statusIgnoresFindings is the mutation that keeps the gate green.
      if (this.options.blockingFindings === true) {
        this.inlineOf(prNumber).push(this.comment(blockingFinding(sha)));
      }
      const gateFails =
        outcome === "review" &&
        this.options.blockingFindings === true &&
        this.options.statusIgnoresFindings !== true;
      this.statuses.set(
        sha,
        gateFails
          ? blockingStatus()
          : { state: "success", description: "review posted" },
      );
    } else if (outcome === "size-skip") {
      list.push(this.comment(SKIP_MARKERS.size));
      this.statuses.set(sha, skipStatus());
    } else if (outcome === "override") {
      // The audit comment and the success status, as the publisher writes them.
      // No report and no outcome: an override runs no review.
      list.push(
        this.comment(
          `${OVERRIDE_MARKER_PREFIX} head=${sha} run=${runId} attempt=1 -->\n\npr-hero's gate was overridden by @${FAKE_ACTOR}.`,
        ),
      );
      this.statuses.set(sha, {
        state: "success",
        description: `pr-hero: overridden by @${FAKE_ACTOR} — no review on this head`,
      });
    } else {
      const as =
        outcome === "hunters-failed" ? this.options.huntersFailedAs : undefined;
      const code = as?.code ?? OUTCOME_CODE[outcome];
      const lead = OUTCOME_LEAD[outcome];
      const body =
        as?.sentence ??
        (lead === undefined ? "fake outcome" : `${lead} fake outcome`);
      list.push(
        this.comment(
          `${OUTCOME_PREFIX} v=1 head=${sha} run=${runId} attempt=1 -->\n\n## ${code}\n\n${body}`,
        ),
      );
      this.statuses.set(sha, {
        state: "error",
        description: `${code}: ${as?.sentence ?? "fake outcome"}`.slice(0, 140),
      });
    }
    this.comments.set(prNumber, list);
  }

  private gh(args: readonly string[], h: Harness): GhResult {
    const [verb, sub] = args;
    if (verb === "repo" && sub === "clone") {
      h.workspace.seed(String(args[3]), this.mainFiles);
      return ok();
    }
    if (verb === "pr" && sub === "list") {
      // The fields gh returns for a same-repo PR. A scenario PR is one only when
      // its head is in the sandbox itself, so the fake must say where it lives.
      const open = [...this.prs.values()]
        .filter((p) => !p.closed)
        .map(({ number, headRefName, url, title, createdAt }) => ({
          number,
          headRefName,
          url,
          title,
          createdAt,
          isCrossRepository: false,
          headRepositoryOwner: { login: "juanmaagd" },
        }));
      return ok(JSON.stringify(open));
    }
    if (verb === "pr" && sub === "create") {
      const branch = flag(args, "--head") ?? "";
      const number = this.nextId++;
      this.prs.set(number, {
        number,
        headRefName: branch,
        url: `${REPO_URL}/pull/${number}`,
        closed: false,
        title: flag(args, "--title") ?? "",
        createdAt: this.stamp(),
      });
      this.comments.set(number, []);
      this.inline.set(number, []);
      this.events.push(`pr create ${number}`);
      const sha = this.branches.get(branch) ?? MAIN_SHA;
      this.startRun(
        "pull_request",
        number,
        branch,
        sha,
        sha,
        this.pushedWorkflow.get(sha) ?? "",
      );
      return ok(`${REPO_URL}/pull/${number}\n`);
    }
    if (verb === "pr" && sub === "close") {
      const pr = this.prs.get(Number(args[2]));
      if (pr !== undefined) pr.closed = true;
      this.events.push(`pr close ${String(args[2])}`);
      return ok();
    }
    if (verb === "pr" && sub === "comment") {
      const number = Number(args[2]);
      const body = flag(args, "--body") ?? "";
      this.events.push(`comment ${body}`);
      if (this.options.failComment === true)
        return fail("HTTP 502: Bad Gateway");
      const posted = this.comment(body);
      const id = posted.id;
      (this.comments.get(number) ?? []).push(posted);
      // The trigger's answer to this comment, if it starts a run at all.
      const reaction = triggerReaction(body);
      if (reaction !== undefined) this.reactions.set(id, [reaction]);
      const pr = this.prs.get(number);
      const head = this.branches.get(pr?.headRefName ?? "") ?? MAIN_SHA;
      const workflow = this.mainFiles.get(WORKFLOW_PATH) ?? "";
      // An accepted review runs a review; an override runs its own audit; a near miss
      // runs the workflow with its review step skipped.
      if (body === "/pr-hero override") {
        this.startRun(
          "issue_comment",
          number,
          "main",
          MAIN_SHA,
          head,
          workflow,
          "override",
        );
      } else if (reaction === "eyes") {
        this.startRun(
          "issue_comment",
          number,
          "main",
          MAIN_SHA,
          head,
          workflow,
        );
        // T5b: a recheck's run also has the CI adjudicator rule on the dismissal, and
        // its reply is an inline comment stamped as this run's.
        if (
          body === "/pr-hero recheck" &&
          this.options.blockingFindings === true
        ) {
          const verdict = this.options.adjudicationVerdict ?? "rejected";
          this.inlineOf(number).push(
            this.comment(
              `<!-- pr-hero-adjudication verdict=${verdict} reply=1 head=${head} -->\n\nThe adjudicator ruled on the dismissal.`,
            ),
          );
        }
      } else if (reaction === "confused") {
        this.startRun(
          "issue_comment",
          number,
          "main",
          MAIN_SHA,
          head,
          workflow,
          "near-miss",
        );
      }
      return ok(`${REPO_URL}/pull/${number}#issuecomment-${id}\n`);
    }
    if (verb === "run" && sub === "list") {
      const event = flag(args, "--event");
      const branch = flag(args, "--branch");
      const rows = [...this.runs]
        .reverse()
        .filter(
          (r) =>
            (event === undefined || r.event === event) &&
            (branch === undefined || r.headBranch === branch),
        )
        .map((r) => ({
          databaseId: r.databaseId,
          headSha: r.headSha,
          status: r.status,
          conclusion: r.conclusion,
          workflowName: r.workflowName,
          url: r.url,
          event: r.event,
          displayTitle: r.displayTitle,
          createdAt: r.createdAt,
        }));
      return ok(JSON.stringify(rows));
    }
    if (verb === "run" && sub === "cancel") {
      // A cancelled run completes without posting anything.
      const run = this.runs.find((r) => r.databaseId === Number(args[2]));
      if (run === undefined) return fail("run not found");
      this.events.push(`run cancel ${run.databaseId}`);
      if (this.options.ignoreCancel === true) return ok();
      run.status = "completed";
      run.conclusion = "cancelled";
      if (
        run.pendingUntilCancel === true &&
        this.options.cancelLeavesPending !== true
      ) {
        this.statuses.set(run.headSha, {
          state: "error",
          description: CANCELLED_STATUS_DESCRIPTION,
        });
      }
      return ok();
    }
    if (verb === "run" && sub === "view") {
      const run = this.runs.find((r) => r.databaseId === Number(args[2]));
      if (run === undefined) return fail("run not found");
      return ok(
        JSON.stringify({
          status: run.status,
          conclusion: run.conclusion,
          jobs: [
            {
              steps: [{ name: RUN_STEP_NAME, conclusion: run.stepConclusion }],
            },
          ],
        }),
      );
    }
    if (verb === "api") return this.api(String(args[1]), args);
    return ok();
  }

  private api(path: string, args: readonly string[]): GhResult {
    // T5b: a reply to a review comment. The body is the `-f body=` field.
    const reply = /\/pulls\/(\d+)\/comments$/.exec(path);
    if (reply !== null && flag(args, "--method") === "POST") {
      const body = (flag(args, "-f") ?? "").replace(/^body=/, "");
      const posted = this.comment(body);
      this.inlineOf(Number(reply[1])).push(posted);
      return ok(JSON.stringify({ id: posted.id }));
    }
    if (args.includes("DELETE")) {
      this.branches.delete(
        path.slice(path.indexOf("refs/heads/") + "refs/heads/".length),
      );
      return ok();
    }
    const commit = /\/commits\/([0-9a-f]{40})\/status$/.exec(path);
    if (commit !== null) {
      const sha = commit[1] ?? "";
      this.events.push(`observe status ${sha}`);
      const status = this.statuses.get(sha);
      return ok(
        JSON.stringify({
          statuses:
            status === undefined ? [] : [{ context: "pr-hero", ...status }],
        }),
      );
    }
    const issue = /\/issues\/(\d+)\/comments/.exec(path);
    if (issue !== null) {
      const list = this.comments.get(Number(issue[1])) ?? [];
      return ok(
        JSON.stringify(
          list.map((c) => ({ body: c.body, created_at: c.createdAt })),
        ),
      );
    }
    const one = /\/issues\/comments\/(\d+)$/.exec(path);
    if (one !== null) {
      const found = [...this.comments.values()]
        .flat()
        .find((c) => c.id === Number(one[1]));
      if (found === undefined) return fail("comment not found");
      return ok(JSON.stringify({ created_at: found.createdAt }));
    }
    // The reactions on a comment: what the trigger gave it (T2e). The read answers
    // with GitHub's shape, one object per reaction with its content.
    const reacted = /\/issues\/comments\/(\d+)\/reactions(?:\?|$)/.exec(path);
    if (reacted !== null) {
      if (this.options.reactionsUnreadable === true) {
        return fail("HTTP 500: Internal Server Error");
      }
      const contents = this.reactions.get(Number(reacted[1])) ?? [];
      return ok(JSON.stringify(contents.map((content) => ({ content }))));
    }
    const inlineList = /\/pulls\/(\d+)\/comments/.exec(path);
    if (inlineList !== null) {
      return ok(
        JSON.stringify(
          this.inlineOf(Number(inlineList[1])).map((c) => ({
            id: c.id,
            body: c.body,
            created_at: c.createdAt,
          })),
        ),
      );
    }
    const pull = /\/pulls\/(\d+)$/.exec(path);
    if (pull !== null) {
      const found = this.prs.get(Number(pull[1]));
      if (found === undefined) return fail("pull request not found");
      return ok(JSON.stringify({ created_at: found.createdAt }));
    }
    const artifacts = /\/actions\/runs\/(\d+)\/artifacts$/.exec(path);
    if (artifacts !== null) {
      const run = this.runs.find((r) => r.databaseId === Number(artifacts[1]));
      // A near miss reviewed nothing, so its run uploads no review artifact.
      const names =
        run === undefined ||
        run.nearMiss === true ||
        (run.event === "issue_comment" &&
          this.options.commentRunsLeaveNoArtifact)
          ? []
          : [`pr-hero-run-${run.prNumber}-${run.reviewSha}`];
      return ok(JSON.stringify({ artifacts: names.map((name) => ({ name })) }));
    }
    return fail(`unexpected api ${path}`);
  }

  private git(args: readonly string[], cwd: string, h: Harness): GitResult {
    const [verb] = args;
    if (verb === "rev-parse") {
      return gitOk(`${this.cwdHead.get(cwd) ?? MAIN_SHA}\n`);
    }
    if (verb === "remote") return gitOk(`${SANDBOX_REMOTE_URL}\n`);
    if (verb === "commit") {
      const sha = this.shaFor(++this.shaCounter);
      this.cwdHead.set(cwd, sha);
      return gitOk();
    }
    if (verb === "push") {
      const branch = String(args.at(-1));
      const sha = this.cwdHead.get(cwd) ?? MAIN_SHA;
      const workflow = h.workspace.dirs.get(cwd)?.get(WORKFLOW_PATH) ?? "";
      this.pushedWorkflow.set(sha, workflow);
      const gotchas = h.workspace.dirs.get(cwd)?.get(GOTCHAS_PATH);
      if (gotchas !== undefined) this.pushedGotchas.set(sha, gotchas);
      if (h.workspace.dirs.get(cwd)?.has(MUTE_PATH) === true) {
        this.muteHeads.add(sha);
      }
      this.branches.set(branch, sha);
      this.events.push(`push ${sha}`);
      const pr = [...this.prs.values()].find(
        (p) => p.headRefName === branch && !p.closed,
      );
      // A push to an open PR's branch is a synchronize: a new run on the new head.
      if (pr !== undefined) {
        this.startRun("pull_request", pr.number, branch, sha, sha, workflow);
      }
      return gitOk();
    }
    return gitOk();
  }
}

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}
