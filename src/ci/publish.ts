// The outcome publisher (odd/tasks/agent-first-ci.md, T2b / S3). Every outcome
// that happens BEFORE the CLI step starts (no credential, an unresolved PR, an
// unverifiable commenter permission, a failed install step) becomes ONE
// annotation, ONE step summary and, when the PR is known, ONE commit status
// plus ONE sticky comment on that PR. The trigger writes the decision to
// trigger.json; this step reads it and speaks.
//
// It runs `if: always()`: a failed install skips every later step, and this
// step is the only one that can still say so. It is gated on the trigger's
// `publish` output, not on `run`, because `run` is false for exactly the
// outcomes this step reports.
//
// In this release it speaks only for pre-CLI outcomes. `cli-started` is the
// marker the run step writes before anything else: when it exists, the CLI ran
// and owns its own status and comment (T2c moves those here later).
//
// WHY ONLY BUILTINS (plus ./outcome): the step runs before anything is installed,
// so a package import has no node_modules to resolve against. ./outcome is a
// sibling that is itself builtins-only at runtime: its repository imports are
// `import type`, erased at transpile. Relative imports need no node_modules.
//
// WHY repost, not edit: GitHub does not notify on an edit, and an edited comment
// does not move down the timeline. So the fresh comment is POSTED first, and the
// older outcome comments of the SAME author are deleted after it (see
// repostMarkedPrComment in src/pr/pr.ts, which made the same choice for the skip
// notice on #315). Posting first means a failed POST deletes nothing.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ErrorParams, RenderedError, TriggerRecord } from "./outcome";
import { parseTriggerRecord, renderCode, renderError } from "./outcome";

// The commit status context. The required check reads this name, so it must
// equal COMMIT_STATUS_CONTEXT in src/pr/preflight.ts (a test pins the two).
const STATUS_CONTEXT = "pr-hero";
// GitHub's limit on a commit status description.
const STATUS_DESCRIPTION_MAX = 140;
const MARKER_PREFIX = "<!-- pr-hero-outcome";
const CLI_STARTED_FILE = "cli-started";
const RECORD_FILE = "trigger.json";
// Short and fixed: one pause before the one retry of the status write.
const STATUS_RETRY_DELAY_MS = 2_000;
const GH_TIMEOUT_MS = 30_000;

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface StatusPost {
  state: "error";
  context: "pr-hero";
  description: string;
  targetUrl: string;
}

export type Publication =
  | { kind: "none" }
  // Annotation and step summary only: no PR can be written to.
  | { kind: "local"; rendered: RenderedError }
  | {
      kind: "remote";
      rendered: RenderedError;
      repository: string;
      pr: number;
      headSha: string;
      status: StatusPost;
      commentBody: string;
    };

// The pure table. Which outcome this run has is the record's decision and class
// (renderError / renderCode say what it means); whether anything can be posted
// on a PR is the record's pr and head.
export function decidePublication(input: {
  record: TriggerRecord | undefined;
  cliStarted: boolean;
}): Publication {
  const record = input.record;
  if (record === undefined) return { kind: "none" };
  if (record.decision === "ignore" || record.decision === "denied") {
    // Denied and ignored commands publish nothing, by design (T2e adds reactions).
    return { kind: "none" };
  }
  // WHY: the CLI owns its own output in this release, so a second outcome here
  // would be a duplicate on the same PR. T2c hands those outcomes over.
  if (record.decision === "review" && input.cliStarted) return { kind: "none" };

  const params: ErrorParams = {
    ...record.params,
    pr: record.pr,
    runId: record.run_id,
    runUrl: record.run_url,
  };
  const rendered = renderRecordOutcome(record, params);
  if (record.pr === undefined || record.head_sha === undefined) {
    return { kind: "local", rendered };
  }
  return {
    kind: "remote",
    rendered,
    repository: record.repository,
    pr: record.pr,
    headSha: record.head_sha,
    status: {
      state: "error",
      context: STATUS_CONTEXT,
      description: statusDescription(rendered),
      targetUrl: record.run_url,
    },
    commentBody: [
      `${MARKER_PREFIX} v=1 head=${record.head_sha} run=${record.run_id} -->`,
      "",
      ...rendered.summary,
    ].join("\n"),
  };
}

