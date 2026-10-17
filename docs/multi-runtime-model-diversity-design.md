# Multi-Runtime Execution and Cross-Model Diversity

**Document ID:** `docs/multi-runtime-model-diversity-design.md`  
**Status:** Rev 5 — Final Candidate  
**Target:** Phase D (D1 multi-runtime harness, D2 routing, D3 model diversity)  
**Date:** 2026-08-25

> **Decision:** This revision is the final implementation candidate. It is not self-ratified: ratification requires every closure item and offline acceptance test in §13 to pass against the implementation.

## Review path

Review lifecycle ownership and settlement first (§§3–5), then isolation and failure policy (§§6–7), accounting (§§8–9), and finally the D3 consensus algebra (§10). Implementation order and acceptance evidence are in §§12–13.

---

## 1. Scope and non-negotiable invariants

`pr-hero` will evolve from a Claude Code-only step runner into a shared harness over CLI and SDK transports. Later phases add explicit model routing and cross-model hunter diversity without weakening the existing refuter or deterministic tiering.

| Invariant | Contract |
|---|---|
| Refuter authority | Every severe candidate is challenged. Hunter agreement is provenance, never a verdict. |
| Lifecycle ownership | The harness owns watchdogs, retries, parsing, write leases, persistence, concurrency, and spend. A transport owns only provider/process mechanics and its declared cancellation protocol. |
| Settlement honesty | Local mutation is fenced before persistence. A receipt distinguishes confirmed termination from an unknown remote state; it never claims remote spend stopped without proof. |
| Isolation | Executables, credentials, filesystem reads, MCP access, prompts, and raw witnesses cross explicit projections only. Ambient home/config/PATH are not capabilities. |
| Accounting | Usage leaves are disjoint, reservations are transactional, and incomplete metered cost fails closed before another paid attempt. |
| Diversity | Observations remain lossless through deterministic matching, clustering, blind adjudication, and final finding projection. |
| Rollout | D3 is off by default and advances only through a frozen, replicated experiment with explicit promotion and rollback criteria. |

The ROADMAP sequence remains **D1 → D2 → C2 → D3**. C2 is the schema prerequisite for D3, not an optional cleanup.

---

## 2. Architecture and ownership

```text
runPipeline / StepSpec
  ├─ StepExecutionHarness
  │    ├─ watchdog + cancellation coordinator
  │    ├─ retry policy + StepSpec.parse()
  │    ├─ write leases + atomic persistence
  │    ├─ bounded event sink
  │    ├─ spend reservations + concurrency admission
  │    └─ ProviderTransport
  │         ├─ ClaudeCodeCliTransport
  │         └─ OpenCodeSdkTransport
  └─ D3 diversity coordinator
       ├─ observation matcher + cluster builder
       ├─ independent blind refuter route
       └─ Finding/debug projection
```

The boundary is intentional:

- **Harness:** timeout policy, pipeline ceiling, retry disposition, parsing, artifact paths, redaction policy, admission, and final persistence.
- **Transport:** convert a resolved request into provider calls; translate the supplied `AbortSignal`; emit bounded protocol events; return a transport outcome; classify only provider/transport causes.
- **Credential broker:** project the minimum authentication material into an ephemeral session environment.
- **Workspace read broker:** mediate every workspace/codegraph read using the same path and sensitive-file policy.

No transport receives a `StepSpec`, parser, retry counter, artifact output path, timeout value, budget, or persistence callback.

---

## 3. Transport contract

### 3.1 Request and resolved route

```typescript
export type RunnerBackend = "claude-code" | "opencode" | "antigravity" | "codex";

export interface ResolvedModelRoute {
  readonly backend: RunnerBackend;
  readonly provider: string;
  readonly gateway?: string;
  readonly modelFamily: string;
  readonly modelSnapshot: string;
  readonly modelVariant?: string;
}

export interface TransportRequest {
  readonly sessionId: string;
  readonly attempt: number;
  readonly route: ResolvedModelRoute;
  readonly systemPromptPath: string;
  readonly systemPromptSha256: string;
  readonly userPrompt: string;
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly mcpConfigPath?: string;
  readonly isolation: IsolationProjection;
}
```

`TransportRequest` deliberately contains **no `timeoutMs` or lifecycle policy**. Cancellation deadlines are transport capabilities declared at preflight (§11), selected and enforced by the harness. It also contains no parser, retry policy, output path, callback, or spend data.

### 3.2 Provider transport

```typescript
export interface ProviderTransport {
  readonly backend: RunnerBackend;
  capabilities(): Promise<ProviderCapabilityReport>;
  execute(
    request: TransportRequest,
    context: {
      readonly signal: AbortSignal;
      readonly events: AsyncEventSink;
    },
  ): Promise<TransportOutcome>;
  classifyFailure(outcome: TransportOutcome): TransportFailureCause | undefined;
}

export interface TransportOutcome {
  readonly completion: "success" | "failed" | "cancelled";
  readonly protocolIntegrity: "verified" | "truncated" | "malformed" | "overflow" | "unverified";
  readonly terminalProof?: ProviderTerminalProof;
  readonly finalText: string;
  readonly usage: SessionUsage;
  readonly stderrTail: string;
  readonly failureHandle?: TransportLocalFailureHandle;
}

export interface TransportLocalFailureHandle {
  readonly opaqueId: string;
}
```

