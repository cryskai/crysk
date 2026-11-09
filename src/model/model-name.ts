// The model names an operator writes, and the roles they are assigned to
// (odd/tasks/role-model-routing.md S1, S3).
//
// WHY a model name carries its backend in a prefix: the old routing keyed every
// assignment by a Claude alias (`sonnet`), so "which step" and "which model"
// were the same word, and a hunter could not get a model of its own. A name is
// now self-describing — `claude:<name>` runs on the Claude Code CLI,
// `opencode:<provider>/<model>` on OpenCode — and the role it is assigned to
// (`hunter.logic`, `summary`) is a separate key. How hard the model works is
// not part of its name: it is a list entry's `effort` (S7, below).
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
import { looksLikeCredential, redactConfigValue } from "../security/redact";
import {
  EFFORT_LEVELS,
  isEffort,
  isModelAlias,
  type ModelAlias,
} from "./catalog";

export class ModelNameError extends Error {}

export interface ModelName {
  // The name as written, e.g. `claude:sonnet-latest`.
  readonly raw: string;
  readonly backend: RunnerBackend;
  readonly provider: string;
  // What reaches the backend: the CLI alias (`sonnet`) or pinned id for
  // Claude, the provider's model id for OpenCode.
  readonly model: string;
  // Set for the `-latest` names only.
  readonly alias?: ModelAlias;
}

const CLAUDE_PREFIX = "claude:";
const OPENCODE_PREFIX = "opencode:";
const LATEST_SUFFIX = "-latest";

// A pinned Claude id: `claude-` and then lowercase letters, digits, dots and
// dashes (`claude-sonnet-5-5`, `claude-sonnet-4.5-20250929`).
const CLAUDE_ID_RE = /^claude-[a-z0-9.-]+$/;
// `provider/model`. The provider runs to the first slash; the model may hold
// more slashes, because some OpenCode providers (openrouter) name models as
// `vendor/model`.
const OPENCODE_RE =
  /^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)$/;
// An OpenCode variant name, which is what an OpenCode entry's effort becomes:
// provider-specific (Anthropic `high`/`max`, OpenAI `none`..`xhigh`, Google
// `low`/`high`, per https://opencode.ai/docs/models/ "Variants"), so the engine
// keeps no table of them and checks the shape only. The characters the removed
// `#variant` suffix allowed, with a length cap.
const OPENCODE_EFFORT_RE = /^[a-zA-Z0-9._-]{1,64}$/;

const CLAUDE_FORMS =
  "claude:sonnet-latest, claude:opus-latest, claude:haiku-latest, claude:fable-latest or a full claude-* model name";
const OPENCODE_FORM = "opencode:<provider>/<model>";

// Every message quotes the name through redactConfigValue: a config value is
// echoed back to a terminal and a CI log, and a pasted key must not be.
function quoted(raw: string): string {
  return `"${redactConfigValue(raw)}"`;
}

// A model name looks like a credential when the whole name does, any of its
// `:`/`/` segments does, or the text after any `:` or `/` does:
// `opencode:deepseek/<key>` parses as an OpenCode name, so a whole-value check
// alone would let it through, and a base64 key can itself contain `/`.
function nameLooksLikeCredential(raw: string): boolean {
  const parts = raw.split(/[:/]/);
  for (const [i, ch] of [...raw].entries()) {
    if (ch === ":" || ch === "/") parts.push(raw.slice(i + 1));
  }
  return looksLikeCredential(raw) || parts.some(looksLikeCredential);
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
  const [, provider, model] = match;
  return { raw, backend: "opencode", provider, model };
}

// The removed `#variant` suffix (S7: "the old `#variant` suffix goes away so
// there is one concept"). Refused wherever a model is written (`models`,
// `--model`, the CI `model` input, a spec's model), and when the name before
// the `#` is a valid one the message is the entry to write instead.
function refuseVariantSuffix(raw: string): void {
  const at = raw.indexOf("#");
  if (at < 0) return;
  const base = raw.slice(0, at);
  const effort = raw.slice(at + 1);
  if (!OPENCODE_EFFORT_RE.test(effort)) return;
  try {
    parseModelName(base);
  } catch {
    return;
  }
  throw new ModelNameError(
    `${quoted(raw)}: the #variant suffix is gone: write {"model": ${JSON.stringify(base)}, "effort": ${JSON.stringify(effort)}} in models`,
  );
}

