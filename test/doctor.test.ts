import { describe, expect, test } from "bun:test";
import { CI_WORKFLOW_RELATIVE_PATH } from "#ci/setup";
import { aliasCanonical } from "#model/catalog";
import { routingNeedsOpenCodeSdk } from "#model/routing";
import {
  GOTCHAS_PLACEHOLDER_MARKER,
  GOTCHAS_TEMPLATE,
} from "#review/preflight";
import {
  type EngineAssets,
  resolveEngineAssets,
  selfInvocation,
} from "../src/assets";
import {
  type DoctorReport,
  openCodeRoutingSdkCheck,
  PROVIDER_HINTS,
  renderDoctorReport,
  runDoctor,
} from "../src/doctor";
import type { ExactBindingCapabilityReport } from "../src/execution/contracts";
import { buildDoctorRoutePlan } from "../src/production-runtime";
import { OpenCodeSdkUnavailableError } from "../src/transports/opencode-admission";

// These fixtures fake the MACHINE's filesystem. The engine's own bundle is not
// on it — in a compiled binary the prompts live inside the executable — so a
// fixture saying "this machine has nothing" must not also be read as "the
// shipped prompt set is broken". Every fixture that is not specifically
// probing the bundle answers for it through this.
const BUNDLED_PROMPT_PATHS = new Set(
  Object.values(resolveEngineAssets().bundledAgentFiles),
);
const bundledPromptBody = (p: string): string | undefined =>
  BUNDLED_PROMPT_PATHS.has(p) ? "# bundled prompt\n" : undefined;

