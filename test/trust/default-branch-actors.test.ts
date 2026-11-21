// S4 (odd/tasks/marker-trust.md): ci_trusted_actors is read from the default branch, never from the
// checkout, including in a CI-shaped clone: shallow, on the pull request's head, with no origin/HEAD
// and no local ref for the default branch. Reading it never changes the clone (PR #595 R002).

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultBranchTrustedActors,
  readDefaultBranchTrustedActors,
  resetDefaultBranchTrustCache,
} from "../../src/trust/resolve";

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
  await run(dir, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD").catch(
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

// A clone with the default branch's remote ref (a full fetch, no origin/HEAD).
async function fullClone(name: string): Promise<string> {
  const dir = path.join(scratch, name);
  await run(scratch, "clone", "-q", "--branch", "pr", `file://${origin}`, dir);
  await run(dir, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD").catch(
    () => "",
  );
  return dir;
}

// A gh that answers by the first rule whose text appears in the joined argv; anything else fails.
function fakeGh(
  rules: { has: string; stdout?: string; stderr?: string; code?: number }[],
) {
  const calls: string[] = [];
  const spawnFn = ((argv: string[]) => {
    const joined = argv.join(" ");
    calls.push(joined);
    const rule = rules.find((r) => joined.includes(r.has));
    return {
      stdout: new Response(rule?.stdout ?? "").body,
      stderr: new Response(rule?.stderr ?? "").body,
      exited: Promise.resolve(rule === undefined ? 1 : (rule.code ?? 0)),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, calls };
}

const base64 = (text: string) => Buffer.from(text).toString("base64");
const NOT_FOUND = { stderr: "gh: Not Found (HTTP 404)", code: 1 };

beforeEach(() => resetDefaultBranchTrustCache());

describe("defaultBranchTrustedActors", () => {
  test("with the default branch's ref present, it reads that branch with git, not the checkout", async () => {
    const dir = await fullClone("full-clone");
    const gh = fakeGh([]);
    const lines: string[] = [];
    const actors = await defaultBranchTrustedActors(dir, {
      env: { GITHUB_EVENT_PATH: await eventFile("main") },
      spawnFn: gh.spawnFn,
      log: (line) => lines.push(line),
    });
    expect([...actors]).toEqual(["from-default-branch"]);
    expect(lines).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  // R002: reading trust must not change the clone the review then diffs.
  test("a CI-shaped clone without the ref reads the file through the API and leaves the clone as it was", async () => {
    const dir = await ciClone("ci-clone");
    const shallowBefore = await readFile(
      path.join(dir, ".git", "shallow"),
      "utf8",
    );
    const gh = fakeGh([
      {
        has: "contents/.crysk/config.json?ref=main",
        stdout: `${base64(config(["from-default-branch"]))}\n`,
      },
    ]);
    const lines: string[] = [];
    const actors = await defaultBranchTrustedActors(dir, {
      env: { GITHUB_EVENT_PATH: await eventFile("main") },
      spawnFn: gh.spawnFn,
      log: (line) => lines.push(line),
    });
    expect([...actors]).toEqual(["from-default-branch"]);
    expect(lines).toEqual([]);
    expect(await run(dir, "for-each-ref", "refs/remotes/origin/main")).toBe("");
    expect(await readFile(path.join(dir, ".git", "shallow"), "utf8")).toBe(
      shallowBefore,
    );
  });

  test("through the API the legacy path is read when the current one is absent", async () => {
    const dir = await ciClone("legacy-clone");
    const gh = fakeGh([
      { has: "contents/.crysk/config.json", ...NOT_FOUND },
      {
        has: "contents/.prhero/config.json?ref=main",
        stdout: base64(config(["legacy-actor"])),
      },
    ]);
    const actors = await defaultBranchTrustedActors(dir, {
      env: { GITHUB_EVENT_PATH: await eventFile("main") },
      spawnFn: gh.spawnFn,
      log: () => {},
    });
    expect([...actors]).toEqual(["legacy-actor"]);
  });

  test("through the API no config file is an empty list and no log line", async () => {
    const dir = await ciClone("no-file-clone");
    const gh = fakeGh([
      { has: "contents/", ...NOT_FOUND },
      { has: "branches/main", stdout: "main\n" },
    ]);
    const lines: string[] = [];
    const read = await readDefaultBranchTrustedActors(dir, {
      env: { GITHUB_EVENT_PATH: await eventFile("main") },
      spawnFn: gh.spawnFn,
      log: (line) => lines.push(line),
    });
    expect(read).toEqual({ ok: true, actors: new Set() });
    expect(lines).toEqual([]);
  });

  // The contents API also answers 404 for a missing branch or a token that cannot read
  // the repository: that is not "no file", and must not read as a legitimately empty list.
  test("through the API a 404 whose branch cannot be read is a failed read and one log line", async () => {
    const dir = await ciClone("no-branch-clone");
    const gh = fakeGh([
      { has: "contents/", ...NOT_FOUND },
      { has: "branches/main", ...NOT_FOUND },
    ]);
    const lines: string[] = [];
    const read = await readDefaultBranchTrustedActors(dir, {
      env: { GITHUB_EVENT_PATH: await eventFile("main") },
      spawnFn: gh.spawnFn,
      log: (line) => lines.push(line),
    });
    expect(read).toEqual({ ok: false });
    expect(lines).toHaveLength(1);
  });

  test("a 404 read whose branch cannot be read is not kept for the next read", async () => {
    const dir = await ciClone("no-branch-cache-clone");
    const env = { GITHUB_EVENT_PATH: await eventFile("main") };
    await readDefaultBranchTrustedActors(dir, {
      env,
      spawnFn: fakeGh([
        { has: "contents/", ...NOT_FOUND },
        { has: "branches/main", ...NOT_FOUND },
      ]).spawnFn,
      log: () => {},
    });
    const read = await readDefaultBranchTrustedActors(dir, {
      env,
      spawnFn: fakeGh([
        {
          has: "contents/.crysk/config.json?ref=main",
          stdout: base64(config(["from-default-branch"])),
        },
      ]).spawnFn,
      log: () => {},
    });
    expect(read).toEqual({
      ok: true,
      actors: new Set(["from-default-branch"]),
    });
  });

  test("an API read that fails is a failed read, an empty list and one log line", async () => {
    const dir = await ciClone("api-fail-clone");
    const gh = fakeGh([
      { has: "contents/", stderr: "HTTP 502: bad gateway", code: 1 },
    ]);
    const lines: string[] = [];
    const read = await readDefaultBranchTrustedActors(dir, {
      env: { GITHUB_EVENT_PATH: await eventFile("main") },
      spawnFn: gh.spawnFn,
      log: (line) => lines.push(line),
    });
    expect(read).toEqual({ ok: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("bots only");
  });

  test("with no event payload the branch comes from gh", async () => {
    const dir = await fullClone("gh-clone");
    const gh = fakeGh([{ has: "repo view", stdout: "main\n" }]);
    const actors = await defaultBranchTrustedActors(dir, {
      env: {},
      spawnFn: gh.spawnFn,
      log: () => {},
    });
    expect([...actors]).toEqual(["from-default-branch"]);
    expect(gh.calls.every((call) => call.startsWith("gh repo view"))).toBe(
      true,
    );
  });

  test("an unreadable default branch is an empty list and one log line", async () => {
    const dir = await ciClone("unreadable-clone");
    const lines: string[] = [];
    const actors = await defaultBranchTrustedActors(dir, {
      env: {},
      spawnFn: fakeGh([]).spawnFn,
      log: (line) => lines.push(line),
    });
    expect([...actors]).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("bots only");
  });

  test("a successful read is reused in the process; a failed one is read again", async () => {
    const dir = await ciClone("cache-clone");
    const env = { GITHUB_EVENT_PATH: await eventFile("main") };
    const failing = fakeGh([{ has: "contents/", stderr: "HTTP 502", code: 1 }]);
    expect(
      await readDefaultBranchTrustedActors(dir, {
        env,
        spawnFn: failing.spawnFn,
        log: () => {},
      }),
    ).toEqual({ ok: false });
    const working = fakeGh([
      {
        has: "contents/.crysk/config.json",
        stdout: base64(config(["from-default-branch"])),
      },
    ]);
    const lines: string[] = [];
    for (let i = 0; i < 2; i++) {
      expect(
        await readDefaultBranchTrustedActors(dir, {
          env,
          spawnFn: working.spawnFn,
          log: (line) => lines.push(line),
        }),
      ).toEqual({ ok: true, actors: new Set(["from-default-branch"]) });
    }
    expect(working.calls).toHaveLength(1);
    expect(lines).toEqual([]);
  });
});
