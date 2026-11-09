// The model names an operator writes, and the roles they are assigned to
// (odd/tasks/role-model-routing.md S1, S3).
//
// WHY a model name carries its backend in a prefix: the old routing keyed every
// assignment by a Claude alias (`sonnet`), so "which step" and "which model"
// were the same word, and a hunter could not get a model of its own. A name is
// now self-describing — `claude:<name>` runs on the Claude Code CLI,
// `opencode:<provider>/<model>[#variant]` on OpenCode — and the role it is
// assigned to (`hunter.logic`, `summary`) is a separate key.
//
// WHY `-latest` and not the bare alias: Juanma, on "sonnet-latest": "explicito
// seria mas claro definitivamente". The Claude Code CLI aliases point to the
// newest version and move over time; a full `claude-*` id pins one
// (https://code.claude.com/docs/en/model-config: "Aliases point to the
// recommended version for your provider and update over time. To pin to a
// specific version, use the full model name"). A bare `claude:sonnet` is
// refused rather than guessed, so nobody reads it as a pin.
//
// Prompt frontmatter, the lab's PipelineInput.model and diversity models keep
// their bare aliases (`sonnet`): they are internal inputs, and
// `modelNameFromAlias` is the one place they become a model name.

import type { RunnerBackend } from "../execution/contracts";
import { redactDiagnostic } from "../security/redact";
import { isModelAlias, type ModelAlias } from "./catalog";

export class ModelNameError extends Error {}

export interface ModelName {
  // The name as written, e.g. `claude:sonnet-latest`.
  readonly raw: string;
  readonly backend: RunnerBackend;
  readonly provider: string;
  // What reaches the backend: the CLI alias (`sonnet`) or pinned id for
  // Claude, the provider's model id for OpenCode.
  readonly model: string;
  readonly variant?: string;
  // Set for the `-latest` names only.
  readonly alias?: ModelAlias;
}

const CLAUDE_PREFIX = "claude:";
const OPENCODE_PREFIX = "opencode:";
const LATEST_SUFFIX = "-latest";

