import { homedir } from "node:os";
import { opencodeSecretToken } from "#ci/crysk-secrets";
import {
  createFreeModelProbe,
  createModelVariantsProbe,
  type FreeModelProbe,
  freeVerdictKey,
  type ModelVariantsProbe,
} from "#model/free-discovery";
import type { ModelsConfig } from "#model/model-name";
import {
  CLAUDE_PROFILE,
  type ModelProfile,
  profileModelAlias,
  profileRoute,
} from "#model/profiles";
import type { ProviderCapabilityReport } from "#model/provider-capabilities";
import {
  type CapabilityGateDecision,
  exactBindingCapabilityGate,
} from "#model/provider-capabilities";
import type { ResolvedRoutePlan, ResolvedStepRoute } from "#model/routing";
import {
  buildResolvedRoutePlan,
  createResolvedRoutePlan,
  freezeRoutePlan,
  planRoutes,
  resolveModelEntryRoute,
} from "#model/routing";
import {
  ClaudeCodeRunner,
  type StepResult,
  type StepRunner,
  type StepSpec,
} from "#review/step-runner";
// Production runtime composition (§2 design): frozen route-keyed bindings admit
// once; MultiProviderRunner acquires a per-step transport lease, delegates
// lifecycle to StepExecutionHarness, and disposes stream/client/server before
// credential projection destroy. Registry caches transports by routeFingerprint.
import type { AttemptAdmissionGate } from "./execution/admission";
import { deriveBucketId, loadOrCreateBucketKey } from "./execution/bucket-id";
import type {
  CredentialKind,
  EnvironmentPolicy,
  ExactBindingCapabilityReport,
  IsolationProjection,
  ProviderTransport,
  ResolvedModelRoute,
  RunnerBackend,
  RuntimeBinding,
  RuntimeBindingCredential,
  TransportLease,
  VerifiedExecutable,
} from "./execution/contracts";
import { StepExecutionHarness } from "./execution/harness";
import { runWithFallback } from "./execution/model-fallback";
import {
  InMemorySpendLedger,
  type SpendLedger,
} from "./execution/spend-limiter";
import {
  type BindingAuthorityResolution,
  createOpenCodeBrokerPool,
  credentialKindBillsMetered,
  credentialKindForRoute,
  openCodeBrokerForRoute,
  openCodeCredentialBrokerForKind,
  prepareProductionRunnerAuthority,
  type ResolvedBindingAuthority,
  type ResolveRunnerAuthorityDeps,
  type RunnerAuthorityOptions,
  resolveBindingAuthority,
  withClaudeDiscoveryAllowlist,
} from "./runner-authority";
import {
  validateBindingAdmission,
  validateRouteDrift,
} from "./security/binding-policy";
import {
  lookupOpenCodeApiRecord,
  lookupOpenCodeOAuthRecord,
  OPENCODE_OAUTH_PROVIDER,
  OpenCodeApiTokenBroker,
  OpenCodeAuthBroker,
  OpenCodeFreeBroker,
  resolveOpenCodeAuthPath,
} from "./security/credential-broker";
import { authorizeWorkspaceCwd } from "./security/execution-authority";
import {
  REVIEW_EXPIRY_MARGIN_MS,
  recordExpiresAt,
} from "./security/oauth-providers";
import { readOpenCodeSecretNames } from "./security/opencode-secret-manifest";
import {
  type AdmitRoutePlanOptions,
  type AdmittedRoutePlanResult,
  admitRoutePlan,
  createDefaultTransportRegistry,
  type D1_11ReadinessEvidence,
  DefaultTransportRegistry,
  readInstalledOpenCodeSdkVersion,
  type TransportFactoryOptions,
  type TransportRegistry,
} from "./transport-registry";
import {
  type OpenCodeIdentityObserver,
  type OpenCodeObservedIdentity,
  observeOpenCodeExecutable,
} from "./transports/opencode-admission";
import { zeroUsage } from "./usage";

export class ProductionRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionRuntimeError";
  }
}

export interface ProductionRuntimeOptions extends RunnerAuthorityOptions {
  readonly plan: ResolvedRoutePlan;
  readonly registry?: TransportRegistry;
  readonly mode?: AdmitRoutePlanOptions["mode"];
  readonly evidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
  readonly authorityDeps?: ResolveRunnerAuthorityDeps;
  readonly spawnFn?: typeof Bun.spawn;
  readonly observeOpenCodeIdentity?: OpenCodeIdentityObserver;
  readonly signal?: AbortSignal;
  readonly attemptAdmissionGate?: AttemptAdmissionGate;
  readonly graceMarginMs?: number;
  // #182: live free-model verdicts, injected so `bun test` stays offline.
  // When present and an opencode route resolved to `provider_api_token`,
  // `resolveFrozenBindings` asks it about (provider, modelSnapshot) and — on
  // true — swaps the binding to `provider_free` + the free broker. When
  // absent, behaviour is unchanged (no spawn, no upgrade). The same instance
  // must feed the server credential and the bindings (see
  // prepareProductionAdmissionContext) so the two cannot disagree across a
  // provider flip — use `createFreeModelProbe` (memoised per provider/model).
  readonly freeModelProbe?: FreeModelProbe;
}

export interface ProductionRuntime {
  readonly runner: StepRunner;
  readonly registry: TransportRegistry;
  readonly bindings: ReadonlyMap<string, RuntimeBinding>;
  readonly admitted: AdmittedRoutePlanResult;
  // The D1-11 evidence this runtime was admitted with, echoed back verbatim.
  // admitRoutePlan reads evidence ONLY from its own options and never from the
  // registry, so a later admission (the pipeline's pre-confirm gate) has no way
  // to recover it from `registry` alone — it has to be carried.
  readonly evidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
  dispose(): Promise<void>;
}

interface ActiveTransportLeaseTracker {
  // U4: the transport is remembered so the lease that ends LAST closes it (and
  // with it the route's OpenCode server), whichever path ended it.
  register(routeKey: string, transport?: ProviderTransport): void;
  /** Returns true when the last active lease for this routeKey was released. */
  unregister(routeKey: string): boolean;
  activeCount(routeKey: string): number;
  teardownTransportIfLast(input: {
    routeKey: string;
    transport: ProviderTransport;
  }): Promise<void>;
  endLease(input: {
    routeKey: string;
    registry: { release?(routeFingerprint: string): void };
  }): Promise<void>;
  releaseAll(registry: {
    release?(routeFingerprint: string): void;
  }): Promise<void>;
}

// U4: close a transport that owns a process (the OpenCode SDK transport's
// server). Transports without one (the Claude CLI, test fakes) have no dispose.
// A failure to close is swallowed like every other teardown here: it must
// never replace the step's own outcome.
async function disposeTransport(transport: ProviderTransport): Promise<void> {
  if ("dispose" in transport && typeof transport.dispose === "function") {
    await (transport as { dispose(): Promise<void> }).dispose().catch(() => {});
  }
}

class DefaultActiveTransportLeaseTracker
  implements ActiveTransportLeaseTracker
{
  private readonly refcounts = new Map<string, number>();
  private readonly gates = new Map<string, Promise<void>>();
  private readonly transports = new Map<string, ProviderTransport>();

  register(routeKey: string, transport?: ProviderTransport): void {
    this.refcounts.set(routeKey, (this.refcounts.get(routeKey) ?? 0) + 1);
    if (transport !== undefined && !this.transports.has(routeKey)) {
      this.transports.set(routeKey, transport);
    }
  }

  unregister(routeKey: string): boolean {
    const current = this.refcounts.get(routeKey) ?? 0;
    if (current <= 1) {
      this.refcounts.delete(routeKey);
      return true;
    }
    this.refcounts.set(routeKey, current - 1);
    return false;
  }

  activeCount(routeKey: string): number {
    return this.refcounts.get(routeKey) ?? 0;
  }

  async teardownTransportIfLast(input: {
    routeKey: string;
    transport: ProviderTransport;
  }): Promise<void> {
    await this.exclusive(input.routeKey, async () => {
      if (this.activeCount(input.routeKey) !== 1) {
        return;
      }
      // U4: closed here, so the lease's end (endLease) does not close it a
      // second time. A later lease on the same cached transport registers it
      // again.
      if (this.transports.get(input.routeKey) === input.transport) {
        this.transports.delete(input.routeKey);
      }
      if (
        "dispose" in input.transport &&
        typeof input.transport.dispose === "function"
      ) {
        await (input.transport as { dispose(): Promise<void> }).dispose();
      }
    });
  }

  async endLease(input: {
    routeKey: string;
    registry: { release?(routeFingerprint: string): void };
  }): Promise<void> {
    await this.exclusive(input.routeKey, async () => {
      if (this.unregister(input.routeKey)) {
        // U4: the last lease on a route closes its transport. The harness's
        // own teardown (teardownTransportIfLast) runs before the step's
        // credential projection is destroyed, but two concurrent steps on one
        // route can both pass it while the other still holds a lease, and
        // then nobody closes the server; this cannot be raced, since only one
        // lease is ever last. A transport the harness already closed was
        // forgotten there, so it is not closed twice.
        const transport = this.transports.get(input.routeKey);
        this.transports.delete(input.routeKey);
        if (transport !== undefined) await disposeTransport(transport);
        input.registry.release?.(input.routeKey);
      }
    });
  }

  // U4: a lease never returned (a step torn down mid-flight) still has its
  // transport closed when the runtime is disposed, so no server outlives it.
  async releaseAll(registry: {
    release?(routeFingerprint: string): void;
  }): Promise<void> {
    const transports = [...this.transports.values()];
    this.transports.clear();
    for (const routeKey of [...this.refcounts.keys()]) {
      registry.release?.(routeKey);
    }
    this.refcounts.clear();
    await Promise.all(transports.map((t) => disposeTransport(t)));
  }

  private async exclusive<T>(
    routeKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.gates.get(routeKey) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.gates.set(
      routeKey,
      previous.then(() => gate),
    );
    await previous;
    try {
      return await fn();
    } finally {
      releaseGate();
    }
  }
}

interface FrozenRuntimeBindingOptions {
  readonly observedOpenCodeIdentity?: OpenCodeObservedIdentity;
  readonly key: string;
  readonly route: ResolvedModelRoute;
  readonly authority: ResolvedBindingAuthority;
  readonly executable: VerifiedExecutable;
  readonly credential: RuntimeBindingCredential;
  readonly getCapabilityReport: (
    backend: RunnerBackend,
  ) => Promise<ProviderCapabilityReport>;
  readonly leaseTracker: ActiveTransportLeaseTracker;
}

function minimalIsolationFromExecutable(
  executable: VerifiedExecutable,
): IsolationProjection {
  return {
    credentialProjectionId: "production-binding",
    env: {},
    syntheticHome: "",
    syntheticConfigHome: "",
    syntheticTmp: "",
    verifiedBinaryPath: executable.verifiedExecutionPath,
  };
}

class FrozenRuntimeBinding implements RuntimeBinding {
  readonly observedOpenCodeIdentity?: OpenCodeObservedIdentity;
  readonly key: string;
  readonly route: ResolvedModelRoute;
  readonly executable: VerifiedExecutable;
  readonly credential: RuntimeBindingCredential;
  readonly environment: EnvironmentPolicy;
  readonly tools = Object.freeze({
    allowMapOnly: true,
    deniedTools: Object.freeze(["bash", "Write", "Edit", "Task"]),
  });
  readonly mcp = Object.freeze({
    codegraphOnly: true,
    verifiedConfigRequired: true,
  });

  private readonly authority: ResolvedBindingAuthority;
  private readonly getCapabilityReport: (
    backend: RunnerBackend,
  ) => Promise<ProviderCapabilityReport>;
  private readonly leaseTracker: ActiveTransportLeaseTracker;