A `TransportLocalFailureHandle` contains no witness bytes; only the originating transport can dereference it, and it must destroy the underlying witness immediately after `classifyFailure()` returns. A clean process exit, resolved SDK promise, or closed stream is not success by itself. Success requires the transport's verified terminal proof and a bounded `finalText`. Only then does the harness invoke `StepSpec.parse()`. Therefore `format_violation` is a **harness cause**, never a result of `ProviderTransport.classifyFailure()`.

---

## 4. Provider events, backpressure, and terminal arbitration

### 4.1 Event schema

```typescript
export interface ProviderEventBase {
  readonly sessionId: string;
  readonly attempt: number;
  readonly seq: number;
  readonly observedAt: string; // RFC 3339 UTC
}

export interface ProviderTerminalProof {
  readonly eventId: string;
  readonly providerStatus: string;
  readonly providerObservedAt: string;
  readonly exitCode?: number;
  readonly signal?: string;
}

export type SessionUsageUpdate = Partial<SessionUsage["tokens"]> & {
  readonly providerReportedTotal?: number;
};

export type ProviderEvent =
  | (ProviderEventBase & { readonly type: "delta"; readonly text: string })
  | (ProviderEventBase & {
      readonly type: "usage";
      readonly mode: "snapshot" | "delta";
      readonly final: boolean;
      readonly usage: SessionUsageUpdate;
    })
  | (ProviderEventBase & {
      readonly type: "diagnostic";
      readonly level: "info" | "warn" | "error";
      readonly message: string;
    })
  | (ProviderEventBase & { readonly type: "heartbeat" })
  | (ProviderEventBase & {
      readonly type: "terminal";
      readonly origin: "provider" | "transport" | "harness";
      readonly proof?: ProviderTerminalProof;
      readonly status: "completed" | "failed" | "cancelled";
      readonly integrity: TransportOutcome["protocolIntegrity"];
    });

export interface AsyncEventSink {
  push(event: ProviderEvent): Promise<"accepted" | "closed">;
  close(): void;
}
```

Every event carries `sessionId`, `attempt`, and a strictly increasing per-attempt `seq`. Duplicate or regressing sequence numbers are protocol violations. Every attempt accepts **exactly one terminal event** through a harness-owned compare-and-set slot. Normally the transport supplies it. When the transport cannot do so before its settlement deadline, the harness supplies one harness-origin terminal with no proof and non-success integrity. A missing provider terminal may instead be closed earlier by a transport-origin terminal marked `truncated`, `malformed`, or `overflow`; neither synthetic path can represent success. Later terminal or data events are rejected, counted, and reported as violations.

### 4.2 Bounded delivery

- The sink is bounded to **256 events or 1 MiB**, whichever comes first.
- A producer must await `push`; there is no fire-and-forget callback.
- Backpressure beyond the transport's declared stall deadline aborts the attempt as `protocol_overflow`.
- Terminal and usage events are never dropped to make room. Diagnostic/heartbeat events may be coalesced; coalescing counters are persisted.
- One delta is limited to 64 KiB, aggregate `finalText` to 1 MiB, redacted stderr tail to 64 KiB, and redacted raw usage to 64 KiB. Exceeding a hard content bound terminates the attempt; content is never silently truncated and parsed.

The write lease gates data-plane events (`delta`, `usage`, `diagnostic`, and `heartbeat`). Invalidating it rejects those events immediately but leaves the terminal compare-and-set slot available to the transport or harness until settlement closes the sink. This keeps late data from mutating state without making cancellation structurally incapable of recording its one terminal outcome.

The first usage event fixes the attempt's aggregation mode. `snapshot` replaces the current provider snapshot; `delta` adds disjoint increments. A later mode change is `protocol_mismatch`.

SDKs that expose both a stream and status polling arbitrate terminal state through one compare-and-set slot. The first **valid provider terminal proof** wins; an EOF, poll timeout, or local abort request cannot win that slot. A conflicting later provider terminal makes the outcome malformed rather than selecting by arrival order. Polling may confirm a matching stream terminal but cannot create a second terminal.

---

## 5. Cancellation, settlement, and late-write fencing

### 5.1 Typed settlement receipt

```typescript
export interface WriteLease {
  readonly id: string;
  readonly valid: boolean;
  invalidate(reason: string): void;
}

export type SettlementOutcome =
  | "completed"
  | "failed"
  | "cancelled_confirmed"
  | "local_fenced_remote_unconfirmed"
  | "local_termination_unconfirmed";

export interface SettlementReceipt {
  readonly sessionId: string;
  readonly attempt: number;
  readonly outcome: SettlementOutcome;
  readonly termination: {
    readonly requested: boolean;
    readonly confirmation:
      | "not_required"
      | "process_group_exited"
      | "sdk_abort_confirmed"
      | "unconfirmed";
    readonly signalCascade?: readonly ("SIGTERM" | "SIGKILL")[];
  };
  readonly resources: {
    readonly localReleased: boolean;
    readonly processGroupAlive: boolean | "unknown" | "not_applicable";
    readonly remoteStatus: "completed" | "cancelled" | "failed" | "unknown_may_continue";
  };
  readonly timestamps: {
    readonly startedAt: string;
    readonly abortRequestedAt?: string;
    readonly leaseInvalidatedAt?: string;
    readonly terminationConfirmedAt?: string;
    readonly settledAt: string;
  };
  readonly lateWriteFence: {
    readonly leaseId: string;
    readonly closed: true;
    readonly rejectedEvents: number;
  };
  readonly warnings: readonly string[];
}

export interface ActiveSession {
  readonly id: string;
  readonly attempt: number;
  readonly controller: AbortController;
  readonly transport: RunnerBackend;
  readonly writeLease: WriteLease;
  readonly cancellationDeadlineMs: number;
  readonly settled: Promise<SettlementReceipt>;
}
```

