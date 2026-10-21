// CLI decomposition P2.1 (odd/tasks/cli-decomposition.md): the pure stages
// `review()` and `reviewPr()` walk identically (or near-identically), pulled
// out of cli.ts so the duplication lives in exactly one place. Every stage
// here reproduces the orchestrators' CURRENT behaviour exactly — this is a
// pure extraction, not a redesign — so each test asserts the concrete values
// the two functions produce today, not a restatement of the implementation.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GOTCHAS_PLACEHOLDER_MARKER, localReviewSpec } from "#review/preflight";
import {
  admissionGateFor,
  assertDistinctRange,
  buildTelemetry,
  CODEGRAPH_ONLY_MCP_CONFIG,
  computeDiffStatAndSizeGate,
  EMPTY_MCP_CONFIG,
  prepareRunnerForRoute,
  resolveGotchasPath,
  resolveParityFires,
  resolvePromptSet,
  selectActiveHunters,
  validateGotchas,
  writeMcpConfig,
} from "#review/run";
import { ClaudeCodeRunner } from "#review/step-runner";
import { loadEffectiveConfig } from "../../src/config/config";
import { CliError, recordClassOf } from "../../src/errors";

describe("assertDistinctRange", () => {
  test("distinct base and head shas: no throw", () => {
    expect(() => assertDistinctRange("aaa111", "bbb222")).not.toThrow();
  });

  // Exact message text pinned from cli.ts's review()/reviewPr() copies —
  // both read byte-identical apart from indentation.
  test("base === head throws CliError with the exact existing message", () => {
    expect(() => assertDistinctRange("deadbeef", "deadbeef")).toThrow(CliError);
    expect(() => assertDistinctRange("deadbeef", "deadbeef")).toThrow(
      "base and head resolve to the same commit (deadbeef); there is nothing to review",
    );
  });
});

describe("resolveGotchasPath", () => {
  test("--gotchas flag given: path.resolve() of the flag, root ignored", () => {
    expect(resolveGotchasPath("./my-gotchas.md", "/repo/root")).toBe(
      path.resolve("./my-gotchas.md"),
    );
  });

  test("no flag: <root>/.prhero/gotchas.md", () => {
    expect(resolveGotchasPath(undefined, "/repo/root")).toBe(
      path.join("/repo/root", ".prhero", "gotchas.md"),
    );
  });

  test("works for each of the three roots this replaces (repoRoot / operatorRoot / repoDir)", () => {
    for (const root of ["/repo/root", "/operator/root", "/some/repo/dir"]) {
      expect(resolveGotchasPath(undefined, root)).toBe(
        path.join(root, ".prhero", "gotchas.md"),
      );
    }
  });
});

describe("selectActiveHunters", () => {
  const hunterA = {
    key: "a",
    file: "a.md",
    role: "hunter" as const,
  };
  const hunterConditional = {
    key: "b",
    file: "b.md",
    role: "hunter" as const,
    trigger: "input" as const,
  };
  const refuter = {
    key: "refuter",
    file: "refuter.md",
    role: "refuter" as const,
  };

  test("unconditional hunters always run, refuters never do", () => {
    const active = selectActiveHunters([hunterA, refuter], false);
    expect(active).toEqual([hunterA]);
  });

  test("a triggered hunter is excluded when parity does not fire", () => {
    const active = selectActiveHunters([hunterA, hunterConditional], false);
    expect(active).toEqual([hunterA]);
  });

  test("a triggered hunter is included when parity fires", () => {
    const active = selectActiveHunters([hunterA, hunterConditional], true);
    expect(active).toEqual([hunterA, hunterConditional]);
  });
});

describe("buildTelemetry", () => {
  const baseResult = {
    usage: {
      wall_ms: 0,
      tokens_in: 10,
      tokens_out: 20,
      tokens_total: 30,
      cost_usd_est: 0.5,
    },
    perAgent: { reliability: { tokens_total: 30, duration_ms: 100 } },
    unresolved: [],
  } as unknown as Parameters<typeof buildTelemetry>[0];

  test("local mode shape: indexMs 0, no cost_usd_est_is_floor when unresolved is empty", () => {
    const telemetry = buildTelemetry(baseResult, 12345, 0);
    expect(telemetry).toEqual({
      index_ms: 0,
      index_mode: "sync",
      index_disk_mb: 0,
      wall_ms: 12345,
      tokens_in: 10,
      tokens_out: 20,
      tokens_total: 30,
      cost_usd_est: 0.5,
      per_agent: { reliability: { tokens_total: 30, duration_ms: 100 } },
    });
  });

  test("PR mode shape: a measured indexMs is passed through", () => {
    const telemetry = buildTelemetry(baseResult, 999, 4321);
    expect(telemetry.index_ms).toBe(4321);
    expect(telemetry.wall_ms).toBe(999);
  });

  test("a non-empty unresolved list sets cost_usd_est_is_floor: true", () => {
    const resultWithUnresolved = {
      ...baseResult,
      unresolved: [{ reservationId: "r1" }],
    } as unknown as Parameters<typeof buildTelemetry>[0];
    const telemetry = buildTelemetry(resultWithUnresolved, 1, 0);
    expect(telemetry.cost_usd_est_is_floor).toBe(true);
  });
});

