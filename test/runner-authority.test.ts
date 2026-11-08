import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RunnerBackend } from "../src/execution/contracts";
import { envBillsMetered } from "../src/execution/usage-normalized";
import { defaultExecSnapshotBase } from "../src/model/exec-snapshots";
import {
  credentialKindBillsMetered,
  credentialKindForRoute,
  resolveBindingAuthority,
  resolveRunnerAuthority,
} from "../src/runner-authority";
import type { CredentialBroker } from "../src/security/credential-broker";
import {
  KeychainCredentialBroker,
  OpenCodeApiTokenBroker,
  OpenCodeAuthBroker,
} from "../src/security/credential-broker";

describe("resolveRunnerAuthority", () => {
  test("resolves an explicit absolute override to canonical path + sha256 allowlist", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\necho hi\n");
    const canonical = "/fake/bin/claude";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const expectedSha = hasher.digest("hex");

    const result = await resolveRunnerAuthority(
      {
        binaryPath: canonical,
        workspaceRoot: "/fake/ws",
        executableAllowlists: {
          "claude-code": [{ absolutePath: canonical, sha256: expectedSha }],
        },
      },
      {
        existsFn: () => true,
        realpathFn: async (p) => p,
        readFileFn: async () => bytes,
        statFn: () => ({ mode: 0o755 }),
      },
    );

    expect(result.error).toBeUndefined();
    if (result.error !== undefined || result.runnerOptions === undefined)
      return;
    expect(result.runnerOptions.binaryPath).toBe(canonical);
    expect(result.runnerOptions.workspaceRoot).toBe("/fake/ws");
    expect(result.runnerOptions.executableAllowlist).toEqual([
      { absolutePath: canonical, sha256: expectedSha },
    ]);
  });

  test("without an override, searches the injected PATH dirs in order", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const expectedSha = hasher.digest("hex");

    const result = await resolveRunnerAuthority(
      {
        workspaceRoot: "/fake/ws",
        env: { PATH: "/first:/second:/third" },
        executableAllowlists: {
          "claude-code": [
            {
              absolutePath: "/real/second/claude",
              sha256: expectedSha,
            },
          ],
        },
      },
      {
        existsFn: (p) => p === "/second/claude" || p === "/real/second/claude",
        realpathFn: async (p) => `/real${p}`,
        readFileFn: async () => new Uint8Array([1, 2, 3]),
        statFn: () => ({ mode: 0o755 }),
      },
    );

    expect(result.error).toBeUndefined();
    if (result.runnerOptions === undefined) return;
    expect(result.runnerOptions.binaryPath).toBe("/real/second/claude");
    expect(result.runnerOptions.executableAllowlist[0].absolutePath).toBe(
      "/real/second/claude",
    );
  });

  test("without an explicit allowlist derives Claude discovery for CLI compatibility", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\necho hi\n");
    const canonical = "/fake/bin/claude";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const expectedSha = hasher.digest("hex");

    const result = await resolveRunnerAuthority(
      { binaryPath: canonical, workspaceRoot: "/fake/ws" },
      {
        existsFn: () => true,
        realpathFn: async (p) => p,
        readFileFn: async () => bytes,
        statFn: () => ({ mode: 0o755 }),
      },
    );

    expect(result.error).toBeUndefined();
    if (result.runnerOptions === undefined) return;
    expect(result.runnerOptions.executableAllowlist).toEqual([
      { absolutePath: canonical, sha256: expectedSha },
    ]);
  });

  test("existsFn for PATH probing does not bypass executable permission checks", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\necho hi\n");
    const canonical = "/fake/bin/claude";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const expectedSha = hasher.digest("hex");

    const result = await resolveRunnerAuthority(
      {
        binaryPath: canonical,
        workspaceRoot: "/fake/ws",
        executableAllowlists: {
          "claude-code": [{ absolutePath: canonical, sha256: expectedSha }],
        },
      },
      {
        existsFn: () => true,
        realpathFn: async (p) => p,
        readFileFn: async () => bytes,
        statFn: () => ({ mode: 0o644 }),
      },
    );

    expect(result.error).toContain("Missing executable permissions");
  });

  test("missing binary on PATH yields an error", async () => {
    const result = await resolveRunnerAuthority(
      { workspaceRoot: "/fake/ws", env: { PATH: "/empty" } },
      {
        existsFn: () => false,
        realpathFn: async (p) => p,
        readFileFn: async () => new Uint8Array(),
      },
    );

    expect(result.error).toBeDefined();
    expect(result.error).toContain("not found");
  });

  test("relative binary override is rejected", async () => {
    const result = await resolveRunnerAuthority(
      { binaryPath: "bin/claude", workspaceRoot: "/fake/ws" },
      {
        existsFn: () => true,
        realpathFn: async (p) => p,
        readFileFn: async () => new Uint8Array(),
      },
    );

    expect(result.error).toBeDefined();
    expect(result.error).toContain("absolute path");
  });
});

