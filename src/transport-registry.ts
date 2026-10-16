import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { capabilityGateDecision } from "#model/provider-capabilities";
import type { ResolvedRoutePlan, ResolvedStepRoute } from "#model/routing";
import { type AssetMode, detectAssetMode } from "./assets";
// Route-keyed transport factory/cache: one ProviderTransport instance per
// `${backend}:${routeFingerprint}`. `release()` drops a lease; teardown order
// inside OpenCodeSdkTransport is stream → client.close → server (harness owns
// step timeout and calls destroy on credential projection after transport returns).
import type {
  CredentialKind,
  ProviderCapabilityReport,
  ProviderTransport,
  ResolvedModelRoute,
  RunnerBackend,
} from "./execution/contracts";
import type { UsageBillingMode } from "./execution/usage-normalized";
import { prheroLayout } from "./home-preflight";
import { credentialKindBillsMetered } from "./runner-authority";
import {
  type CredentialBroker,
  OpenCodeAuthBroker,
} from "./security/credential-broker";
import { redactDiagnostic } from "./security/redact";
import { ClaudeCodeCliTransport } from "./transports/claude-code-cli";
import {
  type OpenCodeObservedIdentity,
  OpenCodeSdkUnavailableError,
  openCodeSdkLoadFailedMessage,
  openCodeSdkUnavailableMessage,
  qualifyOpenCodeServer,
} from "./transports/opencode-admission";
import {
  assertOpenCodeSdk,
  createOpenCodeClient,
  type OpenCodeSdkLike,
} from "./transports/opencode-client";
import type { OpenCodeMcpConfig } from "./transports/opencode-mcp";
import {
  type OpenCodeClientLike,
  OpenCodeSdkTransport,
} from "./transports/opencode-sdk";
import {
  launchProjectedOpenCodeServer,
  type OpenCodeServerHandle,
} from "./transports/opencode-server";

const OPENCODE_SDK_PACKAGE_SPECIFIER = "@opencode-ai/sdk/package.json";
// The CLIENT entry, not the full `/v2` index. `/v2` re-exports
// `dist/v2/server.js`, which imports `cross-spawn`, whose nested
// `require("which")` Bun's `--compile` runtime does not resolve for a package
// living outside the binary (under ~/.prhero/node_modules). Why the compiled
// runtime fails there is not established; that it fails is. pr-hero never
// launches the SDK's own server (see
// src/transports/opencode-server.ts's WHY-NOT header) — it only ever needs
// `createOpencodeClient` (assertOpenCodeSdk) — so `/v2/client` is both
// sufficient and the only one of the two that loads inside a compiled binary.
// Confirmed by a discriminating repro compiled with `bun build --compile`:
// `dist/v2/index.js` throws `Cannot find package 'which'`, `dist/v2/client.js`
// exports `createOpencodeClient` cleanly, and its relative import graph
// (gen/client/client.gen.js, gen/sdk.gen.js, ../error-interceptor.js) carries
// no bare imports.
const OPENCODE_SDK_V2_SPECIFIER = "@opencode-ai/sdk/v2/client";

function openCodeSdkPackageJsonPath(nodeModulesDir: string): string {
  return path.join(nodeModulesDir, "@opencode-ai", "sdk", "package.json");
}

export interface OpenCodeSdkPackageMetadata {
  version?: string;
  exports?: unknown;
}

export interface OpenCodeSdkLoadOptions {
  importPackage?: () => Promise<OpenCodeSdkPackageMetadata>;
  importSdk?: () => Promise<unknown>;
  // Injected so a test can fail the bare specifier and serve the home tree.
  importSpecifier?: (specifier: string) => Promise<unknown>;
  // Injected so `bun test` (always `dev`) can exercise the compiled branch.
  // Absent mode is the only path that calls detectAssetMode().
  mode?: AssetMode;
  nodeModulesDir?: string;
}

export interface OpenCodeSdkImportPlan {
  readonly packageSpecifier: string;
  readonly v2Specifier: string | undefined;
  readonly packageJsonPath: string | undefined;
}

type DynamicImport = (specifier: string) => Promise<unknown>;

function createDynamicImport(): DynamicImport {
  return new Function("specifier", "return import(specifier)") as DynamicImport;
}

function resolveOpenCodeSdkLocation(options?: {
  mode?: AssetMode;
  nodeModulesDir?: string;
}): { mode: AssetMode; nodeModulesDir: string } {
  return {
    mode: options?.mode ?? detectAssetMode(),
    nodeModulesDir:
      options?.nodeModulesDir ?? prheroLayout(os.homedir()).nodeModulesDir,
  };
}

// Dev and npm keep bare specifiers. A compiled binary has no node_modules
// inside /$bunfs, so the package.json path is the product home and the v2
// entry is read from that file's exports — never a hardcoded dist path.
export function planOpenCodeSdkImport(input: {
  mode: AssetMode;
  nodeModulesDir: string;
}): OpenCodeSdkImportPlan {
  if (input.mode !== "compiled") {
    return {
      packageSpecifier: OPENCODE_SDK_PACKAGE_SPECIFIER,
      v2Specifier: OPENCODE_SDK_V2_SPECIFIER,
      packageJsonPath: undefined,
    };
  }
  const packageJsonPath = openCodeSdkPackageJsonPath(input.nodeModulesDir);
  return {
    packageSpecifier: pathToFileURL(packageJsonPath).href,
    v2Specifier: undefined,
    packageJsonPath,
  };
}

