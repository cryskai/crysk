// The safety rails of the sandbox runner (ROADMAP CI sandbox S6). Every gh and
// git call the runners make passes through here first, so the runner cannot
// reach another repository, delete one, force a push, or rewrite main, even by
// a bug in the runner itself. The rails are allowlists: a verb is refused unless
// it is named here, so a new gh or git verb cannot reach the sandbox by accident.

import type { Gh, Git } from "./ports";

export const SANDBOX_OWNER = "juanmaagd";
export const SANDBOX_NAME = "pr-hero-sandbox";
export const SANDBOX_REPO = `${SANDBOX_OWNER}/${SANDBOX_NAME}`;
export const SANDBOX_REMOTE_URL = `https://github.com/${SANDBOX_REPO}.git`;
export const SCENARIO_BRANCH_PREFIX = "sandbox/";

const MAIN = "main";
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export class RailViolation extends Error {
  constructor(message: string) {
    super(`sandbox rail: ${message}`);
    this.name = "RailViolation";
  }
}

// gh subcommands the runner may use, each checked for its repository target.
const GH_REPO_VERBS = new Set(["view", "create", "clone"]);
const GH_TARGETED = new Set([
  "secret list",
  "secret set",
  "variable get",
  "variable set",
  "pr list",
  "pr create",
  "pr view",
  "pr close",
  // The only write a scenario makes to a PR: the `/pr-hero review` comment that
  // starts a comment-triggered run. Still repo-targeted like every verb here.
  "pr comment",
  "run list",
  "run view",
]);

// `gh api` is GET on a path inside the sandbox, plus one DELETE of a scenario
// branch ref. No field flags, which would turn the call into a write.
const API_WRITE_FLAGS = new Set([
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input",
]);
const API_WRITE_FLAG_PREFIXES = ["--field=", "--raw-field=", "--input="];

