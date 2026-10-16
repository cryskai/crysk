// Slice-4 fixture builder (plan §"The fixture eval"): a self-contained mini
// git repo with a KNOWN planted defect, rebuilt fresh into a temp dir on every
// run — never inside pr-hero itself, so a failed eval can never litter the
// engine repo and the fixture can never drift via uncommitted edits. The
// answer key travels with the fixture (returned AND written as expected.json)
// so the eval asserts against a location the builder itself planted.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_NAMES } from "#review/prompt-set";

export interface PlantedFixture {
  repoDir: string;
  baseSha: string;
  headSha: string;
  diffPath: string;
  agentsDir: string;
  gotchasPath: string;
  runDir: string;
  // The planted bug's location. The eval's assertion is OVERLAP — a finding
  // whose path matches and whose line falls inside [lineMin, lineMax] — never
  // exact-claim matching: models phrase the same defect a dozen ways, but
  // they cannot fake pointing at the planted lines.
  expected: { path: string; lineMin: number; lineMax: number };
}

// Explicit identity + neutered global/system config: the fixture must build
// identically on any machine with zero dependence on the user's git setup
// (a gpg-signing or template hook in ~/.gitconfig would otherwise break or
// pollute every commit).
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
// Commit 1 is CORRECT: volumeToGain maps user volume 0-100 to a 0-1 gain
// fraction; player.ts clamps to unity (a no-op then) and scales the fraction
// back up for display. Commit 2 plants the defect.

export const README = `# fixture-player

Tiny volume pipeline: \`volumeToGain\` produces the gain the player consumes,
\`applyVolume\` hands it to the engine and formats the display label.
`;

export const VOLUME_CORRECT = `// Converts a user-facing volume (0-100) into the value the player consumes.
export function volumeToGain(volume: number): number {
  const clamped = Math.min(100, Math.max(0, volume));
  return clamped / 100;
}
`;

// The planted cross-file value-contract bug: the producer now returns the
// PERCENTAGE (0-100) while the untouched player.ts still (a) clamps
// `gain <= 1` — silently flooring every real volume above 1% to unity-gain —
// and (b) multiplies by 100 for display, double-scaling the label. The code
// carries no tell-tale comment: the hunter must see the contradiction, not
// read a confession.
export const VOLUME_BUGGY = `// Converts a user-facing volume into the value the player consumes.
export function volumeToGain(volume: number): number {
  // Percent in, percent out: display code owns any further scaling.
  return Math.min(100, Math.max(0, volume));
}
`;

export const PLAYER = `// Applies a user-requested volume to the audio engine.
import { formatPercent } from "./format";
import { volumeToGain } from "./volume";

export function applyVolume(volume: number): { gain: number; label: string } {
  const gain = volumeToGain(volume);
  // The engine rejects gain above unity, so clamp before handing it over.
  const engineGain = Math.min(1, gain);
  // Display expects a percentage, so scale the fraction back up.
  return { gain: engineGain, label: formatPercent(engineGain * 100) };
}
`;

export const FORMAT = `// Display formatting helpers.
export function formatPercent(value: number): string {
  return \`\${Math.round(value)}%\`;
}
`;

export const INDEX = `import { applyVolume } from "./player";

export function main(volume: number): string {
  const { label } = applyVolume(volume);
  return \`volume set to \${label}\`;
}
`;

// --- The fixture prompt set -------------------------------------------------
// Same frontmatter grammar as the lab's baseline set (agents/baseline/*.md in
// deep-review), but with MUCH shorter bodies:
//   - tools: Read, Grep, Glob — NO codegraph: the fixture repo has no
//     .codegraph index, so granting the tool would only buy failed calls.
//   - model: haiku — the eval proves PLUMBING (spawn, templating, extraction,
//     dedupe, refuter batch, telemetry), not recall quality; the cheapest
//     model that can read a 5-file repo is the right one.
// Bodies keep the {{PRIORS}}/{{GOTCHAS}} anchors so the driver-side
// templating path is exercised for real.

const RELIABILITY_AGENT = `---
name: deep-review-reliability
description: Fixture reliability hunter — value-contract tracing across the diff.
model: haiku
tools: Read, Grep, Glob
---

# Fixture Reliability Hunter

You review one diff in a small TypeScript repo. Your single mandate: trace
every VALUE that crosses the diff boundary — where it originates, its units,
and its numeric domain — and follow it to every consumer in the repo.

Report a finding whenever a producer and a consumer disagree about a value's
contract (units, scale, or range), even when each side looks locally correct.
State the contradiction concretely: what the producer now emits, and what the
consumer still assumes.

Codebase gotchas (authoritative):
{{GOTCHAS}}

Suspicion priors — start here:
{{PRIORS}}

You are read-only: inspect, never edit. If no value crosses the diff with a
contract mismatch, report no findings.
`;