function asPackageJson(module: unknown): OpenCodeSdkPackageMetadata {
  if (typeof module !== "object" || module === null) return {};
  const record = module as OpenCodeSdkPackageMetadata & { default?: unknown };
  if (typeof record.version === "string" || record.exports !== undefined) {
    return record;
  }
  if (typeof record.default === "object" && record.default !== null) {
    return record.default as OpenCodeSdkPackageMetadata;
  }
  return record;
}

function normalizeSdkVersion(version: unknown): string | undefined {
  if (typeof version !== "string") return undefined;
  const trimmed = version.trim();
  return trimmed === "" ? undefined : trimmed;
}

// `exports["./v2/client"]` is either a relative string or `{ import:
// relative }`. Resolved against the package directory, then imported as a
// file URL. Reading the CLIENT sub-path, not `"./v2"` — see the WHY comment
// on OPENCODE_SDK_V2_SPECIFIER above; the full index pulls in cross-spawn,
// which does not resolve inside a compiled binary.
export function resolveOpenCodeSdkV2Entry(
  packageJson: { exports?: unknown },
  packageDir: string,
): string {
  const relative = readOpenCodeV2Export(packageJson.exports);
  if (relative === undefined) {
    throw new OpenCodeSdkUnavailableError(openCodeSdkUnavailableMessage());
  }
  return pathToFileURL(path.resolve(packageDir, relative)).href;
}

function readOpenCodeV2Export(exportsField: unknown): string | undefined {
  if (
    typeof exportsField !== "object" ||
    exportsField === null ||
    Array.isArray(exportsField)
  ) {
    return undefined;
  }
  const v2Client = (exportsField as Record<string, unknown>)["./v2/client"];
  if (typeof v2Client === "string" && v2Client.trim() !== "") return v2Client;
  if (
    typeof v2Client === "object" &&
    v2Client !== null &&
    !Array.isArray(v2Client)
  ) {
    const entry = (v2Client as Record<string, unknown>).import;
    if (typeof entry === "string" && entry.trim() !== "") return entry;
  }
  return undefined;
}

interface LoadedOpenCodeSdkPackage {
  version: unknown;
  packageJson: OpenCodeSdkPackageMetadata;
  packageDir: string;
  plan: OpenCodeSdkImportPlan;
}

async function readPackageJsonAt(packageJsonPath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    if (error instanceof OpenCodeSdkUnavailableError) throw error;
    throw new OpenCodeSdkUnavailableError(openCodeSdkUnavailableMessage());
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OpenCodeSdkUnavailableError(openCodeSdkUnavailableMessage());
  }
}

// Shared by the loader and the version reader so a compiled binary and
// doctor observe the same install.
async function readOpenCodeSdkPackage(
  options: OpenCodeSdkLoadOptions | undefined,
  dynamicImport: DynamicImport,
): Promise<LoadedOpenCodeSdkPackage> {
  const location = resolveOpenCodeSdkLocation(options);
  let plan = planOpenCodeSdkImport(location);
  const importSpecifier = options?.importSpecifier ?? dynamicImport;
  let raw: unknown;
  // Reconcile writes the pin under the product home in every asset mode.
  // Dev and npm still try the bare specifier first, so a checkout or a
  // global install wins. A known package.json is read from disk: import()
  // caches a file URL for the process, so the post-install read would keep
  // the pre-install version after npm overwrites the file.
  if (options?.importPackage) {
    try {
      raw = await options.importPackage();
    } catch (error) {
      if (error instanceof OpenCodeSdkUnavailableError) throw error;
      throw new OpenCodeSdkUnavailableError(openCodeSdkUnavailableMessage());
    }
  } else if (plan.packageJsonPath !== undefined) {
    raw = await readPackageJsonAt(plan.packageJsonPath);
  } else {
    try {
      raw = await importSpecifier(plan.packageSpecifier);
    } catch (error) {
      if (error instanceof OpenCodeSdkUnavailableError) throw error;
      const packageJsonPath = openCodeSdkPackageJsonPath(
        location.nodeModulesDir,
      );
      raw = await readPackageJsonAt(packageJsonPath);
      plan = {
        packageSpecifier: pathToFileURL(packageJsonPath).href,
        v2Specifier: undefined,
        packageJsonPath,
      };
    }
  }
  const packageJson = asPackageJson(raw);
  return {
    version: packageJson.version,
    packageJson,
    packageDir:
      plan.packageJsonPath !== undefined
        ? path.dirname(plan.packageJsonPath)
        : "",
    plan,
  };
}

