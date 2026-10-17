// The action's first decision: does this run review at all?
// (odd/tasks/agent-first-ci.md, T1/S1)
//
// The consumer workflow calls the action on `pull_request` and
// `issue_comment`, and its job `if:` already drops fork pull requests and
// comments that do not start with `/pr-hero review`. This module decides it
// all again anyway. A workflow is a file the consumer owns and edits, so a
// prefix filter there is a cost saving, never the security boundary: the
// command match, the commenter's permission and the credential check all
// live here, on the action side, where every consumer gets the same rules.
//
// decideCiTrigger is PURE. runCiTrigger is the thin shell: it reads env, asks
// `gh` only the questions the decision needs, writes $GITHUB_OUTPUT, and writes
// trigger.json for the publish step (src/ci/publish.ts) for EVERY decision.
// Both I/O seams (`gh`, the writers) are injected so the shell's ordering,
// not just its answers, is testable offline.
//
// WHY ONLY BUILTINS: action.yml runs this step BEFORE `bun install`, so an
// ignored comment costs seconds instead of a dependency install. A package
// import has no node_modules to resolve against yet, and a `#...` alias is no
// better: it resolves to a src module whose own imports reach packages. Keep
// every import here `node:` or `bun`.

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const REVIEW_COMMAND = "/pr-hero review";
export const REVIEW_FULL_COMMAND = "/pr-hero review --full";
// The review, plus the CI adjudicator's rulings on pending dismissals (docs/github-actions.md,
// "Rechecking a dismissal"). Exact, like the review command.
export const RECHECK_COMMAND = "/pr-hero recheck";
// The human escape hatch (odd/tasks/agent-first-ci.md, S8). Exact, like the review
// command: a loose match would let a quoted reply unlock a gate.
export const OVERRIDE_COMMAND = "/pr-hero override";

// A GitHub login: letters, digits, hyphens and underscores (an Enterprise Managed
// User login is `handle_shortcode`), plus the `[bot]` suffix an app posts under. The
// override records the login, so it must be one. The bound is 91 characters in all,
// `[bot]` included: the override status's description is 49 characters around the
// login, and GitHub refuses a description over 140. A copy lives in src/ci/outcome.ts
// (LOGIN_PATTERN); test/ci/outcome.test.ts fails if the two texts differ.
const GITHUB_LOGIN = /^(?=.{1,91}$)[A-Za-z0-9][A-Za-z0-9_-]{0,90}(\[bot\])?$/;

// The only answers of the collaborator-permission endpoint that may spend
// money. `maintain` already reports as `write` there and `triage` as `read`,
// so this is the whole set of "can push to the repository".
const TRIGGER_PERMISSIONS: ReadonlySet<string> = new Set(["admin", "write"]);

const CREDENTIAL_INPUTS = [
  "anthropic-api-key",
  "claude-token",
  "opencode-auth",
] as const;

// What the artifact is named after when the head cannot be resolved. The head
// sha only disambiguates the artifact name; a review must not fail over it.
export const UNKNOWN_HEAD_SHA = "unknown";

export type CommenterPermission =
  // GitHub answered. A 404 is its definitive answer for a login that is not
  // a collaborator, recorded as the permission `none`.
  | { kind: "resolved"; permission: string }
  // No usable answer, and asking again cannot produce one: the event named
  // nobody, or gh succeeded and printed no permission. Denied.
  | { kind: "unavailable"; detail: string }
  // The lookup itself failed: a 5xx, a 403 rate limit, a timeout, no
  // network, no gh. That says nothing about the commenter, only about the
  // API. Retried once; if it reaches the decision, it is neither a review
  // nor a quiet denial. `status` is the HTTP status gh printed, when it
  // printed one; `rateLimited` is set only when gh says so in its own words.
  | {
      kind: "indeterminate";
      detail: string;
      status?: number;
      rateLimited?: boolean;
    };

// Presence only. The action passes `inputs.<credential> != ''`, never the
// value, so nothing in this module can print a secret it never received.
export interface CiCredentialPresence {
  anthropicApiKey: boolean;
  claudeToken: boolean;
  opencodeAuth: boolean;
  // A Claude session file or the OpenCode auth store already on the runner
  // (see runnerCredentialPaths). The engine authenticates with either.
  runnerFile: boolean;
}

// The engine's Claude session files, relative to HOME, and its OpenCode
// auth-store rule. Copied rather than imported, because this module may
// import only builtins (see the header): the originals are
// CLAUDE_SESSION_FILES in src/model/provider-capabilities.ts and
// resolveOpenCodeAuthPath in src/security/credential-broker.ts, and a drift
// test in test/ci/trigger.test.ts pins this copy to both.
const CLAUDE_SESSION_FILES: readonly string[] = [
  ".claude.json",
  path.join(".claude", "session.json"),
  path.join(".claude", ".credentials.json"),
];

// HOME comes from the env this shell was handed, never os.homedir(): the
// engine's homedir() reads HOME first and every runner sets it, while an env
// without one (a test, a stripped container) must not fall through to the
// passwd home of whoever runs the process and find THEIR session. An empty
// XDG_DATA_HOME counts as unset, exactly as the engine reads it.
export function runnerCredentialPaths(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const home = env.HOME ?? "";
  const dataHome = env.XDG_DATA_HOME ?? "";
  const paths =
    home === ""
      ? []
      : CLAUDE_SESSION_FILES.map((file) => path.join(home, file));
  if (dataHome !== "") {
    paths.push(path.join(dataHome, "opencode", "auth.json"));
  } else if (home !== "") {
    paths.push(path.join(home, ".local", "share", "opencode", "auth.json"));
  }
  return paths;
}

export interface CiTriggerInput {
  eventName: string;
  // GITHUB_REPOSITORY, the base repository this run belongs to.
  repository: string;
  // `pull_request.head.repo.full_name`; empty when the fork was deleted.
  prHeadRepo: string;
  commentBody: string;
  commentOnPullRequest: boolean;
  commenterLogin: string;
  // Absent means nobody looked it up, which is denied like a failed lookup.
  commenterPermission?: CommenterPermission;
  credentials: CiCredentialPresence;
  // RUNNER_ENVIRONMENT is `self-hosted`.
  selfHostedRunner: boolean;
  forceInput: boolean;
  fullInput: boolean;
  // GITHUB_RUN_ATTEMPT when it is a positive integer. Absent outside Actions.
  // Above 1 the run is a re-run, which replays the original comment event.
  runAttempt?: number;
  // EVENT_COMMENT_ID when it is all digits: the comment that triggered the run,
  // which the reaction names. Absent for any other event, or any other value.
  commentId?: string;
}