describe("writeMcpConfig / validateGotchas (P2.2)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("writeMcpConfig writes the codegraph server config when available", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-mcp-"));
    const mcpConfigPath = path.join(dir, "mcp.json");
    await writeMcpConfig(mcpConfigPath, true);
    expect(JSON.parse(await Bun.file(mcpConfigPath).text())).toEqual(
      CODEGRAPH_ONLY_MCP_CONFIG,
    );
  });

  test("writeMcpConfig writes the empty config when codegraph is unavailable", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-mcp-"));
    const mcpConfigPath = path.join(dir, "mcp.json");
    await writeMcpConfig(mcpConfigPath, false);
    expect(JSON.parse(await Bun.file(mcpConfigPath).text())).toEqual(
      EMPTY_MCP_CONFIG,
    );
  });

  test("validateGotchas resolves for real, filled-in content", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-gotchas-"));
    const gotchasPath = path.join(dir, "gotchas.md");
    await Bun.write(gotchasPath, "This repo always squashes on merge.");
    await expect(validateGotchas(gotchasPath)).resolves.toBeUndefined();
  });

  test("validateGotchas throws CliError for a missing file (empty)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-gotchas-"));
    const gotchasPath = path.join(dir, "does-not-exist.md");
    await expect(validateGotchas(gotchasPath)).rejects.toThrow(CliError);
  });

  test("validateGotchas throws CliError for the unedited scaffold marker", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-gotchas-"));
    const gotchasPath = path.join(dir, "gotchas.md");
    await Bun.write(
      gotchasPath,
      `<!-- ${GOTCHAS_PLACEHOLDER_MARKER} -->\nfill me in`,
    );
    await expect(validateGotchas(gotchasPath)).rejects.toThrow(CliError);
  });

  // T2d-1 (S2): the gotchas gate's two reasons carry their record class, and the
  // message is the one the gate always printed.
  test("validateGotchas carries the empty reason for a missing file, same message", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-gotchas-"));
    const gotchasPath = path.join(dir, "does-not-exist.md");
    const error = await validateGotchas(gotchasPath).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).cls).toEqual({
      kind: "gotchas",
      reason: "empty",
    });
    expect(
      (error as CliError).message.startsWith(
        `missing or empty gotchas file: ${gotchasPath}`,
      ),
    ).toBe(true);
  });

  test("validateGotchas carries the placeholder reason for the unedited scaffold", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-gotchas-"));
    const gotchasPath = path.join(dir, "gotchas.md");
    await Bun.write(
      gotchasPath,
      `<!-- ${GOTCHAS_PLACEHOLDER_MARKER} -->\nfill me in`,
    );
    const error = await validateGotchas(gotchasPath).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).cls).toEqual({
      kind: "gotchas",
      reason: "placeholder",
    });
    expect(
      (error as CliError).message.startsWith(
        `gotchas file is still the scaffold nobody filled in: ${gotchasPath}`,
      ),
    ).toBe(true);
  });
});

describe("resolvePromptSet: an agent file that does not parse (T2d-1)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("throws the error parseAgentFile threw, with the prompt-set class recorded beside it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pr-hero-run-promptset-"));
    const agentsDir = path.join(dir, "agents");
    await mkdir(agentsDir);
    const files = localReviewSpec({}).agents.map((agent) => agent.file);
    for (const file of files) {
      await Bun.write(path.join(agentsDir, file), "---\nname: ok\n---\nbody\n");
    }
    const broken = path.join(agentsDir, files[0] ?? "");
    await Bun.write(broken, "no frontmatter block here\n");
    const loaded = await loadEffectiveConfig({ root: dir, home: dir });

    const error = await resolvePromptSet({ agents: agentsDir }, loaded).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(Error);
    // WHY not a CliError: main() in src/cli.ts prints a CliError as one line, and a
    // local run has always let this failure take the uncaught path.
    expect(error).not.toBeInstanceOf(CliError);
    expect(recordClassOf(error)).toEqual({ kind: "prompt-set" });
    expect((error as Error).message).toBe(
      `${broken}: agent file has no frontmatter block`,
    );
    // WHY the stack is pinned: the uncaught print starts its excerpt at the top
    // frame, so the original throw site (prompt-set.ts) must stay there.
    expect((error as Error).stack ?? "").toContain("prompt-set.ts");
  });
});

describe("prepareRunnerForRoute (P2.2)", () => {
  test("legacy path (no route plan): falls back to ClaudeCodeRunner, no transport fields", async () => {
    const ceilingController = new AbortController();
    const onProgress = () => {};
    const prepared = await prepareRunnerForRoute({
      routePlan: undefined,
      productionAdmission: undefined,
      workspaceRoot: "/repo",
      runnerAuthority: {
        runnerOptions: {
          binaryPath: "/usr/local/bin/claude",
          workspaceRoot: "/repo",
          executableAllowlist: [],
        },
      },
      ceilingController,
      onProgress,
    });
    expect(prepared.productionRuntime).toBeUndefined();
    expect(prepared.deps.runner).toBeInstanceOf(ClaudeCodeRunner);
    expect(prepared.deps.ceilingController).toBe(ceilingController);
    expect(prepared.deps.onProgress).toBe(onProgress);
    expect(prepared.deps.transportRegistry).toBeUndefined();
    expect(prepared.deps.admissionEvidence).toBeUndefined();
  });
});