// ONE loader for both consumers (the transport factory and probeOpenCodeSdk),
// so the probe proves exactly what the factory will get. `new Function` keeps
// the import out of the static graph — the SDK is an OPTIONAL dependency and
// a Claude-only install must never be asked to resolve it — but the RESULT is
// now validated instead of `as unknown as OpenCodeSdkLike`-cast. That cast was
// the root cause of issue #121: it silenced the only compiler check that could
// have noticed the local interface named a factory the SDK does not export.
export async function loadOpenCodeSdk(
  options?: OpenCodeSdkLoadOptions,
): Promise<OpenCodeSdkLike> {
  const dynamicImport = createDynamicImport();
  const loaded = await readOpenCodeSdkPackage(options, dynamicImport);
  const installedVersion = normalizeSdkVersion(loaded.version);
  if (installedVersion === undefined) {
    throw new OpenCodeSdkUnavailableError(openCodeSdkUnavailableMessage());
  }
  if (installedVersion !== SUPPORTED_OPENCODE_SDK_VERSION) {
    throw new OpenCodeVersionAdmissionError(
      `Unsupported OpenCode SDK version "${installedVersion}". Expected exact version "${SUPPORTED_OPENCODE_SDK_VERSION}".`,
    );
  }
  if (options?.importSdk) {
    return assertOpenCodeSdk(await options.importSdk());
  }
  const v2Specifier =
    loaded.plan.v2Specifier ??
    resolveOpenCodeSdkV2Entry(loaded.packageJson, loaded.packageDir);
  let sdkModule: unknown;
  try {
    sdkModule = await dynamicImport(v2Specifier);
  } catch (error) {
    if (error instanceof OpenCodeSdkUnavailableError) throw error;
    // The version check above already passed: the package IS installed, so
    // this catch is a genuine IMPORT failure (e.g. a compiled binary unable
    // to resolve cross-spawn's nested `require("which")`), never "not
    // installed". openCodeSdkLoadFailedMessage keeps the real cause instead
    // of collapsing it into the absence message below.
    throw new OpenCodeSdkUnavailableError(
      openCodeSdkLoadFailedMessage(v2Specifier, error),
    );
  }
  return assertOpenCodeSdk(sdkModule);
}

export async function readInstalledOpenCodeSdkVersion(options?: {
  mode?: AssetMode;
  nodeModulesDir?: string;
  importPackage?: OpenCodeSdkLoadOptions["importPackage"];
  importSpecifier?: OpenCodeSdkLoadOptions["importSpecifier"];
}): Promise<string | undefined> {
  try {
    const loaded = await readOpenCodeSdkPackage(options, createDynamicImport());
    return normalizeSdkVersion(loaded.version);
  } catch {
    return undefined;
  }
}

export class RouteAdmissionError extends Error {}

export const SUPPORTED_OPENCODE_SDK_VERSION = "1.18.25" as const;
export const SUPPORTED_OPENCODE_SERVER_VERSION = "1.18.30" as const;

// WHY a reason: this one class covers two refusals with different causes. "version"
// is a pinned pair the runtime does not match, and it is the default. "identity" is an
// observed runtime identity that production cannot establish, or one the declared
// versions contradict. Naming that a version mismatch would point at the wrong cause,
// so the CLI's classifier reads the reason (src/ci/classify-error.ts).
export class OpenCodeVersionAdmissionError extends RouteAdmissionError {
  readonly reason: "version" | "identity";

  constructor(message: string, reason: "version" | "identity" = "version") {
    super(message);
    this.name = "OpenCodeVersionAdmissionError";
    this.reason = reason;
  }
}

export function admitOpenCodeVersionPair(pair: {
  readonly sdkVersion?: unknown;
  readonly serverVersion?: unknown;
}): {
  readonly sdkVersion: typeof SUPPORTED_OPENCODE_SDK_VERSION;
  readonly serverVersion: typeof SUPPORTED_OPENCODE_SERVER_VERSION;
} {
  const { sdkVersion, serverVersion } = pair;
  if (typeof sdkVersion !== "string" || sdkVersion.trim() === "") {
    throw new OpenCodeVersionAdmissionError(
      `OpenCode SDK version is malformed or missing (got ${JSON.stringify(sdkVersion)}). Required exact version is "${SUPPORTED_OPENCODE_SDK_VERSION}".`,
    );
  }
  if (typeof serverVersion !== "string" || serverVersion.trim() === "") {
    throw new OpenCodeVersionAdmissionError(
      `OpenCode server version is malformed or missing (got ${JSON.stringify(serverVersion)}). Required exact version is "${SUPPORTED_OPENCODE_SERVER_VERSION}".`,
    );
  }
  if (
    sdkVersion !== SUPPORTED_OPENCODE_SDK_VERSION ||
    serverVersion !== SUPPORTED_OPENCODE_SERVER_VERSION
  ) {
    throw new OpenCodeVersionAdmissionError(
      `Unsupported OpenCode version pair: SDK "${sdkVersion}" and server "${serverVersion}". ` +
        `Only SDK "${SUPPORTED_OPENCODE_SDK_VERSION}" and server "${SUPPORTED_OPENCODE_SERVER_VERSION}" are admitted. ` +
        "Auto-upgrade, fallback, and version inference are denied.",
    );
  }
  return {
    sdkVersion: SUPPORTED_OPENCODE_SDK_VERSION,
    serverVersion: SUPPORTED_OPENCODE_SERVER_VERSION,
  };
}

export class OpenCodeProductionGatedError extends RouteAdmissionError {
  readonly missingPrerequisites: readonly string[];

  constructor(missingPrerequisites: readonly string[] = []) {
    const details =
      missingPrerequisites.length > 0
        ? `: missing D1-11 prerequisites: ${missingPrerequisites.join(", ")}`
        : "";
    super(
      `OpenCode runner backend is gated in production mode until all D1-11 readiness evidence is met${details}.`,
    );
    this.name = "OpenCodeProductionGatedError";
    this.missingPrerequisites = missingPrerequisites;
  }
}