export type CiTriggerDecision =
  | { kind: "review"; force: boolean; full: boolean; adjudicate: boolean }
  // A human's override: no CLI run, $0. `actor` is the login that unlocked the gate.
  | { kind: "override"; actor: string }
  // `nearMiss` is set on a comment that starts like a command but is not one: it
  // runs nothing, and its reaction says so (confused).
  | { kind: "ignore"; reason: string; nearMiss?: true }
  | { kind: "denied"; reason: string }
  | {
      kind: "unverifiable";
      reason: string;
      status?: number;
      rateLimited?: boolean;
    }
  | { kind: "no-credentials"; inputs: readonly string[] };

// Exact match after trimming, and nothing else: no case folding, no inner
// whitespace tolerance, no trailing words. A loose match is how "/pr-hero
// review please" or a quoted reply would start a paid review.
export function parseReviewCommand(
  body: string,
): { full: boolean; adjudicate: boolean } | undefined {
  const command = body.trim();
  if (command === REVIEW_COMMAND) return { full: false, adjudicate: false };
  if (command === REVIEW_FULL_COMMAND) return { full: true, adjudicate: false };
  if (command === RECHECK_COMMAND) return { full: false, adjudicate: true };
  return undefined;
}

// A comment that asks for something. Both kinds are permission-gated, so the
// comment kind (and not the command) decides whether the lookup runs.
type CommentCommand =
  | { kind: "review"; full: boolean; adjudicate: boolean }
  | { kind: "override" };

type EventVerdict =
  | { kind: "ignore"; reason: string; nearMiss?: true }
  | { kind: "comment"; command: CommentCommand }
  | { kind: "event" };

// A comment that starts like a command but is not an exact one: "/pr-hero review
// please", "/pr-hero override --force". It is judged on the trimmed text, the same way
// as the command. The job's own `startsWith` filter lets such a comment start a run,
// and that run reviews nothing; its reaction (confused) is the only word it says.
function isNearMiss(body: string): boolean {
  const text = body.trim();
  return (
    text.startsWith(REVIEW_COMMAND) ||
    text.startsWith(RECHECK_COMMAND) ||
    text.startsWith(OVERRIDE_COMMAND)
  );
}

// The exact text a commenter typed, for the messages that name it.
function commandText(command: CommentCommand): string {
  if (command.kind === "override") return OVERRIDE_COMMAND;
  if (command.adjudicate) return RECHECK_COMMAND;
  return command.full ? REVIEW_FULL_COMMAND : REVIEW_COMMAND;
}

// Stage 1 of the precedence. Shared by decideCiTrigger and
// commenterPermissionNeeded, so the shell can never look a permission up for
// an event the decision would have ignored anyway.
function classifyEvent(input: CiTriggerInput): EventVerdict {
  // The fork filter is `pull_request`'s alone, because only there is its
  // reason true: GitHub hands a fork's `pull_request` run no secrets.
  // `pull_request_target` runs in the BASE repository's context, with its
  // secrets, and the bash this module replaced accepted it. The scaffolded
  // template never wires it; a consumer who does has chosen base-context
  // reviews of fork heads, so it goes on to the credential check like any
  // other review event (there is no commenter to check). pr-hero itself
  // never executes the pull request's code: it reads the head as text.
  if (input.eventName === "pull_request") {
    if (input.prHeadRepo !== input.repository) {
      return {
        kind: "ignore",
        reason:
          "Pull requests from forks are not reviewed automatically: a fork's " +
          "run receives no secrets. A maintainer with write access can " +
          `comment \`${REVIEW_COMMAND}\` on the pull request to review it.`,
      };
    }
    return { kind: "event" };
  }
  if (input.eventName === "issue_comment") {
    if (!input.commentOnPullRequest) {
      return {
        kind: "ignore",
        reason:
          "This comment is on an issue, not a pull request, so there is " +
          "nothing to review.",
      };
    }
    // The reason never quotes the body: it is free text anyone can type,
    // and this string is printed as a workflow command.
    const review = parseReviewCommand(input.commentBody);
    if (review !== undefined) {
      return {
        kind: "comment",
        command: {
          kind: "review",
          full: review.full,
          adjudicate: review.adjudicate,
        },
      };
    }
    if (input.commentBody.trim() === OVERRIDE_COMMAND) {
      return { kind: "comment", command: { kind: "override" } };
    }
    return {
      kind: "ignore",
      reason:
        `This comment is not a pr-hero command. Comment exactly ` +
        `\`${REVIEW_COMMAND}\`, \`${REVIEW_FULL_COMMAND}\` or \`${RECHECK_COMMAND}\` to request ` +
        `a review, or \`${OVERRIDE_COMMAND}\` to unlock a gate.`,
      ...(isNearMiss(input.commentBody) ? { nearMiss: true as const } : {}),
    };
  }
  // workflow_dispatch and anything else a consumer wires: the caller's own
  // `pr-number` / `force` / `full` inputs decide, as they always have.
  return { kind: "event" };
}

export function commenterPermissionNeeded(input: CiTriggerInput): boolean {
  return classifyEvent(input).kind === "comment";
}