function flagValue(
  args: readonly string[],
  names: readonly string[],
): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    for (const name of names) {
      if (arg === name) return args[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function assertApi(args: readonly string[]): void {
  const endpoint = args[1];
  if (endpoint === undefined || endpoint.startsWith("-")) {
    throw new RailViolation("gh api needs an endpoint");
  }
  if (
    !endpoint.startsWith(`repos/${SANDBOX_REPO}/`) &&
    endpoint !== `repos/${SANDBOX_REPO}`
  ) {
    throw new RailViolation(`gh api ${endpoint} is outside ${SANDBOX_REPO}`);
  }
  if (
    args.some(
      (arg) =>
        API_WRITE_FLAGS.has(arg) ||
        API_WRITE_FLAG_PREFIXES.some((p) => arg.startsWith(p)),
    )
  ) {
    throw new RailViolation(
      "gh api field flags are writes, which the runner does not send",
    );
  }
  const method = (flagValue(args, ["-X", "--method"]) ?? "GET").toUpperCase();
  if (method === "GET") return;
  const scenarioRef = `repos/${SANDBOX_REPO}/git/refs/heads/${SCENARIO_BRANCH_PREFIX}`;
  if (
    method === "DELETE" &&
    endpoint.startsWith(scenarioRef) &&
    endpoint.length > scenarioRef.length
  ) {
    return;
  }
  throw new RailViolation(
    `gh api ${method} ${endpoint} is not a sandbox operation`,
  );
}

function assertRepoTarget(args: readonly string[]): void {
  const [verb, sub] = args;
  if (verb === "repo") {
    if (sub === undefined || !GH_REPO_VERBS.has(sub)) {
      throw new RailViolation(
        `gh repo ${sub ?? ""} is not a sandbox operation`,
      );
    }
    if (args[2] !== SANDBOX_REPO) {
      throw new RailViolation(`gh repo ${sub} must name ${SANDBOX_REPO}`);
    }
    return;
  }
  if (!GH_TARGETED.has(`${verb} ${sub}`)) {
    throw new RailViolation(
      `gh ${verb ?? ""} ${sub ?? ""} is not a sandbox operation`,
    );
  }
  if (flagValue(args, ["-R", "--repo"]) !== SANDBOX_REPO) {
    throw new RailViolation(`gh ${verb} ${sub} must target ${SANDBOX_REPO}`);
  }
}

export function assertGhArgs(args: readonly string[]): void {
  if (args[0] === "api") {
    assertApi(args);
    return;
  }
  assertRepoTarget(args);
}

const GIT_VERBS = new Set([
  "add",
  "commit",
  "push",
  "rev-parse",
  "symbolic-ref",
  "checkout",
  "status",
  "remote",
]);
// Any of these anywhere in a git call is refused, whatever the verb.
const GIT_FORBIDDEN = new Set([
  "--force",
  "-f",
  "--force-with-lease",
  "--force-if-includes",
  "--mirror",
  "--delete",
  "-d",
  "--amend",
  "-B",
  "-D",
  "--orphan",
]);
const PUSH_FLAGS = new Set(["-u", "--set-upstream"]);

function assertPush(rest: readonly string[]): void {
  for (const arg of rest) {
    if (arg.startsWith("-") && !PUSH_FLAGS.has(arg)) {
      throw new RailViolation(`git push ${arg} is not a sandbox push`);
    }
  }
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  const [remote, refspec] = positional;
  if (remote !== "origin" || refspec === undefined) {
    throw new RailViolation("git push must be `origin <branch>`");
  }
  // A plain branch name only: no `+` (force), no `:` (delete or a foreign
  // destination), and only main or a scenario branch as the target.
  if (refspec.includes(":") || refspec.startsWith("+")) {
    throw new RailViolation(`git push refspec ${refspec} is refused`);
  }
  if (refspec !== MAIN) assertScenarioBranch(refspec);
}

export function assertGitArgs(args: readonly string[]): void {
  const [verb, ...rest] = args;
  if (verb === undefined || !GIT_VERBS.has(verb)) {
    throw new RailViolation(`git ${verb ?? ""} is not a sandbox operation`);
  }
  for (const arg of args) {
    if (GIT_FORBIDDEN.has(arg))
      throw new RailViolation(`git ${arg} is refused`);
  }
  if (verb === "push") {
    assertPush(rest);
    return;
  }
  if (verb === "remote") {
    if (rest[0] !== "get-url")
      throw new RailViolation("git remote is limited to get-url");
    return;
  }
  if (verb === "checkout") {
    if (rest[0] !== "-b")
      throw new RailViolation("git checkout is limited to -b");
    assertScenarioBranch(rest[1] ?? "");
    return;
  }
  if (verb === "symbolic-ref") {
    if (rest[0] !== "HEAD" || rest[1] !== `refs/heads/${MAIN}`) {
      throw new RailViolation("git symbolic-ref is limited to HEAD -> main");
    }
  }
}

// A scenario branch is sandbox/<name> and nothing else: never main, never a
// name that could be read as a flag or a refspec.
export function assertScenarioBranch(name: string): void {
  const suffix = name.slice(SCENARIO_BRANCH_PREFIX.length);
  if (
    !name.startsWith(SCENARIO_BRANCH_PREFIX) ||
    suffix.length === 0 ||
    !BRANCH_NAME.test(name)
  ) {
    throw new RailViolation(`${name} is not a scenario branch`);
  }
}

// A clone's origin must be the sandbox itself, in either URL form gh and git use.
export function assertSandboxRemote(url: string): void {
  if (
    url !== SANDBOX_REMOTE_URL &&
    url !== `git@github.com:${SANDBOX_REPO}.git`
  ) {
    throw new RailViolation(`origin ${url} is not ${SANDBOX_REPO}`);
  }
}

export function guardedGh(inner: Gh): Gh {
  return async (args) => {
    assertGhArgs(args);
    return inner(args);
  };
}

export function guardedGit(inner: Git): Git {
  return async (args, cwd) => {
    assertGitArgs(args);
    return inner(args, cwd);
  };
}