export interface D1_11ReadinessEvidence {
  readonly sdkAvailable: boolean;
  readonly credentialAuthority: boolean;
  readonly workspaceBroker: boolean;
  readonly pricingReady: boolean;
  readonly issues?: readonly {
    code: string;
    message: string;
    blocking: boolean;
  }[];
}

export interface D1_11ReadinessResult {
  readonly ready: boolean;
  readonly missing: readonly string[];
}

export function checkD1_11Readiness(
  evidence?: D1_11ReadinessEvidence | ProviderCapabilityReport,
): D1_11ReadinessResult {
  if (!evidence) {
    return {
      ready: false,
      missing: [
        "sdkAvailable",
        "credentialAuthority",
        "workspaceBroker",
        "pricingReady",
      ],
    };
  }

  const missing: string[] = [];

  // Check if evidence is a ProviderCapabilityReport
  if ("auth" in evidence && "isolation" in evidence && "billing" in evidence) {
    const report = evidence as ProviderCapabilityReport;
    if (!report.auth.projectionReady) {
      missing.push("credentialAuthority");
    }
    if (!report.isolation.workspaceReadBroker) {
      missing.push("workspaceBroker");
    }
    if (!report.billing.pricingReady) {
      missing.push("pricingReady");
    }
    const hasDeferredSdkIssue = (report.issues ?? []).some(
      (i) => i.code === "real_sdk_adapter_deferred_to_d1_11",
    );
    if (hasDeferredSdkIssue) {
      missing.push("sdkAvailable");
    }
  } else {
    const d1Evidence = evidence as D1_11ReadinessEvidence;
    if (!d1Evidence.sdkAvailable) {
      missing.push("sdkAvailable");
    }
    if (!d1Evidence.credentialAuthority) {
      missing.push("credentialAuthority");
    }
    if (!d1Evidence.workspaceBroker) {
      missing.push("workspaceBroker");
    }
    if (!d1Evidence.pricingReady) {
      missing.push("pricingReady");
    }
  }

  return {
    ready: missing.length === 0,
    missing,
  };
}

export interface TransportFactoryOptions {
  readonly spawnFn?: typeof Bun.spawn;
  readonly openCodeClient?: OpenCodeClientLike;
  readonly loadSdk?: () => Promise<OpenCodeSdkLike>;
  // Free-tier gateway fix: widened to the same two-parameter signature as
  // `CreateOpenCodeClientOptions.launchServer` (opencode-client.ts) so an
  // injector here sees the second parameter exists — an injected launcher
  // that ignores it entirely still type-checks (fewer declared parameters
  // is a valid JS callback shape), which is exactly why createSession's own
  // attestation check exists: the type alone cannot force a launcher to
  // honour this argument, only createSession's runtime check can.
  readonly launchServer?: (
    mcp?: OpenCodeMcpConfig,
    freeTierGatewayAsk?: readonly string[],
  ) => Promise<OpenCodeServerHandle>;
  readonly readSystemPrompt?: (path: string) => Promise<string>;
  readonly readMcpConfig?: (path: string) => Promise<string>;
  readonly binaryPath?: string;
  readonly openCodeBinaryPath?: string;
  // #141: absolute, and resolved HERE rather than inside the client. The
  // client is the wrong place for a PATH lookup — the same rule
  // opencode-server.ts states for the opencode binary itself — and the
  // launcher-side default below keeps the operator's override on the same
  // option path as every other binary this registry hands out.
  readonly codegraphBinaryPath?: string;
  // #161: matches `RunnerAuthorityOptions.env`'s widened shape (it flows in
  // from there) and `baseEnv` below, which already accepted `string |
  // undefined` values — `process.env` itself is typed this way, and this
  // was the narrower link in that chain.
  readonly env?: Readonly<Record<string, string | undefined>>;
  // #149: the credential broker the authority resolved for the opencode
  // backend. The server runs under its projection for the servers whole life.
  readonly credentialBroker?: CredentialBroker;
  // #133: the KIND that broker was resolved for. Travels beside it and is
  // only ever meaningful as a pair — see openCodeLaunchServerFor.
  readonly credentialKind?: CredentialKind;
  readonly evidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
  readonly mode?: "production" | "conformance";
  readonly routeFingerprint?: string;
  readonly route?: ResolvedModelRoute;
  readonly observedOpenCodeIdentity?: OpenCodeObservedIdentity;
  readonly sdkVersion?: string;
  readonly serverVersion?: string;
  readonly openCodeServerVersion?: string;
  [key: string]: unknown;
}

export type TransportFactory = (
  options?: TransportFactoryOptions,
) => ProviderTransport | Promise<ProviderTransport>;

export interface TransportRegistry {
  register(
    backend: RunnerBackend,
    factoryOrInstance: ProviderTransport | TransportFactory,
  ): void;
  get(
    backend: RunnerBackend,
    options?: TransportFactoryOptions,
  ): ProviderTransport;
  has(backend: RunnerBackend): boolean;
  getCapabilityReport(
    backend: RunnerBackend,
    options?: TransportFactoryOptions,
  ): Promise<ProviderCapabilityReport>;
  getAllCapabilityReports(
    options?: TransportFactoryOptions,
  ): Promise<Map<RunnerBackend, ProviderCapabilityReport>>;
  release?(routeFingerprint: string): void;
}

