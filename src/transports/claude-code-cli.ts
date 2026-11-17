import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isEffort } from "#model/catalog";
import { CLAUDE_CAPABILITY_STATICS } from "#model/provider-capabilities";
import { claudeCliModel } from "#model/routing";
import type { BucketScope } from "../execution/bucket-id";
import { deriveBucketId } from "../execution/bucket-id";
import {
  newClaudeSessionId,
  retainClaudeSession,
} from "../execution/claude-session-trace";
import type {
  FailureCredential,
  ObservedModel,
  ProviderCapabilityReport,
  ProviderTerminalProof,
  ProviderTransport,
  ResolvedModelRoute,
  TransportFailureCause,
  TransportOutcome,
  TransportRequest,
} from "../execution/contracts";
import {
  ACTIVE_CHILD_PROCS,
  type SpawnedProcess,
} from "../execution/spawned-process";
import {
  claudeUsageCounts,
  type ModelUsageCounts,
} from "../execution/usage-facts";
import type { NormalizedUsage } from "../execution/usage-normalized";
import {
  envBillsMetered,
  METERED_CREDENTIAL_ENV,
  normalizePartialUsage,
  normalizeUnavailableUsage,
} from "../execution/usage-normalized";

// §9.2 non-secret provider label this transport's route always resolves to
// (the only route it drives is Anthropic-via-Claude-CLI). A per-request
// `route.provider` exists on TransportRequest but capabilities() is called
// before any specific request, so the identity string is this transport's
// own fixed provider — never inferred from a request that may not exist yet.
const BUCKET_IDENTITY_PROVIDER = "anthropic";

// D1-08 PR3 (§9.2): input a caller MAY supply once it has resolved a
// credential's projection and its bucketScope — none does yet (that wiring
// is PR5a's job). Omitting this argument keeps capabilities() byte-identical
// to pre-PR3 behavior: rateLimitBucketId stays undefined.
export interface ClaudeCliCapabilitiesInput {
  readonly credentialFingerprint: string;
  readonly bucketScope?: BucketScope;
  readonly localKey: Uint8Array;
}

// §5.2 CLI/POSIX cascade: SIGTERM -> 5,000 ms grace -> SIGKILL -> reap bound
// 2,000 ms, all inside the harness's 7,500 ms deadline including scheduler
// margin. The numbers are contract, not taste — do not tune them here.
const TERM_GRACE_MS = 5000;
const KILL_REAP_MS = 2000;

export interface PromptFileStatus {
  readonly mode: number;
  readonly isSymbolicLink: boolean;
}

function systemPromptStatus(promptPath: string): PromptFileStatus | undefined {
  try {
    const stats = lstatSync(promptPath);
    return { mode: stats.mode, isSymbolicLink: stats.isSymbolicLink() };
  } catch {
    return undefined;
  }
}

function hashPromptFile(promptPath: string): string {
  return createHash("sha256").update(readFileSync(promptPath)).digest("hex");
}

// #177, 2026-09-02. WHICH credential class this attempt's usage is filed
// under, decided from the env the CHILD is spawned with — the one fact that
// separates a subscription run (quota) from an API-key run (a per-token
// credential).
//
// #173 applied the subscription rule STATICALLY here and was right about its
// reasoning and wrong about its premise. Its premise was
// `credentialKindForRoute` (runner-authority.ts), which returns
// `claude_subscription_oauth` for this backend UNCONDITIONALLY without ever
// reading the environment — so it cannot distinguish the two, and taking it as
// proof made every API-key user's usage file as subscription. Under-reporting,
// shipped by the change that set out to stop it.
//
// The fix is deliberately NARROW: it does not derive `credentialKindForRoute`,
// and it does not touch route admission. See the guard on `envBillsMetered`:
// which credential a route runs on is `credentialKindForRoute`'s single
// decision (#161), and deriving it from the env HERE would fork it. This only
// decides how an attempt that already ran gets FILED.
//
// Returned from ONE function so `noSpawnUsage` and the two parse arms cannot
// drift: `sumNormalizedUsage` collapses `billingMode` to "unknown" the moment
// two attempts of one step disagree, and this transport retries.
function claudeCliBillingMode(
  env: Readonly<Record<string, string | undefined>>,
): NormalizedUsage["billingMode"] {
  return envBillsMetered(env) ? "metered" : "subscription";
}

// A denial before spawn, or a PGID proof failure that refuses to signal a
// child we never trust, used nothing — no attempt reached the provider. This
// is deliberately NOT `normalizeUnavailableUsage`: "unavailable" means an
// attempt ran and its usage is unknown, which would misfile a refusal as an
// unresolved spend once the spend ledger reads completeness.
//
// It has to carry the same billing mode as the parse arms below, for a
// mechanical reason: an unclassified failure legacy-classifies as "format"
// (step-runner.ts `classifyFailure`), which has a retry, so a denied attempt 1
// can be summed with a spawned attempt 2 — and `sumNormalizedUsage` collapses
// `billingMode` to "unknown" whenever two attempts disagree.
function noSpawnUsage(
  wallMs: number,
  env: Readonly<Record<string, string | undefined>>,
): NormalizedUsage {
  return {
    wallMs,
    tokens: {},
    completeness: "complete",
    billingMode: claudeCliBillingMode(env),
  };
}

interface RawClaudeCliResult {
  // #299. Read through `toolInvocationsFromCliResult`, never directly: the
  // type is `unknown` because the only trustworthy shape is an integer >= 1.
  readonly num_turns?: unknown;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
  // #175 half 2. The CLI reports, per model it actually ran, an entry keyed
  // on the exact snapshot. Read here: the two identity fields
  // (`canonicalModel` and the key itself, `observedModelsFromCliResult`) and,
  // since platform-owned-cost T6, the token counts (`modelUsageFromCliResult`).
  // The CLI's per-model cost fields are never read: the engine reports usage
  // facts and the platform prices them. One `--model sonnet` invocation can
  // run two models, which is why the counts are per model.
  readonly modelUsage?: Readonly<
    Record<
      string,
      | {
          readonly canonicalModel?: unknown;
          readonly inputTokens?: unknown;
          readonly outputTokens?: unknown;
          readonly cacheReadInputTokens?: unknown;
          readonly cacheCreationInputTokens?: unknown;
          readonly cacheCreationEphemeral1hInputTokens?: unknown;
          readonly cacheCreationEphemeral5mInputTokens?: unknown;
          readonly thinkingTokens?: unknown;
        }
      | null
      | undefined
    >
  >;
}

