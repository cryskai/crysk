// The product's names during the pr-hero → Crysk rename. Every contract
// writes the new name and, for one version, still reads the old one, so an
// install set up under pr-hero keeps working. Each legacy fallback lives here
// so the version that drops them deletes one module, not a hunt across src/.

const ENV_PREFIX = "CRYSK_";
const LEGACY_ENV_PREFIX = "PRHERO_";

export interface BrandEnvValue {
  value: string;
  // The variable that was read, so a message can name what the user set.
  name: string;
}

// Reads CRYSK_<suffix>, then PRHERO_<suffix>. The first non-empty value
// wins, so a CRYSK_ variable left empty during migration (a workflow `env:`
// entry wired to an unset repo variable) cannot hide the old install's value.
// When neither has a value but one is set, that one is returned as "", so a
// caller that only checks presence (NO_TUI) still sees it.
export function readBrandEnv(
  env: Record<string, string | undefined>,
  suffix: string,
): BrandEnvValue | undefined {
  let present: BrandEnvValue | undefined;
  for (const prefix of [ENV_PREFIX, LEGACY_ENV_PREFIX]) {
    const name = `${prefix}${suffix}`;
    const value = env[name];
    if (value === undefined) continue;
    if (value !== "") return { value, name };
    present ??= { value, name };
  }
  return present;
}

// Comment markers on PRs. Every marker constant is written in the new form
// (`<!-- crysk-<kind>`); the legacy form is derived from it here, so a reader
// passes the one constant it already has and still finds comments posted
// before the rename.
export const MARKER_OPEN = "<!-- crysk-";
const LEGACY_MARKER_OPEN = "<!-- pr-hero-";

// For a RegExp that must match either name: `^<!-- ${MARKER_BRAND_PATTERN}-report`.
export const MARKER_BRAND_PATTERN = "(?:crysk|pr-hero)";

function markerForms(prefix: string): string[] {
  if (!prefix.startsWith(MARKER_OPEN)) {
    throw new Error(`not a crysk marker prefix: ${JSON.stringify(prefix)}`);
  }
  return [prefix, LEGACY_MARKER_OPEN + prefix.slice(MARKER_OPEN.length)];
}

// The form `text` starts with, or undefined. Callers slice by the returned
// prefix's length: the two names differ in length.
export function matchMarkerPrefix(
  text: string,
  prefix: string,
): string | undefined {
  return markerForms(prefix).find((form) => text.startsWith(form));
}

// The earliest occurrence of either form anywhere in `text`, for markers that
// sit inside a larger comment (the summary's state and admission blocks).
export function findMarker(
  text: string,
  prefix: string,
): { index: number; prefix: string } | undefined {
  let best: { index: number; prefix: string } | undefined;
  for (const form of markerForms(prefix)) {
    const index = text.indexOf(form);
    if (index !== -1 && (best === undefined || index < best.index)) {
      best = { index, prefix: form };
    }
  }
  return best;
}

// PR comment commands. Every command constant is written in the new form
// (`/crysk review`); the legacy `/pr-hero` form is derived from it here, so
// a maintainer's muscle memory and old docs keep working for one version.
const COMMAND_PREFIX = "/crysk";
const LEGACY_COMMAND_PREFIX = "/pr-hero";

// Both written forms of a command, new name first. The workflow template
// lists each one, because an Actions expression cannot match a pattern.
export function commandForms(command: string): string[] {
  if (!command.startsWith(`${COMMAND_PREFIX} `)) {
    throw new Error(`not a crysk command: ${JSON.stringify(command)}`);
  }
  return [
    command,
    LEGACY_COMMAND_PREFIX + command.slice(COMMAND_PREFIX.length),
  ];
}

// Exact match after trimming, and nothing else: no case folding, no inner
// whitespace tolerance, no trailing words. A loose match is how a quoted reply
// would start a paid review.
export function isCommand(text: string, command: string): boolean {
  const trimmed = text.trim();
  return commandForms(command).includes(trimmed);
}