describe("doctor tri-state evaluation", () => {
  test("healthy when all checks pass", async () => {
    const self = selfInvocation();
    const report = await runDoctor({
      cwd: "/repo",
      home: "/home/user",
      exists: (p) => {
        if (p === "/repo/.prhero/gotchas.md") return true;
        if (p === "/repo/.codegraph") return true;
        if (p === "/home/user/.prhero/setup.json") return true;
        if (p === "/home/user/.claude/mcp.json") return true;
        if (p.includes(".claude/skills/")) return true;
        if (p === `/repo/${CI_WORKFLOW_RELATIVE_PATH}`) return true;
        return false;
      },
      readFile: (p) => {
        if (p === "/repo/.prhero/gotchas.md")
          return "## Gotchas\nDo not mutate state.";
        if (p === "/home/user/.claude/mcp.json")
          return JSON.stringify({
            mcpServers: {
              "pr-hero": {
                command: self.command,
                args: [...self.args, "mcp"],
              },
            },
          });
        if (p.endsWith("digest.json")) {
          return JSON.stringify({
            files: {
              "SKILL.md": "mock_hash",
              "adjudicator.md": "mock_hash",
              "assets/workflow.yml": "mock_hash",
            },
          });
        }
        if (
          p.endsWith("SKILL.md") ||
          p.endsWith("adjudicator.md") ||
          p.endsWith("workflow.yml") ||
          p.endsWith("admission-config.example.json") ||
          p.endsWith("ci-admission.md") ||
          p.endsWith("opencode-ci.md")
        ) {
          // If reading either the upstream asset or the synced copy, return the same content
          return "same mock content";
        }
        return bundledPromptBody(p);
      },
      checkToolsOptions: {
        which: (bin) =>
          ["git", "claude", "gh", "codegraph"].includes(bin)
            ? `/bin/${bin}`
            : null,
        exec: async (cmd) => {
          if (cmd.includes("git"))
            return { exitCode: 0, stdout: "git version 2.40.0", stderr: "" };
          if (cmd.includes("claude"))
            return { exitCode: 0, stdout: "1.0.0", stderr: "" };
          if (cmd.includes("gh"))
            return { exitCode: 0, stdout: "gh version 2.30.0", stderr: "" };
          if (cmd.includes("codegraph"))
            return { exitCode: 0, stdout: "codegraph 0.5.0", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        env: { ANTHROPIC_API_KEY: "sk-test" },
      },
    });

    expect(report.overall).toBe("healthy");
    expect(report.exitCode).toBe(0);
    expect(report.checks.every((c) => c.severity === "healthy")).toBe(true);
  });

  describe("blocking cases (exitCode: 1)", () => {
    test("git missing is blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: (bin) => (bin === "git" ? null : `/bin/${bin}`),
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const gitCheck = report.checks.find((c) => c.name === "git");
      expect(gitCheck?.severity).toBe("blocking");
    });

    test("claude missing is blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: (bin) => (bin === "claude" ? null : `/bin/${bin}`),
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        },
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const claudeCheck = report.checks.find((c) => c.name === "claude");
      expect(claudeCheck?.severity).toBe("blocking");
    });

    test("claude unauthenticated is blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: {}, // no auth
        },
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const claudeCheck = report.checks.find((c) => c.name === "claude");
      expect(claudeCheck?.severity).toBe("blocking");
    });

    test("stale agents_dir pointing at missing path is blocking with fallback hint", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => {
          if (p === "/repo/.prhero/config.json") return true;
          if (p === "/repo/.prhero/gotchas.md") return true;
          if (p === "/home/user/.prhero/setup.json") return true;
          return false;
        },
        readFile: (p) => {
          if (p === "/repo/.prhero/config.json") {
            return JSON.stringify({ agents_dir: "/missing/old/path" });
          }
          if (p === "/repo/.prhero/gotchas.md") return "## Gotchas\nContent";
          return undefined;
        },
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const agentsCheck = report.checks.find((c) => c.name === "agents_dir");
      expect(agentsCheck?.severity).toBe("blocking");
      expect(agentsCheck?.hint).toContain("Delete");
      expect(agentsCheck?.hint).toContain("bundled default");
    });

    test("missing or empty gotchas.md in current repo is blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/home/user/.prhero/setup.json",
        readFile: () => "   ", // empty
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const gotchasCheck = report.checks.find((c) => c.name === "gotchas");
      expect(gotchasCheck?.severity).toBe("blocking");
    });

    // Without this, `doctor` and `review` disagree about the same file:
    // doctor prints "Repository gotchas present" and a green overall, then
    // the review the user runs on that advice refuses. A diagnostic whose
    // healthy verdict does not survive the next command is worse than no
    // diagnostic — the user believes the problem is elsewhere.
    test("a still-scaffolded gotchas.md is blocking, not 'present'", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md" ? GOTCHAS_TEMPLATE : undefined,
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      // Deliberately NOT asserting report.overall/exitCode here: this fixture
      // resolves no agents_dir, so `overall` is already "blocking" for an
      // unrelated reason and would pass whatever the gotchas check said. Only
      // the gotchas check itself discriminates.
      const gotchasCheck = report.checks.find((c) => c.name === "gotchas");
      expect(gotchasCheck?.severity).toBe("blocking");
      // The message has to name what is wrong with THIS file: "empty or
      // missing" would send the reader looking for a file they can see.
      expect(gotchasCheck?.message).not.toContain("empty or missing");
      expect(gotchasCheck?.hint).toContain(GOTCHAS_PLACEHOLDER_MARKER);
    });
  });

  describe("degraded cases (exitCode: 0 with hints)", () => {
    test("gh missing is degraded, not blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: (bin) => (bin === "gh" ? null : `/bin/${bin}`),
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("degraded");
      expect(report.exitCode).toBe(0);
      const ghCheck = report.checks.find((c) => c.name === "gh");
      expect(ghCheck?.severity).toBe("degraded");
      expect(ghCheck?.hint).toBeDefined();
    });

    test("codegraph unindexed is degraded, not blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) =>
          p === "/repo/.prhero/gotchas.md" ||
          p === "/home/user/.prhero/setup.json",
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("degraded");
      expect(report.exitCode).toBe(0);
      const cgCheck = report.checks.find((c) => c.name === "codegraph");
      expect(cgCheck?.severity).toBe("degraded");
      // The exact upstream command, opening quote included (see system-tools.test.ts).
      expect(cgCheck?.hint).toContain("Run 'codegraph init'");
    });

    test("setup.json missing is degraded with init hint", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md", // setup.json missing
        readFile: () => "## Gotchas\nContent",
        checkToolsOptions: {
          which: () => "/bin/tool",
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          exists: (p) => p === "/repo/.codegraph",
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("degraded");
      expect(report.exitCode).toBe(0);
      const setupCheck = report.checks.find((c) => c.name === "setup");
      expect(setupCheck?.severity).toBe("degraded");
      expect(setupCheck?.hint).toContain("pr-hero init");
    });

    test("skills not synced reports degraded with hint", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return true;
          if (p === "/repo/.codegraph") return true;
          if (p === "/home/user/.prhero/setup.json") return true;
          if (p === "/home/user/.claude/mcp.json") return true;
          // Skills not synced
          return false;
        },
        readFile: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return "## Gotchas\nContent";
          return bundledPromptBody(p);
        },
        checkToolsOptions: {
          which: (bin) => (bin === "claude" ? "/bin/claude" : `/bin/${bin}`),
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("degraded");
      const skillsCheck = report.checks.find((c) =>
        c.name.startsWith("skills:"),
      );
      expect(skillsCheck?.severity).toBe("degraded");
      expect(skillsCheck?.hint).toBeDefined();
    });

    test("mcp server not registered reports degraded with hint", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return true;
          if (p === "/repo/.codegraph") return true;
          if (p === "/home/user/.prhero/setup.json") return true;
          // MCP not registered
          return false;
        },
        readFile: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return "## Gotchas\nContent";
          return bundledPromptBody(p);
        },
        checkToolsOptions: {
          which: (bin) => (bin === "claude" ? "/bin/claude" : `/bin/${bin}`),
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(report.overall).toBe("degraded");
      const mcpCheck = report.checks.find((c) => c.name.startsWith("mcp:"));
      expect(mcpCheck?.severity).toBe("degraded");
      expect(mcpCheck?.hint).toBeDefined();
    });
  });

  describe("provider capability section (§11/D1-09)", () => {
    test("blocking report issue propagates to overall blocking and exitCode 1", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : bundledPromptBody(p),
        checkToolsOptions: {
          which: (bin) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
        produceCapabilityReport: async () => ({
          backend: "claude-code",
          status: "blocking",
          auth: {
            kind: "claude_subscription_oauth",
            projectionReady: false,
            probe: "failed",
          },
          isolation: {
            syntheticHome: false,
            workspaceReadBroker: true,
            codegraphPolicy: false,
          },
          protocol: {
            terminalProof: true,
            boundedEvents: false,
            usageMode: "snapshot",
          },
          cancellation: { deadlineMs: 7500, conformance: "passed" },
          billing: { mode: "subscription", pricingReady: false },
          issues: [
            {
              code: "auth_failed",
              message: "claude authentication not detected",
              blocking: true,
            },
          ],
        }),
      });

      expect(report.overall).toBe("blocking");
      expect(report.exitCode).toBe(1);
      const providerCheck = report.checks.find(
        (c) => c.name === "provider:auth_failed",
      );
      expect(providerCheck?.severity).toBe("blocking");
    });

    test("non-blocking issues render degraded with a hint and do not fail the run", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : bundledPromptBody(p),
        checkToolsOptions: {
          which: (bin) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
        produceCapabilityReport: async () => ({
          backend: "claude-code",
          status: "degraded",
          binary: {
            absolutePath: "/bin/claude",
            sha256: "a".repeat(64),
            version: "1.0.0",
          },
          auth: {
            kind: "claude_subscription_oauth",
            projectionReady: true,
            probe: "passed",
          },
          isolation: {
            syntheticHome: true,
            workspaceReadBroker: true,
            codegraphPolicy: false,
          },
          protocol: {
            terminalProof: true,
            boundedEvents: false,
            usageMode: "snapshot",
          },
          cancellation: { deadlineMs: 7500, conformance: "passed" },
          billing: { mode: "subscription", pricingReady: false },
          issues: [
            {
              code: "pricing_table_missing",
              message: "no per-model pricing table is bundled",
              blocking: false,
            },
          ],
        }),
      });

      expect(report.overall).toBe("degraded");
      expect(report.exitCode).toBe(0);
      const providerCheck = report.checks.find(
        (c) => c.name === "provider:pricing_table_missing",
      );
      expect(providerCheck?.severity).toBe("degraded");
      expect(providerCheck?.hint).toBeDefined();
      // #197. `toBeDefined()` passes on any text, which is how the hint kept
      // claiming "Versioned pricing tables ship with the engine, one per
      // provider, and each one's age is reported by its own pricing-catalog
      // check" after both halves became false. The hint is still reachable
      // (the OpenCode transport emits this code non-blocking, and
      // pushProviderIssues attaches a hint to every non-blocking issue), so
      // the fix was honest text rather than deletion — and this is what pins
      // it.
      expect(providerCheck?.hint).not.toContain("Versioned pricing tables");
      expect(providerCheck?.hint).not.toContain("pricing-catalog");
    });

    test("a throwing producer fails loud as blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : bundledPromptBody(p),
        checkToolsOptions: {
          which: (bin) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
        produceCapabilityReport: async () => {
          throw new Error("boom");
        },
      });

      expect(report.overall).toBe("blocking");
      const providerCheck = report.checks.find((c) => c.name === "provider");
      expect(providerCheck?.severity).toBe("blocking");
      expect(providerCheck?.message).toContain("boom");
    });

    // fix/opencode-sdk-absent-degraded: a compiled binary run from a directory
    // with no `@opencode-ai/sdk` throws OpenCodeSdkUnavailableError, not the
    // generic capability-report failure above. Reporting that as `blocking`
    // told a Claude-only setup its whole environment was broken; it is
    // `degraded` because only the OpenCode route is affected.
    test("SDK-absent producer degrades instead of blocking (produceCapabilityReport)", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : bundledPromptBody(p),
        checkToolsOptions: {
          which: (bin) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
        produceCapabilityReport: async () => {
          throw new OpenCodeSdkUnavailableError(
            "@opencode-ai/sdk is not resolvable from this installation",
          );
        },
      });

      expect(report.overall).not.toBe("blocking");
      const providerCheck = report.checks.find((c) => c.name === "provider");
      expect(providerCheck?.severity).toBe("degraded");
      expect(providerCheck?.message).toContain(
        "@opencode-ai/sdk is not resolvable",
      );
      expect(providerCheck?.hint).toBeDefined();
    });

    test("SDK-absent producer degrades instead of blocking (probeExactBindings)", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : bundledPromptBody(p),
        checkToolsOptions: {
          which: (bin) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
        probeExactBindings: async () => {
          throw new OpenCodeSdkUnavailableError(
            "@opencode-ai/sdk is not resolvable from this installation",
          );
        },
      });

      expect(report.overall).not.toBe("blocking");
      const providerCheck = report.checks.find((c) => c.name === "provider");
      expect(providerCheck?.severity).toBe("degraded");
      expect(providerCheck?.message).toContain(
        "@opencode-ai/sdk is not resolvable",
      );
      expect(providerCheck?.hint).toBeDefined();
    });

    // The probe has no per-step isolation: the OpenCode identity observation
    // is awaited inside the loop that resolves every route, so the rejection
    // escapes before any capability report is built. A hint that told the
    // operator their Claude routes were unaffected claimed a verification
    // this run never performed (PR #263 review).
    test("the SDK-absent hint does not claim the rest of the plan was verified", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : bundledPromptBody(p),
        checkToolsOptions: {
          which: (bin) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
        probeExactBindings: async () => {
          throw new OpenCodeSdkUnavailableError(
            "@opencode-ai/sdk is not resolvable from this installation",
          );
        },
      });

      const hint = report.checks.find((c) => c.name === "provider")?.hint ?? "";
      expect(hint).toContain("unverified");
      expect(hint).not.toContain("unaffected");
      expect(hint).toContain("pr-hero upgrade --reconcile");
      expect(hint).not.toContain("alongside the project's node_modules");
    });

    test("a throwing probeExactBindings that is NOT SDK-absence still fails loud as blocking", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p) => p === "/repo/.prhero/gotchas.md",
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : bundledPromptBody(p),
        checkToolsOptions: {
          which: (bin) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
        probeExactBindings: async () => {
          throw new Error("boom");
        },
      });

      expect(report.overall).toBe("blocking");
      const providerCheck = report.checks.find((c) => c.name === "provider");
      expect(providerCheck?.severity).toBe("blocking");
      expect(providerCheck?.message).toContain("boom");
    });
  });

  describe("exact-binding capability facts", () => {
    const exact = (
      overrides: Partial<ExactBindingCapabilityReport> = {},
    ): ExactBindingCapabilityReport => ({
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
    });
    const base = {
      cwd: "/repo",
      home: "/home/user",
      exists: (p: string) => p === "/repo/.prhero/gotchas.md",
      readFile: () => "## Gotchas\nContent",
      checkToolsOptions: {
        which: (bin: string) => `/bin/${bin}`,
        exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
        env: { ANTHROPIC_API_KEY: "sk-test" },
      },
    };

    test("subscription pricing is non-blocking; metered missing prices block", async () => {
      const sub = await runDoctor({
        ...base,
        probeExactBindings: async () => [exact()],
      });
      expect(sub.exitCode).toBe(0);
      expect(
        sub.checks.some((c) => c.name === "provider:pricing_table_missing"),
      ).toBe(false);
      const metered = await runDoctor({
        ...base,
        probeExactBindings: async () => [
          exact({
            billing: {
              mode: "metered",
              pricingApplicability: "required",
              tokenPricingAvailable: false,
              cashCostAccountingValid: false,
            },
          }),
        ],
      });
      expect(metered.overall).toBe("blocking");
      expect(
        metered.checks.find((c) => c.name === "provider:pricing_table_missing")
          ?.severity,
      ).toBe("blocking");
    });

    test("stale ProviderCapabilityReport cannot override exact-binding facts", async () => {
      const report = await runDoctor({
        ...base,
        produceCapabilityReport: async () => ({
          backend: "claude-code",
          status: "ready",
          auth: {
            kind: "claude_subscription_oauth",
            projectionReady: true,
            probe: "passed",
          },
          isolation: {
            syntheticHome: true,
            workspaceReadBroker: true,
            codegraphPolicy: true,
          },
          protocol: {
            terminalProof: true,
            boundedEvents: true,
            usageMode: "snapshot",
          },
          cancellation: { deadlineMs: 7500, conformance: "passed" },
          billing: { mode: "subscription", pricingReady: true },
          issues: [],
        }),
        probeExactBindings: async () => [exact({ sdk: { available: false } })],
      });
      expect(report.overall).toBe("blocking");
      expect(
        report.checks.find((c) => c.name === "provider:sdk_unavailable")
          ?.severity,
      ).toBe("blocking");
    });

    test("doctor route plan constructs an OpenCode binding from routing", () => {
      const open = buildDoctorRoutePlan({
        mappings: {
          [aliasCanonical("sonnet")]: {
            backend: "opencode",
            provider: "openai",
            modelFamily: "gpt-4o",
            modelSnapshot: "gpt-4o",
            modelVariant: "high",
          },
        },
      }).steps.find((step) => step.route.backend === "opencode");
      expect(open?.route).toMatchObject({
        provider: "openai",
        modelFamily: "gpt-4o",
        modelVariant: "high",
      });
    });
  });

  // The check that was pure assertion until this suite existed: doctor
  // reported "Using bundled prompt set (default)" unconditionally, having
  // verified nothing, on the very machine whose next `review` died with
  // `agents dir does not exist: /$bunfs/root`. A green doctor beside a broken
  // review is worse than no doctor, because it is the thing people trust.
  describe("bundled prompt set", () => {
    // A COMPILED bundle, which is the mode that broke: the paths are the
    // manifest's embedded ones, so nothing here touches a real filesystem.
    const embedded: Record<string, string> = {
      "deep-review-reliability.md": "/embedded/reliability-aaaa.md",
      "deep-review-resilience.md": "/embedded/resilience-bbbb.md",
      "deep-review-lifecycle.md": "/embedded/lifecycle-cccc.md",
      "deep-review-logic.md": "/embedded/logic-ffff.md",
      "deep-review-parity.md": "/embedded/parity-dddd.md",
      "review-refuter.md": "/embedded/refuter-eeee.md",
    };
    const compiledAssets = (files: Record<string, string>): EngineAssets => ({
      ...resolveEngineAssets(),
      mode: "compiled",
      bundledAgentFiles: files,
    });

    const baseOptions = {
      cwd: "/repo",
      home: "/home/user",
      exists: (p: string) =>
        p === "/repo/.prhero/gotchas.md" ||
        p === "/home/user/.prhero/setup.json",
      checkToolsOptions: {
        which: (bin: string) => `/bin/${bin}`,
        exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
        env: { ANTHROPIC_API_KEY: "sk-test" },
      },
    };

    test("every prompt the review spec names is readable -> healthy", async () => {
      const report = await runDoctor({
        ...baseOptions,
        assets: compiledAssets(embedded),
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : "# a prompt body\n",
      });

      const check = report.checks.find((c) => c.name === "agents_dir");
      expect(check?.severity).toBe("healthy");
      expect(check?.message).toContain("6");
    });

    test("a prompt that cannot be read is blocking, named by its logical file", async () => {
      const report = await runDoctor({
        ...baseOptions,
        assets: compiledAssets(embedded),
        readFile: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return "## Gotchas\nContent";
          if (p === "/embedded/refuter-eeee.md") return undefined;
          return "# a prompt body\n";
        },
      });

      const check = report.checks.find((c) => c.name === "agents_dir");
      expect(check?.severity).toBe("blocking");
      expect(check?.message).toContain("review-refuter.md");
      // The logical name, never the embedded path: "/$bunfs/root/<hash>.md" is
      // actionable to nobody and names a file that exists on no machine.
      expect(check?.message).not.toContain("/embedded/");
      expect(check?.hint).toBeDefined();
    });

    test("an empty prompt is as broken as a missing one", async () => {
      const report = await runDoctor({
        ...baseOptions,
        assets: compiledAssets(embedded),
        readFile: (p) => {
          if (p === "/repo/.prhero/gotchas.md") return "## Gotchas\nContent";
          if (p === "/embedded/parity-dddd.md") return "   \n";
          return "# a prompt body\n";
        },
      });

      const check = report.checks.find((c) => c.name === "agents_dir");
      expect(check?.severity).toBe("blocking");
      expect(check?.message).toContain("deep-review-parity.md");
    });

    test("a manifest the build never embedded is blocking, not a crash", async () => {
      const { "review-refuter.md": _dropped, ...incomplete } = embedded;
      const report = await runDoctor({
        ...baseOptions,
        assets: compiledAssets(incomplete),
        readFile: (p) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : "# a prompt body\n",
      });

      const check = report.checks.find((c) => c.name === "agents_dir");
      expect(check?.severity).toBe("blocking");
      expect(check?.message).toContain("review-refuter.md");
    });
  });

  // #197 deleted the bundled rate tables, and doctor's five
  // `pricing-catalog:<provider>` arms with them. Nothing replaces them: with
  // no table there is no table age to report, and a diagnostic that invents a
  // check is worse than one that is absent. A "does the transport report
  // cost?" row is not the substitute either — that is a static capability
  // claim admission already gates on, and a second copy in doctor is two
  // places to disagree.
  //
  // This arm is the guard against the check quietly coming back, and against
  // the wall-clock time bomb it used to be: the all-healthy fixture above no
  // longer injects a clock, so a reintroduced freshness row would turn that
  // test red on a calendar date with no commit behind it.
  describe("pricing catalog checks are gone (#197)", () => {
    test("doctor reports no pricing-catalog row and needs no clock to stay healthy", async () => {
      const report = await runDoctor({
        cwd: "/repo",
        home: "/home/user",
        exists: (p: string) => p === "/repo/.prhero/gotchas.md",
        readFile: (p: string) =>
          p === "/repo/.prhero/gotchas.md"
            ? "## Gotchas\nContent"
            : bundledPromptBody(p),
        checkToolsOptions: {
          which: (bin: string) => `/bin/${bin}`,
          exec: async () => ({ exitCode: 0, stdout: "1.0.0", stderr: "" }),
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      });

      expect(
        report.checks.filter((c) => c.name.startsWith("pricing-catalog")),
      ).toEqual([]);
    });
  });

  describe("PROVIDER_HINTS reachability", () => {
    test("cash_cost_accounting_invalid has no hint entry (the issue is always blocking, so pushProviderIssues never attaches its hint)", () => {
      expect(Object.keys(PROVIDER_HINTS)).not.toContain(
        "cash_cost_accounting_invalid",
      );
    });
  });

  describe("renderDoctorReport", () => {
    test("renders report lines with styles: false containing zero ANSI escape bytes", () => {
      const report: DoctorReport = {
        overall: "degraded",
        exitCode: 0,
        checks: [
          { name: "git", severity: "healthy", message: "git version 2.40.0" },
          {
            name: "gh",
            severity: "degraded",
            message: "gh missing",
            hint: "brew install gh",
          },
        ],
      };

      const lines = renderDoctorReport(report, { styles: false, width: 80 });
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain("\x1b");
      }
    });
  });
});

