// odd/tasks/antigravity-oauth.md T3 (S5): the Antigravity (`agy`) credential
// projection. Obviously-fake tokens only: never a real credential in a fixture.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, statSync } from "node:fs";
import path from "node:path";
import {
  AgyCredentialBroker,
  CredentialProjectionError,
  lookupAntigravityRecord,
  resolveAgyTokenPath,
  resolveAntigravityCredentialSource,
  resolveAntigravityRecordPath,
} from "../../src/security/credential-broker";

const EXPIRES = Date.UTC(2026, 0, 1, 12, 0, 0);

// The canonical record CI materializes from CRYSK_ANTIGRAVITY_OAUTH (T5).
const CANONICAL = JSON.stringify({
  type: "oauth",
  access: "AT-test-fake",
  refresh: "RT-test-fake",
  expires: EXPIRES,
  accountId: "dev@example.com",
});

// The developer's own agy token file, already in agy's StoredToken format.
const AGY_FORMAT = JSON.stringify({
  token: {
    access_token: "AT-local-fake",
    token_type: "Bearer",
    refresh_token: "RT-local-fake",
    expiry: "2026-01-01T12:00:00.000Z",
  },
  auth_method: "consumer",
});

function broker(raw: string | (() => Promise<string>)) {
  return new AgyCredentialBroker({
    readerFn: typeof raw === "string" ? async () => raw : raw,
  });
}

async function project(b: AgyCredentialBroker) {
  return b.project({
    sessionId: "session-1",
    credentialRef: "antigravity-oauth",
    kind: "antigravity_subscription_oauth",
    verifiedBinaryPath: "/usr/local/bin/agy",
  });
}

async function failureOf(b: AgyCredentialBroker): Promise<string> {
  try {
    const projection = await project(b);
    await projection.destroy();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialProjectionError);
    return (error as CredentialProjectionError).failureClass;
  }
  throw new Error("expected the projection to be refused");
}

function mode(p: string): number {
  return statSync(p).mode & 0o777;
}

