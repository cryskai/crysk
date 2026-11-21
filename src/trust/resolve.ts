// Resolves the MarkerTrust (./marker-trust.ts) a command reads marker comments with. Kept apart from
// the leaf so the leaf imports nothing: this module reads git and spawns gh.

import { git, remoteHeadRef } from "#git/git";
import { parseLocalConfig } from "#review/preflight";
import { log } from "#ui/primitives";
import { type MarkerTrust, markerTrust } from "./marker-trust";

const REPO_CONFIG_PATHS = [".crysk/config.json", ".prhero/config.json"];
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

// The repository's ci_trusted_actors, read from the default branch's objects with git plumbing.
// WHY not the working tree: in CI the checkout is the pull request's head, and its author must not be
// able to name themselves. A repository with no config file trusts no login beyond the bots. Anything
// unreadable (no default branch, a ref that cannot be fetched, a file that does not parse) is an empty
// list plus one log line, so a reader falls back to bots alone, which can only read less.
export async function defaultBranchTrustedActors(
  operatorRoot: string,
  options: {
    env?: Record<string, string | undefined>;
    spawnFn?: typeof Bun.spawn;
    log?: (line: string) => void;
  } = {},
): Promise<ReadonlySet<string>> {
  const env = options.env ?? process.env;
  const say = options.log ?? log;
  const unreadable = (why: string): ReadonlySet<string> => {
    say(
      `crysk: ci_trusted_actors not read from the default branch (${why}); reading markers from bots only`,
    );
    return new Set();
  };
  try {
    const branch = await defaultBranchName(operatorRoot, env, options.spawnFn);
    if (branch === undefined) return unreadable("no default branch found");
    const ref = `refs/remotes/origin/${branch}`;
    if (!(await refExists(operatorRoot, ref))) {
      await fetchDefaultBranch(operatorRoot, branch, ref);
      if (!(await refExists(operatorRoot, ref))) {
        return unreadable(`origin/${branch} could not be fetched`);
      }
    }
    for (const file of REPO_CONFIG_PATHS) {
      const listed = await git(operatorRoot, [
        "ls-tree",
        "--full-tree",
        ref,
        "--",
        file,
      ]);
      if (!listed.ok) return unreadable(`origin/${branch} could not be listed`);
      const [meta] = listed.stdout.split("\t");
      const [mode, type, sha] = (meta ?? "").trim().split(" ");
      if (sha === undefined) continue;
      if (type !== "blob" || !REGULAR_FILE_MODES.has(mode ?? "")) {
        return unreadable(`${file} is not a regular file`);
      }
      const blob = await git(operatorRoot, ["cat-file", "blob", sha]);
      if (!blob.ok) return unreadable(`${file} could not be read`);
      return new Set(parseLocalConfig(blob.stdout, file).ci_trusted_actors);
    }
    return new Set();
  } catch (error) {
    return unreadable((error as Error).message.split("\n")[0] ?? "error");
  }
}

// A branch name as git and GitHub spell it, never an option or a path that walks out of refs/.
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const DEFAULT_BRANCH_TIMEOUT_MS = 30_000;

