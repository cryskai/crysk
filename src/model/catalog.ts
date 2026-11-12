import anthropicCatalog from "../../config/models/anthropic.json";
import type { RunnerBackend } from "../execution/contracts";
import { FALLBACK_PROFILE, profileRoleEffort } from "./profiles";

// #175, 2026-09-02. This catalogue holds ALIAS NAMES and nothing else.
//
// WHY it used to hold more, and why that was the last version pin in the
// system: every alias carried `modelFamily`/`modelSnapshot` (`sonnet` ->
// `claude-sonnet-5`). That pin never decided what RAN — the bare alias reaches
// `--model` and the Claude CLI resolves it itself (verified live 2026-09-02:
// `--model sonnet` ran `claude-sonnet-5`).
// It decided only what we ASSERTED had run, in `ResolvedModelRoute`, the route
// fingerprint and `pipeline.json`. So the day Anthropic repointed an alias,
// the CLI would run the new model and our provenance artifact would state the
// old snapshot — a false statement about what ran, in the artifact whose only
// job is to say what ran, arrived at silently. And every model release became
// a release of ours.
//
// WHAT SURVIVES, and why it is legitimately ours: the alias LIST. That
// `sonnet|opus|haiku` are accepted as bare model names is a pr-hero UX
// convention. What they resolve to is the provider's business, and a wrong
// name now fails AT THE PROVIDER — an error from the party that knows is more
// honest than a mapping of ours that pretends to.
//
// The operator can still pin: `claude:<full model name>` in `models` reaches
// `--model` as written (model/model-name.ts). Pinning is a decision an operator
// makes, not a constant we ship. The `-latest` names are these aliases.
export interface ProviderModelCatalog {
  readonly provider: string;
  readonly defaultBackend?: RunnerBackend;
  readonly aliases: readonly string[];
}

export interface ResolvedCatalogAlias {
  readonly provider: string;
  readonly alias: string;
  readonly canonical: string;
  readonly defaultBackend?: RunnerBackend;
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`model catalog: ${label} must be a non-empty string`);
  }
}

function normalizeProviderCatalog(raw: unknown): ProviderModelCatalog {
  if (!raw || typeof raw !== "object") {
    throw new Error("model catalog: provider entry must be an object");
  }
  const record = raw as Record<string, unknown>;
  assertNonEmptyString(record.provider, "provider");
  if (
    record.defaultBackend !== undefined &&
    typeof record.defaultBackend !== "string"
  ) {
    throw new Error("model catalog: defaultBackend must be a string");
  }
  // An ARRAY now, where it used to be an object of alias -> model. The shape
  // change is the point: there is no longer a second field per alias for a
  // version to hide in, so no future edit can quietly re-pin one.
  if (!Array.isArray(record.aliases)) {
    throw new Error(
      `model catalog: ${record.provider} aliases must be an array`,
    );
  }

  const aliases: string[] = [];
  for (const alias of record.aliases) {
    assertNonEmptyString(alias, `${record.provider}.alias`);
    aliases.push(alias);
  }

  if (aliases.length === 0) {
    throw new Error(`model catalog: ${record.provider} must define aliases`);
  }

  return {
    provider: record.provider as string,
    ...(record.defaultBackend === undefined
      ? {}
      : { defaultBackend: record.defaultBackend as RunnerBackend }),
    aliases: Object.freeze(aliases),
  };
}

// The logical identity an alias parses to. `provider/alias`, not
// `provider/version` — the canonical form now names what the operator asked
// for, which is a fact, instead of a version nobody verified.
function canonicalIdentity(provider: string, alias: string): string {
  return `${provider}/${alias}`;
}

const PROVIDER_CATALOGS = {
  anthropic: normalizeProviderCatalog(anthropicCatalog),
} as const satisfies Record<string, ProviderModelCatalog>;

export const MODEL_CATALOG = Object.freeze({
  providers: PROVIDER_CATALOGS,
});

const aliasIndex = new Map<string, ResolvedCatalogAlias>();

for (const catalog of Object.values(PROVIDER_CATALOGS)) {
  for (const alias of catalog.aliases) {
    if (aliasIndex.has(alias)) {
      throw new Error(`model catalog: duplicate alias "${alias}"`);
    }
    const canonical = canonicalIdentity(catalog.provider, alias);
    aliasIndex.set(alias, {
      provider: catalog.provider,
      alias,
      canonical,
      ...(catalog.defaultBackend === undefined
        ? {}
        : { defaultBackend: catalog.defaultBackend }),
    });
  }
}

export type ModelAlias = "sonnet" | "opus" | "haiku" | "fable";