describe("AgyCredentialBroker projection (S5)", () => {
  test("translates the canonical record into agy's StoredToken file", async () => {
    const projection = await project(broker(CANONICAL));
    try {
      const tokenFile = path.join(
        projection.syntheticHome,
        ".gemini",
        "antigravity-cli",
        "antigravity-oauth-token",
      );
      expect(JSON.parse(await Bun.file(tokenFile).text())).toEqual({
        token: {
          access_token: "AT-test-fake",
          token_type: "Bearer",
          refresh_token: "RT-test-fake",
          expiry: new Date(EXPIRES).toISOString(),
        },
        auth_method: "consumer",
      });
      expect(mode(tokenFile)).toBe(0o600);
    } finally {
      await projection.destroy();
    }
  });

  test("accepts agy's own Go-formatted expiry (nanoseconds, zone offset)", async () => {
    const goExpiry = JSON.stringify({
      token: {
        access_token: "AT-local-fake",
        token_type: "Bearer",
        refresh_token: "RT-local-fake",
        expiry: "2026-11-13T12:34:56.123456789-03:00",
      },
      auth_method: "consumer",
    });
    const projection = await project(broker(goExpiry));
    try {
      const file = projection.files.find((f) =>
        f.path.endsWith("antigravity-oauth-token"),
      );
      const written = JSON.parse(await Bun.file(file?.path ?? "").text());
      expect(written.token.expiry).toBe("2026-11-13T15:34:56.123Z");
      expect(written.token.refresh_token).toBe("RT-local-fake");
    } finally {
      await projection.destroy();
    }
  });

  test("projects the developer's agy token file as it is", async () => {
    const projection = await project(broker(AGY_FORMAT));
    try {
      const tokenFile = path.join(
        projection.syntheticHome,
        ".gemini",
        "antigravity-cli",
        "antigravity-oauth-token",
      );
      expect(JSON.parse(await Bun.file(tokenFile).text())).toEqual(
        JSON.parse(AGY_FORMAT),
      );
    } finally {
      await projection.destroy();
    }
  });

  test("writes an empty MCP config, the only MCP file agy reads", async () => {
    const projection = await project(broker(CANONICAL));
    try {
      const mcp = path.join(
        projection.syntheticHome,
        ".gemini",
        "config",
        "mcp_config.json",
      );
      expect(JSON.parse(await Bun.file(mcp).text())).toEqual({
        mcpServers: {},
      });
      expect(mode(mcp)).toBe(0o600);
      expect(projection.files.map((f) => f.path).sort()).toEqual(
        [
          mcp,
          path.join(
            projection.syntheticHome,
            ".gemini",
            "antigravity-cli",
            "antigravity-oauth-token",
          ),
        ].sort(),
      );
      for (const file of projection.files) {
        expect(file.mode).toBe(0o600);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      await projection.destroy();
    }
  });

  test("returns a full projection: synthetic home, config, tmp and pinned env", async () => {
    const projection = await project(broker(CANONICAL));
    try {
      expect(projection.kind).toBe("antigravity_subscription_oauth");
      expect(projection.projectionId).toMatch(/^cred-/);
      const home = projection.syntheticHome;
      expect(projection.syntheticConfigHome).toBe(
        path.join(home, ".gemini", "config"),
      );
      expect(projection.syntheticTmp).toBe(path.join(home, "tmp"));
      expect(projection.env).toEqual({
        HOME: home,
        TMPDIR: path.join(home, "tmp"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        // L3: agy honours `true`, not `1`.
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      });
      // agy writes its own state (plugin-secrets.json, antigravity-cli dirs)
      // into the synthetic home: every directory is the step's own, 0700.
      for (const dir of [
        home,
        path.join(home, ".gemini"),
        path.join(home, ".gemini", "antigravity-cli"),
        path.join(home, ".gemini", "config"),
        path.join(home, ".gemini", "config", "agents"),
        path.join(home, ".config"),
        path.join(home, ".config", "antigravity"),
        path.join(home, ".local", "share"),
        path.join(home, "tmp"),
      ]) {
        expect(lstatSync(dir).isDirectory()).toBe(true);
        expect(mode(dir)).toBe(0o700);
      }
    } finally {
      await projection.destroy();
    }
    expect(existsSync(projection.syntheticHome)).toBe(false);
  });

  test("each step gets its own home", async () => {
    const b = broker(CANONICAL);
    const first = await project(b);
    const second = await project(b);
    try {
      expect(first.syntheticHome).not.toBe(second.syntheticHome);
      expect(first.projectionId).not.toBe(second.projectionId);
    } finally {
      await first.destroy();
      await second.destroy();
    }
  });
});

describe("AgyCredentialBroker refusals (S5)", () => {
  test("an expired access token is projected, never refused (agy refreshes it at startup)", async () => {
    const expired = JSON.stringify({
      type: "oauth",
      access: "AT-expired-fake",
      refresh: "RT-test-fake",
      expires: Date.now() - 60 * 60 * 1000,
    });
    const projection = await project(broker(expired));
    await projection.destroy();
  });

  test("the refresh token travels: antigravity does not rotate it", async () => {
    const projection = await project(broker(CANONICAL));
    try {
      const file = projection.files.find((f) =>
        f.path.endsWith("antigravity-oauth-token"),
      );
      const written = JSON.parse(await Bun.file(file?.path ?? "").text());
      expect(written.token.refresh_token).toBe("RT-test-fake");
    } finally {
      await projection.destroy();
    }
  });

  test("a missing or unreadable record is refused", async () => {
    expect(
      await failureOf(
        broker(async () => {
          throw new Error("ENOENT /secret/path");
        }),
      ),
    ).toBe("source_read_failed");
  });

  test("a malformed record is refused", async () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ type: "api", key: "k" }),
      JSON.stringify({ type: "oauth", access: "a", refresh: "r" }),
      JSON.stringify({
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: "soon",
      }),
      JSON.stringify({ token: { access_token: "a", refresh_token: "r" } }),
      JSON.stringify({
        token: { access_token: "a", refresh_token: "r", expiry: "never" },
      }),
    ]) {
      expect(await failureOf(broker(raw)), raw).toBe("malformed_payload");
    }
  });

  test("an empty refresh token is refused", async () => {
    for (const raw of [
      JSON.stringify({
        type: "oauth",
        access: "a",
        refresh: "",
        expires: EXPIRES,
      }),
      JSON.stringify({
        token: {
          access_token: "a",
          refresh_token: "",
          expiry: "2026-01-01T00:00:00Z",
        },
      }),
    ]) {
      expect(await failureOf(broker(raw)), raw).toBe("malformed_payload");
    }
  });

  test("never raises missing_subscription_record, the class the harness degrades", async () => {
    for (const raw of ["{}", JSON.stringify({ openai: { type: "oauth" } })]) {
      expect(await failureOf(broker(raw)), raw).not.toBe(
        "missing_subscription_record",
      );
    }
  });

  test("a refusal names only its class, never the source or the token", async () => {
    try {
      await project(
        broker(JSON.stringify({ type: "oauth", access: "AT-SECRET-fake" })),
      );
    } catch (error) {
      expect((error as Error).message).toBe(
        "Credential projection failed (malformed_payload)",
      );
      return;
    }
    throw new Error("expected a refusal");
  });

  test("refuses any other credential kind", async () => {
    await expect(
      broker(CANONICAL).project({
        sessionId: "s",
        credentialRef: "antigravity-oauth",
        kind: "claude_subscription_oauth",
        verifiedBinaryPath: "/usr/local/bin/agy",
      }),
    ).rejects.toThrow("AgyCredentialBroker projects only");
  });
});

describe("antigravity credential source (S5)", () => {
  test("the CI record lives under XDG_DATA_HOME, else ~/.local/share", () => {
    expect(resolveAntigravityRecordPath({ XDG_DATA_HOME: "/xdg" }, "/h")).toBe(
      "/xdg/crysk/antigravity-auth.json",
    );
    expect(resolveAntigravityRecordPath({}, "/h")).toBe(
      "/h/.local/share/crysk/antigravity-auth.json",
    );
  });

  test("the developer's agy token is agy's own file", () => {
    expect(resolveAgyTokenPath("/h")).toBe(
      "/h/.gemini/antigravity-cli/antigravity-oauth-token",
    );
  });

  test("CI reads only the materialized record; a local run reads the agy token", () => {
    expect(
      resolveAntigravityCredentialSource({ GITHUB_ACTIONS: "true" }, "/h"),
    ).toBe("/h/.local/share/crysk/antigravity-auth.json");
    expect(resolveAntigravityCredentialSource({}, "/h")).toBe(
      "/h/.gemini/antigravity-cli/antigravity-oauth-token",
    );
  });

  test("the shared lookup answers what the broker answers", async () => {
    const ok = await lookupAntigravityRecord(async () => CANONICAL);
    expect(ok.ok).toBe(true);
    const empty = await lookupAntigravityRecord(async () =>
      JSON.stringify({ type: "oauth", access: "a", refresh: "", expires: 1 }),
    );
    expect(empty).toEqual({ ok: false, failureClass: "malformed_payload" });
  });
});
