import path from "node:path";
import {
  SESSION_LINE_OMITTED,
  SESSION_TRUNCATED,
} from "./claude-session-trace";
import type { NormalizedTokens, UsageBillingMode } from "./usage-normalized";

// What one attempt measured per model request, with no dollar anywhere: the engine's side of the
// platform's `usage_facts` report (odd/tasks/platform-owned-cost-contract.md, section 3). The platform
// prices these; the engine only reads them where the provider wrote them.
//
// WHY at attempt settlement and not in the report step: the Claude CLI's per-model summary
// (`modelUsage`) is in its stdout, which nothing keeps, and the session copy and the OpenCode capture
// are only certain to exist while the harness still holds the attempt. So the harness extracts here,
// writes one `usage.<step>.attempt<n>.json` per attempt, and pipeline.json carries them; the report
// step only copies numbers out of pipeline.json.

// Disjoint token counts, in the platform's order: uncached input, cache read, cache write at the
// provider's default lifetime, cache write for one hour, visible output, reasoning.
export type UsageCounts = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

// The provider's own per-model totals for an attempt (the Claude CLI's `modelUsage`), already split
// into UsageCounts.
export interface ModelUsageCounts {
  readonly model: string;
  readonly counts: UsageCounts;
}

export type UsageFactCredential = "api" | "subscription" | "free";

// The contract's gap reasons this engine emits.
export type UsageGapReason =
  | "no_session" // the Claude session copy is missing or failed
  | "line_omitted" // a session line was over the copy's caps
  | "truncated" // the session copy hit its size cap
  | "no_readback" // the OpenCode capture or its readback is missing
  | "no_summary"; // the Claude CLI printed no `modelUsage` (killed, timed out, unparseable)

