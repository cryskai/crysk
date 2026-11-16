// odd/tasks/antigravity-oauth.md T3 (S5): an agy plan with no usable login is
// refused at confirm with its own credential refusal, before any spend, and
// never under the OpenCode refusal's name.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createResolvedRoutePlan,
  resolveStepRoute,
} from "../../src/model/routing";
import {
  AntigravityCredentialRefusalError,
  resolveProductionRoutePlanAtConfirm,
} from "../../src/review/route-preflight";
import { CredentialRefusalError } from "../../src/security/claude-credential";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "crysk-agy-preflight-"));
  await writeFile(path.join(dir, "agy"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(dir, "agy"), 0o755);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("route preflight refuses an agy plan with no login (S5)", () => {
  test("throws the antigravity credential refusal, classed as a credential failure", async () => {
    let error: unknown;
    try {
      await resolveProductionRoutePlanAtConfirm({
        modelsConfigured: true,
        workspaceRoot: dir,
        buildRoutePlan: async () =>
          createResolvedRoutePlan([
            resolveStepRoute({
              stepKey: "hunter-logic",
              role: "hunter",
              modelRole: "hunter.logic",
              models: { "hunter.logic": ["agy:gemini-4-argon-high"] },
            }),
          ]),
        env: {
          PATH: dir,
          GITHUB_ACTIONS: "true",
          XDG_DATA_HOME: path.join(dir, "xdg"),
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AntigravityCredentialRefusalError);
    expect(error).toBeInstanceOf(CredentialRefusalError);
    const refusal = error as AntigravityCredentialRefusalError;
    expect(refusal.message).toContain("CRYSK_ANTIGRAVITY_OAUTH");
    expect(refusal.params).toEqual({
      backend: "antigravity",
      provider: "google",
      model: "gemini-4-argon-high",
      step: "hunter-logic",
      secret: "CRYSK_ANTIGRAVITY_OAUTH",
    });
    expect(refusal.ledgerReason).toBe(
      "no usable Antigravity login for agy routes; refused before any provider spend",
    );
  });
});
