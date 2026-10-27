// Refuter-discrimination probe fixture (ROADMAP A2 diagnostic, not an arm).
//
// WHY THIS EXISTS. The A2 refuter's first live measurement returned
// `corroborated` on 15 of 15 findings — a 0% false-positive reduction. Two
// explanations fit that data equally well: (a) those hunters were genuinely
// precise, or (b) the v2 refuter prompt is deferential and never refutes
// anything. A replay cannot separate them, because a replay contains no
// finding whose truth value is known in advance — every verdict is graded
// against the same fallible judgement it is supposed to check.
//
// This fixture supplies what the replay cannot: claims whose truth value is
// KNOWN before the model sees them, against code that positively decides them.
// Four arms over the SAME repo, the same agent file, the same model, the same
// finding shape — only the claim, its location and its proof_refs change:
//   - `true-claim`       (control) — accurate claim         → corroborated
//   - `false-claim`      (easy)    — contradicted nearby    → refuted
//   - `hard-false-claim` (depth)   — contradicted 3 files away → refuted
//   - `latent-claim`     (G6)      — real, unreachable code → downgraded-latent
// The control carries as much weight as the tests: without it, an all-`refuted`
// result would read as success when it is really a broken probe.
//
// WHY FOUR ARMS. The first two only decide whether the gate refutes ANYTHING,
// and they measure the easiest case there is. They cannot separate "reads the
// code" from "reads the fourteen lines it was handed": the easy arm's disproof
// sits two lines above the cited signature in the smallest file in the repo.
// The last two arms probe where calibration is actually decided —
//   - `hard-false-claim` keeps the disproof mechanical and citable but moves it
//     three call hops and three files out (`shard.ts` ← `router.ts` ←
//     `settings.ts` ← `normalise.ts`): the value the claim calls unsafe is
//     clamped long before it reaches the cited line, and nothing at that line
//     says so. Only a refuter that WALKS the chain can find the contradiction.
//   - `latent-claim` is the G6 lesson — "real but unreachable today" — which
//     has never been tested once: a real, correctly described defect in a
//     module nothing imports. The only right answer is `downgraded-latent`:
//     keep it, record it, never block a merge on it.
//
// The planted retry function is DELIBERATELY guarded. `withRetry` validates its
// `attempts` argument on the third line, so the easy false claim ("it never
// validates `attempts`") is disproved by a line the refuter can cite — exactly
// the positive disproof Mandate 2 of the A2 prompt demands. The same discipline
// governs the hard arm: `normaliseShardCount` replaces anything below 1, so a
// careful reader following the chain lands on one citable contradicting line.
// Neither false arm is unfalsifiable; an ambiguous arm would return
// `inconclusive` for reasons that have nothing to do with the hypothesis.
//
// REACHABILITY IS AN EXPERIMENTAL CONTROL, and it points in OPPOSITE directions
// per arm. The retry and shard targets must be LIVE — `downgraded-latent` would
// otherwise be a legitimate third answer on those arms and would confound the
// verdict — while the cache target must be an ORPHAN, because that verdict IS
// the hypothesis there. So the head tree is checked, not trusted:
// assertHeadWiring() fails the build if a live edge disappears or if anything
// ever imports the orphan module.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DraftFinding, RefuterOutcome } from "#review/drafts";

// The arm list is a tuple, not a bare union, so the script can iterate the
// matrix without restating it — a fifth arm added here reaches the runner and
// the report for free.
export const PROBE_ARMS = [
  "true-claim",
  "false-claim",
  "hard-false-claim",
  "latent-claim",
] as const;

export type ProbeArm = (typeof PROBE_ARMS)[number];

// The whole point of the probe, as data: what a refuter that discriminates
// MUST return for each arm. Single source of truth — the builder stamps it
// onto the fixture and the script reports against it.
export const EXPECTED_VERDICT: Record<ProbeArm, RefuterOutcome> = {
  "true-claim": "corroborated",
  "false-claim": "refuted",
  "hard-false-claim": "refuted",
  "latent-claim": "downgraded-latent",
};

