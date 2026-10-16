// The outcome publisher (odd/tasks/agent-first-ci.md, T2b / S3). Every outcome
// that happens BEFORE the CLI step starts (no credential, an unresolved PR, an
// unverifiable commenter permission, a failed install step) becomes ONE
// annotation, ONE step summary and, when the PR is known, ONE sticky comment on
// that PR. The commit status is posted only when a valid head sha is known: a
// status needs a sha, a comment does not. The comment's marker says head=unknown
// when no head is known. The trigger writes the decision to trigger.json, and the
// setup step may leave setup.json; this step reads them and speaks.
//
// It runs `if: !cancelled()`: a failed install skips every later step, and this
// step is the only one that can still say so, while a cancelled job (a
// superseded run) must not report a failure it never had. It is gated on the trigger's
// `publish` output, not on `run`, because `run` is false for exactly the
// outcomes this step reports.
//
// It speaks for pre-CLI outcomes. `cli-started` is the marker the run step writes
// before anything else. The CLI owns this run's status and comment (T2c moves
// those here later), so once the CLI has started this step posts neither. What
// is left is one thing, `cleanup`: when the CLI's own commit status on the head
// says its review completed, it deletes the PR's older outcome comments that
// pr-hero wrote, because an earlier run's outcome would contradict that review.
// Only comments of an older run, or of an earlier attempt of this run, go. A CLI
// that did not complete keeps its comments: it left no outcome of its own, so the
// earlier comment is the only explanation on the PR. This path never posts a
// status or a comment, and it always exits 0.
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
import type {
  ErrorParams,
  RenderedError,
  SetupRecord,
  TriggerRecord,
} from "./outcome";
import {
  parseSetupRecord,
  parseTriggerRecord,
  renderCode,
  renderError,
} from "./outcome";

// The commit status context. The required check reads this name, so it must
// equal COMMIT_STATUS_CONTEXT in src/pr/preflight.ts (a test pins the two).
const STATUS_CONTEXT = "pr-hero";
// GitHub's limit on a commit status description.
const STATUS_DESCRIPTION_MAX = 140;
// The success descriptions the CLI posts when its review completed
// (src/pr/preflight.ts, commitStatusRequest: "review posted" when it published a
// comment, "review complete" when it did not). This module is builtins-only and
// cannot import that file, so the test suite builds the CLI's own statuses and
// fails here if their wording drifts.
const CLI_REVIEW_COMPLETED_DESCRIPTIONS: readonly string[] = [
  "review posted",
  "review complete",
];
const MARKER_PREFIX = "<!-- pr-hero-outcome";
const CLI_STARTED_FILE = "cli-started";
const RECORD_FILE = "trigger.json";
const SETUP_RECORD_FILE = "setup.json";
// The step an unverifiable lookup stopped at. The trigger writes the same text
// into its record; the publisher names it itself, so the message never depends
// on what a record carries.
const PERMISSION_STEP = "the commenter permission check";
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

// The CLI's own commit status on the head: the latest `pr-hero` status.
interface CliStatus {
  state: string;
  description: string;
}

export type Publication =
  | { kind: "none" }
  // Annotation and step summary only: no PR can be written to.
  | { kind: "local"; rendered: RenderedError }
  // The CLI's review completed and a PR is known: only older runs' (or earlier
  // attempts') outcome comments on this PR go. runId and runAttempt are this
  // run's place, the bound those comments are compared to.
  | {
      kind: "cleanup";
      repository: string;
      pr: number;
      runId: string;
      runAttempt: number;
    }
  | {
      kind: "remote";
      rendered: RenderedError;
      repository: string;
      pr: number;
      // This run's id and attempt. The cleanup after the post deletes only
      // comments of an older run, or of an earlier attempt of this run.
      runId: string;
      runAttempt: number;
      // Undefined when the record has no valid head: the comment still posts.
      headSha: string | undefined;
      // Undefined exactly when headSha is: a commit status needs a sha.
      status: StatusPost | undefined;
      commentBody: string;
    };