const openCodeDefault = {
  backend: "opencode" as const,
  provider: "opencode",
};
const claudeDefault = {
  backend: "claude-code" as const,
  provider: "anthropic",
};

describe("routingNeedsOpenCodeSdk", () => {
  test("undefined, disabled routing, and Claude-only routing do not need the SDK", () => {
    expect(routingNeedsOpenCodeSdk(undefined)).toBe(false);
    expect(
      routingNeedsOpenCodeSdk({
        disabled: true,
        default: openCodeDefault,
      }),
    ).toBe(false);
    expect(routingNeedsOpenCodeSdk({ default: claudeDefault })).toBe(false);
    expect(
      routingNeedsOpenCodeSdk({
        default: { ...openCodeDefault, disabled: true },
      }),
    ).toBe(false);
    expect(
      routingNeedsOpenCodeSdk({
        default: { ...openCodeDefault, allowSpend: false },
      }),
    ).toBe(false);
  });

  test("an enabled OpenCode default or mapping needs the SDK", () => {
    expect(routingNeedsOpenCodeSdk({ default: openCodeDefault })).toBe(true);
    expect(
      routingNeedsOpenCodeSdk({
        default: claudeDefault,
        mappings: [
          { logical: "sonnet", ...openCodeDefault },
          { logical: "opus", ...claudeDefault, allowSpend: false },
        ],
      }),
    ).toBe(true);
    expect(
      routingNeedsOpenCodeSdk({
        mappings: { sonnet: openCodeDefault },
      }),
    ).toBe(true);
    expect(
      routingNeedsOpenCodeSdk({
        default: claudeDefault,
        mappings: { sonnet: { ...openCodeDefault, disabled: true } },
      }),
    ).toBe(false);
  });
});