// Agent filenames written into the fixture's agents dir. Exported so the
// probe's ReviewSpec cannot desync from the files that back it.
export const HUNTER_AGENT_FILE = "deep-review-resilience.md";
export const REFUTER_AGENT_FILE = "review-refuter.md";
// Findings-schema v1.0.0 pins hunter keys to reliability|resilience|parity|
// lifecycle, and the draft's `hunter` field must sit in the same enum.
// Non-parity on purpose: the parity leg must not fire.
export const HUNTER_KEY = "resilience";

export interface RefuterProbeFixture {
  arm: ProbeArm;
  repoDir: string;
  baseSha: string;
  headSha: string;
  diffPath: string;
  agentsDir: string;
  gotchasPath: string;
  runDir: string;
  // The single finding injected in place of a hunter draft — the arm's whole
  // experimental variable.
  draft: DraftFinding;
  expectedVerdict: RefuterOutcome;
  // The line the arm's expected verdict hinges on, resolved from the source so
  // an edit that deletes it fails loudly here instead of quietly inverting the
  // arm. For the retry arms it is the `attempts` guard the easy false claim
  // collides with; for `hard-false-claim` it is the shard-count clamp three
  // files away. Deliberately absent from both false arms' proof_refs: finding
  // it is the refuter's job. For `latent-claim` no line contradicts anything —
  // that claim is TRUE — so the field carries the defect line instead, and the
  // absence that actually decides the arm is enforced by assertHeadWiring().
  contradictingLine: number;
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "pr-hero-fixture",
  GIT_AUTHOR_EMAIL: "fixture@pr-hero.invalid",
  GIT_COMMITTER_NAME: "pr-hero-fixture",
  GIT_COMMITTER_EMAIL: "fixture@pr-hero.invalid",
};

async function git(repoDir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoDir, ...args], {
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
  }
  return stdout;
}

// --- The mini project -------------------------------------------------------

// Names every module so no module stands out by its absence — a README that
// listed the wired modules and skipped the cache would hand the latent arm its
// answer. It says what each one owns, never how they are wired together.
const README = `# fixture-config

Loads remote configuration at startup. The config module owns the fetch policy;
the client module owns the transport; key routing and payload caching each live
in their own module.
`;

// Unchanged by the diff: the transport that can fail, which is what makes a
// retry policy meaningful at all.
const CLIENT = `export interface ConfigPayload {
  featureFlags: Record<string, boolean>;
}

export async function fetchConfigPayload(url: string): Promise<ConfigPayload> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("config request failed: " + response.status);
  }
  return (await response.json()) as ConfigPayload;
}
`;

// Commit 1 (base): one shot, no retry policy anywhere in the repo.
const CONFIG_BASE = `import { type ConfigPayload, fetchConfigPayload } from "./client";

const CONFIG_URL = "https://config.internal/app.json";

export async function loadConfig(): Promise<ConfigPayload> {
  return fetchConfigPayload(CONFIG_URL);
}
`;

// Commit 2 (head): the caller is rewired onto the new helper. THIS is what
// closes the `downgraded-latent` door — `withRetry` is not an orphan, it sits
// on a path the entry point actually walks.
const CONFIG_HEAD = `import { type ConfigPayload, fetchConfigPayload } from "./client";
import { withRetry } from "./retry";

const CONFIG_URL = "https://config.internal/app.json";
const CONFIG_ATTEMPTS = 3;

export async function loadConfig(): Promise<ConfigPayload> {
  return withRetry(() => fetchConfigPayload(CONFIG_URL), CONFIG_ATTEMPTS);
}
`;

// The entry point at base: index -> loadConfig.
const INDEX_BASE = `import { loadConfig } from "./config";

export async function start(): Promise<string[]> {
  const config = await loadConfig();
  return Object.keys(config.featureFlags);
}
`;

// The entry point at head. It still walks index -> loadConfig -> withRetry, and
// now also index -> routeAll -> shardFor, which is what keeps the hard arm's
// target LIVE. It never reaches the cache module — that omission is the latent
// arm's whole premise, and assertHeadWiring() guards it.
const INDEX_HEAD = `import { loadConfig } from "./config";
import { routeAll } from "./router";

export async function start(): Promise<string[]> {
  const config = await loadConfig();
  return routeAll(Object.keys(config.featureFlags));
}
`;

