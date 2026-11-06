// The action's platform step: trade the run's GitHub Actions OIDC token for a
// repo-scoped installation token, so a review the Crysk platform dispatched
// posts as the Crysk App's bot instead of github-actions[bot].
//
// It runs only in platform mode (action.yml gates the step on
// `workflow_dispatch` plus a non-empty `dispatch-id`), BEFORE the trigger
// step, and standalone use never reaches it.
//
// WHY the base URL is a constant: anyone with write access can dispatch a
// workflow with arbitrary inputs, so a URL taken from an input or an env var
// the workflow controls would let them send the run's OIDC token to a server of
// their choosing. The tests inject the URL as a parameter; the shell below
// never reads it from the environment.
//
// WHY it fails loudly: in platform mode there is no silent fallback to
// `github.token`. A review that quietly posted as the wrong identity, or not at
// all, is worse than a red run that names the cause.
//
// WHY ONLY BUILTINS: like the trigger, this runs before `bun install`. Keep
// every import `node:` or `bun`, and `fetch` is the runtime's own.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PLATFORM_API_URL = "https://api.crysk.dev";

// The audience the platform verifies. An OIDC token minted for any other
// audience is refused with a 401.
const OIDC_AUDIENCE = "crysk";

// Long enough for a slow API, short enough that a hung endpoint cannot hold the
// job: this step runs first, before anything else.
const REQUEST_TIMEOUT_MS = 30_000;

// A GitHub login as the platform returns it (`crysk-dev[bot]`). It lands in a
// trust set and in $GITHUB_OUTPUT, so nothing else is accepted.
const SAFE_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;

const MISSING_OIDC =
  "The workflow did not grant `id-token: write`, so GitHub issued no OIDC token to this run. Add `id-token: write` to the workflow's `permissions:` and dispatch again.";

// The review configuration the platform holds for this repository, split by the
// layer each key belongs to (the engine's CONFIG_DIRECTION): `person` is the
// runner's personal config, `repo` the repository layer. The platform has
// already validated the values; the engine's parsers stay the authority and
// re-check them where they are applied (src/ci/platform-config.ts), because this
// step runs before `bun install` and cannot import them.
export interface PlatformConfig {
  person: Record<string, unknown>;
  repo: Record<string, unknown>;
}

// The file the connect step leaves under CRYSK_PLATFORM_CONFIG_DIR, and the
// setup step reads. Written 0600 under the runner's temp directory, never in the
// workspace.
export const PLATFORM_CONFIG_FILE_NAME = "platform-config.json";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `config` as the token response carries it. Absent (an older platform) or two
// empty objects is "no configuration": `config` is left out of the result, and
// nothing downstream runs. A present value of the wrong shape is a failure, not
// a silent skip: a review with the wrong limits is worse than no review.
export function parsePlatformConfig(
  value: unknown,
): { ok: true; config?: PlatformConfig } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true };
  if (!isPlainObject(value)) {
    return { ok: false, message: "`config` must be a JSON object." };
  }
  const layers: Record<"person" | "repo", Record<string, unknown>> = {
    person: {},
    repo: {},
  };
  for (const layer of ["person", "repo"] as const) {
    const body = value[layer];
    if (body === undefined || body === null) continue;
    if (!isPlainObject(body)) {
      return {
        ok: false,
        message: `\`config.${layer}\` must be a JSON object.`,
      };
    }
    layers[layer] = body;
  }
  if (
    Object.keys(layers.person).length === 0 &&
    Object.keys(layers.repo).length === 0
  ) {
    return { ok: true };
  }
  return { ok: true, config: layers };
}

// How much of the run the platform may keep, as /runs/token's `data_mode`
// says. `full` is the only value that lets the report step send finding text.
export type PlatformDataMode = "full" | "metadata_only";

