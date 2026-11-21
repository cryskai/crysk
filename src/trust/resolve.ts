// Resolves the MarkerTrust (./marker-trust.ts) a command reads marker comments with. Kept apart from
// the leaf so the leaf imports nothing: this module reads git and spawns gh.

import { git, remoteHeadRef } from "#git/git";
import { parseLocalConfig } from "#review/preflight";
import { log } from "#ui/primitives";
import { type MarkerTrust, markerTrust } from "./marker-trust";

const REPO_CONFIG_PATHS = [".crysk/config.json", ".prhero/config.json"];
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

// What a read of the default branch's ci_trusted_actors gave: the list (empty when the repository has
// no config file), or a failure. A caller that keeps a read between polls keeps only a list.
export type DefaultBranchTrustedActorsRead =
  | { ok: true; actors: ReadonlySet<string> }
  | { ok: false };

// One successful read per repository and process: the gate and the review of one CI run read the
// same branch, so the second reads it from here and says nothing twice. A failure is never kept.
const defaultBranchActorsCache = new Map<string, ReadonlySet<string>>();

export function resetDefaultBranchTrustCache(): void {
  defaultBranchActorsCache.clear();
}

// The repository's ci_trusted_actors as the default branch holds them.
// WHY not the working tree: in CI the checkout is the pull request's head, and its author must not be
// able to name themselves. The branch's remote ref is read with git plumbing when the clone has it;
// a CI checkout often does not, and then the file is read through the GitHub API at that branch.
// The clone is never fetched into: its refs and shallow boundary are what the review then diffs. A
// repository with no config file trusts no login beyond the bots. Anything unreadable is a failed
// read plus one log line, so a reader falls back to bots alone, which can only read less.
export async function readDefaultBranchTrustedActors(
  operatorRoot: string,
  options: {
    env?: Record<string, string | undefined>;
    spawnFn?: typeof Bun.spawn;
    log?: (line: string) => void;
  } = {},
): Promise<DefaultBranchTrustedActorsRead> {
  const cached = defaultBranchActorsCache.get(operatorRoot);
  if (cached !== undefined) return { ok: true, actors: cached };
  const env = options.env ?? process.env;
  const say = options.log ?? log;
  const unreadable = (why: string): DefaultBranchTrustedActorsRead => {
    say(
      `crysk: ci_trusted_actors not read from the default branch (${why}); reading markers from bots only`,
    );
    return { ok: false };
  };
  try {
    const branch = await defaultBranchName(operatorRoot, env, options.spawnFn);
    if (branch === undefined) return unreadable("no default branch found");
    const ref = `refs/remotes/origin/${branch}`;
    const read = (await refExists(operatorRoot, ref))
      ? await readConfigAtRef(operatorRoot, ref)
      : await readConfigThroughApi(operatorRoot, branch, options.spawnFn);
    if (!read.ok) return unreadable(read.why);
    defaultBranchActorsCache.set(operatorRoot, read.actors);
    return read;
  } catch (error) {
    return unreadable((error as Error).message.split("\n")[0] ?? "error");
  }
}

// The list alone, for a reader that does not keep reads: a failed read is an empty list.
export async function defaultBranchTrustedActors(
  operatorRoot: string,
  options: Parameters<typeof readDefaultBranchTrustedActors>[1] = {},
): Promise<ReadonlySet<string>> {
  const read = await readDefaultBranchTrustedActors(operatorRoot, options);
  return read.ok ? read.actors : new Set();
}

type ConfigRead =
  | { ok: true; actors: ReadonlySet<string> }
  | { ok: false; why: string };

async function readConfigAtRef(
  operatorRoot: string,
  ref: string,
): Promise<ConfigRead> {
  for (const file of REPO_CONFIG_PATHS) {
    const listed = await git(operatorRoot, [
      "ls-tree",
      "--full-tree",
      ref,
      "--",
      file,
    ]);
    if (!listed.ok) return { ok: false, why: `${ref} could not be listed` };
    const [meta] = listed.stdout.split("\t");
    const [mode, type, sha] = (meta ?? "").trim().split(" ");
    if (sha === undefined) continue;
    if (type !== "blob" || !REGULAR_FILE_MODES.has(mode ?? "")) {
      return { ok: false, why: `${file} is not a regular file` };
    }
    const blob = await git(operatorRoot, ["cat-file", "blob", sha]);
    if (!blob.ok) return { ok: false, why: `${file} could not be read` };
    return { ok: true, actors: configuredActors(blob.stdout, file) };
  }
  return { ok: true, actors: new Set() };
}

// The file at the branch through `gh api .../contents`, which answers the file's bytes in base64. A
// 404 is a file that does not exist there; any other failure is an unreadable branch.
async function readConfigThroughApi(
  operatorRoot: string,
  branch: string,
  spawnFn: typeof Bun.spawn | undefined,
): Promise<ConfigRead> {
  for (const file of REPO_CONFIG_PATHS) {
    const proc = (spawnFn ?? Bun.spawn)(
      [
        "gh",
        "api",
        `repos/{owner}/{repo}/contents/${file}?ref=${encodeURIComponent(branch)}`,
        "--jq",
        ".content",
      ],
      {
        cwd: operatorRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: DEFAULT_BRANCH_TIMEOUT_MS,
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      if (/\(HTTP 404\)/.test(stderr)) continue;
      return { ok: false, why: `${file} could not be read from the API` };
    }
    const encoded = stdout.replace(/\s+/g, "");
    if (encoded.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) {
      return { ok: false, why: `${file} came back without content` };
    }
    const raw = Buffer.from(encoded, "base64").toString("utf8");
    return { ok: true, actors: configuredActors(raw, file) };
  }
  return { ok: true, actors: new Set() };
}

function configuredActors(raw: string, file: string): ReadonlySet<string> {
  return new Set(parseLocalConfig(raw, file).ci_trusted_actors);
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
// The one rule every reader uses, the CI admission gate included. WHY not GITHUB_ACTOR: it is whoever
// triggered the event, and their replies and commands are judged by their repository permission,
// not by this set. An empty set reads bots only; it never means everyone.
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
