// U3 (odd/tasks/role-model-routing.md S8/S9, L12 "Building auth.json"): the
// manifest the setup step leaves beside the OpenCode auth file it built from
// CRYSK_* secrets. Names and kinds only, never a value; the run reads the names
// back so the credential kind follows the secret that was used.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveOpenCodeAuthPath } from "../../src/security/credential-broker";
import {
  OPENCODE_SECRET_MANIFEST_FILE,
  openCodeSecretManifestPath,
  openCodeSecretNamesFromManifest,
  readOpenCodeSecretNames,
  serializeOpenCodeSecretManifest,
} from "../../src/security/opencode-secret-manifest";

describe("the OpenCode secret manifest", () => {
  test("sits beside auth.json", () => {
    const authPath = resolveOpenCodeAuthPath({ XDG_DATA_HOME: "/data" });
    expect(openCodeSecretManifestPath(authPath)).toBe(
      path.join("/data", "opencode", OPENCODE_SECRET_MANIFEST_FILE),
    );
  });

  test("round-trips every secret it names, the used one and the unused one", () => {
    const text = serializeOpenCodeSecretManifest([
      {
        provider: "openai",
        secret: "CRYSK_OPENCODE_OPENAI_OAUTH",
        kind: "oauth",
        unused: "CRYSK_OPENCODE_OPENAI_API_KEY",
      },
      {
        provider: "deepseek",
        secret: "CRYSK_OPENCODE_DEEPSEEK_API_KEY",
        kind: "api_key",
      },
    ]);
    expect(JSON.parse(text)).toEqual({
      v: 1,
      source: "crysk-secrets",
      providers: {
        deepseek: {
          secret: "CRYSK_OPENCODE_DEEPSEEK_API_KEY",
          kind: "api_key",
        },
        openai: {
          secret: "CRYSK_OPENCODE_OPENAI_OAUTH",
          kind: "oauth",
          unused: "CRYSK_OPENCODE_OPENAI_API_KEY",
        },
      },
    });
    expect(openCodeSecretNamesFromManifest(text)).toEqual([
      "CRYSK_OPENCODE_DEEPSEEK_API_KEY",
      "CRYSK_OPENCODE_OPENAI_API_KEY",
      "CRYSK_OPENCODE_OPENAI_OAUTH",
    ]);
  });

  test("anything else reads as no manifest, so the provider literal stands", () => {
    for (const text of [
      "not json",
      "[]",
      JSON.stringify({ v: 2, source: "crysk-secrets", providers: {} }),
      JSON.stringify({ v: 1, source: "other", providers: {} }),
      JSON.stringify({
        v: 1,
        source: "crysk-secrets",
        providers: { openai: { secret: "OPENCODE_AUTH_JSON", kind: "oauth" } },
      }),
      JSON.stringify({
        v: 1,
        source: "crysk-secrets",
        providers: {
          openai: { secret: "CRYSK_OPENCODE_OPENAI_OAUTH", kind: "free" },
        },
      }),
    ]) {
      expect(openCodeSecretNamesFromManifest(text)).toBeUndefined();
    }
  });

  test("reads the file at the env's auth path, and nothing when it is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pr-hero-oc-manifest-"));
    try {
      const env = { XDG_DATA_HOME: root };
      expect(readOpenCodeSecretNames(env)).toBeUndefined();
      const file = openCodeSecretManifestPath(resolveOpenCodeAuthPath(env));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        serializeOpenCodeSecretManifest([
          {
            provider: "openai",
            secret: "CRYSK_OPENCODE_OPENAI_API_KEY",
            kind: "api_key",
          },
        ]),
      );
      expect(readOpenCodeSecretNames(env)).toEqual([
        "CRYSK_OPENCODE_OPENAI_API_KEY",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