// Undefined lets the command through. A definitive non-writer is `denied`
// (a notice, exit 0, as for any stranger). A lookup that failed is
// `unverifiable`: still no review, but red, because a denial is only a
// notice on a default-branch run, invisible from the pull request, and a
// maintainer whose command met a GitHub outage would see nothing happen.
function commenterVerdict(
  input: CiTriggerInput,
  command: CommentCommand,
): CiTriggerDecision | undefined {
  const permission = input.commenterPermission;
  if (
    permission?.kind === "resolved" &&
    TRIGGER_PERMISSIONS.has(permission.permission)
  ) {
    return undefined;
  }
  const who = `@${input.commenterLogin || "unknown"}`;
  if (permission?.kind === "indeterminate") {
    // An override that is not verified changes nothing, so it says so instead of
    // "no review was started", which would be wrong for it.
    const outcome =
      command.kind === "override"
        ? "the gate was not overridden"
        : "no review was started";
    return {
      kind: "unverifiable",
      reason:
        `pr-hero could not verify whether ${who} has write access to ` +
        `${input.repository}, because the GitHub API call failed ` +
        `(${permission.detail}), so ${outcome}. Comment ` +
        `\`${commandText(command)}\` again to retry.`,
      status: permission.status,
      rateLimited: permission.rateLimited,
    };
  }
  const rule =
    command.kind === "override"
      ? `Only a maintainer (write or admin access to ${input.repository}) can ` +
        `unlock a gate with \`${OVERRIDE_COMMAND}\`.`
      : `Only a maintainer (write or admin access to ${input.repository}) can ` +
        `request a review with \`${REVIEW_COMMAND}\`.`;
  if (permission === undefined) {
    return {
      kind: "denied",
      reason: `The permission of ${who} was not checked, so the command was refused. ${rule}`,
    };
  }
  if (permission.kind === "unavailable") {
    return {
      kind: "denied",
      reason:
        `Could not verify the permission of ${who} (${permission.detail}), ` +
        `so the command was refused. ${rule}`,
    };
  }
  return {
    kind: "denied",
    reason: `${who} has \`${permission.permission || "no"}\` permission. ${rule}`,
  };
}

// Precedence, in this order: event filter, commenter permission,
// credentials. An ignored or denied run must never report missing
// credentials: that error is red, and a near-miss comment or a stranger's
// command turning a PR red would be noise the author cannot fix.
// WHY the login check: the override records the login and the publisher prints
// it in a status and a comment. GitHub's own logins always match, so this refuses
// only a value that was never one, and the refusal never echoes it.
function overrideDecision(input: CiTriggerInput): CiTriggerDecision {
  // WHY refused on a re-run: GitHub replays the comment event, and this run then
  // resolves the head as it is NOW. The override would name a head the commenter
  // never saw, so the commenter comments again to act on the current head.
  if (input.runAttempt !== undefined && input.runAttempt > 1) {
    return {
      kind: "denied",
      reason:
        "pr-hero did not override the gate: an override applies to the head at " +
        "the time of the comment; comment `/pr-hero override` again.",
    };
  }
  if (!GITHUB_LOGIN.test(input.commenterLogin)) {
    return {
      kind: "denied",
      reason:
        "The commenter's login is not a GitHub login, so the override was " +
        "refused and nothing was recorded.",
    };
  }
  return { kind: "override", actor: input.commenterLogin };
}

export function decideCiTrigger(input: CiTriggerInput): CiTriggerDecision {
  const event = classifyEvent(input);
  if (event.kind === "ignore") return event;

  if (event.kind === "comment") {
    const verdict = commenterVerdict(input, event.command);
    if (verdict !== undefined) return verdict;
    // WHY before the credential check: an override spends nothing, so a repository
    // with no credential can still unlock its own gate.
    if (event.command.kind === "override") return overrideDecision(input);
  }

  // `no-credentials` is red, so it fires only when nothing the engine can
  // authenticate with is within reach: no credential input, no Claude
  // session file and no OpenCode auth store on the runner, and a runner that
  // is not self-hosted. A self-hosted runner may hold a macOS keychain entry,
  // which this builtins-only step cannot probe, so there the engine's own
  // capability gate decides.
  //
  // ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN in the JOB's environment do
  // not count, and nothing here reads them. action.yml's Run pr-hero step
  // binds both from the inputs in its own `env:`, which overrides the job's,
  // so a job-level value never reaches the engine: counting it would trade
  // this clear red for a confusing auth failure later.
  const { anthropicApiKey, claudeToken, opencodeAuth, runnerFile } =
    input.credentials;
  if (
    !anthropicApiKey &&
    !claudeToken &&
    !opencodeAuth &&
    !runnerFile &&
    !input.selfHostedRunner
  ) {
    return { kind: "no-credentials", inputs: CREDENTIAL_INPUTS };
  }

  const fromComment = event.kind === "comment";
  const commentFull =
    event.kind === "comment" &&
    event.command.kind === "review" &&
    event.command.full;
  const commentAdjudicate =
    event.kind === "comment" &&
    event.command.kind === "review" &&
    event.command.adjudicate;
  return {
    kind: "review",
    force: input.forceInput || fromComment,
    full: input.fullInput || commentFull,
    adjudicate: commentAdjudicate,
  };
}

export interface CiPrNumberSources {
  prNumberInput: string;
  eventName: string;
  eventPrNumber: string;
  eventIssueNumber: string;
}

// Ported from action.yml's run step, which resolved this in bash before the
// trigger existed: the explicit input wins, then the event's own number.
const MISSING_PR_NUMBER =
  "Could not determine the pull request number from the workflow context. Set the 'pr-number' input explicitly.";
const MALFORMED_PR_NUMBER = "The 'pr-number' input must be a positive integer.";
// The outcome record's detail for a malformed pr-number input. Fixed text that
// names the input and never its value: the value is untrusted, and the record
// is read back and rendered.
const MALFORMED_PR_NUMBER_DETAIL =
  "the pr-number input is not a positive integer";

export function resolvePrNumber(
  sources: CiPrNumberSources,
): { ok: true; pr: string } | { ok: false; error: string } {
  let raw = sources.prNumberInput.trim();
  if (raw === "") {
    if (
      sources.eventName === "pull_request" ||
      sources.eventName === "pull_request_target"
    ) {
      raw = sources.eventPrNumber.trim();
    } else if (sources.eventName === "issue_comment") {
      raw = sources.eventIssueNumber.trim();
    }
  }
  if (raw === "") return { ok: false, error: MISSING_PR_NUMBER };
  // Digits only, because the number is written to $GITHUB_OUTPUT as
  // `pr=<n>`: a newline in it would forge the next output line. The value
  // itself is not echoed back for the same reason.
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return { ok: false, error: MALFORMED_PR_NUMBER };
  }
  return { ok: true, pr: raw };
}

