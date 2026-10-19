import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateCiWorkflowTemplate, OWN_CI_WORKFLOW_OPTIONS } from "#ci/setup";
import { ENGINE_VERSION } from "../src/index";

describe("Packaging & distribution configuration", () => {
  const rootDir = path.resolve(__dirname, "..");

  test("root LICENSE file exists and is Apache-2.0", () => {
    const licensePath = path.join(rootDir, "LICENSE");
    expect(existsSync(licensePath)).toBe(true);
    const content = readFileSync(licensePath, "utf-8");
    expect(content).toContain("Apache License");
    expect(content).toContain("Version 2.0");
  });

  test("package.json declares Apache-2.0 license and correct distribution metadata", () => {
    const pkgPath = path.join(rootDir, "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);

    expect(pkg.private).toBe(false);
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.engines).toBeDefined();
    expect(pkg.engines.bun).toBeDefined();
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin["pr-hero"]).toBeDefined();
    expect(pkg.files).toBeDefined();
    expect(pkg.files).toContain("prompts");
    expect(pkg.files).toContain("skills/pr-hero-triage");
    expect(pkg.files).toContain("skills/pr-hero-ci-setup");
    expect(pkg.files).toContain("dist");
    expect(pkg.files).not.toContain("docs");
    expect(pkg.files).not.toContain("scripts");
    expect(pkg.files).not.toContain("fixtures");
    expect(pkg.files).not.toContain("test");
    expect(pkg.files).not.toContain("openspec");
    expect(pkg.files).not.toContain("skills/martian-bench");
    expect(pkg.scripts.build).toBeDefined();
  });

  // release.yml only compares the tag against package.json, so this is what
  // keeps the exported constant from drifting on the next bump.
  test("ENGINE_VERSION matches package.json version", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(rootDir, "package.json"), "utf-8"),
    );
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  // An npm install ships only `files`. A static import from src/ that leaves src/ for a
  // root directory the list omits crashes the installed CLI at startup, which is how
  // config/models/anthropic.json went missing from the package.
  test("every root path a src/ module imports is in package.json files", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(rootDir, "package.json"), "utf-8"),
    );
    const files: string[] = pkg.files;
    const srcDir = path.join(rootDir, "src");
    const missing: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(full, "utf-8");
          for (const match of text.matchAll(/from "(\.\.?\/[^"]+)"/g)) {
            const target = path.relative(
              rootDir,
              path.resolve(dir, match[1] ?? ""),
            );
            if (target.startsWith("src/") || target.startsWith("..")) continue;
            const covered = files.some(
              (f) => target === f || target.startsWith(`${f}/`),
            );
            if (!covered)
              missing.push(`${path.relative(rootDir, full)} -> ${target}`);
          }
        }
      }
    };
    walk(srcDir);
    expect(missing).toEqual([]);
  });

  test("bin/pr-hero.js exists and is an executable wrapper", () => {
    const binPath = path.join(rootDir, "bin", "pr-hero.js");
    expect(existsSync(binPath)).toBe(true);
    const content = readFileSync(binPath, "utf-8");
    // A Node shebang: npx runs it on a machine with no Bun, and it starts Bun itself.
    expect(content.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(content).toContain("cli.ts");
  });

  // Regression guard: bin/pr-hero.js is reached via `import`, where
  // `import.meta.main` is always false inside the imported cli.ts module —
  // only the directly executed entry file gets `true`. A version of
  // bin/pr-hero.js that relies on cli.ts's own `if (import.meta.main)` guard
  // (instead of explicitly calling an exported runCli()/main()) silently
  // produces zero output on both streams and exits 0 for every invocation —
  // the npm-installed `pr-hero` command would do nothing at all. This spawns
  // the real bin/pr-hero.js as a local subprocess of THIS repo's own CLI
  // (no network access, no agent spawn — `--help` is fully offline) and
  // asserts it actually ran.
  test("bin/pr-hero.js, spawned directly, runs the real CLI instead of silently no-op'ing (import.meta.main-under-import regression)", async () => {
    const proc = Bun.spawn(["bun", "bin/pr-hero.js", "--help"], {
      cwd: rootDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      console.error(stdout, stderr);
    }
    // log() writes to stderr unconditionally (src/ui/primitives.ts) — assert there, not stdout.
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).toContain("pr-hero");
    expect(stderr).toContain("Usage:");
    expect(exitCode).toBe(0);
  });

  test("install.sh exists, contains OS detection, checksum verification and PATH setup", () => {
    const scriptPath = path.join(rootDir, "install.sh");
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("darwin");
    expect(content).toContain("linux");
    expect(content).toContain("SHA256SUMS");
    expect(content).toContain(".prhero/bin");
  });

  test("release workflow exists and defines matrix and artifacts", () => {
    const workflowPath = path.join(
      rootDir,
      ".github",
      "workflows",
      "release.yml",
    );
    expect(existsSync(workflowPath)).toBe(true);
    const content = readFileSync(workflowPath, "utf-8");
    expect(content).toContain("darwin-arm64");
    expect(content).toContain("darwin-x64");
    expect(content).toContain("linux-x64");
    expect(content).toContain("linux-arm64");
    expect(content).toContain("SHA256SUMS");
    expect(content).toContain("--provenance");
    expect(content).toContain("git tag -fa");
    expect(content).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
  });

  // Until this workflow existed, .github/workflows/ held only release.yml:
  // nothing ran this repo's own suite on a pull request, so every merge to
  // main was verified by whoever happened to run the gates by hand. These
  // assertions exist so a future edit cannot quietly drop one of the three.
  test("ci workflow runs all three gates on pull requests", () => {
    const workflowPath = path.join(rootDir, ".github", "workflows", "ci.yml");
    expect(existsSync(workflowPath)).toBe(true);
    const content = readFileSync(workflowPath, "utf-8");
    expect(content).toContain("pull_request");
    expect(content).toContain("bun install --frozen-lockfile");
    expect(content).toContain("bun test");
    expect(content).toContain("bun run typecheck");
  });

  // The scar this assertion guards: `bunx biome` resolves to an unrelated
  // abandoned package that ignores the flags, checks nothing, and exits 0.
  // docs/research/scout-design.md:344 records the CI gate sitting green for 18 days on
  // exactly that while real Biome found 10 errors over the same commit. A
  // linter that always passes is worse than no linter, because it is trusted.
  test("ci workflow invokes the real biome binary, never the bunx shim", () => {
    const workflowPath = path.join(rootDir, ".github", "workflows", "ci.yml");
    const content = readFileSync(workflowPath, "utf-8");
    expect(content).toContain("./node_modules/.bin/biome check src test");

    // Comments are stripped before the negative assertion on purpose: the
    // workflow SHOULD name the antipattern to explain why the long path is
    // there, and a whole-file substring check would make documenting the
    // hazard indistinguishable from committing it.
    const commands = content
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(commands).not.toContain("bunx biome");
  });

  // The scar: every gate above this one runs from SOURCE, where
  // `import.meta.dir` names a real directory and the engine reports asset mode
  // "dev". The published artifact is a Bun-compiled binary whose assets live at
  // hashed paths inside a virtual filesystem, and no amount of `bun test` can
  // reach that runtime. v1.0.0 shipped a binary whose `review` command failed
  // for 100% of users — past 2466 green tests, a green lint, and a `doctor`
  // that reported the prompt set healthy. release.yml built that binary and
  // uploaded it without ever executing it once.
  //
  // These assertions exist so a future edit cannot quietly drop the one step
  // that runs the thing users actually download.
  test("both workflows run the compiled binary before trusting it", () => {
    const ci = readFileSync(
      path.join(rootDir, ".github", "workflows", "ci.yml"),
      "utf-8",
    );
    expect(ci).toContain("bun run scripts/compiled-smoke.ts");

    const release = readFileSync(
      path.join(rootDir, ".github", "workflows", "release.yml"),
      "utf-8",
    );
    // Passing the built path is the whole point: a smoke that compiled its own
    // binary would prove nothing about the artifact being uploaded. Matched as
    // a regex rather than a literal because the workflow's `${{ ... }}` reads
    // to a linter as a template placeholder in the wrong kind of quotes.
    expect(release).toMatch(
      /bun run scripts\/compiled-smoke\.ts \.\/pr-hero-\$\{\{ matrix\.target \}\}/,
    );

    // Ordering is load-bearing, not cosmetic. A binary that cannot resolve its
    // own bundled assets must fail the job BEFORE it reaches a release page.
    const smokeAt = release.indexOf("scripts/compiled-smoke.ts");
    const uploadAt = release.indexOf("Upload binary artifact");
    expect(smokeAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(-1);
    expect(smokeAt).toBeLessThan(uploadAt);
  });

  // The above checks that the smoke step EXISTS and comes first. It cannot see
  // whether the step runs for every matrix leg — and the first version of this
  // workflow shipped exactly that hole: darwin-x64 was gated behind
  // `if: matrix.native` while `Upload binary artifact` had no condition at all,
  // so one of four published binaries would still have reached users having
  // never been executed once. A guard with a documented exemption is a guard
  // that erodes: nothing failed, warned, or even grepped if a future target
  // took the same exit "just for convenience".
  //
  // So this parses the workflow instead of reading it. The invariant is
  // structural: every leg that uploads must also smoke.
  test("every release target that is uploaded is also smoked", () => {
    const release = Bun.YAML.parse(
      readFileSync(path.join(rootDir, ".github", "workflows", "release.yml"), {
        encoding: "utf-8",
      }),
    ) as {
      jobs: Record<
        string,
        {
          strategy?: { matrix?: { include?: Record<string, string>[] } };
          steps: Record<string, unknown>[];
        }
      >;
    };

    const job = release.jobs["build-binaries"];
    expect(job).toBeDefined();
    const legs = job?.strategy?.matrix?.include ?? [];
    expect(legs.length).toBeGreaterThan(0);

    const step = (needle: string) =>
      job?.steps.find((s) => String(s.name ?? "").includes(needle));
    const smoke = step("Compiled-binary smoke");
    const upload = step("Upload binary artifact");
    expect(smoke).toBeDefined();
    expect(upload).toBeDefined();

    // Neither may carry a condition. An unconditional upload paired with a
    // conditional smoke is precisely the shape that lets an unexecuted binary
    // ship, and the asymmetry is invisible in a plain-text scan.
    expect(smoke?.if).toBeUndefined();
    expect(upload?.if).toBeUndefined();

    // Every leg must name a runner of its own architecture, or the smoke on
    // that leg cannot execute what it just built. Checked by shape rather than
    // by an allowlist of labels so a runner-image migration does not need a
    // test edit — only a cross-architecture pairing does.
    for (const leg of legs) {
      const wantsArm = leg.target?.endsWith("-arm64");
      const runnerIsArm = /-arm\b|macos-latest|macos-1[4-9]$|macos-2\d$/.test(
        leg.os ?? "",
      );
      expect({
        target: leg.target,
        os: leg.os,
        ok: wantsArm === runnerIsArm,
      }).toEqual({ target: leg.target, os: leg.os, ok: true });
    }
  });

  // The other half of "nothing ships". The smoke stops a BROKEN binary from
  // being published; this stops a WORKING one from being cancelled. Without an
  // explicit `fail-fast: false`, one leg failing to acquire its runner — a
  // retired label, a rename, a capacity blip — cancels the other three
  // in-flight legs, and a release that was fine on three architectures
  // produces nothing at all.
  test("one bad release leg cannot cancel the others", () => {
    const release = Bun.YAML.parse(
      readFileSync(path.join(rootDir, ".github", "workflows", "release.yml"), {
        encoding: "utf-8",
      }),
    ) as {
      jobs: Record<string, { strategy?: Record<string, unknown> }>;
    };
    expect(release.jobs["build-binaries"]?.strategy?.["fail-fast"]).toBe(false);
  });

  // Drift guard. The runbook described the release matrix as `macos-13` long
  // after that image was retired, and nothing noticed — the finding that
  // exposed it cited the stale line as evidence that a runner label had no
  // corroboration anywhere else in the repo. A document that describes CI is
  // only useful while it is true.
  test("the release runbook names the runners the workflow actually uses", () => {
    const release = Bun.YAML.parse(
      readFileSync(path.join(rootDir, ".github", "workflows", "release.yml"), {
        encoding: "utf-8",
      }),
    ) as {
      jobs: Record<
        string,
        { strategy?: { matrix?: { include?: Record<string, string>[] } } }
      >;
    };
    const runbook = readFileSync(
      path.join(rootDir, "docs", "release-runbook.md"),
      "utf-8",
    );
    const legs =
      release.jobs["build-binaries"]?.strategy?.matrix?.include ?? [];
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      expect({
        os: leg.os,
        documented: runbook.includes(leg.os ?? ""),
      }).toEqual({ os: leg.os, documented: true });
    }
  });

  test("the compiled smoke exists and asserts on the virtual-filesystem root", () => {
    const smokePath = path.join(rootDir, "scripts", "compiled-smoke.ts");
    expect(existsSync(smokePath)).toBe(true);
    const smoke = readFileSync(smokePath, "utf-8");
    // `/$bunfs` is the marker for the entire defect class. A smoke that stopped
    // checking for it would still pass while a leaked virtual path reached the
    // terminal again.
    expect(smoke).toContain("/$bunfs");
    expect(smoke).toContain("--dry-run");
  });

  // PREVENTION, where the smoke above is only detection. Every defect in #154
  // was the same line of code written in four places: a filesystem path derived
  // from the module's own location. That is correct in dev and npm and
  // meaningless in a compiled binary, where it resolves to /$bunfs/root — a
  // virtual root that `existsSync` denies, `Bun.Glob` throws on, and no
  // subprocess can read.
  //
  // src/assets.ts already declares itself "Authority for packaged-asset
  // resolution and self-invocation. Single authority across dev, npm, and
  // compiled runtimes." Until this test, that was a comment enforcing nothing,
  // and four other files quietly did the same work incorrectly. This makes the
  // header true.
  //
  // Scoped to the path-deriving members only. `import.meta.main` is the entry
  // guard and is perfectly safe compiled — banning it would be cargo cult.
  test("only src/assets.ts derives filesystem paths from import.meta", () => {
    const offenders: Record<string, number> = {};
    for (const rel of [
      ...new Bun.Glob("src/**/*.ts").scanSync(rootDir),
    ].sort()) {
      // Comments are stripped for the same reason the `bunx biome` scar above
      // strips them: this file's WHY comments SHOULD name the antipattern to
      // explain the rule, and a raw substring scan would make documenting the
      // hazard indistinguishable from committing it.
      const code = readFileSync(path.join(rootDir, rel), "utf-8")
        .split("\n")
        .filter((line) => {
          const t = line.trimStart();
          return (
            !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
          );
        })
        .join("\n");
      const hits = code.match(/import\.meta\.(dir|url|path)\b/g);
      if (hits) offenders[rel.replaceAll("\\", "/")] = hits.length;
    }

    // `engineIdentity`'s `git rev-parse` for the engine's own revision used
    // to be src/cli.ts's one pinned exception — it sat AFTER an early return
    // for compiled mode and was therefore unreachable in the runtime where
    // it would be wrong. During cli-decomp S3 engineIdentity moved to
    // src/git/identity.ts, but the path it reads from is derived by
    // engineCheckoutRoot() in src/assets.ts, so the exception is gone and the
    // test's own name is now literally true: only src/assets.ts derives
    // filesystem paths from import.meta.
    //
    // This assertion earned its keep in that same slice. A first version moved
    // engineIdentity to src/git/ with its `path.join(import.meta.dir, "..")`
    // intact, and import.meta.dir is the directory of the EVALUATING module: from
    // src/ that expression is the checkout, from src/git/ it is src/ itself. The
    // move shifted the path by one level, compiled, typechecked, and passed every
    // behavioural test — because git discovers the repository upward and returned
    // the same HEAD from src/. This test was the only thing that went red. It
    // guards the rule, not a symptom, which is exactly why it caught a relocation
    // no behavioural check could see.
    expect(offenders).toEqual({
      "src/assets.ts": expect.any(Number),
    });
  });

  describe("action.yml — the official Composite Action (Pillar 3 task 5.1)", () => {
    const actionPath = path.join(rootDir, "action.yml");

    function parsedAction(): {
      inputs: Record<string, { default?: string; required: boolean }>;
      outputs: Record<string, { description: string; value: string }>;
      runs: { using: string; steps: Array<Record<string, unknown>> };
    } {
      return Bun.YAML.parse(readFileSync(actionPath, "utf-8")) as never;
    }

    test("exists and is syntactically valid YAML", () => {
      expect(existsSync(actionPath)).toBe(true);
      const parsed = Bun.YAML.parse(readFileSync(actionPath, "utf-8"));
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    });

    // S4: the gate is the action's default, and the run step hands it to the
    // CLI as --ci-mode. Asserted on the text of the run script: the
    // expression and the flag are one line each, and a wrong env name or a
    // dropped `if` would otherwise pass every other check here.
    test("declares a mode input that defaults to gate and hands it to the CLI", () => {
      expect(parsedAction().inputs.mode?.default).toBe("gate");
      const source = readFileSync(actionPath, "utf-8");
      expect(source).toContain(`MODE_INPUT: \${{ inputs.mode }}`);
      expect(source).toContain(
        'if [ -n "$MODE_INPUT" ]; then set -- "$@" --ci-mode "$MODE_INPUT"; fi',
      );
    });

    test("declares the four-member status enum spec 1.1 actually emits", () => {
      // Not five: skipped-clean was never wired (a clean review already
      // reports status=reviewed, findings_count=0) and was dropped from
      // spec.md 1.1 rather than left as a documented lie. `error` IS now
      // wired, via reportFatalCiError (src/ci/reporter.ts).
      const action = parsedAction();
      expect(action.outputs.status.description).toContain(
        "reviewed, skipped-size, skipped-budget, or error",
      );
    });

    test("every `with:` key the generated workflow emits is a declared input", () => {
      // The drift this guards is not hypothetical: the template's `with:`
      // block told readers to set EITHER ANTHROPIC_API_KEY or
      // CLAUDE_CODE_OAUTH_TOKEN and wired only the first, so the documented
      // OAuth path sent an empty credential and never authenticated — while
      // `pr-hero doctor`, which accepts either variable, called the setup
      // healthy. A `with:` key with no matching input is silently ignored by
      // GitHub Actions; nothing else in this repo would notice.
      const declared = Object.keys(parsedAction().inputs);
      const workflow = Bun.YAML.parse(
        generateCiWorkflowTemplate(OWN_CI_WORKFLOW_OPTIONS),
      ) as {
        jobs: {
          review: {
            steps: Array<{ uses?: string; with?: Record<string, string> }>;
          };
        };
      };
      // Select the pr-hero step BY its `uses`, rather than subtracting the
      // third-party keys we happen to know about today. The subtraction form
      // of this test (an exclusion list holding just `fetch-depth`) went red
      // the moment a second third-party step — actions/upload-artifact —
      // joined the job, though nothing about pr-hero's own inputs had
      // changed. Only the keys handed to OUR action can drift from
      // action.yml, so those are the only ones this should look at.
      const ours = workflow.jobs.review.steps.flatMap((step) =>
        step.uses === "./" && step.with !== undefined
          ? Object.keys(step.with)
          : [],
      );
      expect(ours.length).toBeGreaterThan(0);
      for (const key of ours) {
        expect(declared).toContain(key);
      }
      // And both credential paths are actually wired, not just declared.
      expect(ours).toContain("anthropic-api-key");
      expect(ours).toContain("claude-token");
    });

    test("run step invokes bin/pr-hero.js — the entrypoint verified to actually run", () => {
      const action = parsedAction();
      const runStep = action.runs.steps.find(
        (step) => step.id === "run-pr-hero",
      ) as { run?: string } | undefined;
      expect(runStep?.run).toContain("bin/pr-hero.js");
    });

    test("passes --ci unconditionally (--budget-usd/--step-summary require it at parse time)", () => {
      const action = parsedAction();
      const runStep = action.runs.steps.find(
        (step) => step.id === "run-pr-hero",
      ) as { run?: string } | undefined;
      expect(runStep?.run).toContain("--ci");
      expect(runStep?.run).toContain("--yes");
    });

    type ActionStep = {
      id?: string;
      name?: string;
      if?: string;
      uses?: string;
      env?: Record<string, string>;
      with?: Record<string, string | number | boolean>;
      run?: string;
      shell?: string;
    };
    const steps = () => parsedAction().runs.steps as ActionStep[];
    const triggerStep = () => steps().find((step) => step.id === "trigger");

    // The `${{ }}` forms this action's `env:` bindings use, evaluated the way
    // the runner would. Anything else throws, so a new expression shape fails
    // here loudly instead of reaching a script as a literal string.
    interface ActionContext {
      inputs: Record<string, string>;
      github: Record<string, string>;
      trigger: Record<string, string>;
      runner: Record<string, string>;
    }
    function resolveEnv(
      env: Record<string, string>,
      ctx: ActionContext,
    ): Record<string, string> {
      const action = parsedAction();
      const input = (name: string): string =>
        ctx.inputs[name] ?? action.inputs[name]?.default ?? "";
      const resolveExpr = (expr: string): string => {
        const ref = /^inputs\.([\w-]+)$/.exec(expr)?.[1];
        if (ref !== undefined) return input(ref);
        const presence = /^inputs\.([\w-]+) != ''$/.exec(expr)?.[1];
        if (presence !== undefined) return String(input(presence) !== "");
        const contains = /^contains\(inputs\.([\w-]+), '([^']*)'\)$/.exec(expr);
        if (contains !== null) {
          return String(input(contains[1] ?? "").includes(contains[2] ?? ""));
        }
        const github = /^github\.([\w.]+)$/.exec(expr)?.[1];
        if (github !== undefined) return ctx.github[github] ?? "";
        const runner = /^runner\.([\w.]+)$/.exec(expr)?.[1];
        if (runner !== undefined) return ctx.runner[runner] ?? "";
        const output = /^steps\.trigger\.outputs\.(\w+)$/.exec(expr)?.[1];
        if (output !== undefined) return ctx.trigger[output] ?? "";
        throw new Error(`unsupported expression in an action.yml env: ${expr}`);
      };
      // A value may hold one expression or several, mixed with literal text
      // (`${{ runner.temp }}/pr-hero-outcome`).
      const resolve = (value: string): string =>
        value.replace(
          /\$\{\{\s*(.+?)\s*\}\}/g,
          (_match: string, expr: string) => resolveExpr(expr),
        );
      return Object.fromEntries(
        Object.entries(env).map(([name, value]) => [name, resolve(value)]),
      );
    }

    type FakeGh = (args: readonly string[]) => {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
    const offlineGh: FakeGh = () => ({
      exitCode: 1,
      stdout: "",
      stderr: "offline",
    });

    // Runs the action the way the runner would, minus the network: the
    // trigger step's real `env:` bindings feed the real trigger shell (with
    // a fake `gh`), and its outputs then feed the run step's own
    // argument-building script under the composite `shell: bash` flags, with
    // `bun` replaced by a function that prints the CLI arguments it receives.
    // Inputs fall back to each input's declared default, so a missing
    // binding, a wrong default or an env name the two sides disagree on fails
    // here like a wrong branch. `args` is undefined when the trigger did not
    // let the run step run.
    async function runAction(
      inputs: Record<string, string>,
      github: Record<string, string>,
      gh: FakeGh = offlineGh,
      // The exit code the fake CLI returns, so the run step's handling of a
      // failed CLI can be observed. Zero unless a test says otherwise.
      cliExit = 0,
    ): Promise<{
      exitCode: number;
      trigger: Record<string, string>;
      args: string[] | undefined;
      // What the run leaves in the outcome directory: the marker the run step
      // writes first, and the record the trigger wrote. runStepExitCode is the
      // run step's own exit.
      cliStarted: boolean;
      runStepExitCode: number | undefined;
      record: string | undefined;
    }> {
      const { runCiTrigger } = await import("#ci/trigger");
      // The runner's temp directory, with the outcome directory the action
      // binds under it. A real directory, so the marker and the record are
      // checked on disk, not in a string.
      const runnerTemp = mkdtempSync(path.join(os.tmpdir(), "prhero-action-"));
      const outcomeDir = path.join(runnerTemp, "pr-hero-outcome");
      mkdirSync(outcomeDir);
      const runner = { temp: runnerTemp };
      try {
        let output = "";
        const exitCode = runCiTrigger({
          env: {
            ...resolveEnv(triggerStep()?.env ?? {}, {
              inputs,
              github,
              trigger: {},
              runner,
            }),
            // Runner defaults every step inherits, not `env:` bindings.
            GITHUB_REPOSITORY: github.repository ?? "",
            GITHUB_RUN_ID: "4242",
            GITHUB_SERVER_URL: "https://github.com",
          },
          gh,
          stdout: () => {},
          appendOutput: (text) => {
            output += text;
          },
          appendSummary: () => {},
        });
        const trigger = Object.fromEntries(
          output
            .split("\n")
            .filter((line) => line.includes("="))
            .map((line) => [
              line.slice(0, line.indexOf("=")),
              line.slice(line.indexOf("=") + 1),
            ]),
        );
        const recordPath = path.join(outcomeDir, "trigger.json");
        const record = existsSync(recordPath)
          ? readFileSync(recordPath, "utf8")
          : undefined;
        if (trigger.run !== "true") {
          return {
            exitCode,
            trigger,
            args: undefined,
            cliStarted: existsSync(path.join(outcomeDir, "cli-started")),
            runStepExitCode: undefined,
            record,
          };
        }

        const runStep = steps().find((step) => step.id === "run-pr-hero");
        const env = resolveEnv(runStep?.env ?? {}, {
          inputs,
          github,
          trigger,
          runner,
        });
        const script = (runStep?.run ?? "").replaceAll(
          `\${{ github.action_path }}`,
          "/action",
        );
        const fakeBun = `bun() { shift; printf '%s\\n' "$@"; return ${cliExit}; }`;
        const result = Bun.spawnSync(
          [
            "bash",
            "--noprofile",
            "--norc",
            "-eo",
            "pipefail",
            "-c",
            `${fakeBun}\n${script}`,
          ],
          { env: { ...env, PATH: process.env.PATH ?? "" } },
        );
        const args = result.stdout
          .toString()
          .split("\n")
          .filter((line) => line !== "");
        return {
          exitCode,
          trigger,
          args,
          cliStarted: existsSync(path.join(outcomeDir, "cli-started")),
          runStepExitCode: result.exitCode,
          record,
        };
      } finally {
        rmSync(runnerTemp, { recursive: true, force: true });
      }
    }

    const REPOSITORY = "acme/widgets";
    const HEAD = "c".repeat(40);
    const CREDENTIAL = { "claude-token": "oauth-test-token" };
    const dispatchContext = {
      repository: REPOSITORY,
      event_name: "workflow_dispatch",
    };

    async function cliArgsFor(inputs: Record<string, string>) {
      const run = await runAction(
        { ...CREDENTIAL, ...inputs },
        dispatchContext,
      );
      return run.args ?? [];
    }

    // `full` is the only CI recovery when a prior review of the same head was
    // hollow: its complete summary marker makes every later run on that head
    // skip discovery, and `--force` never widens discovery.
    test.each([
      ["full: 'true'", { "pr-number": "305", full: "true" }, ["--full"]],
      ["full: 'false'", { "pr-number": "305", full: "false" }, []],
      ["full unset", { "pr-number": "305" }, []],
    ])(
      "%s passes --full only when the input is exactly 'true'",
      async (_label, inputs, fullFlags) => {
        const args = await cliArgsFor(inputs);
        // Proves the script ran to the CLI call, so an empty result below is
        // the branch's verdict and not a script that died early.
        expect(args.slice(0, 5)).toEqual([
          "review",
          "--pr",
          "305",
          "--ci",
          "--yes",
        ]);
        expect(args.filter((arg): boolean => arg === "--full")).toEqual(
          fullFlags,
        );
      },
    );

    // ---------------------------------------------------------------------
    // The trigger step (odd/tasks/agent-first-ci.md, T1/S1): credential
    // detection and the `/pr-hero review` comment command live in the
    // action, so the calling workflow can be one short file.
    // ---------------------------------------------------------------------

    test("the trigger runs right after Setup Bun, before anything is installed", () => {
      const all = steps();
      const setupBun = all.findIndex((step) => step.name === "Setup Bun");
      expect(setupBun).toBeGreaterThan(-1);
      const trigger = all[setupBun + 1];
      expect(trigger?.id).toBe("trigger");
      expect(trigger?.run).toContain("src/ci/trigger.ts");
    });

    test("every step after the trigger is gated on its run output, except the publisher", () => {
      const all = steps();
      const after = all.slice(
        all.findIndex((step) => step.id === "trigger") + 1,
      );
      expect(after.length).toBeGreaterThan(0);
      // The publisher is gated on the publish output instead: it must also
      // run for the outcomes where the run never starts (T2b).
      const ungated = after
        .filter((step) => step.id !== "publish")
        .filter(
          (step) =>
            !String(step.if ?? "").includes(
              "steps.trigger.outputs.run == 'true'",
            ),
        )
        .map((step) => step.name);
      expect(ungated).toEqual([]);
    });

    test("the comment body reaches the trigger only through env:", () => {
      // Free text anyone can type. In a `run:` or an `if:` it is command
      // injection; in any other step's env it is a value nothing there needs.
      expect(triggerStep()?.env?.COMMENT_BODY).toBe(
        `\${{ github.event.comment.body }}`,
      );
      for (const step of steps()) {
        expect(String(step.run ?? "")).not.toContain("github.event.comment");
        expect(String(step.if ?? "")).not.toContain("github.event.comment");
        if (step.id !== "trigger") {
          expect(JSON.stringify(step.env ?? {})).not.toContain(
            "github.event.comment",
          );
        }
      }
    });

    test("the comment id reaches the trigger through env:, and the reaction it drives names that id", async () => {
      expect(triggerStep()?.env?.EVENT_COMMENT_ID).toBe(
        `\${{ github.event.comment.id }}`,
      );
      const calls: string[][] = [];
      const gh: FakeGh = (args) => {
        calls.push([...args]);
        return {
          exitCode: 0,
          stdout: args.includes("POST")
            ? "{}"
            : args[0] === "api"
              ? "write\n"
              : `${HEAD}\n`,
          stderr: "",
        };
      };
      const run = await runAction(
        CREDENTIAL,
        {
          repository: REPOSITORY,
          event_name: "issue_comment",
          "event.issue.number": "21",
          "event.issue.pull_request.url": `https://api.github.com/repos/${REPOSITORY}/pulls/21`,
          "event.comment.body": "/pr-hero review",
          "event.comment.user.login": "maintainer",
          "event.comment.id": "9001",
        },
        gh,
      );
      expect(run.trigger).toMatchObject({ run: "true", pr: "21" });
      expect(calls.filter((args) => args.includes("POST"))).toEqual([
        [
          "api",
          "-X",
          "POST",
          `repos/${REPOSITORY}/issues/comments/9001/reactions`,
          "-f",
          "content=eyes",
        ],
      ]);
    });

    test("credentials reach the trigger as presence booleans, never as values", () => {
      const env = triggerStep()?.env ?? {};
      for (const input of [
        "anthropic-api-key",
        "claude-token",
        "opencode-auth",
      ]) {
        const bound = Object.values(env).filter((value) =>
          value.includes(`inputs.${input}`),
        );
        expect(bound).toEqual([`\${{ inputs.${input} != '' }}`]);
      }
    });

    test("the trigger has a token for its permission and head lookups", () => {
      expect(triggerStep()?.env?.GH_TOKEN).toBe(`\${{ inputs.github-token }}`);
    });

    // ---------------------------------------------------------------------
    // The outcome directory and the publish step (odd/tasks/agent-first-ci.md,
    // T2b / S3). The trigger writes trigger.json there, the run step marks
    // that the CLI started, and the publisher reads both.
    // ---------------------------------------------------------------------

    test("the outcome directory is bound the same way in the trigger, run and publish steps", () => {
      for (const id of ["trigger", "run-pr-hero", "publish"]) {
        const step = steps().find((candidate) => candidate.id === id);
        expect(step?.env?.PRHERO_OUTCOME_DIR, id).toBe(
          `\${{ runner.temp }}/pr-hero-outcome`,
        );
      }
    });

    test("the materialize step binds the outcome directory, so a malformed input can leave setup.json there", () => {
      const step = steps().find((candidate) => candidate.id === "materialize");
      expect(step?.env?.PRHERO_OUTCOME_DIR).toBe(
        `\${{ runner.temp }}/pr-hero-outcome`,
      );
    });

    test("the publish step skips a cancelled job, still runs after a failed one, and is publish-gated", () => {
      const all = steps();
      const run = all.findIndex((step) => step.id === "run-pr-hero");
      const publish = all.findIndex((step) => step.id === "publish");
      const upload = all.findIndex(
        (step) => step.name === "Upload pr-hero run directory",
      );
      expect(publish).toBe(run + 1);
      // The cancel settle (SB3) sits between publish and the upload, right after publish.
      const settle = all.findIndex((step) => step.id === "cancel-settle");
      expect(settle).toBe(publish + 1);
      expect(upload).toBe(settle + 1);
      const step = all[publish];
      // A cancelled job still reaches always() steps, so always() would publish
      // a false install failure on a superseded head. !cancelled() keeps the
      // failed-install case, which is a failure and not a cancellation.
      expect(step?.if).toContain("!cancelled()");
      expect(step?.if).not.toContain("always()");
      expect(step?.if).toContain("steps.trigger.outputs.publish == 'true'");
    });

    // WHY: the publish step is !cancelled() on purpose, so a cancelled review (SB3) left
    // its pr-hero status pending. The settle step runs only on a cancel, right after
    // publish, in the publisher's cancelled mode, with the same bindings as publish.
    test("the cancel-settle step follows publish, runs only on a cancel, and is in cancelled mode", () => {
      const all = steps();
      const publish = all.findIndex((step) => step.id === "publish");
      const settle = all.findIndex((step) => step.id === "cancel-settle");
      expect(settle).toBe(publish + 1);
      const step = all[settle];
      expect(step?.if).toBe(
        `\${{ cancelled() && steps.trigger.outputs.run == 'true' }}`,
      );
      expect(step?.run).toContain("src/ci/publish.ts");
      const env = step?.env as Record<string, string> | undefined;
      expect(env?.PRHERO_PUBLISH_MODE).toBe("cancelled");
      const publishEnv = (all[publish]?.env ?? {}) as Record<string, string>;
      // Every value it reads is bound as the publish step binds it. It reads no
      // run attempt: its lock is the outcome directory the trigger cleared.
      for (const key of Object.keys(publishEnv)) {
        if (key === "GITHUB_RUN_ATTEMPT") continue;
        expect(env?.[key]).toBe(publishEnv[key]);
      }
      expect(env?.GITHUB_RUN_ATTEMPT).toBeUndefined();
    });

    test("the publish step runs the publisher, binds every value through env:, and names no input in its script", () => {
      const step = steps().find((candidate) => candidate.id === "publish");
      expect(step?.shell).toBe("bash");
      expect(step?.run).toContain("src/ci/publish.ts");
      const expressions = [
        ...String(step?.run ?? "").matchAll(/\$\{\{[^}]*\}\}/g),
      ].map((match) => match[0]);
      expect(expressions).toEqual([`\${{ github.action_path }}`]);
      expect(step?.env?.GH_TOKEN).toBe(`\${{ inputs.github-token }}`);
      expect(step?.env?.GITHUB_REPOSITORY).toBe(`\${{ github.repository }}`);
      expect(step?.env?.GITHUB_RUN_ID).toBe(`\${{ github.run_id }}`);
    });

    // WHY: gh run rerun keeps the run id. The publisher compares the record's
    // attempt with this one, so a record from an earlier attempt is refused.
    test("the publish step binds the run attempt, so a record of another attempt is refused", () => {
      const step = steps().find((candidate) => candidate.id === "publish");
      expect(step?.env?.GITHUB_RUN_ATTEMPT).toBe(`\${{ github.run_attempt }}`);
    });

    // WHY: the publisher reads the CLI's cli.json from the outcome directory,
    // which every step already binds. A run-directory binding would be dead, and
    // a dead binding hides what the publish step really reads, so it stays out.
    test("the publish step binds no run directory: the CLI's record is in the outcome directory", () => {
      const step = steps().find((candidate) => candidate.id === "publish");
      expect(step?.env?.PRHERO_RUN_DIR).toBeUndefined();
    });

    test("the run step writes cli-started as its first command, before anything can fail", () => {
      const run = steps().find((step) => step.id === "run-pr-hero");
      const firstCommand = String(run?.run ?? "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "" && !line.startsWith("#"));
      expect(firstCommand).toBe(': > "$PRHERO_OUTCOME_DIR/cli-started"');
    });

    test("the trigger learns only whether the routing names OpenCode, never the routing text", () => {
      const env = triggerStep()?.env ?? {};
      expect(env.HAS_OPENCODE_ROUTING).toBe(
        `\${{ contains(inputs.routing, 'opencode') }}`,
      );
      expect(JSON.stringify(env)).not.toContain("inputs.routing }}");
    });

    test("a run that reaches the CLI leaves the started marker and a review record, and nothing else", async () => {
      const run = await runAction(
        { ...CREDENTIAL, "pr-number": "305" },
        { repository: REPOSITORY, event_name: "workflow_dispatch" },
      );
      expect(run.args?.slice(0, 2)).toEqual(["review", "--pr"]);
      expect(run.cliStarted).toBe(true);
      expect(JSON.parse(run.record ?? "{}").decision).toBe("review");
    });

    // WHY: the job's result must be the CLI's own. The publish step reads the
    // CLI's cli.json, not a marker the run step writes, so the run step adds
    // nothing after the CLI: a failed CLI fails the step with its code.
    test("the run step exits with the CLI's code, whether the CLI succeeded or failed", async () => {
      const succeeded = await runAction(
        { ...CREDENTIAL, "pr-number": "305" },
        { repository: REPOSITORY, event_name: "workflow_dispatch" },
        offlineGh,
        0,
      );
      expect(succeeded.runStepExitCode).toBe(0);
      expect(succeeded.cliStarted).toBe(true);

      const failed = await runAction(
        { ...CREDENTIAL, "pr-number": "305" },
        { repository: REPOSITORY, event_name: "workflow_dispatch" },
        offlineGh,
        7,
      );
      expect(failed.runStepExitCode).toBe(7);
      expect(failed.cliStarted).toBe(true);
    });

    test("the run step's last command is the CLI itself, so the job's result is the CLI's", () => {
      const run = steps().find((step) => step.id === "run-pr-hero");
      const lastCommand = String(run?.run ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"))
        .at(-1);
      expect(lastCommand).toBe(
        `bun "\${{ github.action_path }}/bin/pr-hero.js" "$@"`,
      );
    });

    test("a run with no credential never reaches the CLI: no marker, and a no-credentials record", async () => {
      const run = await runAction(
        {},
        { repository: REPOSITORY, event_name: "workflow_dispatch" },
      );
      expect(run.exitCode).toBe(1);
      expect(run.args).toBeUndefined();
      expect(run.cliStarted).toBe(false);
      expect(JSON.parse(run.record ?? "{}").decision).toBe("no-credentials");
    });

    test("the legacy force dispatch still passes --pr, --force and --full", async () => {
      const args = await cliArgsFor({
        "pr-number": "305",
        force: "true",
        full: "true",
      });
      expect(args.slice(0, 3)).toEqual(["review", "--pr", "305"]);
      expect(args).toContain("--force");
      expect(args).toContain("--full");
    });

    test("a same-repo pull_request reviews its own number, without --force", async () => {
      const run = await runAction(CREDENTIAL, {
        repository: REPOSITORY,
        event_name: "pull_request",
        "event.pull_request.number": "12",
        "event.pull_request.head.repo.full_name": REPOSITORY,
        "event.pull_request.head.sha": HEAD,
      });
      expect(run.trigger).toMatchObject({
        run: "true",
        pr: "12",
        head_sha: HEAD,
      });
      expect(run.args?.slice(0, 3)).toEqual(["review", "--pr", "12"]);
      expect(run.args).not.toContain("--force");
    });

    test("a `/pr-hero review --full` comment from a writer passes --force and --full", async () => {
      const gh: FakeGh = (args) => ({
        exitCode: 0,
        stdout: args[0] === "api" ? "write\n" : `${HEAD}\n`,
        stderr: "",
      });
      const run = await runAction(
        CREDENTIAL,
        {
          repository: REPOSITORY,
          event_name: "issue_comment",
          "event.issue.number": "21",
          "event.issue.pull_request.url": `https://api.github.com/repos/${REPOSITORY}/pulls/21`,
          "event.comment.body": "/pr-hero review --full",
          "event.comment.user.login": "maintainer",
        },
        gh,
      );
      expect(run.trigger).toMatchObject({ pr: "21", head_sha: HEAD });
      expect(run.args?.slice(0, 3)).toEqual(["review", "--pr", "21"]);
      expect(run.args).toContain("--force");
      expect(run.args).toContain("--full");
    });

    test("a fork pull_request never reaches the run step", async () => {
      const run = await runAction(CREDENTIAL, {
        repository: REPOSITORY,
        event_name: "pull_request",
        "event.pull_request.number": "12",
        "event.pull_request.head.repo.full_name": "stranger/widgets",
        "event.pull_request.head.sha": HEAD,
      });
      expect(run.exitCode).toBe(0);
      expect(run.trigger.run).toBe("false");
      expect(run.args).toBeUndefined();
    });

    test("no credential stops the action red before the run step", async () => {
      const run = await runAction({ "pr-number": "305" }, dispatchContext);
      expect(run.exitCode).toBe(1);
      expect(run.trigger.run).toBe("false");
      expect(run.args).toBeUndefined();
    });

    test("never interpolates a free-text input directly into the shell script body", () => {
      // Every input / github-context value the run step needs must be
      // routed through `env:` and referenced as a shell variable — see the
      // step's own header comment. github.action_path is GitHub-controlled
      // (safe to interpolate directly); nothing else should appear as a raw
      // `${{ ... }}` expression inside the run script's own TEXT (as opposed
      // to the step's `env:` mapping, where binding them is exactly right).
      const action = parsedAction();
      const runStep = action.runs.steps.find(
        (step) => step.id === "run-pr-hero",
      ) as { run?: string } | undefined;
      const script = runStep?.run ?? "";
      const interpolations = script.match(/\$\{\{[^}]*\}\}/g) ?? [];
      expect(interpolations.length).toBeGreaterThan(0);
      for (const token of interpolations) {
        expect(token).toContain("github.action_path");
      }
    });

    // Threat matrix RED (4): every composite `run:` body, not just
    // run-pr-hero. env: may bind inputs; the script text may not.
    test("every step run: interpolation is github.action_path only", () => {
      const action = parsedAction();
      let seen = 0;
      for (const step of action.runs.steps) {
        const script = typeof step.run === "string" ? step.run : "";
        const interpolations = script.match(/\$\{\{[^}]*\}\}/g) ?? [];
        seen += interpolations.length;
        for (const token of interpolations) {
          expect(token).toContain("github.action_path");
        }
      }
      expect(seen).toBeGreaterThan(0);
    });

    // Threat matrix RED (7): pin is its own step so GITHUB_PATH applies to
    // later steps. Never `latest`. Install `if` may read inputs, not secrets.
    test("OpenCode CLI install is not run-pr-hero, pins 1.18.30, and gates on inputs", () => {
      const action = parsedAction();
      const install = action.runs.steps.find((step) =>
        String(step.run ?? "").includes("opencode.ai/install"),
      ) as
        | { id?: string; name?: string; if?: string; run?: string }
        | undefined;
      const run = action.runs.steps.find((step) => step.id === "run-pr-hero");
      expect(install).toBeDefined();
      expect(install).not.toBe(run);
      expect(install?.id).not.toBe("run-pr-hero");
      expect(String(install?.if)).toContain("inputs.");
      expect(String(install?.if)).not.toContain("secrets.");
      expect(install?.run).toContain("--version 1.18.30");
      expect(install?.run).not.toContain("latest");
      expect(install?.run).toContain("GITHUB_PATH");
      const installAt = action.runs.steps.indexOf(install as never);
      const runAt = action.runs.steps.indexOf(run as never);
      expect(installAt).toBeGreaterThan(-1);
      expect(runAt).toBeGreaterThan(installAt);
    });

    test("never embeds a secret value — references secrets by name only", () => {
      const raw = readFileSync(actionPath, "utf-8");
      expect(raw).not.toMatch(/sk-ant-|ghp_|ghs_/);
    });

    // -------------------------------------------------------------------
    // Run-directory artifact upload, moved here from the generated workflow
    // so a consumer gets it without copying a step.
    //
    // `pr-hero triage reply --from <run-dir>` is the ONLY supported way to
    // answer a posted finding, and it hard-fails without a run directory on
    // disk (runTriageCommand needs comparison.json; the reply path needs
    // findings.json to map F00N onto the posted marker). In CI that directory
    // is `~/.prhero/.../runs/pr-<n>-<sha>-1` on an EPHEMERAL runner — it dies
    // with the job. Uploading it is what keeps the triage half of the loop
    // reachable once reviews move to Actions.
    // -------------------------------------------------------------------
    const uploadStep = () =>
      steps().find((step) =>
        String(step.uses ?? "").startsWith("actions/upload-artifact@"),
      );

    test("uploads the run step's run_dir as the action's last step", () => {
      const all = steps();
      const upload = all.at(-1);
      expect(upload?.uses).toBe("actions/upload-artifact@v4");
      expect(
        all.filter((step) =>
          String(step.uses ?? "").startsWith("actions/upload-artifact@"),
        ),
      ).toHaveLength(1);
      // `run_dir` is the key the CLI writes to $GITHUB_OUTPUT
      // (formatCiOutputs); `run-dir` would read as empty and skip forever.
      expect(upload?.with?.path).toBe(
        `\${{ steps.run-pr-hero.outputs.run_dir }}`,
      );
      expect(parsedAction().outputs["run-dir"].value).toBe(
        `\${{ steps.run-pr-hero.outputs.run_dir }}`,
      );
    });

    test("the upload runs on always(), only for a run that reviewed and wrote a directory", () => {
      // The incident this pins: every hunter died with `Not logged in ·
      // Please run /login` and the per-attempt logs — the only evidence
      // naming the cause — were on the runner. A failed review is exactly
      // when the run directory matters most, so the upload must not hang off
      // step success. An ignored run has nothing to upload.
      const condition = String(uploadStep()?.if);
      expect(condition).toContain("always()");
      expect(condition).toContain("steps.trigger.outputs.run == 'true'");
      expect(condition).toContain("steps.run-pr-hero.outputs.run_dir != ''");
    });

    test("a review that wrote no run directory never turns the job red", () => {
      // A size-gated or budget-gated review exits 0 having written nothing.
      // `if-no-files-found: error` would fail the job for a skip that worked
      // exactly as designed.
      expect(uploadStep()?.with?.["if-no-files-found"]).toBe("warn");
    });

    test("the artifact name pins BOTH the PR number and the head sha, from the trigger", () => {
      // A PR is reviewed once per push, and the run directory itself is named
      // `pr-<n>-<sha>-1`. A comment event carries no pull_request payload, so
      // both halves come from the trigger, which resolves them for every
      // event that reviews.
      const name = String(uploadStep()?.with?.name);
      expect(name).toBe(
        `pr-hero-run-\${{ steps.trigger.outputs.pr }}-\${{ steps.trigger.outputs.head_sha }}`,
      );
    });

    test("a re-run overwrites its artifact instead of failing on a name clash", () => {
      // v4 artifact names are unique per workflow RUN, and `gh run rerun`
      // reuses the run id — which the no-credentials summary tells people to
      // do. Without `overwrite`, the second attempt's upload 409s, and under
      // `always()` that turns the job red for a re-run that otherwise
      // succeeded.
      expect(uploadStep()?.with?.overwrite).toBe(true);
    });

    test("retention is bounded — the artifact carries the diff and the prompts", () => {
      // On a PUBLIC repository every workflow artifact is downloadable by
      // anyone: long enough to triage, short enough to limit exposure.
      expect(uploadStep()?.with?.["retention-days"]).toBe(7);
    });

    test("uploads hidden files — the run directory lives under a hidden ancestor", () => {
      // upload-artifact excludes hidden files by default since v4.4, and the
      // run directory sits under `~/.prhero`. With `if-no-files-found: warn`,
      // an exclusion would produce an EMPTY artifact and a warning nobody
      // reads, which is worse than no artifact at all.
      expect(uploadStep()?.with?.["include-hidden-files"]).toBe(true);
    });

    test("explains WHY the run directory is uploaded, not merely that it is", () => {
      const raw = readFileSync(actionPath, "utf-8");
      expect(raw).toMatch(/triage reply --from/);
      expect(raw).toMatch(/ephemeral/i);
      expect(raw).toMatch(/public repositor/i);
    });
  });

  test("committed .github/workflows/pr-hero.yml never drifts from generateCiWorkflowTemplate()", () => {
    // This repo's own canonical example workflow is generated by, not
    // hand-copied from, ci/setup.ts's generateCiWorkflowTemplate() — the same
    // function `pr-hero setup --ci` / `pr-hero ci init` runs for any caller
    // repo. A byte-for-byte equality assertion is the only thing standing
    // between the two ever silently diverging.
    const workflowPath = path.join(
      rootDir,
      ".github",
      "workflows",
      "pr-hero.yml",
    );
    expect(existsSync(workflowPath)).toBe(true);
    const committed = readFileSync(workflowPath, "utf-8");
    expect(committed).toBe(generateCiWorkflowTemplate(OWN_CI_WORKFLOW_OPTIONS));
  });

  // The force workflow is retired: `/pr-hero review` on the pull request is
  // the forced run now, and pr-hero.yml listens for it. A committed or shipped
  // copy would be a second, drifting way to do the same thing, and nothing
  // generates it any more to keep it honest.
  test("neither this repo nor the ci-setup skill ships a separate force workflow", () => {
    expect(
      existsSync(
        path.join(rootDir, ".github", "workflows", "pr-hero-force.yml"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          "skills",
          "pr-hero-ci-setup",
          "assets",
          "workflow-force.yml",
        ),
      ),
    ).toBe(false);
  });

  test("skills/pr-hero-ci-setup/assets/workflow.yml never drifts from generateCiWorkflowTemplate()", () => {
    const assetPath = path.join(
      rootDir,
      "skills",
      "pr-hero-ci-setup",
      "assets",
      "workflow.yml",
    );
    expect(existsSync(assetPath)).toBe(true);
    const assetContent = readFileSync(assetPath, "utf-8");
    expect(assetContent).toBe(generateCiWorkflowTemplate());
  });

  test("ci-setup skill points at the OpenCode operator procedure and that file exists", () => {
    const skillPath = path.join(
      rootDir,
      "skills",
      "pr-hero-ci-setup",
      "SKILL.md",
    );
    const refPath = path.join(
      rootDir,
      "skills",
      "pr-hero-ci-setup",
      "references",
      "opencode-ci.md",
    );
    expect(existsSync(skillPath)).toBe(true);
    expect(existsSync(refPath)).toBe(true);
    const skill = readFileSync(skillPath, "utf-8");
    expect(skill).toContain("references/opencode-ci.md");
    expect(skill).toContain("OPENCODE_AUTH_JSON");
    expect(skill).toContain("PRHERO_ROUTING");
    const ref = readFileSync(refPath, "utf-8");
    expect(ref).toContain("modelSnapshot");
    expect(ref).toContain("Do **not** create `OPENAI_API_KEY`");
  });

  test(".agents/skills/pr-hero-ci-setup/assets/workflow.yml matches the skills workflow asset", () => {
    const skillsPath = path.join(
      rootDir,
      "skills",
      "pr-hero-ci-setup",
      "assets",
      "workflow.yml",
    );
    const agentsPath = path.join(
      rootDir,
      ".agents",
      "skills",
      "pr-hero-ci-setup",
      "assets",
      "workflow.yml",
    );
    expect(existsSync(agentsPath)).toBe(true);
    expect(readFileSync(agentsPath, "utf-8")).toBe(
      readFileSync(skillsPath, "utf-8"),
    );
  });

  // A consumer repo has no copy of this action's source, so it must resolve
  // the published tag. This repo DOES have the source — and resolving a tag
  // that does not exist yet would paint every PR here permanently red, which
  // is strictly worse than no check at all: a red that can never go green
  // teaches everyone to stop reading it. `./` runs the action.yml sitting in
  // the checked-out tree, which is also the only form that actually tests the
  // action being changed in the PR that changes it.
  test("the default action ref targets the published tag for consumer repos", () => {
    expect(generateCiWorkflowTemplate()).toContain(
      "uses: juanmaagd/pr-hero@v0",
    );
  });

  test("this repo's own workflow runs the local action, not an unpublished tag", () => {
    const own = generateCiWorkflowTemplate(OWN_CI_WORKFLOW_OPTIONS);
    expect(own).toContain("uses: ./");
    expect(own).not.toContain("juanmaagd/pr-hero@v0");
  });

  // The byte-equality drift tests above already fail if these lines change, but
  // they fail by showing a diff — they never say WHICH side is supposed to
  // carry an override. These two state the rule directly: a scaffolded repo
  // inherits action.yml's defaults and is never handed ceilings it did not
  // choose, while this repo raises only the size gate because it reviews
  // itself. A future edit that "helpfully" pushes an override into the
  // scaffolded template breaks this, not just a byte comparison.
  test("the scaffolded template sets neither spend nor size ceilings", () => {
    const scaffolded = generateCiWorkflowTemplate();
    expect(scaffolded).not.toContain("budget-usd:");
    expect(scaffolded).not.toContain("max-changed-lines:");
  });

  // Spend is deliberately NOT on this list since issue #156. action.yml's
  // `budget-usd` default is now empty and the CLI resolves the ceiling from
  // the route's billing mode, so an explicit `budget-usd: 15.00` here would
  // impose a ceiling the policy would not otherwise apply — on a subscription
  // route that ceiling gates a token-derived estimate against $0.00 of real
  // spend, and a skipped review reads exactly like a clean one.
  test("this repo's own workflow raises the size ceiling and disables the budget ceiling", () => {
    const own = generateCiWorkflowTemplate(OWN_CI_WORKFLOW_OPTIONS);
    // 0, not a number: a subscription route has no dollar cost to cap.
    expect(own).toContain("budget-usd: 0\n");
    // 5000, not action.yml's 4000: large refactoring slices (like cli-decomposition)
    // exceed 2000 lines, so dogfooding requires an expanded ceiling.
    expect(own).toContain("max-changed-lines: 5000");
  });

  test("build script produces standalone bundle without error", async () => {
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: rootDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      console.error(stdout, stderr);
    }
    expect(exitCode).toBe(0);

    const distCliPath = path.join(rootDir, "dist", "cli.js");
    expect(existsSync(distCliPath)).toBe(true);
  });
});