function renderRecordOutcome(
  record: TriggerRecord,
  params: ErrorParams,
): RenderedError {
  if (record.decision === "no-credentials") {
    return renderError(
      { kind: "trigger", check: "no-credential" },
      params,
      "action",
    );
  }
  if (record.decision === "unverifiable") {
    // WHY the step name: a lookup with no captured status has no class to
    // render, and "stopped at this step" needs a step to name.
    return renderError(
      record.cls ?? { kind: "unknown" },
      { ...params, step: "the commenter permission check" },
      "action",
    );
  }
  // A review that never reached the CLI: a recorded class is the cause (the PR
  // could not be resolved); otherwise the install step failed before the run.
  if (record.cls !== undefined) {
    return renderError(record.cls, params, "action");
  }
  return renderError({ kind: "install", step: "" }, params, "action");
}

// One line, `<CODE>: <what>`, clipped to the status limit.
function statusDescription(rendered: RenderedError): string {
  const line = `${rendered.code}: ${rendered.what}`.replace(/\s+/g, " ");
  return line.length > STATUS_DESCRIPTION_MAX
    ? line.slice(0, STATUS_DESCRIPTION_MAX)
    : line;
}

// ---------------------------------------------------------------------------
// The shell.
// ---------------------------------------------------------------------------

export interface PublishDeps {
  env: Readonly<Record<string, string | undefined>>;
  // Stdin is the comment body; the answer is gh's result.
  gh: (args: readonly string[], stdin?: string) => GhResult;
  sleep?: (ms: number) => void;
  stdout: (text: string) => void;
  appendSummary: (text: string) => void;
}

function httpStatusOf(result: GhResult): number | undefined {
  const match = /HTTP (\d{3})\b/.exec(result.stderr);
  return match === null ? undefined : Number(match[1]);
}

function report(deps: PublishDeps, rendered: RenderedError): void {
  deps.stdout(`${rendered.annotation}\n`);
  deps.appendSummary(`${rendered.summary.join("\n")}\n`);
}

// Workflow-command text, escaped as the runner's toolkit escapes it, so a
// message can never start a second command.
function workflowCommand(
  command: "error" | "warning",
  message: string,
): string {
  const escaped = message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  return `::${command} title=pr-hero::${escaped}\n`;
}

// The status write, retried once. Returns the failure's HTTP status when gh
// printed one, so the renderer can pick the permission or the server wording.
function postStatus(
  deps: PublishDeps,
  plan: Extract<Publication, { kind: "remote" }>,
): { ok: true } | { ok: false; httpStatus: number | undefined } {
  const args = [
    "api",
    `repos/${plan.repository}/statuses/${plan.headSha}`,
    "-f",
    `state=${plan.status.state}`,
    "-f",
    `context=${plan.status.context}`,
    "-f",
    `description=${plan.status.description}`,
    "-f",
    `target_url=${plan.status.targetUrl}`,
  ];
  let result = deps.gh(args);
  if (result.exitCode !== 0) {
    (deps.sleep ?? ((ms: number) => Bun.sleepSync(ms)))(STATUS_RETRY_DELAY_MS);
    result = deps.gh(args);
  }
  if (result.exitCode === 0) return { ok: true };
  return { ok: false, httpStatus: httpStatusOf(result) };
}

// Posts the comment, then deletes the older outcome comments of the same author.
// Returns the failure of the POST only: the cleanup is best effort, because the
// fresh comment has already landed and one stale duplicate is the safe error.
function postComment(
  deps: PublishDeps,
  plan: Extract<Publication, { kind: "remote" }>,
): { ok: true } | { ok: false; detail: string } {
  const repo = plan.repository;
  const created = deps.gh(
    [
      "api",
      "--method",
      "POST",
      `repos/${repo}/issues/${plan.pr}/comments`,
      "-F",
      "body=@-",
      "--jq",
      "[.id, .user.login] | @json",
    ],
    plan.commentBody,
  );
  if (created.exitCode !== 0) {
    const status = httpStatusOf(created);
    return {
      ok: false,
      detail: status === undefined ? "no HTTP response" : `HTTP ${status}`,
    };
  }
  const [newId, author] = parseCreated(created.stdout);
  if (newId === undefined || author === undefined || author === "") {
    // WHY nothing is deleted: without a known author, "the same author" is not
    // a test this step can pass, so an old comment is never removed on a guess.
    return { ok: true };
  }
  deleteOlderOutcomes(deps, repo, plan.pr, newId, author);
  return { ok: true };
}

function parseCreated(
  stdout: string,
): [number | undefined, string | undefined] {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (
      Array.isArray(value) &&
      typeof value[0] === "number" &&
      typeof value[1] === "string"
    ) {
      return [value[0], value[1]];
    }
  } catch {
    // Fall through: an unreadable answer is treated as an unknown author.
  }
  return [undefined, undefined];
}

