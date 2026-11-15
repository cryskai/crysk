import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  AntigravityFailureCredential,
  AsyncEventSink,
  ProviderCapabilityReport,
  ProviderTerminalProof,
  ProviderTransport,
  ResolvedModelRoute,
  TransportFailureCause,
  TransportOutcome,
  TransportRequest,
} from "../execution/contracts";
import { ACTIVE_CHILD_PROCS } from "../execution/spawned-process";
import {
  type NormalizedUsage,
  normalizeUnavailableUsage,
} from "../execution/usage-normalized";
import {
  type CascadeResult,
  type CliProc,
  isSpawnFailureTail,
  KILL_REAP_MS,
  oneLine,
  runProcessGroupCascade,
  spawnFailureTail,
  systemGetPgid,
  TERM_GRACE_MS,
} from "./claude-code-cli";
import {
  hashPromptFile,
  type PromptFileStatus,
  systemPromptStatus,
  verifyPromptIntegrity,
} from "./prompt-integrity";

// ---------------------------------------------------------------------------
// odd/tasks/antigravity-oauth.md T4 (E4, S5, S6): Google Antigravity's `agy`
// CLI as a review backend, on the Google subscription login AgyCredentialBroker
// projects into a per-step home (credential-broker.ts).
//
// What agy 1.5.7 does that shapes this file (measured, Log L3-L8):
//  - `-p` takes the prompt as its VALUE, so the prompt goes on stdin with no
//    `-p` at all; `--effort` conflicts with an effort-bearing model id, and the
//    effort is part of the id (`gemini-4-argon-high`), so it is never sent.
//  - A custom agent (`--agent crysk-step`, read from
//    `$HOME/.gemini/config/agents/crysk-step.md`) with `inheritCustomizations:
//    false` sees none of the repository's AGENTS.md, GEMINI.md or `.agents/`.
//    Its `tools:` list restricts the tool schema; listing `view_file` beside
//    `read_file` aborts on a name conflict. `#`/`##` headings in the body do
//    not truncate it.
//  - `--settings` deny rules bind: `write_file(*)`, `command(*)` and the URL
//    grants are refused even under `toolPermission: always-proceed`. That deny
//    list, not the tool schema, is the hard guarantee.
//  - stream-json: one `step_update` per tool step (`step_type: "tool"`,
//    `state` ACTIVE then DONE), then `{"event":"result","result":{...}}` with
//    `status` SUCCESS/ERROR, `response`, `usage`, `finished_reason` and
//    `error`. `num_turns` counts user turns and is always 1, so tools are
//    counted from the DONE tool steps.
//  - Exit codes: 3 for a model or agent error and a print timeout (with an
//    `AGY_ERROR: {...}` line on stderr), 1 for a failed login or an unknown
//    agent, 2 for a flag error.
// ---------------------------------------------------------------------------

export const AGY_AGENT_NAME = "crysk-step";

const AGY_SECRET: AntigravityFailureCredential = "CRYSK_ANTIGRAVITY_OAUTH";

// Stream-json carries every step's text; a review step's whole run fits far
// below this. Past it the child is stopped and the attempt is an overflow.
const DEFAULT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;
// stderr is a diagnostics channel; its tail holds the AGY_ERROR line.
const STDERR_KEEP_BYTES = 64 * 1024;
const STDERR_TAIL = 4096;
const FAILURE_DETAIL_MAX = 160;

// The projection ids the harness uses when no per-step projection exists
// (harness.ts, production-runtime.ts): the operator's own HOME, a transport
// that declared server-lifetime, or a binding's placeholder. An agy step on
// any of them would read the operator's Google login and agy settings.
const NOT_A_PROJECTION = new Set([
  "operator-env-fallback",
  "server-lifetime",
  "production-binding",
]);

// Crysk's tool names mapped to agy's. Only `read_file` exists for an agy step
// today; Grep/Glob arrive with Crysk's read-only search MCP (T4b), and
// codegraph is never used for agy (L7, L10).
const AGY_TOOL_OF: Readonly<Record<string, string>> = { Read: "read_file" };

