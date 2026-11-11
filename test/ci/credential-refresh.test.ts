import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// action.yml's `operation` input (cryskai/platform odd/tasks/openai-oauth.md, E2):
// `review` (the default) keeps every step exactly as it was, and
// `refresh-credential` runs only Setup Bun, the connect step, the install and the
// refresh step.

type ActionStep = {
  id?: string;
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
};

function action(): {
  inputs: Record<string, { default?: string; required?: boolean }>;
  runs: { steps: ActionStep[] };
} {
  return Bun.YAML.parse(
    readFileSync(path.join(import.meta.dir, "../../action.yml"), "utf8"),
  ) as never;
}

const REVIEW = "(inputs.operation == 'review' || inputs.operation == '')";
const REFRESH = "(inputs.operation != 'review' && inputs.operation != '')";

// Every step's `if` before the operation input existed, pinned as text. A review
// step's condition is now REVIEW && (this), which evaluates the same whenever
// REVIEW holds.
const REVIEW_STEPS_BEFORE: ReadonlyArray<readonly [string, string | null]> = [
  ["Resolve trigger", null],
  ["Install Claude Code CLI", "steps.trigger.outputs.run == 'true'"],
  ["Materialize OpenCode CI data", "steps.trigger.outputs.run == 'true'"],
  [
    "Install OpenCode CLI",
    `\${{ steps.trigger.outputs.run == 'true' && (steps.materialize.outputs.opencode-auth-file == 'true' || steps.materialize.outputs.opencode-models == 'true' || steps.platform.outputs.routing-opencode == 'true') }}`,
  ],
  ["Run Crysk", "steps.trigger.outputs.run == 'true'"],
  [
    "Refresh the Crysk token",
    `\${{ !cancelled() && steps.trigger.outputs.publish == 'true' && github.event_name == 'workflow_dispatch' && github.event.inputs['dispatch-id'] != '' }}`,
  ],
  [
    "Publish Crysk outcome",
    `\${{ !cancelled() && steps.trigger.outputs.publish == 'true' }}`,
  ],
  [
    "Report to Crysk",
    `\${{ !cancelled() && github.event_name == 'workflow_dispatch' && github.event.inputs['dispatch-id'] != '' && (steps.trigger.outputs.run == 'true' || steps.trigger.outputs.publish == 'true') && (steps.platform-publish.outputs.run-token != '' || steps.platform.outputs.run-token != '') }}`,
  ],
  [
    "Refresh the Crysk token (cancelled run)",
    `\${{ cancelled() && steps.trigger.outputs.run == 'true' && github.event_name == 'workflow_dispatch' && github.event.inputs['dispatch-id'] != '' }}`,
  ],
  [
    "Settle a cancelled review",
    `\${{ cancelled() && steps.trigger.outputs.run == 'true' }}`,
  ],
  [
    "Upload the Crysk trace",
    `\${{ always() && github.event_name == 'workflow_dispatch' && github.event.inputs['dispatch-id'] != '' && (steps.trigger.outputs.run == 'true' || steps.trigger.outputs.publish == 'true') && (steps.platform-settle.outputs.run-token != '' || steps.platform-publish.outputs.run-token != '' || steps.platform.outputs.run-token != '') }}`,
  ],
  [
    "Upload Crysk run directory",
    "always() && steps.trigger.outputs.run == 'true' && steps.run-crysk.outputs.run_dir != ''",
  ],
];

// Whether a condition has a top-level `||` (outside parentheses and quotes).
function hasTopLevelOr(condition: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < condition.length; i++) {
    const char = condition[i];
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0 && condition.startsWith("||", i)) return true;
  }
  return false;
}

// The review guard appended to the old condition as one more `&&` term, the old
// text kept verbatim, so its status function (always(), cancelled()) still
// leads it. Equivalent to old && REVIEW only when the old condition has no
// top-level `||`, which the test checks.
function guarded(before: string | null): string {
  if (before === null) return REVIEW;
  const wrapped = /^\$\{\{\s*(.*?)\s*\}\}$/s.exec(before)?.[1];
  return wrapped === undefined
    ? `${before} && ${REVIEW}`
    : `\${{ ${wrapped} && ${REVIEW} }}`;
}