// Unchanged by #175, and the reason it is unchanged is the whole point of the
// slice: the alias LIST is ours, so a config that drops one still has to fail
// loud at import. `ModelAlias` is a compile-time union and the JSON is a
// runtime file; without this loop a deleted alias would typecheck and then
// throw `unknown alias` deep inside a run.
const REQUIRED_ALIASES: readonly ModelAlias[] = [
  "sonnet",
  "opus",
  "haiku",
  "fable",
];
for (const alias of REQUIRED_ALIASES) {
  if (!aliasIndex.has(alias)) {
    throw new Error(`model catalog: missing required alias "${alias}"`);
  }
}

export function isModelAlias(value: string): value is ModelAlias {
  return aliasIndex.has(value);
}

export function allModelAliases(): readonly ModelAlias[] {
  return Object.freeze([...aliasIndex.keys()] as ModelAlias[]);
}

export function lookupAlias(alias: ModelAlias): ResolvedCatalogAlias {
  const entry = aliasIndex.get(alias);
  if (entry === undefined) {
    throw new Error(`model catalog: unknown alias "${alias}"`);
  }
  return entry;
}

export function aliasCanonical(alias: ModelAlias): string {
  return lookupAlias(alias).canonical;
}

// The Claude Code CLI's `--effort` vocabulary, closed. Lives beside
// `ModelAlias` because the pair is what a step is asked to run as: a model and
// how hard it works. An unknown level must fail at the frontmatter seam, not
// reach the CLI, which would reject it (or ignore it) after the run is paid for.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function isEffort(value: string): value is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

// Which kind of step is being built. Wider than `AgentSpec.role` on purpose:
// the summarizer, scout and rereview verifier are steps too, and each needs a
// resolved level, not an implicit one. `other` is for ad hoc steps (judges,
// probes) built outside the pipeline.
export type StepRole =
  | "hunter"
  | "refuter"
  | "summarizer"
  | "scout"
  | "verifier"
  | "other";

// The per-role effort table: the fallback when a prompt's frontmatter omits
// `effort:`, so a custom or lab prompt set still runs at an EXPLICIT level.
// The levels a profile assigns are read from the `claude` profile
// (src/model/profiles.ts), the one place they are chosen; `verifier` and
// `other` have no profile role and stay here.
//
// WHY the engine owns this at all (#299, 2026-10-02): pr-hero never passed
// `--effort`, so every step ran at the CLI's implicit default, which is `high`
// except on Sonnet 5.5 and Opus 5.5, where it is `medium`
// (https://code.claude.com/docs/en/model-config). When the `sonnet` alias moved
// to 5.5 the hunters silently dropped a level and stopped exploring.
//
// Measured on musive pr-1858 (Sonnet 5.5, 4 hunters x 2 replicates):
//   medium 0/8 runs with findings (0.5 min), high 6/8 (1.5 min),
//   xhigh 8/8 and all 4 known bugs (4.5 min), max 7/8 (19 min).
//   - hunter  xhigh: the cheapest level that found everything.
//   - refuter high: refuter-probe 16/16 at medium was NOT sufficient. On the
//     real pr-1858 xhigh findings the Opus refuter at medium returned
//     `refuted` on the pre-labeled known `updateProject` BLOCKER in 3 of 4
//     verdicts, which deletes it; at high it was `downgraded-latent` (kept, as
//     advisory) in 3 of 4 and refuted in 1 of 4. The other 5 findings got the
//     same verdicts at both levels, and the original Sonnet-5-at-high refuter
//     corroborated that finding. The cost is a refuter leg of ~140s instead of
//     ~90s. The probe plants claims with a known verdict; it cannot see a
//     real finding being talked out of existence, which is what this gate did.
//   - everything else high: unmeasured, so it keeps what every model ran at
//     before the 5.5 family, i.e. the behavior those roles were validated under.
const ROLE_EFFORT: Readonly<Record<StepRole, Effort>> = Object.freeze({
  hunter: profileRoleEffort(FALLBACK_PROFILE, "hunter"),
  refuter: profileRoleEffort(FALLBACK_PROFILE, "refuter"),
  summarizer: profileRoleEffort(FALLBACK_PROFILE, "summary"),
  scout: profileRoleEffort(FALLBACK_PROFILE, "scout"),
  verifier: "high",
  other: "high",
});

export function defaultEffortForRole(role: StepRole): Effort {
  return ROLE_EFFORT[role];
}

export function providerCatalog(
  provider: keyof typeof PROVIDER_CATALOGS,
): ProviderModelCatalog {
  return PROVIDER_CATALOGS[provider];
}
