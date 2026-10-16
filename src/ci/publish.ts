// The outcome publisher (odd/tasks/agent-first-ci.md, T2b / S3, T2c). Every
// outcome of a run becomes ONE annotation, ONE step summary and, when the PR is
// known, ONE sticky comment on that PR. The commit status is posted only when a
// valid head sha is known: a status needs a sha, a comment does not. The
// comment's marker says head=unknown when no head is known. One case posts a
// comment with no status even when a head is known: a CLI-started run with no
// cli.json (see decideCliOutcome). The trigger writes
// the decision to trigger.json, the setup step may leave setup.json, and the CLI
// leaves cli.json for each terminal outcome of a review it started. This step
// reads them and speaks.
//
// It runs `if: !cancelled()`: a failed install skips every later step, and this
// step is the only one that can still say so, while a cancelled job (a
// superseded run) must not report a failure it never had. It is gated on the trigger's
// `publish` output, not on `run`, because `run` is false for exactly the
// outcomes this step reports.
//
// WHY the CLI's record decides once the CLI started: `cli-started` is the marker
// the run step writes before the CLI runs, and cli.json says what the run did.
// A `reviewed` record cleans up: a completed review contradicts an older run's
// outcome comment, so pr-hero's own older outcome comments on the PR go. An
// `error`, a `hunters-failed`, or a run with no record is published here with its
// code, because the CLI posts no comment for those. A `skipped` or `yielded` run
// is left alone: the CLI posted its own notice. A record that is absent,
// unreadable or malformed reads as no record, so the run stopped before it
// reported an outcome. Cleanup needs a PR, and it never posts a status.
//
// WHY the CLI's head comes first: cli.json names the head the CLI reviewed or
// resolved, when it knows one, and that is the head its outcome belongs to. The
// trigger's head is the fallback, since a failed `gh pr view` at trigger time can
// leave it out.
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
  CliRecord,
  ErrorParams,
  RenderedError,
  SetupRecord,
  TriggerRecord,
} from "./outcome";
import {
  CLI_RECORD_FILE,
  parseCliRecord,
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
const MARKER_PREFIX = "<!-- pr-hero-outcome";
const CLI_STARTED_FILE = "cli-started";
const RECORD_FILE = "trigger.json";
const SETUP_RECORD_FILE = "setup.json";
// The step a CLI outcome names. A CLI record carries no step, and every CLI
// outcome is about the review, so the publisher names it.
const REVIEW_STEP = "the review";
// The step a run names when no cli.json exists. The CLI exits without writing a
// record on a usage error, on a crash or kill, or when its record write failed,
// and the publisher cannot tell which, so the text claims only that it stopped
// before it reported an outcome.
const STOPPED_STEP = "the review before it reported an outcome";
// What a hunters-failed record says about the failure: the CLI writes no detail,
// and the publisher's wording names what its own record means (sessionFailed:
// every hunter failed, src/review/findings.ts).
const HUNTERS_DETAIL = "each hunter's session ended without a result";
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
      // Undefined when no head is known (no valid head in the record, or a
      // CLI-started run with no cli.json): the comment still posts.
      headSha: string | undefined;
      // Undefined exactly when headSha is: a commit status needs a sha.
      status: StatusPost | undefined;
      commentBody: string;
    };

// The pure table. Which outcome this run has is the record's decision and class
// (renderError / renderCode say what it means); whether anything can be posted
// on a PR is the record's pr alone: the head only decides the status.
export function decidePublication(input: {
  record: TriggerRecord | undefined;
  cliStarted: boolean;
  // The CLI's cli.json, read only for a review the CLI started. Undefined when
  // the file is absent, unreadable or malformed: the same as no record.
  cliRecord?: CliRecord;
  setup?: SetupRecord;
}): Publication {
  const record = input.record;
  if (record === undefined) return { kind: "none" };
  if (record.decision === "ignore" || record.decision === "denied") {
    // Denied and ignored commands publish nothing, by design (T2e adds reactions).
    return { kind: "none" };
  }
  if (record.decision === "review" && input.cliStarted) {
    return decideCliOutcome(record, input.cliRecord);
  }

  const params: ErrorParams = {
    ...record.params,
    pr: record.pr,
    runId: record.run_id,
    runUrl: record.run_url,
  };
  return remoteOrLocal(
    record,
    renderRecordOutcome(record, params, input.setup),
    record.head_sha,
  );
}