  constructor(options: FrozenRuntimeBindingOptions) {
    this.key = options.key;
    this.observedOpenCodeIdentity =
      options.observedOpenCodeIdentity === undefined
        ? undefined
        : Object.freeze({ ...options.observedOpenCodeIdentity });
    this.route = Object.freeze({ ...options.route });
    this.executable = Object.freeze({ ...options.executable });
    this.credential = Object.freeze({ ...options.credential });
    // `syntheticHome` answers ONE question: "is a credential broker
    // configured for this binding?" — not "did this step's harness run get
    // a fresh per-step projection from it." Those coincided for claude-code
    // (the only consumer, until OpenCode existed). They stopped coinciding
    // for OpenCode: since #149 this broker (`OpenCodeAuthBroker` /
    // `OpenCodeFreeBroker`, runner-authority.ts) protects the SERVER's one
    // lifetime projection, and since #150 `StepExecutionHarness.run`
    // deliberately never calls it per step for this backend
    // (`OpenCodeSdkTransport.credentialProjection === "server-lifetime"`,
    // contracts.ts/opencode-sdk.ts) because nothing downstream would read
    // that per-step result. `syntheticHome: true` stays an accurate claim
    // either way — broker authority IS configured and IS what protects the
    // inference — it just protects it at server scope, not step scope, for
    // this backend.
    this.environment = Object.freeze({
      syntheticHome: options.credential.broker !== undefined,
      workspaceReadBroker: true,
    });
    this.authority = options.authority;
    this.getCapabilityReport = options.getCapabilityReport;
    this.leaseTracker = options.leaseTracker;
    Object.freeze(this);
  }

  async capabilities(): Promise<ExactBindingCapabilityReport> {
    const report = await this.getCapabilityReport(this.route.backend);
    // "Broker configured", not "per-step projection actually taken" — see
    // the WHY comment on `this.environment` above (#149/#150: for OpenCode
    // this broker protects the server's lifetime projection, and the
    // harness now skips the per-step call this flag used to imply).
    const projectionBrokered = this.credential.broker !== undefined;
    const sdkAvailable =
      this.route.backend === "claude-code" ||
      !report.issues.some(
        (issue) => issue.code === "real_sdk_adapter_deferred_to_d1_11",
      );
    // #133. ONE effective billing mode, computed once and fed to all THREE
    // readers below (`pricingApplicable`, `billingMode`,
    // `cashCostAccountingValid`). They used to read `report.billing.mode`
    // independently, and that is precisely the trap: upgrading only
    // `billingMode` would leave `pricingApplicability` at "not_applicable",
    // the pricing gate would never fire, and a metered route would be
    // admitted as priced-not-required — executing on real spend while
    // reporting `cashCostUsd: 0`. Under-reporting is the failure this whole
    // issue exists to prevent, so the correction has to be applied ONCE,
    // upstream of every consumer, not per-expression.
    //
    // The legacy backend-wide report cannot know this: it is produced before
    // any route resolves, so it cannot see the provider. The credential KIND
    // can — `provider_api_token` IS a metered API token by definition
    // (runner-authority.ts credentialKindForRoute).
    //
    // 2026-09-02: that "by definition" moved into `credentialKindBillsMetered`
    // rather than staying an inline comparison, because a SECOND caller
    // appeared — the OpenCode transport factory, which stamps the same
    // billing mode onto every usage record so the report and the records
    // cannot disagree about one attempt. Two copies of the rule would be two
    // chances for exactly that disagreement.
    //
    // UPGRADE ONLY, never downgrade. An OAuth or subscription kind keeps
    // whatever the transport reported, `unknown` included — which is what
    // keeps the narrowing guarantee below true for every other kind.
    const effectiveBillingMode: ProviderCapabilityReport["billing"]["mode"] =
      credentialKindBillsMetered(this.credential.kind)
        ? "metered"
        : report.billing.mode;
    const pricingApplicable =
      effectiveBillingMode === "metered" ? "required" : "not_applicable";
    // The legacy report carries THREE billing modes (subscription | metered |
    // unknown) and the exact contract carries two, so `unknown` narrows into
    // "subscription" here. WHY that narrowing is not a lie: it is sound ONLY
    // because `cashCostAccountingValid` below reads the three-state
    // `effectiveBillingMode` and independently blocks `unknown` — the design
    // doc makes `billingMode: "unknown"` a blocking preflight result
    // (docs/multi-runtime-model-diversity-design.md:461), and the pricing
    // gate cannot enforce it because `unknown` is not `metered`, leaving
    // pricingApplicability at "not_applicable". Delete or weaken the
    // cash-cost derivation and this narrowing silently starts claiming that
    // an unknown-billing route bills like a subscription.
    //
    // #133 keeps that intact: the effective mode only ever REPLACES `unknown`
    // with `metered`, and a metered route is caught by the pricing gate
    // instead. Nothing reaches "subscription" that did not already.
    const billingMode: ExactBindingCapabilityReport["billing"]["mode"] =
      effectiveBillingMode === "metered" ? "metered" : "subscription";
    // #197. ONE source, and it is the transport's own claim. This used to be
    // a disjunction — the transport's `pricingReady` OR a bundled per-model
    // rate table selected by `this.route.provider` — and the table half is
    // deleted, along with the loader, the 90-day freshness window and the
    // `config/models/*-pricing.json` files behind it.
    //
    // WHY the table lost, given the design line (§8 line 461) names "provider
    // cost or a versioned rate table": our table was a hand-transcribed
    // snapshot of the same published LIST prices the transports report, and
    // it aged on our release cadence rather than the tool's. It expired after
    // 90 days and REFUSED the route it was meant to enable, it covered only
    // what someone remembered to transcribe (the zai table priced 11 of the
    // 16 models `opencode models` reports, five days after it landed), and a
    // new model was absent until noticed. The transports report a live figure
    // for whatever they actually ran.
    //
    // Both backends now answer for themselves: OpenCode reads a non-optional
    // `cost` off every assistant message, and the Claude CLI reports
    // `total_cost_usd` (#197 flipped that flag). A transport that reports NO
    // cost is refused — which is the gate's whole purpose, unchanged: refuse
    // to bill an unknown amount. What moved is where the unknown is answered.
    // A missing figure is now caught at SETTLEMENT, where the answer is
    // actually known (`settlementFromUsage`, spend-limiter.ts: complete usage
    // with no cash cost settles `unresolved`, never 0), instead of being
    // guessed at admission from a table that might be stale.
    const tokenPricingAvailable = report.billing.pricingReady;
    // Spec (same design line): subscription OAuth may truthfully report
    // `cashCostUsd: 0`; metered routes require a cost source; unknown is
    // blocking. Read off `tokenPricingAvailable` rather than the raw flag so
    // the two cannot drift — a metered report claiming
    // priced-but-not-accountable is self-contradictory and would strand the
    // route in a gate that no longer has a reason to refuse it.
    const cashCostAccountingValid =
      effectiveBillingMode === "subscription"
        ? true
        : effectiveBillingMode === "metered"
          ? tokenPricingAvailable
          : false;
    return {
      routeKey: this.key,
      backend: this.route.backend,
      sdk: { available: sdkAvailable },
      binary: {
        resolved: true,
        absolutePath: this.executable.absolutePath,
        sha256: this.executable.sha256,
      },
      auth: {
        // #182 SCOPE NOTE (b): the transport's backend-wide report hardcodes
        // `kind: "opencode_chatgpt_oauth"` (src/transports/opencode-sdk.ts:389)
        // because it is produced before any route resolves and cannot see the
        // provider — let alone the model the free verdict needs. A free route
        // never observes it: the exact binding overwrites kind with
        // `this.credential.kind` here, so backend-wide stays a fallback for
        // kind-less callers and per-route truth lives on the binding.
        kind: this.credential.kind,
        projectionReady: projectionBrokered,
        probe: projectionBrokered ? report.auth.probe : "not_run",
      },
      environment: {
        // Same "broker configured" meaning as `projectionBrokered` above,
        // not "this step got its own projection" — see the #149/#150 WHY
        // comment on `this.environment` in the constructor.
        syntheticHome: projectionBrokered,
        enumeratedPassthrough: !projectionBrokered,
      },
      isolation: {
        workspaceReadBroker: report.isolation.workspaceReadBroker,
        codegraphPolicy: report.isolation.codegraphPolicy,
      },
      toolsMcp: {
        allowMapEnforced: this.tools.allowMapOnly,
        mcpIntegrityChecked: this.mcp.verifiedConfigRequired,
      },
      protocol: {
        terminalProof: report.protocol.terminalProof,
        boundedEvents: report.protocol.boundedEvents,
        usageMode: report.protocol.usageMode,
      },
      usage: { normalized: true },
      billing: {
        mode: billingMode,
        pricingApplicability: pricingApplicable,
        tokenPricingAvailable,
        cashCostAccountingValid,
      },
    };
  }

  async acquire(
    _isolation: IsolationProjection,
    registry: {
      get(
        backend: RunnerBackend,
        options?: TransportFactoryOptions,
      ): ProviderTransport;
      release?(routeFingerprint: string): void;
    },
  ): Promise<TransportLease> {
    const transport = registry.get(this.route.backend, {
      routeFingerprint: this.key,
      route: this.route,
      // 2026-09-02: the SAME field `capabilities()` derives
      // `effectiveBillingMode` from, handed to the transport factory that
      // derives `usageBillingMode`. One fact, one source — because it was two,
      // and two derivations of one fact diverge in silence (#149's "two
      // brokers", identical shape).
      //
      // `this.credential.kind` is authoritative and the factory's own
      // `merged.credentialKind` is not: this kind was resolved BY THIS ROUTE
      // through `resolveBindingAuthority` -> `credentialKindForRoute(backend,
      // provider)`, while the factory could only ever read a registry-wide
      // default fixed at construction. `productionFallbackRegistry` is the
      // ONLY wiring that sets that default, and it runs only for a caller
      // that supplies no registry — so the public `createProductionRuntime`,
      // which accepts an arbitrary `options.registry`, bypassed it entirely
      // and the factory silently fell back to "subscription" on a metered
      // route. That stamp is what `settlementFromUsage`'s metered-zero rule
      // keys on, so the fallback made the rule DEAD: an unaccountable
      // provider $0 settled as a truthful cost instead of fencing the bucket.
      // (`collectDoctorExactBindingReports` supplies its own kind-less
      // registry too, but it only ever calls `capabilities()` — no attempt,
      // so no usage record, so nothing there could observe the divergence.
      // Being unobservable is what let it ship.)
      //
      // Required on `RuntimeBindingCredential`, so it is forwarded
      // unconditionally rather than through a conditional spread — and
      // `get()` merges `{ ...defaultOptions, ...options }`, so this wins over
      // the construction-time default rather than being shadowed by it. That
      // default survives as the fallback for callers holding no binding.
      credentialKind: this.credential.kind,
      ...(this.route.backend === "opencode"
        ? {
            openCodeBinaryPath: this.executable.absolutePath,
            observedOpenCodeIdentity: this.observedOpenCodeIdentity,
            // U4 (S9): the broker travels with its kind, for the same reason.
            // The server this route's transport launches is projected by
            // `openCodeLaunchServerFor(merged)` from `merged.credentialBroker`,
            // which used to be only the registry-wide default: one broker for
            // every OpenCode route, so a plan naming two providers would
            // project one provider's record into the other's server. This is
            // the binding's own instance, so the server, the binding and the
            // capability report share one credential per route (#149).
            ...(this.credential.broker === undefined
              ? {}
              : { credentialBroker: this.credential.broker }),
          }
        : {}),
    });
    const routeKey = this.key;
    this.leaseTracker.register(routeKey, transport);
    return {
      transport,
      dispose: async () => {
        await this.leaseTracker.endLease({ routeKey, registry });
      },
    };
  }
}

