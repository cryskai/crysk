// Which Claude credential a run uses (odd/tasks/role-model-routing.md, S5, S8, L6 items 2-3, L12 "E-e").
//
// Before S5 nobody chose: the Claude CLI prefers a per-token key to the subscription
// token, so a non-empty ANTHROPIC_API_KEY silently won over CLAUDE_CODE_OAUTH_TOKEN and
// the review billed per token. Now `credentials.claude` names the order (default
// `["subscription", "api_key"]`), the run uses the FIRST listed credential that is
// present, decided once at run start and never switched mid-run, and the child sees
// exactly that one credential under the CLI's own variable name.
//
// Three halves, kept apart so the decision is pure and testable:
//   * claudeCredentialPresence: which credentials exist, and where each came from.
//   * selectClaudeCredential: the order applied to that presence. Pure.
//   * claudeRunEnv: the run's environment with every Claude credential variable
//     removed and only the chosen one put back. Every reader downstream (the binding's
//     credential kind, the CI ceiling, the usage record's billing mode, the failure's
//     credential) reads this env, so they all follow the choice without a second copy
//     of it.
//
// WHY the env is rebuilt rather than `process.env` edited: Bun.spawn without an
// explicit `env` hands the child the environment the process STARTED with, so a
// `delete process.env.X` never reaches it (L14 (a)). The run env is passed explicitly
// to the runner authority and as the harness's `childEnv`.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  claudeCredentialProjectionReady,
  defaultKeychainCredentialPresent,
} from "#model/provider-capabilities";
import type {
  ClaudeCredentialKind,
  CredentialsConfig,
} from "#review/preflight";
import { CliError } from "../errors";

export const DEFAULT_CLAUDE_CREDENTIAL_ORDER: readonly ClaudeCredentialKind[] =
  ["subscription", "api_key"];