`settled` always resolves to a receipt; expected cancellation does not reject. Programmer/invariant failures are converted by the harness into `local_termination_unconfirmed` with an internal warning so collection cannot hang.

### 5.2 Transport-specific cancellation deadlines

Deadlines are declared capabilities, not request fields:

| Transport | Required cancellation protocol | Harness deadline |
|---|---|---:|
| CLI/POSIX | verified dedicated process group → `SIGTERM` → 5,000 ms grace → `SIGKILL` → reap bound 2,000 ms | 7,500 ms including scheduler margin |
| SDK | `session.abort()` → provider-specific terminal confirmation up to 5,000 ms → local cleanup up to 1,000 ms | 6,500 ms including scheduler margin |

The CLI transport must prove the child has a dedicated PGID before negative-PGID signaling. If that proof fails, execution fails before launch; it must never risk signaling the host group. A supported Windows transport must place the process in a Job Object and prove close-on-abort behavior before advertising conformance.

### 5.3 Pipeline ceiling and expired grace

On step watchdog, user cancellation, or the global pipeline ceiling, the cancellation coordinator performs this exact sequence:

1. Stop admission of new steps and retries.
2. Invalidate every active write lease; reject subsequent data-plane events while leaving the terminal compare-and-set slot open.
3. Abort each active controller once.
4. Await each session for its own declared cancellation deadline plus 1,000 ms harness margin.
5. If a transport has not supplied a terminal event, atomically accept one harness-origin non-success terminal; any later transport/provider terminal is counted but cannot replace it.
6. If a transport has not produced a receipt, synthesize `local_termination_unconfirmed`, quarantine that transport/rate-limit bucket, and continue shutdown.
7. Close every event sink and persist one atomic partial snapshot from already accepted, redacted state only.

The grace expiry does **not** guarantee that a remote job or un-reaped local process stopped. It guarantees zero capacity for late mutation inside `pr-hero`: invalid lease, closed sink, detached persistence state, no retries, and no new work in the quarantined bucket.

For an SDK abort without provider confirmation, the receipt is `local_fenced_remote_unconfirmed`, `remoteStatus: "unknown_may_continue"`. The harness stops all new steps and retries on that credential/rate bucket, persists partial state with a visible warning, keeps the spend reservation unresolved (§9), and never claims remote execution or cost ended.

`SIGINT` and `SIGTERM` enter the same coordinator. A second signal may force host exit, but the resulting report must state that termination confirmation was interrupted.

---

## 6. Security, credential projection, and untrusted input

### 6.1 Executable and environment projection

Preflight resolves and hashes one absolute executable path. Execution uses that exact path; ambient `PATH` is not used for provider discovery. If a verified helper path is required, the synthetic environment receives a minimal PATH containing only verified directories.

```typescript
export type CredentialKind =
  | "claude_subscription_oauth"
  | "opencode_chatgpt_oauth"
  | "provider_api_token";

export interface CredentialProjection {
  readonly projectionId: string;
  readonly kind: CredentialKind;
  readonly syntheticHome: string;
  readonly syntheticConfigHome: string;
  readonly syntheticTmp: string;
  readonly env: Readonly<Record<string, string>>;
  readonly files: readonly { path: string; mode: 0o600; sha256: string }[];
  destroy(): Promise<void>;
}

export interface CredentialBroker {
  project(input: {
    readonly sessionId: string;
    readonly credentialRef: string;
    readonly kind: CredentialKind;
    readonly verifiedBinaryPath: string;
  }): Promise<CredentialProjection>;
}

export interface IsolationProjection {
  readonly credentialProjectionId: string;
  readonly env: Readonly<Record<string, string>>;
  readonly syntheticHome: string;
  readonly syntheticConfigHome: string;
  readonly syntheticTmp: string;
  readonly verifiedBinaryPath: string;
}
```

The credential broker copies only the minimum credential record into an ephemeral projection. Its env allowlist always sets `HOME=<syntheticHome>`, `XDG_CONFIG_HOME=<syntheticConfigHome>`, and `TMPDIR=<syntheticTmp>`; it may add only the verified helper `PATH` and the route's one credential variable. It never inherits the real `HOME`, ambient `PATH`, or unrelated environment values.

| Route | Source | Projection |
|---|---|---|
| Claude Code local subscription | Claude Code OAuth store or OS keychain | Only the selected subscription OAuth record required by the verified CLI, never the full real `HOME` or config tree |
| OpenCode using ChatGPT Plus | OpenCode/ChatGPT OAuth store | Only the selected OAuth record in ephemeral XDG config; no unrelated OpenCode providers, history, plugins, or settings |
| OpenCode local metered provider | `auth.json[<provider>]`, `type: "api"` | Only that provider's record; no unrelated OpenCode providers |
| CI metered provider | Explicit CI secret | The exact provider token as one allowlisted env value or 0600 file; no inherited CI environment |

