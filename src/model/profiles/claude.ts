import type { ModelProfile } from "../profiles";

// The `claude` profile: every step on Anthropic models through the Claude Code
// CLI. It is one profile among others; the registry (src/model/profiles.ts)
// also makes it the fallback, which is the only thing that sets it apart.
//
// Exactly what 4898e1b4 runs with no configuration, read off the bundled
// prompts' frontmatter (prompts/default/*.md, consolidate.md, summarizer.md),
// the old DEFAULT_SCOUT_MODEL / DEFAULT_CONSOLIDATE_MODEL /
// DEFAULT_CONSOLIDATE_EFFORT / DEFAULT_SUMMARY_MODEL / MATERIALITY_JUDGE_MODEL
// constants and ROLE_EFFORT (catalog.ts, where the #299 evidence for the
// hunter and refuter levels lives). Pinned by
// test/fixtures/model-profiles/baseline and preflight-bundled-prompts.test.ts.
export const CLAUDE_PROFILE: ModelProfile = Object.freeze({
  id: "claude",
  roles: Object.freeze({
    hunter: Object.freeze({ model: "claude:sonnet-latest", effort: "xhigh" }),
    refuter: Object.freeze({ model: "claude:opus-latest", effort: "high" }),
    consolidate: Object.freeze({
      model: "claude:sonnet-latest",
      effort: "high",
    }),
    scout: Object.freeze({ model: "claude:sonnet-latest", effort: "high" }),
    summary: Object.freeze({ model: "claude:haiku-latest", effort: "high" }),
    judge: Object.freeze({ model: "claude:sonnet-latest", effort: "high" }),
  }),
  // The judge was measured on Claude sonnet and opus through the Claude Code
  // CLI (same bundled prompt, same bar; both passed, lab bench/METRICS.md
  // 2026-11-01); sonnet was chosen because it costs half for a difference
  // within one run's noise.
  measured: Object.freeze({
    judgeModels: Object.freeze(["claude:sonnet-latest", "claude:opus-latest"]),
  }),
} satisfies ModelProfile);