export interface CreateTransportRegistryOptions
  extends TransportFactoryOptions {
  readonly mode?: "production" | "conformance";
}

export class DefaultTransportRegistry implements TransportRegistry {
  private readonly factories = new Map<
    RunnerBackend,
    ProviderTransport | TransportFactory
  >();
  private readonly instances = new Map<RunnerBackend, ProviderTransport>();
  private readonly routeInstances = new Map<string, ProviderTransport>();
  private readonly userOverriddenBackends = new Set<RunnerBackend>();
  private readonly defaultOptions: TransportFactoryOptions;

  // #149: read-only, and it exists for exactly one reason — the invariant that
  // the server launcher and the binding authority share ONE broker instance
  // was unobservable from outside, which is how the forwarding that claimed to
  // guarantee it shipped dead. Identity here is the assertion.
  get openCodeCredentialBroker(): CredentialBroker | undefined {
    return this.defaultOptions.credentialBroker;
  }

  // #133: the same reason, for the other half of the pair. The kind travels
  // beside the broker and decides which credential the server projects; a
  // fallback that silently dropped it would be unobservable from outside, and
  // an unobservable invariant is how the #149 forwarding shipped dead twice.
  get openCodeCredentialKind(): CredentialKind | undefined {
    return this.defaultOptions.credentialKind;
  }

  constructor(options: CreateTransportRegistryOptions = {}) {
    this.defaultOptions = { ...options };

    // Register Claude CLI transport factory
    this.register("claude-code", (opts) => {
      const merged = { ...this.defaultOptions, ...opts };
      return new ClaudeCodeCliTransport({
        spawnFn: merged.spawnFn,
      });
    });

    // Register OpenCode transport factory with D1-11 gate
    this.register("opencode", (opts) => {
      const merged = { ...this.defaultOptions, ...opts };
      const mode = merged.mode ?? "production";
      const evidence = merged.evidence?.get("opencode");

      // Check D1-11 readiness in production mode
      if (mode === "production") {
        const readiness = checkD1_11Readiness(evidence);
        if (!readiness.ready) {
          throw new OpenCodeProductionGatedError(readiness.missing);
        }
      }

      // Check bounded version admission policy (OA1b / U1-C1)
      const observed = merged.observedOpenCodeIdentity;
      if (mode === "production" && observed === undefined) {
        throw new OpenCodeVersionAdmissionError(
          "Observed OpenCode identity is required in production",
          "identity",
        );
      }
      admitOpenCodeVersionPair(
        observed ?? {
          sdkVersion: merged.sdkVersion,
          serverVersion: merged.serverVersion ?? merged.openCodeServerVersion,
        },
      );
      if (
        observed !== undefined &&
        ((merged.sdkVersion !== undefined &&
          merged.sdkVersion !== observed.sdkVersion) ||
          (merged.serverVersion !== undefined &&
            merged.serverVersion !== observed.serverVersion))
      ) {
        throw new OpenCodeVersionAdmissionError(
          "Declared OpenCode versions contradict observed identity",
          "identity",
        );
      }

      // 2026-09-02: the billing mode stamped on every usage record this
      // transport emits, derived from the credential kind the authority
      // resolved.
      //
      // WHY it cannot disagree with the exact-binding report, stated as the
      // mechanism rather than as a hope — because the first version of this
      // comment claimed the guarantee and the code did not make it. The
      // report's `effectiveBillingMode` reads `binding.credential.kind`
      // (production-runtime.ts), and `FrozenRuntimeBinding.acquire()` now
      // forwards THAT SAME field into `options.credentialKind` on the `get()`
      // that builds this transport. One fact, one source, and
      // `credentialKindBillsMetered` is the single predicate both sides apply
      // to it (#133) — so the two are structurally incapable of diverging.
      //
      // What the old wording got wrong: "THE factory is the only place that
      // holds both the kind and the transport" was true, and irrelevant, when
      // the kind could only arrive from construction-time `defaultOptions`.
      // Every caller of the public `createProductionRuntime` that supplies
      // its own registry bypasses the only wiring that sets it
      // (`productionFallbackRegistry`), so a metered route's records were
      // stamped "subscription" — which makes `settlementFromUsage`'s
      // metered-zero rule dead and lets an unaccountable provider $0 settle
      // as a truthful cost. `defaultOptions.credentialKind` is now the
      // FALLBACK for callers holding no binding; `get()`'s merge order
      // (`{ ...defaultOptions, ...options }`) lets the per-binding value win.
      //
      // Computed once, above both construction branches — wiring only the
      // second is how the injected-client path (every test and every doctor
      // probe) would keep the pre-#133 default.
      //
      // #182 follow-up: a `provider_free` kind stamps "free", checked BEFORE
      // the metered test (`credentialKindBillsMetered` is false for free, so
      // order is what keeps the stamp exact). Everything downstream passes the
      // mode through generically — the transport stamps it onto every usage
      // record (incl. `noSessionUsage`, which stays settleable at 0 with empty
      // tokens) and `settlementFromUsage`'s free-nonzero rule reads it.
      const usageBillingMode: UsageBillingMode =
        merged.credentialKind === "provider_free"
          ? "free"
          : merged.credentialKind !== undefined &&
              credentialKindBillsMetered(merged.credentialKind)
            ? "metered"
            : "subscription";

      const route = merged.route;
      const admissionIdentity = {
        executable: "opencode",
        provider: route?.provider ?? "opencode",
      };
      const defaultRoute: ResolvedModelRoute | undefined = route;

      if (merged.openCodeClient) {
        return new OpenCodeSdkTransport({
          client: merged.openCodeClient,
          billingMode: usageBillingMode,
          admissionIdentity,
          defaultRoute,
        });
      }

      // Resolved ONCE per client, before the options object is built: the
      // lookup hits the filesystem, and a spread that called it twice would
      // pay for it twice for one value.
      const codegraphBinaryPath =
        merged.codegraphBinaryPath ?? Bun.which("codegraph") ?? undefined;
      const client = createOpenCodeClient({
        // Free-tier gateway fix: the ONLY thing createSession reads this for
        // is gating FREE_TIER_GATEWAY_TOOLS (opencode-client.ts) — the same
        // per-route value `usageBillingMode` above and `openCodeLaunchServerFor`
        // below already read, so all three agree by construction.
        ...(merged.credentialKind === undefined
          ? {}
          : { credentialKind: merged.credentialKind }),
        ...(observed ? { observedIdentity: observed } : {}),
        ...(observed === undefined
          ? {}
          : {
              qualifyServer: (url: string, signal?: AbortSignal) =>
                qualifyOpenCodeServer(url, observed, signal),
            }),
        model: route
          ? {
              providerID: route.provider,
              modelID: route.modelSnapshot,
              ...(route.modelVariant !== undefined
                ? { variant: route.modelVariant }
                : {}),
            }
          : {
              providerID: "openai",
              modelID: "gpt-4o",
            },
        ...(route?.modelVariant !== undefined
          ? { variant: route.modelVariant }
          : {}),
        loadSdk: merged.loadSdk ?? loadOpenCodeSdk,
        launchServer: merged.launchServer ?? openCodeLaunchServerFor(merged),
        readSystemPrompt:
          merged.readSystemPrompt ??
          (async (filePath: string) => {
            return await readFile(filePath, "utf8");
          }),
        // #141: the SAME mcp.json `binding-policy.ts` already validates —
        // not a second, OpenCode-shaped registry the integrity gate would
        // never see. The path arrives on the request; this only reads it.
        readMcpConfig:
          merged.readMcpConfig ??
          (async (filePath: string) => {
            return await readFile(filePath, "utf8");
          }),
        // An unresolved binary is carried through as "unresolved" rather than
        // refused here: the translation is the only place that knows whether a
        // codegraph binary was needed at all. A repo with no index needs none,
        // and refusing to build a client for it would break the parity case
        // #116's ledger recorded as correct.
        ...(codegraphBinaryPath === undefined ? {} : { codegraphBinaryPath }),
      });

      return new OpenCodeSdkTransport({
        client,
        billingMode: usageBillingMode,
        admissionIdentity,
        defaultRoute,
      });
    });
  }

