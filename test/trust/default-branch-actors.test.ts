// S4 (odd/tasks/marker-trust.md): ci_trusted_actors is read from the default branch, never from the
// checkout, including in a CI-shaped clone: shallow, on the pull request's head, with no origin/HEAD
// and no local ref for the default branch.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultBranchTrustedActors } from "../../src/trust/resolve";

async function run(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out;
}

const config = (actors: string[]) =>
  `${JSON.stringify({ ci_trusted_actors: actors })}\n`;

let scratch: string;
let origin: string;

// An origin whose default branch trusts `from-default-branch`, and a pull request branch whose own
// config names its author.
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "crysk-marker-trust-"));
  const seed = path.join(scratch, "seed");
  origin = path.join(scratch, "origin.git");
  await run(scratch, "init", "-q", "-b", "main", seed);
  await Bun.write(
    path.join(seed, ".crysk/config.json"),
    config(["from-default-branch"]),
  );
  await run(seed, "add", ".");
  await run(seed, "commit", "-q", "-m", "main");
  await run(seed, "checkout", "-q", "-b", "pr");
  await Bun.write(path.join(seed, ".crysk/config.json"), config(["pr-author"]));
  await run(seed, "commit", "-q", "-am", "pr");
  await run(scratch, "clone", "-q", "--bare", seed, origin);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// A clone shaped like actions/checkout's: one branch, shallow, no origin/HEAD.
async function ciClone(name: string): Promise<string> {
  const dir = path.join(scratch, name);
  await run(
    scratch,
    "clone",
    "-q",
    "--depth=1",
    "--single-branch",
    "--branch",
    "pr",
    `file://${origin}`,
    dir,
  );
  await run(dir, "update-ref", "-d", "refs/remotes/origin/HEAD").catch(
    () => "",
  );
  return dir;
}

async function eventFile(defaultBranch: string): Promise<string> {
  const file = path.join(scratch, `event-${defaultBranch}.json`);
  await writeFile(
    file,
    JSON.stringify({ repository: { default_branch: defaultBranch } }),
  );
  return file;
}

const noGh = (() => {
  throw new Error("gh is not reached when the event names the branch");
}) as unknown as typeof Bun.spawn;

describe("defaultBranchTrustedActors", () => {
  test("a CI-shaped clone reads the default branch's list, not the checkout's", async () => {
    const dir = await ciClone("ci-clone");
    const lines: string[] = [];
    const actors = await defaultBranchTrustedActors(dir, {
      env: { GITHUB_EVENT_PATH: await eventFile("main") },
      spawnFn: noGh,
      log: (line) => lines.push(line),
    });
    expect([...actors]).toEqual(["from-default-branch"]);
    expect(lines).toEqual([]);
    // The fetch kept the clone shallow.
    expect(
      (await run(dir, "rev-parse", "--is-shallow-repository")).trim(),
    ).toBe("true");
  });

  test("with no event payload the branch comes from gh", async () => {
    const dir = await ciClone("gh-clone");
    const calls: string[][] = [];
    const gh = ((argv: string[]) => {
      calls.push(argv);
      return {
        stdout: new Response("main\n").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;
    const actors = await defaultBranchTrustedActors(dir, {
      env: {},
      spawnFn: gh,
      log: () => {},
    });
    expect([...actors]).toEqual(["from-default-branch"]);
    expect(calls.map((argv) => argv.slice(0, 3))).toEqual([
      ["gh", "repo", "view"],
    ]);
  });

  test("an unreadable default branch is an empty list and one log line", async () => {
    const dir = await ciClone("unreadable-clone");
    const lines: string[] = [];
    const failingGh = (() => ({
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: Promise.resolve(1),
    })) as unknown as typeof Bun.spawn;
    const actors = await defaultBranchTrustedActors(dir, {
      env: {},
      spawnFn: failingGh,
      log: (line) => lines.push(line),
    });
    expect([...actors]).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("bots only");
  });
});