// WHY the CLI's record decides: the CLI posts its own status and comment for a
// completed review and for a skip, so those need nothing here. It posts neither
// for a crash, a class it could not map, or all hunters failing, so the publisher
// speaks for those with the code the record names. Cleanup needs a completed
// review: a stale outcome comment contradicts it, and nothing else removes that
// comment. A run with no record stopped before it reported, so it is the code for
// that, never silence, but only as a comment: the status stays the CLI's (see the
// no-record branch below).
function decideCliOutcome(
  record: TriggerRecord,
  cliRecord: CliRecord | undefined,
): Publication {
  const runParams: ErrorParams = {
    pr: record.pr,
    runId: record.run_id,
    runUrl: record.run_url,
  };
  if (cliRecord === undefined) {
    // WHY no status (F004 on #330): without a record the publisher cannot tell a
    // killed CLI from one whose record write failed (ENOSPC, or EACCES on a stale
    // cli.json.tmp). The CLI's own commit status already says how far it got:
    // success once the pipeline finished, error when its own teardown settled a
    // failure, pending when a kill left it in flight, or none when it died before
    // posting pending. A pending or missing required check still blocks a merge,
    // so the publisher explains in a comment and never overrides that status. An
    // error status here turned a completed review red. Passing no head is what
    // keeps the status out, since a status needs a sha. The marker then says
    // head=unknown even when the trigger knew one; nothing reads that field.
    return remoteOrLocal(
      record,
      renderError(
        { kind: "unknown" },
        { ...runParams, step: STOPPED_STEP },
        "action",
      ),
      undefined,
    );
  }
  switch (cliRecord.outcome) {
    case "reviewed":
      // WHY the cleanup needs a PR and no head: the older comments are on the
      // PR, and the completed review is the proof, whatever head the trigger saw.
      return record.pr === undefined
        ? { kind: "none" }
        : {
            kind: "cleanup",
            repository: record.repository,
            pr: record.pr,
            runId: record.run_id,
            runAttempt: record.run_attempt,
          };
    case "skipped":
    case "yielded":
      return { kind: "none" };
    case "hunters-failed":
      return remoteOrLocal(
        record,
        renderCode(
          "PRH-HUNTERS-FAILED",
          { ...runParams, step: REVIEW_STEP, detail: HUNTERS_DETAIL },
          "action",
        ),
        cliRecord.head_sha ?? record.head_sha,
      );
    case "error":
      // WHY the params merge: the review is the default step, the CLI's own
      // params (a backend or a secret name, when it has one) replace that
      // default, and this run's pr and run link replace both. The cls fallback
      // only narrows the type: parseCliRecord always sets cls for an error.
      return remoteOrLocal(
        record,
        renderError(
          cliRecord.cls ?? { kind: "unknown" },
          { step: REVIEW_STEP, ...cliRecord.params, ...runParams },
          "action",
        ),
        cliRecord.head_sha ?? record.head_sha,
      );
  }
}

// The one place an outcome becomes a plan: the annotation and summary always, and
// the PR's comment and status when the PR is known. The status needs a head; the
// comment does not, and its marker says head=unknown without one.
function remoteOrLocal(
  record: TriggerRecord,
  rendered: RenderedError,
  headSha: string | undefined,
): Publication {
  if (record.pr === undefined) return { kind: "local", rendered };
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

// The CLI's own record. Absent, unreadable or malformed all read as no record,
// so the caller's one rule covers each of them. No gh call.
function readCliRecord(dir: string): CliRecord | undefined {
  try {
    return parseCliRecord(
      readFileSync(path.join(dir, CLI_RECORD_FILE), "utf8"),
    );
  } catch {
    return undefined;
  }
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
  // WHY read only for a review the CLI started: no other outcome depends on the
  // CLI's record.
  const cliRecord =
    record.decision === "review" && cliStarted ? readCliRecord(dir) : undefined;
  const plan = decidePublication({ record, cliStarted, cliRecord, setup });
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