  register(
    backend: RunnerBackend,
    factoryOrInstance: ProviderTransport | TransportFactory,
  ): void {
    if (this.factories.has(backend)) {
      this.userOverriddenBackends.add(backend);
    }
    this.factories.set(backend, factoryOrInstance);
    this.instances.delete(backend);
    for (const key of [...this.routeInstances.keys()]) {
      if (key.startsWith(`${backend}:`)) {
        this.routeInstances.delete(key);
      }
    }
  }

  private routeCacheKey(
    backend: RunnerBackend,
    routeFingerprint: string,
  ): string {
    return `${backend}:${routeFingerprint}`;
  }

  async probeOpenCodeSdk(): Promise<void> {
    const loadSdk = this.defaultOptions.loadSdk ?? loadOpenCodeSdk;
    await loadSdk();
  }

  needsOpenCodeSdkProbe(): boolean {
    return !this.userOverriddenBackends.has("opencode");
  }

  release(routeFingerprint: string): void {
    for (const key of [...this.routeInstances.keys()]) {
      if (key.endsWith(`:${routeFingerprint}`)) {
        this.routeInstances.delete(key);
      }
    }
  }

  has(backend: RunnerBackend): boolean {
    return this.factories.has(backend);
  }

  get(
    backend: RunnerBackend,
    options?: TransportFactoryOptions,
  ): ProviderTransport {
    if (options?.routeFingerprint !== undefined) {
      const routeKey = this.routeCacheKey(backend, options.routeFingerprint);
      const routeCached = this.routeInstances.get(routeKey);
      if (routeCached !== undefined) {
        return routeCached;
      }
    } else if (!options) {
      const cached = this.instances.get(backend);
      if (cached !== undefined) {
        return cached;
      }
    }
    const entry = this.factories.get(backend);
    if (!entry) {
      throw new RouteAdmissionError(
        redactDiagnostic(`No transport registered for backend "${backend}"`),
      );
    }
    if (typeof entry === "function") {
      const merged = { ...this.defaultOptions, ...options };
      const instance = (entry as TransportFactory)(merged);
      if (instance instanceof Promise) {
        throw new RouteAdmissionError(
          `Async transport factory for backend "${backend}" cannot be resolved synchronously in get()`,
        );
      }
      if (options?.routeFingerprint !== undefined) {
        const routeKey = this.routeCacheKey(backend, options.routeFingerprint);
        this.routeInstances.set(routeKey, instance);
      } else if (!options) {
        this.instances.set(backend, instance);
      }
      return instance;
    }
    if (options?.routeFingerprint !== undefined) {
      const routeKey = this.routeCacheKey(backend, options.routeFingerprint);
      this.routeInstances.set(routeKey, entry);
    } else if (!options) {
      this.instances.set(backend, entry);
    }
    return entry;
  }