export type PlatformTokenResult =
  // `githubActor` is the login the platform says posts as the App's bot. It is
  // absent when the platform sent none or one that is not a plausible login.
  // `config` is absent when the platform sent none or only empty objects.
  // `dataMode` is absent when the platform sent none or anything but exactly
  // `full` or `metadata_only`; the connect step reads absence as metadata_only.
  | {
      ok: true;
      githubToken: string;
      runToken: string;
      githubActor?: string;
      dataMode?: PlatformDataMode;
      config?: PlatformConfig;
    }
  // `message` names the HTTP status and the API's own `message` when there was
  // one. It never carries a token.
  | { ok: false; message: string };

export interface PlatformTokenDeps {
  fetch: typeof fetch;
  env: Readonly<Record<string, string | undefined>>;
  baseUrl: string;
  // Called with each secret as soon as it is known, before it is used or
  // returned, so the caller can emit `::add-mask::` ahead of any other write.
  mask: (secret: string) => void;
  // Waits between OIDC attempts; tests inject a no-op.
  sleep?: (ms: number) => Promise<void>;
  // The refresh steps never use the configuration in their response, so they
  // set this and a config of the wrong shape cannot turn a finished job red.
  ignoreConfig?: boolean;
}

// The OIDC GET is idempotent, so a blip (a thrown fetch, a timeout, a 5xx) is
// retried; the platform POST below is NOT: the platform refuses a second
// exchange of the same OIDC token (HTTP 409, keyed on its jti). Every run of
// this script asks GitHub for a NEW OIDC token, so a later step can exchange
// again for a fresh installation token; a retry of the POST could not.
const OIDC_ATTEMPTS = 3;
const OIDC_BACKOFF_MS = 1_000;