// For near-miss detection: the text begins like the command, in either name.
export function startsWithCommand(text: string, command: string): boolean {
  const trimmed = text.trim();
  return commandForms(command).some((form) => trimmed.startsWith(form));
}

// The legacy spelling of a command. Every workflow accepts it during the
// rename, including one set up before it, which filters only `/pr-hero`, so it
// is the one to name where there is room for a single spelling.
export function legacyCommand(command: string): string {
  return commandForms(command)[1] as string;
}

// Both spellings for a hint a person or an agent will act on. A workflow set
// up before the rename ignores `/crysk`, and floating action tags deliver the
// new hints to it, so a hint naming only `/crysk` would send the reader to a
// command that starts nothing.
export function commandHint(command: string, quote = "`"): string {
  return (
    `${quote}${command}${quote} (or ${quote}${legacyCommand(command)}${quote} ` +
    "on a workflow set up before the rename)"
  );
}

// Commit status contexts. The gate is a required check in users' branch
// protection, which names `pr-hero`; a head that stops getting that context
// blocks forever. So for one version every status is written on BOTH names, the
// new one first, and every reader treats the two as one gate. The version that
// drops the legacy name deletes LEGACY_STATUS_CONTEXT and the helpers below.
export const STATUS_CONTEXT = "crysk";
const LEGACY_STATUS_CONTEXT = "pr-hero";

// The context of a run that cannot move the gate: a local `review --pr` and the
// watcher. Its legacy form is `pr-hero/local`, derived the same way.
export const LOCAL_STATUS_CONTEXT = `${STATUS_CONTEXT}/local` as const;

// Both contexts a status written on `context` is published on, new name first.
// `context` is always a crysk context: a request is built in the new form, and the
// legacy form is derived from it here, as the marker and command helpers do.
export function statusContextForms(context: string): string[] {
  if (context !== STATUS_CONTEXT && !context.startsWith(`${STATUS_CONTEXT}/`)) {
    throw new Error(`not a crysk status context: ${JSON.stringify(context)}`);
  }
  return [
    context,
    LEGACY_STATUS_CONTEXT + context.slice(STATUS_CONTEXT.length),
  ];
}

// Whether a row's context is either name of `context` (the crysk form). `crysk` and
// `pr-hero/local` stay different gates: the local pair never answers for the gate.
export function isStatusContext(actual: string, context: string): boolean {
  return statusContextForms(context).includes(actual);
}

// For picking between two rows with the same time: the legacy name loses to the new
// one, because the pair a run writes carries identical content on both.
export function isLegacyStatusContext(context: string): boolean {
  return (
    context === LEGACY_STATUS_CONTEXT ||
    context.startsWith(`${LEGACY_STATUS_CONTEXT}/`)
  );
}

// A status description starts with the context name (`crysk: 2 blocking finding(s)`,
// `crysk skipped the review`). Statuses written before the rename start with
// `pr-hero` instead. A reader rewrites a legacy lead into the new one and then
// matches against the text this version writes, so one pattern serves both. Only a
// lead followed by `:` or a space is the brand: `pr-heroic` is not.
export function canonicalStatusText(text: string): string {
  if (!text.startsWith(LEGACY_STATUS_CONTEXT)) return text;
  const next = text.charAt(LEGACY_STATUS_CONTEXT.length);
  if (next !== ":" && next !== " ") return text;
  return STATUS_CONTEXT + text.slice(LEGACY_STATUS_CONTEXT.length);
}

// The bundled agent skills, by role, in sync order. The role key joins a skill
// to its pre-rename name: sync removes a legacy dir only once the skill of the
// same role is installed under the new name. Plain strings, so every site that
// lists skills (sync, inspect, remove, uninstall) reads this one list.
export const SKILL_NAMES = {
  triage: "crysk-loop",
  ciSetup: "crysk-ci-setup",
  pr: "crysk-pr",
  general: "crysk",
} as const;

export const LEGACY_SKILL_NAMES = {
  triage: "pr-hero-triage",
  ciSetup: "pr-hero-ci-setup",
  pr: "pr-hero-pr",
  general: "pr-hero",
} as const satisfies Record<keyof typeof SKILL_NAMES, string>;
