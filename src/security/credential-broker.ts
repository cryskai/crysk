// D1-05 §6.1: credential projection. The broker copies ONLY the minimum
// credential record out of a trusted source into an ephemeral 0700 projection
// with a single 0600 file; every component is lstat-checked so a pre-planted
// symlink cannot redirect the credential write outside the projection root.
// Credential values, source paths and file contents never appear in errors,
// metadata or logs — only the projected file's sha256 is exposed.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { CredentialKind } from "#model/provider-capabilities";

export type CredentialProjectionFile = {
  readonly path: string;
  readonly mode: 0o600;
  readonly sha256: string;
};

// Verbatim shape of docs/multi-runtime-model-diversity-design.md §6.1, plus
// D1-08 PR3's §9.2 addition: the scope fields `deriveBucketId`
// (execution/bucket-id.ts) hashes into a rate-limit bucket ID. Populated
// best-effort per credential kind — today NO broker below sets it, because
// `claude_subscription_oauth` (the only shipped route) has no
// account/project/rateLimitGroup to report. That is not a bug: an absent
// `bucketScope` and an explicit `{}` are handled identically by
// `deriveBucketId`'s "unknown" sentinel (§9.2 "Bucket Identity Coarsens
// Unknown Scope"), so every such credential still gets one conservative,
// coarse bucket rather than an unbounded one (design's Open Question).
export interface CredentialProjection {
  readonly projectionId: string;
  readonly kind: CredentialKind;
  readonly syntheticHome: string;
  readonly syntheticConfigHome: string;
  readonly syntheticTmp: string;
  readonly env: Readonly<Record<string, string>>;
  readonly files: readonly CredentialProjectionFile[];
  readonly bucketScope?: {
    readonly account?: string;
    readonly project?: string;
    readonly rateLimitGroup?: string;
  };
  destroy(): Promise<void>;
}

// Verbatim shape of docs/multi-runtime-model-diversity-design.md §6.1.
export interface CredentialBroker {
  project(input: {
    readonly sessionId: string;
    readonly credentialRef: string;
    readonly kind: CredentialKind;
    readonly verifiedBinaryPath: string;
  }): Promise<CredentialProjection>;
}

export const CLAUDE_CREDENTIALS_KEYCHAIN_SERVICE = "Claude Code-credentials";
const SECURITY_BIN = "/usr/bin/security";

export type CredentialProjectionFailureClass =
  | "unsupported_kind"
  | "source_read_failed"
  | "malformed_payload"
  | "missing_subscription_record"
  // #133: the metered kind's own class. `missing_subscription_record` is the
  // wrong NAME for a provider API token — there is no subscription involved —
  // and the wrong BEHAVIOUR: harness.ts degrades that one class to the
  // operator environment (a deliberate 2026-08-26 decision, because Claude's
  // subscription store moved out of the keychain). An absent provider token
  // is not a moved store, and degrading it would run a metered route on
  // whatever provider keys happen to be ambient. It falls into the
  // fail-closed branch there, and must stay there.
  | "missing_provider_record"
  | "projection_layout_invalid";

export class CredentialProjectionError extends Error {
  readonly failureClass: CredentialProjectionFailureClass;

  constructor(failureClass: CredentialProjectionFailureClass) {
    // Message names only the failure class — never source content, paths or
    // keychain output (§6.1 redaction rule).
    super(`Credential projection failed (${failureClass})`);
    this.name = "CredentialProjectionError";
    this.failureClass = failureClass;
  }
}

export interface KeychainCredentialBrokerOptions {
  readonly securityBinPath?: string;
  // Injectable for offline tests; returns the raw JSON payload of the
  // keychain item. Production default shells out to /usr/bin/security.
  readonly readerFn?: (service: string) => Promise<string>;
}

interface ClaudeOauthRecord {
  [key: string]: unknown;
}

export class KeychainCredentialBroker implements CredentialBroker {
  private readonly securityBinPath: string;
  private readonly readerFn: (service: string) => Promise<string>;

  constructor(options: KeychainCredentialBrokerOptions = {}) {
    this.securityBinPath = options.securityBinPath ?? SECURITY_BIN;
    if (options.readerFn !== undefined) {
      this.readerFn = options.readerFn;
    } else {
      // Fail loud at construction, not at first spawn: a missing pinned
      // helper is an environment defect (§6.1 pins absolute helper paths).
      if (!existsSync(this.securityBinPath)) {
        throw new Error(
          `Pinned security binary not found at ${this.securityBinPath}`,
        );
      }
      this.readerFn = (service) => this.readKeychain(service);
    }
  }