// #133: the credential kind is PROVIDER-keyed, not backend-keyed. Everything
// downstream — the billing mode, the projection payload, the rate-limit
// bucket — reads off this one decision.
describe("credentialKindForRoute", () => {
  test("the truth table", () => {
    expect(credentialKindForRoute("claude-code", "anthropic")).toBe(
      "claude_subscription_oauth",
    );
    // The backend decides for claude-code; the provider is not consulted.
    expect(credentialKindForRoute("claude-code", "openai")).toBe(
      "claude_subscription_oauth",
    );
    expect(credentialKindForRoute("opencode", "openai")).toBe(
      "opencode_chatgpt_oauth",
    );
    for (const provider of ["zai", "zai-coding-plan", "mistral", "google"]) {
      expect(credentialKindForRoute("opencode", provider)).toBe(
        "provider_api_token",
      );
    }
  });

  // U3 (S8, L12): an OpenCode route's kind follows which CRYSK_* secret serves
  // its provider, from the names alone. Absent names keep the provider literal.
  test("an opencode route's kind follows the CRYSK_* secret names", () => {
    const kind = (provider: string, names?: readonly string[]) =>
      credentialKindForRoute("opencode", provider, {}, false, names);
    expect(kind("openai", ["CRYSK_OPENCODE_OPENAI_API_KEY"])).toBe(
      "provider_api_token",
    );
    expect(kind("openai", ["CRYSK_OPENCODE_OPENAI_OAUTH"])).toBe(
      "opencode_chatgpt_oauth",
    );
    expect(
      kind("openai", [
        "CRYSK_OPENCODE_OPENAI_API_KEY",
        "CRYSK_OPENCODE_OPENAI_OAUTH",
      ]),
    ).toBe("opencode_chatgpt_oauth");
    expect(kind("deepseek", ["CRYSK_OPENCODE_DEEPSEEK_API_KEY"])).toBe(
      "provider_api_token",
    );
    // A refused _OAUTH or another provider's secret decides nothing.
    expect(kind("deepseek", ["CRYSK_OPENCODE_DEEPSEEK_OAUTH"])).toBe(
      "provider_api_token",
    );
    expect(kind("openai", ["CRYSK_OPENCODE_DEEPSEEK_API_KEY"])).toBe(
      "opencode_chatgpt_oauth",
    );
    expect(kind("openai", [])).toBe("opencode_chatgpt_oauth");
    expect(kind("openai")).toBe("opencode_chatgpt_oauth");
    // A claude-code route never reads them.
    expect(
      credentialKindForRoute("claude-code", "anthropic", {}, false, [
        "CRYSK_OPENCODE_OPENAI_API_KEY",
      ]),
    ).toBe("claude_subscription_oauth");
  });

  // Fail-closed: metered is the safe default, so a backend nobody has bound
  // must not silently inherit it. It has no credential authority at all.
  test("an unbound backend is refused rather than defaulted", () => {
    expect(() =>
      credentialKindForRoute("codex" as RunnerBackend, "openai"),
    ).toThrow(/codex/);
  });

  // #161 (corrected 2026-09-24 by Juanma). A claude-code route reads its kind
  // from the env it would see WITHOUT a projection (3rd arg) AND from
  // whether a broker will actually project one BEFORE the child spawns (4th
  // arg, `hasBroker`). Both default to the "nothing is known" case (`{}`,
  // `false`) so every existing call site that never threaded either through
  // keeps today's answer: subscription.
  describe("claude-code reads the env AND broker presence (#161)", () => {
    test("no arguments at all keeps the pre-#161 answer", () => {
      expect(credentialKindForRoute("claude-code", "anthropic")).toBe(
        "claude_subscription_oauth",
      );
    });

    test("a key with no broker resolves the metered kind", () => {
      expect(
        credentialKindForRoute(
          "claude-code",
          "anthropic",
          { ANTHROPIC_API_KEY: "sk-test" },
          false,
        ),
      ).toBe("provider_api_token");
      expect(
        credentialKindForRoute(
          "claude-code",
          "anthropic",
          { ANTHROPIC_AUTH_TOKEN: "bearer-test" },
          false,
        ),
      ).toBe("provider_api_token");
    });

    // THE precedence rule this correction exists for: on a SUCCESSFUL
    // projection, a broker's presence means the harness strips the key
    // before the child ever sees it (PROJECTION_OWNED_KEYS,
    // execution/harness.ts), so the kind must stay subscription no matter
    // what env carries. The first cut of #161 got this backwards (skipped
    // the broker whenever a key was present) and would have silently
    // rebilled a macOS subscription developer's ambient ANTHROPIC_API_KEY as
    // metered. `credentialKindForRoute` cannot see whether a given
    // projection attempt will actually succeed — #279 is the one known case
    // where it degrades and the key reaches the child anyway; that gap is
    // NOT covered by this unit-level test (see
    // test/harness/credential-projection.test.ts for the real, degraded
    // path).
    test("a key WITH a broker stays the subscription kind — the broker wins", () => {
      expect(
        credentialKindForRoute(
          "claude-code",
          "anthropic",
          { ANTHROPIC_API_KEY: "sk-test" },
          true,
        ),
      ).toBe("claude_subscription_oauth");
      expect(
        credentialKindForRoute(
          "claude-code",
          "anthropic",
          { ANTHROPIC_AUTH_TOKEN: "bearer-test" },
          true,
        ),
      ).toBe("claude_subscription_oauth");
    });

    test("no key in env keeps the subscription kind regardless of broker presence", () => {
      for (const hasBroker of [true, false]) {
        expect(
          credentialKindForRoute("claude-code", "anthropic", {}, hasBroker),
        ).toBe("claude_subscription_oauth");
      }
    });

    // Same trim rule as `envBillsMetered`: a whitespace-only secret (a YAML
    // block scalar that kept its newline, a space-only value) is not a real
    // key.
    test("a whitespace-only key behaves like no key, with no broker", () => {
      expect(
        credentialKindForRoute(
          "claude-code",
          "anthropic",
          { ANTHROPIC_API_KEY: "   ", ANTHROPIC_AUTH_TOKEN: "\n" },
          false,
        ),
      ).toBe("claude_subscription_oauth");
    });
  });

  // The anti-fork guarantee, proven rather than restated — SCOPED to the two
  // cases where it actually holds: no broker at all, and a broker whose
  // projection SUCCEEDS. Admission (`credentialKindForRoute` ->
  // `credentialKindBillsMetered`, reading the RAW pre-strip env plus
  // `hasBroker`) and usage filing (`envBillsMetered` directly on the child's
  // ACTUAL post-strip env, `claudeCliCostBasis` in the transport) reach the
  // same billing mode for the same attempt on those two paths. This builds
  // the successful-strip env INDEPENDENTLY (a literal mirror of
  // `PROJECTION_OWNED_KEYS`, execution/harness.ts, not a call into
  // `credentialKindForRoute`'s own reasoning) so the test can actually catch
  // the two disagreeing, rather than restating the implementation back at it.
  //
  // NOT covered here: a broker whose projection DEGRADES
  // (`missing_subscription_record`) instead of stripping anything — that is
  // #279, where admission and filing DISAGREE by design (admission says
  // subscription, filing correctly says metered) — a disagreement #279's fix
  // deliberately leaves in place (admission cannot see a runtime degrade);
  // what changed is that the SPEND is now fenced too, at the harness, not
  // here. Its own test, against the real harness rather than this
  // simulation, lives in test/harness/credential-projection.test.ts.
  describe("admission and usage filing agree on a successful projection or no broker (#161 anti-fork guarantee)", () => {
    const PROJECTION_OWNED_KEYS = [
      "HOME",
      "TMPDIR",
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ] as const;

    // Named for what it models: the env a SUCCESSFUL projection leaves the
    // child with. A degraded projection (#279) leaves the child on the raw,
    // unstripped env instead — deliberately not a case this helper can
    // produce, since modelling it here would just restate the exception
    // rather than test against it.
    function postSuccessfulProjectionEnv(
      rawEnv: Readonly<Record<string, string | undefined>>,
      hasBroker: boolean,
    ): Record<string, string | undefined> {
      if (!hasBroker) return { ...rawEnv };
      const stripped: Record<string, string | undefined> = { ...rawEnv };
      for (const key of PROJECTION_OWNED_KEYS) delete stripped[key];
      return stripped;
    }

    test("a successful projection + key: both sides say subscription", () => {
      const rawEnv = { ANTHROPIC_API_KEY: "sk-test" };
      const hasBroker = true;

      const kind = credentialKindForRoute(
        "claude-code",
        "anthropic",
        rawEnv,
        hasBroker,
      );
      expect(credentialKindBillsMetered(kind)).toBe(false);
      expect(
        envBillsMetered(postSuccessfulProjectionEnv(rawEnv, hasBroker)),
      ).toBe(false);
    });

    test("no broker + key: both sides say metered", () => {
      const rawEnv = { ANTHROPIC_API_KEY: "sk-test" };
      const hasBroker = false;

      const kind = credentialKindForRoute(
        "claude-code",
        "anthropic",
        rawEnv,
        hasBroker,
      );
      expect(credentialKindBillsMetered(kind)).toBe(true);
      expect(
        envBillsMetered(postSuccessfulProjectionEnv(rawEnv, hasBroker)),
      ).toBe(true);
    });

    test("the two sides agree across every env, given a successful projection or no broker", () => {
      const envs: ReadonlyArray<Readonly<Record<string, string | undefined>>> =
        [
          {},
          { ANTHROPIC_API_KEY: "sk-test" },
          { ANTHROPIC_AUTH_TOKEN: "bearer-test" },
          { ANTHROPIC_API_KEY: "   ", ANTHROPIC_AUTH_TOKEN: "\n" },
          { ANTHROPIC_API_KEY: "sk-a", ANTHROPIC_AUTH_TOKEN: "bearer-b" },
        ];
      for (const env of envs) {
        for (const hasBroker of [true, false]) {
          const kind = credentialKindForRoute(
            "claude-code",
            "anthropic",
            env,
            hasBroker,
          );
          expect(credentialKindBillsMetered(kind)).toBe(
            envBillsMetered(postSuccessfulProjectionEnv(env, hasBroker)),
          );
        }
      }
    });
  });
});

