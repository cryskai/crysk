// Prompt-set loading, ported from deep-review runner/session.ts. In v1 these
// files were assembled into an inline `--agents` registry for the orchestrator
// session's Task tool; in v2 each agent body IS a step's system prompt, so the
// frontmatter parsing survives while the JSON registry assembly is gone — and
// the {{PRIORS}}/{{GOTCHAS}} templating the orchestrator prose used to do at
// spawn time moves into the driver (renderAgentBody).

import { EFFORT_LEVELS, type Effort, isEffort } from "#model/catalog";
import { wrapBlock } from "./boundary";

// Fixed order — the lab's promptSetFingerprint hashes the concatenated files
// in exactly this sequence, so reordering here would silently move every
// recorded fingerprint. The names are the file basenames inside a prompt-set
// directory (`agents/<set>/<name>.md`).
export const AGENT_NAMES = [
  "deep-review-reliability",
  "deep-review-resilience",
  "deep-review-parity",
  "review-refuter",
] as const;

export interface ParsedAgent {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  // Optional `effort:` key. Absent means "use the engine's per-role default"
  // (defaultEffortForRole), never "use the CLI's implicit one".
  effort?: Effort;
  // Everything below the frontmatter block — the step's system prompt.
  body: string;
}

// Same minimal frontmatter grammar as v1: a leading `---` block with
// single-line `key: value` fields. Deliberately not a YAML parser — the agent
// files are ours, and a stricter grammar keeps a malformed set failing loudly
// instead of half-parsing.
export function parseAgentSource(raw: string): ParsedAgent {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error("agent file has no frontmatter block");
  }
  const [, frontmatter, body] = match;
  const field = (key: string): string | undefined => {
    const line = frontmatter.split("\n").find((l) => l.startsWith(`${key}:`));
    return line
      ?.slice(key.length + 1)
      .trim()
      .replace(/^"|"$/g, "");
  };
  const name = field("name");
  if (!name) throw new Error("agent file has no name field");
  const tools = field("tools");
  const model = field("model");
  const effort = field("effort");
  // Present-but-empty is malformed, not an omission (unlike `model:`): an
  // `effort:` line is someone choosing a level, and silently dropping it would
  // put the step on the engine default while the file reads as overridden.
  if (effort !== undefined && !isEffort(effort)) {
    throw new Error(
      `agent file declares effort "${effort}"; expected one of ${EFFORT_LEVELS.join(", ")}`,
    );
  }
  return {
    name,
    description: field("description") ?? name,
    tools: tools ? tools.split(",").map((t) => t.trim()) : [],
    ...(model ? { model } : {}),
    ...(effort === undefined ? {} : { effort }),
    body: body.trim(),
  };
}

export async function parseAgentFile(filePath: string): Promise<ParsedAgent> {
  const raw = await Bun.file(filePath).text();
  try {
    return parseAgentSource(raw);
  } catch (error) {
    // parseAgentSource sees bytes, not a path, so the file is named here: a
    // preflight failure that does not say WHICH of six prompt files is wrong
    // sends the reader grepping.
    throw new Error(
      `${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface SuspicionPrior {
  path: string;
  // The live config carries prose weights ("maximum", "high"), not numbers;
  // rendering only interpolates, so both pass through untouched.
  weight: number | string;
  reason: string;
}

// Exported because the driver needs the SAME bytes twice: once here, to fill
// the {{PRIORS}} anchor, and once at nonce-selection time, to prove the run's
// boundary nonce does not already occur inside the block it is about to wrap
// (C4 O-3.3). Rendering priors twice with two spellings would let the check
// pass on a string the prompt never carries.
export function renderPriorsBlock(priors: SuspicionPrior[]): string {
  return priors
    .map((p) => `- ${p.path} (weight ${p.weight}): ${p.reason}`)
    .join("\n");
}

// Prose Step 4's two dynamic sections, now driver-side: {{PRIORS}} becomes a
// bullet list of the config's suspicion_priors, {{GOTCHAS}} the verbatim
// gotchas content — placed wherever the agent body anchors them (the baseline
// bodies put gotchas ahead of the diff, per the spec's injection requirement).
//
// Both land inside C4 boundary tags. Not because the operator is a threat —
// they are not — but because a uniform rule is enforceable and a rule with
// exceptions is a rule someone forgets (§3.4). `nonce` is REQUIRED, so a future
// caller cannot reach this substitution without one.
// The replacements are FUNCTIONS, not strings: a string replacement treats
// `$$`, `$&`, `` $` `` and `$'` as substitution patterns, so a gotchas or
// REVIEW.md line with Postgres dollar-quoting would be halved, or splice the
// body around the anchor into the block. A function's return is inserted as is.
export function renderAgentBody(
  body: string,
  context: { priors: SuspicionPrior[]; gotchas: string; nonce: string },
): string {
  const priors = wrapBlock(
    "priors",
    context.nonce,
    renderPriorsBlock(context.priors),
  );
  const gotchas = wrapBlock("gotchas", context.nonce, context.gotchas);
  return body
    .replaceAll("{{PRIORS}}", () => priors)
    .replaceAll("{{GOTCHAS}}", () => gotchas);
}

// The prompt set's identity, and the reason it exists is M6's central claim:
// "both arms ran the same prompt set" must be RECORDED, not believed. Ported
// byte-for-byte from the lab's `promptSetFingerprint` (deep-review
// runner/session.ts) — sha256 over the concatenated file TEXTS in the order
// given, truncated to 16 hex — so a fingerprint computed here and one computed
// there are the same string for the same bytes. Changing the algorithm, the
// truncation length, or the file order silently moves every fingerprint ever
// recorded on either side, which is why neither is a free choice.
//
// Order comes from the caller (the ReviewSpec's declaration order), never from
// a directory listing: same files, different order = different concatenation =
// different hash.
export async function promptSetFingerprint(files: string[]): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    hasher.update(await Bun.file(file).text());
  }
  return hasher.digest("hex").slice(0, 16);
}

export interface PromptSetIdentity {
  name: string;
  sha256: string;
}

// `name` is the agents DIRECTORY basename, which is what the lab's `arm-a` /
// `baseline` set names have always meant — two runs can share a fingerprint
// and differ in nothing else, so the name is a label and the sha is the fact.
//
// `name` overrides that derivation, and the compiled binary is why: its
// bundled set has no directory at all (the prompts are embedded at hashed,
// flattened paths, and `agentsDir` is a display label there). It must still
// report "default" — byte-identical to what dev and npm derive from
// `prompts/default` — or one prompt set would name itself three ways and every
// cross-run comparison of `prompt_set` would split into three rows. Passed
// explicitly rather than string-munged out of the label, because a label is
// prose and prose gets edited.
export async function promptSetIdentity(
  agentsDir: string,
  files: string[],
  name?: string,
): Promise<PromptSetIdentity> {
  return {
    name: name ?? agentsDir.replace(/\/+$/, "").split("/").pop() ?? agentsDir,
    sha256: await promptSetFingerprint(files),
  };
}
