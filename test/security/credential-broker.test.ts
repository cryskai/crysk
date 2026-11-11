import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_CREDENTIALS_KEYCHAIN_SERVICE,
  CredentialProjectionError,
  KeychainCredentialBroker,
  OPENCODE_AUTH_RELATIVE_PATH,
  OpenCodeApiTokenBroker,
  OpenCodeAuthBroker,
  OpenCodeFreeBroker,
  openCodeProjectionLayout,
} from "../../src/security/credential-broker";

// Obviously-fake tokens only — never a real credential value in a fixture.
const FAKE_STORE = JSON.stringify({
  claudeAiOauth: {
    accessToken: "AT-test-fake",
    expiresAt: "2026-01-01T00:00:00Z",
    refreshToken: "RT-test-fake",
    refreshTokenExpiresAt: "2026-02-01T00:00:00Z",
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "tier-a",
  },
  mcpOAuth: { "server-a": { accessToken: "AT-mcp-test-fake" } },
  unrelatedBookmark: "keep-out",
});

function brokerWithReader(readerFn: (service: string) => Promise<string>) {
  return new KeychainCredentialBroker({ readerFn });
}

const okReader = async () => FAKE_STORE;

async function project(broker = brokerWithReader(okReader)) {
  return broker.project({
    sessionId: "session-1",
    credentialRef: CLAUDE_CREDENTIALS_KEYCHAIN_SERVICE,
    kind: "claude_subscription_oauth",
    verifiedBinaryPath: "/usr/local/bin/claude",
  });
}