Sources must be approved roots or OS keychain entries. Files and every parent are `lstat`-checked, must not be symlinks, and must satisfy ownership/mode policy. Ephemeral directories are 0700; credential files are 0600. Credential values, source paths, and projection contents never enter logs, events, prompts, callbacks, or artifacts. `destroy()` runs after settlement; failure is a blocking security warning.

### 6.2 Workspace and codegraph read policy

OS-level write denial is necessary but insufficient. Every direct workspace read passes through `WorkspaceReadBroker`, which:

1. `lstat`s every path component and rejects symlink traversal.
2. Resolves `realpath` and proves it remains inside the approved workspace root.
3. Rejects sensitive patterns including `.env*`, credentials, private keys, `.git/config`, `.git/credentials`, provider configs, synthetic credential directories, and configured secret paths.
4. Enforces per-file and aggregate byte bounds.
5. Labels returned bytes as untrusted and wraps them with a per-request nonce before prompt inclusion.

Built-in Read/Grep/Glob access is disabled unless it enforces the identical broker contract. Codegraph is read-only, receives the same sensitive-path and symlink rules, and runs from a hashed 0600 MCP config. It cannot be used as a side channel around the workspace broker.

### 6.3 Prompt injection and raw witnesses

Patch text, repository files, tool output, MCP/codegraph output, prior findings, provider diagnostics, and model output are untrusted data. Runtime preambles state that embedded instructions cannot expand tools, paths, credentials, network access, or lifecycle authority. Tool output is nonce-delimited and schema-labelled; a model cannot request arbitrary re-reads outside the broker.

System prompts and MCP configs are 0600, non-symlink files whose hashes are checked immediately before spawn/call. User and system prompt payloads each have a predeclared 2 MiB byte bound; larger steps fail before provider admission. Prompts are sent through stdin or approved SDK fields, never exposed as command-line values. Provider output remains data until terminal verification and harness parsing.

An unredacted failure witness exists only in transport-local memory for classification. It is destroyed after classification. Redaction occurs **before** events, callbacks, logs, persistence, and thrown user-visible errors. Persisted diagnostic fragments are allowlisted, redacted, bounded, and attached only to the attempt that produced them.

---

## 7. Failure causes and retry disposition

Cause answers *what happened*; disposition answers *what the harness may do*. They are separate types.

```typescript
export type TransportFailureCause =
  | "auth_invalid"
  | "quota_exhausted"
  | "rate_limit"
  | "network_transient"
  | "protocol_truncation"
  | "protocol_mismatch"
  | "protocol_overflow"
  | "output_limit_exceeded"
  | "context_window_exceeded"
  | "safety_refusal"
  | "provider_configuration_invalid"
  | "model_unavailable"
  | "runtime_unavailable"
  | "remote_abort_unconfirmed";

export type HarnessFailureCause =
  | "format_violation"
  | "watchdog_timeout"
  | "pipeline_cancelled"
  | "user_cancelled"
  | "settlement_unconfirmed";

export type FailureCause = TransportFailureCause | HarnessFailureCause;

export interface RetryState {
  readonly transientAttemptsUsed: number;
  readonly formatRetriesUsed: number;
}

export type RetryDisposition =
  | { action: "retry_now"; budget: "transient" }
  | { action: "retry_after"; budget: "transient"; delayMs: number }
  | { action: "retry_format_reminder"; budget: "format" }
  | { action: "terminal" };
```

`ProviderTransport.classifyFailure()` can return only `TransportFailureCause`. After verified transport success, `StepSpec.parse()` runs in the harness; a parse failure becomes `format_violation` and consumes the single independent format-retry budget.

| Cause | Default disposition |
|---|---|
| `network_transient`, `protocol_truncation`, `watchdog_timeout` | bounded transient retry |
| `rate_limit` | bounded retry using validated `Retry-After` or capped exponential backoff |
| `format_violation` | one independent format reminder retry |
| `auth_invalid`, `quota_exhausted`, `context_window_exceeded`, `output_limit_exceeded`, `safety_refusal`, invalid config/runtime | terminal |
| `protocol_mismatch`, `protocol_overflow` | terminal and transport conformance failure unless explicitly allowlisted by a versioned adapter fix |
| cancellation or any unconfirmed settlement/remote abort | terminal; no new step or retry on the affected bucket |

Every retry receives a new session/attempt identity, write lease, event sequence, spend reservation, and settlement receipt. Usage and cash from failed attempts remain accounted; a retry never overwrites them.

---

## 8. Usage normalization and inclusion semantics

```typescript
export interface SessionUsage {
  readonly wallMs: number;
  readonly tokens: {
    readonly inputUncached?: number;
    readonly inputCacheRead?: number;
    readonly inputCacheWrite?: number;
    readonly inputOther?: number;
    readonly outputVisible?: number;
    readonly outputReasoning?: number;
    readonly outputOther?: number;
    readonly inputKnown?: number;
    readonly outputKnown?: number;
    readonly totalKnown?: number;
    readonly providerReportedTotal?: number;
  };
  readonly completeness: "complete" | "partial" | "unavailable";
  readonly billingMode: "subscription" | "metered" | "unknown";
  readonly cashCostUsd?: number;
  readonly notionalCostUsd?: number;
  readonly costSource: "provider" | "versioned_rate_table" | "subscription" | "unknown";
  readonly redactedRaw?: unknown;
}
```

