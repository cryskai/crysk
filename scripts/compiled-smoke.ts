// The guard for a whole class of defect the offline suite structurally cannot
// see: anything that behaves differently inside a Bun-compiled binary.
//
// `bun test` always runs from source, so `import.meta.dir` always names a real
// directory and `detectAssetMode()` always answers "dev". Every code path that
// keys off the compiled runtime is therefore unreachable from the suite. That
// is not a coverage gap to backfill with more unit tests — it is a different
// runtime, and the only honest way to test it is to build the artifact and run
// it. Release v1.0.0 shipped a binary whose `review` command failed for 100% of
// users, past 2466 green tests and a green `doctor`, because nothing here
// executed the thing that was published.
//
// What it proves, concretely: the binary boots, resolves its BUNDLED prompt set
// (which lives at hashed paths inside Bun's virtual filesystem, not in any
// directory), reads those prompts, fingerprints them, and prints a plan — with
// no `/$bunfs` path escaping into user-facing output.
//
// Deliberately free: `--dry-run` spawns no step, so this needs no
// authentication, no network and no money. It costs a compile and about a
// second. It does need a binary NAMED `claude` on PATH, because route
// admission discovers one before the dry run returns — a stub is created below
// and never executed.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

// The marker for the bug class. Bun compiles embedded assets to paths under
// this root, and it is not a real directory: any of these reaching the terminal
// means some code path handed a virtual path to something that wanted a file.
const VIRTUAL_FS_MARKER = "/$bunfs";

interface Run {
  code: number;
  output: string; // stdout and stderr together — a leaked path is a defect on either
}

function run(
  cmd: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Run {
  const result = spawnSync(cmd[0] as string, cmd.slice(1), {
    cwd,
    encoding: "utf-8",
    // Reviews shell out to git, so PATH must survive.
    env,
  });
  if (result.error) {
    return {
      code: 1,
      output: result.error.message,
    };
  }
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// The read-only command surface, swept DIFFERENTIALLY: each one is run twice,
// once through the compiled binary and once through `bun run src/cli.ts`, with
// the same cwd and the same environment, and the two exit codes must agree.
//
// Asserting a table of expected exit codes instead would be worse in both
// directions: several of these legitimately exit non-zero depending on whether
// the repo has an origin remote and what the store already holds, so the table
// would be brittle, and it would encode MY belief about what each command does
// rather than the property that actually matters here — that compiling the
// engine does not change its behaviour. Source is the reference because source
// is what the offline suite proves.
//
// Excluded deliberately: anything needing `gh`, network or auth (`review --pr`,
// `post`, `triage`, `reverts`, `corpus`, `upgrade`), anything interactive
// (`menu`, `setup`), anything that starts a server (`mcp`), and the
// `install`/`uninstall` pairs, which register launchd agents — a smoke must not
// leave a daemon behind. That last exclusion is a real coverage gap and the
// launchd entry path is guarded by unit tests instead.
const SWEPT_COMMANDS: readonly string[][] = [
  ["--help"],
  ["doctor"],
  ["config"],
  ["activity"],
  ["usage"],
  ["watch", "status"],
  ["gc", "status"],
];

function compileBinary(): string {
  const out = path.join(
    mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-bin-")),
    "pr-hero",
  );
  // The same flags release.yml:48 publishes with, minus --target (host arch is
  // what we can execute) and --minify (irrelevant to asset resolution, and it
  // makes a failure stack unreadable). A smoke built with different flags would
  // be testing a different artifact.
  const built = run(
    [
      "bun",
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--define",
      '__PRHERO_VERSION__="0.0.0-smoke"',
      "src/cli.ts",
      "--outfile",
      out,
    ],
    REPO_ROOT,
  );
  if (built.code !== 0) {
    console.error(built.output);
    throw new Error(`compile failed (exit ${built.code})`);
  }
  return out;
}

// A throwaway repository with exactly one commit of history to review. Small on
// purpose: the size gate's verdict is irrelevant here (a dry run exits 0 either
// way) and a large tree would only make the smoke slower.
function makeFixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-repo-"));
  const git = (...args: string[]) => {
    const r = run(["git", ...args], dir);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.output}`);
  };
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "smoke@example.invalid");
  git("config", "user.name", "smoke");
  // Identity must not be inherited from the developer's global gitconfig, and
  // commit signing must be off: a smoke that prompts for a passphrase hangs CI.
  git("config", "commit.gpgsign", "false");
  // pr-hero keys the global home by origin URL and several read-only commands
  // refuse without one. The URL is never contacted — nothing in the swept
  // surface talks to a network — it only has to exist and parse.
  git(
    "remote",
    "add",
    "origin",
    "https://github.com/example/pr-hero-smoke.git",
  );

  // A real repository has been through `pr-hero init`, and the engine refuses
  // to review without a non-empty gotchas file on purpose: an empty one makes
  // the whole review a zero-cost no-op that LOOKS like a clean result. Writing
  // one here reproduces an initialised repo rather than weakening the smoke —
  // without it the run dies on that guard and never reaches the prompt-set
  // resolution this exists to exercise.
  mkdirSync(path.join(dir, ".prhero"), { recursive: true });
  writeFileSync(
    path.join(dir, ".prhero", "gotchas.md"),
    "# Repo gotchas\n\n- smoke: this fixture exists only to boot the engine.\n",
  );

  writeFileSync(path.join(dir, "seed.ts"), "export const seed = 1;\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");

  writeFileSync(
    path.join(dir, "seed.ts"),
    "export const seed = 1;\nexport const added = 2;\n",
  );
  git("add", "-A");
  git("commit", "--quiet", "-m", "change");
  return dir;
}

function check(name: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}`);
  if (!ok) console.log(detail.replace(/^/gm, "        "));
  return ok;
}

