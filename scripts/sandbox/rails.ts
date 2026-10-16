// The safety rails of the sandbox runner (ROADMAP CI sandbox S6). Every gh and
// git call the runner makes passes through here first, so the runner cannot
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
  "run list",
  "run view",
  // Cancelling a sandbox run is how a timed-out scenario stops its review. It
  // is still only ever aimed at the sandbox, by the same -R check as the rest.
  "run cancel",
]);

// The rules in this block apply to every gh call, whatever its verb, so a verb
// added later inherits them. Each refuses a whole class of argument the runner never
// sends, rather than a list of spellings to chase.

// pflag reads a cluster of short flags, and an attached value, as one argument:
// -iXDELETE is -i then -X DELETE, and -dR other/repo is -d then -R other/repo. The
// -i and -d are boolean, so a check on the first letter alone never sees the flag
// inside the cluster. The runner sends only long flags and the bare -X, -f, -F and
// -R, so no single-dash argument longer than two characters is ever needed.
function isShortFlagCluster(arg: string): boolean {
  return arg.startsWith("-") && !arg.startsWith("--") && arg.length > 2;
}

// gh resolves a URL positional to the repository the URL names, and that overrides
// -R, so the -R check passes while the call lands in another repository.
function isUrlArgument(arg: string): boolean {
  return arg.includes("://") || arg.startsWith("github.com/");
}

// These widen a call from the sandbox to an organization, a user, a deployment
// environment, or another GitHub host. The short forms are two characters, so the
// cluster rule does not catch them; each is listed, in its `=` form too.
const SCOPE_FLAGS = [
  "--org",
  "--user",
  "--env",
  "--hostname",
  "-o",
  "-u",
  "-e",
];
function isScopeFlag(arg: string): boolean {
  return SCOPE_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
}

function assertCommonGhArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (isShortFlagCluster(arg)) {
      throw new RailViolation(
        `gh ${arg} is a short-flag cluster or attached value, which the runner never sends`,
      );
    }
    if (isUrlArgument(arg)) {
      throw new RailViolation(
        `gh ${arg} is a URL, which gh resolves to its own repository over -R`,
      );
    }
    if (isScopeFlag(arg)) {
      throw new RailViolation(
        `gh ${arg} widens the call beyond ${SANDBOX_REPO}`,
      );
    }
  }
}

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

// Every method flag, in either spelling. gh keeps the last one it is given, so
// a list is returned and the caller refuses more than one.
function methodFlags(args: readonly string[]): string[] {
  const methods: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "-X" || arg === "--method") {
      methods.push(args[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("--method=")) {
      methods.push(arg.slice("--method=".length));
    }
  }
  return methods;
}

// Every -R or --repo value, in each separated or `=` spelling gh accepts. An
// attached -R value is a cluster, which the common rule refuses first. gh keeps
// the last occurrence, so the caller checks all of them rather than the first.
function repoFlagValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "-R" || arg === "--repo") {
      values.push(args[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("--repo=")) {
      values.push(arg.slice("--repo=".length));
    }
  }
  return values;
}

// A path segment that is `.`, `..`, or empty (`//`, or a trailing slash). GitHub and
// git resolve the first two, so `sandbox/../main` names main, and an empty segment is
// the same malformed shape. A prefix or character test reads the path as written, so
// it cannot see any of them.
function hasUnsafeSegment(path: string): boolean {
  return path
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..");
}

function assertApi(args: readonly string[]): void {
  const endpoint = args[1];
  if (endpoint === undefined || endpoint.startsWith("-")) {
    throw new RailViolation("gh api needs an endpoint");
  }
  // Before the prefix test, which reads the path as written. GitHub decodes `%2e`
  // and resolves `..`, so a path that starts inside the sandbox can name another
  // repository, or main, once it is read.
  if (endpoint.includes("%") || hasUnsafeSegment(endpoint)) {
    throw new RailViolation(
      `gh api ${endpoint} has a dot, empty or percent-encoded segment`,
    );
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
  const methods = methodFlags(args);
  if (methods.length > 1) {
    throw new RailViolation(
      "gh api takes one method, and the runner sends one",
    );
  }
  const method = (methods[0] ?? "GET").toUpperCase();
  if (method === "GET") return;
  // The one write the runner makes: a DELETE of a scenario branch's ref. The branch
  // is taken from the path and given the branch rule, so the two cannot disagree.
  const refs = `repos/${SANDBOX_REPO}/git/refs/heads/`;
  if (method === "DELETE" && endpoint.startsWith(refs)) {
    assertScenarioBranch(endpoint.slice(refs.length));
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
  const repos = repoFlagValues(args);
  if (repos.length === 0 || repos.some((repo) => repo !== SANDBOX_REPO)) {
    throw new RailViolation(`gh ${verb} ${sub} must target ${SANDBOX_REPO}`);
  }
}

export function assertGhArgs(args: readonly string[]): void {
  assertCommonGhArgs(args);
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
  // Exactly a remote and one refspec. A third positional (`main +dev:dev`)
  // would otherwise slip past a check that reads only the first two.
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  if (positional.length !== 2) {
    throw new RailViolation("git push must be `origin <branch>`");
  }
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

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, i) => arg === b[i]);
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
    // Exactly the two reads the clone check makes: origin's fetch URL and its push
    // URL. Any other remote read, or a read of another remote, is refused.
    if (
      !sameArgs(rest, ["get-url", "origin"]) &&
      !sameArgs(rest, ["get-url", "--push", "origin"])
    ) {
      throw new RailViolation(
        `git remote ${rest.join(" ")} is not a sandbox read`,
      );
    }
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
// name that could be read as a flag or a refspec, and never a path that git or
// GitHub would resolve to another ref (a `.` or `..` segment, or an empty one).
export function assertScenarioBranch(name: string): void {
  const suffix = name.slice(SCENARIO_BRANCH_PREFIX.length);
  if (
    !name.startsWith(SCENARIO_BRANCH_PREFIX) ||
    suffix.length === 0 ||
    !BRANCH_NAME.test(name) ||
    hasUnsafeSegment(name)
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