export function agyAgentFile(
  tools: readonly string[],
  systemPrompt: string,
): string {
  const mapped = agyTools(tools);
  // Never an empty list: agy tags `tools` omitempty, so `[]` behaves like no
  // list and brings agy's default set (send_message, search_web, ...; L8). A
  // step with no agy tool lists read_file and agySettings denies it.
  return [
    "---",
    `name: ${AGY_AGENT_NAME}`,
    "description: Crysk review step, read-only",
    "inheritCustomizations: false",
    "inheritMcp: false",
    "subagent: false",
    `tools: [${(mapped.length === 0 ? ["read_file"] : mapped).join(", ")}]`,
    "---",
    "# Crysk step",
    "",
    systemPrompt,
  ].join("\n");
}

export interface AgySettings {
  readonly toolPermission: "always-proceed";
  readonly trustedWorkspaces: readonly string[];
  readonly allowNonWorkspaceAccess: false;
  readonly disableSlashCommands: true;
  readonly permissions: {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
  };
}

function agyTools(tools: readonly string[]): string[] {
  return [
    ...new Set(
      tools.flatMap((tool) => {
        const name = AGY_TOOL_OF[tool];
        return name === undefined ? [] : [name];
      }),
    ),
  ];
}

// Denied on every step: writes, shell, URLs (proven to bind, L6/L8) and the
// tools agy gives an agent by default (L8), a second layer behind `tools:`.
const AGY_DENIED_GRANTS = [
  "write_file(*)",
  "command(*)",
  "read_url(*)",
  "execute_url(*)",
  "download_url(*)",
  "search_web(*)",
  "send_message(*)",
  "schedule(*)",
  "generate_image(*)",
] as const;

// No `enableTerminalSandbox`: shell is denied outright (L8, L9). A step with
// no agy tool gets read_file denied too, since its agent file lists read_file
// rather than an empty list.
export function agySettings(
  cwd: string,
  tools: readonly string[],
): AgySettings {
  const reads = agyTools(tools).includes("read_file");
  return {
    toolPermission: "always-proceed",
    trustedWorkspaces: [cwd],
    allowNonWorkspaceAccess: false,
    disableSlashCommands: true,
    permissions: {
      allow: reads ? ["read_file(*)"] : [],
      deny: reads
        ? [...AGY_DENIED_GRANTS]
        : [...AGY_DENIED_GRANTS, "read_file(*)"],
    },
  };
}

function agentFilePath(home: string): string {
  return path.join(home, ".gemini", "config", "agents", `${AGY_AGENT_NAME}.md`);
}

function settingsFilePath(home: string): string {
  return path.join(
    home,
    ".gemini",
    "config",
    `${AGY_AGENT_NAME}-settings.json`,
  );
}

// Google credentials agy would use INSTEAD of the projected subscription login
// (a Gemini API key bills per token while the attempt is filed at $0), so
// none reaches the child whatever env the caller built.
const NOT_FOR_AGY = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
];

function agyChildEnv(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const child: Record<string, string> = { ...env };
  for (const key of NOT_FOR_AGY) delete child[key];
  // L3: agy honours `true`, not `1`; a step never updates the verified binary.
  child.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return child;
}

function agyArgv(
  binaryPath: string,
  route: ResolvedModelRoute,
  settingsPath: string,
): string[] {
  return [
    binaryPath,
    "--output-format",
    "stream-json",
    "--model",
    route.modelSnapshot,
    "--agent",
    AGY_AGENT_NAME,
    "--settings",
    settingsPath,
    "--disable-slash-commands",
  ];
}

// A refusal before spawn reached no provider: a genuine zero on the
// subscription basis this transport always files under.
function noSpawnUsage(wallMs: number): NormalizedUsage {
  return {
    wallMs,
    tokens: {},
    completeness: "complete",
    billingMode: "subscription",
    costSource: "subscription",
    cashCostUsd: 0,
  };
}

function denied(start: number, reason: string): TransportOutcome {
  return {
    completion: "failed",
    protocolIntegrity: "unverified",
    finalText: "",
    usage: noSpawnUsage(Math.round(performance.now() - start)),
    stderrTail: `[crysk] agy step refused: ${reason}; no spawn`,
  };
}

// The projected home must be the step's own: never the operator's HOME, and
// never a tree a symlink could point elsewhere. Writes nothing.
function projectionProblem(request: TransportRequest): string | undefined {
  const { isolation } = request;
  if (
    NOT_A_PROJECTION.has(isolation.credentialProjectionId) ||
    isolation.syntheticHome === "" ||
    !path.isAbsolute(isolation.syntheticHome)
  ) {
    return "no per-step credential projection (an agy step never runs on the operator's environment)";
  }
  if (isolation.env.HOME !== isolation.syntheticHome) {
    return "the projected home is not the child's HOME";
  }
  return undefined;
}