  async getCapabilityReport(
    backend: RunnerBackend,
    options?: TransportFactoryOptions,
  ): Promise<ProviderCapabilityReport> {
    const transport = this.get(backend, options);
    return await transport.capabilities();
  }

  async getAllCapabilityReports(
    options?: TransportFactoryOptions,
  ): Promise<Map<RunnerBackend, ProviderCapabilityReport>> {
    const reports = new Map<RunnerBackend, ProviderCapabilityReport>();
    for (const backend of this.factories.keys()) {
      try {
        const report = await this.getCapabilityReport(backend, options);
        reports.set(backend, report);
      } catch (err) {
        if (err instanceof OpenCodeProductionGatedError) {
          reports.set(backend, {
            backend,
            status: "blocking",
            auth: {
              kind: "opencode_chatgpt_oauth",
              projectionReady: false,
              probe: "not_run",
            },
            isolation: {
              syntheticHome: false,
              workspaceReadBroker: false,
              codegraphPolicy: false,
            },
            protocol: {
              terminalProof: true,
              boundedEvents: true,
              usageMode: "none",
            },
            cancellation: {
              deadlineMs: 6500,
              conformance: "passed",
            },
            billing: {
              mode: "subscription",
              // #137 leaves this hardcoded: no model id is in scope. This is
              // the synthetic report for a backend whose transport could not
              // be CONSTRUCTED (OpenCodeProductionGatedError), so there is no
              // route, no client and no model behind it — and the report is
              // already blocking on `d1_11_production_gated`.
              //
              // 2026-09-02: NOT the case the OpenCode transport's `true`
              // covers. That claim is a TRANSPORT reporting the provider cost
              // it reads off each assistant message; here there is no
              // transport to make the claim, so `false` is the only honest
              // answer and stays one.
              pricingReady: false,
            },
            issues: [
              {
                code: "d1_11_production_gated",
                message: err.message,
                blocking: true,
              },
            ],
          });
        } else {
          throw err;
        }
      }
    }
    return reports;
  }
}

export function createDefaultTransportRegistry(
  options: CreateTransportRegistryOptions = {},
): TransportRegistry {
  return new DefaultTransportRegistry(options);
}

export interface AdmitRoutePlanOptions {
  readonly mode?: "production" | "conformance";
  readonly evidence?: Map<RunnerBackend, D1_11ReadinessEvidence>;
  readonly capabilities?:
    | ProviderCapabilityReport
    | Map<RunnerBackend, ProviderCapabilityReport>;
}

export interface AdmittedRoutePlanResult {
  readonly ok: true;
  readonly plan: ResolvedRoutePlan;
  readonly admittedSteps: readonly ResolvedStepRoute[];
  readonly reports: ReadonlyMap<RunnerBackend, ProviderCapabilityReport>;
}

export async function admitRoutePlan(
  plan: ResolvedRoutePlan,
  registryOrCapabilities:
    | TransportRegistry
    | ProviderCapabilityReport
    | Map<RunnerBackend, ProviderCapabilityReport>,
  optionsOrRegistry?: TransportRegistry | AdmitRoutePlanOptions,
  maybeOptions?: AdmitRoutePlanOptions,
): Promise<AdmittedRoutePlanResult> {
  let registry: TransportRegistry;
  let options: AdmitRoutePlanOptions;

  const isRegistry = (obj: unknown): obj is TransportRegistry => {
    return (
      typeof obj === "object" &&
      obj !== null &&
      !(obj instanceof Map) &&
      !("backend" in obj) &&
      "get" in obj &&
      typeof (obj as TransportRegistry).get === "function"
    );
  };

  if (isRegistry(registryOrCapabilities)) {
    registry = registryOrCapabilities;
    options = (optionsOrRegistry as AdmitRoutePlanOptions) ?? {};
  } else {
    // Signature: admitRoutePlan(plan, capabilities, registry?, options?)
    if (isRegistry(optionsOrRegistry)) {
      registry = optionsOrRegistry;
      options = {
        ...(maybeOptions ?? {}),
        capabilities: registryOrCapabilities,
      };
    } else {
      registry = new DefaultTransportRegistry();
      options = {
        capabilities: registryOrCapabilities,
        ...((optionsOrRegistry as AdmitRoutePlanOptions) ?? {}),
      };
    }
  }

  const reports = new Map<RunnerBackend, ProviderCapabilityReport>();
  const mode = options.mode ?? "production";

  for (const step of plan.steps) {
    const backend = step.route.backend;

    if (!registry.has(backend)) {
      throw new RouteAdmissionError(
        redactDiagnostic(
          `Step "${step.stepKey}" route backend "${backend}" is not registered`,
        ),
      );
    }

    // Check OpenCode D1-11 gate in production mode
    if (backend === "opencode") {
      const evidence = options.evidence?.get("opencode");
      if (mode === "production") {
        const readiness = checkD1_11Readiness(evidence);
        if (!readiness.ready) {
          throw new OpenCodeProductionGatedError(readiness.missing);
        }
      }
    }

    // Get and validate capability report
    let report: ProviderCapabilityReport | undefined;
    if (options.capabilities) {
      if ("backend" in options.capabilities) {
        if (options.capabilities.backend === backend) {
          report = options.capabilities;
        }
      } else if (options.capabilities instanceof Map) {
        report = options.capabilities.get(backend);
      }
    }

    if (!report) {
      report = await registry.getCapabilityReport(backend, {
        mode,
        evidence: options.evidence,
      });
    }

    reports.set(backend, report);

    const gate = capabilityGateDecision(report);
    if (!gate.ok) {
      throw new RouteAdmissionError(
        redactDiagnostic(
          `Step "${step.stepKey}" route backend "${backend}" rejected by capability gate: ${gate.reason}`,
        ),
      );
    }
  }

  return {
    ok: true,
    plan,
    admittedSteps: plan.steps,
    reports,
  };
}

