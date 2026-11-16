// odd/tasks/antigravity-oauth.md T4 (S5, S6): a whole agy step through the
// harness, with the real broker and transport and a fake `agy`: the agent and
// settings land in the projected home, the token never reaches the operator's
// HOME, and agy's recorded login failure ends the step without a retry.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StepExecutionHarness } from "../../src/execution/harness";
import { AgyCredentialBroker } from "../../src/security/credential-broker";
import { AgyCliTransport } from "../../src/transports/agy-cli";

const FAKE_AGY = path.resolve(import.meta.dir, "../fixtures/agy/fake-agy.sh");

const RECORD = JSON.stringify({
  type: "oauth",
  access: "ya29.fake-access",
  refresh: "1//fake-refresh",
  expires: 1,
  accountId: "dev@example.com",
});

let dir = "";
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "crysk-agy-step-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// The child env is the harness's allowlist, so the scenario rides a wrapper.
function agyFor(scenario: string): string {
  const wrapper = path.join(dir, `agy-${scenario}`);
  writeFileSync(
    wrapper,
    `#!/bin/sh\nFAKE_AGY_SCENARIO=${scenario} exec "${FAKE_AGY}" "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

async function runStep(scenario: string, maxAttempts = 3) {
  const systemPromptPath = path.join(dir, "system.md");
  writeFileSync(systemPromptPath, "You are a hunter.\n", { mode: 0o600 });
  const cwd = path.join(dir, "ws");
  await Bun.write(path.join(cwd, ".keep"), "");
  const homes: string[] = [];
  const broker = new AgyCredentialBroker({ readerFn: async () => RECORD });
  const harness = new StepExecutionHarness({
    transport: new AgyCliTransport({ spawnFn: Bun.spawn }),
    spawnFn: Bun.spawn,
    binaryPath: agyFor(scenario),
    childEnv: { HOME: "/Users/operator-real-home", PATH: "/usr/bin:/bin" },
    credentialBroker: {
      project: async (input) => {
        const projection = await broker.project(input);
        homes.push(projection.syntheticHome);
        return projection;
      },
    },
    sleep: async () => {},
  });
  const result = await harness.run({
    name: "hunter-logic",
    systemPromptPath,
    prompt: "Review this patch.",
    tools: ["Read", "Grep"],
    model: "gemini-4-argon-high",
    effort: "high",
    cwd,
    outPath: path.join(dir, "out.json"),
    // agy reads MCP servers only from the projected home; this path is ignored.
    mcpConfigPath: path.join(dir, "mcp.json"),
    timeoutMs: 20_000,
    maxAttempts,
    parse: (text) => JSON.parse(text),
    route: {
      backend: "antigravity",
      provider: "google",
      modelFamily: "gemini-4-argon-high",
      modelSnapshot: "gemini-4-argon-high",
    },
    credentialKind: "antigravity_subscription_oauth",
    credentialRef: "antigravity-oauth",
  });
  return { result, homes };
}

describe("an agy step through the harness", () => {
  test("succeeds inside its projected home, which is destroyed after", async () => {
    const { result, homes } = await runStep("success");
    expect(result.status).toBe("ok");
    expect(result.resultText).toBe('{"findings":[]}');
    expect(result.attempts).toBe(1);
    expect(homes).toHaveLength(1);
    const home = homes[0] ?? "";
    expect(home.startsWith(tmpdir())).toBe(true);
    // destroy() removed the token, the agent and the settings with the home.
    expect(await Bun.file(path.join(home, ".gemini")).exists()).toBe(false);
  });

  test("the recorded login failure is auth_invalid, terminal, and names the secret", async () => {
    const { result } = await runStep("auth");
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(result.failureCause).toBe("auth_invalid");
    expect(result.failureCredential).toBe("CRYSK_ANTIGRAVITY_OAUTH");
    expect(result.stderrTail).not.toContain("fake-refresh");
    expect(result.stderrTail).not.toContain("fake-access");
  });

  test("an unavailable service is retried", async () => {
    const { result, homes } = await runStep("unavailable", 2);
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(2);
    expect(result.failureCause).toBe("network_transient");
    // One projection per step; every attempt runs in it.
    expect(homes).toHaveLength(1);
  });

  // Every failure shape agy can leave has a typed cause, so none reaches the
  // legacy classifier's format retry.
  for (const [scenario, cause, attempts] of [
    ["error-no-line", "provider_configuration_invalid", 1],
    ["short-unknown", "provider_configuration_invalid", 1],
    ["quota", "quota_exhausted", 1],
    ["no-result", "protocol_truncation", 2],
  ] as const) {
    test(`${scenario} ends as ${cause} after ${attempts} attempt(s)`, async () => {
      const { result } = await runStep(scenario, 2);
      expect(result.status).toBe("failed");
      expect(result.failureCause).toBe(cause);
      expect(result.attempts).toBe(attempts);
    });
  }
});
