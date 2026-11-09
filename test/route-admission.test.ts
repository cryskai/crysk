import { describe, expect, test } from "bun:test";
import {
  computeRouteFingerprint,
  createResolvedRoutePlan,
  type ResolvedStepRoute,
  resolveStepRoute,
} from "#model/routing";
import {
  FINDINGS_CONFORMANCE_CASES,
  type FindingsConformanceCase,
} from "#review/findings-conformance";
import { DiversityCapabilityError } from "../src/diversity/errors";
import type {
  CredentialKind,
  ProviderCapabilityReport,
  ProviderTransport,
  RunnerBackend,
  TransportOutcome,
  TransportRequest,
} from "../src/execution/contracts";
import {
  type AdmitRoutePlanOptions,
  admitDiversityRoutePlan,
  admitRoutePlan,
  checkD1_11Readiness,
  createDefaultTransportRegistry,
  type D1_11ReadinessEvidence,
  DefaultTransportRegistry,
  OpenCodeProductionGatedError,
  RouteAdmissionError,
} from "../src/transport-registry";
import type { OpenCodeSdkTransport } from "../src/transports/opencode-sdk";

function createMockTransport(
  backend: RunnerBackend,
  reportOverrides: Partial<ProviderCapabilityReport> = {},
): ProviderTransport {
  return {
    backend,
    capabilities: async (): Promise<ProviderCapabilityReport> => ({
      backend,
      status: "ready",
      auth: {
        kind:
          backend === "claude-code"
            ? "claude_subscription_oauth"
            : "opencode_chatgpt_oauth",
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
      cancellation: {
        deadlineMs: 5000,
        conformance: "passed",
      },
      billing: {
        mode: "subscription",
        pricingReady: true,
      },
      issues: [],
      ...reportOverrides,
    }),
    execute: async (_request: TransportRequest): Promise<TransportOutcome> => ({
      completion: "success",
      protocolIntegrity: "verified",
      finalText: '{"findings":[]}',
      usage: {
        wallMs: 100,
        tokens: { totalKnown: 10 },
        completeness: "complete",
        billingMode: "subscription",
        costSource: "provider",
        cashCostUsd: 0,
      },
      stderrTail: "",
    }),
    classifyFailure: () => undefined,
  };
}

// A route to a backend no model name can reach, for the admission gate to
// refuse: built by hand, since `codex` is not a backend a name can say.
function codexStep(stepKey: string): ResolvedStepRoute {
  const route = {
    backend: "codex" as RunnerBackend,
    provider: "openai",
    modelFamily: "gpt-4o",
    modelSnapshot: "gpt-4o",
  };
  return {
    stepKey,
    role: "hunter",
    logicalIdentity: "codex:openai/gpt-4o",
    route,
    routeFingerprint: computeRouteFingerprint("codex:openai/gpt-4o", route),
  };
}

describe("Task 2.1 RED: Route Admission & Transport Registry", () => {
  describe("Pre-confirm route plan admission", () => {
    test("admits a valid route plan with registered capable backends", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const step1 = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const step2 = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opus",
      });

      const plan = createResolvedRoutePlan([step1, step2]);

      const admission = await admitRoutePlan(plan, registry);
      expect(admission.ok).toBe(true);
      expect(admission.admittedSteps).toHaveLength(2);
      expect(admission.admittedSteps[0].stepKey).toBe("hunter-reliability");
      expect(admission.admittedSteps[1].stepKey).toBe("refuter");
    });

    test("fails closed if a step backend is not registered in the registry", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const step1 = codexStep("hunter-resilience");

      const plan = createResolvedRoutePlan([step1]);

      expect(admitRoutePlan(plan, registry)).rejects.toThrow(
        RouteAdmissionError,
      );
    });

    test("fails closed if capability report contains blocking issues", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register(
        "claude-code",
        createMockTransport("claude-code", {
          status: "blocking",
          issues: [
            {
              code: "binary_unresolved",
              message: "claude executable not found",
              blocking: true,
            },
          ],
        }),
      );

      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);

      expect(admitRoutePlan(plan, registry)).rejects.toThrow(
        RouteAdmissionError,
      );
    });
  });

  describe("Heterogeneous singular routes", () => {
    test("supports distinct admitted routes per stage with exactly one singular route per step", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));
      registry.register(
        "opencode",
        createMockTransport("opencode", {
          billing: { mode: "subscription", pricingReady: true },
        }),
      );

      const hunter1 = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const hunter2 = resolveStepRoute({
        stepKey: "hunter-resilience",
        role: "hunter",
        cliModel: "haiku",
      });
      const refuter = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opencode:openai/o3-mini-2025-01-31",
      });

      const plan = createResolvedRoutePlan([hunter1, hunter2, refuter]);

      expect(hunter1.route.backend).toBe("claude-code");
      expect(hunter1.route.modelFamily).toBe("sonnet");

      expect(hunter2.route.backend).toBe("claude-code");
      expect(hunter2.route.modelFamily).toBe("haiku");

      expect(refuter.route.backend).toBe("opencode");
      expect(refuter.route.provider).toBe("openai");
      expect(refuter.route.modelFamily).toBe("o3-mini-2025-01-31");

      // Evidence provided for opencode
      const evidence: D1_11ReadinessEvidence = {
        sdkAvailable: true,
        credentialAuthority: true,
        workspaceBroker: true,
        pricingReady: true,
      };

      const admission = await admitRoutePlan(plan, registry, {
        evidence: new Map([["opencode", evidence]]),
      });
      expect(admission.ok).toBe(true);
      expect(admission.admittedSteps).toHaveLength(3);
    });
  });

  describe("Exact route identity preservation", () => {
    test("preserves exact route fingerprints and immutability throughout admission", async () => {
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const step = resolveStepRoute({
        stepKey: "reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);

      const admission = await admitRoutePlan(plan, registry);
      expect(admission.plan.routeFingerprint).toBe(plan.routeFingerprint);
      expect(admission.admittedSteps[0].routeFingerprint).toBe(
        step.routeFingerprint,
      );
      expect(admission.admittedSteps[0].route).toEqual(step.route);
      expect(Object.isFrozen(admission.plan)).toBe(true);
    });
  });

  describe("D1-11 Reconciliation & Enablement Gate", () => {
    test("D1-11 outcome 1: incomplete prerequisites reject OpenCode in production mode", async () => {
      const registry = createDefaultTransportRegistry({ mode: "production" });

      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opencode:openai/gpt-4o",
      });
      const plan = createResolvedRoutePlan([step]);

      // In production mode without D1-11 evidence, OpenCode admission must throw OpenCodeProductionGatedError
      let caughtError: unknown;
      try {
        await admitRoutePlan(plan, registry, { mode: "production" });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(OpenCodeProductionGatedError);
      expect((caughtError as Error).message).toContain("D1-11");
    });

    test("D1-11 checkD1_11Readiness identifies incomplete vs complete evidence", () => {
      const incomplete: D1_11ReadinessEvidence = {
        sdkAvailable: true,
        credentialAuthority: false,
        workspaceBroker: true,
        pricingReady: false,
      };

      const incompleteResult = checkD1_11Readiness(incomplete);
      expect(incompleteResult.ready).toBe(false);
      expect(incompleteResult.missing).toContain("credentialAuthority");
      expect(incompleteResult.missing).toContain("pricingReady");

      const complete: D1_11ReadinessEvidence = {
        sdkAvailable: true,
        credentialAuthority: true,
        workspaceBroker: true,
        pricingReady: true,
      };

      const completeResult = checkD1_11Readiness(complete);
      expect(completeResult.ready).toBe(true);
      expect(completeResult.missing).toHaveLength(0);
    });

    test("D1-11 outcome 2: complete evidence permits composition of OpenCode", async () => {
      const completeEvidence: D1_11ReadinessEvidence = {
        sdkAvailable: true,
        credentialAuthority: true,
        workspaceBroker: true,
        pricingReady: true,
      };

      const registry = createDefaultTransportRegistry({
        mode: "conformance",
        observedOpenCodeIdentity: {
          sdkVersion: "1.18.25",
          serverVersion: "1.18.30",
          executablePath: "/fixture",
          executableSha256: "fixture",
        },
        sdkVersion: "1.18.25",
        serverVersion: "1.18.30",
        evidence: new Map([["opencode", completeEvidence]]),
        openCodeClient: {
          createSession: async () => ({ id: "sess-1" }),
          streamEvents: async function* () {},
          pollStatus: async () => ({
            kind: "terminal",
            proof: {
              eventId: "e1",
              providerStatus: "completed",
              providerObservedAt: new Date().toISOString(),
            },
          }),
          abort: async () => {},
        },
      });

      const step = resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opencode:openai/gpt-4o",
      });
      const plan = createResolvedRoutePlan([step]);

      const admission = await admitRoutePlan(plan, registry, {
        evidence: new Map([["opencode", completeEvidence]]),
      });
      expect(admission.ok).toBe(true);
      expect(admission.admittedSteps[0].route.backend).toBe("opencode");
    });

    test("admitRoutePlan supports Map<RunnerBackend, ProviderCapabilityReport> as 2nd parameter", async () => {
      const step = resolveStepRoute({
        stepKey: "hunter-reliability",
        role: "hunter",
        cliModel: "sonnet",
      });
      const plan = createResolvedRoutePlan([step]);

      const capReport: ProviderCapabilityReport = {
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
        cancellation: { deadlineMs: 5000, conformance: "passed" },
        billing: { mode: "subscription", pricingReady: true },
        issues: [],
      };

      const capabilitiesMap = new Map<RunnerBackend, ProviderCapabilityReport>([
        ["claude-code", capReport],
      ]);

      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));

      const admission = await admitRoutePlan(plan, capabilitiesMap, registry);
      expect(admission.ok).toBe(true);
      expect(admission.reports.get("claude-code")).toBeDefined();
    });

    test("DefaultTransportRegistry caches created transport instances across get() calls", () => {
      const registry = new DefaultTransportRegistry();
      const t1 = registry.get("claude-code");
      const t2 = registry.get("claude-code");
      expect(t1).toBe(t2);
    });
  });
});

