// Step-level headless engine spawn — the v2 descendant of deep-review's
// runner/session.ts. v1 spawned ONE Claude Code session and let an
// orchestrator prompt fan out hunters via the Task tool; v2 spawns one
// session PER STEP (hunter/refuter) and the driver owns the orchestration.
// Every isolation flag and retry mechanism here encodes a paid-for failure
// from v1 — port, don't rewrite.

import type { Effort } from "#model/catalog";
import type { CredentialKind } from "#model/provider-capabilities";
import type { AttemptAdmissionGate } from "../execution/admission";
import type {
  AuthEvent,
  DenialCode,
  ExecutableAllowlistEntry,
  ResolvedModelRoute,
  StepAdmissionGate,
  TransportFailureCause,
} from "../execution/contracts";
import type { FailureClass } from "../execution/failure-classification";
import { StepExecutionHarness } from "../execution/harness";
import type { SpendReservation } from "../execution/spend-limiter";
import type { NormalizedUsage } from "../execution/usage-normalized";
import type { CredentialBroker } from "../security/credential-broker";
import type { SessionUsage } from "../usage";

export interface StepSpec {
  // "hunter-reliability" | "hunter-resilience" | "hunter-parity" | "refuter"
  name: string;
  // Driver-templated file in the run dir (audit artifact).
  systemPromptPath: string;
  // User message: diff, hop budget, batch path, output contract.
  prompt: string;
  // From agent frontmatter.
  tools: string[];
  // Codegraph-only mcp.json.
  mcpConfigPath: string;
  model: string;
  // How hard the model works (`claude --effort`). Always resolved by the engine
  // (frontmatter, else the per-role default) and never left to the CLI's
  // implicit default, which is `medium` on the 5.5 family (#299).
  effort: Effort;
  cwd: string;
  outPath: string;
  // Per-step watchdog; the default (30 min) lives with the caller.
  timeoutMs: number;
  // Transient-only bound (default 2); the format-retry is additional.
  maxAttempts: number;
  // throw = not delivered (v1's draftDelivered role, applied per step).
  parse(finalText: string): unknown;
  // OBSERVATION ONLY. Called just before a retry is spawned, so a retrying
  // step stops looking merely slow — `attempts` was already counted, but only
  // after the fact in PerAgentUsage, which is a post-mortem, not a signal.
  // Nothing here may change retry behavior: no return value is read, and a
  // throwing callback is swallowed (the same rule review/pipeline.ts's emit() keeps
  // — a cosmetic listener must never kill a paid run).
  onRetry?(info: RetryInfo): void;
  // Stage-2 fields — typed now so specs stay forward-compatible, UNUSED in
  // Stage 1: `backend` selects the runner, `models` fans one spec out to
  // `<step>__<model-slug>` legs sharing a groupId.
  backend?: "claude-code" | "opencode";
  models?: string[];
  route?: ResolvedModelRoute;
  // Frozen route fingerprint from the admitted plan. Required for routed
  // production execution via createProductionRuntime.
  routeKey?: string;
  // Provider credential projection stamped by MultiProviderRunner from the
  // admitted binding. Defaults preserve Claude-only behavior.
  credentialKind?: CredentialKind;
  credentialRef?: string;
  // Optional sha256 pin for mcp.json integrity checks at binding admission.
  mcpConfigSha256?: string;
}

export interface RetryInfo {
  // Step name, e.g. "hunter-reliability" or "refuter-F001".
  step: string;
  // The attempt about to START (1-based).
  attempt: number;
  // The transient budget. Meaningless for `reason: "format"` — that retry has
  // its own cap of exactly one, so a renderer must not print "N of M" there.
  maxAttempts: number;
  reason: RetryFailureClass;
}

export interface StepResult {
  name: string;
  status: "ok" | "failed";
  denialCode?: DenialCode;
  output?: unknown;
  // Legacy flat shape (§8's ONLY consumer boundary: `../deep-review/runner/
  // telemetry.ts` reads `runPipeline()`'s returned `usage` by these field
  // names). Projected from `usageV2` via `projectLegacyUsage`, never hand-built.
  usage: SessionUsage;
  // D1-08 PR2: the normalized disjoint leaves this step's attempts actually
  // reported, summed across attempts. Absent when no attempt ever spawned
  // (a pre-spawn denial, a construction failure) — those cases are genuine
  // zero cost, not "unavailable", and carry no v2 record at all.
  usageV2?: NormalizedUsage;
  // D1-08 PR5b (§9.1): one entry per attempt that reached `runAttempt`'s
  // reserve step, each carrying its own `reservationId` and TERMINAL state
  // — spec: "every attempt MUST carry a reservationId and terminal state in
  // pipeline.json". Absent when no `SpendLedger` was configured on the
  // harness (the ledger-free PR5a shape) or no attempt ever reserved.
  reservations?: SpendReservation[];
  attempts: number;
  // The transport cause of the step's final failed attempt, when the harness
  // resolved one (a transport cause, never a harness cause). Absent on success,
  // and on a failure with no transport cause. The CLI record names it per hunter.
  failureCause?: TransportFailureCause;
  // The final failed attempt's one-line explanation (TransportOutcome.failureDetail),
  // when the transport gave one. Absent on success.
  failureDetail?: string;
  stderrTail: string;
  resultText: string;
}

