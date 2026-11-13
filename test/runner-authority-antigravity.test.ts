// odd/tasks/antigravity-oauth.md T2 (S4): the antigravity backend has a
// credential kind of its own, but no binding, transport or broker yet (T3-T4).
// Until then an `agy:` plan must be refused before anything spends, and never
// run on another backend.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createResolvedRoutePlan,
  resolveStepRoute,
} from "../src/model/routing";
import { createProductionRuntime } from "../src/production-runtime";
import {
  credentialKindBillsMetered,
  credentialKindForRoute,
  resolveBindingAuthority,
} from "../src/runner-authority";

// #303: verifying the Claude fixture snapshots it under os.tmpdir(), so a
// per-file TMPDIR keeps it away from the operator's real snapshot base, as in
// production-runtime.test.ts.
let originalTmpdir: string | undefined;
let isolatedTmpdir = "";
beforeAll(async () => {
  originalTmpdir = process.env.TMPDIR;
  isolatedTmpdir = await mkdtemp(path.join(tmpdir(), "crysk-agy-tmpdir-"));
  process.env.TMPDIR = isolatedTmpdir;
});
afterAll(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(isolatedTmpdir, { recursive: true, force: true });
});

describe("antigravity credential kind (S4)", () => {
  test("an antigravity route binds the Google subscription OAuth kind", () => {
    expect(credentialKindForRoute("antigravity", "google")).toBe(
      "antigravity_subscription_oauth",
    );
  });

  test("the subscription kind is not metered", () => {
    expect(credentialKindBillsMetered("antigravity_subscription_oauth")).toBe(
      false,
    );
    expect(credentialKindBillsMetered("provider_api_token")).toBe(true);
  });

  test("codex still has no credential authority", () => {
    expect(() => credentialKindForRoute("codex", "openai")).toThrow(
      'No credential authority is bound for backend "codex"',
    );
  });

  test("claude-code and opencode kinds are unchanged", () => {
    expect(credentialKindForRoute("claude-code", "anthropic")).toBe(
      "claude_subscription_oauth",
    );
    expect(credentialKindForRoute("opencode", "openai")).toBe(
      "opencode_chatgpt_oauth",
    );
    expect(credentialKindForRoute("opencode", "deepseek")).toBe(
      "provider_api_token",
    );
  });
});

describe("an agy plan fails closed until its transport exists (S4)", () => {
  test("binding authority refuses antigravity by name", async () => {
    const result = await resolveBindingAuthority("antigravity", "google", {
      workspaceRoot: tmpdir(),
    });
    expect(result.binding).toBeUndefined();
    expect(result.error).toBe(
      "the antigravity backend (agy: models) is not available yet: Crysk cannot run an agy: model in this version, so choose a claude: or opencode: model",
    );
  });

  test("codex keeps its refusal byte for byte", async () => {
    const result = await resolveBindingAuthority("codex", "openai", {
      workspaceRoot: tmpdir(),
    });
    expect(result.error).toBe('unsupported production backend "codex" in PR1');
  });

  let workspace = "";
  let claude = { canonicalPath: "", sha256: "" };
  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "crysk-agy-admission-"));
    // A verifiable Claude executable, so a Claude route binds and the agy
    // route's own refusal is what stops the plan, whichever comes first.
    const bytes = Buffer.concat([
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
      Buffer.from("#!/bin/sh\nexit 0\n"),
    ]);
    const claudePath = path.join(workspace, "claude");
    await writeFile(claudePath, bytes);
    await chmod(claudePath, 0o755);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    claude = {
      canonicalPath: await realpath(claudePath),
      sha256: hasher.digest("hex"),
    };
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a runtime for a plan naming agy, first or as a fallback, is refused", async () => {
    for (const models of [
      ["agy:gemini-4-argon-high", "claude:sonnet-latest"],
      ["claude:sonnet-latest", "agy:gemini-4-argon-high"],
    ]) {
      const step = resolveStepRoute({
        stepKey: "hunter-logic",
        role: "hunter",
        modelRole: "hunter.logic",
        models: { "hunter.logic": models },
      });
      const plan = createResolvedRoutePlan([step]);
      let error: unknown;
      try {
        const runtime = await createProductionRuntime({
          workspaceRoot: workspace,
          plan,
          mode: "production",
          binaryPath: claude.canonicalPath,
          executableAllowlists: {
            "claude-code": [
              { absolutePath: claude.canonicalPath, sha256: claude.sha256 },
            ],
          },
        });
        await runtime.dispose();
      } catch (caught) {
        error = caught;
      }
      expect(error, models.join(",")).toBeInstanceOf(Error);
      expect((error as Error).message, models.join(",")).toContain(
        "the antigravity backend (agy: models) is not available yet",
      );
    }
  });
});
