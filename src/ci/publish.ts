// The outcome publisher (odd/tasks/agent-first-ci.md, T2b / S3, T2c). Every
// outcome of a run becomes ONE annotation, ONE step summary and, when the PR is
// known, ONE sticky comment on that PR. The commit status is posted only when a
// valid head sha is known: a status needs a sha, a comment does not. The
// comment's marker says head=unknown when no head is known. One case decides on
// the head's own status: a CLI-started run whose cli.json is a `reviewing` progress
// record. That record says the CLI took the pending lock on its own head, so the
// status on that head is replaced when it is still pending or unreadable, and the
// comment alone is posted when it settled (see decideCliOutcome). The trigger writes
// the decision to trigger.json, the setup step may leave setup.json, and the CLI
// leaves cli.json: a progress record while it holds the lock, then its outcome. This
// step reads them and speaks.
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
// outcome comment, so pr-hero's own older outcome comments on the PR go. When that
// record also carries the status its CLI could not write, the status is posted first,
// once, on the record's head (see the cleanup branch of runPublish). An
// `error`, a `hunters-failed`, or a `reviewing` record is published here with its
// code, because the CLI posts no comment for those. A `skipped` or `yielded` run
// is left alone: the CLI posted its own notice. A record that is absent,
// unreadable or malformed reads as no record: the run took no lock the publisher
// can see, so it gets the comment alone and no status (see decideCliOutcome).
// Cleanup needs a PR, and it never posts a status on a run with no lock.
//
// WHY the lock's head comes from the record (F002 on #330): the CLI posts its pending
// hold on the head it resolved itself, and the reviewing record names that head. The
// trigger's head can differ after a push, so it is never read for a lock. For the
// other outcomes, cli.json names the head the CLI reviewed or resolved, when it knows
// one, and the trigger's head is the fallback, since a failed `gh pr view` at trigger
// time can leave it out.
//
// WHY ONLY BUILTINS (plus ./outcome and ./override): the step runs before anything is
// installed, so a package import has no node_modules to resolve against. ./outcome and
// ./override are siblings that are themselves builtins-only at runtime: ./outcome's
// repository imports are `import type`, erased at transpile, and ./override imports
// nothing. Relative imports need no node_modules.
//
// WHY repost, not edit: GitHub does not notify on an edit, and an edited comment
// does not move down the timeline. So the fresh comment is POSTED first, and the
// older outcome comments of the SAME author are deleted after it (see
// repostMarkedPrComment in src/pr/pr.ts, which made the same choice for the skip
// notice on #315). Posting first means a failed POST deletes nothing.

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
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
  OUTCOME_MARKER_PREFIX,
  PENDING_AT_FILE,
  parseCliRecord,
  parseSetupRecord,
  parseTriggerRecord,
  renderCode,
  renderError,
  renderHunterCause,
  STATUS_DESCRIPTION_MAX,
} from "./outcome";
import {
  newestStatusInContext,
  OVERRIDE_DESCRIPTION_PREFIX,
  type OverrideStatusFact,
  overrideStandsOverRun,
} from "./override";

// The commit status context. The required check reads this name, so it must
// equal COMMIT_STATUS_CONTEXT in src/pr/preflight.ts (a test pins the two).
const STATUS_CONTEXT = "pr-hero";
// The outcome marker's spelling is outcome.ts's, shared with the status reader.
const MARKER_PREFIX = OUTCOME_MARKER_PREFIX.trimEnd();
const CLI_STARTED_FILE = "cli-started";
const RECORD_FILE = "trigger.json";
const SETUP_RECORD_FILE = "setup.json";
// The step a CLI outcome names. A CLI record carries no step, and every CLI
// outcome is about the review, so the publisher names it.
const REVIEW_STEP = "the review";
// The step a run names when it has no outcome: no cli.json, or a reviewing record
// that no outcome followed. The CLI exits without an outcome on a usage error, on a
// crash or kill, or when its record write failed, and the publisher cannot tell
// which, so the text claims only that it stopped before it reported an outcome.
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
  // `success` comes from an override (odd/tasks/agent-first-ci.md, S8) or from the
  // final status a CLI could not write; `failure` only from the latter.
  state: "error" | "success" | "failure";
  context: "pr-hero";
  description: string;
  targetUrl: string;
}