// WHY the status and not an exit code: the CLI exits 0 on a size-gate skip, an
// admission skip, manual-required and a yield to an in-flight review, and a
// completed review can exit 1 when findings were dropped. Only the CLI's
// teardown posts a success status, and only when its pipeline finished, so this
// status alone says that a review completed.
function cliReviewCompleted(status: CliStatus | undefined): boolean {
  return (
    status !== undefined &&
    status.state === "success" &&
    CLI_REVIEW_COMPLETED_DESCRIPTIONS.includes(status.description)
  );
}

// The pure table. Which outcome this run has is the record's decision and class
// (renderError / renderCode say what it means); whether anything can be posted
// on a PR is the record's pr alone: the head only decides the status.
export function decidePublication(input: {
  record: TriggerRecord | undefined;
  cliStarted: boolean;
  // The head's latest pr-hero status. Read only for a review the CLI started on
  // a known PR and head, so it is undefined everywhere else, and when the read
  // failed or no such status exists. Undefined deletes nothing.
  cliStatus?: CliStatus;
  setup?: SetupRecord;
}): Publication {
  const record = input.record;
  if (record === undefined) return { kind: "none" };
  if (record.decision === "ignore" || record.decision === "denied") {
    // Denied and ignored commands publish nothing, by design (T2e adds reactions).
    return { kind: "none" };
  }
  // WHY: the CLI owns this run's status and comment, so a second outcome here
  // would be a duplicate on the same PR. T2c hands those outcomes over. What is
  // left is the cleanup, and only once the CLI's own status says its review
  // completed: a stale outcome comment from an earlier run contradicts a review
  // that completed. cli-started alone does not prove that, and a CLI that did
  // not complete leaves no outcome of its own, so its run is left alone. T2c
  // moves that case here. Without a PR or a head there is nothing to clean.
  //
  // KNOWN GAPS of this gate, left as they are until T2c. The gate reads the
  // `pr-hero` status on the head the TRIGGER recorded, not on the head the CLI
  // reviewed (the CLI posts its status on its own head, src/pr/plan.ts).
  // (a) The trigger recorded no head (a failed `gh pr view` on a comment or
  //     dispatch run): there is no head to read, so cleanup does not run.
  // (b) The PR head moved between the trigger and the CLI: the read lands on the
  //     trigger's head, not the reviewed one. Its latest pr-hero status may be a
  //     completed review left by an earlier run on that head. Cleanup then runs
  //     on a status this run did not write, and can delete an older run's
  //     outcome comment while this run's review is incomplete. This case is NOT
  //     fail-safe.
  // T2c replaces this gate with the CLI's own outcome record, which carries the
  // head the CLI actually reviewed, so cleanup no longer depends on the
  // trigger's head or on reading a commit status.
  if (record.decision === "review" && input.cliStarted) {
    if (
      !cliReviewCompleted(input.cliStatus) ||
      record.pr === undefined ||
      record.head_sha === undefined
    ) {
      return { kind: "none" };
    }
    return {
      kind: "cleanup",
      repository: record.repository,
      pr: record.pr,
      runId: record.run_id,
      runAttempt: record.run_attempt,
    };
  }

  const params: ErrorParams = {
    ...record.params,
    pr: record.pr,
    runId: record.run_id,
    runUrl: record.run_url,
  };
  const rendered = renderRecordOutcome(record, params, input.setup);
  if (record.pr === undefined) return { kind: "local", rendered };
  const headSha = record.head_sha;
  return {
    kind: "remote",
    rendered,
    repository: record.repository,
    pr: record.pr,
    runId: record.run_id,
    runAttempt: record.run_attempt,
    headSha,
    status:
      headSha === undefined
        ? undefined
        : {
            state: "error",
            context: STATUS_CONTEXT,
            description: statusDescription(rendered),
            targetUrl: record.run_url,
          },
    commentBody: [
      `${MARKER_PREFIX} v=1 head=${headSha ?? "unknown"} run=${record.run_id} attempt=${record.run_attempt} -->`,
      "",
      ...rendered.summary,
    ].join("\n"),
  };
}

