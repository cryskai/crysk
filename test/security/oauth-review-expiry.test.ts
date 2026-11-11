import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createResolvedRoutePlan, resolveStepRoute } from "#model/routing";
import { openCodeCredentialRefusal } from "../../src/production-runtime";

// A review refuses to start on a subscription login that would expire during it
// (cryskai/platform odd/tasks/openai-oauth.md, E1). The review never renews the
// login itself (the broker empties the refresh token), so a token that runs out
// mid-review would fail its later steps; refusing up front names the cause.

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

let dir = "";
afterEach(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function envWithOpenAIRecord(expires: number | undefined) {
  dir = mkdtempSync(path.join(tmpdir(), "crysk-oauth-expiry-"));
  const dataHome = path.join(dir, "xdg");
  mkdirSync(path.join(dataHome, "opencode"), { recursive: true });
  writeFileSync(
    path.join(dataHome, "opencode", "auth.json"),
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "AT-test-fake",
        refresh: "RT-test-fake",
        ...(expires === undefined ? {} : { expires }),
      },
    }),
  );
  return { XDG_DATA_HOME: dataHome };
}

const plan = createResolvedRoutePlan([
  resolveStepRoute({
    stepKey: "hunter-logic",
    role: "hunter",
    cliModel: "opencode:openai/gpt-5.5",
  }),
]);

describe("openCodeCredentialRefusal — an expiring subscription login", () => {
  test("refuses a login with an hour left, naming the route", async () => {
    const refusal = await openCodeCredentialRefusal(
      plan,
      undefined,
      new Map(),
      envWithOpenAIRecord(NOW + HOUR),
      NOW,
    );
    expect(refusal?.failureClass).toBe("subscription_expiring");
    expect(refusal?.params.provider).toBe("openai");
    expect(refusal?.params.step).toBe("hunter-logic");
    expect(refusal?.message).toContain("expires");
  });

  test("admits a login with three hours left", async () => {
    expect(
      await openCodeCredentialRefusal(
        plan,
        undefined,
        new Map(),
        envWithOpenAIRecord(NOW + 3 * HOUR),
        NOW,
      ),
    ).toBeUndefined();
  });

  test("keeps today's behavior for a record that states no expiry", async () => {
    expect(
      await openCodeCredentialRefusal(
        plan,
        undefined,
        new Map(),
        envWithOpenAIRecord(undefined),
        NOW,
      ),
    ).toBeUndefined();
  });
});
