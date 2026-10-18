import { OPENCODE_OAUTH_PROVIDER } from "../security/credential-broker";

// #182: live free-model discovery. OpenCode free models (backend `opencode`,
// provider `opencode`, e.g. `muse-spark-1.3-contributor-free`) authenticate
// with NOTHING, but without a liveness check they are refused at credential
// projection — there is no kind for "no credential".
//
// NO hardcoded model lists here or in any JSON: free-model identities rotate
// constantly, so discovery is LIVE — `<binaryPath> models <provider>
// --verbose --refresh`, parsed at runtime. The discriminator is what the
// provider itself declares: exact model id present AND status active AND
// input===0 AND output===0 AND cache.read===0 AND cache.write===0.
//
// WHY `--refresh`: a stale price is a CONFIDENT WRONG NUMBER, which is worse
// than no price — the gate exists to refuse billing an unknown amount, and a
// stale quote defeats it by making the unknown look known. That doctrine used
// to live in src/pricing-catalog.ts, whose bundled rate tables #197 deleted
// for failing it (they aged on our release cadence and then refused the very
// routes they existed to price); it is restated here rather than pointed at,
// because it is this function's reason and now has no other home. A cached
// all-zero cost that has since become metered would admit a paid run as free;
// offline failure must refuse loudly downstream (fail closed →
// provider_api_token), not silently pass.
//
// SCOPE NOTE (residual now guarded, #182 follow-up): between the probe and
// the attempt the provider could flip a model from free to metered
// (stale-cache window). The attempt then runs under an empty projection, and
// the flip is observable at settlement — the transport accumulates
// provider-reported cost per message (`cashCostUsd`, `costSource: "provider"`,
// opencode-sdk.ts), stamped with the route's billing mode ("free",
// transport-registry.ts). `settlementFromUsage`'s free-nonzero rule
// (spend-limiter.ts) routes complete usage with cash > 0 on a free-declared
// route to unresolved WITH reason `free_nonzero_cost` (carrying the provider's
// stated figure), the spend ledger fences the bucket, and the harness fails
// the attempt closed with no retry (re-probe is the remedy). Measured first:
// a legitimate free attempt reports cash 0 (Step-0 probe, "Say OK" on
// muse-spark-1.3-contributor-free), so the rule cannot misfire on list-price
// reporting. Free usage with NO cash figure releases WITHOUT fencing
// (harness.ts free-route fence scope) — no cash figure means no evidence of
// billing. Cancelled/undefined-usage and non-free incomplete usage still
// fence: no usage mode to exonerate them, so fail closed.

export type FreeModelProbe = (
  provider: string,
  model: string,
) => Promise<boolean>;

export interface FreeModelDiscoveryRunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface IsFreeModelInput {
  readonly binaryPath: string;
  readonly provider: string;
  readonly model: string;
  // Injectable for offline tests (repo doctrine: `bun test` is fully offline
  // with fake spawn). Production defaults to Bun.spawn. Never throws — any
  // failure returns false through the predicate below.
  readonly run?: (
    argv: readonly string[],
  ) => Promise<FreeModelDiscoveryRunResult>;
  // Bounds the live spawn below. `models --verbose --refresh` hits the
  // network, so without this a hung binary hangs admission forever — and the
  // memoised probe caches the PENDING promise, so one hang poisons every later
  // caller sharing the instance. With it the memoised promise always settles
  // (true/false, never pending forever). Applies to the default spawn only;
  // an injected `run` is the test's own clock. Fail-closed on timeout.
  readonly timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

// Exported for the timeout test below only: production goes through
// isFreeModel (a test IS a real consumer, same precedent as cli.ts main).
export async function defaultRun(
  argv: readonly string[],
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<FreeModelDiscoveryRunResult> {
  const proc = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  }) as unknown as {
    readonly stdout: unknown;
    readonly exited: Promise<number>;
    kill(): void;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = (async () => {
      const stdout = await new Response(proc.stdout as never).text();
      const exitCode = await proc.exited;
      return { exitCode, stdout };
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("free-model probe timed out")),
        timeoutMs,
      );
    });
    return await Promise.race([run, timeout]);
  } catch (error) {
    // Kill the hung child so no `models --refresh` outlives the admission
    // that gave up on it; the predicate below turns this into fail-closed
    // false either way.
    try {
      proc.kill();
    } catch {
      // Best-effort: the throw below is what the caller observes.
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isHeaderLine(line: string): boolean {
  if (line.length === 0) return false;
  const first = line[0];
  if (first === " " || first === "\t") return false;
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("}") ||
    trimmed.startsWith('"') ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("]")
  ) {
    return false;
  }
  return trimmed.includes("/");
}

// The header is `<provider>/<id>`: split on the FIRST "/" so a model id that
// itself contains "/" still matches exactly (remainder may contain "/").
function headerMatches(
  header: string,
  provider: string,
  model: string,
): boolean {
  const slash = header.indexOf("/");
  if (slash <= 0 || slash === header.length - 1) return false;
  return (
    header.slice(0, slash) === provider && header.slice(slash + 1) === model
  );
}

function parseCostBlock(
  stdout: string,
  provider: string,
  model: string,
): unknown {
  const lines = stdout.split("\n");
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!isHeaderLine(line)) continue;
    if (headerMatches(line.trim(), provider, model)) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) return undefined;
  const blockLines: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (isHeaderLine(line)) break;
    blockLines.push(line);
  }
  const block = blockLines.join("\n").trim();
  if (block.length === 0) return undefined;
  try {
    return JSON.parse(block);
  } catch {
    return undefined;
  }
}