// ---------------------------------------------------------------------------
// The compiled-mode OpenCode SDK load path
// ---------------------------------------------------------------------------
//
// Everything above proves the binary resolves ITS OWN bundled assets. This
// proves a DIFFERENT thing a compiled binary does: resolve an OPTIONAL
// runtime dependency (`@opencode-ai/sdk`) that lives OUTSIDE the binary,
// under ~/.prhero/node_modules. The full `@opencode-ai/sdk/v2` index
// re-exports the SDK's own server, which imports `cross-spawn`, whose nested
// `require("which")` Bun's --compile runtime does not resolve for a package
// living outside the binary — a real defect this file did not
// catch before it shipped (route admission reported "not installed" for an
// SDK that plainly was).
//
// Still free, on purpose: `review --dry-run` reaches the SDK load during
// route admission — see the "OpenCode SDK pre-confirm" in
// prepareProductionAdmissionContext (src/production-runtime.ts) — BEFORE the
// dry-run's own early exit, so this needs no auth, no OpenCode credentials
// and no network, same contract as the sweep above. It does need a stub
// `opencode` executable (mirroring the `claude` stub): route admission
// observes the binary's `--version` before it ever imports the SDK, and
// never executes it past that, so the stub never has to behave like a real
// server.
//
// Provider "openai" (OPENCODE_OAUTH_PROVIDER, src/security/credential-broker.ts)
// is deliberate, not incidental: it resolves an OAuth credential kind, which
// keeps prepareProductionAdmissionContext OFF the free-model-probe branch
// entirely. Any other provider resolves a metered kind, which would ALSO
// spawn the opencode binary asking whether the model is free — a second stub
// behaviour this check does not need to grow.
const OPENCODE_SDK_PACKAGE_DIR = path.join(
  REPO_ROOT,
  "node_modules",
  "@opencode-ai",
  "sdk",
);