// The file under test for the retry arms, added by the head commit. Carries NO
// explanatory comment: both claims must be judged against the code, never
// against prose that confesses or denies the defect. The `attempts < 1` guard
// is the contradicting evidence the easy false arm must run into.
const RETRY = `export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  if (attempts < 1) {
    throw new Error("attempts must be at least 1");
  }
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

// The hard-false arm's target, added by the head commit. Nothing HERE answers
// the claim: read in isolation the modulo really is unguarded, and the value
// that decides the verdict is three files up the call chain. That distance is
// the arm, so this file stays as bare as the claim's cited lines.
const SHARD = `export function shardFor(key: string, shardCount: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % shardCount;
}
`;

// Hop 1 of the hard arm's chain: the only caller of `shardFor` in the repo. It
// does not clamp anything itself — it hands the job on, which is what forces a
// second and third hop.
const ROUTER = `import { configuredShardCount } from "./settings";
import { shardFor } from "./shard";

export function routeAll(keys: string[]): string[] {
  const shardCount = configuredShardCount();
  return keys.map((key) => key + "@" + shardFor(key, shardCount));
}
`;

// Hop 2: where the claim's premise is literally true — unset really does read
// as `0` — and where a refuter that stops one file short would confirm the
// claim instead of disproving it.
const SETTINGS = `import { normaliseShardCount } from "./normalise";

const RAW_SHARD_COUNT = Number(process.env.CONFIG_SHARDS ?? "0");

export function configuredShardCount(): number {
  return normaliseShardCount(RAW_SHARD_COUNT);
}
`;

// Hop 3: the disproof. The guard covers 0, negatives and NaN alike, so there is
// no residual reading on which the claim survives — the arm is hard to reach,
// never ambiguous once reached.
const NORMALISE = `const DEFAULT_SHARD_COUNT = 8;

export function normaliseShardCount(raw: number): number {
  if (!Number.isFinite(raw) || raw < 1) {
    return DEFAULT_SHARD_COUNT;
  }
  return Math.trunc(raw);
}
`;

// The latent arm's target: a real defect, in a module NOTHING imports. The
// freshness test is inverted — a live entry is evicted and reported as a miss,
// an expired one is served as a hit and never evicted. The claim describes that
// accurately, so the only thing left for the refuter to weigh is whether
// anything at this commit can execute it. Nothing can.
const CACHE = `import type { ConfigPayload } from "./client";

interface CacheEntry {
  value: ConfigPayload;
  expiresAt: number;
}

const entries = new Map<string, CacheEntry>();

export function storeCached(
  key: string,
  value: ConfigPayload,
  expiresAt: number,
): void {
  entries.set(key, { value, expiresAt });
}

export function readCached(key: string, now: number): ConfigPayload | undefined {
  const entry = entries.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt > now) {
    entries.delete(key);
    return undefined;
  }
  return entry.value;
}
`;

// The head tree as data. The writer and the wiring check read the SAME map, so
// a file cannot reach the repo without being checked.
const HEAD_FILES: Record<string, string> = {
  "src/cache.ts": CACHE,
  "src/client.ts": CLIENT,
  "src/config.ts": CONFIG_HEAD,
  "src/index.ts": INDEX_HEAD,
  "src/normalise.ts": NORMALISE,
  "src/retry.ts": RETRY,
  "src/router.ts": ROUTER,
  "src/settings.ts": SETTINGS,
  "src/shard.ts": SHARD,
};

// Every edge that must survive for a non-latent arm to mean anything: break one
// and its target becomes unreachable, at which point `downgraded-latent` is a
// legitimate answer and the arm no longer tests what it claims to test.
const LIVE_IMPORT_EDGES: Array<[string, string]> = [
  ["src/index.ts", "./config"],
  ["src/index.ts", "./router"],
  ["src/config.ts", "./retry"],
  ["src/router.ts", "./shard"],
  ["src/router.ts", "./settings"],
  ["src/settings.ts", "./normalise"],
];

// The other direction: the latent arm's module must stay an orphan.
const ORPHAN_IMPORT = "./cache";

// Reachability is checked, not trusted — it is as load-bearing as the claims
// and far easier to break by accident, because wiring a module up looks like
// tidying rather than like inverting an experiment.
function assertHeadWiring(): void {
  for (const [file, imported] of LIVE_IMPORT_EDGES) {
    if (!HEAD_FILES[file]?.includes(`from "${imported}"`)) {
      throw new Error(
        `refuter probe fixture: live edge ${file} -> ${imported} is gone; ` +
          "its target is now unreachable and `downgraded-latent` becomes a " +
          "legitimate verdict on an arm that does not expect it",
      );
    }
  }
  for (const [file, source] of Object.entries(HEAD_FILES)) {
    if (source.includes(`from "${ORPHAN_IMPORT}"`)) {
      throw new Error(
        `refuter probe fixture: ${file} imports ${ORPHAN_IMPORT}; the latent ` +
          "arm's target is no longer an orphan, so its expected " +
          "`downgraded-latent` verdict is now the wrong answer",
      );
    }
  }
}

// Neutral: nothing here answers any claim, and nothing hints that two of them
// are planted false or that one target is unwired.
const GOTCHAS = `- Remote configuration is fetched once at startup and cached for the process.
- The config gateway returns 503 for a few seconds while it restarts.
- Retry policy lives in one helper; call sites pass an attempt count and never
  write their own loop.