// The newest pr-hero status of the head a reviewing record names: a pending
// status is a CLI that never settled, a settled one is a finished CLI, and anything
// else (an unreadable answer, no pr-hero row, a state this table does not name) is
// unknown.
type LatestStatusState = "pending" | "settled" | "unknown";

export type Publication =
  | { kind: "none" }
  // Annotation and step summary only: no PR can be written to.
  | { kind: "local"; rendered: RenderedError }
  // A human's override (odd/tasks/agent-first-ci.md, S8): a success status on the
  // head it names, then, only when that status was written, the cleanup of older
  // outcome comments (the same cleanup a completed review runs, since both settle the
  // head), then an audit comment. Nothing ran, so nothing is rendered as an outcome.
  // The override's audit comments and the report summary are never cleaned up.
  | {
      kind: "override";
      repository: string;
      pr: number;
      runId: string;
      runAttempt: number;
      runUrl: string;
      actor: string;
      // Undefined when the record names no head: the comment still posts, and says
      // that no status could be set.
      headSha: string | undefined;
    }
  // The CLI's review completed. Its record may carry the status the CLI could not
  // write, which is posted first, on the record's head. Then only older runs' (or
  // earlier attempts') outcome comments on this PR go, when the PR is known. runId
  // and runAttempt are this run's place, the bound those comments are compared to.
  | {
      kind: "cleanup";
      repository: string;
      // Undefined when the PR is unknown: then only the unsettled status is written.
      pr: number | undefined;
      runId: string;
      runAttempt: number;
      // The unsettled status and the head it is for, when the record carries both.
      // Undefined otherwise, which is every reviewed record without the field.
      headSha?: string;
      status?: StatusPost;
      // The override cutoff the CLI computed for the run, when the record carries one. The repost
      // is skipped when an override created at or after it stands on the head
      // (overrideStandsBeforeRepost). Undefined means no cutoff to judge against, and the repost
      // goes ahead as before.
      overrideCutoffMs?: number;
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
      // Undefined when no head is known (no valid head in the record, or a run that
      // took no lock): the comment still posts.
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
  // The status of the head a reviewing record names. runPublish reads it only for
  // that case; undefined elsewhere, and treated as unknown in that one case.
  latestStatusState?: LatestStatusState;
}): Publication {
  const record = input.record;
  if (record === undefined) return { kind: "none" };
  if (record.decision === "ignore" || record.decision === "denied") {
    // Denied and ignored commands publish nothing: the trigger answers them with a
    // reaction on the comment instead (T2e), so the PR gets no text reply.
    return { kind: "none" };
  }
  // WHY before the outcome fallthrough below: an override is not an error, and
  // rendering it as one would publish a false PRH-INSTALL-FAILED.
  if (record.decision === "override") return decideOverride(record);
  if (record.decision === "review" && input.cliStarted) {
    return decideCliOutcome(record, input.cliRecord, input.latestStatusState);
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

// WHY the record's PR and actor are both required: parseTriggerRecord refuses an
// override without them, so this is the reader's own guarantee for the type.
function decideOverride(record: TriggerRecord): Publication {
  if (record.pr === undefined || record.actor === undefined) {
    return { kind: "none" };
  }
  return {
    kind: "override",
    repository: record.repository,
    pr: record.pr,
    runId: record.run_id,
    runAttempt: record.run_attempt,
    runUrl: record.run_url,
    actor: record.actor,
    headSha: record.head_sha,
  };
}

// WHY the CLI's record decides: the CLI posts its own status and comment for a
// completed review and for a skip, so those need nothing here. It posts neither
// for a crash, a class it could not map, or all hunters failing, so the publisher
// speaks for those with the code the record names. Cleanup needs a settled head:
// a completed review, or an override that set its status (publishOverride), makes
// a stale outcome comment contradict the PR, and nothing else removes that comment.
// A run with no record took no lock the publisher can see, so it gets the
// comment alone (see the no-record branch below). A reviewing record decides its status
// by the head it names (see that case), never by the trigger's head.
function decideCliOutcome(
  record: TriggerRecord,
  cliRecord: CliRecord | undefined,
  latestStatusState: LatestStatusState | undefined,
): Publication {
  const runParams: ErrorParams = {
    pr: record.pr,
    runId: record.run_id,
    runUrl: record.run_url,
  };
  if (cliRecord === undefined) {
    // WHY no status (F001 and F002 on #330): without a progress record the publisher
    // cannot tell whose pending lock sits on a head, so it writes no status on any
    // head. A skipped or yielded run must not turn red, and another process's live
    // lock must not be overwritten. The comment alone says what happened. The one
    // case this leaves is a CLI that held the lock but whose every record write
    // failed: its pending then ends with the admission gate's 90-minute TTL. The
    // marker says head=unknown, and nothing reads that field.
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
    case "reviewing": {
      // WHY the record's head (F002 on #330): the CLI posted its pending hold on the
      // head this record names, so the lock to replace is there, whatever head the
      // trigger saw. The CLI holds the lock and recorded no outcome (it was killed, or
      // its terminal write failed), so the lock is this run's own and a visible red is
      // recoverable. A settled status means the CLI finished, so it stands (F004). An
      // unreadable status takes the error status too, the same reasoning.
      const replacesLock = latestStatusState !== "settled";
      return remoteOrLocal(
        record,
        renderError(
          { kind: "unknown" },
          { ...runParams, step: STOPPED_STEP },
          "action",
        ),
        replacesLock ? cliRecord.head_sha : undefined,
      );
    }
    case "reviewed": {
      // WHY the cleanup needs a PR and no head: the older comments are on the
      // PR, and the completed review is the proof, whatever head the trigger saw.
      // WHY the status needs neither: it sits on the record's head, so it is posted
      // even when no PR is known, and then nothing is cleaned.
      const unsettled = unsettledStatusOf(record, cliRecord);
      if (record.pr === undefined && unsettled === undefined) {
        return { kind: "none" };
      }
      return {
        kind: "cleanup",
        repository: record.repository,
        pr: record.pr,
        runId: record.run_id,
        runAttempt: record.run_attempt,
        ...unsettled,
      };
    }
    case "skipped":
    case "yielded":
      return { kind: "none" };
    case "hunters-failed":
      return remoteOrLocal(
        record,
        huntersFailedRendering(cliRecord, runParams),
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

// The status a reviewed record's CLI could not write, on the head that record names, in
// the shape postStatus takes. Undefined when the record carries no status, or names no
// head: a status needs a sha, and the publisher does not guess one from the trigger.
function unsettledStatusOf(
  record: TriggerRecord,
  cliRecord: CliRecord,
):
  | { headSha: string; status: StatusPost; overrideCutoffMs?: number }
  | undefined {
  const unsettled = cliRecord.unsettled_status;
  if (unsettled === undefined || cliRecord.head_sha === undefined) {
    return undefined;
  }
  return {
    headSha: cliRecord.head_sha,
    overrideCutoffMs: cliRecord.override_cutoff_ms,
    status: {
      state: unsettled.state,
      context: STATUS_CONTEXT,
      description: unsettled.description,
      targetUrl: record.run_url,
    },
  };
}

// The rendering of a hunters-failed run. WHY every hunter and not any: a run whose
// hunters failed for one known cause on the provider's or the configuration's side has
// nothing else to fix, so that cause's own code and owner are rendered. The provider
// and the model are named only when every entry agrees on them. A mix of causes, an
// entry with no cause, or a cause with no code of its own (runtime_unavailable) keeps
// the generic code, since no single cause explains the run.
function huntersFailedRendering(
  cliRecord: CliRecord,
  runParams: ErrorParams,
): RenderedError {
  const failures = cliRecord.hunter_failures ?? [];
  const cause = sharedValue(failures.map((failure) => failure.cause));
  if (cause !== undefined) {
    const rendered = renderHunterCause(
      cause,
      {
        ...runParams,
        step: REVIEW_STEP,
        detail: HUNTERS_DETAIL,
        provider: sharedValue(failures.map((failure) => failure.provider)),
        model: sharedValue(failures.map((failure) => failure.model)),
      },
      "action",
    );
    if (rendered !== undefined) return rendered;
  }
  return renderCode(
    "PRH-HUNTERS-FAILED",
    { ...runParams, step: REVIEW_STEP, detail: HUNTERS_DETAIL },
    "action",
  );
}

// The one value every entry names, or undefined when they name none or differ.
function sharedValue<T>(values: readonly (T | undefined)[]): T | undefined {
  const distinct = new Set(values);
  if (distinct.size !== 1) return undefined;
  const [only] = distinct;
  return only;
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
  return clipStatusDescription(`${rendered.code}: ${rendered.what}`);
}

// The one clipping rule of a status description: one line, at most the status limit.
function clipStatusDescription(text: string): string {
  const line = text.replace(/\s+/g, " ");
  return line.length > STATUS_DESCRIPTION_MAX
    ? line.slice(0, STATUS_DESCRIPTION_MAX)
    : line;
}

// The status a cancelled review settles its own pending on (SB3). A cancel kills the CLI
// before its signal settle lands, so the publisher writes this instead of leaving the head
// pending. It names the cancel and the way to review the head again.
export const CANCELLED_STATUS_DESCRIPTION =
  "PRH-CANCELLED: not reviewed — /pr-hero review reviews this head";

// WHY an exact match (review #347 rounds 1-3): the CLI records the created_at GitHub returned
// for its own pending (PENDING_AT_FILE, written once the pending landed). The settle
// overwrites the head's newest pending only when its created_at is exactly that time, so
// another run's pending (a Force Review beside a push run on the same head) is never
// touched, however close in time it was posted. No record of the pending means this run's
// pending never landed, or the CLI died first, and there is nothing of this run's to settle.
// Any CLI record that names a head is this run's lock on it: the CLI rewrites its record
// (reviewing, then reviewed or hunters-failed) before its final status.
// The CLI's placeholder before its pending POST answered (src/ci/cli-record.ts
// PENDING_POSTING_PREFIX; a literal here, since this module imports builtins and outcome.ts
// only). A test pins the two equal.
export const PENDING_POSTING_MARK = "posting ";
const CANCEL_POSTING_SKEW_MS = 5_000;
const CANCEL_POSTING_WINDOW_MS = 30_000;

export function decideCancelSettle(input: {
  record: CliRecord | undefined;
  latest: { state: string; created_at: string } | undefined;
  pendingAt: string | undefined;
}): { settle: true; headSha: string } | { settle: false; reason: string } {
  const record = input.record;
  if (record === undefined || record.head_sha === undefined) {
    return { settle: false, reason: "no review lock in this run" };
  }
  if (input.latest?.state !== "pending") {
    return {
      settle: false,
      reason: "the head's pr-hero status is not pending",
    };
  }
  const own = input.pendingAt;
  const createdMs = Date.parse(input.latest.created_at);
  // The CLI wrote "posting <ms>" just before its POST and had not yet recorded the answer:
  // the cancel landed inside the POST. Its pending, if it landed, was created within
  // seconds of that time (review #347 round 4).
  if (own?.startsWith(PENDING_POSTING_MARK) === true) {
    const postingMs = Number(own.slice(PENDING_POSTING_MARK.length));
    if (
      Number.isFinite(postingMs) &&
      createdMs >= postingMs - CANCEL_POSTING_SKEW_MS &&
      createdMs <= postingMs + CANCEL_POSTING_WINDOW_MS
    ) {
      return { settle: true, headSha: record.head_sha };
    }
    return { settle: false, reason: "the pending status is not this run's" };
  }
  if (
    own === undefined ||
    !Number.isFinite(Date.parse(own)) ||
    createdMs !== Date.parse(own)
  ) {
    return { settle: false, reason: "the pending status is not this run's" };
  }
  return { settle: true, headSha: record.head_sha };
}

// ---------------------------------------------------------------------------
// The shell.
// ---------------------------------------------------------------------------

export interface PublishDeps {
  env: Readonly<Record<string, string | undefined>>;
  // Stdin is the comment body; the answer is gh's result.
  gh: (args: readonly string[], stdin?: string) => GhResult;
  sleep?: (ms: number) => void;
  // The clock for an override's UTC time. Optional, so a test pins it and the real
  // clock is the default.
  now?: () => Date;
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

// The status write, retried once unless `attempts` is 1. Returns the failure's HTTP
// status when gh printed one, so the renderer can pick the permission or the server
// wording.
function postStatus(
  deps: PublishDeps,
  repository: string,
  headSha: string,
  status: StatusPost,
  attempts = 2,
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
  if (result.exitCode !== 0 && attempts > 1) {
    (deps.sleep ?? ((ms: number) => Bun.sleepSync(ms)))(STATUS_RETRY_DELAY_MS);
    result = deps.gh(args);
  }
  if (result.exitCode === 0) return { ok: true };
  return { ok: false, httpStatus: httpStatusOf(result) };
}

// The one rendering of a failed status write, for the outcome's status and for the
// unsettled one alike. The detail names the HTTP status when gh printed one.
function statusWriteFailure(
  httpStatus: number | undefined,
  runId: string,
  runUrl: string,
): RenderedError {
  const variant =
    httpStatus === 403
      ? "permission"
      : httpStatus !== undefined && httpStatus >= 500
        ? "server"
        : undefined;
  return renderCode(
    "PRH-STATUS-WRITE-FAILED",
    {
      detail:
        httpStatus === undefined
          ? "the request did not complete"
          : `HTTP ${httpStatus}`,
      runId,
      runUrl,
    },
    "action",
    variant,
  );
}

// Posts the comment, then deletes the older outcome comments of the same author.
// Returns the failure of the POST only: the cleanup is best effort, because the
// fresh comment has already landed and one stale duplicate is the safe error.
// The comment's POST alone, with the id and author GitHub answers with. Either is
// undefined when the answer is unreadable, and then nothing is cleaned up.
function createComment(
  deps: PublishDeps,
  repo: string,
  pr: number,
  body: string,
):
  | { ok: true; newId: number | undefined; author: string | undefined }
  | { ok: false; detail: string } {
  const created = deps.gh(
    [
      "api",
      "--method",
      "POST",
      `repos/${repo}/issues/${pr}/comments`,
      "-F",
      "body=@-",
      "--jq",
      "[.id, .user.login] | @json",
    ],
    body,
  );
  if (created.exitCode !== 0) {
    const status = httpStatusOf(created);
    return {
      ok: false,
      detail: status === undefined ? "no HTTP response" : `HTTP ${status}`,
    };
  }
  const [newId, author] = parseCreated(created.stdout);
  return { ok: true, newId, author };
}

// Posts the comment, then deletes the older outcome comments of the same author.
// Returns the failure of the POST only: the cleanup is best effort, because the
// fresh comment has already landed and one stale duplicate is the safe error.
function postComment(
  deps: PublishDeps,
  plan: Extract<Publication, { kind: "remote" }>,
): { ok: true } | { ok: false; detail: string } {
  const repo = plan.repository;
  const created = createComment(deps, repo, plan.pr, plan.commentBody);
  if (!created.ok) return created;
  const { newId, author } = created;
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

// WHY only the outcome marker counts: an override comment is the audit trail of a
// human's unlock (S8). Its marker starts `<!-- pr-hero-override`, which does not
// start with MARKER_PREFIX, so no cleanup or older-run pass can remove it.
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

// WHY cleanup runs once a head settles: a completed review (runPublish's cleanup
// branch), or an override whose success status was written (publishOverride). An
// older outcome comment says a run could not start the review. A later run has now
// settled the head, so that comment contradicts the PR, and nothing else removes it.
// Only older runs' and earlier attempts' comments go (see isOlderRunComment), and
// the override's audit comments and the report summary never match isOutcomeComment.
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

const SETTLED_STATES: ReadonlySet<string> = new Set([
  "success",
  "error",
  "failure",
]);

// The result of reading the head's statuses. A failed read and an empty answer are different
// things: an empty answer says the head has no statuses, a failed read says nothing about them.
type HeadStatusRead =
  | { ok: true; statuses: OverrideStatusFact[] }
  | { ok: false };

// The head's statuses, as the combined-status endpoint returns them, read through this step's
// own gh seam in one attempt. A failed gh call is { ok: false }. WHY per_page=100: the combined
// endpoint pages at 30 contexts by default, and a busy head's pr-hero row can sit past the
// first page. The description is read too, for the override rule.
//
// A malformed row is dropped and the rest are read, for both callers (the override check before a
// repost, and the reviewing path). WHY: a corrupt row must never turn a settled head into an error
// overwrite, and a valid override on the head must not be hidden by a garbage line next to it. Only
// a failed gh call is an unknown read.
function readHeadStatuses(
  deps: PublishDeps,
  repo: string,
  sha: string,
): HeadStatusRead {
  const read = deps.gh([
    "api",
    `repos/${repo}/commits/${sha}/status?per_page=100`,
    "--jq",
    ".statuses[]? | [.context, .state, .created_at, .description] | @json",
  ]);
  if (read.exitCode !== 0) return { ok: false };
  const statuses: OverrideStatusFact[] = [];
  for (const line of read.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const row = parseStatusRow(line);
    if (row === undefined) continue;
    statuses.push(row);
  }
  return { ok: true, statuses };
}

// One --jq row as an override fact, or undefined when the line does not parse to one.
function parseStatusRow(line: string): OverrideStatusFact | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const [context, state, createdAt, description] = value;
  if (
    typeof context !== "string" ||
    typeof state !== "string" ||
    typeof createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    context,
    state,
    created_at: createdAt,
    description: typeof description === "string" ? description : undefined,
  };
}

// The head's newest pr-hero status, as the three states the table needs. The newest row is
// picked by its time, not by its place in the answer. A failed read, no pr-hero row, or a
// state the table does not name is unknown, which the table answers with the status.
function readLatestCliStatusState(
  deps: PublishDeps,
  repo: string,
  sha: string,
): LatestStatusState {
  const read = readHeadStatuses(deps, repo, sha);
  if (!read.ok) return "unknown";
  const latest = newestStatusInContext(read.statuses, STATUS_CONTEXT);
  if (latest === undefined) return "unknown";
  if (latest.state === "pending") return "pending";
  return SETTLED_STATES.has(latest.state) ? "settled" : "unknown";
}

// Whether an override posted during the run stands over the repost of the CLI's unsettled
// status (overrideStandsOverRun, src/ci/override.ts). WHY it is read here: the CLI's final
// write failed, so its own status reads may have failed too, and the override may not have
// been seen by the CLI. A record with no cutoff to judge against is no evidence of an override,
// so the repost goes ahead as before. A failed or corrupt read is also no evidence, so the repost
// goes ahead too, but it is logged as a warning: the override check could not read the head. A
// malformed row is not a failed read: it is skipped, and the valid rows decide, so a fresh override
// beside a garbage row stands.
// WHY the warning: a repost over a head we could not read is the tradeoff, and it must be visible.
// The status reposted is the review's own verdict, so a failed review's failure is reposted as a failure.
//
// WHY the cutoff is the CLI's and not re-derived here: the CLI computed it once for the run,
// and it knows whether its own pending landed, which decides the clock-skew allowance (the
// landed decision is carried by the cutoff, src/ci/override.ts overrideCutoffMs). The publisher
// has neither the pending's outcome nor the allowance, so it compares with the cutoff as given.
function overrideStandsBeforeRepost(
  deps: PublishDeps,
  repo: string,
  sha: string,
  overrideCutoffMs: number | undefined,
): boolean {
  if (overrideCutoffMs === undefined) return false;
  const read = readHeadStatuses(deps, repo, sha);
  if (!read.ok) {
    deps.stdout(
      workflowCommand(
        "warning",
        `pr-hero: could not read the statuses of ${sha.slice(0, 7)}, so an override on it cannot be checked; the review's status is reposted as planned`,
      ),
    );
    return false;
  }
  return overrideStandsOverRun(read.statuses, overrideCutoffMs);
}

// The override's reporter: the shared rendering (statusWriteFailure), reported.
function reportStatusWriteFailure(
  deps: PublishDeps,
  httpStatus: number | undefined,
  runId: string,
  runUrl: string,
): void {
  report(deps, statusWriteFailure(httpStatus, runId, runUrl));
}

// The one status an override writes. Its description starts with OVERRIDE_DESCRIPTION_PREFIX,
// the text the override rule (src/ci/override.ts) recognises. Its description names the actor, so the
// status alone says who unlocked the gate.
function overrideDescription(actor: string): string {
  return `${OVERRIDE_DESCRIPTION_PREFIX}${actor} — no review on this head`;
}

// The audit comment. Its first line is the marker, which is not an outcome marker,
// so no cleanup removes it. Its wording follows the status: a comment that claimed
// an override the status never received would be a false record.
function overrideCommentBody(
  plan: Extract<Publication, { kind: "override" }>,
  statusSet: boolean,
  at: Date,
): string {
  const when = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const marker = `<!-- pr-hero-override head=${plan.headSha ?? "unknown"} run=${plan.runId} attempt=${plan.runAttempt} -->`;
  if (statusSet && plan.headSha !== undefined) {
    return [
      marker,
      "",
      `pr-hero's gate was overridden by @${plan.actor} on head \`${plan.headSha}\` at ${when}. ` +
        "The `pr-hero` status on that head is now success, with no review of this head. " +
        "A new push or a later `/pr-hero review` on this head replaces it.",
    ].join("\n");
  }
  const where =
    plan.headSha === undefined
      ? ", because the head of this pull request is unknown"
      : ` on head \`${plan.headSha}\``;
  return [
    marker,
    "",
    `@${plan.actor} asked to override pr-hero's gate at ${when}, but no commit status could be set${where}, so the gate is unchanged. Comment \`/pr-hero override\` again to retry.`,
  ].join("\n");
}

// WHY the status goes first and the comment's wording follows it: the audit
// comment must never claim an override that the status did not receive. The
// cleanup of older outcome comments runs only after a written status (below), the
// same settle a completed review does; a failed status leaves them in place.
function publishOverride(
  deps: PublishDeps,
  plan: Extract<Publication, { kind: "override" }>,
): number {
  let statusSet = false;
  let exitCode = 0;
  if (plan.headSha !== undefined) {
    const status = postStatus(deps, plan.repository, plan.headSha, {
      state: "success",
      context: STATUS_CONTEXT,
      description: overrideDescription(plan.actor),
      targetUrl: plan.runUrl,
    });
    if (status.ok) {
      statusSet = true;
      // WHY here, right after the success and before the audit comment: the head is green
      // now, so an earlier run's outcome comment contradicts it. The audit comment does not
      // gate this cleanup, and its warnings never change the exit code (as for a review).
      cleanupOlderOutcomes(deps, plan);
    } else {
      reportStatusWriteFailure(
        deps,
        status.httpStatus,
        plan.runId,
        plan.runUrl,
      );
      exitCode = 1;
    }
  }
  deps.stdout(
    workflowCommand(
      "notice",
      statusSet
        ? `pr-hero gate overridden by @${plan.actor} on head ${plan.headSha}.`
        : `pr-hero override by @${plan.actor} set no commit status.`,
    ),
  );
  const at = (deps.now ?? (() => new Date()))();
  const comment = createComment(
    deps,
    plan.repository,
    plan.pr,
    overrideCommentBody(plan, statusSet, at),
  );
  if (!comment.ok) {
    deps.stdout(
      workflowCommand(
        "error",
        `pr-hero could not post its override comment on #${plan.pr} (${comment.detail}).`,
      ),
    );
    return 1;
  }
  return exitCode;
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
  // WHY the read is here, and only here (F001 and F002 on #330): the status decides
  // only for a reviewing record, the one case where this run holds the lock, and it is
  // read on the head that record names, never the trigger's. Every other outcome decides
  // without it, so it makes no call.
  const latestStatusState =
    cliRecord?.outcome === "reviewing" &&
    cliRecord.head_sha !== undefined &&
    record.pr !== undefined
      ? readLatestCliStatusState(deps, record.repository, cliRecord.head_sha)
      : undefined;
  const plan = decidePublication({
    record,
    cliStarted,
    cliRecord,
    setup,
    latestStatusState,
  });
  if (plan.kind === "none") return 0;
  if (plan.kind === "cleanup") {
    // WHY the status goes first, and once: the CLI's final write failed after its review
    // was delivered, so the head's required check is still pending. This step is the
    // publisher's one more chance to settle it. One attempt, because the CLI already
    // tried twice. A failure is reported on one annotation line and the step exits 1,
    // but the cleanup still runs, since the review did complete.
    let exitCode = 0;
    if (plan.headSha !== undefined && plan.status !== undefined) {
      // WHY the override check comes before the repost (Fix 4): an override posted during this
      // run stands over the review's verdict, the same rule the CLI's final write applies
      // (src/ci/override.ts), against the cutoff the CLI recorded. Then the repost is skipped,
      // and the notice says why.
      if (
        overrideStandsBeforeRepost(
          deps,
          plan.repository,
          plan.headSha,
          plan.overrideCutoffMs,
        )
      ) {
        deps.stdout(
          workflowCommand(
            "notice",
            "pr-hero: an override on this head stands, so the review's status is not reposted over it.",
          ),
        );
      } else {
        const status = postStatus(
          deps,
          plan.repository,
          plan.headSha,
          plan.status,
          1,
        );
        if (!status.ok) {
          report(
            deps,
            statusWriteFailure(
              status.httpStatus,
              plan.runId,
              plan.status.targetUrl,
            ),
          );
          exitCode = 1;
        }
      }
    }
    if (plan.pr !== undefined) {
      cleanupOlderOutcomes(deps, { ...plan, pr: plan.pr });
    }
    return exitCode;
  }
  if (plan.kind === "override") return publishOverride(deps, plan);
  report(deps, plan.rendered);
  if (plan.kind === "local") return 0;

  let exitCode = 0;
  // WHY the status is optional: it needs a sha, and the comment below does not.
  if (plan.status !== undefined && plan.headSha !== undefined) {
    const status = postStatus(deps, plan.repository, plan.headSha, plan.status);
    if (!status.ok) {
      report(
        deps,
        statusWriteFailure(status.httpStatus, record.run_id, record.run_url),
      );
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

// The settle of a cancelled review (SB3). It runs in the cancelled job only, after publish,
// and it never fails the job: a cancel is not a failure, and a status it cannot write is a
// warning. Its only write is this run's own pending on the head the CLI locked.
export function runCancelSettle(deps: PublishDeps): number {
  const dir = deps.env.PRHERO_OUTCOME_DIR ?? "";
  if (dir === "") return 0;
  const record = readCliRecord(dir);
  // Guarded like readCliRecord: this step must exit 0 whatever the file system does.
  let pendingAt: string | undefined;
  try {
    pendingAt = readIfExists(path.join(dir, PENDING_AT_FILE))?.trim();
  } catch {
    pendingAt = undefined;
  }
  const repository = deps.env.GITHUB_REPOSITORY ?? "";
  const head = record?.head_sha;
  let latest: { state: string; created_at: string } | undefined;
  if (head !== undefined) {
    const read = readHeadStatuses(deps, repository, head);
    if (!read.ok) {
      deps.stdout(
        workflowCommand(
          "warning",
          "could not read the head's status after the cancel; the pr-hero status may stay pending",
        ),
      );
      return 0;
    }
    latest = newestStatusInContext(read.statuses, STATUS_CONTEXT);
  }
  const decision = decideCancelSettle({
    record,
    latest,
    pendingAt: pendingAt === "" ? undefined : pendingAt,
  });
  if (!decision.settle) {
    deps.stdout(
      workflowCommand(
        "notice",
        `cancel: nothing to settle (${decision.reason})`,
      ),
    );
    return 0;
  }
  const serverUrl = deps.env.GITHUB_SERVER_URL || "https://github.com";
  const runUrl = `${serverUrl}/${repository}/actions/runs/${deps.env.GITHUB_RUN_ID ?? ""}`;
  const status = postStatus(deps, repository, decision.headSha, {
    state: "error",
    context: STATUS_CONTEXT,
    description: clipStatusDescription(CANCELLED_STATUS_DESCRIPTION),
    targetUrl: runUrl,
  });
  if (status.ok) {
    deps.stdout(
      workflowCommand(
        "notice",
        "the review was cancelled; the pr-hero status is now PRH-CANCELLED",
      ),
    );
  } else {
    deps.stdout(
      workflowCommand(
        "warning",
        "could not settle the cancelled review's pr-hero status; it may stay pending",
      ),
    );
  }
  return 0;
}

if (import.meta.main) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY ?? "";
  const run =
    process.env.PRHERO_PUBLISH_MODE === "cancelled"
      ? runCancelSettle
      : runPublish;
  process.exit(
    run({
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