// A pinned Claude id: `claude-` and then lowercase letters, digits, dots and
// dashes (`claude-sonnet-5-5`, `claude-sonnet-4.5-20250929`).
const CLAUDE_ID_RE = /^claude-[a-z0-9.-]+$/;
// `provider/model[#variant]`. The provider runs to the first slash; the model
// may hold more slashes, because some OpenCode providers (openrouter) name
// models as `vendor/model`.
const OPENCODE_RE =
  /^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)(?:#([a-zA-Z0-9._-]+))?$/;

const CLAUDE_FORMS =
  "claude:sonnet-latest, claude:opus-latest, claude:haiku-latest, claude:fable-latest or a full claude-* model name";
const OPENCODE_FORM = "opencode:<provider>/<model>[#variant]";

// Every message quotes the name through redactDiagnostic: a config value is
// echoed back to a terminal and a CI log, and a pasted key must not be.
function quoted(raw: string): string {
  return `"${redactDiagnostic(raw)}"`;
}

function parseClaudeName(raw: string, name: string): ModelName {
  if (name.endsWith(LATEST_SUFFIX)) {
    const alias = name.slice(0, -LATEST_SUFFIX.length);
    if (isModelAlias(alias)) {
      return {
        raw,
        backend: "claude-code",
        provider: "anthropic",
        model: alias,
        alias,
      };
    }
  }
  if (isModelAlias(name)) {
    throw new ModelNameError(
      `${quoted(raw)} is not a model name: write "claude:${name}-latest" for the newest ${name}, or a full name such as "claude-${name}-5-5" to pin a version`,
    );
  }
  if (CLAUDE_ID_RE.test(name) && !name.endsWith("-")) {
    return { raw, backend: "claude-code", provider: "anthropic", model: name };
  }
  throw new ModelNameError(
    `${quoted(raw)} is not a Claude model name: use ${CLAUDE_FORMS}`,
  );
}

function parseOpenCodeName(raw: string, name: string): ModelName {
  const match = name.match(OPENCODE_RE);
  if (match === null) {
    throw new ModelNameError(
      `${quoted(raw)} is not an OpenCode model name: use ${OPENCODE_FORM}`,
    );
  }
  const [, provider, model, variant] = match;
  return {
    raw,
    backend: "opencode",
    provider,
    model,
    ...(variant === undefined ? {} : { variant }),
  };
}

// A model name as an operator wrote it in `models`, `--model` or the CI input.
export function parseModelName(raw: string): ModelName {
  if (typeof raw !== "string") {
    throw new ModelNameError("a model name must be a string");
  }
  // The deny-list the old `routing` parser applied to its values, kept for
  // the values that replaced them: the OpenCode grammar admits the characters
  // of most API keys, so a key pasted as a model would otherwise parse.
  if (redactDiagnostic(raw) !== raw) {
    throw new ModelNameError(
      "a model name looks like a credential, and credentials are not permitted in models",
    );
  }
  if (raw.startsWith(CLAUDE_PREFIX)) {
    return parseClaudeName(raw, raw.slice(CLAUDE_PREFIX.length));
  }
  if (raw.startsWith(OPENCODE_PREFIX)) {
    return parseOpenCodeName(raw, raw.slice(OPENCODE_PREFIX.length));
  }
  if (isModelAlias(raw)) {
    throw new ModelNameError(
      `${quoted(raw)} is not a model name: write "claude:${raw}-latest"`,
    );
  }
  throw new ModelNameError(
    `${quoted(raw)} is not a model name: a model is "claude:<name>" or "${OPENCODE_FORM}"`,
  );
}

// THE one conversion point for internal inputs (prompt frontmatter, the lab's
// PipelineInput.model, diversity models): a bare alias means its `-latest`
// name, which is what the CLI ran for it before this change. Anything else must
// already be a full model name.
export function modelNameFromAlias(value: string): ModelName {
  const trimmed = value.trim();
  if (isModelAlias(trimmed)) {
    return parseModelName(`${CLAUDE_PREFIX}${trimmed}${LATEST_SUFFIX}`);
  }
  return parseModelName(trimmed);
}

// The roles a model can be assigned to (S1). `refuter` covers the verifier and
// the adjudicator too: the three judge one finding against the code, and the
// verifier and adjudicator run the refuter's prompt family. `judge` is the
// materiality judge. Hunters are open: `hunter.<key>` for any hunter key the
// review spec declares, checked against the spec when the plan is built.
export const FIXED_MODEL_ROLES = [
  "default",
  "consolidate",
  "scout",
  "judge",
  "refuter",
  "summary",
] as const;
export type FixedModelRole = (typeof FIXED_MODEL_ROLES)[number];

const HUNTER_ROLE_PREFIX = "hunter.";
// The same slug validateReviewSpec requires of an agent key.
const HUNTER_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function hunterRole(key: string): string {
  return `${HUNTER_ROLE_PREFIX}${key}`;
}

export function isModelRole(value: string): boolean {
  if ((FIXED_MODEL_ROLES as readonly string[]).includes(value)) return true;
  if (!value.startsWith(HUNTER_ROLE_PREFIX)) return false;
  const key = value.slice(HUNTER_ROLE_PREFIX.length);
  return key.length <= 64 && HUNTER_KEY_RE.test(key);
}

// At most three per role (L6 item 7): a fallback chain longer than that is a
// bill nobody planned, and the next model is tried only on provider failures.
export const MAX_MODELS_PER_ROLE = 3;

// One role's list: non-empty, no repeats, at most three, every name valid.
// Kept as the strings the operator wrote, so a config round-trips unchanged.
export function parseModelList(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    throw new ModelNameError(`${where} must be a list of models`);
  }
  if (value.length === 0) {
    throw new ModelNameError(`${where} must list at least one model`);
  }
  if (value.length > MAX_MODELS_PER_ROLE) {
    throw new ModelNameError(
      `${where} lists ${value.length} models: at most ${MAX_MODELS_PER_ROLE} are allowed`,
    );
  }
  const seen = new Set<string>();
  for (const [i, entry] of value.entries()) {
    try {
      parseModelName(entry as string);
    } catch (error) {
      throw new ModelNameError(`${where}[${i}]: ${(error as Error).message}`);
    }
    if (seen.has(entry)) {
      throw new ModelNameError(`${where} lists ${quoted(entry)} twice`);
    }
    seen.add(entry);
  }
  return [...value] as string[];
}

export type ModelsConfig = Readonly<Record<string, readonly string[]>>;

const ROLE_LIST =
  "default, hunter.<key>, consolidate, scout, judge, refuter, summary";

export function parseModelsConfig(value: unknown): ModelsConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelNameError(
      "models must be an object from role to a list of models",
    );
  }
  const result: Record<string, string[]> = {};
  for (const [role, list] of Object.entries(value)) {
    if (!isModelRole(role)) {
      throw new ModelNameError(
        `models has an unknown role ${quoted(role)}: roles are ${ROLE_LIST}`,
      );
    }
    result[role] = parseModelList(list, `models.${role}`);
  }
  return result;
}

// Whether any configured model runs on OpenCode, so the OpenCode SDK must be
// installed. Replaces the old routing check, read by `crysk doctor`,
// `crysk upgrade --reconcile` and the platform connect step: without it an
// OpenCode user would silently lose the SDK install.
export function modelsNeedOpenCode(models: ModelsConfig | undefined): boolean {
  if (models === undefined) return false;
  return Object.values(models).some((list) =>
    list.some((name) => name.startsWith(OPENCODE_PREFIX)),
  );
}