`;

// --- The fixture prompt set -------------------------------------------------

// Never spawned: the probe's dispatching runner answers the hunter step with a
// canned draft. The file exists because the pipeline parses every configured
// agent (and writes its templated body as an audit artifact) BEFORE any step
// runs, so a missing file would fail the run before the refuter is reached.
// Its `model` is likewise resolved but never used.
const HUNTER_AGENT = `---
name: deep-review-resilience
description: Probe placeholder — the hunter leg is faked, this is never spawned.
model: haiku
tools: Read, Grep, Glob
---

# Placeholder Hunter

This body is never sent to a model. It is parsed for its frontmatter and
rendered into the run dir so the templating path stays exercised.

Codebase gotchas (authoritative):
{{GOTCHAS}}

Suspicion priors:
{{PRIORS}}
`;

// --- The planted claims -----------------------------------------------------

// Accurate: the loop re-invokes `fn` with nothing between iterations. A
// discriminating refuter reads the loop, hunts for a delay/backoff it does not
// find, and corroborates.
const TRUE_CLAIM = [
  "`withRetry` retries immediately with no delay between attempts, so a",
  "failing dependency is retried `attempts` times in a tight loop with no",
  "backoff.",
].join(" ");

// False, and mechanically so: `attempts` IS validated, three lines above the
// loop, and `0` throws instead of skipping. A refuter that corroborates this
// has not read past the signature.
const FALSE_CLAIM = [
  "`withRetry` never validates `attempts`, so calling it with `0` skips the",
  "loop entirely and returns `undefined` — silently reporting success for work",
  "that never ran.",
].join(" ");

// False too, and just as mechanically — but the disproof is three call hops and
// three files from the cited line. `shardFor` is handed its count by
// `router.ts`, which takes it from `settings.ts`, which routes it through
// `normalise.ts`, where anything below 1 becomes DEFAULT_SHARD_COUNT. `0` never
// reaches the modulo. The claim's premise (unset reads as `0`) is true where it
// is written, which is what makes stopping one file short so tempting.
const HARD_FALSE_CLAIM = [
  "`shardFor` takes its shard count straight from the `CONFIG_SHARDS`",
  "environment variable, which reads as `0` when unset, so `Math.abs(hash) %",
  "shardCount` evaluates to `NaN` for every key a default deployment routes.",
].join(" ");

// TRUE, and that is the point: the freshness test really is inverted, and the
// claim says so correctly. The arm is not about whether the defect is real but
// about whether the gate notices that NOTHING IMPORTS `src/cache.ts`, so
// nothing at this commit can execute it.
const LATENT_CLAIM = [
  "`readCached` inverts its freshness test: an entry whose `expiresAt` is",
  "still in the future is evicted and reported as a miss, while an already",
  "expired entry is returned as a live hit and never evicted, so a stale",
  "config payload is served for the rest of the process.",
].join(" ");