export interface StepRunner {
  run(step: StepSpec): Promise<StepResult>;
}

// Step-artifact paths (attemptLogPath, settlementReceiptPath,
// attemptEvidencePath), FORMAT_RETRY_REMINDER, and the legacy v1
// classifyFailure/isTransientSessionFailure/isTerminalSessionFailure
// classification vocabulary moved to execution/step-artifacts.ts and
// execution/failure-classification.ts (architecture guard C2): this module
// depends on execution/harness.ts for StepExecutionHarness, so
// execution/harness.ts and execution/attempt-evidence.ts and
// execution/failure-policy.ts importing those helpers FROM here closed a
// value-import cycle back through harness.ts.

export const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_STEP_MAX_ATTEMPTS = 2;

export type RetryFailureClass = Exclude<FailureClass, "terminal">;

// The Claude CLI argv a step spawns with, mirroring the flag order of
// ClaudeCodeCliTransport.execute so the isolation flags can be asserted
// without a transport. It takes no prompt (#314): the prompt goes to
// the child on stdin, because one argv string over Linux's MAX_ARG_STRLEN
// (131072 bytes) fails execve with E2BIG and the prompt embeds the whole
// patch. `-p` with no positional is what makes the CLI read stdin.
export function buildStepArgv(step: StepSpec): string[] {
  return [
    "claude",
    "-p",
    "--append-system-prompt-file",
    step.systemPromptPath,
    "--output-format",
    "json",
    "--mcp-config",
    step.mcpConfigPath,
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--tools",
    step.tools.join(","),
    "--permission-mode",
    "bypassPermissions",
    "--model",
    step.model,
    "--effort",
    step.effort,
    "--exclude-dynamic-system-prompt-sections",
  ];
}

// SpawnedProcess, ACTIVE_CHILD_PROCS, and killAllChildProcesses moved to
// execution/spawned-process.ts (architecture guard C2): the spawner
// (transports/claude-code-cli.ts) is reached from execution/harness.ts via
// transport-registry.ts, and this module depends on execution/harness.ts
// for StepExecutionHarness — so the spawner importing this registry FROM
// here closed a value-import cycle back through harness.ts.

export interface ClaudeCodeRunnerOptions {
  spawnFn?: typeof Bun.spawn;
  workspaceRoot?: string;
  executableAllowlist?: readonly ExecutableAllowlistEntry[];
  binaryPath?: string;
  admissionGate?: StepAdmissionGate;
  // The max_concurrent_steps cap (run.ts admissionGateFor). The legacy
  // runner is what a review without routing runs on, so the cap must reach
  // it too or the key silently does nothing on the default Claude path.
  attemptAdmissionGate?: AttemptAdmissionGate;
  onAuthEvent?: (event: AuthEvent) => void;
  // §6.1 D1-05 credential projection; forwarded to the harness.
  credentialBroker?: CredentialBroker;
  // #177, 2026-09-02: source for the child-env projection, forwarded to the
  // harness (which has documented it as "injectable so tests never touch the
  // real process environment" since D1-05 — this entry point just never
  // passed it, so through THIS runner the injection point was unreachable and
  // `process.env` was the only source).
  //
  // It stopped being cosmetic when the Claude CLI transport began reading
  // that projected env to decide whether an attempt bills metered: two tests
  // here assert the subscription cost shape, and without this they assert it
  // against whatever credentials the developer's own shell carries. Verified,
  // not assumed — `ANTHROPIC_API_KEY=sk-probe bun test` reddened exactly those
  // two before this landed. That is #174's defect, and it cost this repo two
  // wrong diagnoses in one day.
  childEnv?: Readonly<Record<string, string | undefined>>;
  // §5.3 D1-10b: the pipeline ceiling's cancellation signal. This is the ONLY
  // entry point to the harness's §5.3 sequence (no new attempts, lease fence,
  // abort, bounded grace) — the whole sequence shipped implemented and
  // unreachable because this option was missing here, so nothing in src/ ever
  // handed the harness a signal.
  signal?: AbortSignal;
}

export class ClaudeCodeRunner implements StepRunner {
  private readonly harness: StepExecutionHarness;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.harness = new StepExecutionHarness({
      workspaceRoot: options.workspaceRoot,
      executableAllowlist: options.executableAllowlist,
      binaryPath: options.binaryPath,
      admissionGate: options.admissionGate,
      attemptAdmissionGate: options.attemptAdmissionGate,
      onAuthEvent: options.onAuthEvent,
      credentialBroker: options.credentialBroker,
      childEnv: options.childEnv,
      spawnFn: options.spawnFn,
      signal: options.signal,
    });
  }

  async run(step: StepSpec): Promise<StepResult> {
    return this.harness.run(step);
  }
}