function toVerifiedExecutable(
  authority: ResolvedBindingAuthority,
): VerifiedExecutable {
  const entry = authority.executableAllowlist[0];
  return {
    absolutePath: entry.absolutePath,
    sha256: entry.sha256,
    verifiedExecutionPath: authority.binaryPath,
  };
}

function uniqueRoutesByFingerprint(
  plan: ResolvedRoutePlan,
): readonly ResolvedStepRoute[] {
  const seen = new Map<string, ResolvedStepRoute>();
  // Fallbacks included (S4): a fallback is bound up front with the rest, so
  // one that cannot run fails before the run spends, not when its turn comes.
  for (const step of planRoutes(plan)) {
    if (!seen.has(step.routeFingerprint)) {
      seen.set(step.routeFingerprint, step);
    }
  }
  return [...seen.values()];
}

function bindingBucketId(
  authority: ResolvedBindingAuthority,
  route: ResolvedModelRoute,
): string {
  const localKey = loadOrCreateBucketKey(homedir());
  return deriveBucketId(
    {
      provider: route.provider,
      credentialFingerprint: `${authority.credentialKind}:${authority.credentialRef}`,
    },
    localKey,
  );
}

// #279: the bucket a METERED claude-code binding of this SAME
// provider+credentialRef would compute — `bindingBucketId` above, with the
// credential kind hardcoded to `provider_api_token` instead of read off
// `binding.credential.kind`. Used ONLY to fence the one attempt whose
// Keychain projection degraded onto an ambient key/token (StepExecution-
// Harness's `degradedProjectionBucketId`), never as `rateLimitBucketId`
// itself — that stays the binding's OWN bucket, keyed on its REAL
// `credentialKind` (subscription), so a normal, non-degraded subscription
// attempt keeps landing where it always did.
//
// WHY a different bucket than the binding's own: the ledger's guarantee is
// "an unresolved bucket blocks the NEXT paid attempt of the SAME
// credential" (spend-limiter.ts). The credential that pays for a degraded
// attempt is the ambient API key/token, not the subscription OAuth record
// this binding otherwise authenticates with — those are two different
// credentials that happen to share one route. Fencing the subscription
// bucket here would block the next NON-degraded subscription attempt on
// this same route over dollars the OAuth credential never spent (and would
// widen the harness's own reservesSpend=false invariant: "a subscription
// binding reserves nothing" — production-runtime.test.ts). Fencing this
// mirrored bucket instead lands on the SAME identity a real metered
// claude-code binding of this provider+credentialRef would use (see
// `credentialKindForRoute`, runner-authority.ts — hasBroker=false is what
// produces `provider_api_token` for claude-code), so a later real metered
// attempt on the same credential is correctly refused too.
//
// Takes the provider + credentialRef directly rather than a
// `ResolvedBindingAuthority` (unlike `bindingBucketId` above): the ONE call
// site (`MultiProviderRunner.run`) only has the public `RuntimeBinding`,
// whose `credential.ref` already carries the same value `authority.
// credentialRef` would.
function degradedMeteredBucketId(
  provider: string,
  credentialRef: string,
): string {
  const localKey = loadOrCreateBucketKey(homedir());
  return deriveBucketId(
    {
      provider,
      credentialFingerprint: `provider_api_token:${credentialRef}`,
    },
    localKey,
  );
}

async function resolveFrozenBindings(
  plan: ResolvedRoutePlan,
  options: ProductionRuntimeOptions,
  registry: TransportRegistry,
  leaseTracker: ActiveTransportLeaseTracker,
): Promise<Map<string, RuntimeBinding>> {
  const bindings = new Map<string, RuntimeBinding>();
  const deps = options.authorityDeps ?? {};
  // #182: one verdict per (provider, model), shared across every binding in
  // this resolution — the same cache the admission passes down, so the server
  // credential and the bindings cannot disagree across two spawns.
  const observations = new Map<string, Promise<OpenCodeObservedIdentity>>();
  const freeVerdicts = new Map<string, Promise<boolean>>();
  const probeFree = async (
    provider: string,
    model: string,
  ): Promise<boolean> => {
    const probe = options.freeModelProbe;
    if (probe === undefined) return false;
    // WHY freeVerdictKey, not `${provider}/${model}`: model ids may contain
    // "/" (model/free-discovery.ts header test), so the join collides
    // ("a","b/c") vs ("a/b","c") — one verdict for two models.
    const key = freeVerdictKey(provider, model);
    const cached = freeVerdicts.get(key);
    if (cached !== undefined) return cached;
    const verdict = (async () => {
      try {
        return await probe(provider, model);
      } catch {
        // Fail closed: a throwing probe is an unknown price, not a free one.
        return false;
      }
    })();
    freeVerdicts.set(key, verdict);
    return verdict;
  };

  for (const step of uniqueRoutesByFingerprint(plan)) {
    const authorityResult = await resolveBindingAuthority(
      step.route.backend,
      // #133: the provider was in scope here all along and was dropped. It is
      // what decides the credential kind, and through it the billing mode.
      step.route.provider,
      options,
      deps,
    );
    if (
      authorityResult.error !== undefined ||
      authorityResult.binding === undefined
    ) {
      throw new ProductionRuntimeError(
        `binding authority unavailable for route ${step.routeFingerprint}: ${authorityResult.error}`,
      );
    }

    // #182: the free verdict needs (provider, modelSnapshot), and this is the
    // one place the route is in scope — `resolveBindingAuthority` only
    // receives the provider. When the authority resolved metered and the
    // live probe says free, swap in kind `provider_free` + the free broker
    // (selected via the kind-based selector, never a second kind derivation).
    // Fail closed: any probe failure keeps the metered kind.
    let authority = authorityResult.binding;
    if (
      step.route.backend === "opencode" &&
      authority.credentialKind === "provider_api_token" &&
      options.freeModelProbe !== undefined
    ) {
      const free = await probeFree(
        step.route.provider,
        step.route.modelSnapshot,
      );
      if (free) {
        // U4: the run's pool when there is one, so every route on this free
        // credential shares one broker with the server it launches.
        const freeBroker = openCodeBrokerForRoute(
          options,
          "provider_free",
          step.route.provider,
        );
        authority = {
          ...authority,
          credentialKind: "provider_free",
          credentialBroker: freeBroker,
        };
      }
    }
    const executable = toVerifiedExecutable(authority);
    let observedOpenCodeIdentity: OpenCodeObservedIdentity | undefined;
    if (step.route.backend === "opencode") {
      const key = JSON.stringify([executable.absolutePath, executable.sha256]);
      let observation = observations.get(key);
      if (observation === undefined) {
        observation = options.observeOpenCodeIdentity
          ? options.observeOpenCodeIdentity(executable, options.signal)
          : observeOpenCodeExecutable(executable, options.signal, {
              sdkVersion: readInstalledOpenCodeSdkVersion,
            });
        observations.set(key, observation);
      }
      observedOpenCodeIdentity = await observation;
      if (
        observedOpenCodeIdentity.executablePath !== executable.absolutePath ||
        observedOpenCodeIdentity.executableSha256 !== executable.sha256
      ) {
        throw new ProductionRuntimeError(
          "Observed OpenCode executable identity differs from frozen binding",
        );
      }
    }
    const binding = new FrozenRuntimeBinding({
      observedOpenCodeIdentity,
      key: step.routeFingerprint,
      route: step.route,
      authority,
      executable,
      credential: {
        kind: authority.credentialKind,
        ref: authority.credentialRef,
        ...(authority.credentialBroker
          ? { broker: authority.credentialBroker }
          : {}),
        bucketId: bindingBucketId(authority, step.route),
      },
      getCapabilityReport: (backend) =>
        registry.getCapabilityReport(backend, {
          mode: options.mode,
          evidence: options.evidence,
          binaryPath: authority.binaryPath,
          observedOpenCodeIdentity,
        }),
      leaseTracker,
    });
    bindings.set(step.routeFingerprint, binding);
    Object.freeze(binding);
  }

  return bindings;
}

export interface BindingsCapabilityGateResult {
  readonly decision: CapabilityGateDecision;
  readonly reports: readonly ExactBindingCapabilityReport[];
}

// SUGGESTION-1: `capabilities()` is deliberately NOT memoised — it re-probes
// on every call — so the reports gathered here are the expensive artifact,
// not a by-product to throw away. They are returned so a caller that needs
// both the gate decision and the facts (doctor) pays ONE probe pass.
// WHY this no longer short-circuits on the first blocking binding: doctor
// reports on every binding regardless of the decision, so stopping early
// would hand it a truncated view of the plan. The extra probes are bounded
// by plan size and only occur on the already-failing path.
export async function gateBindingsCapabilities(
  bindings: ReadonlyMap<string, RuntimeBinding>,
): Promise<BindingsCapabilityGateResult> {
  const reports: ExactBindingCapabilityReport[] = [];
  for (const binding of bindings.values()) {
    reports.push(await binding.capabilities());
  }
  const failed = reports
    .map((report) => exactBindingCapabilityGate(report))
    .find((gate) => !gate.ok);
  return { decision: failed ?? { ok: true }, reports };
}

export interface ProbeBindingsReadinessResult {
  readonly decision: CapabilityGateDecision;
  // The exact reports the decision was taken on, in binding order. Consumers
  // must reuse these instead of re-calling `capabilities()`.
  readonly reports: readonly ExactBindingCapabilityReport[];
  readonly bindings: ReadonlyMap<string, RuntimeBinding>;
  readonly registry: TransportRegistry;
  dispose(): Promise<void>;
}

export async function probeBindingsReadiness(
  options: ProductionRuntimeOptions,
): Promise<ProbeBindingsReadinessResult> {
  const workspaceAuth = authorizeWorkspaceCwd(
    options.workspaceRoot,
    options.workspaceRoot,
  );
  if (!workspaceAuth.approved) {
    throw new ProductionRuntimeError(
      `workspace root denied before binding probe: ${workspaceAuth.reason}`,
    );
  }

  const plan = freezeRoutePlan(options.plan);
  const registry = options.registry ?? productionFallbackRegistry(options);
  const leaseTracker = new DefaultActiveTransportLeaseTracker();
  const bindings = await resolveFrozenBindings(
    plan,
    options,
    registry,
    leaseTracker,
  );
  const { decision, reports } = await gateBindingsCapabilities(bindings);
  return {
    decision,
    reports,
    bindings,
    registry,
    dispose: async () => {
      await leaseTracker.releaseAll(registry);
    },
  };
}

// The plan `crysk doctor` probes: the active profile's hunter and refuter (on
// `claude`, the sonnet hunter and opus refuter a zero-config review runs),
// plus one step per distinct route `models` names, fallbacks included, so
// every binding a configured review could open is checked before a review
// needs it. Distinct by route, not by entry: an OpenCode effort is the route's
// variant and so a binding of its own, while a Claude effort is not part of
// the route and is probed once.
//
// `claudeRequired: false` (model-profiles S6, doctor.ts reviewNeedsClaude)
// means `models` sends every step elsewhere, so the profile's two steps, which
// no review would run, are left out: probing them would demand a Claude binding
// the configuration never opens. Absent or true keeps them, as before.
export function buildDoctorRoutePlan(
  models?: ModelsConfig,
  options: {
    readonly claudeRequired?: boolean;
    readonly profile?: ModelProfile;
  } = {},
): ResolvedRoutePlan {
  const profile = options.profile ?? CLAUDE_PROFILE;
  const profileAlias = (role: string) =>
    profileModelAlias(profileRoute(profile, role).model);
  const base = buildResolvedRoutePlan({
    agents: [
      {
        key: "reliability",
        role: "hunter",
        model: profileAlias("hunter.reliability"),
      },
      { key: "refuter", role: "refuter", model: profileAlias("refuter") },
    ],
  });
  if (models === undefined) return base;
  const baseSteps = options.claudeRequired === false ? [] : base.steps;
  const distinct = new Map<string, ResolvedStepRoute>();
  for (const entry of Object.values(models).flat()) {
    const step = resolveModelEntryRoute("doctor-model", "other", entry);
    // claudeRequired=false means no step the review runs is on Claude (a
    // Claude judge with the gate off, say), so probing it would contradict
    // the "not needed" answer and fail on a machine without the CLI.
    if (
      options.claudeRequired === false &&
      step.route.backend === "claude-code"
    ) {
      continue;
    }
    if (!distinct.has(step.routeFingerprint)) {
      distinct.set(step.routeFingerprint, step);
    }
  }
  return createResolvedRoutePlan([
    ...baseSteps,
    ...[...distinct.values()].map((step, i) => ({
      ...step,
      stepKey: `doctor-model-${i + 1}`,
    })),
  ]);
}