describe("resolveBindingAuthority credential identity", () => {
  const bytes = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  const canonical = "/fake/bin/opencode";
  const sha256 = (() => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    return hasher.digest("hex");
  })();

  const deps = {
    existsFn: () => true,
    realpathFn: async (p: string) => p,
    readFileFn: async () => bytes,
    statFn: () => ({ mode: 0o755 }),
  };

  async function bind(provider: string) {
    const result = await resolveBindingAuthority(
      "opencode",
      provider,
      {
        workspaceRoot: "/fake/ws",
        openCodeBinaryPath: canonical,
        executableAllowlists: {
          opencode: [{ absolutePath: canonical, sha256 }],
        },
      },
      deps,
    );
    if (result.binding === undefined) {
      throw new Error(result.error ?? "no binding");
    }
    return result.binding;
  }

  test("the opencode OAuth route keeps its kind and names its provider", async () => {
    const binding = await bind("openai");
    expect(binding.credentialKind).toBe("opencode_chatgpt_oauth");
    expect(binding.credentialRef).toBe("opencode-auth:openai");
  });

  // The credentialRef is half of `credentialFingerprint`
  // (production-runtime.ts), which is what separates rate-limit buckets. Two
  // providers on one backend are two different credentials, so a shared ref
  // would pool their quota into one bucket.
  test("two providers on the same backend get distinct credential refs", async () => {
    const zai = await bind("zai");
    const plan = await bind("zai-coding-plan");
    expect(zai.credentialKind).toBe("provider_api_token");
    expect(zai.credentialRef).toBe("opencode-auth:zai");
    expect(plan.credentialRef).toBe("opencode-auth:zai-coding-plan");
    expect(plan.credentialRef).not.toBe(zai.credentialRef);
  });

  // The default broker must MATCH the kind. Handing an api-token route the
  // OAuth broker would fail at projection time, deep inside a live run.
  test("the default broker matches the resolved kind", async () => {
    const oauth = await bind("openai");
    const token = await bind("zai");
    expect(oauth.credentialBroker).toBeInstanceOf(OpenCodeAuthBroker);
    expect(token.credentialBroker).toBeInstanceOf(OpenCodeApiTokenBroker);
  });

  test("an injected broker still overrides both kinds", async () => {
    const fake: CredentialBroker = {
      project: async () => {
        throw new Error("never projected in this test");
      },
    };
    for (const provider of ["openai", "zai"]) {
      const result = await resolveBindingAuthority(
        "opencode",
        provider,
        {
          workspaceRoot: "/fake/ws",
          openCodeBinaryPath: canonical,
          executableAllowlists: {
            opencode: [{ absolutePath: canonical, sha256 }],
          },
          credentialBrokers: { opencode: fake },
        },
        deps,
      );
      expect(result.binding?.credentialBroker).toBe(fake);
    }
  });
});