function renderRecordOutcome(
  record: TriggerRecord,
  params: ErrorParams,
  setup: SetupRecord | undefined,
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
      { ...params, step: PERMISSION_STEP },
      "action",
    );
  }
  // A review that never reached the CLI: a recorded class is the cause (the PR
  // could not be resolved); a setup record names the malformed input the setup
  // step found; otherwise the install step failed before the run.
  if (record.cls !== undefined) {
    return renderError(record.cls, params, "action");
  }
  if (setup !== undefined) {
    return renderError(
      setup.cls,
      { ...params, detail: setup.detail },
      "action",
    );
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
  command: "error" | "warning" | "notice",
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
  repository: string,
  headSha: string,
  status: StatusPost,
): { ok: true } | { ok: false; httpStatus: number | undefined } {
  const args = [
    "api",
    `repos/${repository}/statuses/${headSha}`,
    "-f",
    `state=${status.state}`,
    "-f",
    `context=${status.context}`,
    "-f",
    `description=${status.description}`,
    "-f",
    `target_url=${status.targetUrl}`,
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
  deleteOlderOutcomes(
    deps,
    repo,
    plan.pr,
    newId,
    author,
    currentRunOrder(plan.runId, plan.runAttempt),
  );
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

// One comment, as the listing's --jq filter prints it.
interface ListedComment {
  id: number;
  login: string;
  type: string;
  firstLine: string;
}

// Every comment on the PR, in the order the API lists them. undefined when the
// listing call fails, so each caller words that failure for its own path.
function listComments(
  deps: PublishDeps,
  repo: string,
  pr: number,
): ListedComment[] | undefined {
  const listed = deps.gh([
    "api",
    "--paginate",
    `repos/${repo}/issues/${pr}/comments`,
    "--jq",
    '.[] | [.id, .user.login, .user.type, (.body | split("\\n") | .[0])] | @json',
  ]);
  if (listed.exitCode !== 0) return undefined;
  const rows: ListedComment[] = [];
  for (const line of listed.stdout.split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(row)) continue;
    const [id, login, type, firstLine] = row;
    if (typeof id !== "number" || typeof firstLine !== "string") continue;
    rows.push({
      id,
      login: typeof login === "string" ? login : "",
      type: typeof type === "string" ? type : "",
      firstLine,
    });
  }
  return rows;
}

function isOutcomeComment(row: ListedComment): boolean {
  return row.firstLine.startsWith(MARKER_PREFIX);
}

// Deletes each comment. A failed delete is a warning, and the rest still run.
function deleteComments(
  deps: PublishDeps,
  repo: string,
  pr: number,
  ids: readonly number[],
): void {
  for (const id of ids) {
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

// A positive integer, or undefined. Run ids and the ids in markers are read here.
function positiveInteger(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// A run's place in the order: its run id, then its attempt within that run.
interface RunOrder {
  runId: number;
  attempt: number;
}

// WHY the guard: run ids increase within a repository, so this run's place is
// its id. A run id that is not a safe positive integer has no place, and then no
// comment can be proven older than this run, so the caller keeps them all.
function currentRunOrder(runId: string, attempt: number): RunOrder | undefined {
  const id = positiveInteger(runId);
  return id === undefined ? undefined : { runId: id, attempt };
}

// The place a marker names. A marker with no positive run id has no place, so
// it is never deleted. A marker with no parseable attempt is attempt 1: every
// marker written before attempts were recorded is the first attempt of its run.
function markerRunOrder(firstLine: string): RunOrder | undefined {
  const runId = positiveInteger(/\brun=(\S+)/.exec(firstLine)?.[1] ?? "");
  if (runId === undefined) return undefined;
  const attempt =
    positiveInteger(/\battempt=(\S+)/.exec(firstLine)?.[1] ?? "") ?? 1;
  return { runId, attempt };
}

// WHY the order: a comment from a run that is not older than this one was
// posted by a run still going, or by a newer one, and neither is this run's to
// remove. A re-run keeps the run id, so within one run the attempt decides:
// only an earlier attempt is older. Comment ids alone are not enough: a later
// run can post before this one, and its comment then has the lower id.
function isOlderRunComment(
  row: ListedComment,
  current: RunOrder | undefined,
): boolean {
  if (current === undefined) return false;
  const theirs = markerRunOrder(row.firstLine);
  if (theirs === undefined) return false;
  if (theirs.runId !== current.runId) return theirs.runId < current.runId;
  return theirs.attempt < current.attempt;
}

function deleteOlderOutcomes(
  deps: PublishDeps,
  repo: string,
  pr: number,
  newId: number,
  author: string,
  current: RunOrder | undefined,
): void {
  const rows = listComments(deps, repo, pr);
  if (rows === undefined) {
    deps.stdout(
      workflowCommand(
        "warning",
        `pr-hero could not list the older outcome comments on #${pr}; they were left in place.`,
      ),
    );
    return;
  }
  deleteComments(
    deps,
    repo,
    pr,
    rows
      .filter(
        (row) =>
          row.id < newId &&
          row.login === author &&
          isOutcomeComment(row) &&
          isOlderRunComment(row, current),
      )
      .map((row) => row.id),
  );
}

// WHY cleanup runs once the CLI's review completed: an older outcome comment says
// a run could not start the review. A later run's review has now completed, so
// that comment contradicts the PR, and nothing else removes it. Only older runs'
// and earlier attempts' comments go (see isOlderRunComment).
//
// WHY the identity chain: the older comments were written with the workflow's
// token, which cannot read /user. GraphQL `viewer` names the login that wrote
// them, but whether it answers for this token is not verified here, so the Bot
// type is the fallback: the workflow token posts as github-actions[bot], and a
// person is never a Bot. GraphQL spells that account `github-actions` while REST
// adds the `[bot]` suffix, so a REST login matches the viewer login or that
// login with the suffix. Any other Bot login is kept. A person's comment is
// never deleted on a guess: with no login, only a Bot is deleted.
function cleanupOlderOutcomes(
  deps: PublishDeps,
  plan: { repository: string; pr: number; runId: string; runAttempt: number },
): void {
  const current = currentRunOrder(plan.runId, plan.runAttempt);
  const viewer = deps.gh([
    "api",
    "graphql",
    "-f",
    "query=query { viewer { login } }",
    "--jq",
    ".data.viewer.login",
  ]);
  const login = viewer.exitCode === 0 ? viewer.stdout.trim() : "";
  const rows = listComments(deps, plan.repository, plan.pr);
  if (rows === undefined) {
    deps.stdout(
      workflowCommand(
        "notice",
        `pr-hero could not clean up its older outcome comments on #${plan.pr}; they were left in place.`,
      ),
    );
    return;
  }
  const isMine = (row: ListedComment): boolean =>
    login !== ""
      ? row.login === login || row.login === `${login}[bot]`
      : row.type === "Bot";
  deleteComments(
    deps,
    plan.repository,
    plan.pr,
    rows
      .filter(
        (row) =>
          isOutcomeComment(row) &&
          isMine(row) &&
          isOlderRunComment(row, current),
      )
      .map((row) => row.id),
  );
}

function readIfExists(filePath: string): string | undefined {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
}

// One row of the head's status list, as the read's --jq filter prints it.
interface StatusRow {
  context: string;
  state: string;
  description: string;
  createdAt: string;
}

// The newest `pr-hero` row. The read keeps the latest status of each context,
// but the newest is still picked by time, as the CLI's own reader does
// (src/pr/preflight.ts, latestPrHeroStatus). A row with no readable time is out.
function latestCliStatus(rows: readonly StatusRow[]): CliStatus | undefined {
  let latest: StatusRow | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.context !== STATUS_CONTEXT) continue;
    const createdMs = Date.parse(row.createdAt);
    if (Number.isNaN(createdMs) || createdMs < latestMs) continue;
    latest = row;
    latestMs = createdMs;
  }
  return latest === undefined
    ? undefined
    : { state: latest.state, description: latest.description };
}

// The head's pr-hero status as the CLI left it. WHY the combined endpoint: it
// returns the latest status of each context. WHY per_page=100: it pages at 30
// contexts by default, and a busy head's pr-hero row can sit past the first
// page; a head with more than 100 contexts still needs a further page.
// src/pr/pr.ts reads the same endpoint. A failed read is undefined, which cleans
// up nothing and prints nothing.
function readCliStatus(
  deps: PublishDeps,
  repo: string,
  sha: string,
): CliStatus | undefined {
  const read = deps.gh([
    "api",
    `repos/${repo}/commits/${sha}/status?per_page=100`,
    "--jq",
    ".statuses[]? | [.context, .state, .description, .created_at] | @json",
  ]);
  if (read.exitCode !== 0) return undefined;
  const rows: StatusRow[] = [];
  for (const line of read.stdout.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(value)) continue;
    const [context, state, description, createdAt] = value;
    if (
      typeof context !== "string" ||
      typeof state !== "string" ||
      typeof description !== "string" ||
      typeof createdAt !== "string"
    ) {
      continue;
    }
    rows.push({ context, state, description, createdAt });
  }
  return latestCliStatus(rows);
}

// The status is read only where it can decide: a review the CLI started on a
// known PR and head. Everywhere else no gh call is made.
function readCliStatusFor(
  deps: PublishDeps,
  record: TriggerRecord,
  cliStarted: boolean,
): CliStatus | undefined {
  if (record.decision !== "review" || !cliStarted) return undefined;
  if (record.pr === undefined || record.head_sha === undefined) {
    return undefined;
  }
  return readCliStatus(deps, record.repository, record.head_sha);
}

export function runPublish(deps: PublishDeps): number {
  const dir = deps.env.PRHERO_OUTCOME_DIR ?? "";
  if (dir === "") return 0;
  const recordText = readIfExists(path.join(dir, RECORD_FILE));
  if (recordText === undefined) return 0;
  const cliStarted = existsSync(path.join(dir, CLI_STARTED_FILE));

  const record = parseTriggerRecord(recordText);
  // Read with the record, so both files are judged in one place. The decision
  // uses it only for an install failure.
  const setupText = readIfExists(path.join(dir, SETUP_RECORD_FILE));
  const setup =
    setupText === undefined ? undefined : parseSetupRecord(setupText);
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
  // not this job's, and nothing is posted on a PR on a guess. The attempt is
  // part of it: gh run rerun keeps the run id, so a record of an earlier attempt
  // can still be on disk. An absent or invalid attempt is attempt 1, the same
  // default the trigger writes.
  const runRepository = deps.env.GITHUB_REPOSITORY ?? "";
  const runId = deps.env.GITHUB_RUN_ID ?? "";
  const runAttempt = positiveInteger(deps.env.GITHUB_RUN_ATTEMPT ?? "") ?? 1;
  if (
    (runRepository !== "" && record.repository !== runRepository) ||
    (runId !== "" && record.run_id !== runId) ||
    record.run_attempt !== runAttempt
  ) {
    deps.stdout(
      workflowCommand(
        "error",
        "pr-hero's outcome record belongs to another run or attempt, so nothing was posted.",
      ),
    );
    return 1;
  }

  if (setupText !== undefined && setup === undefined) {
    deps.stdout(
      workflowCommand(
        "warning",
        "pr-hero could not read its setup outcome record, so this failure is reported as an install failure.",
      ),
    );
  }
  const cliStatus = readCliStatusFor(deps, record, cliStarted);
  const plan = decidePublication({ record, cliStarted, cliStatus, setup });
  if (plan.kind === "none") return 0;
  if (plan.kind === "cleanup") {
    cleanupOlderOutcomes(deps, plan);
    return 0;
  }
  report(deps, plan.rendered);
  if (plan.kind === "local") return 0;

  let exitCode = 0;
  // WHY the status is optional: it needs a sha, and the comment below does not.
  if (plan.status !== undefined && plan.headSha !== undefined) {
    const status = postStatus(deps, plan.repository, plan.headSha, plan.status);
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
        // WHY the catch: Bun throws, rather than returning, when gh is not on
        // PATH. A throw would end the step non-zero, and cleanup must exit 0, so
        // a call that cannot run is a failed call like any other.
        try {
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
        } catch (error) {
          return { exitCode: -1, stdout: "", stderr: String(error) };
        }
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
