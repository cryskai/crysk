// S5 (odd/tasks/role-model-routing.md): which Claude credential a run uses, and the env
// its child sees. Assertions read key presence and kinds only; no test prints an env.
import { describe, expect, test } from "bun:test";
import { classifyCliError } from "#ci/classify-error";
import { codeOf } from "#ci/outcome";
import type { AdmissionRecord } from "../../src/ci/admission-ledger";
import { deriveCiBillingMode } from "../../src/ci/gates";
import { envBillsMetered } from "../../src/execution/usage-normalized";
import { settleClaudeCredentialRefusal } from "../../src/pr/admission";
import type { ClaudeCredentialKind } from "../../src/review/preflight";
import { OpenCodeCredentialRefusalError } from "../../src/review/route-preflight";
import {
  CLAUDE_CREDENTIAL_VARIABLES,
  ClaudeCredentialRefusalError,
  claudeCredentialPresence,
  claudeCredentialRefusal,
  claudeRunEnv,
  clearCryskClaudeIntake,
  cryskIntakeEnv,
  defaultClaudeLoginPresent,
  resolveRunClaudeCredential,
  selectClaudeCredential,
  takeCryskClaudeSecrets,
} from "../../src/security/claude-credential";

const ORDERS: ReadonlyArray<{
  label: string;
  order: readonly ClaudeCredentialKind[] | undefined;
}> = [
  { label: "absent", order: undefined },
  { label: "[subscription]", order: ["subscription"] },
  { label: "[api_key]", order: ["api_key"] },
  { label: "[subscription, api_key]", order: ["subscription", "api_key"] },
  { label: "[api_key, subscription]", order: ["api_key", "subscription"] },
];

const PRESENCES: ReadonlyArray<{
  label: string;
  env: Record<string, string>;
  sub: boolean;
  key: boolean;
}> = [
  { label: "nothing", env: {}, sub: false, key: false },
  {
    label: "only the OAuth token",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-old" },
    sub: true,
    key: false,
  },
  {
    label: "only the API key",
    env: { ANTHROPIC_API_KEY: "key-old" },
    sub: false,
    key: true,
  },
  {
    label: "both",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-old", ANTHROPIC_API_KEY: "key-old" },
    sub: true,
    key: true,
  },
];

// The expected choice: the first kind in the order that is present.
function expectedKind(
  order: readonly ClaudeCredentialKind[] | undefined,
  sub: boolean,
  key: boolean,
): ClaudeCredentialKind | undefined {
  for (const kind of order ?? ["subscription", "api_key"]) {
    if (kind === "subscription" && sub) return kind;
    if (kind === "api_key" && key) return kind;
  }
  return undefined;
}

function childKeys(env: Record<string, string | undefined>): {
  oauth: boolean;
  apiKey: boolean;
  authToken: boolean;
} {
  return {
    oauth: env.CLAUDE_CODE_OAUTH_TOKEN !== undefined,
    apiKey: env.ANTHROPIC_API_KEY !== undefined,
    authToken: env.ANTHROPIC_AUTH_TOKEN !== undefined,
  };
}