// Workflow-command message escaping, as the runner's own toolkit does it.
// Every message this module prints is its own text, but a login or a gh
// error detail still passes through here so no line break can start a
// second command.
function escapeCommandData(text: string): string {
  return text
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function workflowCommand(
  command: "notice" | "warning" | "error",
  message: string,
): string {
  return `::${command} title=pr-hero::${escapeCommandData(message)}\n`;
}

export interface CiTriggerOutputs {
  run: boolean;
  force: boolean;
  full: boolean;
  adjudicate: boolean;
  pr: string;
  head_sha: string;
  // Whether the publish step speaks for this run: a review, a missing
  // credential, or an unverifiable permission (odd/tasks/agent-first-ci.md, T2b).
  publish: boolean;
}

const NO_RUN: CiTriggerOutputs = {
  run: false,
  force: false,
  full: false,
  adjudicate: false,
  pr: "",
  head_sha: "",
  publish: false,
};

export function formatTriggerOutputs(outputs: CiTriggerOutputs): string {
  return [
    `run=${outputs.run}`,
    `force=${outputs.force}`,
    `full=${outputs.full}`,
    `adjudicate=${outputs.adjudicate}`,
    `pr=${outputs.pr}`,
    `head_sha=${outputs.head_sha}`,
    `publish=${outputs.publish}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The shell.
// ---------------------------------------------------------------------------

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CiTriggerDeps {
  env: Readonly<Record<string, string | undefined>>;
  gh: (args: readonly string[]) => GhResult;
  // The pause before the one permission-lookup retry. Optional so callers
  // that predate it (test/packaging.test.ts's action simulation) keep
  // working; the default really sleeps, so tests inject it.
  sleep?: (ms: number) => void;
  // Asks whether an on-runner credential file exists. The default is the
  // real filesystem; the paths come from `env` (runnerCredentialPaths).
  exists?: (filePath: string) => boolean;
  stdout: (text: string) => void;
  appendOutput: (text: string) => void;
  appendSummary: (text: string) => void;
  // The record's file writes. The default is node:fs; a test injects a failing
  // one to prove the write is atomic.
  fs?: OutcomeFs;
}

// The file the publisher reads back (src/ci/outcome.ts's TriggerRecord). This
// module imports nothing from outcome.ts, so the name is written out here.
const OUTCOME_RECORD = "trigger.json";

export interface OutcomeFs {
  mkdir(dir: string): void;
  writeFile(filePath: string, text: string): void;
  rename(from: string, to: string): void;
  remove(filePath: string): void;
}

export const NODE_FS: OutcomeFs = {
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  writeFile: (filePath, text) => {
    writeFileSync(filePath, text);
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  remove: (filePath) => {
    rmSync(filePath, { force: true });
  },
};

const RECORD_TEMP_SUFFIX = ".tmp";

// The temp file a record write goes through before its rename. The name is unique
// per write: a temp file that another job or user left at a fixed name (cli.json.tmp,
// say) could otherwise make every write of that record in the run fail (F003 on
// #330). The suffix stays `.tmp`, so an interrupted write still reads as temporary.
// Builtins only: the setup step uses it too, and it must not reach for a package.
export function recordTempPath(finalPath: string): string {
  return `${finalPath}.${process.pid}.${randomBytes(6).toString("hex")}${RECORD_TEMP_SUFFIX}`;
}

// WHY tmp then rename: the publish step reads the record in a later step, and
// it must never see a half-written file. A failed write removes its temp file,
// so nothing partial is left for the publisher to misread. The CLI's cli.json
// (src/ci/cli-record.ts) goes through this same writer under its own name.
export function writeRecordAtomically(
  dir: string,
  name: string,
  text: string,
  fs: OutcomeFs,
): void {
  const finalPath = path.join(dir, name);
  const tempPath = recordTempPath(finalPath);
  fs.mkdir(dir);
  try {
    fs.writeFile(tempPath, text);
    fs.rename(tempPath, finalPath);
  } catch (error) {
    try {
      fs.remove(tempPath);
    } catch {
      // Best effort: the write error is the one worth reporting.
    }
    throw error;
  }
}

// The class a publisher renders from. The trigger writes only what it can
// know without the catalog: an HTTP status from a failed lookup, and an
// unresolved PR on a review.
type RecordClass =
  | { kind: "github"; status: number; rateLimited?: true }
  | { kind: "trigger"; check: "pr-unresolved" };

interface RunIdentity {
  repository: string;
  run_id: string;
  // Omitted when the runner reports no positive attempt: the publisher reads
  // a record without one as attempt 1.
  run_attempt?: number;
  run_url: string;
}

interface RecordFields {
  decision: CiTriggerDecision["kind"];
  params: { backend?: string; step?: string; detail?: string };
  cls?: RecordClass;
  pr?: string;
  headSha?: string;
  // Set only by the override call site: the record names who unlocked the gate
  // and no other decision names anyone (see parseTriggerRecord).
  actor?: string;
}

// A positive integer read from runner text, or undefined. Trigger imports only
// builtins, so this is its own copy of the publisher's check.
function positiveInteger(text: string): number | undefined {
  if (!/^[0-9]+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function runIdentity(deps: CiTriggerDeps): RunIdentity {
  const repository = deps.env.GITHUB_REPOSITORY ?? "";
  const runId = deps.env.GITHUB_RUN_ID ?? "";
  const server = deps.env.GITHUB_SERVER_URL || "https://github.com";
  const attempt = positiveInteger(deps.env.GITHUB_RUN_ATTEMPT ?? "");
  return {
    repository,
    run_id: runId,
    ...(attempt === undefined ? {} : { run_attempt: attempt }),
    run_url: `${server}/${repository}/actions/runs/${runId}`,
  };
}

// The markers an earlier job may have left in a reused outcome directory: a
// self-hosted runner keeps runner.temp. The setup step writes SETUP_RECORD, and
// the run step writes CLI_STARTED_MARKER before the CLI runs. CLI_RECORD is the
// CLI's own outcome (src/ci/outcome.ts's CLI_RECORD_FILE, named out here because
// this module imports nothing from outcome.ts). All are cleared before this
// run's record, so a stale marker cannot make an install failure look like the
// CLI ran, and a stale CLI record cannot stand in for this run's. The CLI
// record is how the publisher learns the CLI's outcome, so a stale one would
// name an earlier job's result.
const CLI_STARTED_MARKER = "cli-started";
const SETUP_RECORD = "setup.json";
const CLI_RECORD = "cli.json";
// The CLI's pending identity (src/ci/outcome.ts PENDING_AT_FILE, pinned equal by a test). A
// stale one would let the cancel settle trust an older run's pending.
const PENDING_AT = "pending-at";

function clearStaleMarkers(dir: string, fs: OutcomeFs): void {
  // The markers the publisher reads stay strict: a stale one would mislead it.
  // Temp files are not cleared here: each write's temp name is unique, so no
  // stale one can collide with it (see recordTempPath).
  for (const name of [
    CLI_STARTED_MARKER,
    SETUP_RECORD,
    CLI_RECORD,
    PENDING_AT,
  ]) {
    fs.remove(path.join(dir, name));
  }
}

// What the record write did. `unset` is a local run with no outcome directory:
// nothing was written and nothing will be published from one. `failed` is a
// write that was attempted and did not land, so the file on disk (if any) is an
// earlier attempt's.
type RecordWrite = "written" | "unset" | "failed";

// Writes one record for every decision, and says what happened to it. A failed
// write is reported, and the decision's own exit code stands: the review is not
// the record's to block.
function writeRecord(
  deps: CiTriggerDeps,
  run: RunIdentity,
  fields: RecordFields,
): RecordWrite {
  const dir = deps.env.PRHERO_OUTCOME_DIR ?? "";
  if (dir === "") return "unset";
  const record = {
    v: 1,
    decision: fields.decision,
    params: fields.params,
    ...(fields.cls === undefined ? {} : { cls: fields.cls }),
    ...(fields.pr === undefined ? {} : { pr: Number(fields.pr) }),
    ...(fields.headSha === undefined ? {} : { head_sha: fields.headSha }),
    ...(fields.actor === undefined ? {} : { actor: fields.actor }),
    repository: run.repository,
    run_id: run.run_id,
    ...(run.run_attempt === undefined ? {} : { run_attempt: run.run_attempt }),
    run_url: run.run_url,
  };
  try {
    const fs = deps.fs ?? NODE_FS;
    fs.mkdir(dir);
    clearStaleMarkers(dir, fs);
    writeRecordAtomically(
      dir,
      OUTCOME_RECORD,
      `${JSON.stringify(record)}\n`,
      fs,
    );
    return "written";
  } catch {
    deps.stdout(
      workflowCommand(
        "error",
        "pr-hero could not write its outcome record, so this run's result may not reach the pull request.",
      ),
    );
    return "failed";
  }
}

// The publish output follows the record. A failed write leaves the publisher
// nothing to read for this run, and the file on disk is an earlier attempt's, so
// the publish step must not run against it. An unset outcome directory keeps
// publish as the decision set it.
function publishes(write: RecordWrite): boolean {
  return write !== "failed";
}

// An exit-1 decision whose record is not on disk has no publisher to name its
// cause, so the trigger prints the cause itself, as one error line. A record
// that was written keeps the publisher as the only speaker.
function printCauseUnlessRecorded(
  deps: CiTriggerDeps,
  write: RecordWrite,
  cause: string,
): void {
  if (write !== "written") deps.stdout(workflowCommand("error", cause));
}

// The cause of a run with no credential. It names the decision's own input
// list, so the text cannot drift from the check that produced it.
function noCredentialCause(inputs: readonly string[]): string {
  return `pr-hero has no credential for this review: pass one of the ${inputs.join(", ")} inputs.`;
}

// The lookup's class: only when gh printed an HTTP status. A 403 is a rate
// limit only when gh said so; otherwise the catalog keeps its permission reading.
function lookupClass(decision: {
  status?: number;
  rateLimited?: boolean;
}): RecordClass | undefined {
  if (decision.status === undefined) return undefined;
  return decision.rateLimited === true
    ? { kind: "github", status: decision.status, rateLimited: true }
    : { kind: "github", status: decision.status };
}

// The route the run would have used. The trigger has no routing text, only
// whether it names OpenCode (action.yml's own test for the OpenCode install).
function backendOf(deps: CiTriggerDeps): string {
  return deps.env.HAS_OPENCODE_ROUTING === "true" ? "opencode" : "claude";
}

// The run's PR number, or why there is none. `malformed` is kept apart from a
// missing number: a malformed input is the one the reader must change, so its
// record carries a detail that names it.
type PrResolution =
  | { ok: true; pr: string }
  | { ok: false; error: string; malformed: boolean };

function resolvedPrNumber(deps: CiTriggerDeps): PrResolution {
  const resolved = resolvePrNumber({
    prNumberInput: deps.env.PR_NUMBER_INPUT ?? "",
    eventName: deps.env.EVENT_NAME ?? "",
    eventPrNumber: deps.env.EVENT_PR_NUMBER ?? "",
    eventIssueNumber: deps.env.EVENT_ISSUE_NUMBER ?? "",
  });
  if (resolved.ok) return resolved;
  return {
    ok: false,
    error: resolved.error,
    malformed: resolved.error === MALFORMED_PR_NUMBER,
  };
}

const VALID_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function validSha(value: string): string | undefined {
  return VALID_SHA.test(value) ? value : undefined;
}

// Every name below is bound by the trigger step's `env:` in action.yml,
// except GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, RUNNER_ENVIRONMENT,
// HOME and XDG_DATA_HOME, which every step inherits from the runner.
function readTriggerInput(
  deps: CiTriggerDeps,
): Omit<CiTriggerInput, "commenterPermission"> {
  const { env } = deps;
  const text = (name: string): string => env[name] ?? "";
  const flag = (name: string): boolean => text(name) === "true";
  const exists = deps.exists ?? existsSync;
  const runAttempt = positiveInteger(text("GITHUB_RUN_ATTEMPT"));
  // Digits only: the id is written into an API path, so any other value is no id.
  const commentId = /^[0-9]+$/.test(text("EVENT_COMMENT_ID"))
    ? text("EVENT_COMMENT_ID")
    : undefined;
  return {
    eventName: text("EVENT_NAME"),
    repository: text("GITHUB_REPOSITORY"),
    prHeadRepo: text("EVENT_PR_HEAD_REPO"),
    commentBody: text("COMMENT_BODY"),
    commentOnPullRequest: text("EVENT_ISSUE_PR_URL") !== "",
    commenterLogin: text("COMMENTER_LOGIN"),
    credentials: {
      anthropicApiKey: flag("HAS_ANTHROPIC_API_KEY"),
      claudeToken: flag("HAS_CLAUDE_TOKEN"),
      opencodeAuth: flag("HAS_OPENCODE_AUTH"),
      runnerFile: runnerCredentialPaths(env).some((file) => exists(file)),
    },
    selfHostedRunner: text("RUNNER_ENVIRONMENT") === "self-hosted",
    forceInput: flag("FORCE_INPUT"),
    fullInput: flag("FULL_INPUT"),
    ...(runAttempt === undefined ? {} : { runAttempt }),
    ...(commentId === undefined ? {} : { commentId }),
  };
}

// The reaction a comment earns. Best effort: it runs only on an issue_comment with an
// id, and a failure prints one warning. It never changes the decision or the exit code,
// because the reaction is a courtesy and the decision is the product.
type CommentReaction = "eyes" | "-1" | "confused";

function react(
  deps: CiTriggerDeps,
  input: Pick<
    CiTriggerInput,
    "eventName" | "repository" | "commentId" | "runAttempt"
  >,
  content: CommentReaction,
): void {
  if (input.eventName !== "issue_comment" || input.commentId === undefined)
    return;
  // WHY only attempt 1 reacts: a re-run replays the comment event, so its reaction would
  // stack on the one its first attempt left (👀 then 👎). The decision is unchanged.
  if (input.runAttempt !== undefined && input.runAttempt > 1) return;
  const result = callGh(deps, [
    "api",
    "-X",
    "POST",
    `repos/${input.repository}/issues/comments/${input.commentId}/reactions`,
    "-f",
    `content=${content}`,
  ]);
  if (result.exitCode === 0) return;
  deps.stdout(
    workflowCommand(
      "warning",
      `Could not add the ${content} reaction to the comment (${ghFailureDetail(result)}). The outcome is unchanged.`,
    ),
  );
}

function callGh(deps: CiTriggerDeps, args: readonly string[]): GhResult {
  try {
    return deps.gh(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: -1, stdout: "", stderr: message };
  }
}

// One short line of gh's stderr, for the denied notice. gh never prints its
// token, and the line is escaped before it is printed.
function ghFailureDetail(result: GhResult): string {
  const line = result.stderr.trim().split("\n")[0]?.trim() ?? "";
  const detail = line === "" ? `gh exited ${result.exitCode}` : line;
  return detail.length > 160 ? `${detail.slice(0, 157)}...` : detail;
}

// One lookup, classified. gh prints `HTTP 404` on stderr when GitHub says
// the login is not a collaborator: a definitive answer, so it is `none`.
// Every other failure (a 5xx, a 403 rate limit, a timeout, no network, a gh
// that cannot start) is about the API, not the commenter.
function askCommenterPermission(
  deps: CiTriggerDeps,
  repository: string,
  login: string,
): CommenterPermission {
  const result = callGh(deps, [
    "api",
    `repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
    "--jq",
    ".permission",
  ]);
  if (result.exitCode !== 0) {
    if (result.stderr.includes("HTTP 404")) {
      return { kind: "resolved", permission: "none" };
    }
    return indeterminateLookup(result);
  }
  const permission = result.stdout.trim();
  if (permission === "") {
    return { kind: "unavailable", detail: "gh returned no permission" };
  }
  return { kind: "resolved", permission };
}