// #175 half 2: which models the provider says it ran, in the order it
// reported them.
//
// Absence over fabrication, three ways: unparseable stdout, no `modelUsage`
// key, and an EMPTY `modelUsage` all answer `undefined`. An empty array would
// assert "we looked and nothing ran", which is a claim about the provider we
// have no basis for — the same distinction `normalizeUnavailableUsage` draws
// between unknown usage and a zero one.
//
// Parsed separately from `normalizeClaudeCliUsage` rather than folded into
// it: that function's contract is the §8 numeric shape, and its every branch
// is about not fabricating a token count. Identity is a different fact with
// different failure modes, so it gets its own parse and its own honest
// absence.
function observedModelsFromCliResult(
  rawStdout: string,
): readonly ObservedModel[] | undefined {
  let parsed: RawClaudeCliResult;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    return undefined;
  }
  const raw = parsed.modelUsage;
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const observed: ObservedModel[] = [];
  for (const [model, entry] of Object.entries(raw)) {
    if (model.trim().length === 0) continue;
    // A non-string canonicalModel is dropped rather than coerced: the field
    // is a model IDENTITY, and `String(someObject)` would put "[object
    // Object]" into a provenance record that reads as a model name.
    const canonicalModel =
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.canonicalModel === "string" &&
      entry.canonicalModel.trim().length > 0
        ? entry.canonicalModel
        : undefined;
    observed.push({
      model,
      ...(canonicalModel === undefined ? {} : { canonicalModel }),
    });
  }
  return observed.length === 0 ? undefined : observed;
}

// platform-owned-cost T6: the token counts of the same `modelUsage` block, per
// model, split into the platform's disjoint leaves (thinking out of output, the
// one-hour write out of the total write). The same absence rule as above: no
// parse, no block, or no usable entry answers `undefined`.
//
// The model is the provider's id, as the session transcript's `message.model`
// spells it, so the two can be joined: the CLI marks a context-window variant on
// its own model names with a bracketed suffix (`requestedModel:
// "claude-opus-5[1m]"` beside `message.model: "claude-opus-5"` in a real
// session), which names no provider model. A key carrying one is filed under the
// id without it, and entries that meet there are summed, so a summary key can
// never miss its transcript requests and count them twice as a remainder.
const CLI_MODEL_VARIANT = /\[[^\]]*\]$/;

function modelUsageFromCliResult(
  rawStdout: string,
): readonly ModelUsageCounts[] | undefined {
  let parsed: RawClaudeCliResult;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    return undefined;
  }
  const raw = parsed?.modelUsage;
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const models = new Map<string, number[]>();
  for (const [key, entry] of Object.entries(raw)) {
    const model = key.replace(CLI_MODEL_VARIANT, "");
    if (
      model.trim().length === 0 ||
      entry === null ||
      typeof entry !== "object"
    ) {
      continue;
    }
    const counts = claudeUsageCounts({
      uncached: entry.inputTokens,
      cacheRead: entry.cacheReadInputTokens,
      cacheWriteTotal: entry.cacheCreationInputTokens,
      cacheWrite1h: entry.cacheCreationEphemeral1hInputTokens,
      cacheWrite5m: entry.cacheCreationEphemeral5mInputTokens,
      output: entry.outputTokens,
      thinking: entry.thinkingTokens,
    });
    const sum = models.get(model) ?? [0, 0, 0, 0, 0, 0];
    counts.forEach((n, i) => {
      sum[i] = (sum[i] ?? 0) + n;
    });
    models.set(model, sum);
  }
  return models.size === 0
    ? undefined
    : [...models].map(([model, counts]) => ({
        model,
        counts: counts as unknown as ModelUsageCounts["counts"],
      }));
}

// #299 (2026-10-01): how many tool calls the model made, as far as the CLI's
// result lets us say. `num_turns` counts ASSISTANT turns, and every turn after
// the first begins from tool results, so `num_turns - 1` is a LOWER BOUND on
// tool calls: parallel calls inside one turn count once. That is exact on the
// one distinction the vacuous-hunt gate needs, zero versus nonzero, and
// deliberately not offered as a call count. Observed 2026-10-01: 1 turn with no
// tools, 2 turns for one Read, 17 turns for a deep hunt.
//
// `undefined` — never a fabricated 0 — unless `num_turns` is an integer >= 1.
// A 0 here asserts "we looked and the model issued none", which would fail a
// hunt on the strength of a field we never saw (missing, a string, a float, or
// a turn count of 0, which no completed attempt can have). Each attempt is its
// own `claude -p` process, with no `--resume`, so `num_turns` is per attempt
// and a retry cannot inherit the previous attempt's count.
function toolInvocationsFromCliResult(rawStdout: string): number | undefined {
  let parsed: RawClaudeCliResult;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    return undefined;
  }
  // `JSON.parse("null")` is valid JSON and not an object.
  if (parsed === null || typeof parsed !== "object") return undefined;
  const turns = parsed.num_turns;
  return typeof turns === "number" && Number.isInteger(turns) && turns >= 1
    ? turns - 1
    : undefined;
}

