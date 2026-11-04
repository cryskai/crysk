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

import { appendFileSync } from "node:fs";

export const PLATFORM_API_URL = "https://api.crysk.dev";

// The audience the platform verifies. An OIDC token minted for any other
// audience is refused with a 401.
const OIDC_AUDIENCE = "crysk";

// Long enough for a slow API, short enough that a hung endpoint cannot hold the
// job: this step runs first, before anything else.
const REQUEST_TIMEOUT_MS = 30_000;

const MISSING_OIDC =
  "The workflow did not grant `id-token: write`, so GitHub issued no OIDC token to this run. Add `id-token: write` to the workflow's `permissions:` and dispatch again.";

export type PlatformTokenResult =
  | { ok: true; githubToken: string; runToken: string }
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
    const oidcResponse = await deps.fetch(
      `${requestUrl}${requestUrl.includes("?") ? "&" : "?"}audience=${OIDC_AUDIENCE}`,
      {
        headers: { Authorization: `bearer ${requestToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
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
    };
    const { github_token: githubToken, run_token: runToken } = body;
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
    return { ok: true, githubToken, runToken };
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
}

// The step's shell. Both tokens are masked BEFORE the output is written, and a
// failure writes no output at all: the later steps see no platform token and the
// job is red, never silently on `github.token`.
export async function runPlatformConnect(
  deps: PlatformConnectDeps,
): Promise<number> {
  const result = await exchangePlatformToken({
    ...deps,
    mask: (secret) => deps.stdout(`::add-mask::${escapeCommandData(secret)}\n`),
  });
  if (!result.ok) {
    deps.stdout(
      `::error title=crysk::${escapeCommandData(`Crysk platform mode failed: ${result.message}`)}\n`,
    );
    return 1;
  }
  deps.appendOutput(`github-token=${result.githubToken}\n`);
  return 0;
}

if (import.meta.main) {
  const outputPath = process.env.GITHUB_OUTPUT;
  process.exit(
    await runPlatformConnect({
      fetch,
      env: process.env,
      baseUrl: PLATFORM_API_URL,
      stdout: (text) => process.stdout.write(text),
      appendOutput: (text) => {
        if (outputPath !== undefined && outputPath !== "") {
          appendFileSync(outputPath, text);
        }
      },
    }),
  );
}