// The failed lookup, with the HTTP status gh printed. gh's own text is only
// read here, never recorded: the record carries the number and a flag.
function indeterminateLookup(result: GhResult): CommenterPermission {
  const match = /HTTP (\d{3})\b/.exec(result.stderr);
  const status = match === null ? undefined : Number(match[1]);
  return {
    kind: "indeterminate",
    detail: ghFailureDetail(result),
    status,
    rateLimited: status === 403 && /rate limit/i.test(result.stderr),
  };
}

// Short and fixed: long enough for a transient 5xx to clear, short enough
// that a real outage costs the comment run seconds, not minutes.
const PERMISSION_RETRY_DELAY_MS = 2_000;

// Fails closed either way: only a clean `admin` / `write` answer can spend
// money. An indeterminate lookup is retried ONCE, because a red "comment
// again" is a cost to a maintainer and one blip should not cause it; more
// retries would only hold every comment run hostage to an outage.
function lookupCommenterPermission(
  deps: CiTriggerDeps,
  repository: string,
  login: string,
): CommenterPermission {
  if (login === "" || repository === "") {
    return {
      kind: "unavailable",
      detail: "the event carried no commenter login or repository",
    };
  }
  const first = askCommenterPermission(deps, repository, login);
  if (first.kind !== "indeterminate") return first;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  sleep(PERMISSION_RETRY_DELAY_MS);
  return askCommenterPermission(deps, repository, login);
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// The head sha only names the uploaded artifact, so this fails SOFT: a
// warning and `unknown`, never a failed review. A pull_request event carries
// it; a comment or a dispatch does not, so those ask gh. Anything that is not
// a sha is discarded, because it is written to $GITHUB_OUTPUT verbatim.
function resolveHeadSha(
  deps: CiTriggerDeps,
  eventName: string,
  repository: string,
  pr: string,
  // A run that will not review says nothing about its head: the publisher
  // carries the outcome, so no second warning is printed for the same gap.
  quiet: boolean,
): string {
  const fromEvent = (deps.env.EVENT_PR_HEAD_SHA ?? "").trim();
  if (
    (eventName === "pull_request" || eventName === "pull_request_target") &&
    SHA_RE.test(fromEvent)
  ) {
    return fromEvent;
  }
  const result = callGh(deps, [
    "pr",
    "view",
    pr,
    "--repo",
    repository,
    "--json",
    "headRefOid",
    "--jq",
    ".headRefOid",
  ]);
  const sha = result.stdout.trim();
  if (result.exitCode === 0 && SHA_RE.test(sha)) return sha;
  if (!quiet) {
    deps.stdout(
      workflowCommand(
        "warning",
        `Could not resolve the head of pull request #${pr}; the run-directory ` +
          `artifact is named with "${UNKNOWN_HEAD_SHA}" instead of its sha.`,
      ),
    );
  }
  return UNKNOWN_HEAD_SHA;
}

// Short, like the permission retry: long enough for a transient gh failure to
// clear, short enough that a real outage costs the comment run seconds. Shared by
// the override's head lookup and the no-credentials head lookup.
const HEAD_RETRY_DELAY_MS = 2_000;

// The notice a refused override prints. docs/github-actions.md ("Overriding a red
// gate") describes the same refusal in prose, so keep the two in step.
const OVERRIDE_FORK_REFUSAL =
  "`/pr-hero override` is refused on a pull request from a fork: its head can change after the comment, so the override would not be bound to the code you saw. Review the fork with `/pr-hero review` and merge it with your repository's own rules.";

// The notice for an answer that does not say whether the pull request is a fork (a
// failed or invalid lookup). It is not a claim that the pull request is one, so it gets
// its own text: the same refusal, with the way to retry.
const OVERRIDE_UNKNOWN_FORK_REFUSAL =
  "`/pr-hero override` could not confirm whether this pull request comes from a fork, so it was refused; comment `/pr-hero override` again.";

// The notices a refused recheck prints: the same refusal as an override on a fork,
// with the adjudicator's reason. The unknown answer gets its own text, as the override does.
const RECHECK_FORK_REFUSAL =
  "/pr-hero recheck cannot run on a fork pull request: the adjudicator needs this repository's checkout of the head";
const RECHECK_UNKNOWN_FORK_REFUSAL =
  "/pr-hero recheck could not confirm whether this pull request comes from a fork, so it was refused; comment `/pr-hero recheck` again.";

// What the override's one lookup says. `crossRepository` is undefined when the
// answer does not say (a failed call, output that is not JSON, or a field that is
// missing or not a boolean). `head` is a validated sha, or undefined.
interface OverrideHeadAnswer {
  head: string | undefined;
  crossRepository: boolean | undefined;
}

// One `gh pr view --json headRefOid,isCrossRepository`. Only an override asks
// for the fork flag: a review's lookup stays the bare-sha query it always was.
function askOverrideHead(
  deps: CiTriggerDeps,
  repository: string,
  pr: string,
): OverrideHeadAnswer {
  const unanswered: OverrideHeadAnswer = {
    head: undefined,
    crossRepository: undefined,
  };
  const result = callGh(deps, [
    "pr",
    "view",
    pr,
    "--repo",
    repository,
    "--json",
    "headRefOid,isCrossRepository",
  ]);
  if (result.exitCode !== 0) return unanswered;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return unanswered;
  }
  if (typeof parsed !== "object" || parsed === null) return unanswered;
  const { headRefOid, isCrossRepository } = parsed as {
    headRefOid?: unknown;
    isCrossRepository?: unknown;
  };
  const sha = typeof headRefOid === "string" ? headRefOid.trim() : "";
  return {
    head: SHA_RE.test(sha) ? sha : undefined,
    crossRepository:
      typeof isCrossRepository === "boolean" ? isCrossRepository : undefined,
  };
}