  async project(input: {
    readonly sessionId: string;
    readonly credentialRef: string;
    readonly kind: CredentialKind;
    readonly verifiedBinaryPath: string;
  }): Promise<CredentialProjection> {
    void input.sessionId;
    void input.credentialRef;
    void input.verifiedBinaryPath;
    if (input.kind !== "claude_subscription_oauth") {
      throw new Error(
        `Unsupported credential kind: ${input.kind} (KeychainCredentialBroker projects only claude_subscription_oauth)`,
      );
    }

    let raw: string;
    try {
      raw = await this.readerFn(CLAUDE_CREDENTIALS_KEYCHAIN_SERVICE);
    } catch {
      throw new CredentialProjectionError("source_read_failed");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CredentialProjectionError("malformed_payload");
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("claudeAiOauth" in parsed)
    ) {
      throw new CredentialProjectionError("missing_subscription_record");
    }

    // Carry ONLY the subscription OAuth record: mcpOAuth and any other keys
    // in the store are unrelated secrets and must not leave the source.
    const oauthRecord = (parsed as Record<string, unknown>).claudeAiOauth;
    if (typeof oauthRecord !== "object" || oauthRecord === null) {
      throw new CredentialProjectionError("missing_subscription_record");
    }

    return this.buildProjection(input.kind, oauthRecord as ClaudeOauthRecord);
  }

  private buildProjection(
    kind: CredentialKind,
    oauthRecord: ClaudeOauthRecord,
  ): CredentialProjection {
    // Fresh UUID root per projection: no reuse across runs, nothing to collide
    // with (§6.1 ephemeral layout).
    const projectionRoot = path.join(
      tmpdir(),
      "prhero-cred-projections",
      randomUUID(),
    );
    const claudeDir = path.join(projectionRoot, ".claude");
    const syntheticTmp = path.join(projectionRoot, "tmp");
    const credentialsFile = path.join(claudeDir, ".credentials.json");

    mkdirSync(projectionRoot, { recursive: true, mode: 0o700 });
    mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    mkdirSync(syntheticTmp, { recursive: true, mode: 0o700 });

    // Empirically proven live (2026-08-26): the CLI authenticates purely from
    // <syntheticHome>/.claude/.credentials.json containing this exact shape.
    const payload = `${JSON.stringify({ claudeAiOauth: oauthRecord }, null, 2)}\n`;
    writeFileSync(credentialsFile, payload, { mode: 0o600 });

    // Defense per §6.1: lstat EVERY component after writing — any symlink in
    // the chain means the credential landed outside our control; fail loud.
    for (const component of [
      tmpdir(),
      path.dirname(path.dirname(credentialsFile)),
      path.dirname(credentialsFile),
      credentialsFile,
    ]) {
      const stats = lstatSync(component);
      if (stats.isSymbolicLink()) {
        // Never leave a possibly-redirected credential tree behind.
        rmSync(projectionRoot, { recursive: true, force: true });
        throw new CredentialProjectionError("projection_layout_invalid");
      }
    }

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(new TextEncoder().encode(payload));
    const sha256 = hasher.digest("hex");

    const projection: CredentialProjection = {
      projectionId: `cred-${randomUUID()}`,
      kind,
      syntheticHome: projectionRoot,
      syntheticConfigHome: claudeDir,
      syntheticTmp,
      env: {
        HOME: projectionRoot,
        TMPDIR: syntheticTmp,
      },
      files: [{ path: credentialsFile, mode: 0o600, sha256 }],
      destroy: async () => {
        rmSync(projectionRoot, { recursive: true, force: true });
      },
    };
    return projection;
  }