const RESILIENCE_AGENT = `---
name: deep-review-resilience
description: Fixture resilience hunter — error and edge handling in the diff.
model: haiku
tools: Read, Grep, Glob
---

# Fixture Resilience Hunter

You review one diff in a small TypeScript repo. Your mandate: error and edge
handling only — inputs outside the expected domain (negative, NaN, out of
range), silent clamps that hide bad data, and failure paths that swallow a
wrong value instead of surfacing it.

Codebase gotchas (authoritative):
{{GOTCHAS}}

Suspicion priors — start here:
{{PRIORS}}

You are read-only: inspect, never edit. Report only defects you can point to
in the code; an empty findings list is a valid result.
`;

// Trivial by design: the eval runs with parity un-triggered, so this body
// exists to satisfy the prompt-set contract (AGENT_NAMES requires the file),
// not to hunt.
const PARITY_AGENT = `---
name: deep-review-parity
description: Fixture parity hunter — duplicated-implementation drift.
model: haiku
tools: Read, Grep, Glob
---

# Fixture Parity Hunter

Compare duplicated implementations touched by the diff. This fixture has
none, so an empty findings list is the expected result.

Codebase gotchas (authoritative):
{{GOTCHAS}}

Suspicion priors:
{{PRIORS}}
`;

// The refuter body carries no {{PRIORS}}/{{GOTCHAS}} anchors — the pipeline
// writes it as-is (see runRefuter in src/review/pipeline.ts).
const REFUTER_AGENT = `---
name: review-refuter
description: Fixture refuter — verifies each submitted finding against the code.
model: haiku
tools: Read, Grep, Glob
---

# Fixture Refuter

You receive a batch of findings, each with an id, location, claim, and proof
refs. For every finding, open the cited code and decide whether the claim
holds: \`corroborated\` when the code confirms it, \`refuted\` when the code
contradicts it, \`inconclusive\` when you cannot tell. Verify against the
code, never against the claim's own confidence. Return the mandated results
JSON with exactly one verdict per submitted finding id.
`;

const AGENT_SOURCES: Record<(typeof AGENT_NAMES)[number], string> = {
  "deep-review-reliability": RELIABILITY_AGENT,
  "deep-review-resilience": RESILIENCE_AGENT,
  "deep-review-parity": PARITY_AGENT,
  "review-refuter": REFUTER_AGENT,
};

export const GOTCHAS = `- Volume values are 0-1 gain fractions everywhere in this codebase.
- The audio engine hard-rejects gain above unity; clamps must stay no-ops.
- Display code owns percentage formatting; nothing else scales by 100.
`;

export async function buildPlantedFixture(): Promise<PlantedFixture> {
  const base = await mkdtemp(path.join(tmpdir(), "pr-hero-fixture-"));
  // Everything EXCEPT the repo lives as a sibling of it: the hunters' cwd is
  // repoDir, and prompts/artifacts inside the repo would show up in Grep
  // results — the fixture would leak its own answer key.
  const repoDir = path.join(base, "repo");
  const agentsDir = path.join(base, "agents");
  const runDir = path.join(base, "run");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  await mkdir(agentsDir);
  await mkdir(runDir);

  // Commit 1 — the correct project.
  await writeFile(path.join(repoDir, "README.md"), README);
  await writeFile(path.join(repoDir, "src", "volume.ts"), VOLUME_CORRECT);
  await writeFile(path.join(repoDir, "src", "player.ts"), PLAYER);
  await writeFile(path.join(repoDir, "src", "format.ts"), FORMAT);
  await writeFile(path.join(repoDir, "src", "index.ts"), INDEX);
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "feat: volume pipeline"]);
  const baseSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

  // Commit 2 (the head) — plant the defect in the producer only, so the diff
  // is exactly the changed contract and the consumer contradiction is only
  // visible by following the value out of the diff.
  await writeFile(path.join(repoDir, "src", "volume.ts"), VOLUME_BUGGY);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, [
    "commit",
    "-q",
    "-m",
    "refactor: simplify volume scaling",
  ]);
  const headSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

  const diffPath = path.join(base, "diff.patch");
  await writeFile(diffPath, await git(repoDir, ["diff", baseSha, headSha]));

  for (const name of AGENT_NAMES) {
    await writeFile(path.join(agentsDir, `${name}.md`), AGENT_SOURCES[name]);
  }

  const gotchasPath = path.join(base, "gotchas.md");
  await writeFile(gotchasPath, GOTCHAS);

  // Answer key: the whole buggy volume.ts (it is tiny — every line of it IS
  // the planted contract change). Derived from the source string so an edit
  // to the fixture can never silently desync the range.
  const expected = {
    path: "src/volume.ts",
    lineMin: 1,
    lineMax: VOLUME_BUGGY.trimEnd().split("\n").length,
  };
  await writeFile(
    path.join(base, "expected.json"),
    `${JSON.stringify(expected, null, 2)}\n`,
  );

  return {
    repoDir,
    baseSha,
    headSha,
    diffPath,
    agentsDir,
    gotchasPath,
    runDir,
    expected,
  };
}