// Issue #142 item 4. `admitDiversityRoutePlan` was covered only transitively,
// through the pipeline, and transitive coverage cannot answer the one question
// that matters about a forwarder: does it still forward what it was handed, in
// the position it was handed it? That is exactly what issue #119 broke — three
// call sites dropped the D1-11 readiness evidence argument, admission gated
// against an empty evidence map, and a live OpenCode review died in 1.1s before
// a single agent spawned. `src/review/pipeline.ts` carries the matching comment
// ("admitDiversityRoutePlan forwards straight to admitRoutePlan, so it carries
// the exact same omission hazard"); until now nothing checked that claim.
describe("admitDiversityRoutePlan independent contract (#142 item 4)", () => {
  const COMPLETE_EVIDENCE: D1_11ReadinessEvidence = {
    sdkAvailable: true,
    credentialAuthority: true,
    workspaceBroker: true,
    pricingReady: true,
  };
  const INCOMPLETE_EVIDENCE: D1_11ReadinessEvidence = {
    sdkAvailable: true,
    credentialAuthority: false,
    workspaceBroker: true,
    pricingReady: false,
  };

  // An opencode-routed plan is the only shape that makes forwarding OBSERVABLE.
  // `admitRoutePlan`'s D1-11 gate reads `options.evidence` and nothing else, so
  // evidence that fails to arrive is the difference between admission and
  // `OpenCodeProductionGatedError`. A claude-code plan admits with or without
  // options and would prove nothing about what got forwarded.
  const openCodePlan = () =>
    createResolvedRoutePlan([
      resolveStepRoute({
        stepKey: "refuter",
        role: "refuter",
        cliModel: "opencode:openai/gpt-4o",
      }),
    ]);

  // A mock transport keeps the capability gate out of the experiment: the real
  // opencode factory would reach for the SDK. With it registered, the only
  // thing left that can reject this plan is the D1-11 evidence check — which is
  // precisely the argument #119 lost.
  const openCodeRegistry = () => {
    const registry = new DefaultTransportRegistry();
    registry.register("opencode", createMockTransport("opencode"));
    return registry;
  };

  const openCodeCapabilities = async () =>
    new Map<RunnerBackend, ProviderCapabilityReport>([
      ["opencode", await createMockTransport("opencode").capabilities()],
    ]);

  const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error("expected admission to reject, but it resolved");
  };

  // WHY this seam rather than a module mock: `requireInternalFindingsCapability`
  // reads no flag, env var or config. Its only input is the shared
  // `FINDINGS_CONFORMANCE_CASES` table, which it replays through the real
  // validator — so the honest way to make the gate fail is to hand it a case it
  // must reject: an accept-case's exact bytes carrying `expect: "reject"`.
  // `mock.module` is the alternative and it is worse here: it has no precedent
  // in this repo, and it patches a module registry shared with every later test
  // file in the same bun process. The table is `readonly` by type only, which
  // is the whole trick; the restore truncates back to the recorded length in a
  // `finally`, and the poison id names itself so a leaked entry fails loudly
  // rather than mysteriously.
  const poisonCapabilityTable = (): (() => void) => {
    const table = FINDINGS_CONFORMANCE_CASES as FindingsConformanceCase[];
    const acceptCase = FINDINGS_CONFORMANCE_CASES.find(
      (conformanceCase) => conformanceCase.expect === "accept",
    );
    if (acceptCase === undefined) {
      throw new Error("no accept conformance case to build a poison case from");
    }
    const originalLength = table.length;
    table.push({
      id: "test-poison-admit-diversity-gate",
      raw: acceptCase.raw,
      expect: "reject",
    });
    return () => {
      table.length = originalLength;
    };
  };

  describe("the capability gate actually runs", () => {
    test("the gate runs BEFORE admitRoutePlan touches the plan", async () => {
      // The plan routes to a backend nobody registered, so `admitRoutePlan`
      // throws `RouteAdmissionError` on its very first loop iteration. Which of
      // the two errors surfaces under a poisoned table IS the ordering claim,
      // asserted behaviourally instead of by spying on call shape.
      const registry = new DefaultTransportRegistry();
      registry.register("claude-code", createMockTransport("claude-code"));
      const plan = createResolvedRoutePlan([codexStep("hunter-resilience")]);

      const healthy = await rejectionOf(
        admitDiversityRoutePlan(plan, registry, { mode: "production" }),
      );
      expect(healthy).toBeInstanceOf(RouteAdmissionError);
      expect(healthy).not.toBeInstanceOf(DiversityCapabilityError);

      const restore = poisonCapabilityTable();
      try {
        const gated = await rejectionOf(
          admitDiversityRoutePlan(plan, registry, { mode: "production" }),
        );
        expect(gated).toBeInstanceOf(DiversityCapabilityError);
        expect(gated).not.toBeInstanceOf(RouteAdmissionError);
      } finally {
        restore();
      }
    });

    test("a failing gate rejects a plan that would otherwise admit", async () => {
      const registry = openCodeRegistry();
      const plan = openCodePlan();
      const options: AdmitRoutePlanOptions = {
        mode: "production",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
      };

      const admitted = await admitDiversityRoutePlan(plan, registry, options);
      expect(admitted.ok).toBe(true);

      const restore = poisonCapabilityTable();
      try {
        const gated = await rejectionOf(
          admitDiversityRoutePlan(plan, registry, options),
        );
        expect(gated).toBeInstanceOf(DiversityCapabilityError);
      } finally {
        restore();
      }
    });
  });

  // The #119 assertions. Each one fails if the argument in that position stops
  // arriving at `admitRoutePlan` — the 3-arg shape is the one `src/review/pipeline.ts`
  // actually calls, the 4-arg shape is the overload the same positional forward
  // has to keep resolving correctly.
  describe("positional forwarding into the admitRoutePlan overload", () => {
    test("3-arg shape (options third): complete evidence admits", async () => {
      const registry = openCodeRegistry();
      const plan = openCodePlan();

      const admission = await admitDiversityRoutePlan(plan, registry, {
        mode: "production",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
      });

      expect(admission.ok).toBe(true);
      expect(admission.admittedSteps).toHaveLength(1);
      expect(admission.admittedSteps[0].route.backend).toBe("opencode");
      expect(admission.reports.get("opencode")).toBeDefined();
    });

    test("3-arg shape: incomplete evidence is refused, not admitted", async () => {
      const gated = await rejectionOf(
        admitDiversityRoutePlan(openCodePlan(), openCodeRegistry(), {
          mode: "production",
          evidence: new Map([["opencode", INCOMPLETE_EVIDENCE]]),
        }),
      );

      expect(gated).toBeInstanceOf(OpenCodeProductionGatedError);
      expect((gated as Error).message).toContain("credentialAuthority");
      expect((gated as Error).message).toContain("pricingReady");
    });

    test("3-arg shape: absent evidence stays fail-closed", async () => {
      const gated = await rejectionOf(
        admitDiversityRoutePlan(openCodePlan(), openCodeRegistry(), {
          mode: "production",
        }),
      );

      expect(gated).toBeInstanceOf(OpenCodeProductionGatedError);
    });

    test("4-arg shape (capabilities, registry, options): complete evidence admits", async () => {
      const admission = await admitDiversityRoutePlan(
        openCodePlan(),
        await openCodeCapabilities(),
        openCodeRegistry(),
        {
          mode: "production",
          evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
        },
      );

      expect(admission.ok).toBe(true);
      expect(admission.admittedSteps[0].route.backend).toBe("opencode");
    });

    test("4-arg shape: incomplete evidence in the fourth argument is refused", async () => {
      const gated = await rejectionOf(
        admitDiversityRoutePlan(
          openCodePlan(),
          await openCodeCapabilities(),
          openCodeRegistry(),
          {
            mode: "production",
            evidence: new Map([["opencode", INCOMPLETE_EVIDENCE]]),
          },
        ),
      );

      expect(gated).toBeInstanceOf(OpenCodeProductionGatedError);
      expect((gated as Error).message).toContain("credentialAuthority");
    });
  });

  // The property `src/review/pipeline.ts` asserts in prose — "forwards straight to
  // admitRoutePlan, so it carries the exact same omission hazard" — turned into
  // a check. Same input, same outcome, in both directions.
  describe("parity with admitRoutePlan on identical input", () => {
    test("both admit on complete evidence", async () => {
      const plan = openCodePlan();
      const options: AdmitRoutePlanOptions = {
        mode: "production",
        evidence: new Map([["opencode", COMPLETE_EVIDENCE]]),
      };

      const direct = await admitRoutePlan(plan, openCodeRegistry(), options);
      const viaDiversity = await admitDiversityRoutePlan(
        plan,
        openCodeRegistry(),
        options,
      );

      expect(viaDiversity.ok).toBe(direct.ok);
      expect(viaDiversity.plan.routeFingerprint).toBe(
        direct.plan.routeFingerprint,
      );
      expect(viaDiversity.admittedSteps.map((step) => step.stepKey)).toEqual(
        direct.admittedSteps.map((step) => step.stepKey),
      );
      expect([...viaDiversity.reports.keys()]).toEqual([
        ...direct.reports.keys(),
      ]);
    });

    test("both refuse, with the same error class and message, on absent evidence", async () => {
      const plan = openCodePlan();
      const options: AdmitRoutePlanOptions = { mode: "production" };

      const direct = await rejectionOf(
        admitRoutePlan(plan, openCodeRegistry(), options),
      );
      const viaDiversity = await rejectionOf(
        admitDiversityRoutePlan(plan, openCodeRegistry(), options),
      );

      expect(direct).toBeInstanceOf(OpenCodeProductionGatedError);
      expect(viaDiversity).toBeInstanceOf(OpenCodeProductionGatedError);
      expect((viaDiversity as Error).constructor).toBe(
        (direct as Error).constructor,
      );
      expect((viaDiversity as Error).message).toBe((direct as Error).message);
    });
  });
});