Token leaves are disjoint. Inclusion rules are explicit:

- If a provider total **includes** detailed cache/reasoning values, split the total into leaves and store only the non-negative residual in `inputOther`/`outputOther`; never add the detail to the inclusive total.
- Anthropic cache-read and cache-creation map to `inputCacheRead` and `inputCacheWrite`. OpenAI cached prompt tokens map to `inputCacheRead`; reasoning tokens map to `outputReasoning`. Gemini thoughts/reasoning map to `outputReasoning` only when the API identifies them separately.
- If inclusion cannot be proven, keep `providerReportedTotal`, mark `partial`, and do not invent a split.
- Snapshot events replace the latest provider counters; delta events accumulate. The two modes cannot mix in one attempt (§4).
- Cross-provider token comparisons use only complete, semantically comparable leaves. Partial usage remains visible but is excluded from efficiency ranking.

Subscription OAuth may truthfully report `cashCostUsd: 0`; optional catalog cost is `notionalCostUsd` and never mixed with cash. Metered routes require provider cost or a versioned rate-table calculation. If a completed/failed metered attempt has incomplete pricing or usage, the run records unknown cost and fails closed before another paid execution. `billingMode: "unknown"` is a blocking preflight result.

Artifacts and reports show cash and notional totals separately. Budget enforcement uses cash only; research comparisons may use notional only when clearly labelled.

---

## 9. Spend reservations and concurrency

### 9.1 Transactional reservation ledger

```typescript
export interface SpendReservation {
  readonly reservationId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly rateLimitBucketId: string;
  readonly reservedUsd: number;
  readonly state: "reserved" | "settled" | "released_unstarted" | "unresolved_remote";
}

export interface ReserveSpendInput {
  readonly requestId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly rateLimitBucketId: string;
  readonly estimatedUsd: number;
}

export interface SpendLimiter {
  reserve(input: ReserveSpendInput): Promise<SpendReservation>;
  settle(reservationId: string, actualUsd: number, idempotencyKey: string): Promise<void>;
  releaseUnstarted(reservationId: string, idempotencyKey: string): Promise<void>;
  markUnresolvedRemote(reservationId: string, knownUsd: number | undefined, idempotencyKey: string): Promise<void>;
}
```

Reservation transitions use an atomic compare-and-set ledger and idempotency keys. The execution order is:

1. Acquire cancellable concurrency capacity.
2. Reserve spend transactionally.
3. Mark the provider attempt started and execute.
4. Settle actual known cost exactly once.
5. Release a reservation only if the provider attempt provably never started.

Cancellation after provider start does not release the reservation. Confirmed terminal usage settles it; an unconfirmed remote abort marks it `unresolved_remote`, keeps the conservative reserved amount charged, and blocks more paid work in that bucket. A retry cannot start until the prior attempt reaches a terminal reservation state.

### 9.2 Rate-limit bucket identity

Concurrency is not keyed by backend. The route resolver derives a non-secret bucket ID from provider, an HMAC credential fingerprint, account/project scope, and provider rate-limit group:

```text
bucketId = HMAC(localKey, provider | credentialFingerprint | account | project | rateLimitGroup)
```

The limiter enforces global and per-bucket ceilings with abort-aware FIFO queues. A lease is released exactly once in `finally`. `local_fenced_remote_unconfirmed` releases the local execution slot but trips the bucket circuit breaker to zero new capacity until reconciliation or operator reset.

---

## 10. D3 deterministic diversity and adjudication

### 10.1 Schema and provenance

C2 schema v1.1 separates specialty from execution leg. Hunter prompts keep their semantic specialty; model identity belongs to provenance, not to the hunter enum.

```typescript
export interface FindingObservation {
  readonly observationId: string;
  readonly specialty: string;
  readonly legId: string;
  readonly backend: RunnerBackend;
  readonly provider: string;
  readonly gateway?: string;
  readonly modelFamily: string;
  readonly modelSnapshot: string;
  readonly modelVariant?: string;
  readonly replicate: number;
  readonly attempt: number;
  readonly promptFingerprint: string;
  readonly routeFingerprint: string;
  readonly path: string;
  readonly line?: number;
  readonly symbol?: string;
  readonly category: string;
  readonly severity: Severity;
  readonly claim: string;
  readonly evidence: string;
  readonly proofRefs: readonly string[];
  readonly causalHypothesis: string;
  readonly artifactSha256: string;
}
```

This provenance is mandatory in `pipeline.json` and debug artifacts: backend, provider, gateway, family, snapshot, variant, replicate, attempt, leg, and prompt/route fingerprints. Two observations are independent only when both provider and model family differ. A different gateway over the same family is recorded as correlated weights and adds no independence vote.

### 10.2 Candidate matching and cluster algebra

Matching is partitioned by semantic specialty and operates on normalized paths, symbols, proof anchors, and line spans. Cross-specialty systemic relationships remain the responsibility of the later root-cause clusterer; the D3 matcher compares model legs that performed the same work.

| Relation | Deterministic rule |
|---|---|
| `strong_same_defect` | Exact **driver-recomputed** normalized dedupe key, **or** same normalized symbol plus at least one identical canonical proof anchor |
| `ambiguous` | Same symbol and line distance ≤100 without a shared proof anchor, **or** shared proof anchor with absent/conflicting symbol |
| `distinct` | Different path with no shared canonical proof anchor, or no rule above matches |