// §8: `--output-format json`'s usage block is already disjoint-additive —
// input_tokens (uncached), cache_read_input_tokens, and
// cache_creation_input_tokens sum to total input (verified against the real
// CLI); this is NOT OpenAI's "total that includes a subset" shape, so the
// leaves are read straight across rather than split from a total via
// `normalizeInclusiveUsage`. Corrupted stdout, and valid JSON carrying no
// `usage` block at all (a safety-blocked or otherwise usage-less response),
// both yield `normalizeUnavailableUsage` — never a fabricated zero leaf.
//
// The credential class (`billingMode`) is filed per attempt from the env the
// child ran with (`claudeCliBillingMode`); the CLI's own cost figure is not
// read — the platform prices a run from the tokens and models reported here.
function normalizeClaudeCliUsage(
  rawStdout: string,
  wallMs: number,
  env: Readonly<Record<string, string | undefined>>,
): NormalizedUsage {
  const billingMode = claudeCliBillingMode(env);
  let parsed: RawClaudeCliResult;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    return normalizeUnavailableUsage({ wallMs, billingMode });
  }
  const raw = parsed.usage;
  if (raw === undefined) {
    return normalizeUnavailableUsage({ wallMs, billingMode });
  }
  const leafValues = [
    raw.input_tokens,
    raw.cache_read_input_tokens,
    raw.cache_creation_input_tokens,
    raw.output_tokens,
  ];
  const allLeavesDefined = leafValues.every((v) => typeof v === "number");
  if (!allLeavesDefined) {
    const providerReportedTotal = leafValues.reduce<number>(
      (sum, v) => sum + (typeof v === "number" ? v : 0),
      0,
    );
    return normalizePartialUsage({
      wallMs,
      providerReportedTotal,
      billingMode,
    });
  }
  const inputUncached = leafValues[0] as number;
  const inputCacheRead = leafValues[1] as number;
  const inputCacheWrite = leafValues[2] as number;
  const outputVisible = leafValues[3] as number;
  const inputKnown = inputUncached + inputCacheRead + inputCacheWrite;
  return {
    wallMs,
    tokens: {
      inputUncached,
      inputCacheRead,
      inputCacheWrite,
      outputVisible,
      inputKnown,
      outputKnown: outputVisible,
      totalKnown: inputKnown + outputVisible,
      providerReportedTotal: inputKnown + outputVisible,
    },
    completeness: "complete",
    billingMode,
  };
}

type CliProc = SpawnedProcess & { readonly pid: number };

type CascadeResult =
  | { kind: "term" }
  | { kind: "kill" }
  | { kind: "kill_unreaped" }
  | { kind: "signal_failed"; error: unknown };

export interface ClaudeCodeCliTransportOptions {
  readonly spawnFn?: typeof Bun.spawn;
  readonly getPgid?: (pid: number) => number | undefined;
  readonly killFn?: (pid: number, signal?: string | number) => unknown;
  readonly termGraceMs?: number;
  readonly killReapMs?: number;
  // §6.3 pre-spawn prompt verification surface; injectable for offline tests,
  // production defaults lstat + sha256 over the real file.
  readonly promptLstatFn?: (path: string) => PromptFileStatus | undefined;
  readonly promptHashFn?: (path: string) => string | Promise<string>;
}

// Bun does not (yet) expose process.getpgid; when a future runtime grows one we
// use it, otherwise the pgid comes from `ps -o pgid= -p <pid>` on this POSIX host.
const runtimeWithGetpgid = process as typeof process & {
  getpgid?: (pid: number) => number;
};

function systemGetPgid(pid: number): number | undefined {
  if (typeof runtimeWithGetpgid.getpgid === "function") {
    try {
      return runtimeWithGetpgid.getpgid(pid);
    } catch {
      return undefined;
    }
  }
  const probe = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]);
  if (probe.exitCode !== 0) return undefined;
  const raw = probe.stdout.toString().trim();
  if (raw.length === 0) return undefined;
  const pgid = Number(raw);
  return Number.isInteger(pgid) ? pgid : undefined;
}

// Resolves true when `p` settled first, false once `ms` elapsed first.
function raceExitFirst(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(false), ms);
    p.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

