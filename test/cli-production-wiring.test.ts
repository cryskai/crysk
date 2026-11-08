import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createResolvedRoutePlan, resolveStepRoute } from "#model/routing";
import { resolveProductionRoutePlanAtConfirm } from "../src/cli";
import type { ExactBindingCapabilityReport } from "../src/execution/contracts";
import {
  d1_11EvidenceFromExactBinding,
  prepareProductionAdmissionContext,
  productionFallbackRegistry,
  soleOpenCodeCredential,
} from "../src/production-runtime";
import { enforceProviderCapabilityGate } from "../src/review/route-preflight";
import { resolveRunClaudeCredential } from "../src/security/claude-credential";
import {
  OpenCodeApiTokenBroker,
  OpenCodeAuthBroker,
  resolveOpenCodeAuthPath,
} from "../src/security/credential-broker";
import {
  openCodeSecretManifestPath,
  serializeOpenCodeSecretManifest,
} from "../src/security/opencode-secret-manifest";
import {
  admitRoutePlan,
  type DefaultTransportRegistry,
} from "../src/transport-registry";

const mockLoadSdk = async () =>
  ({
    createOpencodeClient: () => ({
      session: {},
      event: {},
    }),
  }) as unknown as import("../src/transports/opencode-client").OpenCodeSdkLike;