  private async readKeychain(service: string): Promise<string> {
    const proc = Bun.spawn(
      [this.securityBinPath, "find-generic-password", "-s", service, "-w"],
      {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error("security lookup failed");
    }
    return stdout.trim();
  }
}

// ---------------------------------------------------------------------------
// D1-06b §6.1: the OpenCode / ChatGPT OAuth route.
//
// Ported from KeychainCredentialBroker rather than rewritten — same threat
// model, same defenses — with three differences the source forces:
//
//  1. The source is a FILE, not the macOS keychain, and OpenCode resolves it
//     through XDG_DATA_HOME before falling back to ~/.local/share.
//  2. auth.json is a SHARED store. Every provider the operator ever logged
//     into lives in it, so carrying it wholesale would hand an OpenAI-routed
//     step unrelated provider keys. Only the `openai` record travels — the
//     same rule that keeps mcpOAuth out of the Claude projection.
//  3. The projection pins XDG_DATA_HOME/XDG_CONFIG_HOME as well as HOME. The
//     harness env allowlist happens to drop XDG today, but an isolation claim
//     that depends on a passthrough list staying XDG-free is one edit away
//     from being false.
//
// Empirically proven live (2026-08-27): `opencode auth list` under a synthetic
// HOME reads <syntheticHome>/.local/share/opencode/auth.json and reports
// exactly the one projected OAuth credential, with the sibling provider keys
// absent.
// ---------------------------------------------------------------------------

export const OPENCODE_AUTH_RELATIVE_PATH = path.join(
  ".local",
  "share",
  "opencode",
  "auth.json",
);

// ONE list, used for both creating the tree and guarding it. The gap this
// closes was real (pr-hero F001 on PR #80): the create loop had seven entries
// and the lstat walk had six, so three directories the child is handed as
// XDG_CONFIG_HOME / syntheticConfigHome / TMPDIR were built and never checked.
// Two hand-maintained copies of the same paths WILL drift; a shared layout
// cannot.
export interface OpenCodeProjectionLayout {
  readonly syntheticHome: string;
  readonly syntheticConfigHome: string;
  readonly syntheticTmp: string;
  readonly xdgDataHome: string;
  readonly xdgConfigHome: string;
  readonly authFile: string;
  readonly directories: readonly string[];
  // Every path lstat must clear before the projection is handed over —
  // the tree itself plus the shared parent it was created under.
  readonly guarded: readonly string[];
}

export function openCodeProjectionLayout(
  projectionRoot: string,
  parentDir: string = tmpdir(),
): OpenCodeProjectionLayout {
  const localDir = path.join(projectionRoot, ".local");
  const xdgDataHome = path.join(localDir, "share");
  const xdgConfigHome = path.join(projectionRoot, ".config");
  const opencodeDataDir = path.join(xdgDataHome, "opencode");
  const opencodeConfigDir = path.join(xdgConfigHome, "opencode");
  const syntheticTmp = path.join(projectionRoot, "tmp");
  const authFile = path.join(opencodeDataDir, "auth.json");
  const directories = [
    projectionRoot,
    localDir,
    xdgDataHome,
    opencodeDataDir,
    xdgConfigHome,
    opencodeConfigDir,
    syntheticTmp,
  ];
  return {
    syntheticHome: projectionRoot,
    syntheticConfigHome: opencodeConfigDir,
    syntheticTmp,
    xdgDataHome,
    xdgConfigHome,
    authFile,
    directories,
    guarded: [parentDir, ...directories, authFile],
  };
}

export interface OpenCodeAuthBrokerOptions {
  // Injectable for offline tests; returns the raw auth.json payload.
  readonly readerFn?: () => Promise<string>;
  // Overrides the source lookup; production resolves XDG_DATA_HOME ?? ~/.local/share.
  readonly authFilePath?: string;
}

// One provider's entry in auth.json, whatever shape that provider uses. The
// broker never interprets it — see buildOpenCodeProjection's "travels WHOLE".
interface OpenCodeProviderRecord {
  [key: string]: unknown;
}

// The ONE provider OpenCode serves from a subscription rather than a metered
// API token. Named, because it is the whole reason credentialKindForRoute
// (runner-authority.ts) is provider-keyed instead of backend-keyed.
export const OPENCODE_OAUTH_PROVIDER = "openai";

export function resolveOpenCodeAuthPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = homedir(),
): string {
  const dataHome = env.XDG_DATA_HOME;
  const base =
    dataHome !== undefined && dataHome.length > 0
      ? dataHome
      : path.join(homeDir, ".local", "share");
  return path.join(base, "opencode", "auth.json");
}

export class OpenCodeAuthBroker implements CredentialBroker {
  private readonly readerFn: () => Promise<string>;