describe("resolveParityFires (dedup slice)", () => {
  test("fires when a changed path matches a trigger pattern", () => {
    const patch = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
    ].join("\n");
    expect(resolveParityFires(patch, ["src/**"])).toBe(true);
  });

  test("does not fire when no changed path matches any trigger", () => {
    const patch = [
      "diff --git a/docs/readme.md b/docs/readme.md",
      "+++ b/docs/readme.md",
    ].join("\n");
    expect(resolveParityFires(patch, ["src/**"])).toBe(false);
  });

  test("no trigger patterns configured: never fires", () => {
    const patch = "+++ b/src/foo.ts";
    expect(resolveParityFires(patch, [])).toBe(false);
  });
});

describe("computeDiffStatAndSizeGate", () => {
  const gateConfig = {
    maxChangedLines: 100,
    maxChangedFiles: 10,
    excludeRules: [],
  };

  test("runs --numstat then -w --ignore-blank-lines --numstat, in that order, over the given range/pathArgs", async () => {
    const calls: string[][] = [];
    const runGit = async (args: string[]) => {
      calls.push(args);
      // Both calls share the same fixture output here — the two-call CONTRACT
      // is what this test pins, not a divergent count between them.
      return { ok: true, stdout: "5\t2\tsrc/foo.ts\n", stderr: "" };
    };
    const { diffStat, sizeGate } = await computeDiffStatAndSizeGate({
      runGit,
      range: "base..head",
      pathArgs: ["--", "src/"],
      gateConfig,
    });
    expect(calls).toEqual([
      ["diff", "--numstat", "base..head", "--", "src/"],
      [
        "diff",
        "-w",
        "--ignore-blank-lines",
        "--numstat",
        "base..head",
        "--",
        "src/",
      ],
    ]);
    expect(diffStat).toEqual({ files: 1, insertions: 5, deletions: 2 });
    expect(sizeGate.ok).toBe(true);
  });

  test("the first (plain) numstat failing throws with the git diff --numstat message", async () => {
    const runGit = async () => ({ ok: false, stdout: "", stderr: "boom" });
    await expect(
      computeDiffStatAndSizeGate({
        runGit,
        range: "base..head",
        pathArgs: [],
        gateConfig,
      }),
    ).rejects.toThrow("git diff --numstat failed: boom");
  });

  test("the second (-w) numstat failing throws with the -w-specific message, first call's success notwithstanding", async () => {
    let call = 0;
    const runGit = async () => {
      call += 1;
      return call === 1
        ? { ok: true, stdout: "1\t1\tfoo.ts\n", stderr: "" }
        : { ok: false, stdout: "", stderr: "kaboom" };
    };
    await expect(
      computeDiffStatAndSizeGate({
        runGit,
        range: "base..head",
        pathArgs: [],
        gateConfig,
      }),
    ).rejects.toThrow("git diff -w --numstat failed: kaboom");
  });

  test("a whitespace-only change disappears from the GATE numstat but still bills in the diffStat", async () => {
    const runGit = async (args: string[]) => {
      const isGateNumstat = args.includes("-w");
      return {
        ok: true,
        // The plain numstat still sees the file; the -w one drops it
        // entirely — git emits no row for an all-whitespace change.
        stdout: isGateNumstat ? "" : "3\t0\tsrc/formatted.ts\n",
        stderr: "",
      };
    };
    const { diffStat, sizeGate } = await computeDiffStatAndSizeGate({
      runGit,
      range: "base..head",
      pathArgs: [],
      gateConfig,
    });
    expect(diffStat).toEqual({ files: 1, insertions: 3, deletions: 0 });
    expect(sizeGate.ok).toBe(true);
  });
});

describe("admissionGateFor (max_concurrent_steps wiring)", () => {
  test("unset cap constructs no gate, so the runtime stays unlimited", () => {
    expect(admissionGateFor(undefined)).toBeUndefined();
  });

  test("a cap of 2 holds the third attempt until one lease is released", async () => {
    const gate = admissionGateFor(2);
    expect(gate).toBeDefined();
    if (gate === undefined) return;
    const signal = new AbortController().signal;
    const attempt = (n: number) =>
      gate.acquire({
        sessionId: "s",
        attempt: n,
        rateLimitBucketId: "aiand",
        signal,
      });
    const first = await attempt(1);
    const second = await attempt(2);
    let thirdGranted = false;
    const third = attempt(3).then((lease) => {
      thirdGranted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdGranted).toBe(false);
    first.release();
    const granted = await third;
    expect(thirdGranted).toBe(true);
    second.release();
    granted.release();
  });
});