describe("selectClaudeCredential over every presence x credentials.claude", () => {
  for (const { label: presenceLabel, env, sub, key } of PRESENCES) {
    for (const { label: orderLabel, order } of ORDERS) {
      test(`${presenceLabel}, credentials.claude ${orderLabel}`, () => {
        const run = resolveRunClaudeCredential({
          credentials: order === undefined ? undefined : { claude: order },
          env,
          loginPresent: false,
        });
        const want = expectedKind(order, sub, key);
        expect(run.kind).toBe(want);
        expect(run.selection.status).toBe(
          want === undefined ? "none" : "chosen",
        );
        const keys = childKeys(run.env);
        // Exactly one Claude variable, the CLI's own name for the chosen kind.
        expect(keys.oauth).toBe(want === "subscription");
        expect(keys.apiKey).toBe(want === "api_key");
        expect(keys.authToken).toBe(false);
        if (want === "subscription") {
          expect(run.env.CLAUDE_CODE_OAUTH_TOKEN === "oauth-old").toBe(true);
        }
        if (want === "api_key") {
          expect(run.env.ANTHROPIC_API_KEY === "key-old").toBe(true);
        }
      });
    }
  }

  test("the default order is subscription, then api_key", () => {
    const selection = selectClaudeCredential(undefined, {
      subscription: "CLAUDE_CODE_OAUTH_TOKEN",
      api_key: "ANTHROPIC_API_KEY",
    });
    expect(selection.status).toBe("chosen");
    if (selection.status !== "chosen") return;
    expect(selection.kind).toBe("subscription");
    expect(selection.order).toEqual(["subscription", "api_key"]);
    expect(selection.orderDefaulted).toBe(true);
  });

  test("a present credential not in the order is never used", () => {
    const selection = selectClaudeCredential(["api_key"], {
      subscription: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    expect(selection.status).toBe("none");
  });
});

describe("credential sources", () => {
  test("CRYSK_* secrets count, and win over the old names, under the CLI's names in the child", () => {
    const env = {
      CRYSK_CLAUDE_OAUTH_TOKEN: "oauth-new",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-old",
      CRYSK_CLAUDE_API_KEY: "key-new",
    };
    const sub = resolveRunClaudeCredential({ env, loginPresent: false });
    expect(sub.selection.status === "chosen" && sub.selection.source).toBe(
      "CRYSK_CLAUDE_OAUTH_TOKEN",
    );
    expect(sub.env.CLAUDE_CODE_OAUTH_TOKEN === "oauth-new").toBe(true);
    expect(sub.env.CRYSK_CLAUDE_OAUTH_TOKEN).toBeUndefined();
    expect(sub.env.CRYSK_CLAUDE_API_KEY).toBeUndefined();
    expect(sub.env.ANTHROPIC_API_KEY).toBeUndefined();

    const key = resolveRunClaudeCredential({
      credentials: { claude: ["api_key"] },
      env,
      loginPresent: false,
    });
    expect(key.selection.status === "chosen" && key.selection.source).toBe(
      "CRYSK_CLAUDE_API_KEY",
    );
    expect(key.env.ANTHROPIC_API_KEY === "key-new").toBe(true);
    expect(key.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("a local login counts as the subscription and puts no variable in the child", () => {
    const run = resolveRunClaudeCredential({
      env: { ANTHROPIC_API_KEY: "key-old" },
      loginPresent: true,
    });
    expect(run.kind).toBe("subscription");
    expect(run.selection.status === "chosen" && run.selection.source).toBe(
      "login",
    );
    const keys = childKeys(run.env);
    expect(keys).toEqual({ oauth: false, apiKey: false, authToken: false });
  });

  test("locally, api_key first with a key present uses the key even when a login exists", () => {
    const run = resolveRunClaudeCredential({
      credentials: { claude: ["api_key", "subscription"] },
      env: { ANTHROPIC_API_KEY: "key-old" },
      loginPresent: true,
    });
    expect(run.kind).toBe("api_key");
    expect(childKeys(run.env).apiKey).toBe(true);
  });

  test("whitespace-only values are no credential", () => {
    const presence = claudeCredentialPresence(
      { ANTHROPIC_API_KEY: "   ", CLAUDE_CODE_OAUTH_TOKEN: "" },
      false,
    );
    expect(presence.subscription).toBeUndefined();
    expect(presence.api_key).toBeUndefined();
  });

  test("ANTHROPIC_AUTH_TOKEN is never a source and never reaches the child", () => {
    const run = resolveRunClaudeCredential({
      env: { ANTHROPIC_AUTH_TOKEN: "bearer", CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
      loginPresent: false,
    });
    expect(run.kind).toBe("subscription");
    expect(childKeys(run.env).authToken).toBe(false);
  });

  test("no credential chosen leaves no Claude credential variable at all", () => {
    const env: Record<string, string> = {};
    for (const name of CLAUDE_CREDENTIAL_VARIABLES) env[name] = "x";
    const run = claudeRunEnv(env, {
      status: "none",
      order: ["subscription"],
      orderDefaulted: false,
      presence: {},
    });
    for (const name of CLAUDE_CREDENTIAL_VARIABLES) {
      expect(run[name] === undefined).toBe(true);
    }
  });

  test("other variables pass through untouched", () => {
    const run = resolveRunClaudeCredential({
      env: {
        PATH: "/bin",
        ANTHROPIC_BASE_URL: "https://gw",
        ANTHROPIC_API_KEY: "k",
      },
      loginPresent: false,
    });
    expect(run.env.PATH).toBe("/bin");
    expect(run.env.ANTHROPIC_BASE_URL).toBe("https://gw");
  });
});

describe("claudeCredentialRefusal", () => {
  test("names the order and what is set when no listed credential is present", () => {
    const selection = selectClaudeCredential(["api_key"], {
      subscription: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    expect(claudeCredentialRefusal(selection, true)).toBe(
      "no Claude credential this run may use is set: credentials.claude is [api_key], and none of those is set: api_key (CRYSK_CLAUDE_API_KEY or ANTHROPIC_API_KEY). subscription is set but not listed, so it is not used. Set a listed credential, or change credentials.claude in your person config",
    );
  });

  test("says the order was the default, and that ANTHROPIC_AUTH_TOKEN is no longer used", () => {
    const presence = claudeCredentialPresence(
      { ANTHROPIC_AUTH_TOKEN: "bearer" },
      false,
    );
    const message = claudeCredentialRefusal(
      selectClaudeCredential(undefined, presence),
      true,
    );
    expect(message).toBe(
      "no Claude credential this run may use is set: credentials.claude is [subscription, api_key] (the default), and none of those is set: subscription (CRYSK_CLAUDE_OAUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN, or a Claude login on this machine); api_key (CRYSK_CLAUDE_API_KEY or ANTHROPIC_API_KEY). ANTHROPIC_AUTH_TOKEN is set but no longer used: put an API key in CRYSK_CLAUDE_API_KEY or ANTHROPIC_API_KEY. Set a listed credential, or change credentials.claude in your person config",
    );
  });

  // U5: in the action the Claude credential comes only from the crysk-secrets input
  // (or a login on the runner), so the refusal names the CRYSK_* secrets there and
  // never the CLI variables, which the action no longer reads.
  test("in the action, the refusal names the CRYSK_* secrets in the crysk-secrets input", () => {
    try {
      takeCryskClaudeSecrets({});
      const run = resolveRunClaudeCredential({ loginPresent: false });
      expect(claudeCredentialRefusal(run.selection, true)).toBe(
        "no Claude credential this run may use is set: credentials.claude is [subscription, api_key] (the default), and none of those is set: subscription (CRYSK_CLAUDE_OAUTH_TOKEN in the crysk-secrets input, or a Claude login on this machine); api_key (CRYSK_CLAUDE_API_KEY in the crysk-secrets input). Set a listed credential, or change credentials.claude in your person config",
      );
    } finally {
      clearCryskClaudeIntake();
    }
  });

  test("a plan with no Claude route ignores Claude credentials", () => {
    const selection = selectClaudeCredential(["api_key"], {});
    expect(claudeCredentialRefusal(selection, false)).toBeUndefined();
  });

  test("a chosen credential is never refused", () => {
    const selection = selectClaudeCredential(undefined, {
      api_key: "ANTHROPIC_API_KEY",
    });
    expect(claudeCredentialRefusal(selection, true)).toBeUndefined();
  });

  // Missing credential: the refusal is a missing credential in cli.json, not
  // CRYSK-UNCLASSIFIED, and its message is unchanged.
  test("the refusal error is classified CRYSK-CRED-MISSING and keeps its message", () => {
    const error = new ClaudeCredentialRefusalError("no Claude credential");
    expect(error.message).toBe("no Claude credential");
    expect(codeOf(classifyCliError(error))).toBe("CRYSK-CRED-MISSING");
  });
});

// R003 (#494) + missing credential (S4): every admission credential refusal stops a CI
// run before any spend, so its ledger row settles as gate-skipped with the refusal's
// own reason; the OpenCode one included, never `failed`.
describe("a credential refusal settles the CI ledger row as an unspent skip", () => {
  function ledgerState() {
    const record: AdmissionRecord = {
      schemaVersion: 1,
      prNumber: 7,
      headSha: "a".repeat(40),
      policyHash: "deadbeefcafefeed",
      reservationId: "reservation-cred",
      attemptNumber: 1,
      status: "reserved",
      decisionReason: "reason recorded before settlement",
      priorScore: null,
      blockingCount: null,
      advisoryCount: null,
      workflowRunId: null,
      createdAt: "2026-11-10T12:00:00.000Z",
      settledAt: null,
    };
    return {
      record,
      checkRunId: 11,
      headSha: "a".repeat(40),
      operatorRoot: "/repo",
    };
  }
  // Every gh call answers a check-run id; the argv is kept.
  function fakeGh(calls: string[][]): typeof Bun.spawn {
    return ((argv: string[]) => {
      calls.push(argv);
      const out = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":11}'));
          controller.close();
        },
      });
      return {
        stdout: out,
        stderr: new ReadableStream({ start: (c) => c.close() }),
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
  }

  test("an OpenCode route with no record settles gate-skipped, naming the provider", async () => {
    const state = ledgerState();
    const calls: string[][] = [];
    await settleClaudeCredentialRefusal(
      state,
      new OpenCodeCredentialRefusalError({
        message: "models name OpenCode provider aiand (hunter-logic), but …",
        failureClass: "missing_provider_record",
        params: {
          backend: "opencode",
          provider: "aiand",
          model: "deepseek-ai/deepseek-v4.1-flash-1017",
          step: "hunter-logic",
        },
      }),
      { spawnFn: fakeGh(calls) },
    );
    expect(state.record.status).toBe("gate-skipped");
    expect(state.record.decisionReason).toBe(
      "no credential record for OpenCode provider aiand; refused before any provider spend",
    );
    expect(calls.length).toBe(1);
  });

  test("an expiring subscription login settles gate-skipped, naming why", async () => {
    const state = ledgerState();
    await settleClaudeCredentialRefusal(
      state,
      new OpenCodeCredentialRefusalError({
        message: "models name OpenCode provider openai (refuter), but …",
        failureClass: "subscription_expiring",
        params: {
          backend: "opencode",
          provider: "openai",
          model: "gpt-5.5",
          step: "refuter",
        },
      }),
      { spawnFn: fakeGh([]) },
    );
    expect(state.record.status).toBe("gate-skipped");
    expect(state.record.decisionReason).toBe(
      "subscription login for OpenCode provider openai expires within the review; refused before any provider spend",
    );
  });

  test("the Claude refusal keeps its own reason", async () => {
    const state = ledgerState();
    await settleClaudeCredentialRefusal(
      state,
      new ClaudeCredentialRefusalError("no Claude credential"),
      { spawnFn: fakeGh([]) },
    );
    expect(state.record.status).toBe("gate-skipped");
    expect(state.record.decisionReason).toBe(
      "no Claude credential the run may use is set; refused before any provider spend",
    );
  });
});

// U5 (odd/tasks/role-model-routing.md, S8, L27): in CI the Claude secrets arrive in
// the crysk-secrets input, which the Run Crysk step pipes to src/ci/run.ts on stdin.
// run.ts hands the Claude values to this module's intake; nothing writes process.env.
// The run's env is the process env with every Claude variable dropped and the
// intake's CRYSK_* values put in, so a job-level ANTHROPIC_API_KEY nobody passed
// through crysk-secrets is never chosen.
describe("the crysk-secrets intake", () => {
  test("cryskIntakeEnv drops every Claude variable and adds only the intake's CRYSK_* names", () => {
    const env = cryskIntakeEnv(
      {
        HOME: "/home/runner",
        ANTHROPIC_API_KEY: "job-level-key",
        CLAUDE_CODE_OAUTH_TOKEN: "job-level-oauth",
        ANTHROPIC_AUTH_TOKEN: "job-level-bearer",
        CRYSK_CLAUDE_API_KEY: "env-crysk-key",
      },
      { subscription: "intake-oauth" },
    );
    expect(env.HOME).toBe("/home/runner");
    expect(env.CRYSK_CLAUDE_OAUTH_TOKEN === "intake-oauth").toBe(true);
    for (const name of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "CRYSK_CLAUDE_API_KEY",
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  test("an intake API key is the run's credential, under the CLI's variable, and bills metered", () => {
    const run = resolveRunClaudeCredential({
      env: cryskIntakeEnv(
        { CLAUDE_CODE_OAUTH_TOKEN: "job-level-oauth" },
        { api_key: "intake-key" },
      ),
      loginPresent: false,
    });
    expect(run.kind).toBe("api_key");
    expect(run.env.ANTHROPIC_API_KEY === "intake-key").toBe(true);
    expect(childKeys(run.env)).toEqual({
      oauth: false,
      apiKey: true,
      authToken: false,
    });
    // Every billing reader reads this env: the usage stamp and the timeout label
    // (envBillsMetered) and the CI ceiling (deriveCiBillingMode).
    expect(envBillsMetered(run.env)).toBe(true);
    expect(deriveCiBillingMode(run.env)).toBe("metered");
  });

  test("the credential order still decides between two intake secrets", () => {
    const both = { subscription: "intake-oauth", api_key: "intake-key" };
    const byDefault = resolveRunClaudeCredential({
      env: cryskIntakeEnv({}, both),
      loginPresent: false,
    });
    expect(byDefault.kind).toBe("subscription");
    expect(deriveCiBillingMode(byDefault.env)).toBe("subscription");
    const keyFirst = resolveRunClaudeCredential({
      credentials: { claude: ["api_key", "subscription"] },
      env: cryskIntakeEnv({}, both),
      loginPresent: false,
    });
    expect(keyFirst.kind).toBe("api_key");
  });

  test("an intake taken by run.ts is what a run that passes no env reads, and process.env is untouched", () => {
    const before = process.env.CRYSK_CLAUDE_API_KEY;
    try {
      takeCryskClaudeSecrets({ api_key: "SENTINEL-INTAKE-5c1" });
      const run = resolveRunClaudeCredential({
        credentials: { claude: ["api_key"] },
        loginPresent: false,
      });
      expect(run.kind).toBe("api_key");
      expect(run.env.ANTHROPIC_API_KEY === "SENTINEL-INTAKE-5c1").toBe(true);
      expect(process.env.CRYSK_CLAUDE_API_KEY === before).toBe(true);
      expect(process.env.ANTHROPIC_API_KEY === "SENTINEL-INTAKE-5c1").toBe(
        false,
      );
    } finally {
      clearCryskClaudeIntake();
    }
  });
});

// R001 (#494): a Mac's login is the Keychain item, not the `security` binary being
// installed. Every probe is injected: no test reads the real Keychain or HOME.
describe("the machine's Claude login", () => {
  const HOME = "/home/crysk-test";
  const STORE = `${HOME}/.claude/.credentials.json`;
  const mac = (files: readonly string[], item: boolean) => {
    const asked: string[] = [];
    return {
      asked,
      probe: {
        platform: "darwin" as const,
        existsFn: (p: string) => p === "/usr/bin/security" || files.includes(p),
        keychainProbe: () => {
          asked.push("keychain");
          return item;
        },
      },
    };
  };

  test("a Mac with no Keychain item and no OAuth store has no login", () => {
    const { probe } = mac([], false);
    expect(defaultClaudeLoginPresent({ HOME }, probe)).toBe(false);
  });

  test("a Mac with the Keychain item has a login", () => {
    const { probe } = mac([], true);
    expect(defaultClaudeLoginPresent({ HOME }, probe)).toBe(true);
  });

  test("the OAuth store counts on any host, and Linux never asks the Keychain", () => {
    const asked: string[] = [];
    const linux = (files: readonly string[]) => ({
      platform: "linux" as const,
      existsFn: (p: string) => files.includes(p),
      keychainProbe: () => {
        asked.push("keychain");
        return true;
      },
    });
    expect(defaultClaudeLoginPresent({ HOME }, linux([STORE]))).toBe(true);
    expect(defaultClaudeLoginPresent({ HOME }, linux([]))).toBe(false);
    expect(asked).toEqual([]);
    expect(defaultClaudeLoginPresent({ HOME }, mac([STORE], false).probe)).toBe(
      true,
    );
  });

  test("a Mac with only an API key runs on the key, which stays in the child env", () => {
    const env = { HOME, ANTHROPIC_API_KEY: "sk-test" };
    const { probe } = mac([], false);
    const selection = selectClaudeCredential(
      undefined,
      claudeCredentialPresence(env, defaultClaudeLoginPresent(env, probe)),
    );
    expect(selection.status).toBe("chosen");
    if (selection.status !== "chosen") return;
    expect(selection.kind).toBe("api_key");
    expect(claudeRunEnv(env, selection).ANTHROPIC_API_KEY).toBe("sk-test");
  });

  test("a Mac with neither a login nor a key is refused before spend", () => {
    const env = { HOME };
    const { probe } = mac([], false);
    const selection = selectClaudeCredential(
      undefined,
      claudeCredentialPresence(env, defaultClaudeLoginPresent(env, probe)),
    );
    expect(selection.status).toBe("none");
    expect(claudeCredentialRefusal(selection, true)).toBeDefined();
  });
});
