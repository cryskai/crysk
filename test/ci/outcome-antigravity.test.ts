// odd/tasks/antigravity-oauth.md T3 (S2, S5): a failure on an agy route names
// CRYSK_ANTIGRAVITY_OAUTH and Antigravity's own fix, never a Claude or ChatGPT
// login.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyCliError, cliErrorParams } from "../../src/ci/classify-error";
import { writeFatalCliRecord } from "../../src/ci/cli-record";
import {
  CLI_RECORD_FILE,
  knownFailureCredential,
  parseCliRecord,
  renderCode,
  renderError,
  renderHunterCause,
} from "../../src/ci/outcome";
import { AntigravityCredentialRefusalError } from "../../src/review/route-preflight";
import { oauthSecretName } from "../../src/security/oauth-providers";

const SECRET = "CRYSK_ANTIGRAVITY_OAUTH";
const AGY = {
  backend: "antigravity",
  provider: "google",
  model: "gemini-4-argon-high",
  step: "hunter-logic",
  pr: 7,
  runId: "1",
  runUrl: "https://github.com/o/r/actions/runs/1",
};

function text(rendered: { annotation: string; summary: string[] }): string {
  return `${rendered.annotation}\n${rendered.summary.join("\n")}`;
}

function expectAntigravityFix(rendered: {
  annotation: string;
  summary: string[];
}): void {
  const all = text(rendered);
  expect(rendered.annotation).toContain(SECRET);
  expect(all).toContain(SECRET);
  expect(all).not.toContain("claude setup-token");
  expect(all).not.toContain("ChatGPT");
  expect(all).not.toContain("CRYSK_OPENCODE_OPENAI_OAUTH");
  expect(all).not.toContain("CRYSK_CLAUDE_");
}

describe("CRYSK_ANTIGRAVITY_OAUTH as a failure credential", () => {
  test("is the descriptor's secret name (outcome.ts keeps a builtins-only copy)", () => {
    expect(oauthSecretName("antigravity")).toBe(SECRET);
  });

  test("is a known failure credential", () => {
    expect(knownFailureCredential(SECRET)).toBe(SECRET);
    expect(knownFailureCredential("CRYSK_ANTIGRAVITY_API_KEY")).toBeUndefined();
  });
});

describe("antigravity remediation (S5)", () => {
  test("a missing login names CRYSK_ANTIGRAVITY_OAUTH in CI", () => {
    const rendered = renderError(
      { kind: "credential", failureClass: "missing_subscription_record" },
      { ...AGY, secret: SECRET },
      "action",
    );
    expect(rendered.code).toBe("CRYSK-CRED-UNUSABLE");
    expectAntigravityFix(rendered);
    expect(text(rendered)).toContain("gh secret set CRYSK_ANTIGRAVITY_OAUTH");
  });

  test("a missing login is refused the same way without a secret param", () => {
    expectAntigravityFix(
      renderError(
        { kind: "credential", failureClass: "missing_subscription_record" },
        AGY,
        "action",
      ),
    );
  });

  // The CRYSK-CRED-REJECTED / CRYSK-PROVIDER-LIMITED variants with Antigravity's
  // own fix wait for docs/github-actions.md (docs parity); until then a rejected
  // login still names its secret as it is.
  test("a rejected login names CRYSK_ANTIGRAVITY_OAUTH as its secret", () => {
    const rendered = renderHunterCause("auth_invalid", AGY, "action", {
      credential: SECRET,
    });
    expect(rendered?.code).toBe("CRYSK-CRED-REJECTED");
    expect(rendered?.annotation).toContain(SECRET);
  });

  test("no credential at all on an agy route names the antigravity secret", () => {
    expectAntigravityFix(renderCode("CRYSK-CRED-MISSING", AGY, "action"));
  });
});

describe("the antigravity refusal survives the CLI record (S5)", () => {
  test("classified, written, read back and rendered, it names CRYSK_ANTIGRAVITY_OAUTH", async () => {
    const error = new AntigravityCredentialRefusalError({
      message:
        "models name agy model gemini-4-argon-high (hunter-logic), but no usable CRYSK_ANTIGRAVITY_OAUTH secret reached the run",
      failureClass: "missing_subscription_record",
      params: {
        backend: "antigravity",
        provider: "google",
        model: "gemini-4-argon-high",
        step: "hunter-logic",
        secret: SECRET,
      },
    });
    const cls = classifyCliError(error);
    expect(cls).toEqual({
      kind: "credential",
      failureClass: "missing_subscription_record",
    });
    const dir = await mkdtemp(path.join(tmpdir(), "crysk-agy-record-"));
    try {
      writeFatalCliRecord(
        cls,
        { CRYSK_OUTCOME_DIR: dir },
        cliErrorParams(error),
      );
      const record = parseCliRecord(
        await Bun.file(path.join(dir, CLI_RECORD_FILE)).text(),
      );
      expect(record?.outcome).toBe("error");
      if (record?.outcome !== "error") return;
      expect(record.params?.backend).toBe("antigravity");
      expect(record.params?.secret).toBe(SECRET);
      expect(record.cls).toEqual(cls);
      if (record.cls === undefined) return;
      const rendered = renderError(record.cls, record.params ?? {}, "action");
      expect(rendered.code).toBe("CRYSK-CRED-UNUSABLE");
      expectAntigravityFix(rendered);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
