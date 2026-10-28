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
// lists each one, because a Actions expression cannot match a pattern.
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