// WHY one retry, for an override only: the head is the whole target of an
// override's status, so one failed lookup would leave the gate unchanged with
// no status. The same answer also says whether the pull request is a fork, and
// an unanswered fork question is refused, so the retry covers both. A definite
// fork answer is final: a fork is refused on the first answer, with no retry.
function lookupOverrideHead(
  deps: CiTriggerDeps,
  repository: string,
  pr: string,
): OverrideHeadAnswer {
  const first = askOverrideHead(deps, repository, pr);
  if (first.crossRepository === true) return first;
  if (first.crossRepository === false && first.head !== undefined) return first;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  sleep(HEAD_RETRY_DELAY_MS);
  return askOverrideHead(deps, repository, pr);
}

// WHY one retry, on an issue_comment only: when the head lookup fails, the record
// carries no head, and the publisher posts a comment with no status on a red
// repository, a silent gate. The retry is the same one the override makes. A
// pull_request names its head in the event, so its lookup is never the gap.
function lookupNoCredentialsHead(
  deps: CiTriggerDeps,
  base: Pick<CiTriggerInput, "eventName" | "repository">,
  pr: string,
): string {
  const first = resolveHeadSha(deps, base.eventName, base.repository, pr, true);
  if (first !== UNKNOWN_HEAD_SHA || base.eventName !== "issue_comment") {
    return first;
  }
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  sleep(HEAD_RETRY_DELAY_MS);
  return resolveHeadSha(deps, base.eventName, base.repository, pr, true);
}