// Creates the config tree at 0700 when missing and refuses any symlink in it.
function guardConfigTree(home: string): string | undefined {
  const chain = [
    home,
    path.join(home, ".gemini"),
    path.join(home, ".gemini", "config"),
    path.join(home, ".gemini", "config", "agents"),
  ];
  for (const dir of chain) {
    let isLink: boolean;
    try {
      isLink = lstatSync(dir).isSymbolicLink();
    } catch {
      try {
        mkdirSync(dir, { mode: 0o700 });
      } catch {
        return `cannot create ${dir}`;
      }
      isLink = lstatSync(dir).isSymbolicLink();
    }
    if (isLink) return `${dir} is a symlink`;
  }
  return undefined;
}

// A fresh 0600 file: a regular file left by an earlier attempt is replaced, a
// symlink is refused, and `wx` refuses anything that appears in between.
function writeOwnFile(file: string, content: string): string | undefined {
  try {
    const existing = lstatSync(file);
    if (existing.isSymbolicLink()) return `${file} is a symlink`;
    unlinkSync(file);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      return `cannot replace ${file}`;
    }
  }
  try {
    writeFileSync(file, content, { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
  } catch {
    return `cannot write ${file}`;
  }
  return undefined;
}

// --- stream-json -----------------------------------------------------------

interface AgyResult {
  readonly status?: unknown;
  readonly response?: unknown;
  readonly error?: unknown;
  readonly finished_reason?: unknown;
  readonly usage?: {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
    readonly thinking_tokens?: unknown;
    readonly cache_read_tokens?: unknown;
    readonly total_tokens?: unknown;
  };
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A step field read at the event's top level or one object down: the Log
// records the fields, not their nesting.
function stepField(event: JsonObject, key: string): unknown {
  if (Object.hasOwn(event, key)) return event[key];
  for (const value of Object.values(event)) {
    if (isObject(value) && Object.hasOwn(value, key)) return value[key];
  }
  return undefined;
}

class StreamState {
  result: AgyResult | undefined;
  private doneTools = 0;
  private readonly doneToolIds = new Set<string>();
  // A step_update whose step_type or state is nowhere it looks: its tool
  // calls cannot be counted, so the count is unknown rather than short.
  private unreadableSteps = false;

  consume(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isObject(event)) return;
    const kind = event.event ?? event.type;
    if (kind === "result") {
      if (isObject(event.result)) this.result = event.result as AgyResult;
      return;
    }
    if (kind !== "step_update") return;
    const stepType = stepField(event, "step_type");
    const stepState = stepField(event, "state");
    if (typeof stepType !== "string" || typeof stepState !== "string") {
      this.unreadableSteps = true;
      return;
    }
    if (stepType !== "tool" || stepState !== "DONE") return;
    // agy 1.5.7 numbers steps with `step_index` (L6); `step_id` is kept for
    // other shapes. A step reported DONE twice is one tool call.
    const id = stepField(event, "step_index") ?? stepField(event, "step_id");
    if (typeof id === "string" || typeof id === "number") {
      if (this.doneToolIds.has(String(id))) return;
      this.doneToolIds.add(String(id));
    }
    this.doneTools++;
  }

  // Undefined, never 0, when no result arrived (nothing says the run ended)
  // or a step could not be read (a 0 would fail a real hunt as vacuous).
  toolInvocations(): number | undefined {
    return this.result === undefined || this.unreadableSteps
      ? undefined
      : this.doneTools;
  }
}

// Reads a stream line by line into `onLine`, holding only the current line.
// Past `maxBytes` it stops parsing, calls `onOverflow` once, and drains.
async function readLines(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLine: (line: string) => void,
  onOverflow: () => void,
): Promise<{ readonly bytes: number; readonly overflow: boolean }> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let pending = "";
  let bytes = 0;
  let overflow = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (overflow) continue;
    if (bytes > maxBytes) {
      overflow = true;
      pending = "";
      onOverflow();
      continue;
    }
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      onLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  if (!overflow) {
    pending += decoder.decode();
    if (pending !== "") onLine(pending);
  }
  return { bytes, overflow };
}

async function readTail(
  stream: ReadableStream<Uint8Array>,
  keepBytes: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > keepBytes * 2) text = text.slice(-keepBytes);
  }
  text += decoder.decode();
  return text.slice(-keepBytes);
}