export async function admitDiversityRoutePlan(
  plan: ResolvedRoutePlan,
  registryOrCapabilities: Parameters<typeof admitRoutePlan>[1],
  optionsOrRegistry?: Parameters<typeof admitRoutePlan>[2],
  maybeOptions?: Parameters<typeof admitRoutePlan>[3],
): Promise<AdmittedRoutePlanResult> {
  const { requireInternalFindingsCapability } = await import(
    "./diversity/admission"
  );
  requireInternalFindingsCapability();
  return admitRoutePlan(
    plan,
    registryOrCapabilities,
    optionsOrRegistry,
    maybeOptions,
  );
}

// #149: the launcher the registry hands out when the caller injects none.
// Named and exported because it is the ONLY place production chooses the
// opencode server environment, and every existing test injects `launchServer`
// instead — so an inline closure here was, by construction, untested.
export function defaultOpenCodeLaunchServer(options: {
  readonly verifiedBinaryPath: string;
  readonly broker: CredentialBroker;
  readonly credentialKind: CredentialKind;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly spawnFn?: typeof Bun.spawn;
  readonly killFn?: (pid: number, signal?: string | number) => unknown;
}): (
  mcp?: OpenCodeMcpConfig,
  freeTierGatewayAsk?: readonly string[],
) => Promise<OpenCodeServerHandle> {
  return async (
    mcp?: OpenCodeMcpConfig,
    freeTierGatewayAsk?: readonly string[],
  ) => {
    return await launchProjectedOpenCodeServer({
      ...options,
      // #141: the run’s registry rides the SPAWN. OpenCode reads
      // `OPENCODE_CONFIG_CONTENT` at startup, so a server already running
      // cannot be given one without opening a window between "server up" and
      // "MCP connected".
      ...(mcp === undefined ? {} : { mcp }),
      // Free-tier gateway fix: same reason, same spawn-time constraint — see
      // opencode-client.ts's FREE_TIER_GATEWAY_TOOLS and opencode-server.ts's
      // launchOpenCodeServer for the full WHY.
      ...(freeTierGatewayAsk === undefined ? {} : { freeTierGatewayAsk }),
    });
  };
}

// #149: how the registry turns its options into a launcher. Split out from the
// factory so the WIRING is reachable from a test — the factory itself only
// hands `launchServer` to the client, and every existing test injects one,
// which is how the previous inline closure went untested for its whole life.
export function openCodeLaunchServerFor(
  merged: TransportFactoryOptions,
): (
  mcp?: OpenCodeMcpConfig,
  freeTierGatewayAsk?: readonly string[],
) => Promise<OpenCodeServerHandle> {
  return defaultOpenCodeLaunchServer({
    verifiedBinaryPath:
      merged.openCodeBinaryPath ??
      merged.binaryPath ??
      "/usr/local/bin/opencode",
    // The same broker the credential authority resolved for this backend.
    // Defaulting a second instance here would be a second source of truth
    // beside runner-authority.ts, and a caller injecting a fake at the
    // authority would silently get a real one at the server.
    broker: merged.credentialBroker ?? new OpenCodeAuthBroker(),
    // #133: the kind the authority resolved for that broker. The default
    // below is the OAuth kind because the default BROKER on the line above is
    // the OAuth broker — the pair is only ever defaulted together, here.
    //
    // The one case where they intentionally MISMATCH: a caller that supplies
    // a metered `credentialKind` but no broker gets the OAuth default, which
    // then refuses `provider_api_token` by name. That is deliberate. #149's
    // invariant is that an absent broker stays absent rather than being
    // silently stood in for, so the honest outcome is a loud refusal, not a
    // guess — and never the reverse, an OAuth record projected under a
    // metered route.
    credentialKind: merged.credentialKind ?? "opencode_chatgpt_oauth",
    // pr-hero own environment, filtered to operational keys only. The
    // projection owns HOME/TMPDIR/XDG_* and overrides whatever survives;
    // see composeOpenCodeServerEnv.
    baseEnv: merged.env ?? process.env,
  });
}
