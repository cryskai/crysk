import { describe, expect, test } from "bun:test";
import { buildResolvedRoutePlan } from "#model/routing";
import { validateReviewSpec } from "#review/spec";
import { requireInternalFindingsCapability } from "../../src/diversity/admission";
import { buildDiversityPlan } from "../../src/diversity/identity";
import {
  assertSameRepositoryRoot,
  parseGhPrViewArgv,
  resolveGitRepositoryRoot,
  validateFrozenExternalTarget,
  validateGhPrViewPayload,
} from "../../src/diversity/target-validation";
import { createPanelState } from "../../src/progress";

describe("route and progress integration", () => {
  const spec = validateReviewSpec({
    multiModelDiversity: {
      enabled: true,
      armId: "bench",
      maxLegs: 2,
    },
    agents: [
      {
        key: "reliability",
        file: "deep-review-reliability.md",
        role: "hunter",
        models: ["sonnet", "opus"],
      },
      { key: "refuter", file: "review-refuter.md", role: "refuter" },
    ],
  });

  test("admitted legs map to distinct route step keys and progress hunter rows", () => {
    requireInternalFindingsCapability();
    const plan = buildDiversityPlan({
      spec,
      c2SchemaVersion: "1.1.0",
      target: {
        repoId: "/tmp/musive",
        pr: 42,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
    });
    const routePlan = buildResolvedRoutePlan({
      agents: plan.legs.map((leg) => ({
        key: leg.agentKey,
        role: "hunter",
        model: leg.logicalModel,
      })),
    });
    expect(routePlan.steps.length).toBeGreaterThanOrEqual(2);
    const panel = createPanelState(
      "pr-hero review",
      Date.now(),
      plan.legs.map((leg) => leg.agentKey),
    );
    expect(panel.hunters).toHaveLength(2);
    expect(new Set(panel.hunters.map((row) => row.key)).size).toBe(2);
  });

  test("argv-only git selectors resolve one repository root", () => {
    const roots = [
      resolveGitRepositoryRoot("/tmp/repo-a", "/tmp/work"),
      resolveGitRepositoryRoot(["git", "-C", "/tmp/repo-a"], "/tmp/work"),
    ];
    expect(assertSameRepositoryRoot(roots, "git selector")).toBe("/tmp/repo-a");
  });

  test("gh pr view argv rejects composed commands and extra flags", () => {
    expect(() =>
      parseGhPrViewArgv([
        "gh",
        "pr",
        "view",
        "42",
        "--repo",
        "org/repo",
        "--json",
        "number,baseRefOid,headRefOid",
      ]),
    ).not.toThrow();
    expect(() =>
      parseGhPrViewArgv(["gh", "pr", "view", "42", "--state", "OPEN"]),
    ).toThrow(/not allowed/);
    expect(() =>
      parseGhPrViewArgv(["gh", "pr", "view", "42 && echo pwned"]),
    ).toThrow(/composed shell command/);
  });

  test("frozen external target rejects head/base drift", () => {
    const frozen = {
      repoId: "/tmp/repo",
      pr: 7,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    };
    expect(() =>
      validateFrozenExternalTarget(frozen, {
        ...frozen,
        headSha: "c".repeat(40),
      }),
    ).toThrow(/headSha drift/);
    expect(() =>
      validateGhPrViewPayload(
        {
          number: 7,
          baseRefOid: frozen.baseSha,
          headRefOid: frozen.headSha,
        },
        frozen,
      ),
    ).not.toThrow();
  });
});