  constructor(options: OpenCodeAuthBrokerOptions = {}) {
    if (options.readerFn !== undefined) {
      this.readerFn = options.readerFn;
    } else {
      const authPath = options.authFilePath ?? resolveOpenCodeAuthPath();
      this.readerFn = () => Bun.file(authPath).text();
    }
  }

  async project(input: {
    readonly sessionId: string;
    readonly credentialRef: string;
    readonly kind: CredentialKind;
    readonly verifiedBinaryPath: string;
  }): Promise<CredentialProjection> {
    void input.sessionId;
    void input.credentialRef;
    void input.verifiedBinaryPath;
    if (input.kind !== "opencode_chatgpt_oauth") {
      throw new Error(
        `Unsupported credential kind: ${input.kind} (OpenCodeAuthBroker projects only opencode_chatgpt_oauth)`,
      );
    }

    const lookup = await lookupOpenCodeOAuthRecord(this.readerFn);
    if (!lookup.ok) {
      throw new CredentialProjectionError(lookup.failureClass);
    }

    return buildOpenCodeProjection(
      input.kind,
      OPENCODE_OAUTH_PROVIDER,
      lookup.record,
    );
  }
}

// The read+parse+validate sequence for the `openai` ChatGPT OAuth record, the
// OAuth broker's own (above) and admission's credential check
// (openCodeCredentialRefusal, production-runtime.ts). One copy, so admission
// asks exactly what the broker will ask when the route runs.
export async function lookupOpenCodeOAuthRecord(
  readerFn: () => Promise<string>,
): Promise<OpenCodeRecordLookup> {
  let raw: string;
  try {
    raw = await readerFn();
  } catch {
    return { ok: false, failureClass: "source_read_failed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, failureClass: "malformed_payload" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, failureClass: "malformed_payload" };
  }

  const record = (parsed as Record<string, unknown>).openai;
  if (typeof record !== "object" || record === null) {
    return { ok: false, failureClass: "missing_subscription_record" };
  }
  // This kind promises ChatGPT OAuth specifically. An `openai` entry holding
  // a pay-as-you-go API key is a different credential on different billing,
  // and projecting it here would make the capability report's
  // `billing.mode: "subscription"` a lie rather than a claim.
  //
  // #133 note: this lock is also what makes credentialKindForRoute's
  // provider-keyed decision safe. That function does NOT read the store, so
  // an `openai` entry holding an API key still resolves to this OAuth kind —
  // and lands here, refused, rather than being silently routed metered. A
  // bounded, stated limit, not a bug: the failure is loud and the fix is to
  // name that provider differently in the model name (`opencode:<provider>/...`).
  if ((record as Record<string, unknown>).type !== "oauth") {
    return { ok: false, failureClass: "missing_subscription_record" };
  }

  return { ok: true, record: record as OpenCodeProviderRecord };
}

// ONE builder for both OpenCode brokers. A third copy of the create+lstat+hash
// sequence is exactly the drift `openCodeProjectionLayout` already exists to
// prevent (pr-hero F001 on PR #80: two hand-maintained path lists, three
// directories built and never checked). The ONLY thing that differs between
// the OAuth route and the API-token route is which provider key the payload
// is written under, so that is the only thing parameterised.
function buildOpenCodeProjection(
  kind: CredentialKind,
  provider: string,
  record: OpenCodeProviderRecord,
): CredentialProjection {
  const parentDir = path.join(tmpdir(), "prhero-cred-projections");
  const layout = openCodeProjectionLayout(
    path.join(parentDir, randomUUID()),
    parentDir,
  );

  // Every level explicitly at 0700 — `recursive` alone lets an intermediate
  // directory inherit the umask.
  for (const dir of layout.directories) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // The record travels WHOLE. On the OAuth route its access token expires
  // (~10 days on the observed store) and the child renews it with the refresh
  // token; a projection carrying only `access` would hand the child a
  // credential it cannot rotate, and it would go stale mid-run with no way
  // back. On the API-token route the same rule holds for a different reason:
  // the store's own record shape is what OpenCode reads, and reconstructing a
  // subset of it here would be a second, silently drifting schema.
  const payload = `${JSON.stringify({ [provider]: record }, null, 2)}\n`;
  writeFileSync(layout.authFile, payload, { mode: 0o600 });

  // §6.1: lstat every guarded path — a pre-planted symlink anywhere in the
  // chain means the credential, or a directory the child writes into,
  // landed outside our control.
  for (const component of layout.guarded) {
    if (lstatSync(component).isSymbolicLink()) {
      rmSync(layout.syntheticHome, { recursive: true, force: true });
      throw new CredentialProjectionError("projection_layout_invalid");
    }
  }

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new TextEncoder().encode(payload));
  const sha256 = hasher.digest("hex");

  return {
    projectionId: `cred-${randomUUID()}`,
    kind,
    syntheticHome: layout.syntheticHome,
    syntheticConfigHome: layout.syntheticConfigHome,
    syntheticTmp: layout.syntheticTmp,
    env: {
      HOME: layout.syntheticHome,
      TMPDIR: layout.syntheticTmp,
      // Pinned, not merely absent from the harness allowlist: OpenCode reads
      // XDG_DATA_HOME first, so an inherited value would point the child
      // straight back at the operator's real store.
      XDG_DATA_HOME: layout.xdgDataHome,
      XDG_CONFIG_HOME: layout.xdgConfigHome,
    },
    files: [{ path: layout.authFile, mode: 0o600, sha256 }],
    destroy: async () => {
      rmSync(layout.syntheticHome, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// #133 §6.1: the metered provider API-token route, generic over ANY OpenCode
// provider. Ported from OpenCodeAuthBroker — same source file, same layout,
// same lstat defense — with two differences the KIND forces:
//
//  1. The provider is a CONSTRUCTOR argument, not a literal. OpenCode's
//     auth.json is keyed by provider name and the operator may hold any
//     number of them; nothing about this broker is zai-shaped.
//  2. `type === "api"` is required, the exact MIRROR of the OAuth broker's
//     `type === "oauth"` lock. This kind promises a metered API token;
//     projecting an OAuth record under it would make the capability report's
//     `billing.mode: "metered"` wrong in the other direction — a subscription
//     route gated, and charged, as if it spent cash per token.
//
// Projection shape proven live (2026-09-01, opencode 1.18.23): a synthetic
// HOME carrying only `{ <provider>: { type: "api", ... } }` is read as exactly
// that one credential, with the operator's sibling providers absent, on two
// different provider keys. Inference under that credential is NOT yet proven —
// that smoke is blocked on #137's pricing table.
// ---------------------------------------------------------------------------

// The provider name is interpolated into a JSON object key and compared
// against store keys, so it is constrained to a grammar that cannot be a path
// traversal, a prototype key, or anything requiring escaping.
const OPENCODE_PROVIDER_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export type OpenCodeRecordLookup =
  | { readonly ok: true; readonly record: OpenCodeProviderRecord }
  | {
      readonly ok: false;
      readonly failureClass: CredentialProjectionFailureClass;
    };

// #280: the read+parse+validate sequence for ONE provider's `type: "api"`
// entry, shared by OpenCodeApiTokenBroker (below, fails loud on every
// outcome) and OpenCodeFreeBroker (fails loud on NONE of them — every
// `ok: false` collapses to the empty tree). Splitting this out is the same
// move buildOpenCodeProjection's header already made for the create+lstat+
// hash sequence: a third hand-maintained copy is exactly the drift that
// comment warns about, and here it would additionally let the two callers'
// validation silently diverge (e.g. one broker accepting a record shape the
// other refuses). Admission's credential check (openCodeCredentialRefusal,
// production-runtime.ts) is the third caller, for the same reason.
export async function lookupOpenCodeApiRecord(
  readerFn: () => Promise<string>,
  provider: string,
): Promise<OpenCodeRecordLookup> {
  let raw: string;
  try {
    raw = await readerFn();
  } catch {
    return { ok: false, failureClass: "source_read_failed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, failureClass: "malformed_payload" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, failureClass: "malformed_payload" };
  }

  // Object.hasOwn, never a bare index — see OpenCodeApiTokenBroker's own note
  // (pr-hero F001 lineage, PR #162): a bare index reaches Object.prototype.
  if (!Object.hasOwn(parsed, provider)) {
    return { ok: false, failureClass: "missing_provider_record" };
  }
  const record = (parsed as Record<string, unknown>)[provider];
  if (typeof record !== "object" || record === null) {
    return { ok: false, failureClass: "missing_provider_record" };
  }
  // The mirror of the OAuth broker's `type !== "oauth"` lock: this lookup
  // promises an API token specifically, never an OAuth record.
  if ((record as Record<string, unknown>).type !== "api") {
    return { ok: false, failureClass: "missing_provider_record" };
  }

  return { ok: true, record: record as OpenCodeProviderRecord };
}

export class OpenCodeApiTokenBroker implements CredentialBroker {
  private readonly provider: string;
  private readonly readerFn: () => Promise<string>;

  constructor(provider: string, options: OpenCodeAuthBrokerOptions = {}) {
    // Fail loud at construction, not at first projection: a malformed
    // provider name is a configuration defect, and discovering it mid-run
    // costs a live step.
    if (!OPENCODE_PROVIDER_NAME.test(provider)) {
      throw new Error(
        `Invalid OpenCode provider name: ${JSON.stringify(provider)} (expected ${OPENCODE_PROVIDER_NAME})`,
      );
    }
    this.provider = provider;
    if (options.readerFn !== undefined) {
      this.readerFn = options.readerFn;
    } else {
      const authPath = options.authFilePath ?? resolveOpenCodeAuthPath();
      this.readerFn = () => Bun.file(authPath).text();
    }
  }

  async project(input: {
    readonly sessionId: string;
    readonly credentialRef: string;
    readonly kind: CredentialKind;
    readonly verifiedBinaryPath: string;
  }): Promise<CredentialProjection> {
    void input.sessionId;
    void input.credentialRef;
    void input.verifiedBinaryPath;
    if (input.kind !== "provider_api_token") {
      throw new Error(
        `Unsupported credential kind: ${input.kind} (OpenCodeApiTokenBroker projects only provider_api_token)`,
      );
    }

    // HONESTY about the hasOwn guard inside the shared lookup: with
    // OPENCODE_PROVIDER_NAME as it stands, the only Object.prototype key that
    // can even be a provider name is `constructor`, and its value is a
    // FUNCTION — so the `typeof record !== "object"` check already refuses
    // it, and removing the hasOwn guard breaks no test today (verified by
    // mutation, 2026-09-01). It is the second lock, and it is the one that
    // stays correct if the grammar is ever widened or the source stops being
    // JSON.parse output. Keep both; do not read the passing suite as proof
    // that line is exercised.
    const lookup = await lookupOpenCodeApiRecord(this.readerFn, this.provider);
    if (!lookup.ok) {
      throw new CredentialProjectionError(lookup.failureClass);
    }

    return buildOpenCodeProjection(input.kind, this.provider, lookup.record);
  }
}

// ---------------------------------------------------------------------------
// #182 → #280: the provider-free route — an OpenCode model the provider
// itself declares free at runtime (all cost leaves === 0, status active).
//
// #182's ORIGINAL invariant was "reads nothing, projects nothing" — sound
// for a per-token free model, wrong for a flat-fee API-key plan priced at
// $0 (zai-coding-plan): that provider still REQUIRES its key, so the empty
// tree left it running keyless against a provider that rejects the request.
// #280's relaxed invariant, and the reasoning behind each clause:
//
//  1. It projects THIS PROVIDER's own `type: "api"` record from auth.json,
//     and ONLY that — never another provider's, never an OAuth record for
//     the same provider name. The read+parse+validate is the exact same
//     `lookupOpenCodeApiRecord` OpenCodeApiTokenBroker uses; the two brokers
//     must never silently diverge on what counts as a usable record.
//  2. EVERY other outcome of that lookup — the file is absent, unreadable,
//     malformed JSON, has no entry for this provider, or the entry is not
//     `type: "api"` — collapses to the SAME empty 0700 tree #182 always
//     produced (`files: []`, no auth file written at all). Deliberately NOT
//     a fail-closed throw for the read/parse failures: a fresh machine or a
//     Zen-only user has no auth.json for zai-coding-plan at all, and that is
//     the common case this route exists to keep working, not an error to
//     surface. #182's `source_read_failed` header note ("structurally
//     unreachable") no longer holds — this route reads now — but its
//     conclusion does: nothing about a missing or corrupt STORE should stop
//     a free run, only a symlinked LAYOUT should (clause 3).
//  3. It MUST NEVER throw `missing_subscription_record`. harness.ts degrades
//     exactly that class to the operator environment, and degrading a free
//     route onto ambient credentials would be the failure this issue forbids
//     (a free run silently spending a real token, or now, running under the
//     WRONG provider's ambient key). Only fail-closed class: still
//     `projection_layout_invalid` on a symlinked layout. Nothing else
//     throws — the record lookup above never gets the chance to.
//
// Accepted cost (owner decision, #280, 2026-09-24): a model that flips from
// free to paid mid-run can spend on one attempt before the free-nonzero
// settlement rule fences the bucket — unchanged from #182, since billing
// stays keyed on `provider_free`/"free" regardless of what this broker
// projects. And an OpenCode Zen user with a stored `opencode` api key now
// runs Zen's free models with that key rather than keyless — accepted
// because it is strictly an upgrade (a working credential where none
// existed), never a downgrade.
// ---------------------------------------------------------------------------
export class OpenCodeFreeBroker implements CredentialBroker {
  private readonly provider: string;
  private readonly readerFn: () => Promise<string>;

  constructor(provider: string, options: OpenCodeAuthBrokerOptions = {}) {
    // Same grammar lock as OpenCodeApiTokenBroker, same reason: fail loud at
    // construction, not mid-run, and the provider is interpolated into a
    // JSON key by the shared lookup below.
    if (!OPENCODE_PROVIDER_NAME.test(provider)) {
      throw new Error(
        `Invalid OpenCode provider name: ${JSON.stringify(provider)} (expected ${OPENCODE_PROVIDER_NAME})`,
      );
    }
    this.provider = provider;
    if (options.readerFn !== undefined) {
      this.readerFn = options.readerFn;
    } else {
      const authPath = options.authFilePath ?? resolveOpenCodeAuthPath();
      this.readerFn = () => Bun.file(authPath).text();
    }
  }

  async project(input: {
    readonly sessionId: string;
    readonly credentialRef: string;
    readonly kind: CredentialKind;
    readonly verifiedBinaryPath: string;
  }): Promise<CredentialProjection> {
    void input.sessionId;
    void input.credentialRef;
    void input.verifiedBinaryPath;
    if (input.kind !== "provider_free") {
      throw new Error(
        `Unsupported credential kind: ${input.kind} (OpenCodeFreeBroker projects only provider_free)`,
      );
    }

    // Clause 1+2: a usable record projects; every other lookup outcome
    // (including a thrown read/parse error) falls through to the empty tree
    // below rather than propagating — `lookup.failureClass` is deliberately
    // never inspected here.
    const lookup = await lookupOpenCodeApiRecord(this.readerFn, this.provider);
    if (lookup.ok) {
      return buildOpenCodeProjection(input.kind, this.provider, lookup.record);
    }

    const parentDir = path.join(tmpdir(), "prhero-cred-projections");
    const layout = openCodeProjectionLayout(
      path.join(parentDir, randomUUID()),
      parentDir,
    );

    // Every level explicitly at 0700 — `recursive` alone lets an intermediate
    // directory inherit the umask. Same rule as buildOpenCodeProjection.
    for (const dir of layout.directories) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // §6.1: lstat every guarded path EXCEPT the auth file, which does not
    // exist on this route by design. A pre-planted symlink anywhere in the
    // chain means a directory the child writes into landed outside our
    // control.
    for (const component of [parentDir, ...layout.directories]) {
      if (lstatSync(component).isSymbolicLink()) {
        rmSync(layout.syntheticHome, { recursive: true, force: true });
        throw new CredentialProjectionError("projection_layout_invalid");
      }
    }

    return {
      projectionId: `cred-${randomUUID()}`,
      kind: input.kind,
      syntheticHome: layout.syntheticHome,
      syntheticConfigHome: layout.syntheticConfigHome,
      syntheticTmp: layout.syntheticTmp,
      env: {
        HOME: layout.syntheticHome,
        TMPDIR: layout.syntheticTmp,
        // Pinned, not merely absent from the harness allowlist: OpenCode reads
        // XDG_DATA_HOME first, so an inherited value would point the child
        // straight back at the operator's real store.
        XDG_DATA_HOME: layout.xdgDataHome,
        XDG_CONFIG_HOME: layout.xdgConfigHome,
      },
      files: [],
      destroy: async () => {
        rmSync(layout.syntheticHome, { recursive: true, force: true });
      },
    };
  }
}