export async function collectDoctorExactBindingReports(input: {
  readonly workspaceRoot: string;
  readonly models?: ModelsConfig;
  // Whether any step the configuration resolves runs on the Claude CLI
  // (doctor.ts reviewNeedsClaude). Absent: required, as before.
  readonly claudeRequired?: boolean;
  readonly authorityDeps?: ResolveRunnerAuthorityDeps;
  readonly env?: RunnerAuthorityOptions["env"];
  readonly observeOpenCodeIdentity?: OpenCodeIdentityObserver;
  readonly loadSdk?: () => Promise<
    import("./transports/opencode-client").OpenCodeSdkLike
  >;
}): Promise<readonly ExactBindingCapabilityReport[]> {
  const plan = buildDoctorRoutePlan(
    input.models,
    input.claudeRequired === undefined
      ? {}
      : { claudeRequired: input.claudeRequired },
  );
  // U3: the doctor binds OpenCode routes the way a review's admission does, so
  // it reads the setup step's CRYSK_* manifest too.
  const openCodeSecretNames = planRoutes(plan).some(
    (step) => step.route.backend === "opencode",
  )
    ? readOpenCodeSecretNames(input.env ?? process.env)
    : undefined;
  const authority = await prepareProductionRunnerAuthority(
    input.workspaceRoot,
    plan,
    input.authorityDeps,
    {
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(openCodeSecretNames === undefined ? {} : { openCodeSecretNames }),
    },
  );
  if ("error" in authority) {
    throw new Error(authority.error);
  }
  // WHY the conformance mode is unconditional, and why `mode` is repeated on
  // BOTH the probe options and the registry: this diagnostic is the phase that
  // PRODUCES D1-11 readiness evidence, so gating it on that evidence can only
  // ever fail. It used to be split into two disagreeing branches — a
  // conformance registry when a test injected `loadSdk`, nothing at all
  // otherwise — and the injected branch was the only one any test exercised.
  // The real doctor/wizard path therefore reached the OpenCode transport
  // factory with no mode, which defaults to "production", and every OpenCode
  // route came back blocking. Passing `mode` here too is not redundant:
  // resolveFrozenBindings forwards `mode: options.mode` on every capability
  // call, and an explicit `undefined` key overrides the registry's default
  // through the factory's `{ ...defaultOptions, ...opts }` spread.
  const probe = await probeBindingsReadiness({
    ...authority,
    plan,
    observeOpenCodeIdentity: input.observeOpenCodeIdentity,
    workspaceRoot: input.workspaceRoot,
    authorityDeps: input.authorityDeps,
    mode: "conformance",
    registry: createDefaultTransportRegistry({
      mode: "conformance",
      env: authority.env,
      ...(input.loadSdk === undefined ? {} : { loadSdk: input.loadSdk }),
    }),
  });
  try {
    // SUGGESTION-1: the readiness probe already called capabilities() once
    // per binding to reach its decision. capabilities() re-probes on every
    // call, so re-collecting here would double the probe cost for a doctor
    // run that needs exactly the reports the gate already produced.
    return probe.reports;
  } finally {
    await probe.dispose();
  }
}

export function d1_11EvidenceFromExactBinding(
  report: ExactBindingCapabilityReport,
  sdkAvailable = report.sdk.available,
): D1_11ReadinessEvidence {
  return {
    sdkAvailable,
    credentialAuthority:
      report.auth.projectionReady || report.auth.probe === "passed",
    workspaceBroker: report.isolation.workspaceReadBroker,
    pricingReady:
      report.billing.pricingApplicability !== "required" ||
      report.billing.tokenPricingAvailable,
  };
}

export interface ProductionAdmissionContext {
  readonly registry: DefaultTransportRegistry;
  readonly authorityOptions: RunnerAuthorityOptions;
  readonly evidence: Map<RunnerBackend, D1_11ReadinessEvidence>;
  // #182: the memoised probe this admission decided the server credential
  // with. A caller building a runtime from this admission should forward the
  // SAME instance so bindings reuse its verdicts instead of re-spawning.
  readonly freeModelProbe?: FreeModelProbe;
}

// U4 (S9, L12 "Several providers"): the OpenCode credentials a plan runs on,
// one per (provider, kind). It replaces `soleOpenCodeCredential`, which refused
// any plan naming two providers, or mixing a free and a metered route, because
// one broker served every OpenCode route. Each route now carries its own broker
// to the server its transport launches (FrozenRuntimeBinding.acquire), and the
// registry caches one transport, so one server, per route: two routes on two
// credentials never share a server, and each server projects only its route's
// record (credential-broker.ts, buildOpenCodeProjection).
//
// A route's kind is `credentialKindForRoute` over the CRYSK_* names (U3), then
// `provider_free` when the run's free verdict for (provider, model) says so,
// the same upgrade `resolveFrozenBindings` applies to the binding, so the list
// and the bindings cannot disagree. Fallbacks count (S4): every model a role may
// run is bound up front.
export interface OpenCodeRouteCredential {
  readonly provider: string;
  readonly kind: CredentialKind;
}

export function planOpenCodeCredentials(
  plan: ResolvedRoutePlan,
  openCodeSecretNames: readonly string[] | undefined,
  freeVerdicts: ReadonlyMap<string, boolean> = new Map(),
): readonly OpenCodeRouteCredential[] {
  const credentials = new Map<string, OpenCodeRouteCredential>();
  for (const step of planRoutes(plan)) {
    if (step.route.backend !== "opencode") continue;
    const kind = openCodeRouteKind(step, openCodeSecretNames, freeVerdicts);
    credentials.set(JSON.stringify([step.route.provider, kind]), {
      provider: step.route.provider,
      kind,
    });
  }
  return [...credentials.values()].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) || a.kind.localeCompare(b.kind),
  );
}

// The kind one OpenCode route binds: planOpenCodeCredentials's rule, shared with
// admission's credential check (openCodeCredentialRefusal) so the two cannot
// disagree about which routes need a record.
function openCodeRouteKind(
  step: ResolvedStepRoute,
  openCodeSecretNames: readonly string[] | undefined,
  freeVerdicts: ReadonlyMap<string, boolean>,
): CredentialKind {
  const base = credentialKindForRoute(
    "opencode",
    step.route.provider,
    {},
    false,
    openCodeSecretNames,
  );
  return base === "provider_api_token" &&
    freeVerdicts.get(
      freeVerdictKey(step.route.provider, step.route.modelSnapshot),
    ) === true
    ? "provider_free"
    : base;
}

// The plan-wide credential, when there is exactly one. A single-credential plan
// keeps everything it had before U4: admission seeds that one broker into
// `credentialBrokers.opencode` and the registry's default broker and kind, so
// the bindings, the probe registry and the server all share one instance. A plan
// with no OpenCode route keeps the pre-#133 OAuth default (nothing reads it). A
// plan with several has no plan-wide answer: `undefined`, and every route
// brings its own.
export function soleOpenCodeCredentialOf(
  credentials: readonly OpenCodeRouteCredential[],
): OpenCodeRouteCredential | undefined {
  if (credentials.length === 0) {
    return {
      provider: OPENCODE_OAUTH_PROVIDER,
      kind: "opencode_chatgpt_oauth",
    };
  }
  return credentials.length === 1 ? credentials[0] : undefined;
}

// One broker cannot project several credentials: injected as
// `credentialBrokers.opencode`, it would serve every route, and a metered
// broker for one provider projects that provider's record into another
// provider's server, which no type lock catches when both kinds are metered.
// Refused by name, before anything runs.
function sharedOpenCodeBrokerRefusal(
  credentials: readonly OpenCodeRouteCredential[],
): string {
  return `a single OpenCode credential broker (credentialBrokers.opencode) cannot serve a plan on ${credentials.length} OpenCode credentials (${credentials.map((c) => `${c.provider} ${c.kind}`).join(", ")}); pass openCodeBrokerFor instead`;
}

// The free verdict of every metered OpenCode route in the plan, through the
// run's one memoised probe. OAuth routes never probe (a subscription model is
// not free by declaration), exactly as before U4.
async function openCodeFreeVerdicts(
  plan: ResolvedRoutePlan,
  openCodeSecretNames: readonly string[] | undefined,
  probe: FreeModelProbe,
): Promise<Map<string, boolean>> {
  const pairs = new Map<string, { provider: string; model: string }>();
  for (const step of planRoutes(plan)) {
    if (step.route.backend !== "opencode") continue;
    const kind = credentialKindForRoute(
      "opencode",
      step.route.provider,
      {},
      false,
      openCodeSecretNames,
    );
    if (kind !== "provider_api_token") continue;
    pairs.set(freeVerdictKey(step.route.provider, step.route.modelSnapshot), {
      provider: step.route.provider,
      model: step.route.modelSnapshot,
    });
  }
  const verdicts = new Map<string, boolean>();
  await Promise.all(
    [...pairs.entries()].map(async ([key, { provider, model }]) => {
      verdicts.set(key, await probe(provider, model));
    }),
  );
  return verdicts;
}

// S7 (E-g, E2): an OpenCode `models` entry's effort is sent as the model's
// variant, and OpenCode accepts a variant the model does not have without an
// error and runs it at the default level (L34). So every variant a plan would
// send, fallbacks included, is checked against the variants OpenCode lists for
// that model before the run starts, and refused by name: an unknown variant,
// a model with no variants, and a listing that could not be read all stop the
// review here, before the cost confirmation. A plan sending no variant (no
// OpenCode entry sets an effort, D1) checks nothing and spawns nothing.
//
// The listing is `opencode models <provider> --verbose --refresh`, the same
// read the free check makes (model/free-discovery.ts); admission launches no
// server, so the server's own model list is not reachable here.
export async function openCodeVariantRefusal(
  plan: ResolvedRoutePlan,
  probe: ModelVariantsProbe | undefined,
): Promise<string | undefined> {
  const checks = new Map<
    string,
    { readonly step: ResolvedStepRoute; readonly stepKeys: string[] }
  >();
  for (const step of planRoutes(plan)) {
    if (
      step.route.backend !== "opencode" ||
      step.route.modelVariant === undefined
    ) {
      continue;
    }
    const key = JSON.stringify([
      step.route.provider,
      step.route.modelSnapshot,
      step.route.modelVariant,
    ]);
    const found = checks.get(key);
    if (found === undefined) {
      checks.set(key, { step, stepKeys: [step.stepKey] });
    } else if (!found.stepKeys.includes(step.stepKey)) {
      found.stepKeys.push(step.stepKey);
    }
  }
  if (checks.size === 0) return undefined;
  const refusals = await Promise.all(
    [...checks.values()].map(async ({ step, stepKeys }) => {
      const variant = step.route.modelVariant ?? "";
      const what = `effort "${variant}" for ${step.logicalIdentity}`;
      const where = `(${stepKeys.join(", ")})`;
      const listing =
        probe === undefined
          ? {
              kind: "unavailable" as const,
              reason: "no OpenCode binary to list them with",
            }
          : await probe(step.route.provider, step.route.modelSnapshot);
      if (listing.kind === "unavailable") {
        return `${what} could not be checked against its OpenCode variants (${listing.reason}); OpenCode runs a variant the model does not have at its default level without an error, so the review does not start on an unchecked one: fix that, or remove the effort ${where}`;
      }
      if (listing.variants.length === 0) {
        return `${what} cannot apply: OpenCode lists no variants for this model, so it would run at its default level: remove the effort ${where}`;
      }
      if (!listing.variants.includes(variant)) {
        return `${what} is not one of its OpenCode variants (${listing.variants.join(", ")}), and OpenCode would run it at the model's default level without an error: write one of those, or remove the effort ${where}`;
      }
      return undefined;
    }),
  );
  const refused = refusals.filter(
    (refusal): refusal is string => refusal !== undefined,
  );
  return refused.length === 0 ? undefined : `models: ${refused.join("; ")}`;
}