async function boundedValue<T>(
  pending: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  const value = await Promise.race([pending, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return value;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

// §8 leaves from agy's usage: `input_tokens` includes the cache reads, so the
// uncached leaf is the remainder; `thinking_tokens` is reasoning output beside
// the visible `output_tokens`. A subscription charges nothing per token.
export function normalizeAgyUsage(
  result: AgyResult | undefined,
  wallMs: number,
): NormalizedUsage {
  const raw = result?.usage;
  const input = count(raw?.input_tokens);
  const output = count(raw?.output_tokens);
  if (raw === undefined || input === undefined || output === undefined) {
    return normalizeUnavailableUsage({ wallMs, billingMode: "subscription" });
  }
  const cacheRead = count(raw.cache_read_tokens) ?? 0;
  const thinking = count(raw.thinking_tokens) ?? 0;
  const inputUncached = Math.max(0, input - cacheRead);
  const inputKnown = inputUncached + cacheRead;
  const outputKnown = output + thinking;
  return {
    wallMs,
    tokens: {
      inputUncached,
      inputCacheRead: cacheRead,
      outputVisible: output,
      outputReasoning: thinking,
      inputKnown,
      outputKnown,
      totalKnown: inputKnown + outputKnown,
      providerReportedTotal:
        count(raw.total_tokens) ?? inputKnown + outputKnown,
    },
    completeness: "complete",
    billingMode: "subscription",
    costSource: "subscription",
    cashCostUsd: 0,
  };
}

// --- failures ----------------------------------------------------------------

interface AgyErrorLine {
  readonly raw: string;
  readonly status?: string;
  readonly code?: number;
  readonly retryable?: boolean;
  readonly message?: string;
}

const AGY_ERROR_PREFIX = "AGY_ERROR:";

// The last `AGY_ERROR: {...}` line on stderr. Its field names are read
// tolerantly (the binary names `short_error`, `retryable`, `error_id`); the
// canonical tokens on the line are the fallback.
function agyErrorOf(stderr: string): AgyErrorLine | undefined {
  const lines = stderr
    .split("\n")
    .filter((line) => line.includes(AGY_ERROR_PREFIX));
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const raw = last
    .slice(last.indexOf(AGY_ERROR_PREFIX) + AGY_ERROR_PREFIX.length)
    .trim();
  let parsed: JsonObject = {};
  try {
    const value: unknown = JSON.parse(raw);
    if (isObject(value)) parsed = value;
  } catch {
    // The canonical tokens on the raw line still classify it.
  }
  const text = (key: string): string | undefined => {
    const value = parsed[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };
  const numberOf = (key: string): number | undefined => {
    const value = parsed[key];
    return typeof value === "number" && Number.isInteger(value)
      ? value
      : undefined;
  };
  return {
    raw,
    status: text("status") ?? text("canonical_status"),
    code:
      numberOf("code") ??
      numberOf("http_status") ??
      numberOf("status_code") ??
      numberOf("grpc_code"),
    retryable:
      typeof parsed.retryable === "boolean" ? parsed.retryable : undefined,
    message: text("short_error") ?? text("message") ?? text("error"),
  };
}

const AUTH_WITNESS =
  /UNAUTHENTICATED|invalid_grant|invalid_rapt|authentication (?:failed|required)|not logged in/i;
const LIMIT_WITNESS =
  /RESOURCE_EXHAUSTED|\b429\b|quota|too many requests|rate.?limit/i;
const QUOTA_WITNESS = /quota|credits?/i;
const TRANSIENT_WITNESS =
  /\bUNAVAILABLE\b|DEADLINE_EXCEEDED|\bINTERNAL\b|\b50[0-4]\b|ECONNRESET|connection reset|overloaded|temporarily|try again|service unavailable/i;

function causeOfAgyError(error: AgyErrorLine): TransportFailureCause {
  const status = (error.status ?? "").toUpperCase();
  const words = `${status} ${error.message ?? ""} ${error.raw}`;
  if (
    status === "UNAUTHENTICATED" ||
    status === "PERMISSION_DENIED" ||
    error.code === 401 ||
    error.code === 403 ||
    AUTH_WITNESS.test(words)
  ) {
    return "auth_invalid";
  }
  if (
    status === "RESOURCE_EXHAUSTED" ||
    error.code === 429 ||
    LIMIT_WITNESS.test(words)
  ) {
    return error.retryable === false || QUOTA_WITNESS.test(error.message ?? "")
      ? "quota_exhausted"
      : "rate_limit";
  }
  if (status === "NOT_FOUND" || error.code === 404) return "model_unavailable";
  if (
    status === "UNAVAILABLE" ||
    status === "DEADLINE_EXCEEDED" ||
    status === "INTERNAL" ||
    (error.code !== undefined && error.code >= 500 && error.code < 600) ||
    TRANSIENT_WITNESS.test(words)
  ) {
    return "network_transient";
  }
  if (error.retryable === true) return "network_transient";
  return "provider_configuration_invalid";
}

interface AgyFailure {
  readonly cause: TransportFailureCause;
  readonly detail: string;
}

function firstErrorLine(stderr: string): string | undefined {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.includes(AGY_ERROR_PREFIX));
}

function detailOf(words: string, suffix = ""): string {
  const prefix = "Antigravity: ";
  return `${prefix}${oneLine(words, FAILURE_DETAIL_MAX - prefix.length - suffix.length)}${suffix}`;
}

// The typed cause of a failed run, from what agy itself reported: the
// AGY_ERROR line, the result's `error` and `finished_reason`, the exit code
// and stderr. Never from `response`, which is the model's prose and can talk
// about rate limits and timeouts as its subject.
export function agyFailure(input: {
  readonly exitCode: number | undefined;
  readonly result: AgyResult | undefined;
  readonly stderr: string;
}): AgyFailure | undefined {
  const { exitCode, result, stderr } = input;
  const agyError = agyErrorOf(stderr);
  const resultError =
    typeof result?.error === "string" && result.error.trim() !== ""
      ? result.error
      : undefined;
  // A print timeout first: agy reports it with an AGY_ERROR line too, whose
  // text matches no other cause and would end the step instead of retrying.
  if (
    result?.finished_reason === "print_timeout" ||
    /\[agy\] print timeout/.test(stderr) ||
    /print timeout/i.test(agyError?.message ?? "")
  ) {
    return {
      cause: "network_transient",
      detail: detailOf("the turn was cut short by its print timeout"),
    };
  }
  if (agyError !== undefined) {
    const label = [agyError.status, agyError.code].filter(
      (part) => part !== undefined,
    );
    return {
      cause: causeOfAgyError(agyError),
      detail: detailOf(
        agyError.message ??
          resultError ??
          agyError.status ??
          "model or agent error",
        label.length === 0 ? "" : ` (${label.join(" ")})`,
      ),
    };
  }
  // Login before timeout: agy's own failed-login text is "authentication
  // failed or timed out", and its "timed out" is not a network failure.
  const own = `${resultError ?? ""}\n${stderr}`;
  if (AUTH_WITNESS.test(own)) {
    return {
      cause: "auth_invalid",
      detail: detailOf(
        resultError ?? firstErrorLine(stderr) ?? "not signed in",
      ),
    };
  }
  if (LIMIT_WITNESS.test(own)) {
    return {
      cause: QUOTA_WITNESS.test(own) ? "quota_exhausted" : "rate_limit",
      detail: detailOf(resultError ?? firstErrorLine(stderr) ?? "rate limited"),
    };
  }
  if (exitCode === 2) {
    return {
      cause: "provider_configuration_invalid",
      detail: detailOf(firstErrorLine(stderr) ?? "agy refused its flags"),
    };
  }
  if (exitCode === 1 && /unknown agent|agent .*not found/i.test(stderr)) {
    return {
      cause: "provider_configuration_invalid",
      detail: detailOf(firstErrorLine(stderr) ?? "unknown agent"),
    };
  }
  return undefined;
}

// A failed run agy explained in no way agyFailure names. Never left to the
// legacy classifier, whose format retry would re-send the prompt for a failure
// no reminder can fix: no result event at all is a truncated stream (retried
// as transient); anything else is terminal, quoting agy's own words.
function unnamedFailure(
  exitCode: number | undefined,
  result: AgyResult | undefined,
): AgyFailure {
  const exit = exitCode === undefined ? "no exit code" : `exit ${exitCode}`;
  if (result === undefined) {
    return {
      cause: "protocol_truncation",
      detail: detailOf(`the run ended without a result event (${exit})`),
    };
  }
  const status = typeof result.status === "string" ? result.status : undefined;
  const reason =
    typeof result.finished_reason === "string"
      ? result.finished_reason
      : undefined;
  const words =
    typeof result.error === "string" && result.error.trim() !== ""
      ? result.error
      : typeof result.response === "string" && result.response !== ""
        ? "the run did not finish cleanly"
        : "the result carried no response";
  const label = [status, reason, exit].filter(
    (part): part is string => part !== undefined,
  );
  return {
    cause: "provider_configuration_invalid",
    detail: detailOf(words, ` (${label.join(", ")})`),
  };
}

function credentialFor(
  cause: TransportFailureCause,
): AntigravityFailureCredential | undefined {
  return cause === "auth_invalid" ||
    cause === "quota_exhausted" ||
    cause === "rate_limit"
    ? AGY_SECRET
    : undefined;
}

// --- transport ---------------------------------------------------------------

export interface AgyCliTransportOptions {
  readonly spawnFn?: typeof Bun.spawn;
  readonly getPgid?: (pid: number) => number | undefined;
  readonly killFn?: (pid: number, signal?: string | number) => unknown;
  readonly termGraceMs?: number;
  readonly killReapMs?: number;
  readonly maxStdoutBytes?: number;
  readonly promptLstatFn?: (path: string) => PromptFileStatus | undefined;
  readonly promptHashFn?: (path: string) => string | Promise<string>;
  // The agy the binding authority resolved, for evidence only: the child is
  // spawned from `request.isolation.verifiedBinaryPath`, the harness-verified
  // copy, never from this path.
  readonly configuredBinaryPath?: string;
}

export class AgyCliTransport implements ProviderTransport {
  readonly backend = "antigravity";
  readonly billingMode = "subscription" as const;
  readonly cancellationSemantics = "process-exit" as const;
  // S5: every attempt runs inside the step's projected home.
  readonly credentialProjection = "per-step" as const;
  // `provider` equals the route's (`route.provider`, model-name.ts): the
  // harness refuses a step whose route names another provider.
  readonly admissionIdentity = {
    executable: "agy",
    provider: "google",
  } as const;
  readonly configuredBinaryPath?: string;
  private readonly spawnFn: typeof Bun.spawn;
  private readonly getPgid: (pid: number) => number | undefined;
  private readonly killFn: (pid: number, signal?: string | number) => unknown;
  private readonly termGraceMs: number;
  private readonly killReapMs: number;
  private readonly maxStdoutBytes: number;
  private readonly promptLstatFn: (
    path: string,
  ) => PromptFileStatus | undefined;
  private readonly promptHashFn: (path: string) => string | Promise<string>;

  constructor(options: AgyCliTransportOptions = {}) {
    this.spawnFn = options.spawnFn ?? Bun.spawn;
    this.getPgid = options.getPgid ?? systemGetPgid;
    this.killFn = options.killFn ?? process.kill;
    this.termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
    this.killReapMs = options.killReapMs ?? KILL_REAP_MS;
    this.maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    this.promptLstatFn = options.promptLstatFn ?? systemPromptStatus;
    this.promptHashFn = options.promptHashFn ?? hashPromptFile;
    this.configuredBinaryPath = options.configuredBinaryPath;
  }

  // Static: built before any route resolves and without running agy, so a
  // plan that never names an agy model pays nothing for it.
  async capabilities(): Promise<ProviderCapabilityReport> {
    return {
      backend: "antigravity",
      status: "degraded",
      auth: {
        kind: "antigravity_subscription_oauth",
        projectionReady: true,
        probe: "not_run",
      },
      isolation: {
        syntheticHome: true,
        workspaceReadBroker: false,
        codegraphPolicy: false,
      },
      protocol: {
        terminalProof: true,
        boundedEvents: false,
        usageMode: "snapshot",
      },
      cancellation: { deadlineMs: 7500, conformance: "not_run" },
      // A subscription: every attempt's cash cost is a truthful 0.
      billing: { mode: "subscription", pricingReady: true },
      issues: [
        {
          code: "bounded_events_sink_missing",
          message:
            "agy's stream-json events are read for the tool count and the final result, not pushed to the event sink; usage arrives as a final snapshot",
          blocking: false,
        },
        {
          code: "agy_search_tools_unavailable",
          message:
            "agy steps read files with read_file only; Grep and Glob arrive with Crysk's read-only search MCP",
          blocking: false,
        },
      ],
    };
  }

  async execute(
    request: TransportRequest,
    context: {
      readonly signal: AbortSignal;
      readonly events?: AsyncEventSink;
    },
  ): Promise<TransportOutcome> {
    const start = performance.now();

    if (request.route.backend !== "antigravity") {
      return denied(
        start,
        `${request.route.backend} is not an antigravity route`,
      );
    }
    const projectionDenial = projectionProblem(request);
    if (projectionDenial !== undefined) return denied(start, projectionDenial);

    const promptDenial = await verifyPromptIntegrity(request, {
      lstat: this.promptLstatFn,
      hash: this.promptHashFn,
    });
    if (promptDenial !== undefined) {
      return denied(start, `prompt integrity denied: ${promptDenial}`);
    }
    // The prompt's bytes are copied into the agent file, so the copied bytes
    // themselves are the ones checked against the request's hash.
    let systemPrompt: string;
    try {
      const bytes = readFileSync(request.systemPromptPath);
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        request.systemPromptSha256
      ) {
        return denied(
          start,
          "prompt integrity denied: system prompt hash mismatch against request.systemPromptSha256",
        );
      }
      systemPrompt = bytes.toString("utf8");
    } catch {
      return denied(
        start,
        `prompt integrity denied: system prompt unreadable: ${request.systemPromptPath}`,
      );
    }

    const home = request.isolation.syntheticHome;
    const treeDenial = guardConfigTree(home);
    if (treeDenial !== undefined) return denied(start, treeDenial);
    const settingsPath = settingsFilePath(home);
    const writeDenial =
      writeOwnFile(
        agentFilePath(home),
        agyAgentFile(request.tools, systemPrompt),
      ) ??
      writeOwnFile(
        settingsPath,
        `${JSON.stringify(agySettings(request.cwd, request.tools), null, 2)}\n`,
      );
    if (writeDenial !== undefined) return denied(start, writeDenial);

    const args = agyArgv(
      request.isolation.verifiedBinaryPath,
      request.route,
      settingsPath,
    );

    // detached: the child leads its own process group, the precondition for
    // the negative-PGID cascade (claude-code-cli.ts §5.2). The prompt goes on
    // stdin, never argv: it embeds the whole patch (#314).
    let proc: CliProc;
    try {
      proc = this.spawnFn(args, {
        cwd: request.cwd,
        env: agyChildEnv(request.isolation.env),
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
        usage: noSpawnUsage(Math.round(performance.now() - start)),
        stderrTail: spawnFailureTail(error),
      };
    }

    ACTIVE_CHILD_PROCS.add(proc);
    let cascadePromise: Promise<CascadeResult> | undefined;
    let provenPgid: number | undefined;
    let notifyCascadeStart: (value: "cascade") => void = () => {};
    const cascadeStarted = new Promise<"cascade">((resolve) => {
      notifyCascadeStart = resolve;
    });
    const startCascade = () => {
      if (cascadePromise) return;
      cascadePromise = runProcessGroupCascade(proc, provenPgid, {
        killFn: this.killFn,
        termGraceMs: this.termGraceMs,
        killReapMs: this.killReapMs,
      });
      notifyCascadeStart("cascade");
    };
    const onAbort = () => startCascade();

    try {
      const rawPid = (proc as { pid?: unknown }).pid;
      const kernelPid =
        typeof rawPid === "number" && Number.isInteger(rawPid) && rawPid > 1
          ? rawPid
          : undefined;
      if (kernelPid !== undefined) {
        const pgid = this.getPgid(kernelPid);
        if (pgid === undefined || pgid !== kernelPid) {
          return {
            completion: "failed",
            protocolIntegrity: "unverified",
            finalText: "",
            usage: noSpawnUsage(Math.round(performance.now() - start)),
            stderrTail:
              pgid === undefined
                ? `[crysk] PGID proof failed: could not read pgid for pid ${kernelPid}; no signal sent`
                : `[crysk] PGID proof failed: pid ${kernelPid} has pgid ${pgid}, expected ${kernelPid}; no signal sent`,
          };
        }
        provenPgid = pgid;
      }

      const state = new StreamState();
      const stdoutPending = readLines(
        proc.stdout as ReadableStream<Uint8Array>,
        this.maxStdoutBytes,
        (line) => state.consume(line),
        startCascade,
      );
      const stderrPending = readTail(
        proc.stderr as ReadableStream<Uint8Array>,
        STDERR_KEEP_BYTES,
      );

      if (context.signal.aborted) {
        onAbort();
      } else {
        context.signal.addEventListener("abort", onAbort, { once: true });
      }

      const natural = Promise.all([stdoutPending, stderrPending, proc.exited]);
      const route = await Promise.race([
        natural.then((): "natural" => "natural"),
        cascadeStarted,
      ]);

      let exitCode: number | undefined;
      let stdoutRead = { bytes: 0, overflow: false };
      let stderr = "";
      let unreaped = false;
      let escalatedToKill = false;
      if (route === "natural") {
        [stdoutRead, stderr, exitCode] = await natural;
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
        if (cascade.kind === "kill_unreaped") {
          unreaped = true;
          // The group survived SIGKILL past the reap bound: take what landed.
          stdoutRead = (await boundedValue(stdoutPending, this.killReapMs)) ?? {
            bytes: 0,
            overflow: false,
          };
          stderr = (await boundedValue(stderrPending, this.killReapMs)) ?? "";
        } else {
          [stdoutRead, stderr, exitCode] = await natural;
        }
      }

      const wallMs = Math.round(performance.now() - start);
      const result = state.result;
      const overflow = stdoutRead.overflow;

      let stderrTail = stderr.slice(-STDERR_TAIL);
      if (unreaped) {
        stderrTail =
          `${stderrTail}\n[crysk] child process group -${provenPgid ?? "(unproven)"} was not reaped within ${this.killReapMs}ms after SIGKILL`.slice(
            -STDERR_TAIL,
          );
      }

      const terminalProof: ProviderTerminalProof | undefined =
        exitCode === undefined
          ? undefined
          : {
              eventId: `${request.sessionId}-${request.attempt}-terminal`,
              providerStatus:
                typeof result?.status === "string"
                  ? result.status
                  : exitCode === 0
                    ? "completed"
                    : "failed",
              providerObservedAt: new Date().toISOString(),
              exitCode,
              ...(escalatedToKill ? { signal: "SIGKILL" } : {}),
            };

      const isCancelled = context.signal.aborted;
      const response =
        typeof result?.response === "string" ? result.response : "";
      const answered =
        !overflow &&
        !unreaped &&
        exitCode === 0 &&
        terminalProof !== undefined &&
        result?.status === "SUCCESS" &&
        result.finished_reason === undefined &&
        response !== "";
      const failure =
        isCancelled || answered
          ? undefined
          : overflow
            ? {
                cause: "protocol_overflow" as const,
                detail: detailOf(
                  `stdout passed ${this.maxStdoutBytes} bytes; the child was stopped`,
                ),
              }
            : (agyFailure({ exitCode, result, stderr }) ??
              unnamedFailure(exitCode, result));
      if (failure !== undefined) {
        stderrTail = `${stderrTail}\n[crysk] ${failure.detail}`.slice(
          -STDERR_TAIL,
        );
      }
      const failureCredential =
        failure === undefined ? undefined : credentialFor(failure.cause);
      const toolInvocations = state.toolInvocations();

      return {
        completion: isCancelled ? "cancelled" : answered ? "success" : "failed",
        protocolIntegrity: overflow
          ? "overflow"
          : unreaped || terminalProof === undefined
            ? "unverified"
            : result === undefined
              ? "truncated"
              : "verified",
        ...(terminalProof === undefined ? {} : { terminalProof }),
        ...(failure === undefined
          ? {}
          : {
              failureCause: failure.cause,
              failureDetail: failure.detail,
              ...(failureCredential === undefined ? {} : { failureCredential }),
            }),
        // A partial response (an ERROR status, a print timeout) is never
        // handed to the draft parser.
        finalText: answered ? response : "",
        usage: overflow
          ? normalizeUnavailableUsage({ wallMs, billingMode: "subscription" })
          : normalizeAgyUsage(result, wallMs),
        stderrTail,
        ...(toolInvocations === undefined || overflow
          ? {}
          : { toolInvocations }),
        ...(exitCode === undefined ? {} : { exitCode }),
      };
    } finally {
      ACTIVE_CHILD_PROCS.delete(proc);
      context.signal.removeEventListener("abort", onAbort);
    }
  }

  classifyFailure(
    outcome: TransportOutcome,
  ): TransportFailureCause | undefined {
    // No child started: the same argv would be refused again.
    if (isSpawnFailureTail(outcome.stderrTail)) return "runtime_unavailable";
    if (outcome.failureCause !== undefined) return outcome.failureCause;
    // Diagnostics only: `finalText` is the model's prose.
    return agyFailure({
      exitCode: outcome.exitCode,
      result: undefined,
      stderr: outcome.stderrTail,
    })?.cause;
  }
}