// 2026-09-02. #133 taught the CAPABILITY REPORT that a `provider_api_token`
// route bills as metered; the usage records the transport emits were still
// hardcoded `subscription`. The factory is where the two meet: it is the only
// place that holds the credential kind AND builds the transport.
//
// #149's lesson is why `usageBillingMode` is readable at all: the broker
// forwarding that "guaranteed" a shared instance shipped dead twice because
// nothing outside could observe it. Deriving a billing mode from a credential
// kind inside a factory is exactly that shape, so the derivation is
// observable rather than asserted through an executed attempt.
describe("OpenCode transport factory derives usage billing mode from the credential kind", () => {
  const idleClient = {
    createSession: async () => ({ id: "sess-idle" }),
    streamEvents: async function* () {},
    pollStatus: async () => ({ kind: "pending" }) as const,
    abort: async () => {},
  };

  function openCodeTransportFor(credentialKind?: CredentialKind) {
    const registry = createDefaultTransportRegistry({
      mode: "conformance",
      sdkVersion: "1.18.25",
      serverVersion: "1.18.30",
      openCodeClient: idleClient,
      ...(credentialKind === undefined ? {} : { credentialKind }),
    });
    return registry.get("opencode") as OpenCodeSdkTransport;
  }

  test("a provider_api_token credential makes the transport stamp metered", () => {
    expect(openCodeTransportFor("provider_api_token").usageBillingMode).toBe(
      "metered",
    );
  });

  test("a provider_free credential makes the transport stamp free (settlement guard reads it)", () => {
    // #182 follow-up: checked BEFORE the metered test in the factory — a
    // subscription badge here would settle a flipped attempt's priced cost as
    // a truthful zero. Only the free kind stamps free.
    expect(openCodeTransportFor("provider_free").usageBillingMode).toBe("free");
  });

  test("the OAuth credential keeps subscription", () => {
    expect(
      openCodeTransportFor("opencode_chatgpt_oauth").usageBillingMode,
    ).toBe("subscription");
  });

  test("no credential kind keeps subscription, matching the factory's default route", () => {
    // The same branch that defaults the model to `openai/gpt-4o` — an OAuth,
    // subscription-billed route. The two defaults have to agree or the
    // transport would stamp a mode its own default route contradicts.
    expect(openCodeTransportFor().usageBillingMode).toBe("subscription");
  });

  // #150: the SAME real factory this describe block uses everywhere else —
  // `DefaultTransportRegistry`'s registered "opencode" closure, which just
  // `new`s an `OpenCodeSdkTransport` and returns it uncopied/unwrapped
  // (transport-registry.ts `get()`). Proving the declaration survives THIS
  // path, not only a bare `new OpenCodeSdkTransport(...)` in a unit test, is
  // what rules out a future wrapper silently dropping the field.
  test("the transport the production registry factory returns still declares server-lifetime", () => {
    expect(openCodeTransportFor().credentialProjection).toBe("server-lifetime");
  });
});