// #161: an API-key claude-code route binds as metered — a different
// credential kind, no default Keychain broker (it projects only the
// subscription record and throws for anything else, credential-broker.ts),
// and its own rate-limit bucket — while a no-key route stays byte-identical
// to the pre-#161 shape.
describe("resolveBindingAuthority claude-code credential kind (#161)", () => {
  const bytes = new TextEncoder().encode("#!/bin/sh\necho hi\n");
  const canonical = "/fake/bin/claude";
  const sha256 = (() => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    return hasher.digest("hex");
  })();

  const deps = {
    existsFn: () => true,
    realpathFn: async (p: string) => p,
    readFileFn: async () => bytes,
    statFn: () => ({ mode: 0o755 }),
  };

  async function bindClaude(
    env: Readonly<Record<string, string | undefined>>,
    credentialBrokers?: { readonly "claude-code": CredentialBroker },
  ) {
    const result = await resolveBindingAuthority(
      "claude-code",
      "anthropic",
      {
        binaryPath: canonical,
        workspaceRoot: "/fake/ws",
        executableAllowlists: {
          "claude-code": [{ absolutePath: canonical, sha256 }],
        },
        env,
        ...(credentialBrokers === undefined ? {} : { credentialBrokers }),
      },
      deps,
    );
    if (result.binding === undefined) {
      throw new Error(result.error ?? "no binding");
    }
    return result.binding;
  }

  // Whether THIS host would actually offer the real default (darwin +
  // /usr/bin/security) is orthogonal to what #161 changes, but it decides
  // which arms below can exercise the FULL resolveBindingAuthority path
  // deterministically: injecting a fake broker is always deterministic
  // (proves the "a broker IS present" arm on every host); proving "NO broker
  // at all" end to end needs a host whose default genuinely resolves to
  // undefined, which this darwin sandbox's real Keychain does not. That arm's
  // platform-independent proof is `credentialKindForRoute`'s own describe
  // block above ("a key with no broker resolves the metered kind") — this
  // block's own copy is `skipIf`'d here and runs for real on CI's
  // ubuntu-latest.
  function darwinKeychainAvailable(): boolean {
    return process.platform === "darwin" && existsSync("/usr/bin/security");
  }

  test("no key: unchanged — subscription kind, the platform-gated Keychain default, and the claude-code bucket", async () => {
    const binding = await bindClaude({});
    expect(binding.credentialKind).toBe("claude_subscription_oauth");
    expect(credentialKindBillsMetered(binding.credentialKind)).toBe(false);
    expect(binding.bucketId).toBe("claude-code");
    if (darwinKeychainAvailable()) {
      expect(binding.credentialBroker).toBeInstanceOf(KeychainCredentialBroker);
    } else {
      expect(binding.credentialBroker).toBeUndefined();
    }
  });

  // #161 (corrected 2026-09-24). THE precedence test, for a SUCCESSFUL
  // projection: a key alongside a broker must stay subscription, because a
  // successful projection strips that key before the child ever spawns
  // (PROJECTION_OWNED_KEYS, harness.ts), so billing the developer as metered
  // would charge for spend the child structurally cannot incur. The fake
  // broker below never actually projects (it always throws first), which is
  // fine here — this test is only about the ADMISSION-time decision
  // (`resolveBindingAuthority` never awaits a real projection), not the
  // runtime outcome. A projection that degrades instead of succeeding is
  // #279's known exception, tested against the real harness in
  // test/harness/credential-projection.test.ts, not here. The fake broker
  // also makes this deterministic on every host, unlike the real Keychain
  // default.
  test("a key WITH a broker: subscription kind, the broker still attaches, the claude-code bucket", async () => {
    const fake: CredentialBroker = {
      project: async () => {
        throw new Error("never projected in this test");
      },
    };
    const binding = await bindClaude(
      { ANTHROPIC_API_KEY: "sk-test" },
      { "claude-code": fake },
    );
    expect(binding.credentialKind).toBe("claude_subscription_oauth");
    expect(credentialKindBillsMetered(binding.credentialKind)).toBe(false);
    expect(binding.credentialBroker).toBe(fake);
    expect(binding.bucketId).toBe("claude-code");
  });

  test("ANTHROPIC_AUTH_TOKEN with a broker: same precedence as ANTHROPIC_API_KEY", async () => {
    const fake: CredentialBroker = {
      project: async () => {
        throw new Error("never projected in this test");
      },
    };
    const binding = await bindClaude(
      { ANTHROPIC_AUTH_TOKEN: "bearer-test" },
      { "claude-code": fake },
    );
    expect(binding.credentialKind).toBe("claude_subscription_oauth");
    expect(binding.credentialBroker).toBe(fake);
    expect(binding.bucketId).toBe("claude-code");
  });

  // The full path for "a key, no broker at all" — only exercisable end to
  // end on a host whose default Keychain broker genuinely resolves to
  // undefined (CI's ubuntu-latest). On this darwin sandbox it is skipped in
  // favour of the deterministic, platform-independent proof in
  // `credentialKindForRoute`'s own describe block.
  test.skipIf(darwinKeychainAvailable())(
    "a key with no broker at all: metered kind, no broker, the API bucket",
    async () => {
      const binding = await bindClaude({ ANTHROPIC_API_KEY: "sk-test" });
      expect(binding.credentialKind).toBe("provider_api_token");
      expect(credentialKindBillsMetered(binding.credentialKind)).toBe(true);
      expect(binding.credentialBroker).toBeUndefined();
      expect(binding.bucketId).toBe("claude-code-api");
      expect(binding.bucketId).not.toBe("claude-code");
    },
  );

  test("whitespace-only key behaves like no key, whether or not a broker is present", async () => {
    const withoutBroker = await bindClaude({ ANTHROPIC_API_KEY: "   " });
    expect(withoutBroker.credentialKind).toBe("claude_subscription_oauth");
    expect(withoutBroker.bucketId).toBe("claude-code");

    const fake: CredentialBroker = {
      project: async () => {
        throw new Error("never projected in this test");
      },
    };
    const withBroker = await bindClaude(
      { ANTHROPIC_API_KEY: "   " },
      { "claude-code": fake },
    );
    expect(withBroker.credentialKind).toBe("claude_subscription_oauth");
    expect(withBroker.credentialBroker).toBe(fake);
  });

  // S5: the credential chosen at run start decides the binding. An API key attaches
  // no Keychain broker (on any host), so it bills metered on its own bucket.
  async function bindChosen(
    env: Readonly<Record<string, string | undefined>>,
    claudeCredential: "subscription" | "api_key",
    credentialBrokers?: { readonly "claude-code": CredentialBroker },
  ) {
    const result = await resolveBindingAuthority(
      "claude-code",
      "anthropic",
      {
        binaryPath: canonical,
        workspaceRoot: "/fake/ws",
        executableAllowlists: {
          "claude-code": [{ absolutePath: canonical, sha256 }],
        },
        env,
        claudeCredential,
        ...(credentialBrokers === undefined ? {} : { credentialBrokers }),
      },
      deps,
    );
    if (result.binding === undefined) {
      throw new Error(result.error ?? "no binding");
    }
    return result.binding;
  }

  test("S5: api_key chosen: metered, no broker even when one is supplied, the API bucket", async () => {
    const fake: CredentialBroker = {
      project: async () => {
        throw new Error("never projected in this test");
      },
    };
    const binding = await bindChosen(
      { ANTHROPIC_API_KEY: "sk-test" },
      "api_key",
      { "claude-code": fake },
    );
    expect(binding.credentialKind).toBe("provider_api_token");
    expect(binding.credentialBroker).toBeUndefined();
    expect(binding.bucketId).toBe("claude-code-api");
  });

  test("S5: subscription chosen: subscription kind, the supplied broker attaches", async () => {
    const fake: CredentialBroker = {
      project: async () => {
        throw new Error("never projected in this test");
      },
    };
    const binding = await bindChosen(
      { CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
      "subscription",
      { "claude-code": fake },
    );
    expect(binding.credentialKind).toBe("claude_subscription_oauth");
    expect(binding.credentialBroker).toBe(fake);
    expect(binding.bucketId).toBe("claude-code");
  });
});