// origin/HEAD when the clone has it. A CI checkout usually does not, so then the event payload Actions
// writes (its repository's default_branch), and last the repository as gh reports it.
async function defaultBranchName(
  operatorRoot: string,
  env: Record<string, string | undefined>,
  spawnFn: typeof Bun.spawn | undefined,
): Promise<string | undefined> {
  const valid = (name: unknown): string | undefined =>
    typeof name === "string" && BRANCH_NAME.test(name) ? name : undefined;
  const remote = valid(await remoteHeadRef(operatorRoot));
  if (remote !== undefined) return remote;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath !== undefined && eventPath.length > 0) {
    try {
      const event = JSON.parse(await Bun.file(eventPath).text()) as {
        repository?: { default_branch?: unknown };
      };
      const fromEvent = valid(event.repository?.default_branch);
      if (fromEvent !== undefined) return fromEvent;
    } catch {
      // An unreadable payload falls through to gh.
    }
  }
  try {
    const proc = (spawnFn ?? Bun.spawn)(
      [
        "gh",
        "repo",
        "view",
        "--json",
        "defaultBranchRef",
        "--jq",
        ".defaultBranchRef.name",
      ],
      {
        cwd: operatorRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: DEFAULT_BRANCH_TIMEOUT_MS,
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return exitCode === 0 ? valid(stdout.trim()) : undefined;
  } catch {
    return undefined;
  }
}

async function refExists(operatorRoot: string, ref: string): Promise<boolean> {
  const result = await git(operatorRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return result.ok;
}

// Fetches only the default branch's tip into its remote-tracking ref, bounded. A shallow checkout
// (the CI default) stays shallow; a full clone is not made shallow.
async function fetchDefaultBranch(
  operatorRoot: string,
  branch: string,
  ref: string,
): Promise<void> {
  const shallow = await git(operatorRoot, [
    "rev-parse",
    "--is-shallow-repository",
  ]);
  const depth =
    shallow.ok && shallow.stdout.trim() === "true" ? ["--depth=1"] : [];
  const proc = Bun.spawn(
    [
      "git",
      "-C",
      operatorRoot,
      "fetch",
      "--no-tags",
      "--quiet",
      ...depth,
      "origin",
      `+refs/heads/${branch}:${ref}`,
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: DEFAULT_BRANCH_TIMEOUT_MS,
    },
  );
  await proc.exited;
}

const SELF_LOGIN_TIMEOUT_MS = 10_000;

// One answer per process: the account gh is signed in as does not change while a command runs. A
// lookup that failed is not kept, so a long-running watcher asks again on its next read.
let selfLoginCache: Promise<string | undefined> | undefined;

export function resetSelfLoginCache(): void {
  selfLoginCache = undefined;
}

// The login of the account gh posts as on this machine, or undefined when it does not read. Best
// effort and bounded: a failure adds no login, so the run reads bots and the configured logins only.
// WHY never in Actions: an installation token cannot read /user, and a run there posts as a bot.
export function resolveSelfLogin(input: {
  operatorRoot: string;
  env?: Record<string, string | undefined>;
  spawnFn?: typeof Bun.spawn;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const env = input.env ?? process.env;
  if (env.GITHUB_ACTIONS === "true") return Promise.resolve(undefined);
  if (selfLoginCache === undefined) {
    const pending = readSelfLogin(input);
    selfLoginCache = pending;
    void pending.then((login) => {
      if (login === undefined && selfLoginCache === pending) {
        selfLoginCache = undefined;
      }
    });
  }
  return selfLoginCache;
}

async function readSelfLogin(input: {
  operatorRoot: string;
  spawnFn?: typeof Bun.spawn;
  timeoutMs?: number;
}): Promise<string | undefined> {
  try {
    const spawn = input.spawnFn ?? Bun.spawn;
    const proc = spawn(["gh", "api", "user", "--jq", ".login"], {
      cwd: input.operatorRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: input.timeoutMs ?? SELF_LOGIN_TIMEOUT_MS,
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return undefined;
    const login = stdout.trim();
    // Letters, digits and hyphens; an enterprise managed user's login also carries an underscore.
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(login) ? login : undefined;
  } catch {
    return undefined;
  }
}

// The trust a command reads marker comments with: every bot, the platform App's login, the
// repository's ci_trusted_actors from the default branch, and, outside Actions, the login this
// machine posts as (a local `review --pr` or `post` writes the summary under it).
export async function resolveMarkerTrust(input: {
  operatorRoot: string;
  env?: Record<string, string | undefined>;
  spawnFn?: typeof Bun.spawn;
}): Promise<MarkerTrust> {
  const env = input.env ?? process.env;
  const [configured, self] = await Promise.all([
    defaultBranchTrustedActors(input.operatorRoot, {
      env,
      spawnFn: input.spawnFn,
    }),
    resolveSelfLogin({ ...input, env }),
  ]);
  return markerTrust([env.CRYSK_PLATFORM_ACTOR, ...configured, self]);
}
