// odd/tasks/antigravity-oauth.md T3 (S5): admission refuses an agy plan with
// no usable Antigravity login before anything spends. An expired access token
// is not a refusal: agy renews it at startup from the non-rotating refresh
// token, so REVIEW_EXPIRY_MARGIN_MS applies only to rotating providers.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createResolvedRoutePlan,
  resolveStepRoute,
} from "../src/model/routing";
import {
  antigravityCredentialRefusal,
  prepareProductionAdmissionContext,
} from "../src/production-runtime";
import { oauthSecretName } from "../src/security/oauth-providers";

function planOf(models: string[]) {
  return createResolvedRoutePlan([
    resolveStepRoute({
      stepKey: "hunter-logic",
      role: "hunter",
      modelRole: "hunter.logic",
      models: { "hunter.logic": models },
    }),
    resolveStepRoute({
      stepKey: "hunter-security",
      role: "hunter",
      modelRole: "hunter.security",
      models: { "hunter.security": models },
    }),
  ]);
}

const VALID = JSON.stringify({
  type: "oauth",
  access: "AT-test-fake",
  refresh: "RT-test-fake",
  // Long expired: still usable, agy renews it.
  expires: Date.UTC(2020, 0, 1),
});
const NO_REFRESH = JSON.stringify({
  type: "oauth",
  access: "AT-test-fake",
  refresh: "",
  expires: Date.UTC(2030, 0, 1),
});
const CI = { GITHUB_ACTIONS: "true", XDG_DATA_HOME: "/xdg" };

describe("antigravityCredentialRefusal (S5)", () => {
  test("the secret it names is the provider descriptor's", () => {
    expect(oauthSecretName("antigravity")).toBe("CRYSK_ANTIGRAVITY_OAUTH");
  });

  test("a plan with no agy route reads nothing", async () => {
    let reads = 0;
    const refusal = await antigravityCredentialRefusal(
      planOf(["claude:sonnet-latest"]),
      CI,
      async () => {
        reads++;
        return VALID;
      },
    );
    expect(refusal).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("CI with no record is refused before spend, naming CRYSK_ANTIGRAVITY_OAUTH", async () => {
    const read: string[] = [];
    const refusal = await antigravityCredentialRefusal(
      planOf(["claude:sonnet-latest", "agy:gemini-4-argon-high"]),
      CI,
      async (p) => {
        read.push(p);
        throw new Error("ENOENT");
      },
    );
    expect(read).toEqual(["/xdg/crysk/antigravity-auth.json"]);
    expect(refusal).toEqual({
      message:
        "models name agy model gemini-4-argon-high (hunter-logic, hunter-security), but no usable CRYSK_ANTIGRAVITY_OAUTH secret reached the run (no Antigravity login record with a refresh token): connect Antigravity in the Crysk dashboard, or set CRYSK_ANTIGRAVITY_OAUTH and pass it in the crysk-secrets input",
      failureClass: "missing_subscription_record",
      params: {
        backend: "antigravity",
        provider: "google",
        model: "gemini-4-argon-high",
        step: "hunter-logic",
        secret: "CRYSK_ANTIGRAVITY_OAUTH",
      },
    });
  });

  test("an empty refresh token is refused like a missing record", async () => {
    const refusal = await antigravityCredentialRefusal(
      planOf(["agy:gemini-4-argon-high"]),
      CI,
      async () => NO_REFRESH,
    );
    expect(refusal?.failureClass).toBe("missing_subscription_record");
    expect(refusal?.params.secret).toBe("CRYSK_ANTIGRAVITY_OAUTH");
  });

  test("a malformed record is refused", async () => {
    const refusal = await antigravityCredentialRefusal(
      planOf(["agy:gemini-4-argon-high"]),
      CI,
      async () => "not json",
    );
    expect(refusal?.failureClass).toBe("missing_subscription_record");
  });

  test("an expired access token with a refresh token is not refused", async () => {
    expect(
      await antigravityCredentialRefusal(
        planOf(["agy:gemini-4-argon-high"]),
        CI,
        async () => VALID,
      ),
    ).toBeUndefined();
  });

  test("a local run reads the developer's agy login and says how to sign in", async () => {
    const read: string[] = [];
    const refusal = await antigravityCredentialRefusal(
      planOf(["agy:gemini-4-argon-high"]),
      { HOME: "/ignored" },
      async (p) => {
        read.push(p);
        throw new Error("ENOENT");
      },
      "/home/dev",
    );
    expect(read).toEqual([
      "/home/dev/.gemini/antigravity-cli/antigravity-oauth-token",
    ]);
    expect(refusal?.message).toBe(
      "models name agy model gemini-4-argon-high (hunter-logic, hunter-security), but agy has no usable login (no Antigravity login record with a refresh token): run `agy` and sign in with Google",
    );
    expect(refusal?.params.secret).toBeUndefined();
  });

  test("the record's text never reaches the message", async () => {
    const refusal = await antigravityCredentialRefusal(
      planOf(["agy:gemini-4-argon-high"]),
      CI,
      async () => JSON.stringify({ type: "oauth", access: "AT-SECRET-fake" }),
    );
    expect(refusal?.message).not.toContain("SECRET");
  });
});

describe("admission refuses an agy plan with no login (S5)", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "crysk-agy-admission-"));
    await writeFile(path.join(dir, "agy"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(dir, "agy"), 0o755);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("before any binding or spend", async () => {
    const result = await prepareProductionAdmissionContext({
      workspaceRoot: dir,
      plan: planOf(["agy:gemini-4-argon-high"]),
      env: {
        PATH: dir,
        GITHUB_ACTIONS: "true",
        XDG_DATA_HOME: path.join(dir, "xdg"),
      },
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("CRYSK_ANTIGRAVITY_OAUTH");
    expect(result.credentialRefusal?.params.backend).toBe("antigravity");
  });

  test("a dry run checks no credential", async () => {
    // T4: past the credential check, the agy route binds on its registered
    // transport and the discovered agy.
    const result = await prepareProductionAdmissionContext({
      workspaceRoot: dir,
      plan: planOf(["agy:gemini-4-argon-high"]),
      checkCredentials: false,
      env: {
        PATH: dir,
        GITHUB_ACTIONS: "true",
        XDG_DATA_HOME: path.join(dir, "xdg"),
      },
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.registry.has("antigravity")).toBe(true);
    expect(result.authorityOptions.antigravityBinaryPath).toBe(
      await realpath(path.join(dir, "agy")),
    );
  });

  test("a usable record passes the credential check", async () => {
    await mkdir(path.join(dir, "xdg", "crysk"), { recursive: true });
    await writeFile(
      path.join(dir, "xdg", "crysk", "antigravity-auth.json"),
      VALID,
      { mode: 0o600 },
    );
    const result = await prepareProductionAdmissionContext({
      workspaceRoot: dir,
      plan: planOf(["agy:gemini-4-argon-high"]),
      env: {
        PATH: dir,
        GITHUB_ACTIONS: "true",
        XDG_DATA_HOME: path.join(dir, "xdg"),
      },
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.registry.has("antigravity")).toBe(true);
  });
});