// Strict predicate: exact `provider/model` header, JSON parses,
// status === "active", all four cost leaves strictly === 0. ANY failure,
// ambiguity, missing field, non-zero leaf, or spawn error returns FALSE
// (fail closed, never throws).
export async function isFreeModel(input: IsFreeModelInput): Promise<boolean> {
  try {
    if (
      input.binaryPath.length === 0 ||
      !input.binaryPath.startsWith("/") ||
      input.provider.length === 0 ||
      input.model.length === 0
    ) {
      return false;
    }
    const run = input.run ?? ((argv) => defaultRun(argv, input.timeoutMs));
    let result: FreeModelDiscoveryRunResult;
    try {
      result = await run([
        input.binaryPath,
        "models",
        input.provider,
        "--verbose",
        "--refresh",
      ]);
    } catch {
      return false;
    }
    if (result.exitCode !== 0) return false;
    const parsed = parseCostBlock(result.stdout, input.provider, input.model);
    if (typeof parsed !== "object" || parsed === null) return false;
    const record = parsed as Record<string, unknown>;
    if (record.status !== "active") return false;
    const cost = record.cost;
    if (typeof cost !== "object" || cost === null) return false;
    const costRecord = cost as Record<string, unknown>;
    if (costRecord.input !== 0 || costRecord.output !== 0) return false;
    const cache = costRecord.cache;
    if (typeof cache !== "object" || cache === null) return false;
    const cacheRecord = cache as Record<string, unknown>;
    if (cacheRecord.read !== 0 || cacheRecord.write !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

// Collision-free memo key for (provider, model) verdicts. RouteMapping
// provider/modelSnapshot are unconstrained strings and model ids may contain
// "/" (proven by our own header test) — so `${provider}/${model}` collides:
// ("a","b/c") and ("a/b","c") share one key and one verdict. JSON.stringify
// of the pair cannot collide: distinct pairs serialize distinctly.
export function freeVerdictKey(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

// One probe instance per admission: memoised per (provider, model) so the
// plan-level server credential and the per-binding upgrades share ONE verdict
// (the #149 anti-drift rule — two spawns could disagree across a provider
// flip, and the server would then hold a different truth than the binding).
export function createFreeModelProbe(options: {
  readonly binaryPath: string;
  readonly run?: IsFreeModelInput["run"];
  readonly timeoutMs?: number;
}): FreeModelProbe {
  const cache = new Map<string, Promise<boolean>>();
  return (provider: string, model: string) => {
    const key = freeVerdictKey(provider, model);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const verdict = isFreeModel({
      binaryPath: options.binaryPath,
      provider,
      model,
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
    cache.set(key, verdict);
    return verdict;
  };
}

// The plan line's billing half: how many steps of an ADMITTED route plan the
// free verdict covers. Reads only the verdicts admission already decided, so
// it never spawns — `probe` is the memoised instance admission returned, and a
// pair admission never probed would spawn here, which is why the gate below
// is the same one admission applies. Only OpenCode api-token routes can be
// free: an OAuth provider (OPENCODE_OAUTH_PROVIDER) never probes, and a
// claude-code step has no free kind at all. A missing probe, or a throwing
// one, counts as not free: an unknown price is never presented as free.
export interface FreeRouteBilling {
  readonly free: number;
  readonly total: number;
}

export async function countFreeRouteSteps(input: {
  readonly steps: readonly {
    readonly route: {
      readonly backend: string;
      readonly provider: string;
      readonly modelSnapshot: string;
    };
  }[];
  readonly probe: FreeModelProbe | undefined;
}): Promise<FreeRouteBilling> {
  const total = input.steps.length;
  if (input.probe === undefined) return { free: 0, total };
  const probe = input.probe;
  const verdicts = await Promise.all(
    input.steps.map(async ({ route }) => {
      if (route.backend !== "opencode") return false;
      if (route.provider === OPENCODE_OAUTH_PROVIDER) return false;
      try {
        return await probe(route.provider, route.modelSnapshot);
      } catch {
        return false;
      }
    }),
  );
  return { free: verdicts.filter((free) => free).length, total };
}