// [provider, model, ...UsageCounts]: the model exactly as the provider reported it.
export type UsageFactEntry = readonly [
  string,
  string,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface AttemptUsageFacts {
  readonly attempt: number;
  readonly credential: UsageFactCredential;
  // One per model request, in the order the provider answered.
  readonly requests: readonly UsageFactEntry[];
  // What the provider's own totals count beyond the requests, per model. Absent when nothing is.
  readonly remainders?: readonly UsageFactEntry[];
  // Why some requests could not be read. Absent when none were lost.
  readonly gaps?: readonly UsageGapReason[];
}

export function usageFactsPath(
  outPath: string,
  stepName: string,
  attempt: number,
): string {
  return path.join(
    path.dirname(outPath),
    `usage.${stepName}.attempt${attempt}.json`,
  );
}

// The credential an attempt ran on, from the billing mode its transport stamped on its usage. An
// attempt's own mode is never `unknown` today (only a sum of disagreeing attempts is); such an
// attempt would name no credential, so it reports no facts rather than a guessed one.
export function credentialOfBillingMode(
  mode: UsageBillingMode,
): UsageFactCredential | undefined {
  switch (mode) {
    case "metered":
      return "api";
    case "subscription":
      return "subscription";
    case "free":
      return "free";
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A token count as the platform accepts it: a non-negative integer.
function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// The Claude CLI counts thinking inside its output and the one-hour write inside its total write, so
// both are split out here. A figure that names no split leaves it all in the default leaf.
export function claudeUsageCounts(input: {
  uncached: unknown;
  cacheRead: unknown;
  cacheWriteTotal: unknown;
  cacheWrite1h: unknown;
  cacheWrite5m: unknown;
  output: unknown;
  thinking: unknown;
}): UsageCounts {
  const write1h = tokens(input.cacheWrite1h);
  const writeTotal =
    typeof input.cacheWriteTotal === "number"
      ? tokens(input.cacheWriteTotal)
      : tokens(input.cacheWrite5m) + write1h;
  const thinking = tokens(input.thinking);
  return [
    tokens(input.uncached),
    tokens(input.cacheRead),
    Math.max(0, writeTotal - write1h),
    write1h,
    Math.max(0, tokens(input.output) - thinking),
    thinking,
  ];
}

// The requests of one Claude session copy (execution/claude-session-trace.ts), read a line at a
// time: the copy can be 64 MiB and several hunters settle at once, so it is never held whole. The
// CLI writes one line per content block of a message, each with the message's final usage, so a
// message id is one request, kept at its first position. A message with no usage at all (a CLI
// placeholder) is not a request: it bills nothing and would name a model nobody prices.
async function claudeSessionRequests(
  lines: AsyncIterable<string> | Iterable<string>,
): Promise<{
  requests: ModelUsageCounts[];
  gaps: UsageGapReason[];
}> {
  const byId = new Map<string, ModelUsageCounts>();
  const requests: ModelUsageCounts[] = [];
  const gaps = new Set<UsageGapReason>();
  for await (const line of lines) {
    // Most lines are prompts and tool results; only these can name usage or a marker.
    if (!line.includes('"usage"') && !line.includes('"crysk"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed.crysk === SESSION_LINE_OMITTED) gaps.add("line_omitted");
    if (parsed.crysk === SESSION_TRUNCATED) gaps.add("truncated");
    if (parsed.type !== "assistant" || !isRecord(parsed.message)) continue;
    const { id, model, usage } = parsed.message;
    const modelId = nonEmpty(model);
    if (modelId === undefined || !isRecord(usage)) continue;
    const creation = isRecord(usage.cache_creation) ? usage.cache_creation : {};
    const details = isRecord(usage.output_tokens_details)
      ? usage.output_tokens_details
      : {};
    const counts = claudeUsageCounts({
      uncached: usage.input_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWriteTotal: usage.cache_creation_input_tokens,
      cacheWrite1h: creation.ephemeral_1h_input_tokens,
      cacheWrite5m: creation.ephemeral_5m_input_tokens,
      output: usage.output_tokens,
      thinking: details.thinking_tokens,
    });
    if (counts.every((n) => n === 0)) continue;
    const request = { model: modelId, counts };
    const key = nonEmpty(id);
    if (key === undefined) {
      requests.push(request);
      continue;
    }
    const seen = byId.get(key);
    if (seen === undefined) {
      byId.set(key, request);
      requests.push(request);
    } else {
      // Same message, later line: its usage replaces the earlier one in place.
      requests[requests.indexOf(seen)] = request;
      byId.set(key, request);
    }
  }
  return { requests, gaps: [...gaps] };
}

function sumCounts(rows: readonly UsageCounts[]): UsageCounts {
  const total = [0, 0, 0, 0, 0, 0];
  for (const row of rows) for (let i = 0; i < 6; i++) total[i] += row[i] ?? 0;
  return total as unknown as UsageCounts;
}

// What a total counts beyond the requests of the same model, leaf by leaf, never negative. The two
// split leaves (write: default and one hour; output: visible and reasoning) are compared on their
// sum first, so a total that does not split them (an older CLI) is not read as a missing split.
function beyond(total: UsageCounts, seen: UsageCounts): UsageCounts {
  const over = (a: number, b: number) => Math.max(0, a - b);
  const pair = (
    defaultLeaf: number,
    splitLeaf: number,
  ): readonly [number, number] => {
    const all = over(
      total[defaultLeaf] + total[splitLeaf],
      seen[defaultLeaf] + seen[splitLeaf],
    );
    const split = Math.min(all, over(total[splitLeaf], seen[splitLeaf]));
    return [all - split, split];
  };
  const [write, write1h] = pair(2, 3);
  const [output, reasoning] = pair(4, 5);
  return [
    over(total[0], seen[0]),
    over(total[1], seen[1]),
    write,
    write1h,
    output,
    reasoning,
  ];
}

function entry(provider: string, row: ModelUsageCounts): UsageFactEntry {
  return [provider, row.model, ...row.counts];
}

function facts(
  base: { attempt: number; credential: UsageFactCredential },
  requests: readonly UsageFactEntry[],
  remainders: readonly UsageFactEntry[],
  gaps: readonly UsageGapReason[],
): AttemptUsageFacts {
  return {
    attempt: base.attempt,
    credential: base.credential,
    requests,
    ...(remainders.length === 0 ? {} : { remainders }),
    ...(gaps.length === 0 ? {} : { gaps }),
  };
}

// One Claude CLI attempt: its requests from the session copy's lines (undefined when the copy is
// missing), and the CLI's per-model summary (undefined when the CLI printed none) for what the copy
// lost or never had: a side model the CLI ran outside the conversation, a line over the copy's caps.
export async function claudeAttemptUsageFacts(input: {
  attempt: number;
  credential: UsageFactCredential;
  provider: string;
  session: AsyncIterable<string> | Iterable<string> | undefined;
  summary: readonly ModelUsageCounts[] | undefined;
}): Promise<AttemptUsageFacts> {
  const read =
    input.session === undefined
      ? { requests: [], gaps: ["no_session" as const] }
      : await claudeSessionRequests(input.session);
  const remainders: UsageFactEntry[] = [];
  for (const total of input.summary ?? []) {
    const seen = sumCounts(
      read.requests.filter((r) => r.model === total.model).map((r) => r.counts),
    );
    const counts = beyond(total.counts, seen);
    if (counts.some((n) => n > 0)) {
      remainders.push(entry(input.provider, { model: total.model, counts }));
    }
  }
  return facts(
    input,
    read.requests.map((r) => entry(input.provider, r)),
    remainders,
    input.summary === undefined ? [...read.gaps, "no_summary"] : read.gaps,
  );
}

// The newest readback of an OpenCode capture (transports/opencode-evidence.ts): the session's
// messages as OpenCode returned them, final per message, where the stream's per-message figures
// can still grow. One request per assistant message, none skipped, in the order the trace makes
// its turns of them (ci/trace-transcripts.ts `openCodeConversation`), so a request's index is its
// turn's. `complete` is the readback's own `coverage`, the same test the evidence classifier uses.
// Undefined when the capture holds no readback.
function openCodeReadback(
  capture: string,
  route: { provider: string; model: string },
): { requests: UsageFactEntry[]; complete: boolean } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(capture);
  } catch {
    return undefined;
  }
  const records =
    isRecord(parsed) && Array.isArray(parsed.records)
      ? parsed.records.filter(isRecord)
      : [];
  const readback = records
    .filter(
      (record) =>
        record.kind === "readback" &&
        isRecord(record.data) &&
        Array.isArray(record.data.messages),
    )
    .at(-1);
  if (readback === undefined || !isRecord(readback.data)) return undefined;
  const requests: UsageFactEntry[] = [];
  for (const message of (readback.data.messages as unknown[]).filter(
    isRecord,
  )) {
    const info = isRecord(message.info) ? message.info : message;
    if (info.role !== "assistant") continue;
    const t = isRecord(info.tokens) ? info.tokens : {};
    const cache = isRecord(t.cache) ? t.cache : {};
    // OpenCode's leaves are disjoint and its one cache write has no lifetime.
    requests.push([
      nonEmpty(info.providerID) ?? route.provider,
      nonEmpty(info.modelID) ?? route.model,
      tokens(t.input),
      tokens(cache.read),
      tokens(cache.write),
      0,
      tokens(t.output),
      tokens(t.reasoning),
    ]);
  }
  return { requests, complete: readback.data.coverage === "complete" };
}

// One OpenCode attempt: one request per assistant message of its capture's newest readback. When
// the readback is missing (the capture was dropped or elided) or does not cover the whole session,
// what the attempt's streamed totals count beyond the requests read stands in as one remainder
// under its route, with a `no_readback` gap. An attempt with no capture and no totals reached no
// session and reports nothing. The contract's `evicted` gap is not emitted: the transport's
// per-message cap applies to its streamed map, which these facts never read.
export function openCodeAttemptUsageFacts(input: {
  attempt: number;
  credential: UsageFactCredential;
  route: { provider: string; model: string };
  capture: string | undefined;
  totals: NormalizedTokens;
}): AttemptUsageFacts | undefined {
  const readback =
    input.capture === undefined
      ? undefined
      : openCodeReadback(input.capture, input.route);
  if (readback?.complete === true) {
    return facts(input, readback.requests, [], []);
  }
  const t = input.totals;
  const totals: UsageCounts = [
    tokens(t.inputUncached) + tokens(t.inputOther),
    tokens(t.inputCacheRead),
    tokens(t.inputCacheWrite),
    0,
    tokens(t.outputVisible) + tokens(t.outputOther),
    tokens(t.outputReasoning),
  ];
  if (input.capture === undefined && totals.every((n) => n === 0)) {
    return undefined;
  }
  const requests = readback?.requests ?? [];
  const counts = beyond(
    totals,
    sumCounts(requests.map((r) => r.slice(2) as unknown as UsageCounts)),
  );
  return facts(
    input,
    requests,
    counts.some((n) => n > 0)
      ? [entry(input.route.provider, { model: input.route.model, counts })]
      : [],
    ["no_readback"],
  );
}
