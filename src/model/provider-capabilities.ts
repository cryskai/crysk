import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExactBindingCapabilityReport } from "../execution/contracts";
import {
  defaultExecSnapshotBase,
  executionSnapshotDirName,
  registerExecutionSnapshot,
  releaseExecutionSnapshot,
  sweepExecutionSnapshotsOpportunistically,
} from "./exec-snapshots";

export type RunnerBackend =
  | "claude-code"
  | "opencode"
  | "antigravity"
  | "codex";

export type CredentialKind =
  | "claude_subscription_oauth"
  | "opencode_chatgpt_oauth"
  | "provider_api_token"
  // #182: an OpenCode route whose model the provider itself declares free at
  // runtime (all cost leaves === 0, status active, via `opencode models
  // <provider> --verbose --refresh`). Authenticates with NOTHING — no OAuth
  // record, no API token — so it is refused at credential projection without
  // a kind of its own. Not metered (`credentialKindBillsMetered` is false),
  // so pricing is not_applicable and usage stamps subscription (truthful
  // zero). Additive: every consumer compares with ===/!== or passes through.
  | "provider_free";

export type ExecutableDenialCode = "executable_not_approved";

export interface ExecutableAllowlistEntry {
  readonly absolutePath: string;
  readonly sha256: string;
}

export interface VerifiedExecutable {
  readonly absolutePath: string;
  readonly sha256: string;
  readonly verifiedExecutionPath: string;
  readonly kind?: "binary" | "script-launcher";
  readonly version?: string;
}

export interface ExecutableVerificationApproved {
  readonly approved: true;
  readonly executable: VerifiedExecutable;
  readonly code?: undefined;
  readonly reason?: undefined;
}

export interface ExecutableVerificationDenied {
  readonly approved: false;
  readonly code: ExecutableDenialCode;
  readonly reason: string;
  readonly executable?: undefined;
}

export type ExecutableVerificationResult =
  | ExecutableVerificationApproved
  | ExecutableVerificationDenied;

export interface VerifyExecutableOptions {
  readonly candidatePath: string;
  readonly allowlist?: readonly ExecutableAllowlistEntry[];
  readonly snapshotDir?: string;
}

export interface VerifyExecutableAuthorityDeps {
  readonly realpathFn?: (p: string) => Promise<string>;
  readonly readFileFn?: (p: string) => Promise<Uint8Array>;
  readonly statFn?: (p: string) => { mode: number };
}

interface AllowlistedBytes {
  readonly approved: true;
  readonly canonicalPath: string;
  readonly digest: string;
  readonly content: Buffer;
}

