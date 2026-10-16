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

import { gotchasUnusableReason } from "#review/preflight";
import {
  RUN_STEP_NAME,
  SKIP_MARKERS,
  WORKFLOW_NAME,
} from "../../scripts/sandbox/markers";
import type { GhResult, GitResult } from "../../scripts/sandbox/ports";
import { SANDBOX_REMOTE_URL, SANDBOX_REPO } from "../../scripts/sandbox/rails";
import {
  GOTCHAS_PATH,
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
  createdAt: string;
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
type Outcome =
  | "credential"
  | "routing"
  | "gotchas"
  | "review"
  | "hunters-failed";

const OUTCOME_CODE: Record<Exclude<Outcome, "review">, string> = {
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
  // A comment run reports success and reviews, but uploads no artifact: the
  // evidence a trigger that ignored the command would lack.
  commentRunsLeaveNoArtifact?: boolean;
  // An issue_comment run stays in progress, and posts nothing, until it is
  // cancelled: a run that outlives the poll.
  stuckCommentRuns?: boolean;
  // A cancel is accepted but the run keeps going: a run that outlives the cancel too.
  ignoreCancel?: boolean;
  // An issue_comment run that skips on size: it posts the skip marker, and nothing
  // else (no report, no outcome, no artifact).
  commentRunsSkipSize?: boolean;
  // A review run whose review step fails, though the head still reads as reviewed
  // from the status and report it left behind.
  stepFailsOnReview?: boolean;
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

  private decide(workflow: string, gotchas: string | undefined): Outcome {
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
    return "review";
  }

  private startRun(
    event: "pull_request" | "issue_comment",
    prNumber: number,
    headBranch: string,
    headSha: string,
    reviewSha: string,
    workflow: string,
  ): void {
    const id = this.nextId++;
    // A pull_request run checks out the PR, so it reads that head's gotchas. A
    // comment run reads the base branch (the ERROR_CATALOG fix text says so), which
    // this fake does not model: it passes no gotchas, so the gate does not fire.
    const outcome =
      this.queued.shift() ??
      this.decide(
        workflow,
        event === "pull_request" ? this.pushedGotchas.get(headSha) : undefined,
      );
    // A run whose hunters all failed fails its review step, as the engine exits non-zero.
    const failed = outcome === "hunters-failed";
    const stepFails =
      failed ||
      (outcome === "review" && this.options.stepFailsOnReview === true);
    const displayTitle = this.prs.get(prNumber)?.title ?? "";
    const stuck =
      event === "issue_comment" && this.options.stuckCommentRuns === true;
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
      stepConclusion: stepFails ? "failure" : "success",
      prNumber,
      reviewSha,
    });
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
      return;
    }
    this.post(outcome, prNumber, reviewSha, id);
  }

  private comment(body: string): CommentRow {
    return { id: this.nextId++, body, createdAt: this.stamp() };
  }

  // What the publisher leaves on the PR for one run's outcome.
  private post(outcome: Outcome, prNumber: number, sha: string, runId: number) {
    const list = this.comments.get(prNumber) ?? [];
    if (outcome === "review") {
      const report = `${REPORT_PREFIX} head=${sha} -->\n\n# pr-hero review`;
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
      this.statuses.set(sha, {
        state: "success",
        description: "review posted",
      });
    } else {
      const code = OUTCOME_CODE[outcome];
      const lead = OUTCOME_LEAD[outcome];
      const body = lead === undefined ? "fake outcome" : `${lead} fake outcome`;
      list.push(
        this.comment(
          `${OUTCOME_PREFIX} v=1 head=${sha} run=${runId} attempt=1 -->\n\n## ${code}\n\n${body}`,
        ),
      );
      this.statuses.set(sha, {
        state: "error",
        description: `${code}: fake outcome`,
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
      if (body === "/pr-hero review") {
        const pr = this.prs.get(number);
        const head = this.branches.get(pr?.headRefName ?? "") ?? MAIN_SHA;
        this.startRun(
          "issue_comment",
          number,
          "main",
          MAIN_SHA,
          head,
          this.mainFiles.get(WORKFLOW_PATH) ?? "",
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
    if (/\/pulls\/\d+\/comments/.test(path)) return ok("[]");
    const pull = /\/pulls\/(\d+)$/.exec(path);
    if (pull !== null) {
      const found = this.prs.get(Number(pull[1]));
      if (found === undefined) return fail("pull request not found");
      return ok(JSON.stringify({ created_at: found.createdAt }));
    }
    const artifacts = /\/actions\/runs\/(\d+)\/artifacts$/.exec(path);
    if (artifacts !== null) {
      const run = this.runs.find((r) => r.databaseId === Number(artifacts[1]));
      const names =
        run === undefined ||
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