function deleteOlderOutcomes(
  deps: PublishDeps,
  repo: string,
  pr: number,
  newId: number,
  author: string,
): void {
  const listed = deps.gh([
    "api",
    "--paginate",
    `repos/${repo}/issues/${pr}/comments`,
    "--jq",
    '.[] | [.id, .user.login, (.body | split("\\n") | .[0])] | @json',
  ]);
  if (listed.exitCode !== 0) {
    deps.stdout(
      workflowCommand(
        "warning",
        `pr-hero could not list the older outcome comments on #${pr}; they were left in place.`,
      ),
    );
    return;
  }
  for (const line of listed.stdout.split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(row)) continue;
    const [id, login, firstLine] = row;
    const older =
      typeof id === "number" &&
      id < newId &&
      login === author &&
      typeof firstLine === "string" &&
      firstLine.startsWith(MARKER_PREFIX);
    if (!older) continue;
    const removed = deps.gh([
      "api",
      "--method",
      "DELETE",
      `repos/${repo}/issues/comments/${id}`,
    ]);
    if (removed.exitCode !== 0) {
      deps.stdout(
        workflowCommand(
          "warning",
          `pr-hero could not delete an older outcome comment (${id}) on #${pr}.`,
        ),
      );
    }
  }
}

function readIfExists(filePath: string): string | undefined {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
}

export function runPublish(deps: PublishDeps): number {
  const dir = deps.env.PRHERO_OUTCOME_DIR ?? "";
  if (dir === "") return 0;
  const recordText = readIfExists(path.join(dir, RECORD_FILE));
  if (recordText === undefined) return 0;
  const cliStarted = existsSync(path.join(dir, CLI_STARTED_FILE));

  const record = parseTriggerRecord(recordText);
  if (record === undefined) {
    // A record that is present but unreadable is reported, never skipped: a
    // silent skip here is exactly the outcome this step exists to prevent.
    if (cliStarted) return 0;
    report(
      deps,
      renderCode("PRH-UNCLASSIFIED", { step: "the outcome record" }, "action"),
    );
    return 1;
  }
  // WHY: the record must describe this run. A mismatch means the directory is
  // not this job's, and nothing is posted on a PR on a guess.
  const runRepository = deps.env.GITHUB_REPOSITORY ?? "";
  const runId = deps.env.GITHUB_RUN_ID ?? "";
  if (
    (runRepository !== "" && record.repository !== runRepository) ||
    (runId !== "" && record.run_id !== runId)
  ) {
    deps.stdout(
      workflowCommand(
        "error",
        "pr-hero's outcome record belongs to another run, so nothing was posted.",
      ),
    );
    return 1;
  }

  const plan = decidePublication({ record, cliStarted });
  if (plan.kind === "none") return 0;
  report(deps, plan.rendered);
  if (plan.kind === "local") return 0;

  const status = postStatus(deps, plan);
  let exitCode = 0;
  if (!status.ok) {
    const variant =
      status.httpStatus === 403
        ? "permission"
        : status.httpStatus !== undefined && status.httpStatus >= 500
          ? "server"
          : undefined;
    const failure = renderCode(
      "PRH-STATUS-WRITE-FAILED",
      {
        detail:
          status.httpStatus === undefined
            ? "the request did not complete"
            : `HTTP ${status.httpStatus}`,
        runId: record.run_id,
        runUrl: record.run_url,
      },
      "action",
      variant,
    );
    report(deps, failure);
    exitCode = 1;
  }

  const comment = postComment(deps, plan);
  if (!comment.ok) {
    deps.stdout(
      workflowCommand(
        "error",
        `pr-hero could not post its outcome comment on #${plan.pr} (${comment.detail}).`,
      ),
    );
    return 1;
  }
  return exitCode;
}

if (import.meta.main) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY ?? "";
  process.exit(
    runPublish({
      env: process.env,
      gh: (args, stdin) => {
        const result = Bun.spawnSync(["gh", ...args], {
          stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
          stdout: "pipe",
          stderr: "pipe",
          // A hung API call must not hold the job: this step runs last.
          timeout: GH_TIMEOUT_MS,
        });
        return {
          exitCode: result.exitCode ?? -1,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
        };
      },
      stdout: (text) => {
        process.stdout.write(text);
      },
      appendSummary: (text) => {
        if (summaryPath !== "") appendFileSync(summaryPath, text);
      },
    }),
  );
}
