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
// `gh` only the questions the decision needs, and writes $GITHUB_OUTPUT.
// Both I/O seams (`gh`, the writers) are injected so the shell's ordering,
// not just its answers, is testable offline.
//
// WHY ONLY BUILTINS: action.yml runs this step BEFORE `bun install`, so an
// ignored comment costs seconds instead of a dependency install. A package
// import has no node_modules to resolve against yet, and a `#...` alias is no
// better: it resolves to a src module whose own imports reach packages. Keep
// every import here `node:` or `bun`.

import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";

export const REVIEW_COMMAND = "/pr-hero review";
export const REVIEW_FULL_COMMAND = "/pr-hero review --full";

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
  // nor a quiet denial.
  | { kind: "indeterminate"; detail: string };

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
}

export type CiTriggerDecision =
  | { kind: "review"; force: boolean; full: boolean }
  | { kind: "ignore"; reason: string }
  | { kind: "denied"; reason: string }
  | { kind: "unverifiable"; reason: string }
  | { kind: "no-credentials"; inputs: readonly string[] };

// Exact match after trimming, and nothing else: no case folding, no inner
// whitespace tolerance, no trailing words. A loose match is how "/pr-hero
// review please" or a quoted reply would start a paid review.
export function parseReviewCommand(
  body: string,
): { full: boolean } | undefined {
  const command = body.trim();
  if (command === REVIEW_COMMAND) return { full: false };
  if (command === REVIEW_FULL_COMMAND) return { full: true };
  return undefined;
}

