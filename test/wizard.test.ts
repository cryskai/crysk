import { describe, expect, test } from "bun:test";
import {
  GOTCHAS_PLACEHOLDER_MARKER,
  gotchasUnusableReason,
  initGitReminder,
} from "#review/preflight";
import type { ExactBindingCapabilityReport } from "../src/execution/contracts";
import {
  CURRENT_ONBOARDING_VERSION,
  createInitialWizardState,
  isMachineOnboarded,
  renderWizardStep,
  runWizard,
  runWizardSteps,
  WIZARD_STEPS,
  type WizardDeps,
  wizardReducer,
} from "../src/wizard";

// W4 remediation (opencode-production-runtime PR3 verify #4997): the old
// `probeExactBinding` seam returned `{ projectionReady: boolean }` — a
// caller-supplied boolean, not the real ExactBindingCapabilityReport the
// doctor and execution consumers derive readiness from. That let the wizard
// step exercise a shape production code never produces. This fixture
// matches the real report exactly (see test/doctor.test.ts's `exact()`).
function exactBindingReport(
  overrides: Partial<ExactBindingCapabilityReport> = {},
): ExactBindingCapabilityReport {
  return {
    routeKey: "fp",
    backend: "claude-code",
    sdk: { available: true },
    binary: { resolved: true, absolutePath: "/bin/claude", sha256: "aa" },
    auth: {
      kind: "claude_subscription_oauth",
      projectionReady: true,
      probe: "passed",
    },
    environment: { syntheticHome: true, enumeratedPassthrough: false },
    isolation: { workspaceReadBroker: true, codegraphPolicy: false },
    toolsMcp: { allowMapEnforced: true, mcpIntegrityChecked: true },
    protocol: {
      terminalProof: true,
      boundedEvents: false,
      usageMode: "snapshot",
    },
    usage: { normalized: true },
    billing: {
      mode: "subscription",
      pricingApplicability: "not_applicable",
      tokenPricingAvailable: false,
      cashCostAccountingValid: true,
    },
    ...overrides,
  };
}