Canonical proof anchors are versioned hashes of `(path, symbol, normalized code span or control-flow edge)`, not prose similarity. The normalized dedupe key is also recomputed mechanically from canonical anchors and taxonomy; an LLM self-reported `dedupe_key` is evidence only and can never authorize a merge. Line proximity alone can never produce `strong_same_defect`.

The builder is order-independent:

1. Sort observations by `(path, symbol ?? "", line ?? -1, observationId)` and compute every pair relation once.
2. Build an undirected graph from `strong_same_defect` edges.
3. Merge a connected component only when it is a complete graph. A non-complete component—such as A≈B and B≈C while A≉C—produces singleton candidate clusters inside one `AdjudicationGroup`; no transitive merge is permitted.
4. Build a second graph over candidate clusters using explicit `ambiguous` edges. Each connected component becomes an `AdjudicationGroup`, ordered by its smallest observation key. `distinct` edges never group or merge.
5. Derive IDs from the versioned matcher revision plus sorted observation IDs, making input order irrelevant and replay stable.

This is conservative complete-link clustering without greedy insertion. Ambiguous observations are never merged; they retain separate candidates for the refuter.

```typescript
export interface FindingCluster {
  readonly clusterId: string;
  readonly observations: readonly FindingObservation[];
  readonly locationCandidates: readonly { path: string; line?: number; symbol?: string }[];
  readonly causalHypotheses: readonly string[];
  readonly schedulingSeverity: Severity;
  readonly independence: "independent" | "correlated_weights" | "single_source";
}
```

`schedulingSeverity` is the maximum source severity and is used only to decide whether refutation is mandatory. It is not the final severity and cannot be lowered by majority vote. Every severe cluster, and every ambiguous group containing a severe observation, reaches the refuter.

### 10.3 Refuter independence and two-stage output

The route resolver selects a refuter whose **provider and model family are absent** from the hunter group. Eligible routes are ordered by explicit configured priority and then route fingerprint, so selection is replayable. If none is independent, fallback routes are ranked by number of absent dimensions (provider, then family), configured priority, and route fingerprint; the winner is recorded as `correlated_fallback`, grants no confidence boost, and still runs. If no refuter can execute, severe candidates become `inconclusive`, advisory, and make the pipeline partial; they are never auto-corroborated or silently dropped.

Adjudication is code-first and two-stage:

1. **Blind code inspection:** the refuter receives only frozen code locations and proof anchors—no hunter prose, model names, votes, severities, or hypotheses—and returns a hashed `CodeEvidenceReport`.
2. **Anonymous hypothesis adjudication:** the refuter receives the frozen evidence report plus hypotheses labelled `H1`, `H2`, etc. It must echo the evidence hash and return structured outcomes.

```typescript
export interface CodeEvidenceReport {
  readonly inspectedLocations: readonly { path: string; line?: number; symbol?: string }[];
  readonly reachableBehavior: readonly string[];
  readonly proofRefs: readonly string[];
  readonly limitations: readonly string[];
  readonly sha256: string;
}

export interface ClusterAdjudication {
  readonly evidenceReportSha256: string;
  readonly relation: "same_defect" | "distinct_defects" | "no_defect" | "inconclusive";
  readonly hypotheses: readonly {
    id: string;
    outcome: "supported" | "refuted" | "latent" | "inconclusive";
    proofRefs: readonly string[];
  }[];
  readonly canonicalFindings: readonly {
    path: string;
    line?: number;
    symbol?: string;
    severity: Severity;
    category: number;
    evidenceClass: EvidenceClass;
    causalDisposition: CausalDisposition;
    claim: string;
    proofRefs: readonly string[];
    hopsUsed: number;
    hopTrail: HopTrail;
  }[];
}
```

Stage 2 assigns canonical severity, evidence class, and causal disposition from the reachable impact proven in the frozen code evidence, never from source vote count or hunter severity. It must cite proof refs and return the bounded inspection trail used to reach them. Existing deterministic tier derivation still runs after the projected `Finding[]` is validated.

The driver projects each canonical result to the existing `Finding` contract mechanically: it assigns the final `id`; stamps the partition's semantic specialty as `hunter`; maps the structured adjudication fields to `evidence_class`, `causal_disposition`, `claim`, `proof_refs`, `hops_used`, and `hop_trail`; computes `dedupe_key` from the canonical anchor; maps the supported/refuted/latent adjudication to `refuter_verdict`; and derives `tier` with the existing deterministic function. Fields not present in the adjudication cannot be invented from hunter majority. Schema v1.1 carries all observation/cluster provenance in debug artifacts while the published finding remains compatible through the explicit migration in §12.

Projection is deterministic:

| Adjudication | `Finding[]` | Debug/provenance |
|---|---|---|
| `same_defect` with supported hypothesis | One canonical finding | Cluster, all observations, mapping, refuter route/outcome |
| `distinct_defects` | One finding per canonical defect | Original candidate clusters and split mapping |
| `no_defect` | No published finding | Refuted observations and proof retained |
| `inconclusive` | Separate advisory candidates; pipeline partial | Ambiguity and all hypotheses retained |
| Refuter failure/malformed output | Same conservative result as inconclusive | Failure cause, usage, settlement, and route retained |

