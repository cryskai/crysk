import { describe, expect, test } from "bun:test";
import {
  aliasCanonical,
  allModelAliases,
  defaultEffortForRole,
  EFFORT_LEVELS,
  isEffort,
  lookupAlias,
  MODEL_CATALOG,
  providerCatalog,
} from "#model/catalog";

describe("model catalog", () => {
  test("anthropic aliases match the engine's logical alias set", () => {
    expect([...allModelAliases()].sort()).toEqual([
      "fable",
      "haiku",
      "opus",
      "sonnet",
    ]);
  });

  test("lookupAlias resolves canonical identities from config/models/*.json", () => {
    const sonnet = lookupAlias("sonnet");
    expect(sonnet.provider).toBe("anthropic");
    expect(sonnet.canonical).toBe("anthropic/sonnet");
    expect(sonnet.defaultBackend).toBe("claude-code");

    expect(aliasCanonical("opus")).toBe("anthropic/opus");
    expect(aliasCanonical("haiku")).toBe("anthropic/haiku");
  });

  test("provider catalog is loaded from JSON and frozen at import", () => {
    const anthropic = providerCatalog("anthropic");
    expect(anthropic.provider).toBe("anthropic");
    expect(anthropic.aliases).toEqual(["sonnet", "opus", "haiku", "fable"]);
    expect(Object.isFrozen(MODEL_CATALOG)).toBe(true);
  });
});

describe("engine-owned effort", () => {
  // The CLI's `--effort` vocabulary, closed. Anything else must fail loud at
  // the frontmatter seam, because an unknown level the CLI rejects (or worse,
  // ignores) would silently put a step back on a level nobody chose.
  test("the closed vocabulary is the CLI's five levels", () => {
    expect([...EFFORT_LEVELS]).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    for (const level of EFFORT_LEVELS) expect(isEffort(level)).toBe(true);
  });

  test("isEffort rejects everything outside the vocabulary", () => {
    for (const bad of ["", "HIGH", "Medium", "turbo", "auto", " high"]) {
      expect(isEffort(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  // The refuter is `high`, not `medium`: at medium it deleted a pre-labeled
  // known BLOCKER on real pr-1858 findings in 3 of 4 verdicts (refuter-probe
  // 16/16 at medium had not predicted that). Pinned apart from the "everything
  // else" loop so a future edit to one cannot ride along with the other.
  test("the per-role table: hunter xhigh, refuter high, every other role high", () => {
    expect(defaultEffortForRole("hunter")).toBe("xhigh");
    expect(defaultEffortForRole("refuter")).toBe("high");
    for (const role of ["summarizer", "scout", "verifier", "other"] as const) {
      expect(defaultEffortForRole(role), role).toBe("high");
    }
  });
});