// `/pr-hero recheck` reaches the CI adjudicator through action.yml's review args
// and the three workflow copies, which must all accept the command.
describe("/pr-hero recheck wiring", () => {
  const rootDir = path.resolve(__dirname, "..");
  const recheckClause =
    "startsWith(github.event.comment.body, '/pr-hero recheck')";
  const copies = [
    ".github/workflows/pr-hero.yml",
    "skills/pr-hero-ci-setup/assets/workflow.yml",
  ];

  test("action.yml passes TRIGGER_ADJUDICATE as --adjudicate", () => {
    const action = readFileSync(path.join(rootDir, "action.yml"), "utf-8");
    expect(action).toContain(
      "TRIGGER_ADJUDICATE: " + "$" + "{{ steps.trigger.outputs.adjudicate }}",
    );
    expect(action).toContain(
      'if [ "$TRIGGER_ADJUDICATE" = "true" ]; then set -- "$@" --adjudicate; fi',
    );
  });

  test.each(copies)(
    "%s accepts the recheck command in if and concurrency",
    (file) => {
      const content = readFileSync(path.join(rootDir, file), "utf-8");
      const review =
        content.split(
          "startsWith(github.event.comment.body, '/pr-hero review')",
        ).length - 1;
      expect(review).toBeGreaterThan(0);
      expect(content.split(recheckClause).length - 1).toBe(review);
      if (file.startsWith(".github")) {
        expect(content).toContain(
          "/pr-hero review, /pr-hero recheck or /pr-hero override",
        );
      }
    },
  );
});
