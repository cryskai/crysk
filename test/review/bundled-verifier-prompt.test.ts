// The re-review verifier's body (prompts/verifier.md) and the request the
// engine composes for it (rereview/verify.ts) are one unit: the body may name
// only what that request carries, and both must offer the same verdicts.

import { describe, expect, test } from "bun:test";
import { composeVerifyPrompt } from "#rereview/verify";
import { parseAgentFile } from "#review/prompt-set";
import { enginePromptPath } from "#review/route-preflight";

const body = (await parseAgentFile(enginePromptPath("verifier.md"))).body;
const NONCE = "d0d0cafe";
const request =
  composeVerifyPrompt(
    {
      vId: "V001",
      priorId: "R001",
      sev: "CRITICAL",
      trigger: "applied",
      claim: "a claim",
      locs: ["src/app.ts:10"],
      authorReply: "",
      commentBody: "",
      triageTag: "applied",
      deltaHunks: "",
    },
    NONCE,
  ) ?? "";

describe("the bundled verifier prompt", () => {
  test("anchors the repository's review instructions", () => {
    expect(body.split("{{GOTCHAS}}").length - 1).toBe(1);
    expect(body).not.toContain("{{PRIORS}}");
  });

  test("names the blocks the request carries, and no block it does not", () => {
    for (const tag of ["previous_finding", "triage_tag"]) {
      expect(request).toContain(`<${tag} ${NONCE}>`);
      expect(body).toContain(`\`${tag}\``);
    }
    // Wired in the request's shape but empty in every production run: a body
    // that told the verifier to read them would send it looking for nothing.
    for (const absent of ["author_reply", "comment_body", "patch", "delta"]) {
      expect(body).not.toContain(absent);
    }
  });

  test("offers the request's three verdicts and not the refuter's fourth", () => {
    for (const verdict of ["refuted", "corroborated", "inconclusive"]) {
      expect(body).toContain(`\`${verdict}\``);
      expect(request).toContain(`\`${verdict}\``);
    }
    expect(body).not.toContain("downgraded-latent");
  });

  test("does not describe the refuter's input or name other stages", () => {
    expect(body).not.toContain("BLOCKER");
    expect(body).not.toContain("CRITICAL");
    expect(body.toLowerCase()).not.toContain("hunter");
    expect(body.toLowerCase()).not.toContain("refuter");
  });

  test("declares no model, effort or tools of its own", async () => {
    const parsed = await parseAgentFile(enginePromptPath("verifier.md"));
    expect(parsed.model).toBeUndefined();
    expect(parsed.effort).toBeUndefined();
    expect(parsed.tools).toEqual([]);
  });
});
