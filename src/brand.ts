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

// PR comment commands. Only the `/crysk` form is a command: the legacy `/pr-hero` spelling is no longer
// accepted (2026-11-17), because nobody can tell whether a workflow set up before the rename is still
// out there, and keeping both forms meant every hint and status had to name the old one.
const COMMAND_PREFIX = "/crysk";

// The written forms of a command. One today; the workflow template lists each form, because an Actions
// expression cannot match a pattern.
export function commandForms(command: string): string[] {
  if (!command.startsWith(`${COMMAND_PREFIX} `)) {
    throw new Error(`not a crysk command: ${JSON.stringify(command)}`);
  }
  return [command];
}

// The line a comment is read as a command from: the first line of its trimmed text. What follows
// that line is not part of the command, so a signature or a note below it changes nothing.
export function commandLine(text: string): string {
  return (text.trim().split(/\r?\n/, 1)[0] ?? "").trim();
}

// The first line must be exactly the command: no case folding, no inner whitespace tolerance, no
// trailing words. A loose match is how "/crysk review please" or a quoted reply would start a paid
// review. WHY only the first line: an agent signs its comments, and a command with a signature
// below it used to be no command at all, with nothing said.
export function isCommand(text: string, command: string): boolean {
  return commandForms(command).includes(commandLine(text));
}

// For near-miss detection: the first line begins like the command.
export function startsWithCommand(text: string, command: string): boolean {
  const line = commandLine(text);
  return commandForms(command).some((form) => line.startsWith(form));
}

// A command as a hint a person or an agent will act on.
export function commandHint(command: string, quote = "`"): string {
  commandForms(command);
  return `${quote}${command}${quote}`;
}

// Commit status contexts. Every status is written on the crysk name only (#457
// ended the dual write that kept the legacy `pr-hero` context alive, so a branch
// protection that still requires `pr-hero` must switch to `crysk`). Readers still
// treat both names as one gate: a head reviewed before that change, or by an older
// action, carries only `pr-hero` rows, and those must keep counting. The version
// that stops reading the legacy name deletes LEGACY_STATUS_CONTEXT and the helpers below.
export const STATUS_CONTEXT = "crysk";
const LEGACY_STATUS_CONTEXT = "pr-hero";

// The context of a run that cannot move the gate: a local `review --pr` and the
// watcher. Its legacy form, still read, is `pr-hero/local`, derived the same way.
export const LOCAL_STATUS_CONTEXT = `${STATUS_CONTEXT}/local` as const;

// Both names a READER accepts for `context`, new name first. Never a list to write:
// a status is posted on `context` alone. `context` is always a crysk context, and the
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
// one, so the answer never depends on the order of the list. (A pair with one time is
// what a run before #457 wrote, with identical content on both names.)
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
// The command a status names is rewritten the same way: a status an earlier release wrote ends in
// `/pr-hero override` or `/pr-hero review`, and the readers that rebuild a verdict's text to
// recognise it (pr/admission.ts) must still recognise that verdict, or the carry walk passes over it.
const LEGACY_STATUS_COMMAND = /\/pr-hero (review|recheck|override|stop)\b/g;

export function canonicalStatusText(text: string): string {
  const commands = text.replace(LEGACY_STATUS_COMMAND, "/crysk $1");
  if (!commands.startsWith(LEGACY_STATUS_CONTEXT)) return commands;
  const next = commands.charAt(LEGACY_STATUS_CONTEXT.length);
  if (next !== ":" && next !== " ") return commands;
  return STATUS_CONTEXT + commands.slice(LEGACY_STATUS_CONTEXT.length);
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

// The key the agent MCP configs register this server under, and the key
// installs set up under pr-hero still hold. Register writes the first and
// retires the second; inspect and unregister read both.
export const MCP_SERVER_KEY = "crysk";
export const LEGACY_MCP_SERVER_KEY = "pr-hero";

// MCP tool names. The server advertises only the current prefix; a call under
// the legacy one is mapped onto it, so an agent prompt or skill written before
// the rename keeps working.
const MCP_TOOL_PREFIX = "crysk_";
const LEGACY_MCP_TOOL_PREFIX = "prhero_";

export function currentMcpToolName(name: string): string {
  return name.startsWith(LEGACY_MCP_TOOL_PREFIX)
    ? MCP_TOOL_PREFIX + name.slice(LEGACY_MCP_TOOL_PREFIX.length)
    : name;
}

// The standalone binary, as installed in <home>/bin and as a release asset
// prefix (`<name>-<target>`). The release carries both assets for one version,
// install.sh and `upgrade` install the first and keep the second as a link, so
// a shell alias, a CI script or an old binary's `pr-hero upgrade` keeps
// resolving. The version that drops the legacy name deletes LEGACY_BIN_NAME and
// the fallbacks that read it.
export const BIN_NAME = "crysk";
export const LEGACY_BIN_NAME = "pr-hero";

// CI identifiers. The workflow file new repos get, and the one a repo set up
// before the rename keeps (it is updated in place, never duplicated: two
// workflow files would review every pull request twice). Filesystem lookups
// that choose between them live in brand-paths.ts.
export const WORKFLOW_FILE_NAME = "crysk.yml";
export const LEGACY_WORKFLOW_FILE_NAME = "pr-hero.yml";

// The generated workflow's display name and the step that runs the action. A
// reader of the Actions API (the sandbox) matches runs of a workflow scaffolded
// before the rename too, so each has a legacy form.
export const WORKFLOW_DISPLAY_NAME = "Crysk Review";
export const LEGACY_WORKFLOW_DISPLAY_NAME = "pr-hero Review";
export const RUN_STEP_DISPLAY_NAME = "Run Crysk";
export const LEGACY_RUN_STEP_DISPLAY_NAME = "Run pr-hero";

// The artifact the action uploads the run directory as: `<prefix><pr>-<sha>`.
export const RUN_ARTIFACT_PREFIX = "crysk-run-";
export const LEGACY_RUN_ARTIFACT_PREFIX = "pr-hero-run-";

// The check run that is the durable CI admission ledger. A head first reviewed
// by an older release holds its attempts under the legacy name, so a reader
// accepts both: the attempt count must survive the rename. Only the new name
// is written.
export const ADMISSION_CHECK_RUN_NAME = "crysk/ci-admission";
export const LEGACY_ADMISSION_CHECK_RUN_NAME = "pr-hero/ci-admission";

export function isAdmissionCheckRunName(name: string): boolean {
  return (
    name === ADMISSION_CHECK_RUN_NAME ||
    name === LEGACY_ADMISSION_CHECK_RUN_NAME
  );
}