describe("resolveRunnerAuthority run env (S5)", () => {
  const bytes = new TextEncoder().encode("#!/bin/sh\necho hi\n");
  const canonical = "/fake/bin/claude";
  const deps = {
    existsFn: () => true,
    realpathFn: async (p: string) => p,
    readFileFn: async () => bytes,
    statFn: () => ({ mode: 0o755 }),
  };

  test("an explicit env becomes the runner's childEnv, and api_key drops the broker", async () => {
    const env = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-test" };
    const fake: CredentialBroker = {
      project: async () => {
        throw new Error("never projected in this test");
      },
    };
    const result = await resolveRunnerAuthority(
      {
        binaryPath: canonical,
        workspaceRoot: "/fake/ws",
        env,
        claudeCredential: "api_key",
        credentialBrokers: { "claude-code": fake },
      },
      deps,
    );
    if (result.runnerOptions === undefined) throw new Error(result.error);
    expect(result.runnerOptions.childEnv === env).toBe(true);
    expect(result.runnerOptions.credentialBroker).toBeUndefined();
  });

  test("no env given: no childEnv, so the harness keeps reading the process env as before", async () => {
    const result = await resolveRunnerAuthority(
      { binaryPath: canonical, workspaceRoot: "/fake/ws" },
      deps,
    );
    if (result.runnerOptions === undefined) throw new Error(result.error);
    expect("childEnv" in result.runnerOptions).toBe(false);
  });
});

