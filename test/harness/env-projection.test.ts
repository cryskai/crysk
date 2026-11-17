import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ProviderTransport,
  TransportOutcome,
} from "../../src/execution/contracts";
import {
  projectChildEnv,
  StepExecutionHarness,
} from "../../src/execution/harness";

describe("projectChildEnv", () => {
  test("passes through only enumerated keys and never GIT_*", () => {
    const projected = projectChildEnv({
      HOME: "/Users/juanma",
      USER: "juanma",
      PATH: "/usr/bin:/bin",
      GIT_DIR: "/evil/.git",
      GIT_WORK_TREE: "/evil",
      ANTHROPIC_API_KEY: "sk-test",
      OPERATOR_SECRET: "leak-me",
    });
    expect(projected).toEqual({
      HOME: "/Users/juanma",
      USER: "juanma",
      PATH: "/usr/bin:/bin",
      ANTHROPIC_API_KEY: "sk-test",
    });
  });

  test("omits unset keys instead of writing empty strings", () => {
    const projected = projectChildEnv({ HOME: "/h", HTTPS_PROXY: undefined });
    expect(Object.keys(projected)).toEqual(["HOME"]);
  });

  // The invariant this states is "the gate and the spawn agree about what
  // counts as a credential". The capability gate accepts EITHER of these two
  // env vars as proof that claude is authenticated
  // (defaultClaudeAuthProbe, src/model/provider-capabilities.ts), so whatever it
  // accepts, the projection must carry. It did not: pr-hero's first real CI
  // self-review (2026-08-27) passed the gate on CLAUDE_CODE_OAUTH_TOKEN and
  // then died in three seconds with every step reporting "Not logged in ·
  // Please run /login", because the projection dropped that exact variable.
  // The subscription route the action, the workflow and the docs all
  // recommend as the zero-API-cost option could never have worked.
  test("carries every credential the capability gate accepts as proof of auth", () => {
    const projected = projectChildEnv({
      HOME: "/h",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
      ANTHROPIC_API_KEY: "sk-test",
    });
    expect(projected.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-test");
    expect(projected.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  // #299 (2026-10-02): pr-hero owns the effort and passes `--effort` on every
  // spawn. The CLI also reads CLAUDE_CODE_EFFORT_LEVEL, and if that variable
  // ever reached the child, an operator's shell could race the flag the engine
  // measured its defaults against. The projection is an allowlist, so today it
  // cannot; this pins that, so adding the variable to ENV_PASSTHROUGH (the
  // usual reflex when a CLI knob "needs" to be forwarded) fails here.
  test("never projects CLAUDE_CODE_EFFORT_LEVEL, so the engine's --effort cannot be overridden", () => {
    const projected = projectChildEnv({
      HOME: "/h",
      CLAUDE_CODE_EFFORT_LEVEL: "low",
    });
    expect(projected).toEqual({ HOME: "/h" });
    expect("CLAUDE_CODE_EFFORT_LEVEL" in projected).toBe(false);
  });

  test("the harness hands the projected env to the transport request", async () => {
    let seenEnv: Readonly<Record<string, string>> | undefined;
    const transport: ProviderTransport = {
      backend: "claude-code",
      capabilities: async () => {
        throw new Error("not used");
      },
      classifyFailure: () => undefined,
      async execute(request) {
        seenEnv = request.isolation.env;
        return {
          completion: "success",
          protocolIntegrity: "verified",
          finalText: "{}",
          usage: {
            wallMs: 0,
            tokens: {},
            completeness: "complete",
            billingMode: "subscription",
          },
          stderrTail: "",
        } satisfies TransportOutcome;
      },
    };
    const harness = new StepExecutionHarness({
      transport,
      // Marks the harness as offline-test (skips the production allowlist
      // gate); the custom transport above means it is never invoked.
      spawnFn: (() => ({
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn,
      childEnv: {
        HOME: "/Users/juanma",
        GIT_DIR: "/evil",
        CLAUDE_CODE_EFFORT_LEVEL: "low",
      },
    });
    // The harness hashes the system prompt before admitting the step, so it
    // must exist on disk even in this offline projection probe.
    const promptDir = await mkdtemp(path.join(tmpdir(), "pr-hero-env-probe-"));
    const systemPromptPath = path.join(promptDir, "system.md");
    await writeFile(systemPromptPath, "system prompt");
    await harness.run({
      name: "env-probe",
      systemPromptPath,
      prompt: "p",
      tools: [],
      model: "sonnet",
      effort: "high",
      cwd: "/tmp/ws",
      outPath: `/tmp/env-probe-${Date.now()}.json`,
      mcpConfigPath: "/tmp/mcp.json",
      timeoutMs: 1000,
      maxAttempts: 1,
      parse: (text) => JSON.parse(text),
    });
    expect(seenEnv).toBeDefined();
    expect(seenEnv?.HOME).toBe("/Users/juanma");
    expect(seenEnv?.GIT_DIR).toBeUndefined();
    expect(seenEnv?.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });
});