// A model name as an operator wrote it in `models`, `--model` or the CI input.
export function parseModelName(raw: string): ModelName {
  if (typeof raw !== "string") {
    throw new ModelNameError("a model name must be a string");
  }
  // The deny-list the old `routing` parser applied to its values, kept for
  // the values that replaced them: the OpenCode grammar admits the characters
  // of most API keys, so a key pasted as a model would otherwise parse.
  if (nameLooksLikeCredential(raw)) {
    throw new ModelNameError(
      "a model name looks like a credential, and credentials are not permitted in models",
    );
  }
  refuseVariantSuffix(raw);
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

// A `models` list entry as written (S7): a model name, or the name with how
// hard it works, `{"model": "claude:opus-latest", "effort": "max"}`. Kept as
// written, so a config read and written back is unchanged; readers go through
// modelEntry, so a string and an object with no effort read the same.
export type ModelListEntry =
  | string
  | { readonly model: string; readonly effort?: string };

// An entry as every reader sees it.
export interface ModelEntry {
  readonly name: string;
  readonly effort?: string;
}

export function modelEntry(entry: ModelListEntry): ModelEntry {
  if (typeof entry === "string") return { name: entry };
  return entry.effort === undefined
    ? { name: entry.model }
    : { name: entry.model, effort: entry.effort };
}

const ENTRY_KEYS = ["model", "effort"];
const ENTRY_FORM = '{"model": "<name>", "effort": "<level>"}';
// `--effort ultracode` is not a level: on the Claude Code CLI it also turns on
// workflow orchestration and runs at xhigh
// (https://code.claude.com/docs/en/model-config "Adjust effort level"). A review
// step is one bounded turn, so it is refused by name rather than with the list.
const ULTRACODE = "ultracode";

function levelList(): string {
  return `${EFFORT_LEVELS.slice(0, -1).join(", ")} or ${EFFORT_LEVELS.at(-1)}`;
}

// The effort an entry sets, checked against the backend its model runs on.
// Claude: the CLI's `--effort` vocabulary, closed. OpenCode: a variant name,
// open (OPENCODE_EFFORT_RE), and run through the same credential check as a
// model name, because its grammar admits the characters of most API keys.
function checkEffort(effort: unknown, name: ModelName, at: string): string {
  if (typeof effort !== "string") {
    throw new ModelNameError(`${at}: effort must be a string`);
  }
  if (looksLikeCredential(effort)) {
    throw new ModelNameError(
      `${at}: the effort looks like a credential, and credentials are not permitted in models`,
    );
  }
  if (name.backend === "claude-code") {
    if (effort === ULTRACODE) {
      throw new ModelNameError(
        `${at}: effort "${ULTRACODE}" is not an effort level: on the Claude Code CLI it also turns on workflow orchestration. Write "xhigh" for its effort level`,
      );
    }
    if (!isEffort(effort)) {
      throw new ModelNameError(
        `${at}: effort ${quoted(effort)} is not a Claude effort level: use ${levelList()}`,
      );
    }
    return effort;
  }
  if (!OPENCODE_EFFORT_RE.test(effort)) {
    throw new ModelNameError(
      `${at}: effort ${quoted(effort)} is not an OpenCode variant name: use letters, digits, ".", "_" and "-", at most 64 characters`,
    );
  }
  return effort;
}

function parseModelEntry(
  value: unknown,
  at: string,
  effortAllowed: string | undefined,
): ModelListEntry {
  if (typeof value === "string") {
    try {
      parseModelName(value);
    } catch (error) {
      throw new ModelNameError(`${at}: ${(error as Error).message}`);
    }
    return value;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelNameError(`${at} must be a model name or ${ENTRY_FORM}`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ENTRY_KEYS.includes(key)) {
      throw new ModelNameError(
        `${at} has an unknown key ${quoted(key)}: an entry takes model and effort`,
      );
    }
  }
  if (record.model === undefined) {
    throw new ModelNameError(`${at} needs a "model"`);
  }
  let name: ModelName;
  try {
    name = parseModelName(record.model as string);
  } catch (error) {
    throw new ModelNameError(`${at}: ${(error as Error).message}`);
  }
  if (record.effort === undefined) return { model: name.raw };
  if (effortAllowed !== undefined) {
    throw new ModelNameError(`${at} sets an effort: ${effortAllowed}`);
  }
  return { model: name.raw, effort: checkEffort(record.effort, name, at) };
}

// One role's list: non-empty, no repeats, at most three, every entry valid.
// Kept as the operator wrote it, so a config round-trips unchanged. A model
// named twice is refused even with two efforts (D2): the second would run only
// when the first fails, and a provider failure does not depend on effort.
export function parseModelList(
  value: unknown,
  where: string,
  // Why this list takes no effort, when it takes none (`models.judge`).
  noEffortReason?: string,
): ModelListEntry[] {
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
  const result: ModelListEntry[] = [];
  for (const [i, value_] of value.entries()) {
    const entry = parseModelEntry(value_, `${where}[${i}]`, noEffortReason);
    const { name } = modelEntry(entry);
    if (seen.has(name)) {
      throw new ModelNameError(`${where} lists ${quoted(name)} twice`);
    }
    seen.add(name);
    result.push(entry);
  }
  return result;
}

export type ModelsConfig = Readonly<Record<string, readonly ModelListEntry[]>>;

// D3: the judge was measured on its prompt's own effort; a different one is
// a different, unmeasured judge (see MEASURED_JUDGE_MODELS in routing.ts).
const JUDGE_NO_EFFORT =
  "the materiality judge runs at the effort it was measured at, so models.judge takes model names only";

const ROLE_LIST =
  "default, hunter.<key>, consolidate, scout, judge, refuter, summary";

export function parseModelsConfig(value: unknown): ModelsConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelNameError(
      "models must be an object from role to a list of models",
    );
  }
  const result: Record<string, ModelListEntry[]> = {};
  for (const [role, list] of Object.entries(value)) {
    if (!isModelRole(role)) {
      throw new ModelNameError(
        `models has an unknown role ${quoted(role)}: roles are ${ROLE_LIST}`,
      );
    }
    result[role] = parseModelList(
      list,
      `models.${role}`,
      role === "judge" ? JUDGE_NO_EFFORT : undefined,
    );
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
    list.some((entry) => modelEntry(entry).name.startsWith(OPENCODE_PREFIX)),
  );
}