// A plan refused because an OpenCode route has no credential record. `message`
// is the refusal; `failureClass` and `params` let the CI record classify it
// (CRYSK-CRED-UNUSABLE) and name the route's fixes. `params` describes the first
// route refused; the message names every one.
export interface OpenCodeCredentialRefusal {
  readonly message: string;
  readonly failureClass:
    | "missing_provider_record"
    | "missing_subscription_record"
    | "subscription_expiring";
  readonly params: {
    readonly backend: "opencode";
    readonly provider: string;
    readonly model: string;
    readonly step: string;
    readonly secret?: string;
  };
}

// The auth file's text, "{}" when there is no file (no record at all), or
// undefined when it exists and cannot be read. WHY a missing file is not an
// unreadable one: a CI run whose crysk-secrets built no OpenCode record writes no
// auth file (setup.ts, assembleOpenCodeAuth), and that is exactly the run this
// check exists to stop.
async function readOpenCodeAuthText(
  authPath: string,
): Promise<string | undefined> {
  try {
    return await Bun.file(authPath).text();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return code === "ENOENT" ? "{}" : undefined;
  }
}

// The refusal for one route's missing record, in CI and locally. In CI it also names
// the models input: setup builds the auth file only from the providers `models`
// names, so a secret passed for a model given through the model input never lands.
function missingRecordSentence(
  provider: string,
  kind: CredentialKind,
  stepKeys: readonly string[],
  inCi: boolean,
): { readonly text: string; readonly secret?: string } {
  const where = `models name OpenCode provider ${provider} (${stepKeys.join(", ")})`;
  const oauth = kind === "opencode_chatgpt_oauth";
  const record = oauth
    ? `${provider} subscription record`
    : `${provider} record`;
  if (!inCi) {
    return {
      text: oauth
        ? `${where}, but the OpenCode auth file has no ${record}: run \`opencode auth login\` and choose ChatGPT`
        : `${where}, but the OpenCode auth file has no ${record}: run \`opencode auth login\` and add ${provider}'s API key`,
    };
  }
  const token = opencodeSecretToken(provider);
  if (token === undefined) {
    return {
      text: `${where}, but the OpenCode auth file has no ${record}, and no CRYSK_OPENCODE_* secret name can carry this provider id`,
    };
  }
  const apiKey = `CRYSK_OPENCODE_${token}_API_KEY`;
  if (oauth) {
    const secret = `CRYSK_OPENCODE_${token}_OAUTH`;
    return {
      text: `${where}, but no ${secret} secret reached the run (the OpenCode auth file has no ${record}): set it, or ${apiKey} to bill per token, pass it in the crysk-secrets input, and name the model in the models input (the model input builds no OpenCode auth file)`,
      secret,
    };
  }
  return {
    text: `${where}, but no ${apiKey} secret reached the run (the OpenCode auth file has no ${record}): set it, pass it in the crysk-secrets input, and name the model in the models input (the model input builds no OpenCode auth file)`,
    secret: apiKey,
  };
}

// Every OpenCode route that will need a credential record, fallbacks included
// (admission binds every model a role may run), is checked against the auth file
// the run's env points to, the file the route's broker reads when it runs. A route
// whose kind is free needs none (OpenCodeFreeBroker runs on an empty tree). The
// check asks the brokers' own lookups, so it refuses exactly what the first step on
// that route would fail on (CRYSK-CRED-UNUSABLE, credential-broker.ts), only before
// anything is spent. It does not depend on the route's effort: a model with no
// effort used to pass admission and fail at its first hunter, one with an effort
// failed listing its variants with no word about the key.
//
// Not refused here: an auth file that exists and cannot be read, or is not a JSON
// object. The broker's own error names those when the route runs.
export async function openCodeCredentialRefusal(
  plan: ResolvedRoutePlan,
  openCodeSecretNames: readonly string[] | undefined,
  freeVerdicts: ReadonlyMap<string, boolean>,
  env: Readonly<Record<string, string | undefined>>,
  now: number = Date.now(),
): Promise<OpenCodeCredentialRefusal | undefined> {
  const needs = new Map<
    string,
    {
      readonly step: ResolvedStepRoute;
      readonly kind: CredentialKind;
      readonly stepKeys: string[];
    }
  >();
  for (const step of planRoutes(plan)) {
    if (step.route.backend !== "opencode") continue;
    const kind = openCodeRouteKind(step, openCodeSecretNames, freeVerdicts);
    if (kind === "provider_free") continue;
    const key = JSON.stringify([step.route.provider, kind]);
    const found = needs.get(key);
    if (found === undefined) {
      needs.set(key, { step, kind, stepKeys: [step.stepKey] });
    } else if (!found.stepKeys.includes(step.stepKey)) {
      found.stepKeys.push(step.stepKey);
    }
  }
  if (needs.size === 0) return undefined;
  const text = await readOpenCodeAuthText(resolveOpenCodeAuthPath(env));
  if (text === undefined) return undefined;
  const reader = async () => text;
  const inCi = env.GITHUB_ACTIONS === "true";
  const refused: {
    readonly sentence: string;
    readonly refusal: Omit<OpenCodeCredentialRefusal, "message">;
  }[] = [];
  for (const { step, kind, stepKeys } of needs.values()) {
    const provider = step.route.provider;
    const lookup =
      kind === "opencode_chatgpt_oauth"
        ? await lookupOpenCodeOAuthRecord(reader)
        : await lookupOpenCodeApiRecord(reader, provider);
    if (lookup.ok) {
      // A subscription login that would expire during the review: the review never
      // renews it (the broker empties a rotating provider's refresh token), so its
      // later steps would fail on a dead token. Refused before anything is spent.
      const expiresAt =
        kind === "opencode_chatgpt_oauth"
          ? recordExpiresAt(lookup.record)
          : undefined;
      if (
        expiresAt !== undefined &&
        expiresAt - now <= REVIEW_EXPIRY_MARGIN_MS
      ) {
        refused.push({
          sentence: `models name OpenCode provider ${provider} (${stepKeys.join(", ")}), but its subscription login ${expiresAt <= now ? "has expired" : `expires at ${new Date(expiresAt).toISOString()}, before the review would finish`}: the Crysk platform renews it ahead of time, or reconnect it in the Crysk dashboard (locally, run any \`opencode\` request to renew it)`,
          refusal: {
            failureClass: "subscription_expiring",
            params: {
              backend: "opencode",
              provider,
              model: step.route.modelSnapshot,
              step: stepKeys[0] ?? step.stepKey,
            },
          },
        });
      }
      continue;
    }
    if (
      lookup.failureClass !== "missing_provider_record" &&
      lookup.failureClass !== "missing_subscription_record"
    ) {
      continue;
    }
    const sentence = missingRecordSentence(provider, kind, stepKeys, inCi);
    refused.push({
      sentence: sentence.text,
      refusal: {
        failureClass: lookup.failureClass,
        params: {
          backend: "opencode",
          provider,
          model: step.route.modelSnapshot,
          step: stepKeys[0] ?? step.stepKey,
          ...(sentence.secret === undefined ? {} : { secret: sentence.secret }),
        },
      },
    });
  }
  const first = refused[0];
  if (first === undefined) return undefined;
  return {
    ...first.refusal,
    message: refused.map((r) => r.sentence).join("; "),
  };
}

export async function prepareProductionAdmissionContext(input: {
  readonly workspaceRoot: string;
  readonly plan: ResolvedRoutePlan;
  readonly authorityDeps?: ResolveRunnerAuthorityDeps;
  readonly observeOpenCodeIdentity?: OpenCodeIdentityObserver;
  readonly loadSdk?: () => Promise<
    import("./transports/opencode-client").OpenCodeSdkLike
  >;
  readonly env?: RunnerAuthorityOptions["env"];
  readonly claudeCredential?: RunnerAuthorityOptions["claudeCredential"];
  // U3: given (tests), or read here from the setup step's manifest beside the
  // OpenCode auth file `env` resolves to, once, when the plan names OpenCode.
  readonly openCodeSecretNames?: RunnerAuthorityOptions["openCodeSecretNames"];
  readonly credentialBrokers?: RunnerAuthorityOptions["credentialBrokers"];
  // U4: the run's per-credential broker pool (tests inject one over a fake
  // store); created here when absent and carried in the authority options.
  readonly openCodeBrokerFor?: RunnerAuthorityOptions["openCodeBrokerFor"];
  // False skips the missing-credential check: a local dry run authenticates
  // nothing, so it is never refused for a credential (src/review/run.ts).
  readonly checkCredentials?: boolean;
  // #182: see ProductionRuntimeOptions.freeModelProbe. U4: each metered
  // OpenCode route is asked about its own (provider, model) and binds free on a
  // true verdict, so a plan may mix free and metered routes, each billed by its
  // own kind. The memoised wrapper is returned so the runtime built from this
  // admission reuses its verdicts.
  readonly freeModelProbe?: FreeModelProbe;
  // S7: lists a model's OpenCode variants (openCodeVariantRefusal). Tests
  // inject one; otherwise it is built from the authority's OpenCode binary,
  // and only when the plan sends a variant.
  readonly modelVariantsProbe?: ModelVariantsProbe;
}): Promise<
  | ProductionAdmissionContext
  | {
      readonly error: string;
      // Set when the error is a route with no credential record (S1).
      readonly credentialRefusal?: OpenCodeCredentialRefusal;
    }