describe("KeychainCredentialBroker", () => {
  test("extracts ONLY claudeAiOauth — mcpOAuth and unknown keys never land in the projection", async () => {
    const projection = await project();
    try {
      const filePath = path.join(
        projection.syntheticHome,
        ".claude",
        ".credentials.json",
      );
      const written = JSON.parse(await Bun.file(filePath).text());
      expect(Object.keys(written)).toEqual(["claudeAiOauth"]);
      expect(written.claudeAiOauth.accessToken).toBe("AT-test-fake");
      expect(JSON.stringify(written)).not.toContain("mcpOAuth");
      expect(JSON.stringify(written)).not.toContain("unrelatedBookmark");
    } finally {
      await projection.destroy();
    }
  });

  test("layout: root/.claude/tmp are 0700, credentials file is 0600", async () => {
    const projection = await project();
    try {
      expect(statSync(projection.syntheticHome).mode & 0o777).toBe(0o700);
      expect(statSync(projection.syntheticConfigHome).mode & 0o777).toBe(0o700);
      expect(statSync(projection.syntheticTmp).mode & 0o777).toBe(0o700);
      expect(statSync(projection.files[0].path).mode & 0o777).toBe(0o600);
    } finally {
      await projection.destroy();
    }
  });

  // pr-hero F001 on PR #80. The create list had seven entries and the lstat
  // walk had six: xdgConfigHome, opencodeConfigDir and syntheticTmp were
  // built and then handed to the child as XDG_CONFIG_HOME, syntheticConfigHome
  // and TMPDIR without ever being checked — while the module's own comment
  // promised EVERY component was. Two hand-maintained lists of the same paths
  // is the defect; this test pins the single list they now share.
  test("every path the layout declares is created AND checked", () => {
    const layout = openCodeProjectionLayout("/tmp/root");
    expect(layout.directories.length).toBeGreaterThan(0);
    // Everything the child is handed must appear among the guarded paths.
    for (const handed of [
      layout.syntheticHome,
      layout.syntheticConfigHome,
      layout.syntheticTmp,
      layout.xdgDataHome,
      layout.authFile,
    ]) {
      expect(layout.guarded).toContain(handed);
    }
    for (const dir of layout.directories) {
      expect(layout.guarded).toContain(dir);
    }
  });

  test("no component of the projection is a symlink (§6.1 lstat defense)", async () => {
    const projection = await project();
    try {
      for (const component of [
        path.dirname(projection.syntheticHome),
        projection.syntheticHome,
        projection.syntheticConfigHome,
        projection.files[0].path,
        projection.syntheticTmp,
      ]) {
        expect(lstatSync(component).isSymbolicLink()).toBe(false);
      }
    } finally {
      await projection.destroy();
    }
  });

  test("files[] carries exactly path/mode/sha256 and the sha256 matches the written bytes", async () => {
    const projection = await project();
    try {
      expect(projection.files.length).toBe(1);
      const file = projection.files[0];
      expect(Object.keys(file).sort()).toEqual(["mode", "path", "sha256"]);
      expect(file.mode).toBe(0o600);
      const bytes = new Uint8Array(await Bun.file(file.path).bytes());
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(bytes);
      expect(file.sha256).toBe(hasher.digest("hex"));
      expect(await Bun.file(file.path).text()).not.toContain(
        "AT-mcp-test-fake",
      );
    } finally {
      await projection.destroy();
    }
  });

  test("env is exactly HOME+TMPDIR pointing at synthetic locations", async () => {
    const projection = await project();
    try {
      expect(projection.env).toEqual({
        HOME: projection.syntheticHome,
        TMPDIR: projection.syntheticTmp,
      });
    } finally {
      await projection.destroy();
    }
  });

  test("destroy removes the tree and is idempotent", async () => {
    const projection = await project();
    const root = projection.syntheticHome;
    expect(existsSync(root)).toBe(true);
    await projection.destroy();
    expect(existsSync(root)).toBe(false);
    await projection.destroy();
    expect(existsSync(root)).toBe(false);
  });

  test("reader failure produces a clean classed error with no source content", async () => {
    const broker = brokerWithReader(async () => {
      throw new Error("SecKeychainSearchCopyNext failed AT-test-fake");
    });
    let caught: unknown;
    try {
      await project(broker);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialProjectionError);
    const projectionError = caught as CredentialProjectionError;
    expect(projectionError.failureClass).toBe("source_read_failed");
    expect(projectionError.message).not.toContain("AT-test-fake");
    expect(projectionError.message).not.toContain("SecKeychainSearchCopyNext");
  });

  test("malformed JSON produces a clean classed error without echoing the payload", async () => {
    const broker = brokerWithReader(
      async () => '{"claudeAiO":{"accessToken":"AT-test-fake"',
    );
    let caught: unknown;
    try {
      await project(broker);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialProjectionError);
    const projectionError = caught as CredentialProjectionError;
    expect(projectionError.failureClass).toBe("malformed_payload");
    expect(projectionError.message).not.toContain("AT-test-fake");
    expect(projectionError.message).not.toContain("{");
  });

  test("store missing the subscription record fails loud", async () => {
    const broker = brokerWithReader(async () => '{"mcpOAuth":{}}');
    let caught: unknown;
    try {
      await project(broker);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialProjectionError);
    expect((caught as CredentialProjectionError).failureClass).toBe(
      "missing_subscription_record",
    );
  });

  // #133 gave `provider_api_token` a broker of its own
  // (OpenCodeApiTokenBroker). That does not make it projectable HERE: the
  // keychain holds the Claude subscription record and nothing else, so this
  // broker must keep refusing both foreign kinds by name.
  test("unsupported kinds fail loud naming the kind", async () => {
    const broker = brokerWithReader(okReader);
    for (const kind of [
      "opencode_chatgpt_oauth",
      "provider_api_token",
    ] as const) {
      let message = "";
      try {
        await broker.project({
          sessionId: "s",
          credentialRef: "ref",
          kind,
          verifiedBinaryPath: "/bin/true",
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(kind);
    }
  });

  test("production construction requires the pinned security binary", () => {
    expect(
      () =>
        new KeychainCredentialBroker({
          securityBinPath: path.join(
            mkdtempSync(path.join(tmpdir(), "prhero-broker-")),
            "absent-security",
          ),
        }),
    ).toThrow(/pinned security binary/i);
    const scratch = mkdtempSync(path.join(tmpdir(), "prhero-broker-"));
    rmSync(scratch, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// D1-06b: the OpenCode/ChatGPT OAuth route (§6.1). Empirically grounded —
// `opencode auth list` under a synthetic HOME reads
// <syntheticHome>/.local/share/opencode/auth.json and reports exactly the
// projected credential (verified 2026-08-27).
// ---------------------------------------------------------------------------

// Obviously-fake tokens only — never a real credential value in a fixture.
// The zai entries are the point of the exclusion test: they are unrelated
// provider secrets that share the store and must never travel.
const FAKE_OPENCODE_STORE = JSON.stringify({
  "zai-coding-plan": { key: "ZAI-KEY-test-fake", type: "api" },
  zai: { key: "ZAI-KEY-2-test-fake", type: "api" },
  openai: {
    type: "oauth",
    access: "AT-openai-test-fake",
    refresh: "RT-openai-test-fake",
    accountId: "acct-test-fake",
    // A year from now: the broker refuses an expired record (see below).
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
  },
});

function openCodeBroker(readerFn: () => Promise<string>) {
  return new OpenCodeAuthBroker({ readerFn });
}

async function projectOpenCode(
  broker = openCodeBroker(async () => FAKE_OPENCODE_STORE),
) {
  return broker.project({
    sessionId: "session-1",
    credentialRef: OPENCODE_AUTH_RELATIVE_PATH,
    kind: "opencode_chatgpt_oauth",
    verifiedBinaryPath: "/opt/homebrew/bin/opencode",
  });
}

function projectedAuthPath(syntheticHome: string): string {
  return path.join(syntheticHome, ".local", "share", "opencode", "auth.json");
}

describe("OpenCodeAuthBroker", () => {
  // The load-bearing one. OpenCode's auth.json is a SHARED store: every
  // provider the operator ever logged into lives in the same file. Copying it
  // wholesale would hand an OpenAI-routed step the operator's Z.ai keys.
  test("carries ONLY the openai record — sibling provider secrets never travel", async () => {
    const projection = await projectOpenCode();
    try {
      const raw = await Bun.file(
        projectedAuthPath(projection.syntheticHome),
      ).text();
      expect(Object.keys(JSON.parse(raw))).toEqual(["openai"]);
      expect(raw).not.toContain("ZAI-KEY-test-fake");
      expect(raw).not.toContain("ZAI-KEY-2-test-fake");
      expect(raw).not.toContain("zai");
    } finally {
      await projection.destroy();
    }
  });

  // A review never rotates the chain (cryskai/platform odd/tasks/openai-oauth.md, E1).
  // OpenAI rotates refresh tokens and refuses a reused one for good, and the record
  // this copy came from (a GitHub secret, or the operator's own store) never sees the
  // renewed one. So the copy carries every field but the refresh token, emptied:
  // OpenCode's schema accepts "", reads it only once the access token has expired,
  // and then fails instead of spending the stored chain.
  test("a rotating provider's record travels without its refresh token", async () => {
    const projection = await projectOpenCode();
    try {
      const written = JSON.parse(
        await Bun.file(projectedAuthPath(projection.syntheticHome)).text(),
      );
      expect(Object.keys(written.openai).sort()).toEqual([
        "access",
        "accountId",
        "expires",
        "refresh",
        "type",
      ]);
      expect(written.openai.refresh).toBe("");
      expect(written.openai.access).toBe("AT-openai-test-fake");
      expect(written.openai.accountId).toBe("acct-test-fake");
      expect(JSON.stringify(written)).not.toContain("RT-openai-test-fake");
    } finally {
      await projection.destroy();
    }
  });

  test("an expired record is refused, so the child never tries to renew it", async () => {
    const expired = JSON.stringify({
      openai: {
        type: "oauth",
        access: "AT-openai-test-fake",
        refresh: "RT-openai-test-fake",
        expires: Date.now() - 60_000,
      },
    });
    const error = await projectOpenCode(
      openCodeBroker(async () => expired),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialProjectionError);
    expect((error as CredentialProjectionError).failureClass).toBe(
      "subscription_expiring",
    );
  });

  test("layout: root and every created level are 0700, auth.json is 0600", async () => {
    const projection = await projectOpenCode();
    try {
      for (const dir of [
        projection.syntheticHome,
        path.join(projection.syntheticHome, ".local"),
        path.join(projection.syntheticHome, ".local", "share"),
        path.join(projection.syntheticHome, ".local", "share", "opencode"),
        projection.syntheticTmp,
      ]) {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
      expect(
        statSync(projectedAuthPath(projection.syntheticHome)).mode & 0o777,
      ).toBe(0o600);
    } finally {
      await projection.destroy();
    }
  });

  test("no component of the projection is a symlink (§6.1 lstat defense)", async () => {
    const projection = await projectOpenCode();
    try {
      let cursor = projectedAuthPath(projection.syntheticHome);
      while (cursor.startsWith(projection.syntheticHome)) {
        expect(lstatSync(cursor).isSymbolicLink()).toBe(false);
        cursor = path.dirname(cursor);
      }
    } finally {
      await projection.destroy();
    }
  });

  // The isolation claim must not rest on the harness's env allowlist staying
  // XDG-free. OpenCode resolves its store through XDG_DATA_HOME first, so an
  // inherited value would silently defeat the synthetic home.
  test("env pins XDG so an inherited value cannot escape the projection", async () => {
    const projection = await projectOpenCode();
    try {
      expect(projection.env.HOME).toBe(projection.syntheticHome);
      expect(projection.env.XDG_DATA_HOME).toBe(
        path.join(projection.syntheticHome, ".local", "share"),
      );
      expect(projection.env.XDG_CONFIG_HOME).toBe(
        path.join(projection.syntheticHome, ".config"),
      );
      expect(projection.env.TMPDIR).toBe(projection.syntheticTmp);
    } finally {
      await projection.destroy();
    }
  });

  test("files[] carries the projected path and a sha256 of the real bytes", async () => {
    const projection = await projectOpenCode();
    try {
      expect(projection.files).toHaveLength(1);
      const entry = projection.files[0];
      expect(entry.path).toBe(projectedAuthPath(projection.syntheticHome));
      expect(entry.mode).toBe(0o600);
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(
        new TextEncoder().encode(await Bun.file(entry.path).text()),
      );
      expect(entry.sha256).toBe(hasher.digest("hex"));
    } finally {
      await projection.destroy();
    }
  });

  test("destroy removes the tree and is idempotent", async () => {
    const projection = await projectOpenCode();
    const root = projection.syntheticHome;
    await projection.destroy();
    expect(existsSync(root)).toBe(false);
    await projection.destroy();
    expect(existsSync(root)).toBe(false);
  });

  test("reader failure produces a clean classed error with no source content", async () => {
    const broker = openCodeBroker(async () => {
      throw new Error("/Users/someone/.local/share/opencode/auth.json ENOENT");
    });
    await expect(projectOpenCode(broker)).rejects.toThrow(
      CredentialProjectionError,
    );
    try {
      await projectOpenCode(broker);
    } catch (error) {
      const err = error as CredentialProjectionError;
      expect(err.failureClass).toBe("source_read_failed");
      expect(err.message).not.toContain("/Users/someone");
    }
  });

  test("malformed JSON produces a clean classed error without echoing it", async () => {
    const broker = openCodeBroker(async () => '{"openai": AT-leaked-value');
    try {
      await projectOpenCode(broker);
      throw new Error("expected a projection failure");
    } catch (error) {
      const err = error as CredentialProjectionError;
      expect(err.failureClass).toBe("malformed_payload");
      expect(err.message).not.toContain("AT-leaked-value");
    }
  });

  test("a store with no openai record fails loud", async () => {
    const broker = openCodeBroker(async () =>
      JSON.stringify({ zai: { key: "ZAI-KEY-test-fake", type: "api" } }),
    );
    try {
      await projectOpenCode(broker);
      throw new Error("expected a projection failure");
    } catch (error) {
      expect((error as CredentialProjectionError).failureClass).toBe(
        "missing_subscription_record",
      );
    }
  });

  // The kind claims ChatGPT OAuth. An `openai` entry holding a pay-as-you-go
  // API key is a different credential with different billing, and projecting
  // it under this kind would make the capability report's
  // `billing.mode: "subscription"` a lie.
  test("an openai API key is not the OAuth record this kind promises", async () => {
    const broker = openCodeBroker(async () =>
      JSON.stringify({ openai: { key: "sk-test-fake", type: "api" } }),
    );
    try {
      await projectOpenCode(broker);
      throw new Error("expected a projection failure");
    } catch (error) {
      expect((error as CredentialProjectionError).failureClass).toBe(
        "missing_subscription_record",
      );
    }
  });

  test("unsupported kinds fail loud naming the kind", async () => {
    const broker = openCodeBroker(async () => FAKE_OPENCODE_STORE);
    await expect(
      broker.project({
        sessionId: "s",
        credentialRef: OPENCODE_AUTH_RELATIVE_PATH,
        kind: "claude_subscription_oauth",
        verifiedBinaryPath: "/opt/homebrew/bin/opencode",
      }),
    ).rejects.toThrow(/claude_subscription_oauth/);
  });
});

// ---------------------------------------------------------------------------
// #133: the metered API-token route (§6.1 "CI metered provider", and the
// local equivalent). Generic over ANY OpenCode provider — the provider name
// is a constructor argument, never a literal in the broker.
//
// Projection shape proven live (2026-09-01, opencode 1.18.23): a synthetic
// HOME carrying only `{ <provider>: { type: "api", ... } }` is read as
// exactly that one credential, with the operator's sibling providers absent,
// on two different provider keys. Inference under that credential is NOT yet
// proven — that smoke is blocked on #137's pricing table.
// ---------------------------------------------------------------------------

function apiTokenBroker(provider: string, readerFn: () => Promise<string>) {
  return new OpenCodeApiTokenBroker(provider, { readerFn });
}

async function projectApiToken(broker: OpenCodeApiTokenBroker) {
  return broker.project({
    sessionId: "session-1",
    credentialRef: OPENCODE_AUTH_RELATIVE_PATH,
    kind: "provider_api_token",
    verifiedBinaryPath: "/opt/homebrew/bin/opencode",
  });
}

describe("OpenCodeApiTokenBroker", () => {
  // Genericity is the point of the issue, so it is proven on two DIFFERENT
  // provider names rather than on one that could be a hardcoded literal.
  for (const provider of ["zai", "zai-coding-plan"]) {
    test(`projects the ${provider} record and nothing else`, async () => {
      const broker = apiTokenBroker(provider, async () => FAKE_OPENCODE_STORE);
      const projection = await projectApiToken(broker);
      try {
        const raw = await Bun.file(
          projectedAuthPath(projection.syntheticHome),
        ).text();
        const written = JSON.parse(raw);
        expect(Object.keys(written)).toEqual([provider]);
        // The record travels WHOLE, same rule as the OAuth broker.
        expect(written[provider].type).toBe("api");
        expect(written[provider].key).toBe(
          provider === "zai" ? "ZAI-KEY-2-test-fake" : "ZAI-KEY-test-fake",
        );
        // Sibling providers — including the operator's OpenAI OAuth record —
        // never leave the source store.
        expect(raw).not.toContain("AT-openai-test-fake");
        expect(raw).not.toContain("RT-openai-test-fake");
        expect(raw).not.toContain("oauth");
      } finally {
        await projection.destroy();
      }
    });
  }

  test("the two providers project disjoint stores from the same source", async () => {
    const a = await projectApiToken(
      apiTokenBroker("zai", async () => FAKE_OPENCODE_STORE),
    );
    const b = await projectApiToken(
      apiTokenBroker("zai-coding-plan", async () => FAKE_OPENCODE_STORE),
    );
    try {
      const rawA = await Bun.file(projectedAuthPath(a.syntheticHome)).text();
      const rawB = await Bun.file(projectedAuthPath(b.syntheticHome)).text();
      expect(rawA).not.toContain("ZAI-KEY-test-fake");
      expect(rawB).not.toContain("ZAI-KEY-2-test-fake");
    } finally {
      await a.destroy();
      await b.destroy();
    }
  });

  // The MIRROR of the OAuth broker's `type !== "oauth"` lock. This kind
  // promises a metered API token; projecting an OAuth record under it would
  // make `billing.mode: "metered"` wrong in the other direction — a
  // subscription route reported, and gated, as if it spent cash per token.
  test("an OAuth record is not the API token this kind promises", async () => {
    const broker = apiTokenBroker("openai", async () => FAKE_OPENCODE_STORE);
    try {
      await projectApiToken(broker);
      throw new Error("expected a projection failure");
    } catch (error) {
      expect((error as CredentialProjectionError).failureClass).toBe(
        "missing_provider_record",
      );
    }
  });

  test("a store with no record for this provider fails loud", async () => {
    const broker = apiTokenBroker("mistral", async () => FAKE_OPENCODE_STORE);
    try {
      await projectApiToken(broker);
      throw new Error("expected a projection failure");
    } catch (error) {
      expect((error as CredentialProjectionError).failureClass).toBe(
        "missing_provider_record",
      );
    }
  });

  // `lookupModelPricing` (pricing catalogue, deleted by #197) hit this exact
  // class of bug, found by
  // pr-hero on its own PR #162: a bare index reaches Object.prototype, so a
  // lookup answers true for something the store never held.
  //
  // This arm asserts the OUTCOME, and it does not discriminate on the
  // `Object.hasOwn` line alone: `constructor` is the only prototype key the
  // provider grammar admits, its value is a function, and the broker's
  // `typeof record !== "object"` check refuses it either way (mutation-checked
  // 2026-09-01 — deleting the hasOwn guard keeps this suite green). Kept
  // because the outcome is the contract; the guard's own WHY says the same
  // thing in the source so nobody mistakes this green for coverage of it.
  test("an inherited Object.prototype key is not a provider record", async () => {
    const broker = apiTokenBroker(
      "constructor",
      async () => FAKE_OPENCODE_STORE,
    );
    try {
      await projectApiToken(broker);
      throw new Error("expected a projection failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialProjectionError);
      expect((error as CredentialProjectionError).failureClass).toBe(
        "missing_provider_record",
      );
    }
  });

  test("a provider name outside the safe grammar is refused at construction", () => {
    for (const bad of ["", "../escape", "Zai", "zai/x", "-lead", "a b"]) {
      expect(() => new OpenCodeApiTokenBroker(bad)).toThrow(/provider/i);
    }
    expect(() => new OpenCodeApiTokenBroker("zai-coding-plan")).not.toThrow();
  });

  test("unsupported kinds fail loud naming the kind", async () => {
    const broker = apiTokenBroker("zai", async () => FAKE_OPENCODE_STORE);
    await expect(
      broker.project({
        sessionId: "s",
        credentialRef: OPENCODE_AUTH_RELATIVE_PATH,
        kind: "opencode_chatgpt_oauth",
        verifiedBinaryPath: "/opt/homebrew/bin/opencode",
      }),
    ).rejects.toThrow(/opencode_chatgpt_oauth/);
  });

  // The seam CI will use (#136): the record does not have to come from a
  // file on this machine. A constructed `{type:"api",key}` must project
  // byte-identically to one read off disk.
  test("a constructed record projects identically to a read one", async () => {
    // Same key ORDER as the store fixture: the projection is a
    // JSON.stringify of the record as read, so the bytes — and therefore the
    // sha256 the isolation record publishes — follow insertion order.
    const record = { key: "ZAI-KEY-2-test-fake", type: "api" };
    const fromStore = await projectApiToken(
      apiTokenBroker("zai", async () => FAKE_OPENCODE_STORE),
    );
    const fromSecret = await projectApiToken(
      apiTokenBroker("zai", async () => JSON.stringify({ zai: record })),
    );
    try {
      expect(fromSecret.files[0].sha256).toBe(fromStore.files[0].sha256);
    } finally {
      await fromStore.destroy();
      await fromSecret.destroy();
    }
  });

  test("layout: every created level is 0700, auth.json is 0600", async () => {
    const projection = await projectApiToken(
      apiTokenBroker("zai", async () => FAKE_OPENCODE_STORE),
    );
    try {
      for (const dir of [
        projection.syntheticHome,
        path.join(projection.syntheticHome, ".local"),
        path.join(projection.syntheticHome, ".local", "share"),
        path.join(projection.syntheticHome, ".local", "share", "opencode"),
        projection.syntheticTmp,
      ]) {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
      expect(
        statSync(projectedAuthPath(projection.syntheticHome)).mode & 0o777,
      ).toBe(0o600);
    } finally {
      await projection.destroy();
    }
  });

  test("no component of the projection is a symlink (§6.1 lstat defense)", async () => {
    const projection = await projectApiToken(
      apiTokenBroker("zai", async () => FAKE_OPENCODE_STORE),
    );
    try {
      let cursor = projectedAuthPath(projection.syntheticHome);
      while (cursor.startsWith(projection.syntheticHome)) {
        expect(lstatSync(cursor).isSymbolicLink()).toBe(false);
        cursor = path.dirname(cursor);
      }
      expect(projection.kind).toBe("provider_api_token");
      expect(projection.env.XDG_DATA_HOME).toBe(
        path.join(projection.syntheticHome, ".local", "share"),
      );
    } finally {
      await projection.destroy();
    }
  });

  test("reader failure and malformed JSON stay classed and redacted", async () => {
    const unreadable = apiTokenBroker("zai", async () => {
      throw new Error("/Users/someone/.local/share/opencode/auth.json ENOENT");
    });
    try {
      await projectApiToken(unreadable);
      throw new Error("expected a projection failure");
    } catch (error) {
      const err = error as CredentialProjectionError;
      expect(err.failureClass).toBe("source_read_failed");
      expect(err.message).not.toContain("/Users/someone");
    }

    const malformed = apiTokenBroker(
      "zai",
      async () => '{"zai": ZAI-leaked-value',
    );
    try {
      await projectApiToken(malformed);
      throw new Error("expected a projection failure");
    } catch (error) {
      const err = error as CredentialProjectionError;
      expect(err.failureClass).toBe("malformed_payload");
      expect(err.message).not.toContain("ZAI-leaked-value");
    }
  });

  test("destroy removes the tree and is idempotent", async () => {
    const projection = await projectApiToken(
      apiTokenBroker("zai", async () => FAKE_OPENCODE_STORE),
    );
    const root = projection.syntheticHome;
    await projection.destroy();
    expect(existsSync(root)).toBe(false);
    await projection.destroy();
    expect(existsSync(root)).toBe(false);
  });
});

// #280: the free route projects the provider's OWN `api` record when one
// exists in auth.json, so a flat-fee API-key plan priced at $0
// (zai-coding-plan) reaches the child with a credential instead of running
// keyless against a provider that requires one. Every other outcome —
// absent file, unreadable file, malformed JSON, no entry for this provider,
// an entry that is not `type: "api"` — collapses to the SAME empty tree
// #182 always produced, never a throw. See the class header comment for the
// full WHY; these tests are what "collapses to the empty tree" means in
// practice, one failure mode at a time.
function freeBroker(provider: string, readerFn: () => Promise<string>) {
  return new OpenCodeFreeBroker(provider, { readerFn });
}

async function projectFree(broker: OpenCodeFreeBroker) {
  return broker.project({
    sessionId: "session-1",
    credentialRef: OPENCODE_AUTH_RELATIVE_PATH,
    kind: "provider_free",
    verifiedBinaryPath: "/opt/homebrew/bin/opencode",
  });
}

describe("#280 OpenCodeFreeBroker projects the provider's api record", () => {
  test("a provider WITH an api record gets it projected, and only it", async () => {
    const broker = freeBroker(
      "zai-coding-plan",
      async () => FAKE_OPENCODE_STORE,
    );
    const projection = await projectFree(broker);
    try {
      expect(projection.files).toHaveLength(1);
      const raw = await Bun.file(
        projectedAuthPath(projection.syntheticHome),
      ).text();
      const written = JSON.parse(raw);
      expect(Object.keys(written)).toEqual(["zai-coding-plan"]);
      expect(written["zai-coding-plan"].type).toBe("api");
      expect(written["zai-coding-plan"].key).toBe("ZAI-KEY-test-fake");
      // Sibling providers in the same store — including the operator's
      // OpenAI OAuth record — never leave the source store.
      expect(raw).not.toContain("AT-openai-test-fake");
      expect(raw).not.toContain("ZAI-KEY-2-test-fake");
    } finally {
      await projection.destroy();
    }
  });

  test("a provider with NO record in an otherwise-populated store falls back to the empty tree", async () => {
    const broker = freeBroker("mistral", async () => FAKE_OPENCODE_STORE);
    const projection = await projectFree(broker);
    try {
      expect(projection.files).toEqual([]);
      expect(existsSync(projectedAuthPath(projection.syntheticHome))).toBe(
        false,
      );
    } finally {
      await projection.destroy();
    }
  });

  test("an OAuth record for this exact provider is not projected — empty tree, not the OAuth record", async () => {
    const broker = freeBroker("openai", async () => FAKE_OPENCODE_STORE);
    const projection = await projectFree(broker);
    try {
      expect(projection.files).toEqual([]);
    } finally {
      await projection.destroy();
    }
  });

  test("auth.json absent (fresh machine, Zen-only user) — empty tree, never a throw", async () => {
    const broker = freeBroker("zai-coding-plan", async () => {
      throw new Error("/Users/someone/.local/share/opencode/auth.json ENOENT");
    });
    const projection = await projectFree(broker);
    try {
      expect(projection.files).toEqual([]);
    } finally {
      await projection.destroy();
    }
  });

  test("malformed JSON in the store — empty tree, never a throw, never the operator env", async () => {
    const broker = freeBroker(
      "zai-coding-plan",
      async () => '{"zai-coding-plan": KEY-leaked-value',
    );
    const projection = await projectFree(broker);
    try {
      expect(projection.files).toEqual([]);
    } finally {
      await projection.destroy();
    }
  });

  test("still refuses any other kind by name, and never the degrading class", async () => {
    const broker = freeBroker(
      "zai-coding-plan",
      async () => FAKE_OPENCODE_STORE,
    );
    for (const kind of [
      "provider_api_token",
      "opencode_chatgpt_oauth",
      "claude_subscription_oauth",
    ] as const) {
      let error: unknown;
      try {
        await broker.project({
          sessionId: "s",
          credentialRef: OPENCODE_AUTH_RELATIVE_PATH,
          kind,
          verifiedBinaryPath: "/fake/opencode",
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      if (error instanceof CredentialProjectionError) {
        expect(error.failureClass).not.toBe("missing_subscription_record");
      }
    }
  });

  test("a provider name outside the safe grammar is refused at construction", () => {
    for (const bad of ["", "../escape", "Zai", "zai/x", "-lead", "a b"]) {
      expect(() => new OpenCodeFreeBroker(bad)).toThrow(/provider/i);
    }
    expect(() => new OpenCodeFreeBroker("zai-coding-plan")).not.toThrow();
  });
});

// D1-08 PR3 task 3.9 (§9.2): CredentialProjection.bucketScope. Neither
// shipped broker populates it yet — claude_subscription_oauth has no
// account/project/rateLimitGroup to report — but the field must exist so a
// future broker can, and an absent bucketScope must feed deriveBucketId
// (execution/bucket-id.ts) identically to an explicit all-unknown one.
describe("CredentialProjection.bucketScope", () => {
  test("today's Keychain projection carries no bucketScope (honest, not populated)", async () => {
    const projection = await project();
    try {
      expect(projection.bucketScope).toBeUndefined();
    } finally {
      await projection.destroy();
    }
  });

  test("an absent bucketScope and an explicit all-undefined one derive the identical bucketId", async () => {
    const { deriveBucketId } = await import("../../src/execution/bucket-id");
    const key = Buffer.from("c".repeat(64), "hex");
    const projection = await project();
    try {
      const withoutScope = deriveBucketId(
        {
          provider: "anthropic",
          credentialFingerprint: projection.projectionId,
          scope: projection.bucketScope,
        },
        key,
      );
      const withExplicitUnknownScope = deriveBucketId(
        {
          provider: "anthropic",
          credentialFingerprint: projection.projectionId,
          scope: {
            account: undefined,
            project: undefined,
            rateLimitGroup: undefined,
          },
        },
        key,
      );
      expect(withoutScope).toBe(withExplicitUnknownScope);
    } finally {
      await projection.destroy();
    }
  });

  test("a projection MAY carry a populated bucketScope (type accepts it) and it changes the derived bucket", async () => {
    const { deriveBucketId } = await import("../../src/execution/bucket-id");
    const key = Buffer.from("d".repeat(64), "hex");
    const base = await project();
    try {
      const scoped: typeof base = {
        ...base,
        bucketScope: { account: "acct-9" },
      };
      const bucketWithoutScope = deriveBucketId(
        {
          provider: "anthropic",
          credentialFingerprint: base.projectionId,
          scope: base.bucketScope,
        },
        key,
      );
      const bucketWithScope = deriveBucketId(
        {
          provider: "anthropic",
          credentialFingerprint: scoped.projectionId,
          scope: scoped.bucketScope,
        },
        key,
      );
      expect(bucketWithScope).not.toBe(bucketWithoutScope);
    } finally {
      await base.destroy();
    }
  });
});