describe("openCodeRoutingSdkCheck", () => {
  test("no OpenCode routing or the pinned version adds no row", () => {
    expect(
      openCodeRoutingSdkCheck({
        routing: { default: claudeDefault },
        sdkVersion: undefined,
      }),
    ).toBeUndefined();
    expect(
      openCodeRoutingSdkCheck({
        routing: { default: openCodeDefault },
        sdkVersion: "1.18.25",
      }),
    ).toBeUndefined();
  });

  test("a missing SDK blocks with the reconcile message", () => {
    for (const sdkVersion of [undefined, "", "   "]) {
      const item = openCodeRoutingSdkCheck({
        routing: { default: openCodeDefault },
        sdkVersion,
      });
      expect(item?.severity).toBe("blocking");
      expect(item?.message).toContain("pr-hero upgrade --reconcile");
      expect(item?.message).toContain("@opencode-ai/sdk@1.18.25");
      expect(item?.message).toContain("~/.prhero/node_modules");
      expect(item?.message).not.toContain("undefined");
    }
  });

  test("any other installed version blocks and names both versions", () => {
    const item = openCodeRoutingSdkCheck({
      routing: { default: openCodeDefault },
      sdkVersion: "1.18.26",
    });
    expect(item?.severity).toBe("blocking");
    expect(item?.message).toContain("1.18.26");
    expect(item?.message).toContain("1.18.25");
    expect(item?.message).toContain("pr-hero upgrade --reconcile");
  });
});