async function fetchOidc(
  deps: PlatformTokenDeps,
  url: string,
  requestToken: string,
): Promise<Response> {
  const sleep =
    deps.sleep ??
    ((ms: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    });
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await deps.fetch(url, {
        headers: { Authorization: `bearer ${requestToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status < 500 || attempt === OIDC_ATTEMPTS) return response;
    } catch (error) {
      if (attempt === OIDC_ATTEMPTS) throw error;
    }
    await sleep(OIDC_BACKOFF_MS * attempt);
  }
}

// A token is written to $GITHUB_OUTPUT as `name=value`, so one that holds a
// line break or any other whitespace could plant a second output. Installation
// and run tokens are printable ASCII; refuse anything else.
const SAFE_TOKEN = /^[\x21-\x7e]+$/;

function failure(
  message: string,
  secrets: readonly string[],
): PlatformTokenResult {
  let safe = message;
  for (const secret of secrets) {
    if (secret !== "") safe = safe.split(secret).join("***");
  }
  return { ok: false, message: safe };
}

// The API's `{ message }`, when the body is JSON and has one.
async function apiMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "message" in body) {
      const { message } = body as { message: unknown };
      if (typeof message === "string" && message !== "") return message;
    }
  } catch {
    // Not JSON: the status alone names the failure.
  }
  return undefined;
}

export async function exchangePlatformToken(
  deps: PlatformTokenDeps,
): Promise<PlatformTokenResult> {
  const requestUrl = deps.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "";
  const requestToken = deps.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "";
  const dispatchId = deps.env.CRYSK_DISPATCH_ID ?? "";
  if (requestUrl === "" || requestToken === "") {
    return { ok: false, message: MISSING_OIDC };
  }
  // The runner already masks its own request token, and the secrets list keeps
  // it out of any message a failure builds.
  const secrets: string[] = [requestToken];

  try {
    const oidcResponse = await fetchOidc(
      deps,
      `${requestUrl}${requestUrl.includes("?") ? "&" : "?"}audience=${OIDC_AUDIENCE}`,
      requestToken,
    );
    if (!oidcResponse.ok) {
      return failure(
        `GitHub's OIDC endpoint answered HTTP ${oidcResponse.status}; the run could not obtain an identity token.`,
        secrets,
      );
    }
    const oidcBody = (await oidcResponse.json()) as { value?: unknown };
    const oidc = oidcBody.value;
    if (typeof oidc !== "string" || oidc === "") {
      return failure("GitHub's OIDC endpoint returned no token.", secrets);
    }
    deps.mask(oidc);
    secrets.push(oidc);

    const response = await deps.fetch(`${deps.baseUrl}/runs/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidc}`,
        "X-Crysk-Dispatch-Id": dispatchId,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const message = await apiMessage(response);
      return failure(
        `The Crysk platform refused the token exchange: HTTP ${response.status}${message === undefined ? "" : ` — ${message}`}`,
        secrets,
      );
    }
    const body = (await response.json()) as {
      github_token?: unknown;
      run_token?: unknown;
      github_actor?: unknown;
      data_mode?: unknown;
      config?: unknown;
    };
    const {
      github_token: githubToken,
      run_token: runToken,
      github_actor: actor,
      data_mode: dataMode,
    } = body;
    // Mask whatever string arrived before judging it, so a malformed reply
    // still cannot leak a token into the log.
    for (const value of [githubToken, runToken]) {
      if (typeof value === "string" && value !== "") deps.mask(value);
    }
    if (
      typeof githubToken !== "string" ||
      typeof runToken !== "string" ||
      !SAFE_TOKEN.test(githubToken) ||
      !SAFE_TOKEN.test(runToken)
    ) {
      return failure(
        "The Crysk platform answered HTTP 200 without a usable github_token and run_token.",
        [...secrets, String(githubToken), String(runToken)],
      );
    }
    const config: ReturnType<typeof parsePlatformConfig> =
      deps.ignoreConfig === true
        ? { ok: true }
        : parsePlatformConfig(body.config);
    if (!config.ok) {
      return failure(
        `The Crysk platform answered HTTP 200 with a malformed config: ${config.message}`,
        [...secrets, githubToken, runToken],
      );
    }
    return {
      ok: true,
      githubToken,
      runToken,
      ...(typeof actor === "string" && SAFE_LOGIN.test(actor)
        ? { githubActor: actor }
        : {}),
      ...(dataMode === "full" || dataMode === "metadata_only"
        ? { dataMode }
        : {}),
      ...(config.config === undefined ? {} : { config: config.config }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      `The Crysk platform token exchange could not complete: ${detail}`,
      secrets,
    );
  }
}

// Workflow-command data escaping, as the runner's own toolkit does it.
function escapeCommandData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export interface PlatformConnectDeps extends Omit<PlatformTokenDeps, "mask"> {
  stdout: (text: string) => void;
  appendOutput: (text: string) => void;
  // Where the review configuration is left for the setup step. Set by the first
  // connect step only: the refresh steps run after the review and must not touch
  // it, so they leave this unset and the config in their response is ignored.
  configDir?: string;
}

// Hands the platform's review configuration to the setup step as a 0600 file
// under the runner's temp directory (never the workspace). Returns the path.
function writePlatformConfig(dir: string, config: PlatformConfig): string {
  const file = path.join(dir, PLATFORM_CONFIG_FILE_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return file;
}

// The step's shell. Every token is masked BEFORE the output is written, and a
// failure writes no output at all: the later steps see no platform token and the
// job is red, never silently on `github.token`.
export async function runPlatformConnect(
  deps: PlatformConnectDeps,
): Promise<number> {
  const result = await exchangePlatformToken({
    ...deps,
    // Only the first connect step (it binds the config directory) uses it.
    ignoreConfig: deps.configDir === undefined,
    mask: (secret) => deps.stdout(`::add-mask::${escapeCommandData(secret)}\n`),
  });
  if (!result.ok) {
    deps.stdout(
      `::error title=crysk::${escapeCommandData(`Crysk platform mode failed: ${result.message}`)}\n`,
    );
    return 1;
  }
  // WHY the config file is written before any output: a failure writes no
  // output at all, so a run whose configuration could not be applied never
  // looks connected. The failure names the file, never a value.
  let configFile: string | undefined;
  if (result.config !== undefined && deps.configDir !== undefined) {
    try {
      configFile = writePlatformConfig(deps.configDir, result.config);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.stdout(
        `::error title=crysk::${escapeCommandData(`Crysk platform mode failed: the review configuration could not be written to ${path.join(deps.configDir, PLATFORM_CONFIG_FILE_NAME)}: ${detail}`)}\n`,
      );
      return 1;
    }
  }
  // WHY a throw is an error and not a green step: the later steps read this
  // output with `|| inputs.github-token`, so a token that was never written
  // would silently post as github-actions[bot].
  try {
    // WHY fail closed: `data-mode` decides whether the report step may send
    // finding text at all (src/ci/platform-report.ts), and a repository in
    // metadata-only mode must never have its code leave the runner. A missing
    // or unrecognised value therefore reads as metadata_only, with a notice.
    // Written by EVERY exchange, refresh steps included: the report step reads
    // the freshest one (the publish refresh, minted after the run), because the
    // first token can be 75 minutes old and the repository's mode may have
    // been switched to metadata_only since.
    // WHY first: the report step pairs this exchange's run token with this
    // exchange's data mode. Appends are not atomic, so if one throws the step
    // fails; with the mode written before the tokens, a refresh that left a
    // run token always left its mode, and the report never pairs a fresh
    // token with the stale first-exchange mode.
    deps.appendOutput(`data-mode=${result.dataMode ?? "metadata_only"}\n`);
    if (result.dataMode === undefined) {
      deps.stdout(
        "::notice title=crysk::The Crysk platform sent no recognised data_mode; treating this repository as metadata_only, so no finding text is uploaded.\n",
      );
    }
    deps.appendOutput(`github-token=${result.githubToken}\n`);
    // The run token authenticates the report step (src/ci/platform-report.ts).
    // Already masked by the exchange above, like the installation token.
    deps.appendOutput(`run-token=${result.runToken}\n`);
    // Not a secret. Only a login the platform returned, so the engine's trust
    // set never learns one from anywhere else (see CRYSK_PLATFORM_ACTOR).
    if (result.githubActor !== undefined) {
      deps.appendOutput(`github-actor=${result.githubActor}\n`);
    }
    // Present only when there is configuration to apply: the setup step and the
    // run step are gated on it, so a standalone run (no platform step, no
    // output) and an empty config both skip everything.
    if (configFile !== undefined) {
      deps.appendOutput(`config-file=${configFile}\n`);
      // The same test the OpenCode install step makes of the routing input
      // (`contains(inputs.routing, 'opencode')`): platform routing that names
      // OpenCode needs the CLI installed too. Present whenever the platform
      // sent a routing, `false` included, because platform routing wins over
      // the input: action.yml reads an empty output as "use the input's" and
      // any value as the platform's answer, so a platform routing that does not
      // name OpenCode overrides an input that does.
      // Read off `models` now (S1): an `opencode:` model needs the CLI. A
      // platform `routing` is refused by the setup step's person parser.
      const models = result.config?.person.models;
      if (models !== undefined) {
        deps.appendOutput(
          `routing-opencode=${JSON.stringify(models).includes('"opencode:')}\n`,
        );
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.stdout(
      `::error title=crysk::${escapeCommandData(`Crysk platform mode failed: the installation token could not be handed to the later steps: ${detail}`)}\n`,
    );
    return 1;
  }
  return 0;
}

// Appends to the file the runner named in GITHUB_OUTPUT. Unset or empty is an
// error, not a no-op: see runPlatformConnect.
export function appendGithubOutput(
  outputPath: string | undefined,
  text: string,
): void {
  if (outputPath === undefined || outputPath === "") {
    throw new Error("GITHUB_OUTPUT is not set");
  }
  appendFileSync(outputPath, text);
}

if (import.meta.main) {
  process.exit(
    await runPlatformConnect({
      fetch,
      env: process.env,
      baseUrl: PLATFORM_API_URL,
      stdout: (text) => process.stdout.write(text),
      appendOutput: (text) =>
        appendGithubOutput(process.env.GITHUB_OUTPUT, text),
      // Bound by the connect step only (action.yml), never by a refresh step.
      ...(process.env.CRYSK_PLATFORM_CONFIG_DIR
        ? { configDir: process.env.CRYSK_PLATFORM_CONFIG_DIR }
        : {}),
    }),
  );
}
