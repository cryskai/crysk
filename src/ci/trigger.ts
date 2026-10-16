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

import { appendFileSync } from "node:fs";

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
  | { kind: "resolved"; permission: string }
  | { kind: "unavailable"; detail: string };

// Presence only. The action passes `inputs.<credential> != ''`, never the
// value, so nothing in this module can print a secret it never received.
export interface CiCredentialPresence {
  anthropicApiKey: boolean;
  claudeToken: boolean;
  opencodeAuth: boolean;
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
  forceInput: boolean;
  fullInput: boolean;
}

export type CiTriggerDecision =
  | { kind: "review"; force: boolean; full: boolean }
  | { kind: "ignore"; reason: string }
  | { kind: "denied"; reason: string }
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
  if (
    input.eventName === "pull_request" ||
    input.eventName === "pull_request_target"
  ) {
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

function deniedReason(input: CiTriggerInput): string | undefined {
  const permission = input.commenterPermission;
  if (
    permission?.kind === "resolved" &&
    TRIGGER_PERMISSIONS.has(permission.permission)
  ) {
    return undefined;
  }
  const who = `@${input.commenterLogin || "unknown"}`;
  const rule =
    `Only a maintainer (write or admin access to ${input.repository}) can ` +
    `request a review with \`${REVIEW_COMMAND}\`.`;
  if (permission === undefined) {
    return `The permission of ${who} was not checked, so the command was refused. ${rule}`;
  }
  if (permission.kind === "unavailable") {
    return (
      `Could not verify the permission of ${who} (${permission.detail}), ` +
      `so the command was refused. ${rule}`
    );
  }
  return `${who} has \`${permission.permission || "no"}\` permission. ${rule}`;
}

// Precedence, in this order: event filter, commenter permission,
// credentials. An ignored or denied run must never report missing
// credentials: that error is red, and a near-miss comment or a stranger's
// command turning a PR red would be noise the author cannot fix.
export function decideCiTrigger(input: CiTriggerInput): CiTriggerDecision {
  const event = classifyEvent(input);
  if (event.kind === "ignore") return event;

  if (event.kind === "comment") {
    const reason = deniedReason(input);
    if (reason !== undefined) return { kind: "denied", reason };
  }

  const { anthropicApiKey, claudeToken, opencodeAuth } = input.credentials;
  if (!anthropicApiKey && !claudeToken && !opencodeAuth) {
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
    `**What is wrong:** no model credential reached the action. Its ${inputs} inputs were all empty.`,
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
  stdout: (text: string) => void;
  appendOutput: (text: string) => void;
  appendSummary: (text: string) => void;
}

// Every name below is bound by the trigger step's `env:` in action.yml,
// except GITHUB_REPOSITORY and GITHUB_RUN_ID, which every step inherits.
function readTriggerInput(
  env: CiTriggerDeps["env"],
): Omit<CiTriggerInput, "commenterPermission"> {
  const text = (name: string): string => env[name] ?? "";
  const flag = (name: string): boolean => text(name) === "true";
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
    },
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

// Fails closed: a gh that cannot start, a non-zero exit (a 404 for a
// non-collaborator included) or an empty answer is "unavailable", which the
// decision denies. Only a clean `admin` / `write` answer can spend money.
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
  const result = callGh(deps, [
    "api",
    `repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
    "--jq",
    ".permission",
  ]);
  if (result.exitCode !== 0) {
    return { kind: "unavailable", detail: ghFailureDetail(result) };
  }
  const permission = result.stdout.trim();
  if (permission === "") {
    return { kind: "unavailable", detail: "gh returned no permission" };
  }
  return { kind: "resolved", permission };
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
  const base = readTriggerInput(deps.env);
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
      stdout: (text) => process.stdout.write(text),
      appendOutput: appendTo(process.env.GITHUB_OUTPUT),
      appendSummary: appendTo(process.env.GITHUB_STEP_SUMMARY),
    }),
  );
}