function checkOpenCodeSdkLoad(
  binary: string,
  repo: string,
  claudeStubDir: string,
): boolean {
  // @opencode-ai/sdk is an OPTIONAL dependency (package.json
  // optionalDependencies), and `bun install --frozen-lockfile` — the only
  // install command either ci.yml or release.yml runs, with no
  // `--no-optional` anywhere — installs optional dependencies by default. So
  // both workflows that run this file always have it, and a silent skip here
  // would be exactly the "gate that always finds a way to pass" pattern that
  // let v1.0.0 ship a broken `review` past a fully green run: fail loudly
  // instead.
  if (!existsSync(OPENCODE_SDK_PACKAGE_DIR)) {
    return check(
      "opencode SDK load: repo's own node_modules has @opencode-ai/sdk",
      false,
      `not found at ${OPENCODE_SDK_PACKAGE_DIR} — is it still an ` +
        "optionalDependency, and did `bun install` run without --no-optional?",
    );
  }

  const home = mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-sdkhome-"));
  const outDir = mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-sdkout-"));
  const opencodeStubDir = mkdtempSync(
    path.join(os.tmpdir(), "prhero-smoke-opencode-stub-"),
  );
  let passed = true;
  try {
    // ONLY the SDK package, never its dependency tree: cross-spawn and which
    // live as SIBLINGS under the repo's root node_modules, not nested inside
    // node_modules/@opencode-ai/sdk itself (a flat node_modules layout has no
    // node_modules/@opencode-ai/sdk/node_modules at all), so copying this one
    // directory excludes them structurally. That absence is exactly what
    // makes the full /v2 index unloadable here on unfixed dev, and it is what
    // this check discriminates on: without it, the full index would resolve
    // fine and the check would prove nothing.
    const sdkDestDir = path.join(
      home,
      ".prhero",
      "node_modules",
      "@opencode-ai",
      "sdk",
    );
    mkdirSync(path.dirname(sdkDestDir), { recursive: true });
    cpSync(OPENCODE_SDK_PACKAGE_DIR, sdkDestDir, { recursive: true });

    // Person-layer config: `routing` is a "person" direction field
    // (CONFIG_DIRECTION, src/review/preflight.ts) — the repo-level
    // .prhero/config.json rejects it outright, so this has to live under the
    // fake HOME, exactly where a real operator's global routing config would.
    mkdirSync(path.join(home, ".prhero"), { recursive: true });
    writeFileSync(
      path.join(home, ".prhero", "config.json"),
      JSON.stringify({
        routing: {
          default: {
            backend: "opencode",
            provider: "openai",
            gateway: "configured",
            modelSnapshot: "gpt-4o",
          },
        },
      }),
    );

    // Route admission observes this binary's `--version` before it ever
    // imports the SDK (the OpenCode server/SDK identity pairing) — see the
    // header comment above for why it is never executed past that.
    const opencodeStub = path.join(opencodeStubDir, "opencode");
    writeFileSync(opencodeStub, '#!/bin/sh\necho "1.18.30"\nexit 0\n');
    chmodSync(opencodeStub, 0o755);

    const env = {
      ...process.env,
      HOME: home,
      PATH:
        `${claudeStubDir}${path.delimiter}${opencodeStubDir}` +
        `${path.delimiter}${process.env.PATH ?? ""}`,
    };

    const result = run(
      [
        binary,
        "review",
        "--base",
        "HEAD~1",
        "--dry-run",
        "--yes",
        "--out",
        outDir,
      ],
      repo,
      env,
    );
    passed =
      check(
        "opencode SDK load: review --dry-run through opencode routing exits 0",
        result.code === 0,
        `exit ${result.code}\n${result.output}`,
      ) && passed;
    // The exact collapse this whole file exists to catch: an import failure
    // of an INSTALLED, version-matched package reported as "not installed",
    // and the real cause (a resolution error) thrown away entirely.
    passed =
      check(
        "opencode SDK load: does not report the SDK as not installed",
        !result.output.includes("not installed"),
        result.output,
      ) && passed;
    passed =
      check(
        "opencode SDK load: no unresolved import failure surfaced",
        !result.output.includes("Cannot find package"),
        result.output,
      ) && passed;
    // The positive proof, not just the absence of the two strings above:
    // this line only prints after route admission (and inside it, the SDK
    // pre-confirm) succeeded — reaching the dry run's own early exit.
    passed =
      check(
        "opencode SDK load: admission succeeded and reached the dry-run exit",
        result.output.includes(
          "dry run: nothing was spawned and nothing was spent.",
        ),
        result.output,
      ) && passed;
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    rmSync(opencodeStubDir, { recursive: true, force: true });
  }
  return passed;
}