type EventVerdict =
  | { kind: "ignore"; reason: string }
  | { kind: "comment"; full: boolean }
  | { kind: "event" };

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
    const command = parseReviewCommand(input.commentBody);
    if (command === undefined) {
      return {
        kind: "ignore",
        reason:
          `This comment is not a pr-hero command. Comment exactly ` +
          `\`${REVIEW_COMMAND}\` or \`${REVIEW_FULL_COMMAND}\` to request ` +
          "a review.",
      };
    }
    return { kind: "comment", full: command.full };
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
  full: boolean,
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
    const command = full ? REVIEW_FULL_COMMAND : REVIEW_COMMAND;
    return {
      kind: "unverifiable",
      reason:
        `pr-hero could not verify whether ${who} has write access to ` +
        `${input.repository}, because the GitHub API call failed ` +
        `(${permission.detail}), so no review was started. Comment ` +
        `\`${command}\` again to retry.`,
    };
  }
  const rule =
    `Only a maintainer (write or admin access to ${input.repository}) can ` +
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
export function decideCiTrigger(input: CiTriggerInput): CiTriggerDecision {
  const event = classifyEvent(input);
  if (event.kind === "ignore") return event;

  if (event.kind === "comment") {
    const verdict = commenterVerdict(input, event.full);
    if (verdict !== undefined) return verdict;
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
  return {
    kind: "review",
    force: input.forceInput || fromComment,
    full: input.fullInput || (fromComment && event.full),
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
    return {
      ok: false,
      error: "The 'pr-number' input must be a positive integer.",
    };
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

export function renderNoCredentialsError(): string {
  return workflowCommand(
    "error",
    "No model credential reached pr-hero, so this pull request was not " +
      "reviewed. Set CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, or " +
      "OPENCODE_AUTH_JSON plus PRHERO_ROUTING. The job summary has the " +
      "exact commands.",
  );
}

// The fix commands are ported from the old `credentials` job's notice in
// src/ci/setup.ts. That job only warned, and a skipped review reported green
// — exactly what a clean review looks like — which cost this project five
// unreviewed PRs. Now the run is red, and the summary carries the fix.
export function renderNoCredentialsSummary(context: {
  runId?: string;
}): string {
  const runId =
    context.runId !== undefined && /^[0-9]+$/.test(context.runId)
      ? context.runId
      : "<run-id>";
  const inputs = CREDENTIAL_INPUTS.map((name) => `\`${name}\``).join(", ");
  return [
    "### :x: pr-hero could not review this pull request",
    "",
    `**What is wrong:** no model credential reached the action. Its ${inputs} inputs were all empty, and the runner holds no Claude session file or OpenCode auth store.`,
    "",
    "**Why this run is red:** pr-hero reviews with a model it can authenticate to. A run that skipped quietly would report green, and that looks exactly like a clean review.",
    "",
    "**Fix:** wire a Claude secret, or OpenCode (secret plus routing variable):",
    "",
    "```bash",
    "claude setup-token   # prints a long-lived token; paste it below",
    "gh secret set CLAUDE_CODE_OAUTH_TOKEN",
    "# ...or, for pay-as-you-go billing:",
    "gh secret set ANTHROPIC_API_KEY",
    "# ...or, for OpenCode (needs both):",
    "gh secret set OPENCODE_AUTH_JSON",
    "gh variable set PRHERO_ROUTING --body '<routing-object-json>'",
    "```",
    "",
    `If the secret is already set, check that the workflow hands it to the action (for example \`claude-token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\`): a secret the workflow does not pass never reaches pr-hero. Runs started by Dependabot read Dependabot secrets (\`gh secret set --app dependabot <NAME>\`), not Actions secrets.`,
    "",
    `**Re-run:** adding a secret does not re-run past workflows. Re-run this one with \`gh run rerun ${runId}\`, or comment \`${REVIEW_COMMAND}\` on the pull request.`,
    "",
  ].join("\n");
}

export interface CiTriggerOutputs {
  run: boolean;
  force: boolean;
  full: boolean;
  pr: string;
  head_sha: string;
}

const NO_RUN: CiTriggerOutputs = {
  run: false,
  force: false,
  full: false,
  pr: "",
  head_sha: "",
};

export function formatTriggerOutputs(outputs: CiTriggerOutputs): string {
  return [
    `run=${outputs.run}`,
    `force=${outputs.force}`,
    `full=${outputs.full}`,
    `pr=${outputs.pr}`,
    `head_sha=${outputs.head_sha}`,
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
}

// Every name below is bound by the trigger step's `env:` in action.yml,
// except GITHUB_REPOSITORY, GITHUB_RUN_ID, RUNNER_ENVIRONMENT, HOME and
// XDG_DATA_HOME, which every step inherits from the runner.
function readTriggerInput(
  deps: CiTriggerDeps,
): Omit<CiTriggerInput, "commenterPermission"> {
  const { env } = deps;
  const text = (name: string): string => env[name] ?? "";
  const flag = (name: string): boolean => text(name) === "true";
  const exists = deps.exists ?? existsSync;
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
  };
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
    return { kind: "indeterminate", detail: ghFailureDetail(result) };
  }
  const permission = result.stdout.trim();
  if (permission === "") {
    return { kind: "unavailable", detail: "gh returned no permission" };
  }
  return { kind: "resolved", permission };
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
  deps.stdout(
    workflowCommand(
      "warning",
      `Could not resolve the head of pull request #${pr}; the run-directory ` +
        `artifact is named with "${UNKNOWN_HEAD_SHA}" instead of its sha.`,
    ),
  );
  return UNKNOWN_HEAD_SHA;
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

  if (decision.kind === "ignore" || decision.kind === "denied") {
    deps.appendOutput(formatTriggerOutputs(NO_RUN));
    deps.stdout(workflowCommand("notice", decision.reason));
    return 0;
  }
  if (decision.kind === "unverifiable") {
    deps.appendOutput(formatTriggerOutputs(NO_RUN));
    deps.stdout(workflowCommand("error", decision.reason));
    return 1;
  }
  if (decision.kind === "no-credentials") {
    deps.appendOutput(formatTriggerOutputs(NO_RUN));
    deps.stdout(renderNoCredentialsError());
    deps.appendSummary(
      renderNoCredentialsSummary({ runId: deps.env.GITHUB_RUN_ID }),
    );
    return 1;
  }

  const pr = resolvePrNumber({
    prNumberInput: deps.env.PR_NUMBER_INPUT ?? "",
    eventName: base.eventName,
    eventPrNumber: deps.env.EVENT_PR_NUMBER ?? "",
    eventIssueNumber: deps.env.EVENT_ISSUE_NUMBER ?? "",
  });
  if (!pr.ok) {
    deps.appendOutput(formatTriggerOutputs(NO_RUN));
    deps.stdout(workflowCommand("error", pr.error));
    return 1;
  }

  deps.appendOutput(
    formatTriggerOutputs({
      run: true,
      force: decision.force,
      full: decision.full,
      pr: pr.pr,
      head_sha: resolveHeadSha(deps, base.eventName, base.repository, pr.pr),
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