// Steps 1-6: the allowlist and hash verdict, shared by the snapshotting
// authority below and the verify-only binding check. Writes nothing.
async function verifyAllowlistedBytes(
  options: Omit<VerifyExecutableOptions, "snapshotDir">,
  deps: VerifyExecutableAuthorityDeps,
): Promise<AllowlistedBytes | ExecutableVerificationDenied> {
  const { candidatePath, allowlist = [] } = options;
  const toRealpath = deps.realpathFn ?? realpath;
  const readBytes =
    deps.readFileFn ?? ((p: string) => readFile(p) as Promise<Uint8Array>);
  const statFile = deps.statFn ?? ((p: string) => statSync(p));

  // 1. Validate allowlist integrity: reject relative paths in allowlist entries
  for (const entry of allowlist) {
    if (!path.isAbsolute(entry.absolutePath)) {
      return {
        approved: false,
        code: "executable_not_approved",
        reason: `Allowlist entry contains relative path: ${entry.absolutePath}`,
      };
    }
  }

  // 2. Candidate path must be absolute
  if (!path.isAbsolute(candidatePath)) {
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Relative executable path not allowed: ${candidatePath}`,
    };
  }

  // 3. Resolve canonical path
  let canonicalPath: string;
  try {
    canonicalPath = await toRealpath(candidatePath);
  } catch (error) {
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Executable not found or realpath failed: ${(error as Error).message}`,
    };
  }

  // 4. Check executable mode bit
  try {
    const stats = statFile(canonicalPath);
    const isExecutable = (stats.mode & 0o111) !== 0;
    if (!isExecutable) {
      return {
        approved: false,
        code: "executable_not_approved",
        reason: `Missing executable permissions on: ${canonicalPath}`,
      };
    }
  } catch (error) {
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Failed to inspect permissions: ${(error as Error).message}`,
    };
  }

  // 5. Read bytes and compute SHA-256
  let content: Buffer;
  let digest: string;
  try {
    const raw = await readBytes(canonicalPath);
    content = Buffer.from(raw);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    digest = hasher.digest("hex");
  } catch (error) {
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Failed to read and hash binary: ${(error as Error).message}`,
    };
  }

  // 6. Match against allowlist
  const matchingEntry = allowlist.find(
    (entry) =>
      path.resolve(entry.absolutePath) === canonicalPath &&
      entry.sha256.toLowerCase() === digest.toLowerCase(),
  );

  if (!matchingEntry) {
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Binary ${canonicalPath} (sha256:${digest}) is not in configured allowlist`,
    };
  }

  return { approved: true, canonicalPath, digest, content };
}

export interface ExecutableBindingApproved {
  readonly approved: true;
  readonly absolutePath: string;
  readonly sha256: string;
  readonly code?: undefined;
  readonly reason?: undefined;
}

export type ExecutableBindingVerificationResult =
  | ExecutableBindingApproved
  | ExecutableVerificationDenied;

// #303: binding resolution (runner-authority.ts) needs the allowlist and hash
// verdict, never a runnable copy — it used to call verifyExecutableAuthority
// and discard the snapshot that call had just written, one per route. The
// approved shape deliberately carries no `verifiedExecutionPath`: nothing can
// spawn from a verify-only result, so execution still has to go through
// verifyExecutableAuthority and its TOCTOU snapshot.
export async function verifyExecutableBinding(
  options: Omit<VerifyExecutableOptions, "snapshotDir">,
  deps: VerifyExecutableAuthorityDeps = {},
): Promise<ExecutableBindingVerificationResult> {
  const verified = await verifyAllowlistedBytes(options, deps);
  if (!verified.approved) return verified;
  return {
    approved: true,
    absolutePath: verified.canonicalPath,
    sha256: verified.digest,
  };
}

export async function verifyExecutableAuthority(
  options: VerifyExecutableOptions,
  deps: VerifyExecutableAuthorityDeps = {},
): Promise<ExecutableVerificationResult> {
  const verified = await verifyAllowlistedBytes(options, deps);
  if (!verified.approved) return verified;
  const { canonicalPath, digest, content } = verified;

  // WHY scripts are not snapshotted: a shebang launcher's interpreter resolves
  // relative imports against the script's own location, so a snapshot copy
  // breaks sibling imports. The launcher executes from its canonical path; the
  // residual TOCTOU window on scripts is accepted until credential projection
  // lands.
  if (content.subarray(0, 2).toString("latin1") === "#!") {
    return {
      approved: true,
      executable: {
        absolutePath: canonicalPath,
        sha256: digest,
        verifiedExecutionPath: canonicalPath,
        kind: "script-launcher",
      },
    };
  }

  // 7. TOCTOU Defense: Create private verified execution snapshot bound to verified bytes
  const snapBase = options.snapshotDir ?? defaultExecSnapshotBase();
  // #303: collect what crashed processes left behind before adding to it.
  // Rate-limited, time-bounded (OPPORTUNISTIC_SWEEP_BUDGET_MS) and
  // best-effort inside, so this step pays at most the budget even on a large
  // backlog; awaited so a test's cleanup never races a sweep still running in
  // the background.
  await sweepExecutionSnapshotsOpportunistically(snapBase);
  // The pid lets a later sweep tell a dead owner's directory from a live one;
  // the per-call uuid stays — it is what defeats a pre-planted path.
  const snapDir = path.join(
    snapBase,
    executionSnapshotDirName(digest, process.pid, randomUUID()),
  );
  try {
    mkdirSync(snapDir, { recursive: true, mode: 0o700 });
    // Registered before the bytes land, so an exit mid-write still removes
    // the partial copy. Every removal below goes through the registry too.
    registerExecutionSnapshot(snapDir);
    chmodSync(snapDir, 0o700);
    const snapBinaryName = path.basename(canonicalPath);
    const snapBinaryPath = path.join(snapDir, snapBinaryName);
    // Exclusive, no-follow create: a symlink planted at this exact path must
    // make the write fail closed rather than redirect the verified bytes.
    const fd = openSync(
      snapBinaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o700,
    );
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    chmodSync(snapBinaryPath, 0o700);

    const snapshotBytes = readFileSync(snapBinaryPath);
    const verifyHasher = new Bun.CryptoHasher("sha256");
    verifyHasher.update(snapshotBytes);
    if (verifyHasher.digest("hex") !== digest.toLowerCase()) {
      releaseExecutionSnapshot(snapDir);
      return {
        approved: false,
        code: "executable_not_approved",
        reason: "snapshot verification failed",
      };
    }

    return {
      approved: true,
      executable: {
        absolutePath: canonicalPath,
        sha256: digest,
        verifiedExecutionPath: snapBinaryPath,
        kind: "binary",
      },
    };
  } catch (error) {
    // Unregistered only when mkdirSync itself failed, and then there is no
    // directory to remove.
    releaseExecutionSnapshot(snapDir);
    return {
      approved: false,
      code: "executable_not_approved",
      reason: `Failed to create verified execution snapshot: ${(error as Error).message}`,
    };
  }
}

export interface ProviderCapabilityReport {
  readonly backend: RunnerBackend;
  readonly status: "ready" | "degraded" | "blocking";
  readonly binary?: { absolutePath: string; sha256: string; version: string };
  readonly auth: {
    kind: CredentialKind;
    projectionReady: boolean;
    probe: "passed" | "failed" | "not_run";
  };
  readonly isolation: {
    syntheticHome: boolean;
    workspaceReadBroker: boolean;
    codegraphPolicy: boolean;
  };
  readonly protocol: {
    terminalProof: boolean;
    boundedEvents: boolean;
    usageMode: "snapshot" | "delta" | "none";
  };
  readonly cancellation: {
    deadlineMs: number;
    conformance: "passed" | "failed" | "not_run";
  };
  readonly billing: {
    mode: "subscription" | "metered" | "unknown";
    pricingReady: boolean;
  };
  readonly rateLimitBucketId?: string;
  readonly issues: readonly {
    code: string;
    message: string;
    blocking: boolean;
  }[];
}

// §13 ("Preflight and execution use the same verified absolute binary"):
// extracted from resolveRunnerAuthority so the capability-report producer and
// the execution authority share ONE resolution rule instead of two copies
// that can drift. Same lookup order, same error strings.
export interface ClaudeBinaryLookup {
  readonly binaryPath?: string;
  readonly env?: { PATH?: string };
}

export interface ClaudeBinaryResolutionDeps {
  readonly existsFn?: (p: string) => boolean;
  readonly realpathFn?: (p: string) => Promise<string>;
  readonly readFileFn?: (p: string) => Promise<Uint8Array>;
  readonly statFn?: (p: string) => { mode: number };
}

export type ClaudeCanonicalBinary =
  | {
      readonly canonicalPath: string;
      readonly sha256: string;
      readonly error?: undefined;
    }
  | { readonly canonicalPath?: undefined; readonly error: string };

const CLAUDE_BINARY_NAME = "claude";

export async function resolveClaudeCanonicalBinary(
  lookup: ClaudeBinaryLookup,
  deps: ClaudeBinaryResolutionDeps = {},
): Promise<ClaudeCanonicalBinary> {
  const exists = deps.existsFn ?? existsSync;
  const toRealpath = deps.realpathFn ?? realpath;
  const readBytes =
    deps.readFileFn ?? ((p: string) => readFile(p) as Promise<Uint8Array>);

  let candidate: string;
  if (lookup.binaryPath !== undefined) {
    if (!path.isAbsolute(lookup.binaryPath)) {
      return {
        error: `binary override must be an absolute path: ${lookup.binaryPath}`,
      };
    }
    candidate = lookup.binaryPath;
  } else {
    const searchDirs = (lookup.env?.PATH ?? process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((dir) => dir.length > 0);
    candidate = "";
    for (const dir of searchDirs) {
      const probe = path.join(dir, CLAUDE_BINARY_NAME);
      if (exists(probe)) {
        candidate = probe;
        break;
      }
    }
    if (candidate === "") {
      return { error: "claude binary not found on PATH" };
    }
  }

  try {
    const canonical = await toRealpath(candidate);
    const bytes = await readBytes(canonical);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const sha256 = hasher.digest("hex");
    return { canonicalPath: canonical, sha256 };
  } catch (error) {
    return {
      error: `failed to resolve claude binary ${candidate}: ${(error as Error).message}`,
    };
  }
}

// §11/D1-09: fields every claude-code route claims independent of host
// environment. The transport's capabilities() and the report producer both
// read these constants, so the two surfaces cannot contradict each other.
export const CLAUDE_CAPABILITY_STATICS = {
  authKind: "claude_subscription_oauth",
  workspaceReadBroker: true,
  terminalProof: true,
  usageMode: "snapshot",
  cancellationDeadlineMs: 7500,
  cancellationConformance: "passed",
  billingMode: "subscription",
} as const;

// Same predicate runner-authority applies when deciding whether to wire the
// KeychainCredentialBroker (§6.1): macOS subscription OAuth projects out of
// the Keychain via /usr/bin/security; elsewhere there is nothing to project.
export function claudeCredentialProjectionReady(
  options: {
    platform?: NodeJS.Platform;
    existsFn?: (p: string) => boolean;
  } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const exists = options.existsFn ?? existsSync;
  return platform === "darwin" && exists("/usr/bin/security");
}

// Mirrors system-tools' claude auth predicate (env token or on-disk session),
// extended with the two routes that predicate misses and §6.1's own table
// names: the macOS Keychain item (the subscription path this project targets
// — pr-hero found its own gate refusing exactly that machine class) and the
// Linux-style ~/.claude/.credentials.json. The default probe never spawns
// claude; the keychain query is metadata-only (no -w), proven non-interactive.
function defaultKeychainCredentialPresent(): boolean {
  return (
    Bun.spawnSync([
      "/usr/bin/security",
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
    ]).exitCode === 0
  );
}

// The on-disk Claude sessions the default probe accepts, relative to HOME.
// Exported because src/ci/trigger.ts must reach the same verdict before
// `bun install` and so keeps its own copy (it may import only builtins); a
// drift test in test/ci/trigger.test.ts pins that copy to this list.
export const CLAUDE_SESSION_FILES: readonly string[] = [
  ".claude.json",
  path.join(".claude", "session.json"),
  path.join(".claude", ".credentials.json"),
];

function defaultClaudeAuthProbe(
  env: Record<string, string | undefined>,
  home: string,
  exists: (p: string) => boolean,
  platform: NodeJS.Platform,
  keychainProbe: () => boolean,
): "passed" | "failed" {
  const hasToken =
    Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) ||
    Boolean(env.ANTHROPIC_API_KEY?.trim());
  if (hasToken) return "passed";
  const hasSessionFile = CLAUDE_SESSION_FILES.some((file) =>
    exists(path.join(home, file)),
  );
  if (hasSessionFile) return "passed";
  if (platform === "darwin" && exists("/usr/bin/security")) {
    return keychainProbe() ? "passed" : "failed";
  }
  return "failed";
}

export interface ProduceClaudeCapabilityReportOptions {
  readonly binaryPath?: string;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly existsFn?: (p: string) => boolean;
  readonly realpathFn?: (p: string) => Promise<string>;
  readonly readFileFn?: (p: string) => Promise<Uint8Array>;
  readonly version?: string;
  // Injectable so offline tests never spawn claude (§11).
  readonly authProbe?: () => "passed" | "failed";
  // Injectable keychain presence check backing the default auth probe's
  // macOS subscription route; offline tests stub it.
  readonly keychainProbe?: () => boolean;
}

// §11/D1-09: the REAL claude-code report. Every gap becomes an issue entry;
// missing binary or failed auth are blocking, everything unproven is claimed
// false and non-blocking rather than assumed green.
export async function produceClaudeCapabilityReport(
  options: ProduceClaudeCapabilityReportOptions = {},
): Promise<ProviderCapabilityReport> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const existsFn = options.existsFn ?? existsSync;

  const issues: { code: string; message: string; blocking: boolean }[] = [];

  const resolved = await resolveClaudeCanonicalBinary(
    { binaryPath: options.binaryPath, env },
    {
      existsFn,
      realpathFn: options.realpathFn,
      readFileFn: options.readFileFn,
    },
  );

  const projectionReady = claudeCredentialProjectionReady({
    platform: options.platform,
    existsFn,
  });

  const probeResult =
    options.authProbe !== undefined
      ? options.authProbe()
      : defaultClaudeAuthProbe(
          env,
          home,
          existsFn,
          options.platform ?? process.platform,
          options.keychainProbe ?? defaultKeychainCredentialPresent,
        );
  if (probeResult === "failed") {
    issues.push({
      code: "auth_failed",
      message:
        "claude authentication not detected (no OAuth token env var, no session credentials, no keychain entry)",
      blocking: true,
    });
  }

  if (!projectionReady) {
    issues.push({
      code: "credential_projection_unavailable",
      message:
        "credential projection broker unavailable (needs darwin + /usr/bin/security); child runs with enumerated-passthrough env instead of a synthetic home",
      blocking: false,
    });
  }

  // Honest until enforced: no codegraph-specific read policy exists in
  // src/security/ today, so the report must not claim one (§11).
  issues.push({
    code: "codegraph_policy_unenforced",
    message:
      "no dedicated codegraph sensitive-file policy is enforced yet; isolation relies on --strict-mcp-config with a codegraph-only mcp.json",
    blocking: false,
  });

  // The AsyncEventSink contract exists but the pipeline still consumes usage
  // from the CLI's json snapshot, not bounded events (§12 D1-08 residual).
  issues.push({
    code: "bounded_events_sink_missing",
    message:
      "bounded event streaming is not wired: the event sink is currently a no-op and usage arrives as a final snapshot",
    blocking: false,
  });

  if (resolved.error !== undefined) {
    issues.unshift({
      code: "binary_unresolved",
      message: resolved.error,
      blocking: true,
    });
  }

  const hasBlocking = issues.some((issue) => issue.blocking);

  return {
    backend: "claude-code",
    status: hasBlocking ? "blocking" : "degraded",
    ...(resolved.error === undefined
      ? {
          binary: {
            absolutePath: resolved.canonicalPath,
            sha256: resolved.sha256,
            version: options.version ?? "unknown",
          },
        }
      : {}),
    auth: {
      kind: CLAUDE_CAPABILITY_STATICS.authKind,
      projectionReady,
      probe: probeResult,
    },
    isolation: {
      syntheticHome: projectionReady,
      workspaceReadBroker: CLAUDE_CAPABILITY_STATICS.workspaceReadBroker,
      codegraphPolicy: false,
    },
    protocol: {
      terminalProof: CLAUDE_CAPABILITY_STATICS.terminalProof,
      boundedEvents: false,
      usageMode: CLAUDE_CAPABILITY_STATICS.usageMode,
    },
    cancellation: {
      deadlineMs: CLAUDE_CAPABILITY_STATICS.cancellationDeadlineMs,
      conformance: CLAUDE_CAPABILITY_STATICS.cancellationConformance,
    },
    billing: {
      mode: CLAUDE_CAPABILITY_STATICS.billingMode,
      // #197. The old `false` reasoned about a model id: this is a
      // BACKEND-wide report produced before any route resolves, and
      // `tokenPricingAvailableFor` needed a provider AND a model to answer.
      // That function and the tables behind it are deleted, and the flag it
      // fed never meant what the comment assumed — `pricingReady` asserts
      // "will this transport tell you what the attempt cost?", which is a
      // backend-wide fact needing no model. The claude-code CLI reports
      // `total_cost_usd`, so the honest answer here is `true`.
      //
      // Kept IDENTICAL to ClaudeCodeCliTransport.capabilities() on purpose:
      // "the transport contradicts the producer in no environment"
      // (test/model/provider-capabilities.test.ts) is a structural guard, and a
      // producer disagreeing with the transport that actually runs the route
      // is the drift it exists to catch.
      pricingReady: true,
    },
    issues,
  };
}

// §11: "Any blocking issue prevents the route from executing." Pure decision
// so cli.ts's review paths gate on it without their own issue-parsing logic.
export interface CapabilityGateDecision {
  readonly ok: boolean;
  readonly reason?: string;
}

export function capabilityGateDecision(
  report: ProviderCapabilityReport,
): CapabilityGateDecision {
  const blocking = report.issues.filter((issue) => issue.blocking);
  if (blocking.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: blocking
      .map((issue) => `${issue.code}: ${issue.message}`)
      .join("; "),
  };
}

function gateDecisionFromIssues(
  issues: readonly { code: string; message: string; blocking: boolean }[],
): CapabilityGateDecision {
  const blocking = issues.filter((issue) => issue.blocking);
  if (blocking.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: blocking
      .map((issue) => `${issue.code}: ${issue.message}`)
      .join("; "),
  };
}

// Exact-binding gate (§11 production runtime): subscription routes may pass
// without token pricing when pricingApplicability is not_applicable; metered
// routes require tokenPricingAvailable before spend.
export function exactBindingCapabilityIssues(
  report: ExactBindingCapabilityReport,
): readonly { code: string; message: string; blocking: boolean }[] {
  const issues: { code: string; message: string; blocking: boolean }[] = [];
  const label = `${report.backend} (${report.routeKey})`;

  if (!report.binary.resolved) {
    issues.push({
      code: "binary_unresolved",
      message:
        report.binary.reason ?? `executable not resolved for binding ${label}`,
      blocking: true,
    });
  }
  if (report.auth.probe === "failed") {
    issues.push({
      code: "auth_failed",
      message: `authentication not detected for binding ${label}`,
      blocking: true,
    });
  }
  if (!report.sdk.available) {
    issues.push({
      code: "sdk_unavailable",
      message: `SDK adapter unavailable for binding ${label}`,
      blocking: true,
    });
  }
  if (
    report.billing.pricingApplicability === "required" &&
    !report.billing.tokenPricingAvailable
  ) {
    issues.push({
      code: "pricing_table_missing",
      message: `token pricing required but unavailable for binding ${label}`,
      blocking: true,
    });
  }
  // WHY: this is the enforcement point for the design's "billingMode:
  // 'unknown' is a blocking preflight result"
  // (docs/multi-runtime-model-diversity-design.md:461). The legacy
  // ProviderCapabilityReport has three billing modes and the exact contract
  // has two, so FrozenRuntimeBinding.capabilities() narrows `unknown` into
  // "subscription"; that leaves pricingApplicability at "not_applicable", so
  // the pricing_table_missing gate above structurally CANNOT catch an
  // unknown-billing route. The producer therefore derives
  // cashCostAccountingValid from the THREE-STATE effective mode (#133's
  // `effectiveBillingMode`, which is the transport's own mode for every kind
  // except `provider_api_token`) and reports false for `unknown`, and this
  // branch is what turns that fact into a refusal. It is reachable through
  // the real producer (see test/production-runtime.test.ts "an unknown legacy
  // billing mode blocks the exact-binding gate through the real producer"),
  // and it also holds the pricingApplicability/cashCostAccountingValid field
  // independence (src/execution/contracts.ts:235-237) for any future
  // producer.
  //
  // #133 does not weaken this: the effective mode only ever replaces
  // `unknown` with `metered`, and a metered route without pricing is caught
  // by pricing_table_missing above instead. Nothing reaches "subscription"
  // that did not already, so `unknown` still ends in a blocking refusal on
  // one branch or the other.
  if (
    report.billing.pricingApplicability !== "required" &&
    !report.billing.cashCostAccountingValid
  ) {
    issues.push({
      code: "cash_cost_accounting_invalid",
      message: `cash-cost accounting is not valid for binding ${label}`,
      blocking: true,
    });
  }
  if (!report.isolation.codegraphPolicy) {
    issues.push({
      code: "codegraph_policy_unenforced",
      message:
        "no dedicated codegraph sensitive-file policy is enforced yet; isolation relies on --strict-mcp-config with a codegraph-only mcp.json",
      blocking: false,
    });
  }
  if (!report.protocol.boundedEvents) {
    issues.push({
      code: "bounded_events_sink_missing",
      message:
        "bounded event streaming is not wired: usage arrives as a final snapshot",
      blocking: false,
    });
  }
  if (
    report.auth.projectionReady === false &&
    report.environment.enumeratedPassthrough
  ) {
    issues.push({
      code: "credential_projection_unavailable",
      message:
        "credential projection broker unavailable; child runs with enumerated-passthrough env instead of a synthetic home",
      blocking: false,
    });
  }
  return issues;
}

export function exactBindingCapabilityGate(
  report: ExactBindingCapabilityReport,
): CapabilityGateDecision {
  return gateDecisionFromIssues(exactBindingCapabilityIssues(report));
}

export function exactBindingCapabilityStatus(
  issues: readonly { code: string; message: string; blocking: boolean }[],
): ProviderCapabilityReport["status"] {
  if (issues.some((issue) => issue.blocking)) {
    return "blocking";
  }
  if (issues.length > 0) {
    return "degraded";
  }
  return "ready";
}