// The guards use only string literals, ==, !=, && and || on one input, so
// substituting the input's value gives a JavaScript expression with the same
// result for lowercase values (GitHub compares strings ignoring case).
function evaluate(guard: string, operation: string): boolean {
  return new Function(
    `return ${guard.replaceAll("inputs.operation", JSON.stringify(operation))};`,
  )() as boolean;
}

function stepNamed(name: string): ActionStep | undefined {
  return action().runs.steps.find((step) => step.name === name);
}

describe("action.yml — the operation input", () => {
  test("declares operation, defaulting to review, and refresh-provider", () => {
    const { inputs } = action();
    expect(inputs.operation?.default).toBe("review");
    expect(inputs.operation?.required).toBe(false);
    expect(inputs["refresh-provider"]?.required).toBe(false);
  });

  test("the review guard holds for an absent, empty or review operation, and the refresh guard for anything else", () => {
    // Absent resolves to the declared default; a stub may forward an empty one.
    for (const operation of ["review", ""]) {
      expect(evaluate(REVIEW, operation), operation).toBe(true);
      expect(evaluate(REFRESH, operation), operation).toBe(false);
    }
    // An unknown value runs the refresh step, which refuses it (red), and no
    // review step.
    for (const operation of ["refresh-credential", "refresh"]) {
      expect(evaluate(REVIEW, operation), operation).toBe(false);
      expect(evaluate(REFRESH, operation), operation).toBe(true);
    }
  });

  test("every review step keeps its old condition behind the review guard", () => {
    for (const [name, before] of REVIEW_STEPS_BEFORE) {
      expect(hasTopLevelOr(before ?? ""), name).toBe(false);
      expect(stepNamed(name)?.if, name).toBe(guarded(before));
    }
  });

  test("the shared steps run for both operations, and the install also for a refresh", () => {
    expect(stepNamed("Setup Bun")?.if).toBeUndefined();
    expect(stepNamed("Connect to Crysk")?.if).toBe(
      "github.event_name == 'workflow_dispatch' && github.event.inputs['dispatch-id'] != ''",
    );
    // For a review REFRESH is false, so this is the old condition.
    expect(stepNamed("Install dependencies")?.if).toBe(
      `steps.trigger.outputs.run == 'true' || ${REFRESH}`,
    );
  });

  test("a refresh runs only Setup Bun, the connect step, the install and the refresh step", () => {
    const { steps } = action().runs;
    const known = new Set([
      ...REVIEW_STEPS_BEFORE.map(([name]) => name),
      "Setup Bun",
      "Connect to Crysk",
      "Install dependencies",
      "Refresh the subscription login",
    ]);
    // A step added later must be classified here.
    expect(
      steps.map((step) => step.name).filter((n) => !known.has(n ?? "")),
    ).toEqual([]);
    const refresh = steps.findIndex((step) => step.id === "credential-refresh");
    const install = steps.findIndex(
      (step) => step.name === "Install dependencies",
    );
    expect(refresh).toBe(install + 1);
    expect(steps[refresh]?.if).toBe(REFRESH);
  });

  test("the refresh step reads the secrets on stdin and every other value through env:", () => {
    const step = action().runs.steps.find(
      (candidate) => candidate.id === "credential-refresh",
    );
    expect(step?.run).toBe(
      `printf '%s' "$CRYSK_SECRETS_INPUT" | CRYSK_SECRETS_INPUT= bun "\${{ github.action_path }}/src/ci/credential-refresh.ts" --crysk-secrets-stdin`,
    );
    expect(step?.env?.CRYSK_SECRETS_INPUT).toBe(`\${{ inputs.crysk-secrets }}`);
    expect(step?.env?.CRYSK_OPERATION).toBe(`\${{ inputs.operation }}`);
    expect(step?.env?.CRYSK_REFRESH_PROVIDER).toBe(
      `\${{ inputs.refresh-provider }}`,
    );
    expect(step?.env?.CRYSK_RUN_TOKEN).toBe(
      `\${{ steps.platform.outputs.run-token }}`,
    );
    expect(step?.env?.CRYSK_DISPATCH_ID).toBe(
      `\${{ github.event.inputs['dispatch-id'] }}`,
    );
    for (const name of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "CRYSK_CLAUDE_OAUTH_TOKEN",
      "CRYSK_CLAUDE_API_KEY",
    ]) {
      expect(step?.env?.[name], name).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// src/ci/credential-refresh.ts (E3): the refresh step itself, against a fake
// platform and a fake provider token endpoint. Sealing is real libsodium, and
// the test opens the box with the matching secret key.
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const BASE = "https://platform.test";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
// Sentinels: none of these may appear in a log line other than a mask, in an
// error, or in a platform request body.
const RUN_TOKEN = "run-token-SENTINEL-1111";
const STORED_ACCESS = "stored-access-SENTINEL-2222";
const STORED_REFRESH = "stored-refresh-SENTINEL-3333";
const NEW_ACCESS_SUFFIX = "new-access-SENTINEL-4444";
const NEW_REFRESH = "new-refresh-SENTINEL-5555";
const DISPATCH_ID = "d0000000-0000-4000-8000-000000000001";

function jwt(claims: Record<string, unknown>, tail = "sig"): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.${tail}`;
}

function secretLine(record: Record<string, unknown>): string {
  return `CRYSK_OPENCODE_OPENAI_OAUTH=${Buffer.from(JSON.stringify(record)).toString("base64")}`;
}

const STORED_RECORD = {
  type: "oauth",
  access: STORED_ACCESS,
  refresh: STORED_REFRESH,
  expires: NOW + 2 * 24 * 60 * 60 * 1000,
  accountId: "acct-stored",
};

type Call = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

type Answer = Response | (() => Response) | "throw";

async function keypair() {
  const { default: sodium } = await import("libsodium-wrappers");
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return {
    sodium,
    pair,
    publicKey: sodium.to_base64(
      pair.publicKey,
      sodium.base64_variants.ORIGINAL,
    ),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function runRefresh(options: {
  answers: Record<string, Answer[]>;
  env?: Record<string, string>;
  secrets?: string;
  publicKey?: string;
}) {
  const { runCredentialRefresh, CREDENTIAL_REFRESH_PATHS } = await import(
    "../../src/ci/credential-refresh"
  );
  const keys = await keypair();
  const publicKey = options.publicKey ?? keys.publicKey;
  const queues: Record<string, Answer[]> = {
    [`${BASE}${CREDENTIAL_REFRESH_PATHS.targets}`]: [
      json({ key_id: "key-1", key: publicKey }),
    ],
    [`${BASE}${CREDENTIAL_REFRESH_PATHS.begin}`]: [json({ ok: true })],
    [`${BASE}${CREDENTIAL_REFRESH_PATHS.result}`]: [json({ ok: true })],
    ...options.answers,
  };
  const calls: Call[] = [];
  let clock = NOW;
  const sleeps: number[] = [];
  const out: string[] = [];
  const exitCode = await runCredentialRefresh({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        headers: { ...(init?.headers as Record<string, string>) },
        body: String(init?.body ?? ""),
      });
      const queue = queues[url];
      if (queue === undefined || queue.length === 0) {
        throw new Error(`unexpected request to ${url}`);
      }
      const answer = queue.length > 1 ? queue.shift() : queue[0];
      if (answer === "throw") {
        throw new Error(`socket closed while sending ${RUN_TOKEN}`);
      }
      return typeof answer === "function"
        ? answer()
        : (answer as Response).clone();
    }) as typeof fetch,
    env: {
      CRYSK_OPERATION: "refresh-credential",
      CRYSK_REFRESH_PROVIDER: "openai",
      CRYSK_RUN_TOKEN: RUN_TOKEN,
      CRYSK_DISPATCH_ID: DISPATCH_ID,
      ...options.env,
    },
    cryskSecrets: options.secrets ?? `${secretLine(STORED_RECORD)}\n`,
    baseUrl: BASE,
    stdout: (text) => out.push(text),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  const paths = calls.map((call) =>
    call.url.startsWith(BASE) ? call.url.slice(BASE.length) : call.url,
  );
  return { exitCode, calls, paths, sleeps, out: out.join(""), keys };
}

function resultBodies(calls: Call[]): Record<string, unknown>[] {
  return calls
    .filter((call) => call.url === `${BASE}/runs/credential-refresh`)
    .map((call) => JSON.parse(call.body) as Record<string, unknown>);
}

const NEW_ACCESS = jwt(
  {
    exp: Math.floor(NOW / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-jwt" },
  },
  NEW_ACCESS_SUFFIX,
);
const PROVIDER_OK = json({
  access_token: NEW_ACCESS,
  refresh_token: NEW_REFRESH,
  id_token: jwt({ chatgpt_account_id: "acct-from-id-token" }, "idsig-SENTINEL"),
  expires_in: 864000,
  token_type: "Bearer",
});

const SENTINELS = [
  RUN_TOKEN,
  STORED_ACCESS,
  STORED_REFRESH,
  NEW_ACCESS_SUFFIX,
  NEW_REFRESH,
];

// Every line but the masks, which are how the runner learns to hide a value.
function unmaskedLog(out: string): string {
  return out
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
}

describe("credential-refresh.ts — renewing a subscription login", () => {
  test("renews the login, seals OpenCode's record for the target and posts only ciphertext", async () => {
    const run = await runRefresh({ answers: { [TOKEN_URL]: [PROVIDER_OK] } });
    expect(run.exitCode).toBe(0);
    expect(run.paths).toEqual([
      "/runs/credential-refresh/targets",
      "/runs/credential-refresh/begin",
      TOKEN_URL,
      "/runs/credential-refresh",
    ]);
    for (const call of run.calls.filter((c) => c.url.startsWith(BASE))) {
      expect(call.headers.Authorization).toBe(`Bearer ${RUN_TOKEN}`);
      expect(call.headers["X-Crysk-Dispatch-Id"]).toBe(DISPATCH_ID);
    }
    expect(JSON.parse(run.calls[0]?.body ?? "")).toEqual({
      provider: "openai",
    });
    expect(JSON.parse(run.calls[1]?.body ?? "")).toEqual({
      provider: "openai",
    });

    const provider = run.calls[2] as Call;
    expect(provider.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(new URLSearchParams(provider.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: STORED_REFRESH,
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });

    const [result] = resultBodies(run.calls);
    expect(Object.keys(result ?? {}).sort()).toEqual([
      "encrypted_value",
      "expires_at",
      "issued_at",
      "key_id",
      "provider",
      "provider_account_id",
    ]);
    expect(result?.provider).toBe("openai");
    expect(result?.key_id).toBe("key-1");
    expect(result?.issued_at).toBe(new Date(NOW).toISOString());
    expect(result?.expires_at).toBe(
      new Date(NOW + 864000 * 1000).toISOString(),
    );
    // id_token first, as OpenCode reads it.
    expect(result?.provider_account_id).toBe("acct-from-id-token");

    // The box opens with the target's secret key, and its plaintext is the
    // secret's value exactly as the engine reads CRYSK_OPENCODE_OPENAI_OAUTH.
    const { sodium, pair } = run.keys;
    const plaintext = sodium.to_string(
      sodium.crypto_box_seal_open(
        sodium.from_base64(
          String(result?.encrypted_value),
          sodium.base64_variants.ORIGINAL,
        ),
        pair.publicKey,
        pair.privateKey,
      ),
    );
    const { parseCryskSecrets } = await import("../../src/ci/crysk-secrets");
    const parsed = parseCryskSecrets(
      `CRYSK_OPENCODE_OPENAI_OAUTH=${plaintext}`,
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.secrets.opencode.get("OPENAI")?.oauth).toEqual({
      type: "oauth",
      refresh: NEW_REFRESH,
      access: NEW_ACCESS,
      expires: NOW + 864000 * 1000,
      accountId: "acct-from-id-token",
    });
  });

  test("keeps the stored account id and refresh token when the answer carries neither, and reads the expiry from the JWT", async () => {
    const run = await runRefresh({
      answers: {
        [TOKEN_URL]: [json({ access_token: jwt({ exp: NOW / 1000 + 7200 }) })],
      },
    });
    expect(run.exitCode).toBe(0);
    const [result] = resultBodies(run.calls);
    expect(result?.provider_account_id).toBe("acct-stored");
    expect(result?.expires_at).toBe(new Date(NOW + 7200 * 1000).toISOString());
    const { sodium, pair } = run.keys;
    const record = JSON.parse(
      Buffer.from(
        sodium.to_string(
          sodium.crypto_box_seal_open(
            sodium.from_base64(
              String(result?.encrypted_value),
              sodium.base64_variants.ORIGINAL,
            ),
            pair.publicKey,
            pair.privateKey,
          ),
        ),
        "base64",
      ).toString("utf8"),
    );
    expect(record.refresh).toBe(STORED_REFRESH);
    expect(record.accountId).toBe("acct-stored");
  });

  for (const code of [
    "refresh_token_reused",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "invalid_grant",
  ]) {
    for (const [shape, body] of [
      ["error.code", { error: { code, message: `bad ${STORED_REFRESH}` } }],
      ["string error", { error: code, error_description: "gone" }],
      ["top-level code", { code }],
    ] as const) {
      test(`a permanent ${code} (${shape}) posts the failure and ends red`, async () => {
        const run = await runRefresh({
          answers: { [TOKEN_URL]: [json(body, 401)] },
        });
        expect(run.exitCode).toBe(1);
        expect(resultBodies(run.calls)).toEqual([
          { provider: "openai", failure: code },
        ]);
        expect(run.out).toContain(code);
        for (const sentinel of SENTINELS) {
          expect(unmaskedLog(run.out)).not.toContain(sentinel);
        }
      });
    }
  }

  test("any other provider error posts provider_error, never the provider's text", async () => {
    for (const answer of [
      json({ error: { code: "server_error" } }, 500),
      json({ error: "rate_limited" }, 429),
      new Response("<html>bad gateway</html>", { status: 502 }),
      json({ token_type: "Bearer" }),
    ]) {
      const run = await runRefresh({ answers: { [TOKEN_URL]: [answer] } });
      expect(run.exitCode).toBe(1);
      expect(resultBodies(run.calls)).toEqual([
        { provider: "openai", failure: "provider_error" },
      ]);
    }
  });

  test("a provider request that fails in flight is never retried and reports nothing", async () => {
    const run = await runRefresh({ answers: { [TOKEN_URL]: ["throw"] } });
    expect(run.exitCode).toBe(1);
    expect(run.paths.filter((p) => p === TOKEN_URL)).toHaveLength(1);
    expect(resultBodies(run.calls)).toEqual([]);
    expect(run.out).toContain("may have been spent");
  });

  test("an unknown provider, a wrong operation, or a missing record ends red before any request", async () => {
    const cases: Array<{ env?: Record<string, string>; secrets?: string }> = [
      { env: { CRYSK_REFRESH_PROVIDER: "anthropic" } },
      { env: { CRYSK_REFRESH_PROVIDER: "" } },
      { env: { CRYSK_OPERATION: "refresh" } },
      { env: { CRYSK_RUN_TOKEN: "" } },
      { env: { CRYSK_DISPATCH_ID: "" } },
      { secrets: "CRYSK_OPENCODE_OPENAI_OAUTH=\n" },
      { secrets: "CRYSK_OPENCODE_OPENAI_OAUTH=not base64!\n" },
      { secrets: secretLine({ ...STORED_RECORD, refresh: "" }) },
    ];
    for (const options of cases) {
      const run = await runRefresh({ answers: {}, ...options });
      expect(run.exitCode, JSON.stringify(options)).toBe(1);
      expect(run.calls, JSON.stringify(options)).toEqual([]);
      expect(run.out).toContain("::error title=crysk::");
    }
    const unknown = await runRefresh({
      answers: {},
      env: { CRYSK_REFRESH_PROVIDER: "anthropic" },
    });
    expect(unknown.out).toContain('"anthropic" is not a subscription provider');
  });

  test("a failure before the provider call spends nothing: no begin after a bad target, no provider call after a refused begin", async () => {
    const noTarget = await runRefresh({
      answers: { [`${BASE}/runs/credential-refresh/targets`]: [json({}, 503)] },
    });
    expect(noTarget.exitCode).toBe(1);
    expect(noTarget.paths).toEqual(["/runs/credential-refresh/targets"]);
    expect(noTarget.out).toContain("nothing was spent");

    const badKey = await runRefresh({ answers: {}, publicKey: "AAAA" });
    expect(badKey.exitCode).toBe(1);
    expect(badKey.paths).toEqual(["/runs/credential-refresh/targets"]);

    const refused = await runRefresh({
      answers: { [`${BASE}/runs/credential-refresh/begin`]: [json({}, 409)] },
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.paths).toEqual([
      "/runs/credential-refresh/targets",
      "/runs/credential-refresh/begin",
    ]);
  });

  test("after a spend, the result POST is retried with backoff until the platform takes it", async () => {
    const run = await runRefresh({
      answers: {
        [TOKEN_URL]: [PROVIDER_OK],
        [`${BASE}/runs/credential-refresh`]: [
          "throw",
          json({}, 503),
          json({}, 429),
          json({ ok: true }),
        ],
      },
    });
    expect(run.exitCode).toBe(0);
    expect(resultBodies(run.calls)).toHaveLength(4);
    // The same sealed record every time: it is held in memory, never re-made.
    expect(
      new Set(resultBodies(run.calls).map((b) => b.encrypted_value)).size,
    ).toBe(1);
    expect(run.sleeps).toEqual([5000, 10000, 20000]);
    expect(run.paths.filter((p) => p === TOKEN_URL)).toHaveLength(1);
  });

  test("the result POST stops on a refusal, and gives up after the retry budget", async () => {
    const refused = await runRefresh({
      answers: {
        [TOKEN_URL]: [PROVIDER_OK],
        [`${BASE}/runs/credential-refresh`]: [json({}, 409)],
      },
    });
    expect(refused.exitCode).toBe(1);
    expect(resultBodies(refused.calls)).toHaveLength(1);

    const down = await runRefresh({
      answers: {
        [TOKEN_URL]: [PROVIDER_OK],
        [`${BASE}/runs/credential-refresh`]: [json({}, 503)],
      },
    });
    expect(down.exitCode).toBe(1);
    const { RESULT_RETRY_BUDGET_MS } = await import(
      "../../src/ci/credential-refresh"
    );
    const slept = down.sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(slept).toBeLessThanOrEqual(RESULT_RETRY_BUDGET_MS);
    expect(slept).toBeGreaterThan(RESULT_RETRY_BUDGET_MS / 2);
    expect(down.out).toContain("the stored login was spent");
  });

  test("no token reaches the log, an error, or a platform request in plain text", async () => {
    const runs = [
      await runRefresh({ answers: { [TOKEN_URL]: [PROVIDER_OK] } }),
      await runRefresh({ answers: { [TOKEN_URL]: ["throw"] } }),
      await runRefresh({
        answers: { [`${BASE}/runs/credential-refresh/targets`]: ["throw"] },
      }),
      await runRefresh({
        answers: {
          [TOKEN_URL]: [PROVIDER_OK],
          [`${BASE}/runs/credential-refresh`]: [json({}, 400)],
        },
      }),
    ];
    for (const run of runs) {
      const log = unmaskedLog(run.out);
      const platformBodies = run.calls
        .filter((call) => call.url.startsWith(BASE))
        .map((call) => call.body)
        .join("\n");
      for (const sentinel of SENTINELS) {
        expect(log).not.toContain(sentinel);
        expect(platformBodies).not.toContain(sentinel);
      }
    }
    // The new tokens are masked before anything else is printed.
    const ok = runs[0]?.out ?? "";
    for (const value of [NEW_ACCESS, NEW_REFRESH, STORED_REFRESH, RUN_TOKEN]) {
      const mask = ok.indexOf(`::add-mask::${value}\n`);
      expect(mask, value).toBeGreaterThanOrEqual(0);
    }
    expect(ok).not.toContain("::add-mask::Bearer");
  });
});