// #303: binding resolution used to call verifyExecutableAuthority, which
// copies the binary into a snapshot dir, and then discarded the result —
// one leaked copy per route per run, each >100 MB for a real claude binary.
describe("resolveBindingAuthority writes no execution snapshot", () => {
  // The verify-only path takes no snapshot base, so the observable is the
  // real default base, filtered to this fixture's unique digest prefix.
  async function defaultBaseEntriesFor(sha256: string): Promise<string[]> {
    const names = await readdir(defaultExecSnapshotBase()).catch(() => []);
    return names.filter((name) => name.startsWith(sha256.slice(0, 16)));
  }

  const seenDigests: string[] = [];
  afterEach(async () => {
    for (const sha256 of seenDigests.splice(0)) {
      for (const name of await defaultBaseEntriesFor(sha256)) {
        await rm(path.join(defaultExecSnapshotBase(), name), {
          recursive: true,
          force: true,
        });
      }
    }
  });

  test.each([
    ["claude-code", "anthropic", "/fake/bin/claude"],
    ["opencode", "opencode", "/fake/bin/opencode"],
  ] as const)("%s", async (backend, provider, canonical) => {
    // Mach-O-prefixed, so the full authority would have snapshotted it.
    const bytes = new Uint8Array([
      0xcf,
      0xfa,
      0xed,
      0xfe,
      ...new TextEncoder().encode(randomUUID()),
    ]);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const sha256 = hasher.digest("hex");
    seenDigests.push(sha256);

    const result = await resolveBindingAuthority(
      backend,
      provider,
      {
        binaryPath: canonical,
        openCodeBinaryPath: canonical,
        workspaceRoot: "/fake/ws",
        env: {},
        executableAllowlists: {
          [backend]: [{ absolutePath: canonical, sha256 }],
        },
      },
      {
        existsFn: () => true,
        realpathFn: async (p: string) => p,
        readFileFn: async () => bytes,
        statFn: () => ({ mode: 0o755 }),
      },
    );

    expect(result.binding?.executableAllowlist).toEqual([
      { absolutePath: canonical, sha256 },
    ]);
    expect(await defaultBaseEntriesFor(sha256)).toEqual([]);
  });
});