> {
  // U3: the CRYSK_OPENCODE_* names are read ONCE, here, and travel in the
  // authority options below, which the runtime and the binding probe are built
  // from, so the server's kind and every binding's kind follow the same names.
  const openCodeSecretNames =
    input.openCodeSecretNames ??
    (planRoutes(input.plan).some((step) => step.route.backend === "opencode")
      ? readOpenCodeSecretNames(input.env ?? process.env)
      : undefined);
  // U4: one broker per credential for the whole run, shared by the bindings
  // below, the runtime built from this admission and each route's server.
  const openCodeBrokerFor =
    input.openCodeBrokerFor ?? createOpenCodeBrokerPool();
  // #182 follow-up, CLI threading: the authority is resolved BEFORE probe
  // evaluation (not after) so the probe can be built from the
  // AUTHORITY-RESOLVED openCodeBinaryPath — never a second binary lookup for
  // the probe beside the one the authority already did. Reused below as the
  // final authorityOptions with only the decided broker overlaid, so no
  // second resolution runs either.
  const preliminaryAuthority = await prepareProductionRunnerAuthority(
    input.workspaceRoot,
    input.plan,
    input.authorityDeps,
    {
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.claudeCredential === undefined
        ? {}
        : { claudeCredential: input.claudeCredential }),
      ...(openCodeSecretNames === undefined ? {} : { openCodeSecretNames }),
      ...(input.credentialBrokers === undefined
        ? {}
        : { credentialBrokers: input.credentialBrokers }),
      openCodeBrokerFor,
    },
  );
  if ("error" in preliminaryAuthority) {
    return preliminaryAuthority;
  }
  // When the caller supplied no probe but the plan names opencode routes and
  // the authority resolved a binary, probe for real: without this nothing in
  // src/ ever supplies a freeModelProbe on the CLI path, so real runs never
  // upgrade and the feature is dead in production. Fail-closed (a spawn
  // failure probes false) and time-bounded (the probe's own 30s default), so
  // a missing/broken binary keeps the metered kind instead of hanging
  // admission. OAuth-only and claude-only plans skip it: no opencode route
  // means no model to ask about.
  let probeInput = input.freeModelProbe;
  if (
    probeInput === undefined &&
    preliminaryAuthority.openCodeBinaryPath !== undefined &&
    planRoutes(input.plan).some((step) => step.route.backend === "opencode")
  ) {
    probeInput = createFreeModelProbe({
      binaryPath: preliminaryAuthority.openCodeBinaryPath,
    });
  }
  let sharedFreeProbe: FreeModelProbe | undefined;
  let freeVerdicts = new Map<string, boolean>();
  if (probeInput !== undefined) {
    sharedFreeProbe = memoiseFreeModelProbe(probeInput);
    freeVerdicts = await openCodeFreeVerdicts(
      input.plan,
      openCodeSecretNames,
      sharedFreeProbe,
    );
  }
  // S1 (missing credential): after the free check, which decides which routes
  // need a record, and before the variants check, which lists the model through
  // the provider and fails with no word about the key when there is none. Skipped
  // on a dry run, and when the caller injected an OpenCode broker: the routes then
  // run on that broker, not on the auth file.
  if (
    input.checkCredentials !== false &&
    input.openCodeBrokerFor === undefined &&
    input.credentialBrokers?.opencode === undefined
  ) {
    const credentialRefusal = await openCodeCredentialRefusal(
      input.plan,
      openCodeSecretNames,
      freeVerdicts,
      input.env ?? process.env,
    );
    if (credentialRefusal !== undefined) {
      return { error: credentialRefusal.message, credentialRefusal };
    }
  }
  // S7: after the credential check, before the bindings and the cost
  // confirmation. The probe is built only when a route sends a variant, so a plan
  // without one spawns nothing new.
  const sendsVariant = planRoutes(input.plan).some(
    (step) =>
      step.route.backend === "opencode" &&
      step.route.modelVariant !== undefined,
  );
  if (sendsVariant) {
    const variantsProbe =
      input.modelVariantsProbe ??
      (preliminaryAuthority.openCodeBinaryPath === undefined
        ? undefined
        : createModelVariantsProbe({
            binaryPath: preliminaryAuthority.openCodeBinaryPath,
          }));
    const refusal = await openCodeVariantRefusal(input.plan, variantsProbe);
    if (refusal !== undefined) return { error: refusal };
  }
  const openCodeCredentials = planOpenCodeCredentials(
    input.plan,
    openCodeSecretNames,
    freeVerdicts,
  );
  const sole = soleOpenCodeCredentialOf(openCodeCredentials);
  if (sole === undefined && input.credentialBrokers?.opencode !== undefined) {
    return { error: sharedOpenCodeBrokerRefusal(openCodeCredentials) };
  }
  // #149: with ONE OpenCode credential the broker is resolved ONCE, here, and
  // seeded into the authority so binding resolution and the registry that
  // launches the server are handed the SAME object (#133: matched to the
  // plan's provider; #182: to its kind, so a free plan gets the free broker
  // everywhere). With several (U4) there is no plan-wide broker to seed: each
  // binding takes its credential's broker from the pool and carries it to its
  // own route's server (FrozenRuntimeBinding.acquire), which keeps the same
  // one-instance rule per credential.
  const credentialBrokers =
    sole === undefined
      ? { ...input.credentialBrokers }
      : {
          ...input.credentialBrokers,
          opencode:
            input.credentialBrokers?.opencode ??
            openCodeBrokerFor(sole.kind, sole.provider),
        };
  // The preliminary authority above, with only the decided broker overlaid —
  // re-resolving here would be a second binary lookup for the same binaries.
  const authorityOptions: RunnerAuthorityOptions = {
    ...preliminaryAuthority,
    credentialBrokers,
  };
  // The registry-wide default credential: only a one-credential plan has one.
  // It is the fallback for a transport built without a binding; every binding
  // forwards its own broker and kind on acquire().
  const registryCredential =
    sole === undefined
      ? {}
      : {
          // #149: the SAME instance seeded into the binding authority above.
          credentialBroker: credentialBrokers.opencode,
          // #133: and the kind it was resolved FOR. The launcher pairs the
          // two; sending the broker without its kind would leave the launcher
          // defaulting to the OAuth kind over an api-token broker.
          credentialKind: sole.kind,
        };

  const probeRegistry = createDefaultTransportRegistry({
    mode: "conformance",
    binaryPath: authorityOptions.binaryPath,
    openCodeBinaryPath: authorityOptions.openCodeBinaryPath,
    env: authorityOptions.env,
    ...registryCredential,
    ...(input.loadSdk !== undefined ? { loadSdk: input.loadSdk } : {}),
  });
  const probe = await probeBindingsReadiness({
    ...authorityOptions,
    plan: input.plan,
    workspaceRoot: input.workspaceRoot,
    registry: probeRegistry,
    observeOpenCodeIdentity: input.observeOpenCodeIdentity,
    mode: "conformance",
    authorityDeps: input.authorityDeps,
    // #182: the SAME memoised instance the credentials above were decided
    // with — bindings reuse its verdicts instead of re-spawning.
    ...(sharedFreeProbe === undefined
      ? {}
      : { freeModelProbe: sharedFreeProbe }),
  });
  if (!probe.decision.ok) {
    await probe.dispose();
    return {
      error: probe.decision.reason ?? "exact-binding readiness gate failed",
    };
  }

  const evidence = new Map<RunnerBackend, D1_11ReadinessEvidence>();
  const needsOpenCode = [...probe.bindings.values()].some(
    (binding) => binding.route.backend === "opencode",
  );
  if (needsOpenCode) {
    if (probeRegistry instanceof DefaultTransportRegistry) {
      try {
        await probeRegistry.probeOpenCodeSdk();
      } catch (error) {
        await probe.dispose();
        const message = error instanceof Error ? error.message : String(error);
        return { error: `OpenCode SDK pre-confirm failed: ${message}` };
      }
    }
    // U4: the backend's D1-11 evidence holds only when it holds for EVERY
    // OpenCode binding. It used to keep the last binding's, harmless while
    // every route shared one credential and wrong once they do not.
    let combined: D1_11ReadinessEvidence | undefined;
    for (const binding of probe.bindings.values()) {
      if (binding.route.backend !== "opencode") continue;
      const report = await binding.capabilities();
      const next = d1_11EvidenceFromExactBinding(report, true);
      combined =
        combined === undefined
          ? next
          : {
              sdkAvailable: combined.sdkAvailable && next.sdkAvailable,
              credentialAuthority:
                combined.credentialAuthority && next.credentialAuthority,
              workspaceBroker: combined.workspaceBroker && next.workspaceBroker,
              pricingReady: combined.pricingReady && next.pricingReady,
            };
    }
    if (combined !== undefined) evidence.set("opencode", combined);
  }
  await probe.dispose();

  const observedBinding = [...probe.bindings.values()].find(
    (binding): binding is FrozenRuntimeBinding =>
      binding instanceof FrozenRuntimeBinding &&
      binding.route.backend === "opencode",
  );
  const registry = createDefaultTransportRegistry({
    mode: "production",
    observedOpenCodeIdentity: observedBinding?.observedOpenCodeIdentity,
    evidence,
    binaryPath: authorityOptions.binaryPath,
    openCodeBinaryPath: authorityOptions.openCodeBinaryPath,
    env: authorityOptions.env,
    ...registryCredential,
    ...(input.loadSdk !== undefined ? { loadSdk: input.loadSdk } : {}),
  }) as DefaultTransportRegistry;

  return {
    registry,
    authorityOptions,
    evidence,
    ...(sharedFreeProbe === undefined
      ? {}
      : { freeModelProbe: sharedFreeProbe }),
  };
}

// #182: one verdict per (provider, model) for the whole run. Memoised so the
// probe spawns at most once per pair however many steps name it, and fail
// closed: a throwing probe is an unknown price, not a free one.
//
// WHY freeVerdictKey, not `${provider}/${model}`: model ids may contain "/"
// (model/free-discovery.ts header test), so the join collides ("a","b/c") vs
// ("a/b","c") — one verdict for two models.
function memoiseFreeModelProbe(probe: FreeModelProbe): FreeModelProbe {
  const verdicts = new Map<string, Promise<boolean>>();
  return (provider: string, model: string) => {
    const key = freeVerdictKey(provider, model);
    const cached = verdicts.get(key);
    if (cached !== undefined) return cached;
    const verdict = (async () => {
      try {
        return await probe(provider, model);
      } catch {
        return false;
      }
    })();
    verdicts.set(key, verdict);
    return verdict;
  };
}