Published finding IDs are assigned only after adjudication. Observation and cluster IDs are stable debug identifiers. `src/dedupe.ts` remains mechanical within a proven canonical finding; it does not decide causal equivalence from wording.

### 10.4 Experiment, promotion, and rollback

D3 ships behind `multiModelDiversity.enabled`, default `false`. Before any run, the experiment plan freezes:

- target PRs and ground truth source;
- control route and treatment routes;
- `N` targets and `R ≥ 3` replicates per arm;
- prompt, model snapshot, gateway, and route fingerprints;
- interleaved execution order and invalid-run rules;
- numeric quality, latency, cash-cost, and notional-cost thresholds;
- maximum total cash spend and stop conditions.

The ROADMAP live head-to-head remains the primary evaluation. Martian may be an additional explicitly authorized surface, never a substitute or an implicit live run. Ground-truth adjudication is blind to arm.

Primary economics are **cash cost per real finding**: total arm cash divided by unique true-positive defects after adjudication. Notional cost per real finding is reported separately. Duplicate observations, refuted candidates, and retries do not inflate the denominator; all their costs remain in the numerator.

Promotion requires every predeclared threshold, no security/settlement regression, reproducible provenance, and explicit human approval. Roll back/disable immediately for any credential or sensitive-file exposure, late mutation, unconfirmed-settlement rate above the frozen bound, quality regression, cost/latency bound breach, irreconstructible provenance, or unapproved route drift.

---

## 11. Typed preflight and conformance capabilities

```typescript
export interface ProviderCapabilityReport {
  readonly backend: RunnerBackend;
  readonly status: "ready" | "degraded" | "blocking";
  readonly binary?: { absolutePath: string; sha256: string; version: string };
  readonly auth: { kind: CredentialKind; projectionReady: boolean; probe: "passed" | "failed" | "not_run" };
  readonly isolation: { syntheticHome: boolean; workspaceReadBroker: boolean; codegraphPolicy: boolean };
  readonly protocol: { terminalProof: boolean; boundedEvents: boolean; usageMode: "snapshot" | "delta" | "none" };
  readonly cancellation: { deadlineMs: number; conformance: "passed" | "failed" | "not_run" };
  readonly billing: { mode: "subscription" | "metered" | "unknown"; pricingReady: boolean };
  readonly rateLimitBucketId?: string;
  readonly issues: readonly { code: string; message: string; blocking: boolean }[];
}
```

`doctor`, `init`, route selection, and execution consume the same report. A boolean `healthy` is insufficient. Any blocking issue prevents the route from executing. A degraded capability is usable only when the named missing feature is irrelevant to that route and a test proves the fallback.

Conformance deadlines are transport-specific: CLI fixtures allow the 5-second TERM grace plus KILL/reap bound; SDK fixtures use their declared abort-confirmation deadline. There is no impossible global “abort within 3 seconds” rule.

---

## 12. Implementation sequence and traceability

### Phase D1 — shared harness and OpenCode SDK

- **D1-01:** Extract `StepExecutionHarness`; keep parsing, retry, persistence, and timeouts outside transports.
- **D1-02:** Add `TransportRequest`, `ProviderTransport`, `ProviderEvent`, and bounded `AsyncEventSink` contracts.
- **D1-03:** Add typed `ActiveSession`, write lease, cancellation coordinator, and `SettlementReceipt` persistence.
- **D1-04:** Port Claude CLI into `ClaudeCodeCliTransport` with verified binary/PGID, TERM→KILL→reap, and terminal proof.
- **D1-05:** Add credential projection, synthetic environment, workspace read broker, codegraph policy, and redaction boundary.
- **D1-06:** Implement `OpenCodeSdkTransport` with stream/poll arbitration and confirmed/unknown abort semantics.
- **D1-07:** Implement cause/disposition policy, including harness-only format violations.
- **D1-08:** Implement usage normalization, transactional spend reservations, and credential/rate-bucket concurrency.
- **D1-09:** Replace boolean health checks with `ProviderCapabilityReport` in preflight, doctor, and init.
- **D1-10:** Wire pipeline ceiling, partial persistence, attempt provenance, and migration/read-back compatibility.
- **D1-11:** Land all offline conformance tests in §13 before enabling OpenCode.

### Phase D2 — model routing

- Add logical `provider/model#variant` resolution to `AgentSpec` without embedding credentials.
- Apply C5 routing precedence and persist the resolved route fingerprint.
- Allow heterogeneous stages, including an independent refuter route.

### Phase C2 — schema v1.1 prerequisite

- Separate specialty from `legId` and widen provenance/debug schemas.
- Keep byte-compatible readers or an explicit versioned migration.
- Update the lab validator before any D3 artifact is produced.

### Phase D3 — cross-model diversity

- Add feature-flagged N×R fan-out per specialty.
- Implement deterministic matching, complete-link clusters, and ambiguous adjudication groups.
- Implement independent refuter routing and the two-stage blind protocol.
- Project adjudication to `Finding[]` and debug provenance.
- Run the frozen experiment and promote only under §10.4.

### Credential-less free routes — measured behavior and limits (live, 2026-09-03)