const SIGNATURE_MARKER = "export async function withRetry";
const GUARD_MARKER = "if (attempts < 1) {";
const LOOP_MARKER = "for (let i = 0; i < attempts; i++) {";
const CALL_MARKER = "return withRetry(";
const SHARD_HASH_MARKER = "hash = (hash * 31 + key.charCodeAt(i)) | 0;";
const SHARD_MODULO_MARKER = "return Math.abs(hash) % shardCount;";
const ROUTE_MARKER = "shardFor(key, shardCount)";
const CLAMP_MARKER = "if (!Number.isFinite(raw) || raw < 1) {";
const CACHE_STORE_MARKER = "export function storeCached";
const CACHE_FRESHNESS_MARKER = "if (entry.expiresAt > now) {";

// Line refs are DERIVED, never typed by hand: an edit to a source constant
// above must either move the refs with it or fail here, because a claim citing
// the wrong lines would be refutable for a reason that has nothing to do with
// the hypothesis under test.
function lineOf(source: string, marker: string, label: string): number {
  const index = source.split("\n").findIndex((l) => l.includes(marker));
  if (index < 0) {
    throw new Error(
      `refuter probe fixture: ${label} not located (marker "${marker}")`,
    );
  }
  return index + 1; // 1-indexed, the form proof_refs use
}

// One category across every arm. It reads as "retry / idempotency" because the
// first two arms live in the retry helper, but it is HELD FIXED on purpose:
// category feeds dedupe_key and the tier arithmetic, and letting it drift with
// the target file would add a second experimental variable for no gain.
const CATEGORY = 6;

// path, symbol and dedupe_key are one fact, not three — dedupe_key is
// path:symbol:category by contract. Arms 3 and 4 necessarily point at other
// files, so the trio is derived from the target rather than restated per arm.
function target(
  path: string,
  symbol: string,
): Pick<DraftFinding, "path" | "symbol" | "dedupe_key"> {
  return { path, symbol, dedupe_key: `${path}:${symbol}:${CATEGORY}` };
}

function plantedDraft(arm: ProbeArm): {
  draft: DraftFinding;
  contradictingLine: number;
} {
  const signatureLine = lineOf(RETRY, SIGNATURE_MARKER, "withRetry signature");
  const guardLine = lineOf(RETRY, GUARD_MARKER, "attempts guard");
  const loopLine = lineOf(RETRY, LOOP_MARKER, "retry loop");
  const callLine = lineOf(CONFIG_HEAD, CALL_MARKER, "withRetry call site");
  const hashLine = lineOf(SHARD, SHARD_HASH_MARKER, "shard hash");
  const moduloLine = lineOf(SHARD, SHARD_MODULO_MARKER, "shard modulo");
  const routeLine = lineOf(ROUTER, ROUTE_MARKER, "shardFor call site");
  const clampLine = lineOf(NORMALISE, CLAMP_MARKER, "shard-count clamp");
  const storeLine = lineOf(CACHE, CACHE_STORE_MARKER, "cache write");
  const freshLine = lineOf(CACHE, CACHE_FRESHNESS_MARKER, "freshness test");

  // Everything except `line`, `claim`, `proof_refs` and the target trio is
  // identical across the arms. Severity especially: BLOCKER/CRITICAL is what
  // admits a finding to the refuter batch at all, so an arm-dependent severity
  // would silently make one arm a no-op. `evidence_class` never reaches the
  // refuter (its prompt carries id, location, severity, claim, proof_refs and
  // nothing else), so it cannot be the variable either — it is fixed only to
  // keep the tier arithmetic comparable between arms.
  const common = {
    id: "RES-1",
    category: CATEGORY, // hunting-map: retry / idempotency
    severity: "CRITICAL" as const,
    evidence_class: "inferential" as const,
    causal_disposition: "introduced" as const,
    hunter: HUNTER_KEY as DraftFinding["hunter"],
    hops_used: 1,
    hop_trail: [],
  };

  switch (arm) {
    case "true-claim":
      return {
        draft: {
          ...common,
          ...target("src/retry.ts", "withRetry"),
          line: loopLine,
          claim: TRUE_CLAIM,
          proof_refs: [`src/retry.ts:${loopLine}`, `src/config.ts:${callLine}`],
        },
        contradictingLine: guardLine,
      };
    case "false-claim":
      return {
        draft: {
          ...common,
          ...target("src/retry.ts", "withRetry"),
          line: signatureLine,
          claim: FALSE_CLAIM,
          // The guard line is NOT cited. Mandate 1 of the A2 prompt requires
          // the refuter to expand beyond the hunter's refs and hunt the
          // counterexample itself; handing it the disproof would test reading
          // comprehension instead of the behaviour under investigation.
          proof_refs: [
            `src/retry.ts:${signatureLine}`,
            `src/retry.ts:${loopLine}`,
            `src/config.ts:${callLine}`,
          ],
        },
        contradictingLine: guardLine,
      };
    case "hard-false-claim":
      return {
        draft: {
          ...common,
          ...target("src/shard.ts", "shardFor"),
          line: moduloLine,
          claim: HARD_FALSE_CLAIM,
          // Same discipline as the easy false arm, an order of magnitude
          // further out: neither the clamp in `normalise.ts` nor the
          // `settings.ts` hop is cited, so the refuter must walk router →
          // settings → normalise on its own. The router call site IS cited,
          // exactly as the retry arms cite theirs, so the arm measures
          // traversal DEPTH rather than whether a caller can be found at all.
          proof_refs: [
            `src/shard.ts:${hashLine}`,
            `src/shard.ts:${moduloLine}`,
            `src/router.ts:${routeLine}`,
          ],
        },
        contradictingLine: clampLine,
      };
    case "latent-claim":
      return {
        draft: {
          ...common,
          ...target("src/cache.ts", "readCached"),
          line: freshLine,
          claim: LATENT_CLAIM,
          // Both refs sit inside the orphan module, and neither says anything
          // about who calls it: establishing that nobody does is the verdict
          // this arm asks for.
          proof_refs: [
            `src/cache.ts:${freshLine}`,
            `src/cache.ts:${storeLine}`,
          ],
        },
        // No line contradicts this claim — it is TRUE. What decides the arm is
        // an ABSENCE (no importer of src/cache.ts), which no line number can
        // encode and assertHeadWiring() enforces instead. The field carries the
        // defect line, so deleting the inverted test still fails loudly here.
        contradictingLine: freshLine,
      };
  }
}