// Where each credential may come from in the environment, the CRYSK_* secret first
// (S8). The old names are the Claude CLI's own variables, which a local run exports;
// in CI the action reads only the crysk-secrets input (the intake below, U5).
const ENV_SOURCES = {
  subscription: ["CRYSK_CLAUDE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  api_key: ["CRYSK_CLAUDE_API_KEY", "ANTHROPIC_API_KEY"],
} as const satisfies Record<ClaudeCredentialKind, readonly string[]>;

type EnvSource = (typeof ENV_SOURCES)[ClaudeCredentialKind][number];

// "login" is a subscription the machine already holds outside the environment: the
// macOS Keychain item the credential broker projects, or the CLI's OAuth store
// `~/.claude/.credentials.json`.
export type ClaudeCredentialSource = EnvSource | "login";

// The variable the Claude CLI reads for each kind. The child gets exactly one.
export const CLAUDE_CHILD_VARIABLE = {
  subscription: "CLAUDE_CODE_OAUTH_TOKEN",
  api_key: "ANTHROPIC_API_KEY",
} as const satisfies Record<ClaudeCredentialKind, string>;

// Every variable that can carry a Claude credential. All of them leave the run env.
// ANTHROPIC_AUTH_TOKEN is one too (a bearer token the CLI also bills per token), but no
// `credentials.claude` kind names it, so it is removed and never chosen.
export const CLAUDE_CREDENTIAL_VARIABLES = [
  "CRYSK_CLAUDE_OAUTH_TOKEN",
  "CRYSK_CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

export interface ClaudeCredentialPresence {
  readonly subscription?: ClaudeCredentialSource;
  readonly api_key?: ClaudeCredentialSource;
  // Set when ANTHROPIC_AUTH_TOKEN holds a value: it is stripped, and a refusal says so.
  readonly authTokenIgnored?: true;
  // Set when the env came from the crysk-secrets intake (the action, U5): the only
  // sources were the CRYSK_* secrets in that input, so a refusal names those.
  readonly fromCryskSecrets?: true;
}

export type ClaudeCredentialSelection =
  | {
      readonly status: "chosen";
      readonly kind: ClaudeCredentialKind;
      readonly source: ClaudeCredentialSource;
      readonly order: readonly ClaudeCredentialKind[];
      readonly orderDefaulted: boolean;
    }
  | {
      readonly status: "none";
      readonly order: readonly ClaudeCredentialKind[];
      readonly orderDefaulted: boolean;
      readonly presence: ClaudeCredentialPresence;
    };

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

// Which credentials exist. The trim matches envBillsMetered: a whitespace-only value is
// no credential (GitHub renders an unset input as "", and a stray space must not count).
export function claudeCredentialPresence(
  env: Readonly<Record<string, string | undefined>>,
  loginPresent: boolean,
): ClaudeCredentialPresence {
  const found = (kind: ClaudeCredentialKind): EnvSource | undefined =>
    ENV_SOURCES[kind].find((name) => hasValue(env[name]));
  const subscription =
    found("subscription") ?? (loginPresent ? "login" : undefined);
  const apiKey = found("api_key");
  return {
    ...(subscription === undefined ? {} : { subscription }),
    ...(apiKey === undefined ? {} : { api_key: apiKey }),
    ...(hasValue(env.ANTHROPIC_AUTH_TOKEN)
      ? { authTokenIgnored: true as const }
      : {}),
  };
}

// The first listed credential that is present. A present credential that the order
// does not list is never used: listing is consent to pay with it.
export function selectClaudeCredential(
  order: readonly ClaudeCredentialKind[] | undefined,
  presence: ClaudeCredentialPresence,
): ClaudeCredentialSelection {
  const effective = order ?? DEFAULT_CLAUDE_CREDENTIAL_ORDER;
  const orderDefaulted = order === undefined;
  for (const kind of effective) {
    const source = presence[kind];
    if (source !== undefined) {
      return {
        status: "chosen",
        kind,
        source,
        order: effective,
        orderDefaulted,
      };
    }
  }
  return { status: "none", order: effective, orderDefaulted, presence };
}

function describeSources(
  kind: ClaudeCredentialKind,
  fromCryskSecrets: boolean,
): string {
  const names = fromCryskSecrets
    ? `${ENV_SOURCES[kind][0]} in the crysk-secrets input`
    : ENV_SOURCES[kind].join(" or ");
  return kind === "subscription"
    ? `${names}, or a Claude login on this machine`
    : names;
}

// The refusal's own class, so a CI run can settle its admission row as an unspent
// gate skip (settleClaudeCredentialRefusal, pr/admission.ts). No `cls`: the outcome
// stays unclassified, and the CLI prints it as the one line it prints any CliError.
export class ClaudeCredentialRefusalError extends CliError {}

// The admission refusal for a plan that has a Claude route and no listed credential
// present, or undefined when the run can go ahead. A plan with no Claude route ignores
// Claude credentials, so it is never refused here. The message names the order and what
// is set, never a value.
export function claudeCredentialRefusal(
  selection: ClaudeCredentialSelection,
  planHasClaudeRoute: boolean,
): string | undefined {
  if (selection.status === "chosen" || !planHasClaudeRoute) return undefined;
  const order = `credentials.claude is [${selection.order.join(", ")}]${selection.orderDefaulted ? " (the default)" : ""}`;
  const missing = selection.order
    .map(
      (kind) =>
        `${kind} (${describeSources(kind, selection.presence.fromCryskSecrets === true)})`,
    )
    .join("; ");
  const unlisted = (["subscription", "api_key"] as const).filter(
    (kind) =>
      !selection.order.includes(kind) && selection.presence[kind] !== undefined,
  );
  const parts = [
    `no Claude credential this run may use is set: ${order}, and none of those is set: ${missing}`,
  ];
  if (unlisted.length > 0) {
    parts.push(
      `${unlisted.join(" and ")} ${unlisted.length === 1 ? "is" : "are"} set but not listed, so ${unlisted.length === 1 ? "it is" : "they are"} not used`,
    );
  }
  if (selection.presence.authTokenIgnored) {
    parts.push(
      "ANTHROPIC_AUTH_TOKEN is set but no longer used: put an API key in CRYSK_CLAUDE_API_KEY or ANTHROPIC_API_KEY",
    );
  }
  parts.push(
    "Set a listed credential, or change credentials.claude in your person config",
  );
  return parts.join(". ");
}

// The run's environment: every Claude credential variable removed, then only the
// chosen credential put back under the CLI's own name. A subscription that comes from
// the machine's login puts nothing back: the broker projects it, or the CLI reads its
// own store. With no credential chosen, every Claude credential is gone.
export function claudeRunEnv(
  env: Readonly<Record<string, string | undefined>>,
  selection: ClaudeCredentialSelection,
): Record<string, string | undefined> {
  const run: Record<string, string | undefined> = { ...env };
  for (const name of CLAUDE_CREDENTIAL_VARIABLES) delete run[name];
  if (selection.status === "chosen" && selection.source !== "login") {
    run[CLAUDE_CHILD_VARIABLE[selection.kind]] = env[selection.source];
  }
  return run;
}

// U5: the Claude values the Run Crysk step took from the crysk-secrets input
// (src/ci/run.ts, which reads the input on stdin), keyed by kind. Undefined until
// run.ts takes them, which only the action does; a local run never sets it.
let cryskClaudeIntake:
  | { readonly subscription?: string; readonly api_key?: string }
  | undefined;

// Called once by src/ci/run.ts, before the CLI starts, with the parsed input's
// Claude secrets (parseCryskSecrets's `secrets.claude`). Nothing is written to
// process.env: Bun hands a child the environment it started with, and readers of
// the startup env (the transport's billingMode getter, a `{...process.env}` copy)
// would see a value assigned there. resolveRunClaudeCredential reads the intake.
export function takeCryskClaudeSecrets(claude: {
  readonly subscription?: string;
  readonly api_key?: string;
}): void {
  cryskClaudeIntake = { ...claude };
}

// For tests: forget the intake, so a later test reads the process env again.
export function clearCryskClaudeIntake(): void {
  cryskClaudeIntake = undefined;
}

// The env a CI run reads its Claude credential from: every Claude variable of the
// process env removed (a job-level ANTHROPIC_API_KEY nobody passed through the
// crysk-secrets input must not be chosen), then the intake's values under their
// CRYSK_* names. Pure; the run env (claudeRunEnv) is built from it as from any env.
export function cryskIntakeEnv(
  env: Readonly<Record<string, string | undefined>>,
  claude: { readonly subscription?: string; readonly api_key?: string },
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of CLAUDE_CREDENTIAL_VARIABLES) delete out[name];
  for (const kind of ["subscription", "api_key"] as const) {
    const value = claude[kind];
    if (value !== undefined) out[ENV_SOURCES[kind][0]] = value;
  }
  return out;
}

export interface RunClaudeCredential {
  readonly selection: ClaudeCredentialSelection;
  // The environment every runner, binding and gate of this run reads.
  readonly env: Record<string, string | undefined>;
  // The chosen kind, for the runner authority (an API key attaches no Keychain broker).
  readonly kind?: ClaudeCredentialKind;
}

// The probes behind defaultClaudeLoginPresent. Tests inject all three, so no test
// reads the real Keychain or HOME.
export interface ClaudeLoginProbe {
  readonly platform?: NodeJS.Platform;
  readonly existsFn?: (p: string) => boolean;
  readonly keychainProbe?: () => boolean;
}

// The machine's own Claude login: a Keychain item the broker can project (macOS), or
// the CLI's OAuth store. `~/.claude.json` does not count: every Claude user has it,
// API-key users included, and counting it would strip their key.
// WHY the item and not only the broker (R001, #494): `security` is on every Mac, so
// counting the broker alone chose the login on a Mac that has only an API key; the
// key was stripped, the projection found no item (`source_read_failed`) and every
// step failed. The item check is metadata-only (no `-w`, no secret read).
export function defaultClaudeLoginPresent(
  env: Readonly<Record<string, string | undefined>> = process.env,
  probe: ClaudeLoginProbe = {},
): boolean {
  const exists = probe.existsFn ?? existsSync;
  const home = hasValue(env.HOME) ? env.HOME : homedir();
  if (exists(path.join(home, ".claude", ".credentials.json"))) return true;
  return (
    claudeCredentialProjectionReady({
      ...(probe.platform === undefined ? {} : { platform: probe.platform }),
      existsFn: exists,
    }) && (probe.keychainProbe ?? defaultKeychainCredentialPresent)()
  );
}

// Called once at run start, before any plan is admitted. With no env given it reads
// the process env, or, in the action, the crysk-secrets intake over it (U5).
export function resolveRunClaudeCredential(input: {
  readonly credentials?: CredentialsConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly loginPresent?: boolean;
}): RunClaudeCredential {
  const fromIntake = input.env === undefined && cryskClaudeIntake !== undefined;
  const env =
    input.env ??
    (cryskClaudeIntake === undefined
      ? process.env
      : cryskIntakeEnv(process.env, cryskClaudeIntake));
  const found = claudeCredentialPresence(
    env,
    input.loginPresent ?? defaultClaudeLoginPresent(env),
  );
  const presence: ClaudeCredentialPresence = fromIntake
    ? { ...found, fromCryskSecrets: true }
    : found;
  const selection = selectClaudeCredential(input.credentials?.claude, presence);
  return {
    selection,
    env: claudeRunEnv(env, selection),
    ...(selection.status === "chosen" ? { kind: selection.kind } : {}),
  };
}