async function boundedText(
  pending: Promise<string>,
  ms: number,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  const value = await Promise.race([pending, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return value;
}

export class ClaudeCodeCliTransport implements ProviderTransport {
  readonly backend = "claude-code";
  readonly admissionIdentity = {
    executable: "claude",
    provider: "anthropic",
  } as const;
  readonly cancellationSemantics = "process-exit" as const;
  readonly defaultRoute: ResolvedModelRoute = {
    backend: "claude-code",
    provider: "anthropic",
    modelFamily: "claude",
    modelSnapshot: "sonnet",
  };
  get billingMode(): NormalizedUsage["billingMode"] {
    return claudeCliBillingMode(process.env);
  }
  private readonly spawnFn: typeof Bun.spawn;
  private readonly getPgid: (pid: number) => number | undefined;
  private readonly killFn: (pid: number, signal?: string | number) => unknown;
  private readonly termGraceMs: number;
  private readonly killReapMs: number;
  private readonly promptLstatFn: (
    path: string,
  ) => PromptFileStatus | undefined;
  private readonly promptHashFn: (path: string) => string | Promise<string>;

  constructor(options: ClaudeCodeCliTransportOptions = {}) {
    this.spawnFn = options.spawnFn ?? Bun.spawn;
    this.getPgid = options.getPgid ?? systemGetPgid;
    this.killFn = options.killFn ?? process.kill;
    this.termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
    this.killReapMs = options.killReapMs ?? KILL_REAP_MS;
    this.promptLstatFn = options.promptLstatFn ?? systemPromptStatus;
    this.promptHashFn = options.promptHashFn ?? hashPromptFile;
  }

  // §6.3: system prompts are 0600, non-symlink files whose hashes are checked
  // immediately before spawn. Returns the denial reason, or undefined when
  // verification holds.
  private async verifyPromptIntegrity(
    request: TransportRequest,
  ): Promise<string | undefined> {
    const status = await this.promptLstatFn(request.systemPromptPath);
    if (status === undefined) {
      return `system prompt unreadable: ${request.systemPromptPath}`;
    }
    if (status.isSymbolicLink) {
      return `system prompt is a symlink: ${request.systemPromptPath}`;
    }
    // Raw lstat mode carries file-type bits; only the permission bits must be
    // exactly 0600.
    if ((status.mode & 0o777) !== 0o600) {
      return `system prompt mode is ${(status.mode & 0o777).toString(8)}, expected 600`;
    }
    const actualSha256 = await this.promptHashFn(request.systemPromptPath);
    if (actualSha256 !== request.systemPromptSha256) {
      return "system prompt hash mismatch against request.systemPromptSha256";
    }
    return undefined;
  }

  // §11/D1-09: static report built from the SAME constants the report
  // producer reads (CLAUDE_CAPABILITY_STATICS), so transport and producer can
  // never contradict each other. projectionReady/syntheticHome are
  // contractual here, not probed: every execute() request must carry an
  // IsolationProjection (credentialProjectionId + syntheticHome) or admission
  // denies it. Unproven features are claimed false with a
  // yet and no dedicated codegraph policy is enforced — hence status
  // "degraded", not "ready".
  async capabilities(
    input?: ClaudeCliCapabilitiesInput,
  ): Promise<ProviderCapabilityReport> {
    return {
      backend: "claude-code",
      status: "degraded",
      auth: {
        kind: CLAUDE_CAPABILITY_STATICS.authKind,
        projectionReady: true,
        probe: "not_run",
      },
      isolation: {
        syntheticHome: true,
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
        // The backend-wide report is a STATIC claim made at admission, before
        // any spawn and before any route (and so any credential) resolves.
        // The per-route credential class lives on the exact binding
        // (`FrozenRuntimeBinding.capabilities()`, production-runtime.ts),
        // which upgrades this mode through `credentialKindBillsMetered`.
        // That is #161's rule: `credentialKindForRoute` (runner-authority.ts)
        // derives `provider_api_token` — a metered kind — for a claude-code
        // route whose environment carries ANTHROPIC_API_KEY or
        // ANTHROPIC_AUTH_TOKEN AND that has no credential broker projecting
        // for it, because with no broker nothing strips the key before the
        // child sees it (the common case on Linux/CI, which has no Keychain
        // to project from). A route with a broker whose projection SUCCEEDS
        // stays subscription whatever its env carries. A degraded projection
        // is #279's known exception: admission cannot see that a projection
        // failed and fell back to the unstripped env, so that route keeps
        // saying subscription while the key reaches the child. That
        // ADMISSION-time answer is deliberately left that way: the fix lives
        // downstream, in `StepExecutionHarness.run` (harness.ts), which
        // re-applies `envBillsMetered` to this SAME child env this module
        // stamps `billingMode: "metered"` from, and opens a spend-ledger
        // reservation for that one attempt so it is settled or fenced exactly
        // like a metered route.
        mode: CLAUDE_CAPABILITY_STATICS.billingMode,
      },
      ...(input !== undefined
        ? {
            rateLimitBucketId: deriveBucketId(
              {
                provider: BUCKET_IDENTITY_PROVIDER,
                credentialFingerprint: input.credentialFingerprint,
                scope: input.bucketScope,
              },
              input.localKey,
            ),
          }
        : {}),
      issues: [
        {
          code: "codegraph_policy_unenforced",
          message:
            "no dedicated codegraph sensitive-file policy is enforced yet; isolation relies on --strict-mcp-config with a codegraph-only mcp.json",
          blocking: false,
        },
        {
          code: "bounded_events_sink_missing",
          message:
            "bounded event streaming is not wired: the event sink is currently a no-op and usage arrives as a final snapshot",
          blocking: false,
        },
      ],
    };
  }

  private runCascade(
    proc: CliProc,
    pgid: number | undefined,
  ): Promise<CascadeResult> {
    const deliver = (signal: string): boolean => {
      let delivered = false;
      if (pgid !== undefined) {
        // Negative-pgid signaling reaches every descendant the CLI spawned; a
        // bare proc.kill() would orphan its subprocesses. Only reachable once
        // the dedicated-PGID proof held.
        try {
          this.killFn(-pgid, signal);
          delivered = true;
        } catch {
          void signal;
        }
      }
      // Direct line to the leader itself: redundant for a live child (it is in
      // the group) but it unblocks offline doubles whose kill() settles their
      // streams, and it is the only delivery possible when no kernel pid
      // exists to prove a group for.
      try {
        proc.kill();
        delivered = true;
      } catch {
        void signal;
      }
      return delivered;
    };

    return (async (): Promise<CascadeResult> => {
      // §5.2: SIGTERM to -pgid, then a 5,000 ms grace window before escalation.
      if (!deliver("SIGTERM")) {
        return { kind: "signal_failed", error: new Error("SIGTERM failed") };
      }
      const exitedDuringGrace = await raceExitFirst(
        proc.exited,
        this.termGraceMs,
      );
      if (exitedDuringGrace) return { kind: "term" };
      if (!deliver("SIGKILL")) {
        return { kind: "signal_failed", error: new Error("SIGKILL failed") };
      }
      const reaped = await raceExitFirst(proc.exited, this.killReapMs);
      return reaped ? { kind: "kill" } : { kind: "kill_unreaped" };
    })();
  }

  async execute(
    request: TransportRequest,
    context: {
      readonly signal: AbortSignal;
      readonly events?: import("../execution/contracts").AsyncEventSink;
    },
  ): Promise<TransportOutcome> {
    // The engine owns the effort and ALWAYS passes it (#299). The CLI's own
    // default is `high` except on Sonnet 5.5 / Opus 5.5 (`medium`), so a
    // request that reaches here without a level would quietly put the step back
    // on the implicit default this flag exists to replace. That is a
    // programming error, not a case to fall back from, and it throws before the
    // paid spawn. The child env is an allowlist without
    // CLAUDE_CODE_EFFORT_LEVEL, so nothing the operator exports can override it.
    if (typeof request.effort !== "string" || !isEffort(request.effort)) {
      throw new Error(
        `claude-code transport requires an explicit effort, got ${JSON.stringify(request.effort)}`,
      );
    }
    // `-p` with NO positional prompt: the CLI then reads the prompt from
    // stdin, which the spawn below supplies (#314 — see the WHY there).
    const args = [
      request.isolation.verifiedBinaryPath,
      "-p",
      "--append-system-prompt-file",
      request.systemPromptPath,
      "--output-format",
      "json",
    ];

    if (request.mcpConfigPath) {
      args.push("--mcp-config", request.mcpConfigPath, "--strict-mcp-config");
    }

    args.push(
      "--setting-sources",
      "",
      "--tools",
      request.tools.join(","),
      "--permission-mode",
      "bypassPermissions",
      "--model",
      claudeCliModel(request.route),
      "--effort",
      request.effort,
      // Moves the per-machine sections (cwd, env info, git status) out of the
      // system prompt into the first user message. Without it every worktree
      // path changes the system prompt, so no spawn could reuse the cached
      // tools + base prompt another review wrote: measured 2026-10-21 (lab
      // ledger, prompt-cache layout probe), a second repo wrote 6.6k cache
      // tokens without the flag and 1.4k with it. Nothing leaves the context;
      // isolation is unchanged.
      "--exclude-dynamic-system-prompt-sections",
    );

    // The engine names the session so its transcript can be found however
    // the attempt ends, including a timeout, a kill or a cancel that leaves no
    // result to read the id from. `-p` never resumes, so a fresh id per spawn
    // cannot collide.
    const claudeSessionId = newClaudeSessionId();
    args.push("--session-id", claudeSessionId);

    const start = performance.now();

    // §6.3: hash/mode/symlink verification happens immediately before spawn;
    // a failed check never reaches the provider.
    const promptDenial = await this.verifyPromptIntegrity(request);
    if (promptDenial !== undefined) {
      return {
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: noSpawnUsage(
          Math.round(performance.now() - start),
          request.isolation.env,
        ),
        stderrTail: `[pr-hero] prompt integrity denied: ${promptDenial}; no spawn`,
      };
    }

    // detached: Bun maps this to setsid() on POSIX, so the child starts a new
    // session and leads its own process group — the precondition for §5.2's
    // negative-PGID cascade to be safe at all.
    //
    // stdin carries the user prompt, never argv (#314). The prompt embeds the
    // whole patch, and Linux caps ONE argv string at MAX_ARG_STRLEN (131072
    // bytes including the NUL): a 175,805-byte patch made execve fail with
    // E2BIG, so every hunter on that PR died in 7s before reaching the
    // provider. stdin has no such bound. `claude -p` with no positional
    // prompt reads it from stdin (verified against claude 2.1.289 with a
    // 175,865-byte prompt). Never pass both: which one the CLI would honor is
    // unverified, and a positional prompt brings the size bug back. Same
    // channel and reason as gh's report body in pr/pr.ts.
    //
    // A synchronous spawn throw (execve refused: E2BIG, ENOENT, EACCES) is a
    // failed attempt with its reason, not a rejection (#314). Thrown, it
    // escaped before the try below, the harness swallowed the rejection and
    // settled the attempt as cancelled (the step's only recorded reason was
    // "step cancelled; settled per §5.3"), and the run log said only "failed" —
    // the E2BIG that killed every hunter was visible nowhere. Nothing was
    // spawned, so nothing is registered and nothing was spent.
    let proc: CliProc;
    try {
      proc = this.spawnFn(args, {
        cwd: request.cwd,
        env: request.isolation.env,
        stdin: new TextEncoder().encode(request.userPrompt),
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      }) as unknown as CliProc;
    } catch (error) {
      return {
        completion: "failed",
        protocolIntegrity: "unverified",
        finalText: "",
        usage: noSpawnUsage(
          Math.round(performance.now() - start),
          request.isolation.env,
        ),
        stderrTail: spawnFailureTail(error),
      };
    }

    ACTIVE_CHILD_PROCS.add(proc);
    retainClaudeSession(request, claudeSessionId);

    let cascadePromise: Promise<CascadeResult> | undefined;
    let provenPgid: number | undefined;
    let notifyCascadeStart: (value: "cascade") => void = () => {};
    const cascadeStarted = new Promise<"cascade">((resolve) => {
      notifyCascadeStart = resolve;
    });
    const startCascade = () => {
      // Only reachable past the PGID proof below: negative-pgid signaling is
      // armed exclusively after the child was proven to lead its own group
      // (or is an offline double with no group to signal at all).
      if (cascadePromise) return;
      cascadePromise = this.runCascade(proc, provenPgid);
      notifyCascadeStart("cascade");
    };
    const onAbort = () => {
      startCascade();
    };

    try {
      // §5.2: proof that pid == pgid must hold BEFORE any negative-PGID signal
      // path is armed. Failure means we never signal — a wrong guess could kill
      // the host's own group instead of the child's. A child without a kernel
      // pid is an offline test double: no group exists to prove or signal.
      const rawPid = (proc as { pid?: unknown }).pid;
      const kernelPid =
        typeof rawPid === "number" && Number.isInteger(rawPid) && rawPid > 1
          ? rawPid
          : undefined;
      let provenGroup: number | undefined;
      if (kernelPid !== undefined) {
        const pgid = this.getPgid(kernelPid);
        if (pgid === undefined || pgid !== kernelPid) {
          return {
            completion: "failed",
            protocolIntegrity: "unverified",
            finalText: "",
            usage: noSpawnUsage(
              Math.round(performance.now() - start),
              request.isolation.env,
            ),
            stderrTail:
              pgid === undefined
                ? `[pr-hero] PGID proof failed: could not read pgid for pid ${kernelPid}; no signal sent`
                : `[pr-hero] PGID proof failed: pid ${kernelPid} has pgid ${pgid}, expected ${kernelPid}; no signal sent`,
          };
        }
        provenGroup = pgid;
      }

      provenPgid = provenGroup;

      const stdoutPending = new Response(proc.stdout).text();
      const stderrPending = new Response(proc.stderr).text();

      // Per-attempt step timeout is harness-owned (StepSpec.timeoutMs → watchdog
      // → AbortSignal). Transports react only to the supplied signal.

      if (context.signal.aborted) {
        onAbort();
      } else {
        context.signal.addEventListener("abort", onAbort, { once: true });
      }

      let exitCode: number | undefined;
      let stdout: string;
      let stderr: string;
      let unreaped = false;
      let escalatedToKill = false;

      const natural = Promise.all([stdoutPending, stderrPending, proc.exited]);

      // The ladder can be armed by the timeout while we are mid-await on the
      // natural path; race it so an unkillable group cannot hang us forever.
      const route = await Promise.race([
        natural.then((): "natural" => "natural"),
        cascadeStarted,
      ]);

      if (route === "natural") {
        [stdout, stderr, exitCode] = await natural;
        if (cascadePromise !== undefined) {
          const late = await cascadePromise;
          escalatedToKill =
            late.kind === "kill" || late.kind === "kill_unreaped";
        }
      } else {
        if (cascadePromise === undefined) {
          throw new Error("cascade route taken without an armed cascade");
        }
        const cascade = await cascadePromise;
        escalatedToKill =
          cascade.kind === "kill" || cascade.kind === "kill_unreaped";
        if (
          cascade.kind === "term" ||
          cascade.kind === "kill" ||
          cascade.kind === "signal_failed"
        ) {
          [stdout, stderr, exitCode] = await natural;
        } else {
          // The group survived SIGKILL past the 2,000 ms reap bound: stop
          // waiting, take whatever output landed, and record it rather than
          // hang the harness past its 7,500 ms deadline.
          unreaped = true;
          stdout = (await boundedText(stdoutPending, this.killReapMs)) ?? "";
          stderr = (await boundedText(stderrPending, this.killReapMs)) ?? "";
        }
      }

      const wallMs = Math.round(performance.now() - start);

      let fullResult = "";
      let apiError: ProviderApiError | undefined;
      try {
        const parsed = JSON.parse(stdout) as CliResultEnvelope;
        fullResult = typeof parsed.result === "string" ? parsed.result : "";
        apiError = providerApiErrorOf(parsed);
      } catch {
        // non-json stdout
      }

      const usage = normalizeClaudeCliUsage(
        stdout,
        wallMs,
        request.isolation.env,
      );
      const observedModels = observedModelsFromCliResult(stdout);
      const modelUsage = modelUsageFromCliResult(stdout);
      const toolInvocations = toolInvocationsFromCliResult(stdout);

      let stderrTail = stderr.slice(-4096);
      if (unreaped) {
        stderrTail =
          `${stderrTail}\n[pr-hero] child process group -${provenPgid ?? "(unproven)"} was not reaped within ${this.killReapMs}ms after SIGKILL`.slice(
            -4096,
          );
      }

      const terminalProof: ProviderTerminalProof | undefined =
        exitCode === undefined
          ? undefined
          : {
              eventId: `${request.sessionId}-${request.attempt}-terminal`,
              providerStatus: exitCode === 0 ? "completed" : "failed",
              providerObservedAt: new Date().toISOString(),
              exitCode,
              ...(escalatedToKill ? { signal: "SIGKILL" } : {}),
            };

      // The result's `session_id` is not read for the transcript: the id passed
      // as `--session-id` is the one retained at spawn, and it wins if the two
      // ever differ, because only it exists on every way an attempt ends.
      //
      // The CLI exits 0 when the API rejected the request, with the provider's message in
      // `result`. That message is not the agent's answer: it fails the attempt with its
      // typed cause, is never handed to the draft parser (which would spend a format retry
      // on it), and its words go to the attempt's diagnostics.
      const failureCredential =
        apiError === undefined
          ? undefined
          : credentialOf(request.isolation.env);
      if (apiError !== undefined) {
        fullResult = "";
        stderrTail = `${stderrTail}\n[pr-hero] ${apiError.detail}`.slice(-4096);
      }

      const isCancelled = context.signal.aborted;
      const completion: TransportOutcome["completion"] = isCancelled
        ? "cancelled"
        : apiError === undefined &&
            exitCode === 0 &&
            fullResult &&
            terminalProof !== undefined
          ? "success"
          : "failed";

      if (terminalProof === undefined && !isCancelled) {
        stderrTail =
          `${stderrTail}\n[pr-hero] no terminal proof observed; refusing success`.slice(
            -4096,
          );
      }

      return {
        completion,
        protocolIntegrity:
          unreaped || terminalProof === undefined
            ? "unverified"
            : stdout
              ? "verified"
              : "unverified",
        ...(terminalProof !== undefined ? { terminalProof } : {}),
        ...(apiError === undefined
          ? {}
          : {
              failureCause: apiError.cause,
              failureDetail: apiError.detail,
              ...(failureCredential === undefined ? {} : { failureCredential }),
            }),
        finalText: fullResult,
        usage,
        stderrTail,
        ...(observedModels === undefined ? {} : { observedModels }),
        ...(modelUsage === undefined ? {} : { modelUsage }),
        ...(toolInvocations === undefined ? {} : { toolInvocations }),
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
    } finally {
      ACTIVE_CHILD_PROCS.delete(proc);
      context.signal.removeEventListener("abort", onAbort);
    }
  }

  classifyFailure(
    outcome: TransportOutcome,
  ): TransportFailureCause | undefined {
    // First, and definitive whatever the error text says (PR #315 review
    // F004): no child started, so nothing reached a provider and the same
    // argv would be refused again. Unclassified, it fell through to the
    // legacy "format" class and respawned once with a format reminder — a
    // longer prompt, against the E2BIG that a too-long argv caused. See
    // isSpawnFailureTail for why the whole tail is the witness.
    if (isSpawnFailureTail(outcome.stderrTail)) {
      return "runtime_unavailable";
    }
    const witness = `${outcome.stderrTail}\n${outcome.finalText}`;
    // The child's stderr, with no model output mixed in — see the two-witness
    // note on the backpressure branch below.
    const diagnostics = outcome.stderrTail;
    if (/Not logged in\s*[·.]\s*Please run \/login/i.test(witness)) {
      return "auth_invalid";
    }
    // Backpressure is tested BEFORE the generic network witness, and the
    // order is load-bearing: the real CLI string for an overload is
    // "API Error: 529 overloaded_error", which matches both. Tested second,
    // rate_limit would never fire for the exact witness it exists to catch.
    //
    // §7 gives these two causes different dispositions on purpose —
    // rate_limit waits (validated Retry-After or capped exponential),
    // network_transient retries immediately. Retrying instantly against a
    // server that just said it is saturated deepens the saturation and burns
    // the entire transient budget in milliseconds.
    //
    // Backpressure is read from TWO witnesses, because the two channels do
    // not carry the same kind of text. `finalText` is
    // `JSON.parse(stdout).result` — mixed: the CLI's own error text AND the
    // model's final message. pr-hero's model output is code-review prose
    // about exactly these failure modes ("this endpoint has no rate limit",
    // "consider returning 429"), so an English phrase or a bare status code
    // read from there matches the tool's own subject matter and routes a
    // healthy failure into a backoff it never earned. `stderrTail` is the
    // child's diagnostics channel and carries no model prose at all.
    //
    // So: provider error TYPES are machine tokens no reviewer writes in a
    // sentence, and are trusted from either channel — this is what keeps the
    // real witness "API Error: 529 overloaded_error" classified even when the
    // CLI surfaces it through `result`.
    if (/rate_limit_error|overloaded_error/i.test(witness)) {
      return "rate_limit";
    }
    // Everything prose-shaped — bare phrases and bare status codes — is read
    // from diagnostics ONLY. Word boundaries keep a token count like 15291 or
    // a job id like 1429 from being read as a status.
    if (
      /\b429\b|\b529\b|\b503\b|overloaded|rate[ _-]?limit|too many requests|service unavailable/i.test(
        diagnostics,
      )
    ) {
      return "rate_limit";
    }
    // Connection-level only. Nothing upstream asked us to slow down, and
    // waiting out a reset socket buys nothing. 502 stays here: a bad gateway
    // is a proxy failure, not a capacity signal.
    if (
      /API Error|Connection closed|ECONNRESET|socket hang up|timed out|\b502\b/i.test(
        witness,
      )
    ) {
      return "network_transient";
    }
    return undefined;
  }
}

// The envelope fields the error map reads. `result` is the model's answer on a normal run
// and the CLI's own message on an error.
interface CliResultEnvelope {
  readonly result?: unknown;
  readonly subtype?: unknown;
  readonly is_error?: unknown;
  readonly terminal_reason?: unknown;
  readonly api_error_status?: unknown;
}

interface ProviderApiError {
  readonly cause: TransportFailureCause;
  readonly detail: string;
}

const API_ERROR_DETAIL_MAX = 160;
const UNNAMED_TAG_MAX = 60;

// Text witnesses that split ONE status into two causes (S3 of odd/tasks/claude-error-map.md).
// A 400 is a spent balance or limit, or a plain malformed request; a 429 is a usage limit
// that will not clear within minutes ("You've hit your 5-hour limit · resets 12:40pm", a
// tier spend cap), or a rate limit that will. They are read ONLY once a status picked the
// branch, never alone.
//
// The patterns are Anthropic's real wordings: "Credit balance is too low", "You have reached
// your specified workspace API usage limits" (a 400), "You've hit your 5-hour limit"
// (a subscription), a tier "spend cap". Bare "limit reached" and "resets" are NOT witnesses:
// an ordinary per-minute rate-limit message can say either and must keep its backoff retry.
const CREDIT_OR_SPEND_LIMIT = /credit balance|spend limit|usage limit/i;
const SUBSCRIPTION_OR_SPEND_CAP =
  /hit your .*limit|usage limit|spend cap|spend limit/i;
// A usage-limit message that arrives with no status is the same terminal limit.
const USAGE_LIMIT_NO_STATUS =
  /hit your .*limit|usage limit|credit balance|spend cap|spend limit/i;
const NOT_LOGGED_IN = /Not logged in\s*[·.]\s*Please run \/login/i;

// The map from one error envelope to its typed cause. The CLI prints `is_error: true` with
// the HTTP status of the API's refusal in `api_error_status`, and `terminal_reason` /
// `subtype` for the run-level errors that have no status. The exit code is NOT a signal:
// an API rejection exits 0 (CLI 2.1.312) or 1 (anthropics/claude-code#103807).
//
// The status is read first, then the reason, and a message only to split one status. The
// retry rule is the cause's own (failure-policy.ts): only rate_limit and network_transient
// retry. So the causes that cannot clear in minutes (an empty balance, a subscription
// window) are terminal, and a server-side failure is never made terminal, since the CLI
// wraps 5xx and 529 in this same envelope.
//
// An `is_error` the map does not name (a stop hook, a budget cap, a reason a later CLI adds)
// returns undefined here, and providerApiErrorOf fails it terminally rather than let the
// error text be parsed as a draft and earn a format retry that hides the cause.
function claudeCliErrorCause(
  envelope: CliResultEnvelope,
): TransportFailureCause | undefined {
  const status =
    typeof envelope.api_error_status === "number" &&
    Number.isInteger(envelope.api_error_status)
      ? envelope.api_error_status
      : undefined;
  const reason =
    typeof envelope.terminal_reason === "string"
      ? envelope.terminal_reason
      : undefined;
  const subtype =
    typeof envelope.subtype === "string" ? envelope.subtype : undefined;
  const message = typeof envelope.result === "string" ? envelope.result : "";

  // The prompt-too-long reason is the CLI's own, and the API reports it as a 400.
  if (reason === "prompt_too_long" || status === 413) {
    return "context_window_exceeded";
  }
  if (status !== undefined) {
    if (status === 401 || status === 403) return "auth_invalid";
    if (status === 402) return "quota_exhausted";
    if (status === 404) return "model_unavailable";
    if (status === 400) {
      return CREDIT_OR_SPEND_LIMIT.test(message)
        ? "quota_exhausted"
        : "provider_configuration_invalid";
    }
    if (status === 429) {
      return SUBSCRIPTION_OR_SPEND_CAP.test(message)
        ? "quota_exhausted"
        : "rate_limit";
    }
    // 503 backs off like 529: an instant retry against a saturated server burns the whole
    // transient budget in milliseconds (the same reason classifyFailure reads it as
    // rate_limit). Every other 5xx is a failure to try again at once.
    if (status === 529 || status === 503) return "rate_limit";
    if (status >= 500) return "network_transient";
    if (status >= 400) return "provider_configuration_invalid";
    return undefined;
  }

  // No status: the CLI's own words, then the run-level reasons.
  if (NOT_LOGGED_IN.test(message)) return "auth_invalid";
  if (reason === "max_output_tokens" || /max_output_tokens/.test(message)) {
    return "output_limit_exceeded";
  }
  if (subtype === "error_max_turns" || reason === "max_turns") {
    return "output_limit_exceeded";
  }
  if (reason === "model_error" || reason === "malformed_tool_use_exhausted") {
    return "protocol_mismatch";
  }
  if (USAGE_LIMIT_NO_STATUS.test(message)) return "quota_exhausted";
  if (/overloaded|rate_limit_error|service unavailable/i.test(message)) {
    return "rate_limit";
  }
  if (
    reason === "aborted_streaming" ||
    reason === "aborted_tools" ||
    subtype === "error_during_execution" ||
    reason === "api_error"
  ) {
    return "network_transient";
  }
  return undefined;
}

// The typed cause and one short line of the CLI's own words, or undefined for a result
// that is not an error the map names.
function providerApiErrorOf(
  envelope: CliResultEnvelope,
): ProviderApiError | undefined {
  if (envelope.is_error !== true) return undefined;
  const cause = claudeCliErrorCause(envelope);

  const status =
    typeof envelope.api_error_status === "number"
      ? envelope.api_error_status
      : undefined;
  const reason =
    typeof envelope.terminal_reason === "string"
      ? envelope.terminal_reason
      : undefined;
  const subtype =
    typeof envelope.subtype === "string" ? envelope.subtype : undefined;
  const message = typeof envelope.result === "string" ? envelope.result : "";

  // An error the map does not name. The CLI said it failed, so the text is not an answer;
  // the request is not one a retry can fix, so it is terminal, and the reason is quoted
  // beside the CLI's words so CI shows what happened instead of a generic failure.
  if (cause === undefined) {
    // The tag is the CLI's text too: one line, and short enough that the message keeps
    // room in the 160 characters.
    const tag =
      oneLine(
        reason ??
          (subtype !== undefined && subtype !== "success" ? subtype : ""),
        UNNAMED_TAG_MAX,
      ) || "unknown";
    const suffix = ` (${tag}${status === undefined ? "" : `, HTTP ${status}`})`;
    const prefix = "Claude CLI: ";
    const words = oneLine(
      message.trim() === "" ? "no message" : message,
      API_ERROR_DETAIL_MAX - prefix.length - suffix.length,
    );
    return {
      cause: "provider_configuration_invalid",
      detail: `${prefix}${words}${suffix}`,
    };
  }

  // A run-level error has no message of its own; its reason names it.
  const named =
    subtype !== undefined && subtype !== "success" ? subtype : reason;
  const words = message.trim() === "" ? (named ?? "") : message;
  const prefix =
    status !== undefined || reason === "api_error"
      ? "Anthropic API: "
      : "Claude CLI: ";

  // One line, no control characters, and short enough for a commit status.
  const suffix = status === undefined ? "" : ` (HTTP ${status})`;
  const room = API_ERROR_DETAIL_MAX - prefix.length - suffix.length;
  return { cause, detail: `${prefix}${oneLine(words, room)}${suffix}` };
}

// The CLI's words as one line: control characters become spaces, whitespace collapses, and
// the text is cut with an ellipsis to fit `room` characters.
function oneLine(words: string, room: number): string {
  const flat = Array.from(words, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= room ? flat : `${flat.slice(0, room - 1)}…`;
}

// The secret the child ran on. The per-token variables (the list envBillsMetered reads) win
// over CLAUDE_CODE_OAUTH_TOKEN, and a whitespace-only value is no credential (the same trim).
// Since S5 a review run's child holds exactly one of them (the credential chosen at run
// start, security/claude-credential.ts), so the precedence below only decides for callers
// that build their own env.
//
// The precedence is observed, not assumed. With CLI 2.1.312 and both an API key and an
// OAuth login present, the CLI prints "claude.ai connectors are disabled because
// ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai
// login". On juanmaagd/pr-hero CI with both secrets bound, every request used the API key
// ("Credit balance is too low") while CLAUDE_CODE_OAUTH_TOKEN was valid.
function credentialOf(
  env: Readonly<Record<string, string | undefined>>,
): FailureCredential | undefined {
  for (const name of METERED_CREDENTIAL_ENV) {
    if (env[name]?.trim()) return name;
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return "CLAUDE_CODE_OAUTH_TOKEN";
  return undefined;
}

// The failed outcome execute() returns when spawn throws, and its exact
// witness for classifyFailure. Producer and matcher share these two
// constants so a reworded message cannot silently become retryable again.
// The WHOLE tail is matched, not a line inside it: this outcome never has a
// child, so its stderrTail is exactly this string and nothing else, while a
// real child's stderr that merely quotes the phrase starts with the child's
// own output. classifyFailure runs on the transport's outcome before the
// harness appends its own annotations, so the suffix is still the end. The
// message between them can span lines; prefix and suffix cannot.
const SPAWN_FAILURE_PREFIX = "[pr-hero] spawn failed: ";
const SPAWN_FAILURE_SUFFIX = "; no child started";

function spawnFailureTail(error: unknown): string {
  return `${SPAWN_FAILURE_PREFIX}${describeSpawnError(error)}${SPAWN_FAILURE_SUFFIX}`;
}

function isSpawnFailureTail(stderrTail: string): boolean {
  return (
    stderrTail.startsWith(SPAWN_FAILURE_PREFIX) &&
    stderrTail.endsWith(SPAWN_FAILURE_SUFFIX)
  );
}

// "<code>: <message>" for a spawn throw, without repeating a code the message
// already leads with (Bun's system errors often do). A non-Error throw is
// stringified rather than dropped: the reason is the whole point (#314).
function describeSpawnError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  if (
    typeof code === "string" &&
    code !== "" &&
    !error.message.includes(code)
  ) {
    return `${code}: ${error.message}`;
  }
  return error.message;
}