export function runCiTrigger(deps: CiTriggerDeps): number {
  const base = readTriggerInput(deps);
  const input: CiTriggerInput = commenterPermissionNeeded(base)
    ? {
        ...base,
        commenterPermission: lookupCommenterPermission(
          deps,
          base.repository,
          base.commenterLogin,
        ),
      }
    : base;
  const decision = decideCiTrigger(input);
  const run = runIdentity(deps);
  // Resolved before the decision branches, so every record names the PR the
  // publisher would post on, whatever the decision.
  const resolution = resolvedPrNumber(deps);
  const pr = resolution.ok ? resolution.pr : undefined;

  if (decision.kind === "ignore" || decision.kind === "denied") {
    writeRecord(deps, run, { decision: decision.kind, params: {} });
    deps.appendOutput(formatTriggerOutputs(NO_RUN));
    deps.stdout(workflowCommand("notice", decision.reason));
    if (decision.kind === "denied") react(deps, base, "-1");
    else if (decision.nearMiss === true) react(deps, base, "confused");
    return 0;
  }

  if (decision.kind === "unverifiable") {
    // gh is already failing for this lookup, so asking it for the head would
    // only add another failing call: the publisher degrades to its summary.
    const write = writeRecord(deps, run, {
      decision: "unverifiable",
      params: { step: "the commenter permission check" },
      cls: lookupClass(decision),
      pr,
    });
    printCauseUnlessRecorded(deps, write, decision.reason);
    deps.appendOutput(
      formatTriggerOutputs({
        ...NO_RUN,
        pr: pr ?? "",
        publish: publishes(write),
      }),
    );
    return 1;
  }

  if (decision.kind === "no-credentials") {
    // An authorised commenter's command is accepted; the run is red for the missing
    // credential, and its comment says why.
    react(deps, base, "eyes");
    const head =
      pr === undefined
        ? UNKNOWN_HEAD_SHA
        : lookupNoCredentialsHead(deps, base, pr);
    const write = writeRecord(deps, run, {
      decision: "no-credentials",
      params: { backend: backendOf(deps) },
      pr,
      headSha: validSha(head),
    });
    printCauseUnlessRecorded(deps, write, noCredentialCause(decision.inputs));
    deps.appendOutput(
      formatTriggerOutputs({
        ...NO_RUN,
        pr: pr ?? "",
        head_sha: validSha(head) ?? "",
        publish: publishes(write),
      }),
    );
    return 1;
  }

  if (!resolution.ok) {
    // The publisher renders the class (PRH-PR-UNRESOLVED). The review never
    // started, so the install step's marker is absent by design. A malformed
    // input carries its fixed detail, so the fix names the input to correct.
    const write = writeRecord(deps, run, {
      decision: "review",
      params: resolution.malformed
        ? { detail: MALFORMED_PR_NUMBER_DETAIL }
        : {},
      cls: { kind: "trigger", check: "pr-unresolved" },
    });
    printCauseUnlessRecorded(deps, write, resolution.error);
    deps.appendOutput(
      formatTriggerOutputs({ ...NO_RUN, publish: publishes(write) }),
    );
    return 1;
  }

  // Past the early return the resolution is the resolved PR, so its number is a string.
  const prNumber = resolution.pr;
  // WHY a recheck is refused on a fork like an override: the adjudicator reads this
  // repository's checkout of the head, and a fork's head is not one.
  if (decision.kind === "review" && decision.adjudicate) {
    const answer = lookupOverrideHead(deps, base.repository, prNumber);
    if (answer.crossRepository !== false) {
      writeRecord(deps, run, { decision: "denied", params: {} });
      deps.appendOutput(formatTriggerOutputs(NO_RUN));
      deps.stdout(
        workflowCommand(
          "notice",
          answer.crossRepository === true
            ? RECHECK_FORK_REFUSAL
            : RECHECK_UNKNOWN_FORK_REFUSAL,
        ),
      );
      react(deps, base, "-1");
      return 0;
    }
  }
  if (decision.kind === "override") {
    // WHY refused unless the lookup says "same repository": a fork's head can change
    // after the comment, and the job binds the override to the head it resolves now.
    // A fork's author has no write access, so a fork's push after the comment would
    // turn the gate green on code the maintainer never saw. A same-repository pusher
    // already has write access. An answer that does not say is refused too, because
    // the lookup cannot rule the fork out. Refused like the denied path: no status. The
    // two refusals print different notices: a proven fork, and an answer that did not say.
    const answer = lookupOverrideHead(deps, base.repository, prNumber);
    if (answer.crossRepository !== false) {
      writeRecord(deps, run, { decision: "denied", params: {} });
      deps.appendOutput(formatTriggerOutputs(NO_RUN));
      deps.stdout(
        workflowCommand(
          "notice",
          answer.crossRepository === true
            ? OVERRIDE_FORK_REFUSAL
            : OVERRIDE_UNKNOWN_FORK_REFUSAL,
        ),
      );
      react(deps, base, "-1");
      return 0;
    }
    react(deps, base, "eyes");
    // WHY the no-head path is kept: a same-repository answer with no usable sha
    // still posts, and the publisher's comment says no status could be set.
    const head = answer.head ?? UNKNOWN_HEAD_SHA;
    const write = writeRecord(deps, run, {
      decision: "override",
      params: {},
      pr: prNumber,
      headSha: validSha(head),
      actor: decision.actor,
    });
    deps.appendOutput(
      formatTriggerOutputs({
        ...NO_RUN,
        pr: prNumber,
        head_sha: head,
        publish: publishes(write),
      }),
    );
    // WHY a failed record write is red: the publisher then has nothing to post,
    // so a green run would claim an override that never reached the gate.
    return write === "failed" ? 1 : 0;
  }
  const head = resolveHeadSha(
    deps,
    base.eventName,
    base.repository,
    prNumber,
    false,
  );
  const write = writeRecord(deps, run, {
    decision: "review",
    params: {},
    pr: prNumber,
    headSha: validSha(head),
  });
  react(deps, base, "eyes");
  deps.appendOutput(
    formatTriggerOutputs({
      run: true,
      force: decision.force,
      full: decision.full,
      adjudicate: decision.adjudicate,
      pr: prNumber,
      head_sha: head,
      publish: publishes(write),
    }),
  );
  return 0;
}

// An unset path (a local run outside Actions) writes nothing rather than
// creating a file named "undefined" in the working directory.
function appendTo(filePath: string | undefined): (text: string) => void {
  return (text) => {
    if (filePath !== undefined && filePath !== "") {
      appendFileSync(filePath, text);
    }
  };
}

if (import.meta.main) {
  process.exit(
    runCiTrigger({
      env: process.env,
      gh: (args) => {
        const result = Bun.spawnSync(["gh", ...args], {
          stdout: "pipe",
          stderr: "pipe",
          // A hung API call must not hold the job: this step runs before
          // anything else, on every event.
          timeout: 30_000,
        });
        return {
          exitCode: result.exitCode ?? -1,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
        };
      },
      sleep: (ms) => Bun.sleepSync(ms),
      exists: existsSync,
      stdout: (text) => process.stdout.write(text),
      appendOutput: appendTo(process.env.GITHUB_OUTPUT),
      appendSummary: appendTo(process.env.GITHUB_STEP_SUMMARY),
    }),
  );
}