OpenCode serves free models (provider `opencode`) that authenticate with nothing.
They resolve to credential kind `provider_free` **only** from live provider-declared
zero cost (`opencode models <provider> --verbose --refresh`: exact id, status
active, all cost leaves `=== 0`). No model list is bundled anywhere — free
identities rotate too fast for that. Any discovery failure keeps the metered
kind (fail closed). A model free at probe time that bills at attempt time is
refused at settlement (`free_nonzero_cost`: fence the bucket, fail the step,
no retry).

Mixing rules, as built (spike #184 ran them, not just reviewed them):

- Mixed **opencode providers** (or free+metered) in one plan are **refused**:
  one server, one credential for its whole life. No silent pick.
- Mixed **backends** (`claude-code` + `opencode`) in one run **execute**: one
  hunter per backend, per-credential buckets, `partial` if either leg fails.

Measured limit, stated so nobody learns it from a dead run: free models are
currently too slow for hunter-size prompts. `muse-spark-1.3` did not finish in
10 minutes a prompt `haiku` does in ~41 s (2 provider events in that window);
the watchdog kill yields `unknown` usage, which fences conservatively and fails
the step. Do not route hunters to free models until throughput is re-measured.

---

## 13. Closure checklist and offline acceptance

Rev 5 is ratifiable only when every applicable box is backed by code and an offline test artifact.

### Transport and lifecycle

- [ ] `TransportRequest` has no timeout, retry, parser, artifact, or budget policy.
- [ ] Transport classification cannot emit `format_violation`; the harness emits it only after `StepSpec.parse()` fails.
- [ ] Every session resolves a typed `SettlementReceipt` with termination/resource/remote status, timestamps, warnings, and a closed late-write fence.
- [ ] CLI tests prove dedicated process-group safety, 5-second TERM grace, KILL escalation, and reap bound.
- [ ] SDK tests distinguish confirmed abort from `unknown_may_continue` without claiming remote cost ended.
- [ ] Pipeline-ceiling tests prove no new steps/retries and exactly one atomic partial snapshot after lease invalidation.

### Events and bounds

- [ ] Every event carries session, attempt, sequence, and timestamp; exactly one terminal is accepted.
- [ ] Backpressure, overflow, snapshot/delta usage, stream/poll races, and all content bounds are tested.
- [ ] Late events cannot mutate artifacts after sink closure, including after the harness settlement grace expires.

### Security and credentials

- [ ] Preflight and execution use the same verified absolute binary.
- [ ] Claude subscription OAuth, OpenCode ChatGPT OAuth, and CI token projections work from synthetic HOME/config without exposing full user config.
- [ ] Credential modes, symlink rejection, destruction, prompt-file hashes, and redaction-before-callback are tested.
- [ ] Direct reads and codegraph enforce the identical sensitive-file, realpath, symlink, and byte-bound policy.
- [ ] Prompt-injection fixtures prove attempted embedded instructions cannot expand capabilities enforced by the workspace, tool, credential, network, or lifecycle boundaries.

### Failure, usage, spend, and concurrency

- [ ] Cause and retry disposition are separate; transient and format budgets cannot consume each other.
- [ ] Anthropic/OpenAI/Gemini cache and reasoning inclusion rules have provider fixtures, including partial/unknown cases.
- [ ] Subscription cash, metered cash, and notional cost remain separate in attempts and rollups.
- [ ] Reservation IDs settle atomically and idempotently; abort-before-start releases, abort-after-start does not.
- [ ] Unknown metered cost and unconfirmed remote abort stop further paid work.
- [ ] Concurrency is enforced by upstream credential/rate-limit bucket, with abort-aware FIFO and circuit breaking.

### D3 algebra and rollout

- [ ] C2 v1.1 lands before D3 and preserves/migrates existing artifacts explicitly.
- [ ] Matching fixtures cover line drift, rewritten causal hypotheses, non-transitive triples, ambiguous groups, and distinct defects at one locus.
- [ ] Maximum source severity schedules refutation but never determines final severity.
- [ ] All provenance dimensions survive cluster-to-finding/debug projection.
- [ ] Refuter selection proves provider+family independence or records correlated fallback without confidence inflation.
- [ ] Blind stage 1 excludes claims/votes; stage 2 is bound to the frozen evidence hash and emits structured outcomes.
- [ ] The feature flag defaults off; N×R plan, thresholds, promotion approval, rollback, and cost-per-real-finding math are frozen before execution.

### Required offline evidence

- [ ] `test/conformance/transport-contract.test.ts`
- [ ] `test/conformance/claude-cli-transport.test.ts`
- [ ] `test/conformance/opencode-sdk-transport.test.ts`
- [ ] `test/harness/event-sink.test.ts`
- [ ] `test/harness/settlement.test.ts`
- [ ] `test/harness/failure-policy.test.ts`
- [ ] `test/security/credential-projection.test.ts`
- [ ] `test/security/workspace-read-policy.test.ts`
- [ ] `test/usage/normalization.test.ts`
- [ ] `test/harness/spend-limiter.test.ts`
- [ ] `test/harness/concurrency-limiter.test.ts`
- [ ] `test/diversity/multi-model-clustering.test.ts`
- [ ] `test/diversity/refuter-adjudication.test.ts`
- [ ] `test/schema/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `./node_modules/.bin/biome check src test`

Until this checklist passes, the current implementation remains authoritative and this document describes a future contract. No unimplemented transport, provider, settlement guarantee, security boundary, or D3 result may be advertised as production behavior.
