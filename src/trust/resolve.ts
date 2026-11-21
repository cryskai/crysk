// Resolves the MarkerTrust (./marker-trust.ts) a command reads marker comments with. Kept apart from
// the leaf so the leaf imports nothing: this module reads git and spawns gh.

import { git, remoteHeadRef } from "#git/git";
import { parseLocalConfig } from "#review/preflight";
import { type MarkerTrust, markerTrust } from "./marker-trust";

const REPO_CONFIG_PATHS = [".crysk/config.json", ".prhero/config.json"];
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

// The repository's ci_trusted_actors, read from the default branch's objects with local git only.
// WHY not the working tree: the checkout is often the pull request, and its author must not be able
// to name themselves. Anything unreadable (no origin/HEAD, no file, a file that does not parse) is an
// empty list, so a reader falls back to bots alone, which can only read less.
export async function defaultBranchTrustedActors(
  operatorRoot: string,
): Promise<ReadonlySet<string>> {
  try {
    const branch = await remoteHeadRef(operatorRoot);
    if (branch === undefined) return new Set();
    for (const file of REPO_CONFIG_PATHS) {
      const listed = await git(operatorRoot, [
        "ls-tree",
        "--full-tree",
        `refs/remotes/origin/${branch}`,
        "--",
        file,
      ]);
      if (!listed.ok) return new Set();
      const [meta] = listed.stdout.split("\t");
      const [mode, type, sha] = (meta ?? "").trim().split(" ");
      if (sha === undefined) continue;
      if (type !== "blob" || !REGULAR_FILE_MODES.has(mode ?? "")) {
        return new Set();
      }
      const blob = await git(operatorRoot, ["cat-file", "blob", sha]);
      if (!blob.ok) return new Set();
      return new Set(parseLocalConfig(blob.stdout, file).ci_trusted_actors);
    }
    return new Set();
  } catch {
    return new Set();
  }
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
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(login)
      ? login
      : undefined;
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
    defaultBranchTrustedActors(input.operatorRoot),
    resolveSelfLogin({ ...input, env }),
  ]);
  return markerTrust([env.CRYSK_PLATFORM_ACTOR, ...configured, self]);
}