async function main(): Promise<number> {
  // Release CI already built the real artifact for its target; re-compiling it
  // here would smoke a DIFFERENT binary from the one it uploads.
  const rawProvided = process.argv[2];
  const provided =
    rawProvided !== undefined && rawProvided.trim().length > 0
      ? path.resolve(rawProvided)
      : undefined;
  const binary = provided ?? compileBinary();
  console.log(
    `compiled-smoke: ${provided ? "using provided binary" : "compiled"} ${binary}`,
  );

  const repo = makeFixtureRepo();
  const outDir = mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-out-"));
  // A throwaway HOME so the sweep cannot read or write the real ~/.prhero: the
  // store, watch.json and the worktree registry all live there, and a smoke
  // that mutates a developer's state — or reads it and passes only because of
  // what it found — is not a smoke. --out is kept as well, so the run dir lands
  // beside the rest of the temp state rather than inside the fake home.
  const home = mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-home-"));

  // A stub `claude` at the FRONT of PATH. Route admission discovers the binary
  // by name and hashes its bytes for run identity — it does not validate that
  // hash against anything — so a stub satisfies it, and `--dry-run` returns
  // before any step is spawned, so the stub is never executed.
  //
  // Why this is not cheating: what this file exists to prove is that the
  // COMPILED binary can resolve its own embedded assets. Provider admission is
  // a different gate with its own tests, and on a CI runner there is no
  // `claude` to find — so without the stub the run dies before it ever reaches
  // the prompt set, and the smoke reports a missing dependency instead of the
  // thing it was built to catch. Prepended rather than appended so the result
  // is the same on a developer's machine, where a real `claude` is on PATH.
  const stubDir = mkdtempSync(path.join(os.tmpdir(), "prhero-smoke-bin-stub-"));
  const stub = path.join(stubDir, "claude");
  writeFileSync(stub, "#!/bin/sh\nexit 0\n");
  chmodSync(stub, 0o755);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  let passed = true;

  const review = run(
    [
      binary,
      "review",
      "--base",
      "HEAD~1",
      "--dry-run",
      "--yes",
      "--out",
      outDir,
    ],
    repo,
    env,
  );
  passed =
    check(
      "review --dry-run exits 0",
      review.code === 0,
      `exit ${review.code}\n${review.output}`,
    ) && passed;
  passed =
    check(
      "review --dry-run leaks no virtual-filesystem path",
      !review.output.includes(VIRTUAL_FS_MARKER),
      review.output,
    ) && passed;
  // The plan card proves the prompt set was not merely resolved but READ: the
  // agent rows are built from parsed prompt bodies.
  passed =
    check(
      "review --dry-run resolved and read the bundled prompt set",
      review.output.includes("AGENTS") && review.output.includes("refuter"),
      review.output,
    ) && passed;

  const cliEntry = path.join(REPO_ROOT, "src", "cli.ts");
  for (const argv of SWEPT_COMMANDS) {
    const label = argv.join(" ");
    const built = run([binary, ...argv], repo, env);
    passed =
      check(
        `${label} leaks no virtual-filesystem path`,
        !built.output.includes(VIRTUAL_FS_MARKER),
        built.output,
      ) && passed;

    const fromSource = run(["bun", "run", cliEntry, ...argv], repo, env);
    passed =
      check(
        `${label} behaves the same compiled as from source`,
        built.code === fromSource.code,
        `compiled exit ${built.code}, source exit ${fromSource.code}\n` +
          `--- compiled ---\n${built.output}\n--- source ---\n${fromSource.output}`,
      ) && passed;
  }

  passed = checkOpenCodeSdkLoad(binary, repo, stubDir) && passed;

  rmSync(repo, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
  if (provided === undefined) {
    rmSync(path.dirname(binary), { recursive: true, force: true });
  }

  console.log(passed ? "compiled-smoke: PASS" : "compiled-smoke: FAIL");
  return passed ? 0 : 1;
}

process.exit(await main());