describe("Wizard state machine & steps", () => {
  test("5 ordered step descriptors defined", () => {
    expect(WIZARD_STEPS.length).toBe(5);
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual([
      "system_tools",
      "agent_env",
      "skills_mcp",
      "workspace",
      "verification",
    ]);
  });

  test("wizardReducer transitions stepIndex and selectedIndex correctly", () => {
    let state = createInitialWizardState();
    expect(state.stepIndex).toBe(0);

    state = wizardReducer(state, { type: "NEXT_STEP" });
    expect(state.stepIndex).toBe(1);

    state = wizardReducer(state, { type: "SET_SELECTED_INDEX", index: 2 });
    expect(state.selectedIndex).toBe(2);

    state = wizardReducer(state, { type: "PREV_STEP" });
    expect(state.stepIndex).toBe(0);
    expect(state.selectedIndex).toBe(0);
  });

  describe("Step 4 (workspace) apply behavior", () => {
    test("apply writes ~/.crysk/setup.json and NEVER touches ~/.crysk/config.json", async () => {
      const written: Record<string, string> = {};
      const executed: string[][] = [];

      const step = WIZARD_STEPS.find((s) => s.id === "workspace");
      expect(step).toBeDefined();

      const initialState = createInitialWizardState();
      initialState.gotchas = {
        collected: 0,
        informedSkip: true,
        truncatedOnSkip: false,
        entries: [],
      };
      initialState.commitChoice = undefined;

      const deps = {
        cwd: "/repo",
        home: "/home/user",
        exists: (p: string) => Boolean(written[p]),
        readFile: (p: string) => written[p],
        writeFile: async (p: string, c: string) => {
          written[p] = c;
        },
        exec: async (cmd: string[]) => {
          executed.push(cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };

      const result = await step?.apply(initialState, deps);
      expect(result?.setupStateWritten).toBe(true);

      // Verify setup.json content
      const setupRaw = written["/home/user/.crysk/setup.json"];
      expect(setupRaw).toBeDefined();
      const setup = JSON.parse(setupRaw);
      expect(setup.onboarding_version).toBe(CURRENT_ONBOARDING_VERSION);
      expect(setup.completed_at).toBeDefined();

      // Crucial invariant: never touches ~/.crysk/config.json
      expect(written["/home/user/.crysk/config.json"]).toBeUndefined();

      // Verify skipped gotchas marker
      const gotchasRaw = written["/repo/.crysk/gotchas.md"];
      expect(gotchasRaw).toBeDefined();
      expect(gotchasRaw).toContain(
        "<!-- human-attention-required: zero invariants defined during onboarding -->",
      );
      // The loop that matters, closed on the ACTUAL bytes rather than on a
      // literal retyped into another test file: what `setup` writes here is
      // what `review`, the pipeline and `doctor` all refuse. `runWizard`
      // dispatches no reducer actions, so `gotchas.entries` is always empty
      // and this file is what `pr-hero setup` produces WHENEVER it writes one
      // — which, since neither write overwrites, is only in a repo that had
      // no `.crysk/gotchas.md` yet.
      expect(gotchasUnusableReason(gotchasRaw)).toBe("placeholder");
      // ...and the flag step 5 reads before warning about that file agrees
      // with the bytes just asserted.
      expect(result?.placeholderGotchasWritten).toBe(true);
      expect(result?.workspaceFilesWritten).toBe(true);
    });

    test("a gotchas file already on disk is neither rewritten nor claimed", async () => {
      // The other half of "never overwrites": when both files exist, this run
      // wrote nothing into `.crysk/`, and both of step 5's flags must say so.
      // They used to be one flag assigned `isRepo`, which was true here.
      const written: Record<string, string> = {
        "/repo/.crysk/config.json": '{"default_base": "main"}\n',
        "/repo/.crysk/gotchas.md":
          "# Repo gotchas\n\n- auth: tokens are refreshed by the broker, never in-process.\n",
      };
      const before = { ...written };

      const step = WIZARD_STEPS.find((s) => s.id === "workspace");
      const result = await step?.apply(createInitialWizardState(), {
        cwd: "/repo",
        home: "/home/user",
        exists: (p: string) => Object.hasOwn(written, p),
        readFile: (p: string) => written[p],
        writeFile: async (p: string, c: string) => {
          written[p] = c;
        },
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });

      expect(result?.workspaceFilesWritten).toBe(false);
      expect(result?.placeholderGotchasWritten).toBe(false);
      expect(written["/repo/.crysk/gotchas.md"]).toBe(
        before["/repo/.crysk/gotchas.md"],
      );
      expect(written["/repo/.crysk/config.json"]).toBe(
        before["/repo/.crysk/config.json"],
      );
    });

    test("apply with commitChoice 'commit' stages .crysk and creates chore commit", async () => {
      const written: Record<string, string> = {};
      const executed: string[][] = [];

      const step = WIZARD_STEPS.find((s) => s.id === "workspace");
      const initialState = createInitialWizardState();
      initialState.commitChoice = "commit";
      initialState.gotchas = {
        collected: 1,
        informedSkip: false,
        truncatedOnSkip: false,
        entries: ["Do not mutate state without lock."],
      };

      const deps = {
        cwd: "/repo",
        home: "/home/user",
        exists: (p: string) => Boolean(written[p]),
        readFile: (p: string) => written[p],
        writeFile: async (p: string, c: string) => {
          written[p] = c;
        },
        exec: async (cmd: string[]) => {
          executed.push(cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };

      const result = await step?.apply(initialState, deps);

      // The distinction the two flags exist to keep: entries were collected,
      // so the gotchas file this run wrote is REAL and carries no marker —
      // step 5's placeholder warning would be false about it. Collapsing the
      // flag into "we wrote gotchas" is the regression this catches.
      //
      // Honest caveat: nothing in production dispatches SET_GOTCHAS_ENTRIES
      // today, so this branch is reached only through `apply`'s own signature.
      // It is a contract test for `apply`, not a user-reachable ending — the
      // reachable endings are asserted through `runWizardSteps` further down.
      expect(result?.placeholderGotchasWritten).toBe(false);
      expect(result?.workspaceFilesWritten).toBe(true);
      expect(written["/repo/.crysk/gotchas.md"]).not.toContain(
        GOTCHAS_PLACEHOLDER_MARKER,
      );

      expect(executed).toContainEqual(["git", "add", ".crysk"]);
      expect(executed).toContainEqual([
        "git",
        "commit",
        "-m",
        "chore: initialize crysk review configuration",
      ]);
    });

    test("apply with commitChoice 'ignore' appends .crysk/ to .gitignore", async () => {
      const written: Record<string, string> = {
        "/repo/.gitignore": "node_modules/\n",
      };
      const executed: string[][] = [];

      const step = WIZARD_STEPS.find((s) => s.id === "workspace");
      const initialState = createInitialWizardState();
      initialState.commitChoice = "ignore";

      const deps = {
        cwd: "/repo",
        home: "/home/user",
        exists: (p: string) => Boolean(written[p]),
        readFile: (p: string) => written[p],
        writeFile: async (p: string, c: string) => {
          written[p] = c;
        },
        exec: async (cmd: string[]) => {
          executed.push(cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };

      await step?.apply(initialState, deps);

      expect(written["/repo/.gitignore"]).toContain(".crysk/");
    });
  });

  describe("isMachineOnboarded", () => {
    test("returns true when ~/.crysk/setup.json exists with current version", () => {
      const exists = (p: string) => p === "/home/user/.crysk/setup.json";
      const readFile = () => JSON.stringify({ onboarding_version: 1 });
      expect(isMachineOnboarded({ home: "/home/user", exists, readFile })).toBe(
        true,
      );
    });

    test("returns false when setup.json is missing or outdated", () => {
      expect(
        isMachineOnboarded({
          home: "/home/user",
          exists: () => false,
          readFile: () => undefined,
        }),
      ).toBe(false);

      expect(
        isMachineOnboarded({
          home: "/home/user",
          exists: () => true,
          readFile: () => JSON.stringify({ onboarding_version: 0 }),
        }),
      ).toBe(false);
    });
  });

  describe("renderWizardStep", () => {
    test("renders wizard lines with styles: false with zero ANSI bytes", () => {
      const state = createInitialWizardState();
      const lines = renderWizardStep(state, { styles: false, width: 80 });
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain("\x1b");
      }
    });
  });

  describe("dependency injection: WizardDeps.exec reaches the tool checks", () => {
    // WizardDeps has always exposed `exec`, and a caller that injects it is
    // entitled to assume NOTHING in the wizard shells out for real. It did not
    // hold: the system_tools step spread only `deps.checkToolsOptions` into
    // `checkSystemTools`, so an injected `exec` was silently dropped and the
    // real `Bun.spawn` fallback ran `gh auth status` — a live network round
    // trip — inside a test that had faked its I/O. That is a leak in the seam,
    // not a slow test: it made `bun test` depend on the network and on GitHub
    // being fast, and it is why test/repo-optional.test.ts's setup test timed
    // out at bun's 5000ms default whenever `gh` was slow to answer.
    // `checkSystemTools` falls back to the real `Bun.which` when no `which` is
    // injected (src/system-tools.ts:96), and it only issues the `gh auth
    // status` exec once `which("gh")` returned a path (:156-168). So a test
    // that injects `exec` but not `which` still depends on the host having
    // `gh` on PATH — which is the exact ambient-state dependency these tests
    // exist to disprove. Found by pr-hero on #118; reproduced by running them
    // with a PATH containing no `gh`.
    const hermeticWhich = { which: (bin: string) => `/usr/local/bin/${bin}` };

    test("an injected exec is used for the system-tool probes, not Bun.spawn", async () => {
      const calls: string[][] = [];
      await runWizard({
        cwd: "/repo",
        home: "/home/user",
        checkToolsOptions: hermeticWhich,
        exec: async (cmd) => {
          calls.push(cmd);
          return { exitCode: 1, stdout: "", stderr: "not a git repository" };
        },
        writeFile: async () => {},
        exists: () => false,
      });

      // The tool preflight asks each installed binary for its version, and
      // `--version` is issued by checkSystemTools alone — the wizard's own
      // git probe is `rev-parse`. So a `--version` command arriving here is
      // the seam being wired, not the pre-existing git call leaking through.
      expect(calls.some((cmd) => cmd.includes("--version"))).toBe(true);
    });

    test("an injected exec keeps the wizard off the network entirely", async () => {
      // The specific spawn that made this expensive was `gh auth status`.
      // Nothing the wizard runs may reach a real binary when exec is injected.
      const calls: string[][] = [];
      await runWizard({
        cwd: "/repo",
        home: "/home/user",
        checkToolsOptions: hermeticWhich,
        exec: async (cmd) => {
          calls.push(cmd);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        writeFile: async () => {},
        exists: () => false,
      });

      // Every command the wizard issued was observed here. If `gh auth status`
      // had gone to the real Bun.spawn fallback instead, this list would not
      // contain it — the assertion is that the probes are visible, i.e. routed
      // through the seam rather than around it.
      expect(calls.some((cmd) => cmd.includes("auth"))).toBe(true);
    });
  });

  describe("exact-binding initialization facts", () => {
    const tools = {
      cwd: "/repo",
      home: "/home/user",
      exists: () => true,
      checkToolsOptions: {
        which: (bin: string) => `/bin/${bin}`,
        exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
        env: { ANTHROPIC_API_KEY: "sk-test" },
      },
    };

    test("system_tools probe and render follow exact-binding projectionReady from a real ExactBindingCapabilityReport (drift, spec scenario 8)", async () => {
      const step = WIZARD_STEPS.find((s) => s.id === "system_tools");
      expect(step).toBeDefined();
      const unavailable = await step?.probe({
        ...tools,
        probeExactBinding: async () => [
          exactBindingReport({
            auth: {
              kind: "claude_subscription_oauth",
              projectionReady: false,
              probe: "failed",
            },
          }),
        ],
      });
      expect(unavailable?.exactBindingAuthProjections).toEqual([
        { routeKey: "fp", backend: "claude-code", projectionReady: false },
      ]);
      expect(unavailable?.exactBindingProbeError).toBeUndefined();
      const down = step?.render(
        { ...createInitialWizardState(), ...unavailable },
        { styles: false, width: 80 },
      );
      expect(
        down?.some((l) => l.includes("auth projection: unavailable")),
      ).toBe(true);

      // Binding drift: the same step, re-probed with fresh facts, reflects
      // CURRENT state — it must not reuse the prior call's success flag.
      const ready = await step?.probe({
        ...tools,
        probeExactBinding: async () => [exactBindingReport()],
      });
      expect(ready?.exactBindingAuthProjections).toEqual([
        { routeKey: "fp", backend: "claude-code", projectionReady: true },
      ]);
      const up = step?.render(
        { ...createInitialWizardState(), ...ready },
        { styles: false, width: 80 },
      );
      expect(up?.some((l) => l.includes("auth projection: ready"))).toBe(true);
    });

    test("a probe/authority failure is recorded distinctly from a genuinely unready projection", async () => {
      const step = WIZARD_STEPS.find((s) => s.id === "system_tools");
      expect(step).toBeDefined();

      // A genuine defect (broker down, transport throw, etc.) must not
      // collapse into the SAME `false` a clean unready report also produces.
      const errored = await step?.probe({
        ...tools,
        probeExactBinding: async () => {
          throw new Error("credential broker unavailable");
        },
      });
      expect(errored?.exactBindingAuthProjections).toEqual([]);
      expect(errored?.exactBindingProbeError).toContain(
        "credential broker unavailable",
      );

      const genuinelyUnready = await step?.probe({
        ...tools,
        probeExactBinding: async () => [
          exactBindingReport({
            auth: {
              kind: "claude_subscription_oauth",
              projectionReady: false,
              probe: "failed",
            },
          }),
        ],
      });
      expect(genuinelyUnready?.exactBindingAuthProjections).toEqual([
        { routeKey: "fp", backend: "claude-code", projectionReady: false },
      ]);
      expect(genuinelyUnready?.exactBindingProbeError).toBeUndefined();
    });

    // NEW-1 (verify report #4997 rev7): the probe failure was captured in
    // state but never rendered, so an operator saw the identical
    // "unavailable" line whether the broker threw or the projection was
    // cleanly unready. State-only distinctions help nobody at the terminal.
    test("render distinguishes a probe failure from a cleanly unready projection", () => {
      const step = WIZARD_STEPS.find((s) => s.id === "system_tools");
      expect(step).toBeDefined();

      const base = {
        ...createInitialWizardState(),
        toolStatuses: {
          claude: { name: "claude", installed: true, version: "1.0.0" },
        },
      };

      const unreadyClaudeBinding = [
        {
          routeKey: "fp",
          backend: "claude-code" as const,
          projectionReady: false,
        },
      ];

      const cleanlyUnready = step?.render(
        { ...base, exactBindingAuthProjections: unreadyClaudeBinding },
        { styles: false, width: 80 },
      ) as string[];
      expect(cleanlyUnready.join("\n")).toContain(
        "auth projection: unavailable",
      );
      expect(cleanlyUnready.join("\n")).not.toContain("probe failed");

      const probeFailed = step?.render(
        {
          ...base,
          exactBindingAuthProjections: unreadyClaudeBinding,
          exactBindingProbeError: "credential broker unavailable",
        },
        { styles: false, width: 80 },
      ) as string[];
      const rendered = probeFailed.join("\n");
      expect(rendered).toContain("probe failed");
      expect(rendered).toContain("credential broker unavailable");
      // The two states must not render identically.
      expect(rendered).not.toBe(cleanlyUnready.join("\n"));
    });

    // SUGGESTION-2 + NEW-1 residue: readiness was computed with `.some()`
    // over EVERY binding but rendered only on the `claude` tool row, so an
    // opencode binding's ready projection was reported as Claude's. The
    // probe-failure line inherited the identical `name === "claude"` gate.
    // A multi-binding plan is the only thing that can prove the fix.
    test("auth projection readiness is labelled per binding, never `.some()` on the claude row", async () => {
      const step = WIZARD_STEPS.find((s) => s.id === "system_tools");
      expect(step).toBeDefined();

      const probed = await step?.probe({
        ...tools,
        probeExactBinding: async () => [
          exactBindingReport({
            routeKey: "claude-fp",
            backend: "claude-code",
            auth: {
              kind: "claude_subscription_oauth",
              projectionReady: false,
              probe: "failed",
            },
          }),
          exactBindingReport({
            routeKey: "opencode-fp",
            backend: "opencode",
            auth: {
              kind: "opencode_chatgpt_oauth",
              projectionReady: true,
              probe: "passed",
            },
          }),
        ],
      });

      const lines = step?.render(
        { ...createInitialWizardState(), ...probed },
        { styles: false, width: 80 },
      ) as string[];
      const claudeRow = lines.find((l) => l.includes("claude:"));
      expect(claudeRow).toBeDefined();
      // The claude row reports the CLAUDE binding, which is unavailable.
      expect(claudeRow).toContain("auth projection: unavailable");

      // The opencode binding's ready projection is still reported — under
      // its own backend, never folded into the claude row.
      const openCodeLine = lines.find((l) => l.includes("opencode"));
      expect(openCodeLine).toBeDefined();
      expect(openCodeLine).toContain("auth projection: ready");

      for (const line of lines) {
        expect(line).not.toContain("\x1b");
      }
    });

    // SUGGESTION-6: both tests above inject `probeExactBinding`, so the real
    // fallback — `collectDoctorExactBindingReports` with the wizard's own
    // `workspaceRoot` and its constructed `authorityDeps` — had no coverage
    // at all. These two drive it for real, with NO probe seam: the error text
    // can only come from `resolveClaudeCanonicalBinary`, which proves the
    // injected `existsFn` reached the real authority resolver through
    // `prepareProductionRunnerAuthority`.
    test("without the probe seam the wizard drives the real exact-binding collector via deps.exists", async () => {
      const step = WIZARD_STEPS.find((s) => s.id === "system_tools");
      expect(step).toBeDefined();

      const probed = await step?.probe({
        cwd: "/repo",
        home: "/home/user",
        exists: () => false,
        checkToolsOptions: {
          which: (bin: string) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(probed?.exactBindingAuthProjections).toEqual([]);
      expect(probed?.exactBindingProbeError).toBe(
        "claude binary not found on PATH",
      );
    });

    test("the authorityDeps fallback also honours checkToolsOptions.exists", async () => {
      const step = WIZARD_STEPS.find((s) => s.id === "system_tools");
      expect(step).toBeDefined();

      // No `deps.exists` at all — the `deps.exists ?? deps.checkToolsOptions
      // ?.exists` fallback is the only thing that can reach the resolver.
      const probed = await step?.probe({
        cwd: "/repo",
        home: "/home/user",
        checkToolsOptions: {
          which: (bin: string) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          exists: () => false,
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(probed?.exactBindingProbeError).toBe(
        "claude binary not found on PATH",
      );
    });

    test("a plan-wide probe failure is rendered even when the claude tool row is missing", () => {
      const step = WIZARD_STEPS.find((s) => s.id === "system_tools");
      expect(step).toBeDefined();

      // The probe throws for the WHOLE plan, so its failure belongs to no
      // single binding — gating it on an installed `claude` row hid it.
      const lines = step?.render(
        {
          ...createInitialWizardState(),
          toolStatuses: {
            git: { installed: true, version: "2.0.0" },
          } as never,
          exactBindingProbeError: "credential broker unavailable",
        },
        { styles: false, width: 80 },
      ) as string[];

      const rendered = lines.join("\n");
      expect(rendered).toContain("probe failed");
      expect(rendered).toContain("credential broker unavailable");
    });
  });
});

// ---------------------------------------------------------------------------
// The state-production path, driven for real.
//
// Every assertion below runs the SAME accumulation loop `pr-hero setup` runs
// (`runWizardSteps`) and renders whatever state it produced. Nothing here
// hand-builds a `WizardState`: the previous version of this block did, with
// `Object.assign(state, { workspaceCommitted: true })` and friends, and that
// is precisely how a `repoScaffolded` flag that never meant what its name said
// passed a green suite. A fabricated state proves the RENDERER agrees with
// itself; it proves nothing about the flag production actually sets.
// ---------------------------------------------------------------------------

function wizardFixture(input: {
  isRepo: boolean;
  files?: Record<string, string>;
}): {
  deps: WizardDeps;
  files: Record<string, string>;
  executed: string[][];
} {
  const files: Record<string, string> = { ...(input.files ?? {}) };
  const executed: string[][] = [];
  const deps: WizardDeps = {
    cwd: "/repo",
    home: "/home/user",
    // `Object.hasOwn`, not a truthiness test: an empty file EXISTS, and a
    // gotchas file that exists-but-is-empty is one of the states this block
    // has to be able to express.
    exists: (p: string) => Object.hasOwn(files, p),
    readFile: (p: string) => files[p],
    writeFile: async (p: string, c: string) => {
      files[p] = c;
    },
    // Without this the step-1 probe runs the REAL capability collection
    // against the real workspace — ambient state inside a test that believes
    // it faked its I/O.
    probeExactBinding: async () => [],
    // `null`, matching Bun.which's own return type. No binary is found, so
    // checkSystemTools issues no version/auth exec of its own and the only
    // commands reaching `exec` below are the wizard's own git probes.
    checkToolsOptions: { which: () => null },
    exec: async (cmd: string[]) => {
      executed.push(cmd);
      if (cmd[0] === "git" && !input.isRepo) {
        return { exitCode: 128, stdout: "", stderr: "not a git repository" };
      }
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        return { exitCode: 0, stdout: "true\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, files, executed };
}

describe("runWizardSteps — the loop `runWizard` renders", () => {
  test("returns the accumulated state, parked on the last step", async () => {
    const { deps } = wizardFixture({ isRepo: true });
    const state = await runWizardSteps(deps);
    // renderWizardStep reads `stepIndex`, so the step a real `pr-hero setup`
    // prints is whichever one the loop left it on.
    expect(state.stepIndex).toBe(WIZARD_STEPS.length - 1);
    expect(state.completed).toBe(true);
    expect(state.setupStateWritten).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 5 must not end on a lie — driven through the real state-production
// path, never a fabricated state.
//
// `runWizardSteps` dispatches no reducer actions (nothing in production calls
// `wizardReducer` at all), so `commitChoice` is ALWAYS undefined here and
// `workspaceCommitted` is ALWAYS false. Two of the old tests in this block
// overrode exactly those two fields to assert the short ending; both were
// asserting branches production cannot reach. They are gone. The short ending
// is reached below the way a user reaches it: a repo whose `.crysk/` files
// already exist, so this run wrote nothing.
// ---------------------------------------------------------------------------

const REAL_GOTCHAS = `# Repo gotchas

- billing: a subscription run files a notional figure, never cash.
- isolation: a credential projection owns the credential, not just the home.
`;

async function verificationLines(input: {
  isRepo: boolean;
  files?: Record<string, string>;
  styles?: boolean;
}): Promise<{ lines: string[]; files: Record<string, string> }> {
  const { deps, files } = wizardFixture(input);
  const state = await runWizardSteps(deps);
  return {
    lines: renderWizardStep(state, {
      styles: input.styles ?? false,
      width: 80,
    }),
    files,
  };
}

describe("verification step — the ending matches what the run actually did", () => {
  test("a fresh repo: this run scaffolded both files, so both warnings are printed", async () => {
    const { lines, files } = await verificationLines({ isRepo: true });
    const text = lines.join("\n");
    // Precondition, asserted rather than assumed: the run really did write a
    // placeholder gotchas file, which is what makes both halves TRUE here.
    expect(files["/repo/.crysk/config.json"]).toBeDefined();
    expect(gotchasUnusableReason(files["/repo/.crysk/gotchas.md"])).toBe(
      "placeholder",
    );

    expect(text).toContain(initGitReminder());
    expect(text).toContain(".crysk/gotchas.md");
    expect(text).toContain(GOTCHAS_PLACEHOLDER_MARKER);
  });

  test("...and both land BEFORE the line telling you to run a review", async () => {
    // Ordering is the whole point: advice that arrives after the instruction
    // it qualifies is advice the reader has already acted against.
    const { lines } = await verificationLines({ isRepo: true });
    const reviewLine = lines.findIndex((l) => l.includes("crysk review"));
    const reminderLine = lines.findIndex((l) =>
      l.includes(initGitReminder().slice(0, 40)),
    );
    const gotchasLine = lines.findIndex((l) =>
      l.includes(GOTCHAS_PLACEHOLDER_MARKER),
    );
    expect(reviewLine).toBeGreaterThan(-1);
    expect(reminderLine).toBeGreaterThan(-1);
    expect(gotchasLine).toBeGreaterThan(-1);
    expect(reminderLine).toBeLessThan(reviewLine);
    expect(gotchasLine).toBeLessThan(reviewLine);
  });

  test("the longer ending emits zero ANSI bytes with styles off", async () => {
    const { lines } = await verificationLines({ isRepo: true, styles: false });
    for (const line of lines) {
      expect(line).not.toContain("\x1b");
    }
  });

  // THE regression. A repo that ran `pr-hero setup` in a previous session,
  // committed `.crysk/`, and wrote real gotchas into it re-runs setup: this
  // run writes nothing into `.crysk/`, so neither "commit the untracked
  // .crysk/" nor "the one just scaffolded is a placeholder" is true of it.
  // Both were printed anyway, because `repoScaffolded` meant "cwd is a git
  // repo".
  test("a repo whose .crysk/ already holds real gotchas gets NEITHER warning", async () => {
    const { lines, files } = await verificationLines({
      isRepo: true,
      files: {
        "/repo/.crysk/config.json": '{"default_base": "main"}\n',
        "/repo/.crysk/gotchas.md": REAL_GOTCHAS,
      },
    });
    const text = lines.join("\n");

    // The gotchas the user wrote are untouched — the claim the message would
    // be making is false in both directions.
    expect(files["/repo/.crysk/gotchas.md"]).toBe(REAL_GOTCHAS);
    expect(gotchasUnusableReason(REAL_GOTCHAS)).toBeUndefined();

    expect(text).not.toContain(initGitReminder());
    expect(text).not.toContain(GOTCHAS_PLACEHOLDER_MARKER);
    expect(text).toContain("crysk review");
  });

  // A repo still on the legacy .prhero/ is updated in place, so the closing
  // advice must name .prhero/ — a .crysk/ that was never created is not
  // something to edit or commit.
  test("a legacy .prhero/ repo is told about .prhero/, never .crysk/", async () => {
    const { lines, files } = await verificationLines({
      isRepo: true,
      files: {
        "/repo/.prhero": "",
        "/repo/.prhero/config.json": '{"default_base": "main"}\n',
      },
    });
    const text = lines.join("\n");
    expect(files["/repo/.prhero/gotchas.md"]).toBeDefined();
    expect(files["/repo/.crysk/gotchas.md"]).toBeUndefined();
    expect(text).toContain(".prhero/gotchas.md");
    expect(text).toContain(initGitReminder(".prhero"));
    expect(text).not.toContain(".crysk");
  });

  test("outside a repo nothing was scaffolded, so there is nothing to commit", async () => {
    const { lines, files } = await verificationLines({ isRepo: false });
    const text = lines.join("\n");
    expect(files["/repo/.crysk/config.json"]).toBeUndefined();
    expect(files["/repo/.crysk/gotchas.md"]).toBeUndefined();
    expect(text).not.toContain(initGitReminder());
    expect(text).not.toContain(GOTCHAS_PLACEHOLDER_MARKER);
  });
});