function createImmutableBindingsMap(
  bindings: Map<string, RuntimeBinding>,
): ReadonlyMap<string, RuntimeBinding> {
  const frozen = new Map(bindings);
  return new Proxy(frozen, {
    get(target, prop) {
      if (prop === "set" || prop === "delete" || prop === "clear") {
        return () => {
          throw new ProductionRuntimeError("runtime bindings are immutable");
        };
      }
      const value = Reflect.get(target, prop);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as ReadonlyMap<string, RuntimeBinding>;
}

export class MultiProviderRunner implements StepRunner {
  private readonly workspaceRoot: string;
  private readonly bindings: ReadonlyMap<string, RuntimeBinding>;
  private readonly registry: TransportRegistry;
  private readonly defaultBindingKey?: string;
  private readonly spawnFn?: typeof Bun.spawn;
  private readonly signal?: AbortSignal;
  private readonly attemptAdmissionGate?: AttemptAdmissionGate;
  private readonly graceMarginMs?: number;
  private readonly leaseTracker?: ActiveTransportLeaseTracker;
  // S5: the run env (one Claude credential, chosen at run start), handed to every
  // step's harness as its `childEnv`. Absent keeps the harness's own default, the
  // process environment.
  private readonly childEnv?: Readonly<Record<string, string | undefined>>;
  // 2026-09-02: ONE ledger for the whole run, and note the shape — it is
  // injectable but NOT optional-off, unlike `attemptAdmissionGate` beside it.
  // That difference is the point: the concurrency gate is an opt-in policy, a
  // spend ledger is a GUARANTEE. Before 2026-09-02 nothing in src/ built one,
  // and that absence made `settlementFromUsage` unreachable on every real run
  // — it is only ever called from `finalizeReservation`, which returns early
  // when no ledger is configured. An opt-in default would reintroduce exactly
  // that, one forgetful caller at a time.
  //
  // Run-scoped because this runner is: `createProductionRuntime` builds
  // exactly one `MultiProviderRunner` per run, while `run()` below builds a
  // FRESH `StepExecutionHarness` per step. A ledger constructed down there
  // would carry a `fencedBuckets` set that dies with the step — it would look
  // wired and fence nothing, which is worse than none because it reads as
  // covered. Holding it here is what makes the fence span the run.
  private readonly spendLedger: SpendLedger;

  constructor(options: {
    readonly workspaceRoot: string;
    readonly bindings: ReadonlyMap<string, RuntimeBinding>;
    readonly registry: TransportRegistry;
    readonly defaultBindingKey?: string;
    readonly spawnFn?: typeof Bun.spawn;
    readonly signal?: AbortSignal;
    readonly attemptAdmissionGate?: AttemptAdmissionGate;
    readonly graceMarginMs?: number;
    readonly leaseTracker?: ActiveTransportLeaseTracker;
    readonly childEnv?: Readonly<Record<string, string | undefined>>;
    // Injected only by tests that need to observe the CAS calls; production
    // takes the default, which is the whole point of defaulting rather than
    // requiring a caller to remember.
    readonly spendLedger?: SpendLedger;
  }) {
    this.workspaceRoot = options.workspaceRoot;
    this.bindings = options.bindings;
    this.registry = options.registry;
    this.defaultBindingKey = options.defaultBindingKey;
    this.spawnFn = options.spawnFn;
    this.signal = options.signal;
    this.attemptAdmissionGate = options.attemptAdmissionGate;
    this.graceMarginMs = options.graceMarginMs;
    this.leaseTracker = options.leaseTracker;
    this.childEnv = options.childEnv;
    this.spendLedger = options.spendLedger ?? new InMemorySpendLedger();
  }

  resolveBinding(step: StepSpec): RuntimeBinding | undefined {
    if (step.routeKey !== undefined) {
      return this.bindings.get(step.routeKey);
    }
    if (step.route !== undefined) {
      for (const binding of this.bindings.values()) {
        if (
          binding.route.backend === step.route.backend &&
          binding.route.provider === step.route.provider &&
          binding.route.modelFamily === step.route.modelFamily &&
          binding.route.modelSnapshot === step.route.modelSnapshot &&
          binding.route.modelVariant === step.route.modelVariant
        ) {
          return binding;
        }
      }
      return undefined;
    }
    if (this.defaultBindingKey !== undefined) {
      return this.bindings.get(this.defaultBindingKey);
    }
    if (this.bindings.size === 1) {
      return [...this.bindings.values()][0];
    }
    return undefined;
  }

  // A step whose role lists several models tries them in order (S4,
  // model-fallback.ts); every model's binding was frozen with the rest, so a
  // fallback runs through exactly the admission a first model does.
  //
  // "The same credential", for a refused login (`auth_invalid`), is the
  // binding's spend bucket: provider plus credential kind and ref
  // (`bindingBucketId`). Every Claude model shares one, so a Claude login
  // failure skips the other Claude models and moves to an OpenCode one, and
  // the reverse.
  async run(step: StepSpec): Promise<StepResult> {
    return runWithFallback({
      step,
      runOn: (single) => this.runOnBinding(single),
      credentialOf: (route) =>
        this.resolveBinding({ ...step, route, routeKey: undefined })?.credential
          .bucketId,
      cancelled: () => this.signal?.aborted === true,
    });
  }

  private async runOnBinding(step: StepSpec): Promise<StepResult> {
    const binding = this.resolveBinding(step);
    if (binding === undefined) {
      return {
        name: step.name,
        status: "failed",
        usage: zeroUsage(),
        attempts: 0,
        stderrTail:
          step.routeKey !== undefined
            ? `No admitted binding for routeKey ${step.routeKey}`
            : "No admitted binding for step route",
        resultText: "",
      };
    }

    const cwdAuth = authorizeWorkspaceCwd(this.workspaceRoot, step.cwd);
    if (!cwdAuth.approved) {
      return {
        name: step.name,
        status: "failed",
        denialCode: "path_not_approved",
        usage: zeroUsage(),
        attempts: 0,
        stderrTail: `Workspace denied: ${cwdAuth.reason}`,
        resultText: "",
      };
    }

    if (step.routeKey !== undefined && step.route !== undefined) {
      const driftError = validateRouteDrift(binding.route, step.route);
      if (driftError !== undefined) {
        return {
          name: step.name,
          status: "failed",
          usage: zeroUsage(),
          attempts: 0,
          stderrTail: driftError,
          resultText: "",
        };
      }
    }

    const policyError = await validateBindingAdmission(step, binding);
    if (policyError !== undefined) {
      return {
        name: step.name,
        status: "failed",
        usage: zeroUsage(),
        attempts: 0,
        stderrTail: policyError,
        resultText: "",
      };
    }

    if (
      binding.route.backend === "opencode" &&
      this.registry instanceof DefaultTransportRegistry &&
      this.registry.needsOpenCodeSdkProbe()
    ) {
      try {
        await this.registry.probeOpenCodeSdk();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          name: step.name,
          status: "failed",
          usage: zeroUsage(),
          attempts: 0,
          stderrTail: `OpenCode SDK pre-confirm failed: ${message}`,
          resultText: "",
        };
      }
    }

    const capabilityReport = await binding.capabilities();
    const capabilityGate = exactBindingCapabilityGate(capabilityReport);
    if (!capabilityGate.ok) {
      return {
        name: step.name,
        status: "failed",
        usage: zeroUsage(),
        attempts: 0,
        stderrTail: `Exact-binding capability gate failed: ${capabilityGate.reason}`,
        resultText: "",
      };
    }

    // 2026-09-02. WHICH steps reserve into the run's ledger: metered ones
    // only, read off the report the gate above just admitted rather than
    // re-derived from `binding.credential.kind`. One derivation of one fact —
    // the same `effectiveBillingMode` #133 computes once and feeds to all
    // three billing readers — so the fact that decided admission is the fact
    // that decides reservation.
    //
    // WHY not every step. The ledger's guarantee is "an unresolved bucket
    // blocks the next paid attempt", and `finalizeReservation` reaches it on
    // more than the metered-zero rule: partial usage, unavailable usage (an
    // OpenCode attempt where no usage event ever arrived, and ANY backend's
    // harness watchdog timeout, which normalizes to unavailable), and an
    // attempt that comes back `cancelled`. Any one of those fences the bucket
    // for the rest of the ledger's life.
    //
    // On a metered bucket that is exactly right and fail-closed: we do not
    // know what we spent, so we stop spending. On a SUBSCRIPTION bucket it
    // would refuse later steps over dollars that cannot be spent — and it
    // would do so against a pipeline built to survive exactly this. Hunters
    // run under `Promise.allSettled` and `runPipeline` tolerates a lost
    // hunter (`hunterFailures`, failing the run only when ALL of them fail),
    // so one hunter whose stdout would not parse would fence the credential
    // and take the refuter down with it. That trades a degraded run for a
    // dead one, buying nothing, on the one backend that demonstrably works
    // today.
    //
    // Same reasoning keeps `ClaudeCodeRunner` (step-runner.ts) ledger-free:
    // claude-code resolves to `claude_subscription_oauth` for every provider
    // (`credentialKindForRoute`), so the metered-zero rule structurally cannot
    // fire there. A ledger on that path is a state machine with no guarantee
    // to enforce. The known limitation, deliberately not addressed here: a
    // claude-code run under a real `ANTHROPIC_API_KEY` does spend money, but
    // the engine models that backend as subscription on purpose — ci/gates.ts
    // documents why deriving it instead is an ADMISSION hazard, and
    // `resolveCiBudgetCeiling` is where that case is handled.
    //
    // 2026-09-02, #177: one clause of that paragraph is no longer true and the
    // correction matters. Its usage RECORDS are no longer "truthfully
    // subscription" on every route — the Claude CLI transport now stamps
    // `metered` when the projected child env carries ANTHROPIC_API_KEY or
    // ANTHROPIC_AUTH_TOKEN, so the run's real spend reaches `cashCostUsd`
    // instead of being filed as an uncharged list price. This line is
    // deliberately unchanged: it reads the CAPABILITY REPORT, not the usage
    // record, so no reservation is opened, nothing is fenced, and no API-key
    // route loses admission. The record is honest; the gate stays where #161
    // must move it.
    //
    // A claude-only run therefore records no reservations at all, and the
    // absent `reservations` key on those steps is the truthful signal — not a
    // gap.
    //
    // #182 follow-up: free OpenCode bindings reserve too — read off the
    // credential KIND, not the report (which still says subscription for free
    // routes: capability `BillingMode` stays binary on purpose). Without a
    // reservation `finalizeReservation` never runs, the free-nonzero rule
    // (spend-limiter.ts) would be dead in production, and a flipped model
    // would keep spending attempts instead of fencing the bucket and failing
    // closed. A free step that stays free settles 0 and never fences, so the
    // subscription reasoning above ("refusing later steps over dollars that
    // cannot be spent") does not apply: only a priced flip, partial usage, or
    // unavailable usage fences a free bucket.
    const reservesSpend =
      capabilityReport.billing.mode === "metered" ||
      binding.credential.kind === "provider_free";

    // #279, 2026-09-24: the harness itself decides whether a SINGLE attempt
    // whose Keychain projection degraded onto an ambient key/token still
    // needs to reserve — a fact only it can see, per `run()`, not per
    // binding (see harness.ts's `reservesSpend`/`degradedProjectionBucketId`
    // options and their WHY). That requires the ledger to be REACHABLE from
    // every binding, subscription included, so `spendLedger` below is now
    // unconditional; `reservesSpend` still gates the binding's OWN
    // unconditional-per-attempt reservation exactly as it always has.
    const isolation = minimalIsolationFromExecutable(binding.executable);
    const lease = await binding.acquire(isolation, this.registry);
    const routeKey = binding.key;
    try {
      const harness = new StepExecutionHarness({
        workspaceRoot: this.workspaceRoot,
        executableAllowlist: [
          {
            absolutePath: binding.executable.absolutePath,
            sha256: binding.executable.sha256,
          },
        ],
        binaryPath: binding.executable.absolutePath,
        credentialBroker: binding.credential.broker,
        // S5: the same env the binding's credential kind was decided from
        // (`options.env`, resolveBindingAuthority), so the child runs on the one
        // credential the run chose and on nothing the process happens to hold.
        ...(this.childEnv === undefined ? {} : { childEnv: this.childEnv }),
        transport: lease.transport,
        spawnFn: this.spawnFn,
        signal: this.signal,
        ...(this.attemptAdmissionGate !== undefined
          ? { attemptAdmissionGate: this.attemptAdmissionGate }
          : {}),
        rateLimitBucketId: binding.credential.bucketId,
        // The bucket id is per provider+credential (`bindingBucketId`), so a
        // fence lands on the credential that could not account for its spend
        // and leaves every other route admissible.
        //
        // `reservedUsdPerAttempt` is deliberately left at the harness default
        // of 0 rather than given an invented number: `reservedUsd` is
        // RECORDED on the reservation and read by no gate anywhere — the
        // fence keys on `fencedBuckets`, never on an amount — so a figure
        // here would be a budget nobody has decided, dressed as one that was.
        //
        // #279: `spendLedger` is now handed to EVERY binding — see the WHY
        // just above `isolation` — with `reservesSpend` carrying the
        // per-binding decision the conditional spread used to encode. A
        // subscription binding (`reservesSpend: false`) still reserves
        // nothing on its own; only its harness's own degraded-projection
        // check (envBillsMetered on the actual child env) can open a
        // reservation now, and only into `degradedProjectionBucketId` —
        // the bucket a metered claude-code binding of this SAME
        // provider+credential would compute, never this binding's own
        // subscription bucket (see `degradedMeteredBucketId`'s WHY above).
        spendLedger: this.spendLedger,
        reservesSpend,
        degradedProjectionBucketId: degradedMeteredBucketId(
          binding.route.provider,
          binding.credential.ref,
        ),
        ...(this.graceMarginMs !== undefined
          ? { graceMarginMs: this.graceMarginMs }
          : {}),
        onBeforeCredentialProjectionDestroy: async () => {
          if (this.leaseTracker === undefined) {
            return;
          }
          await this.leaseTracker.teardownTransportIfLast({
            routeKey,
            transport: lease.transport,
          });
        },
      });

      return await harness.run({
        ...step,
        cwd: cwdAuth.canonicalCwd,
        route: binding.route,
        routeKey: binding.key,
        credentialKind: binding.credential.kind,
        credentialRef: binding.credential.ref,
      });
    } finally {
      await lease.dispose();
    }
  }
}

// #182 -> U4: never project a credential under a route of another kind. Before
// U4 one server credential served every route, so the guard compared it with
// the bindings; each route now carries its own broker to its own server, so
// the check is per binding: a free route on a non-free broker (or the reverse)
// is a wiring divergence (an admission and a runtime that decided the free
// verdict differently, typically a runtime built without the admission's
// probe), refused here by name instead of failing later at projection.
//
// A caller's single `credentialBrokers.opencode` on a plan with several
// OpenCode credentials is refused at admission (sharedOpenCodeBrokerRefusal),
// which is what every review builds its runtime from. A caller building a
// runtime directly (tests, probes) keeps its injected broker for every route,
// exactly as before U4.
function refuseOpenCodeBrokerMismatch(
  bindings: ReadonlyMap<string, RuntimeBinding>,
): void {
  const openCode = [...bindings.values()].filter(
    (b) => b.route.backend === "opencode",
  );
  // Only the production broker classes say which kind they project. Any other
  // broker (a caller's fake) is not judged here, as before U4; a real broker
  // handed the wrong kind still refuses it by name at projection.
  const mismatched = openCode
    .filter((b) => {
      const broker = b.credential.broker;
      const free = b.credential.kind === "provider_free";
      return (
        (broker instanceof OpenCodeFreeBroker && !free) ||
        ((broker instanceof OpenCodeApiTokenBroker ||
          broker instanceof OpenCodeAuthBroker) &&
          free)
      );
    })
    .map(
      (b) =>
        `${b.route.provider}/${b.route.modelSnapshot} ${b.credential.kind}`,
    )
    .sort();
  if (mismatched.length > 0) {
    throw new ProductionRuntimeError(
      `${mismatched.length} OpenCode binding(s) resolved a credential kind their broker does not project (${mismatched.join(", ")}); refusing to serve a free route from a metered projection or a metered route from an empty one (forward the admission's freeModelProbe so both share one verdict)`,
    );
  }
}

export async function createProductionRuntime(
  options: ProductionRuntimeOptions,
): Promise<ProductionRuntime> {
  const workspaceAuth = authorizeWorkspaceCwd(
    options.workspaceRoot,
    options.workspaceRoot,
  );
  if (!workspaceAuth.approved) {
    throw new ProductionRuntimeError(
      `workspace root denied before admission: ${workspaceAuth.reason}`,
    );
  }

  const plan = freezeRoutePlan(options.plan);
  // #182: when a probe is supplied but no registry is, decide the free
  // verdicts BEFORE building the fallback so the registry's default credential
  // and the bindings share one verdict. The memoised wrapper is what bindings
  // resolve with below — one spawn per (provider, model), never two that could
  // disagree.
  let effectiveOptions = options;
  let decidedCredentials: readonly OpenCodeRouteCredential[] | undefined;
  if (options.freeModelProbe !== undefined && options.registry === undefined) {
    const memoised = memoiseFreeModelProbe(options.freeModelProbe);
    effectiveOptions = { ...options, freeModelProbe: memoised };
    decidedCredentials = planOpenCodeCredentials(
      plan,
      options.openCodeSecretNames,
      await openCodeFreeVerdicts(plan, options.openCodeSecretNames, memoised),
    );
  }
  const registry =
    effectiveOptions.registry ??
    productionFallbackRegistry({
      mode: effectiveOptions.mode,
      evidence: effectiveOptions.evidence,
      binaryPath: effectiveOptions.binaryPath,
      env: effectiveOptions.env,
      credentialBrokers: effectiveOptions.credentialBrokers,
      openCodeSecretNames: effectiveOptions.openCodeSecretNames,
      plan,
      ...(decidedCredentials === undefined
        ? {}
        : { openCodeCredentials: decidedCredentials }),
    });

  const leaseTracker = new DefaultActiveTransportLeaseTracker();
  const bindings = await resolveFrozenBindings(
    plan,
    effectiveOptions,
    registry,
    leaseTracker,
  );
  refuseOpenCodeBrokerMismatch(bindings);
  // Backend-wide compatibility admission must consume the same observations
  // as exact bindings, not reconstruct an unobserved factory beside them.
  const compatibilityReports = new Map<
    RunnerBackend,
    ProviderCapabilityReport
  >();
  for (const binding of bindings.values()) {
    if (compatibilityReports.has(binding.route.backend)) continue;
    compatibilityReports.set(
      binding.route.backend,
      await registry.getCapabilityReport(binding.route.backend, {
        mode: options.mode,
        evidence: options.evidence,
        observedOpenCodeIdentity:
          binding instanceof FrozenRuntimeBinding
            ? binding.observedOpenCodeIdentity
            : undefined,
      }),
    );
  }
  const admitted = await admitRoutePlan(plan, registry, {
    capabilities: compatibilityReports,
    mode: options.mode,
    evidence: options.evidence,
  });

  const defaultClaude = [...bindings.values()].find(
    (binding) => binding.route.backend === "claude-code",
  );
  const runnerBindings = createImmutableBindingsMap(bindings);
  const runner = new MultiProviderRunner({
    workspaceRoot: options.workspaceRoot,
    bindings: runnerBindings,
    registry,
    defaultBindingKey: defaultClaude?.key,
    spawnFn: options.spawnFn,
    signal: options.signal,
    attemptAdmissionGate: options.attemptAdmissionGate,
    graceMarginMs: options.graceMarginMs,
    leaseTracker,
    ...(options.env === undefined ? {} : { childEnv: options.env }),
  });

  return {
    runner,
    registry,
    bindings: createImmutableBindingsMap(bindings),
    admitted,
    evidence: options.evidence,
    dispose: async () => {
      await leaseTracker.releaseAll(registry);
    },
  };
}

export function createClaudeCompatibilityRunner(
  options: RunnerAuthorityOptions,
  deps: ResolveRunnerAuthorityDeps = {},
): Promise<StepRunner> {
  return withClaudeDiscoveryAllowlist(options, deps).then((resolvedOptions) => {
    if ("error" in resolvedOptions) {
      throw new ProductionRuntimeError(resolvedOptions.error);
    }
    // Claude-only by construction; credentialKindForRoute ignores the
    // provider for this backend.
    return resolveBindingAuthority(
      "claude-code",
      "anthropic",
      resolvedOptions,
      deps,
    ).then((result) => {
      if (result.error !== undefined || result.binding === undefined) {
        throw new ProductionRuntimeError(
          result.error ?? "claude authority unavailable",
        );
      }
      const binding = result.binding;
      return new ClaudeCodeRunner({
        workspaceRoot: binding.workspaceRoot,
        binaryPath: binding.binaryPath,
        executableAllowlist: binding.executableAllowlist,
        ...(binding.credentialBroker
          ? { credentialBroker: binding.credentialBroker }
          : {}),
      });
    });
  });
}

export type { BindingAuthorityResolution, ResolvedBindingAuthority };

// #149, second round: the registry a caller gets when it supplies none. Shared
// by both fallbacks because they had drifted into the same defect twice — the
// caller supplied `credentialBrokers` and the registry dropped it, so the
// binding authority got the caller broker (runner-authority.ts:335) and the
// server that actually runs the inference got a fresh real one. Found by
// pr-hero own review of the first fix, which patched only the third site.
export function productionFallbackRegistry(options: {
  readonly mode?: "production" | "conformance";
  readonly evidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
  readonly binaryPath?: string;
  readonly openCodeBinaryPath?: string;
  // #161: matches `RunnerAuthorityOptions.env`'s widened shape — this
  // function is fed `options`/`authorityOptions` (both that type) directly.
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly credentialBrokers?: RunnerAuthorityOptions["credentialBrokers"];
  // U3: the same names the bindings read, so the server's kind follows them too.
  readonly openCodeSecretNames?: RunnerAuthorityOptions["openCodeSecretNames"];
  // #133: optional because this function is also called with a bare
  // `{ mode }` by callers that never reach an opencode route. When it IS
  // present it decides the credential KIND, and dropping it here is how this
  // fallback drifts from the binding authority for the THIRD time — the two
  // earlier rounds are recorded in the comment above, both found by pr-hero
  // reviewing its own fix.
  readonly plan?: ResolvedRoutePlan;
  // #182: async callers (createProductionRuntime with a freeModelProbe) decide
  // the free verdicts BEFORE building the fallback — this sync function cannot
  // spawn — and hand the decided credentials here so the registry's default
  // and the bindings share one verdict instead of two spawns that could
  // disagree.
  readonly openCodeCredentials?: readonly OpenCodeRouteCredential[];
}): TransportRegistry {
  // U4: the registry-wide default exists only when the plan runs on exactly one
  // OpenCode credential (or none: the pre-#133 OAuth default). With several,
  // there is no default, and nothing is refused: every binding forwards its own
  // broker and kind to the transport it acquires.
  const credential =
    options.openCodeCredentials !== undefined
      ? soleOpenCodeCredentialOf(options.openCodeCredentials)
      : options.plan === undefined
        ? undefined
        : soleOpenCodeCredentialOf(
            planOpenCodeCredentials(options.plan, options.openCodeSecretNames),
          );
  const kind = credential?.kind;
  // #182: when the decided kind is free and no broker was supplied, default to
  // the free broker — NOT the OAuth default in openCodeLaunchServerFor. That
  // default pairs an OAuth broker with whatever kind travels, and pairing it
  // with `provider_free` would refuse by name (loud but useless).
  //
  // #280 changed what this substitution costs. The free broker used to read
  // nothing, so a fresh instance here was indistinguishable from the caller's.
  // It now reads the provider's own `api` record from auth.json when one
  // exists, so a fresh instance here and another at the binding would be two
  // independent reads of the same mutable store — the "two brokers, diverging
  // in silence" class #149 closed. The production path never reaches this:
  // prepareProductionAdmissionContext resolves ONE broker and seeds it into
  // `credentialBrokers.opencode`, which both the bindings and this registry
  // receive. This default only serves callers that build a runtime without
  // that context (tests, probes); pass `credentialBrokers.opencode` to share.
  const needsFreeDefault =
    kind === "provider_free" &&
    options.credentialBrokers?.opencode === undefined;
  return createDefaultTransportRegistry({
    mode: options.mode,
    evidence: options.evidence,
    binaryPath: options.binaryPath,
    openCodeBinaryPath: options.openCodeBinaryPath,
    env: options.env,
    // Forwarded only when the caller actually supplied one. Substituting a
    // fresh broker here would erase the difference between "no preference"
    // and "use THIS one", which is the whole defect.
    ...(options.credentialBrokers?.opencode === undefined
      ? needsFreeDefault
        ? {
            credentialBroker: openCodeCredentialBrokerForKind(
              "provider_free",
              (credential as OpenCodeRouteCredential).provider,
            ),
          }
        : {}
      : { credentialBroker: options.credentialBrokers.opencode }),
    // The KIND travels even when the broker does not: the registry's own
    // default broker (openCodeLaunchServerFor) must be built for the plan's
    // provider, and its default kind must match whatever broker it ends up
    // with. Without this, a `zai` plan gave the binding an
    // OpenCodeApiTokenBroker and the server an OAuth broker asking for the
    // OAuth kind — which would project the operator's OpenAI record under a
    // zai route. Wrong, not loud, and the worse of the two failure shapes.
    ...(credential === undefined ? {} : { credentialKind: kind }),
  });
}