export async function buildRefuterProbeFixture(
  arm: ProbeArm,
  refuterAgentSource: string,
): Promise<RefuterProbeFixture> {
  // Before any I/O: a broken wiring invariant invalidates the arm, and finding
  // that out from a verdict costs a live model run.
  assertHeadWiring();

  const base = await mkdtemp(path.join(tmpdir(), `pr-hero-refuter-${arm}-`));
  // agents/ and run/ are SIBLINGS of the repo, never inside it: the refuter's
  // cwd is repoDir, and an agent prompt or an answer key under that root would
  // surface in its own Grep results.
  const repoDir = path.join(base, "repo");
  const agentsDir = path.join(base, "agents");
  const runDir = path.join(base, "run");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  await mkdir(agentsDir);
  await mkdir(runDir);

  await writeFile(path.join(repoDir, "README.md"), README);
  await writeFile(path.join(repoDir, "src", "client.ts"), CLIENT);
  await writeFile(path.join(repoDir, "src", "config.ts"), CONFIG_BASE);
  await writeFile(path.join(repoDir, "src", "index.ts"), INDEX_BASE);
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "feat: load remote config"]);
  const baseSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

  // The head tree comes from the checked map, never from a second hand-kept
  // list of writes. Files whose bytes did not change are simply not staged.
  for (const [relative, source] of Object.entries(HEAD_FILES)) {
    await writeFile(path.join(repoDir, relative), source);
  }
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, [
    "commit",
    "-q",
    "-m",
    "feat: retry the config fetch, route keys to shards, add a payload cache",
  ]);
  const headSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

  const diffPath = path.join(base, "diff.patch");
  await writeFile(diffPath, await git(repoDir, ["diff", baseSha, headSha]));

  await writeFile(path.join(agentsDir, HUNTER_AGENT_FILE), HUNTER_AGENT);
  await writeFile(path.join(agentsDir, REFUTER_AGENT_FILE), refuterAgentSource);

  const gotchasPath = path.join(base, "gotchas.md");
  await writeFile(gotchasPath, GOTCHAS);

  const { draft, contradictingLine } = plantedDraft(arm);

  return {
    arm,
    repoDir,
    baseSha,
    headSha,
    diffPath,
    agentsDir,
    gotchasPath,
    runDir,
    draft,
    expectedVerdict: EXPECTED_VERDICT[arm],
    contradictingLine,
  };
}