async function writeExecutable(
  dir: string,
  name: string,
  body: string,
): Promise<{ canonicalPath: string; sha256: string }> {
  const filePath = path.join(dir, name);
  const script =
    name === "opencode" && body === "opencode"
      ? `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "1.18.30"\n  exit 0\nfi\nexit 0\n`
      : body.startsWith("#!")
        ? body
        : `#!/bin/sh\n${body}\n`;
  const bytes = Buffer.from(script);
  await writeFile(filePath, bytes);
  await chmod(filePath, 0o755);
  const canonicalPath = await realpath(filePath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { canonicalPath, sha256: hasher.digest("hex") };
}

function fixtureDeps(
  tmpDir: string,
  claude: { canonicalPath: string },
  opencode: { canonicalPath: string },
) {
  return {
    existsFn: (p: string) =>
      p === claude.canonicalPath ||
      p === opencode.canonicalPath ||
      p.startsWith(tmpDir),
    realpathFn: async (p: string) => p,
  };
}

describe("CLI production wiring (verify C1/C3)", () => {
  test("prepareProductionAdmissionContext admits OpenCode with D1-11 evidence", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-prod-"));
    try {
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opencode:openai/gpt-4o",
      });
      const plan = createResolvedRoutePlan([step]);
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: { PATH: tmpDir },
        loadSdk: mockLoadSdk,
        authorityDeps: fixtureDeps(tmpDir, claude, opencode),
      });
      if ("error" in admission) {
        throw new Error(admission.error);
      }
      expect(admission.evidence.get("opencode")?.sdkAvailable).toBe(true);
      await expect(
        admitRoutePlan(plan, admission.registry, {
          mode: "production",
          evidence: admission.evidence,
        }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // #149 follow-up: the fix forwards `credentialBrokers.opencode` into the
  // transport registry so the server launcher and the binding authority share
  // ONE broker. That forwarding was dead on the production path — the input
  // type carried no `credentialBrokers`, so the value was always undefined
  // and each side independently constructed its own OpenCodeAuthBroker.
  test("the opencode credential broker is resolved once and shared", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-broker-"));
    try {
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opencode:openai/gpt-4o",
      });
      const plan = createResolvedRoutePlan([step]);
      const injected = {
        project: async () => {
          throw new Error("not called in this test");
        },
      };
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: { PATH: tmpDir },
        loadSdk: mockLoadSdk,
        authorityDeps: fixtureDeps(tmpDir, claude, opencode),
        credentialBrokers: { opencode: injected },
      });
      if ("error" in admission) {
        throw new Error(admission.error);
      }
      // Identity, not shape: a second OpenCodeAuthBroker would satisfy a
      // shape assertion while being exactly the divergence under test.
      expect(admission.authorityOptions.credentialBrokers?.opencode).toBe(
        injected,
      );
      // The registry that launches the server holds the SAME object, not a
      // second one built from the same config.
      expect(
        (admission.registry as DefaultTransportRegistry)
          .openCodeCredentialBroker,
      ).toBe(injected);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("an uninjected opencode broker is still resolved once, not per consumer", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-broker2-"));
    try {
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opencode:openai/gpt-4o",
      });
      const plan = createResolvedRoutePlan([step]);
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: { PATH: tmpDir },
        loadSdk: mockLoadSdk,
        authorityDeps: fixtureDeps(tmpDir, claude, opencode),
      });
      if ("error" in admission) {
        throw new Error(admission.error);
      }
      // Defined even with nothing injected: the ONE instance both the binding
      // authority and the transport registry are handed.
      expect(
        admission.authorityOptions.credentialBrokers?.opencode,
      ).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // #149, second round: prepareProductionAdmissionContext was fixed while the
  // two `options.registry ?? createDefaultTransportRegistry(...)` fallbacks
  // kept dropping `credentialBrokers` — so a caller that supplies a broker but
  // no registry still got the fake at the binding authority and a real one at
  // the server. Found by pr-hero own review of the first fix.
  test("the fallback registry carries the caller opencode broker", () => {
    const injected = {
      project: async () => {
        throw new Error("not called in this test");
      },
    };
    const registry = productionFallbackRegistry({
      mode: "production",
      credentialBrokers: { opencode: injected },
    }) as DefaultTransportRegistry;
    expect(registry.openCodeCredentialBroker).toBe(injected);
  });

  test("the fallback registry supplies no broker when the caller did not", () => {
    const registry = productionFallbackRegistry({
      mode: "production",
    }) as DefaultTransportRegistry;
    // Absent, not a stand-in: the registry own default is then the single
    // source, and inventing one here would hide a caller that meant to inject.
    expect(registry.openCodeCredentialBroker).toBeUndefined();
    // With no plan there is no provider to key a kind off, so the launcher's
    // own OAuth default stands — the pre-#133 shape, unchanged.
    expect(registry.openCodeCredentialKind).toBeUndefined();
  });

  // #133, and this is the THIRD round of the same drift the comment above
  // records: the fallback forwarded the broker and dropped the credential
  // KIND. A `zai` plan with nothing injected gave the binding authority an
  // OpenCodeApiTokenBroker while the server built an OAuth broker asking for
  // the OAuth kind — which would project the operator's OpenAI record under a
  // metered route. Wrong rather than loud, which is the worse failure.
  test("the fallback registry carries the plan's credential kind", () => {
    const zaiStep = resolveStepRoute({
      stepKey: "refuter",
      role: "refuter",
      cliModel: "opencode:zai/glm-5",
    });
    const registry = productionFallbackRegistry({
      mode: "production",
      plan: createResolvedRoutePlan([zaiStep]),
    }) as DefaultTransportRegistry;
    expect(registry.openCodeCredentialKind).toBe("provider_api_token");
    // Still no stand-in broker: #149's invariant is untouched. The server
    // therefore gets the OAuth default broker and a metered kind, and refuses
    // by NAME — loud, which is the direction this slice chose.
    expect(registry.openCodeCredentialBroker).toBeUndefined();
  });

  test("the fallback registry refuses a mixed-provider plan", () => {
    const step = (stepKey: string, logical: string, provider: string) =>
      resolveStepRoute({
        stepKey,
        role: stepKey === "refuter" ? "refuter" : "hunter",
        cliModel: `opencode:${provider}/${logical.split("/")[1]}`,
      });
    expect(() =>
      productionFallbackRegistry({
        mode: "production",
        plan: createResolvedRoutePlan([
          step("hunter-reliability", "openai/gpt-4o", "openai"),
          step("refuter", "zai/glm-5", "zai"),
        ]),
      }),
    ).toThrow(/one credential/);
  });

  test("resolveProductionRoutePlanAtConfirm wires mixed Claude/OpenCode production admission", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-route-"));
    try {
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
      const claudeStep = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const openStep = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opencode:openai/gpt-4o",
      });
      const plan = createResolvedRoutePlan([claudeStep, openStep]);
      const routed = await resolveProductionRoutePlanAtConfirm({
        modelsConfigured: true,
        workspaceRoot: tmpDir,
        buildRoutePlan: async () => plan,
        env: { PATH: tmpDir },
        loadSdk: mockLoadSdk,
        authorityDeps: fixtureDeps(tmpDir, claude, opencode),
      });
      expect(routed?.routePlan).toBe(plan);
      expect(
        routed?.productionAdmission.authorityOptions.executableAllowlists
          ?.opencode?.[0]?.sha256,
      ).toBe(opencode.sha256);
      expect(
        routed?.productionAdmission.authorityOptions.executableAllowlists?.[
          "claude-code"
        ]?.[0]?.sha256,
      ).toBe(claude.sha256);
      expect(routed?.productionAdmission.evidence.has("opencode")).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // S5: the credential chosen at run start reaches admission, and a plan with a Claude
  // route and no listed credential present is refused before anything is admitted.
  describe("the run's Claude credential at admission (S5)", () => {
    const refused = resolveRunClaudeCredential({
      credentials: { claude: ["api_key"] },
      env: { PATH: "/nowhere", CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
      loginPresent: false,
    });

    test("a plan with a Claude route and no listed credential is refused, naming the order", async () => {
      let built = false;
      const plan = createResolvedRoutePlan([
        resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: "sonnet",
        }),
      ]);
      await expect(
        resolveProductionRoutePlanAtConfirm({
          modelsConfigured: true,
          workspaceRoot: "/nowhere",
          buildRoutePlan: async () => {
            built = true;
            return plan;
          },
          claudeRun: refused,
        }),
      ).rejects.toThrow(
        /credentials\.claude is \[api_key\], and none of those is set.*subscription is set but not listed/,
      );
      expect(built).toBe(true);
    });

    test("the legacy no-plan path is always Claude, so it is refused too", async () => {
      await expect(
        resolveProductionRoutePlanAtConfirm({
          modelsConfigured: false,
          workspaceRoot: "/nowhere",
          buildRoutePlan: async () => {
            throw new Error("raw model id the CLI resolves itself");
          },
          claudeRun: refused,
        }),
      ).rejects.toThrow(/no Claude credential this run may use is set/);
    });

    test("a plan with no Claude route ignores Claude credentials", async () => {
      const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-route-"));
      try {
        const claude = await writeExecutable(
          tmpDir,
          "claude",
          "#!/bin/sh\necho ok\n",
        );
        const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
        const plan = createResolvedRoutePlan([
          resolveStepRoute({
            stepKey: "hunter-reliability",
            role: "hunter",
            cliModel: "opencode:openai/gpt-4o",
          }),
        ]);
        const routed = await resolveProductionRoutePlanAtConfirm({
          modelsConfigured: true,
          workspaceRoot: tmpDir,
          buildRoutePlan: async () => plan,
          loadSdk: mockLoadSdk,
          authorityDeps: fixtureDeps(tmpDir, claude, opencode),
          claudeRun: resolveRunClaudeCredential({
            credentials: { claude: ["api_key"] },
            env: { PATH: tmpDir },
            loginPresent: false,
          }),
        });
        expect(routed?.routePlan).toBe(plan);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    // The legacy no-plan path's capability gate checks Claude auth from an env: the run
    // env (its binary lookup too), never the process env, so a CRYSK_* credential the
    // run chose is the one it sees under the CLI's name.
    test("the legacy capability gate reads the run env, not the process env", async () => {
      const childEnv = {
        PATH: "/nonexistent-u2",
        ANTHROPIC_API_KEY: "sk-test",
      };
      await expect(
        enforceProviderCapabilityGate({
          routePlan: undefined,
          workspaceRoot: "/nowhere",
          runnerAuthority: {
            runnerOptions: {
              binaryPath: "/nonexistent-u2/claude",
              workspaceRoot: "/nowhere",
              executableAllowlist: [],
              childEnv,
            },
          },
        }),
      ).rejects.toThrow(/provider capability gate failed/);
    });

    test("the chosen credential and its run env become the admission's authority options", async () => {
      const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-route-"));
      try {
        const claude = await writeExecutable(
          tmpDir,
          "claude",
          "#!/bin/sh\necho ok\n",
        );
        const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
        const plan = createResolvedRoutePlan([
          resolveStepRoute({
            stepKey: "hunter-reliability",
            role: "hunter",
            cliModel: "sonnet",
          }),
        ]);
        const claudeRun = resolveRunClaudeCredential({
          credentials: { claude: ["api_key", "subscription"] },
          env: {
            PATH: tmpDir,
            ANTHROPIC_API_KEY: "sk-test",
            CLAUDE_CODE_OAUTH_TOKEN: "oauth",
          },
          loginPresent: false,
        });
        const routed = await resolveProductionRoutePlanAtConfirm({
          modelsConfigured: true,
          workspaceRoot: tmpDir,
          buildRoutePlan: async () => plan,
          loadSdk: mockLoadSdk,
          authorityDeps: fixtureDeps(tmpDir, claude, opencode),
          claudeRun,
        });
        const options = routed?.productionAdmission.authorityOptions;
        expect(options?.env === claudeRun.env).toBe(true);
        expect(options?.claudeCredential).toBe("api_key");
        expect(options?.env?.CLAUDE_CODE_OAUTH_TOKEN === undefined).toBe(true);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  test("d1_11EvidenceFromExactBinding keeps subscription pricing non-blocking", () => {
    const report: ExactBindingCapabilityReport = {
      routeKey: "k",
      backend: "claude-code",
      sdk: { available: true },
      binary: { resolved: true, absolutePath: "/bin/claude", sha256: "abc" },
      auth: {
        kind: "claude_subscription_oauth",
        projectionReady: true,
        probe: "passed",
      },
      environment: { syntheticHome: true, enumeratedPassthrough: false },
      isolation: {
        workspaceReadBroker: true,
        codegraphPolicy: false,
      },
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
    };
    expect(d1_11EvidenceFromExactBinding(report).pricingReady).toBe(true);
  });

  // #133. The OpenCode server is ONE per backend and outlives every step, so
  // its credential is a whole-plan fact. Two things must hold here, and the
  // second is what made the api-token route reachable at all:
  //  1. A plan naming two OpenCode providers is refused BY NAME. Serving it
  //     would run one provider's steps under the other's credential.
  //  2. The default broker matches the plan's provider. An unconditional
  //     `new OpenCodeAuthBroker()` resolved the right KIND at the authority
  //     and then handed it a broker that refuses that kind — a failure that
  //     would only surface at projection time, mid-run.
  describe("the plan's sole opencode credential", () => {
    function openCodeStep(stepKey: string, logical: string, provider: string) {
      return resolveStepRoute({
        stepKey,
        role: stepKey === "refuter" ? "refuter" : "hunter",
        cliModel: `opencode:${provider}/${logical.split("/")[1]}`,
      });
    }

    async function admit(plan: ReturnType<typeof createResolvedRoutePlan>) {
      const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-cred-"));
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
      try {
        return await prepareProductionAdmissionContext({
          workspaceRoot: tmpDir,
          plan,
          env: { PATH: tmpDir },
          loadSdk: mockLoadSdk,
          authorityDeps: fixtureDeps(tmpDir, claude, opencode),
        });
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    }

    test("a two-provider plan is refused by name", async () => {
      const plan = createResolvedRoutePlan([
        openCodeStep("hunter-reliability", "openai/gpt-4o", "openai"),
        openCodeStep("refuter", "zai/glm-5", "zai"),
      ]);
      const admission = await admit(plan);
      if (!("error" in admission)) {
        throw new Error("expected a refusal");
      }
      expect(admission.error).toContain("openai");
      expect(admission.error).toContain("zai");
      expect(admission.error).toContain("one credential");
    });

    test("a single-provider plan resolves the sole credential", () => {
      const plan = createResolvedRoutePlan([
        openCodeStep("hunter-reliability", "zai/glm-5", "zai"),
        openCodeStep("refuter", "zai/glm-5", "zai"),
      ]);
      expect(soleOpenCodeCredential(plan, undefined)).toEqual({
        kind: "provider_api_token",
        provider: "zai",
      });
    });

    // A claude-only plan never reads the value, and must not be refused for a
    // backend it does not name.
    test("a plan with no opencode route keeps the pre-#133 OAuth default", () => {
      const plan = createResolvedRoutePlan([
        resolveStepRoute({
          stepKey: "hunter-reliability",
          role: "hunter",
          cliModel: "sonnet",
        }),
      ]);
      expect(soleOpenCodeCredential(plan, undefined)).toEqual({
        kind: "opencode_chatgpt_oauth",
        provider: "openai",
      });
    });

    test("the OAuth default broker is still the one both consumers share", async () => {
      const oauth = await admit(
        createResolvedRoutePlan([
          openCodeStep("refuter", "openai/gpt-4o", "openai"),
        ]),
      );
      if ("error" in oauth) throw new Error(oauth.error);
      expect(oauth.authorityOptions.credentialBrokers?.opencode).toBeInstanceOf(
        OpenCodeAuthBroker,
      );
      // #149: ONE instance, shared with the registry that launches the server.
      expect(
        (oauth.registry as DefaultTransportRegistry).openCodeCredentialBroker,
      ).toBe(oauth.authorityOptions.credentialBrokers?.opencode);
    });

    // U3 (S8, L12 "Building auth.json"): the kind follows which CRYSK_* secret
    // the setup step built the auth file from, named in its manifest. Without a
    // manifest the provider literal stands, so the old opencode-auth input and
    // a local store keep their answer.
    test("the sole credential follows the CRYSK_* secret names", () => {
      const plan = createResolvedRoutePlan([
        openCodeStep("refuter", "openai/gpt-4o", "openai"),
      ]);
      expect(
        soleOpenCodeCredential(plan, ["CRYSK_OPENCODE_OPENAI_API_KEY"]),
      ).toEqual({ kind: "provider_api_token", provider: "openai" });
      expect(
        soleOpenCodeCredential(plan, [
          "CRYSK_OPENCODE_OPENAI_API_KEY",
          "CRYSK_OPENCODE_OPENAI_OAUTH",
        ]),
      ).toEqual({ kind: "opencode_chatgpt_oauth", provider: "openai" });
      expect(soleOpenCodeCredential(plan, undefined)).toEqual({
        kind: "opencode_chatgpt_oauth",
        provider: "openai",
      });
    });

    test("admission reads the setup step's manifest: openai on an API key binds the API-token broker", async () => {
      const tmpDir = await mkdtemp(path.join(tmpdir(), "pr-hero-cli-cred-"));
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
      const dataHome = path.join(tmpDir, "xdg-data");
      const authPath = resolveOpenCodeAuthPath({ XDG_DATA_HOME: dataHome });
      await mkdir(path.dirname(authPath), { recursive: true });
      await writeFile(
        openCodeSecretManifestPath(authPath),
        serializeOpenCodeSecretManifest([
          {
            provider: "openai",
            secret: "CRYSK_OPENCODE_OPENAI_API_KEY",
            kind: "api_key",
          },
        ]),
      );
      try {
        const admission = await prepareProductionAdmissionContext({
          workspaceRoot: tmpDir,
          plan: createResolvedRoutePlan([
            openCodeStep("refuter", "openai/gpt-4o", "openai"),
          ]),
          env: { PATH: tmpDir, XDG_DATA_HOME: dataHome },
          loadSdk: mockLoadSdk,
          authorityDeps: fixtureDeps(tmpDir, claude, opencode),
        });
        if ("error" in admission) throw new Error(admission.error);
        expect(admission.authorityOptions.openCodeSecretNames).toEqual([
          "CRYSK_OPENCODE_OPENAI_API_KEY",
        ]);
        const broker = admission.authorityOptions.credentialBrokers?.opencode;
        expect(broker).toBeInstanceOf(OpenCodeApiTokenBroker);
        expect(
          (admission.registry as DefaultTransportRegistry)
            .openCodeCredentialBroker,
        ).toBe(broker);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    // SCOPE NOTE, updated by #137 and again on 2026-09-02, asserted rather
    // than claimed. This test used to require a REFUSAL here, on the premise
    // that a model absent from every bundled table is unpriceable. That
    // premise is gone: the design's metered rule is "provider cost OR a
    // versioned rate table" (§8 line 461, provider cost first), and the
    // OpenCode transport reports provider cost per assistant message. So a
    // route the TABLE cannot price is priced by the PROVIDER, and admitting
    // it is correct rather than a loosening — `glm-5-turbo` is routable in
    // OpenCode (`opencode models`, 2026-09-02) and absent from z.ai's
    // published price table, which is exactly the case provider cost exists
    // to cover.
    //
    // The fail-closed direction #133 chose is unchanged; it just moved to
    // where the unknown now actually lives. Admission no longer has an
    // unknown to refuse, so the guarantee is carried by
    // `settlementFromUsage`'s metered-zero rule: a metered attempt whose
    // provider-reported cost is $0 while output tokens were produced settles
    // UNRESOLVED and fences its bucket, instead of being recorded as free.
    // #197 finished the move this note describes: the bundled tables are
    // gone, so provider cost is not merely FIRST, it is the only source. The
    // claude-code CLI answers for itself too now, from `total_cost_usd`
    // (test/production-runtime.test.ts, "the claude-code CLI reports its own
    // cost, so an unpriceable model there is admitted").
    //
    // No `now` seam is needed anywhere any more: a reported cost does not
    // expire, so no arm in this file or in production-runtime's can turn red
    // on a calendar date.
    test("a metered route no bundled table covers is admitted on the transport's own provider cost", async () => {
      const admission = await admit(
        createResolvedRoutePlan([
          openCodeStep("refuter", "zai/glm-5-turbo", "zai"),
        ]),
      );
      if ("error" in admission) {
        throw new Error(admission.error);
      }
      // The readiness evidence the gate produced, not a re-derivation: the
      // pricing prerequisite is met, and it can only have been met by the
      // transport, since no bundled table carries this model on any clock.
      expect(admission.evidence.get("opencode")?.pricingReady).toBe(true);
    });
  });
});

// odd/tasks/role-model-routing.md S4 (E-d): every model of a role's list is
// admitted before the cost confirmation, so an OpenCode model listed only as
// a fallback gets its executable resolved here, and a fallback that cannot
// run fails here, before anything spends.
describe("fallback models at the pre-confirm admission", () => {
  function claudeThenOpenCode() {
    return createResolvedRoutePlan([
      resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        modelRole: "hunter.reliability",
        models: {
          "hunter.reliability": [
            "claude:sonnet-latest",
            "opencode:openai/gpt-4o",
          ],
        },
      }),
    ]);
  }

  test("an OpenCode model listed only as a fallback gets its executable resolved", async () => {
    const tmpDir = await realpath(
      await mkdtemp(path.join(tmpdir(), "pr-hero-cli-fallback-")),
    );
    try {
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      const opencode = await writeExecutable(tmpDir, "opencode", "opencode");
      const plan = claudeThenOpenCode();
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan,
        env: { PATH: tmpDir },
        loadSdk: mockLoadSdk,
        authorityDeps: fixtureDeps(tmpDir, claude, opencode),
      });
      if ("error" in admission) {
        throw new Error(admission.error);
      }
      expect(admission.authorityOptions.executableAllowlists?.opencode).toEqual(
        [{ absolutePath: opencode.canonicalPath, sha256: opencode.sha256 }],
      );
      expect(admission.evidence.get("opencode")?.sdkAvailable).toBe(true);
      await expect(
        admitRoutePlan(plan, admission.registry, {
          mode: "production",
          evidence: admission.evidence,
        }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("a fallback whose executable cannot be found fails admission", async () => {
    const tmpDir = await realpath(
      await mkdtemp(path.join(tmpdir(), "pr-hero-cli-fallback-")),
    );
    try {
      const claude = await writeExecutable(
        tmpDir,
        "claude",
        "#!/bin/sh\necho ok\n",
      );
      // No opencode binary anywhere this admission may look.
      const missing = { canonicalPath: path.join(tmpDir, "no-opencode") };
      const admission = await prepareProductionAdmissionContext({
        workspaceRoot: tmpDir,
        plan: claudeThenOpenCode(),
        env: { PATH: tmpDir },
        loadSdk: mockLoadSdk,
        authorityDeps: {
          ...fixtureDeps(tmpDir, claude, missing),
          existsFn: (p: string) =>
            p.startsWith(tmpDir) && path.basename(p) !== "opencode",
        },
      });
      expect("error" in admission ? admission.error : "admitted").toMatch(
        /opencode/i,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
