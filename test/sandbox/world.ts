// A phase-aware fake of the sandbox repository, for the scenario runner. Unlike
// the scripted fakes in fakes.ts, it reacts the way GitHub does: a PR's first push
// or a later push starts a pull_request run on that head, and a PR comment starts
// an issue_comment run that executes main's workflow. The outcome each run posts
// is decided from the workflow on its head, so the runner's expectations are
// checked against what a run would have left behind, not against a script.
//
// The product behaviour it encodes is the minimum the scenarios rely on: no model
// credential input gives PRH-CRED-MISSING, a malformed routing literal gives
// PRH-ROUTING-INVALID, a review upserts the report for its head and removes the
// outcome comments of earlier runs. Live runs are the proof of the product; this
// fake is the proof of the runner's sequencing and its reads.

import { RUN_STEP_NAME, WORKFLOW_NAME } from "../../scripts/sandbox/markers";
import type { GhResult, GitResult } from "../../scripts/sandbox/ports";
import { SANDBOX_REMOTE_URL, SANDBOX_REPO } from "../../scripts/sandbox/rails";
import { sandboxFiles, WORKFLOW_PATH } from "../../scripts/sandbox/seed";
import { fail, gitOk, type Harness, harness, ok } from "./fakes";

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
}

interface PrRow {
  number: number;
  headRefName: string;
  url: string;
  closed: boolean;
}

// What a run leaves behind. `hunters-failed` is the free model's flake: every
// hunter returned nothing, so the publisher posts PRH-HUNTERS-FAILED.
type Outcome = "credential" | "routing" | "review" | "hunters-failed";

const OUTCOME_CODE: Record<Exclude<Outcome, "review">, string> = {
  credential: "PRH-CRED-MISSING",
  routing: "PRH-ROUTING-INVALID",
  "hunters-failed": "PRH-HUNTERS-FAILED",
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
}

export class FakeGithub {
  // The ordered remote and observation events: `push <sha>`, `run <id> ...`,
  // `observe status <sha>`, `comment <body>`. Tests read the order from here.
  readonly events: string[] = [];
  readonly prs = new Map<number, PrRow>();
  readonly branches = new Map<string, string>();
  readonly runs: RunRow[] = [];
  readonly statuses = new Map<string, { state: string; description: string }>();
  readonly comments = new Map<number, { id: number; body: string }[]>();
  readonly mainFiles: Map<string, string>;
  private readonly options: WorldOptions;
  private nextId = 100;
  private shaCounter = 0;
  private readonly cwdHead = new Map<string, string>();
  private readonly pushedWorkflow = new Map<string, string>();
  private readonly queued: Outcome[];

  constructor(options: WorldOptions) {
    this.options = options;
    this.queued = [...(options.runOutcomes ?? [])];
    this.mainFiles = sandboxFiles(options.ref);
    if (options.mainWorkflow !== undefined) {
      this.mainFiles.set(WORKFLOW_PATH, options.mainWorkflow);
    }
  }

  harness(): Harness {
    return harness({
      gh: (args, h) => this.gh(args, h),
      git: (args, cwd, h) => this.git(args, cwd, h),
    });
  }

  // A foreign scenario PR, open before the run starts.
  openForeignPr(number: number, headRefName: string): void {
    this.prs.set(number, {
      number,
      headRefName,
      url: `${REPO_URL}/pull/${number}`,
      closed: false,
    });
    this.comments.set(number, []);
  }

  private shaFor(counter: number): string {
    return counter.toString(16).padStart(40, "0");
  }

  private decide(workflow: string): Outcome {
    if (this.options.forceCredentialOutcome === true) return "credential";
    if (
      !/^\s+(?:opencode-auth|anthropic-api-key|claude-token):/m.test(workflow)
    ) {
      return "credential";
    }
    if (/^\s+routing: "\{not json"$/m.test(workflow)) return "routing";
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
    const outcome = this.queued.shift() ?? this.decide(workflow);
    // A run whose hunters all failed fails its review step, as the engine exits non-zero.
    const failed = outcome === "hunters-failed";
    this.runs.push({
      databaseId: id,
      headSha,
      headBranch,
      event,
      status: "completed",
      conclusion: failed ? "failure" : "success",
      workflowName: WORKFLOW_NAME,
      url: `${REPO_URL}/actions/runs/${id}`,
      stepConclusion: failed ? "failure" : "success",
      prNumber,
      reviewSha,
    });
    this.events.push(`run ${id} ${event} completed`);
    this.post(outcome, prNumber, reviewSha, id);
  }

  // What the publisher leaves on the PR for one run's outcome.
  private post(outcome: Outcome, prNumber: number, sha: string, runId: number) {
    const list = this.comments.get(prNumber) ?? [];
    if (outcome === "review") {
      const report = `${REPORT_PREFIX} head=${sha} -->\n\n# pr-hero review`;
      const at = list.findIndex((c) =>
        c.body.startsWith(`${REPORT_PREFIX} head=${sha}`),
      );
      if (at >= 0) list[at] = { id: this.nextId++, body: report };
      else list.push({ id: this.nextId++, body: report });
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
      list.push({
        id: this.nextId++,
        body: `${OUTCOME_PREFIX} v=1 head=${sha} run=${runId} attempt=1 -->\n\n## ${code}\n\nfake outcome`,
      });
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
      const open = [...this.prs.values()]
        .filter((p) => !p.closed)
        .map(({ number, headRefName, url }) => ({ number, headRefName, url }));
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
      const id = this.nextId++;
      (this.comments.get(number) ?? []).push({ id, body });
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
        }));
      return ok(JSON.stringify(rows));
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
      return ok(JSON.stringify(list.map((c) => ({ body: c.body }))));
    }
    if (/\/pulls\/\d+\/comments/.test(path)) return ok("[]");
    const artifacts = /\/actions\/runs\/(\d+)\/artifacts$/.exec(path);
    if (artifacts !== null) {
      const run = this.runs.find((r) => r.databaseId === Number(artifacts[1]));
      const names =
        run === undefined
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
