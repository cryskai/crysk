import type { ModelProfile } from "../profiles";

// The `openai` profile: every step on OpenAI models through OpenCode, the same
// parallel hunters `claude` runs. Juanma's approved table (odd/tasks/
// openai-profile.md S2, "Asi si"): Sol for the refuter, Terra for the hunters,
// consolidate, scout and judge, Luna for the summary.
//
// An effort becomes the OpenCode variant (OpenAI's Responses variants are
// none..xhigh). A role with no effort sends no variant, so it runs at the
// provider's default level.
//
// Nothing was measured on these models, and no measurement is planned (S10),
// so no `promptSet` (the default prompts) and no `measured`. The materiality
// judge runs on Terra by Juanma's choice, not a measurement (S9, L8: "yo
// dejaria encendido el juez pero es opcional"). The gate stays opt-in
// (`materiality_gate`, off by default).
export const OPENAI_PROFILE: ModelProfile = Object.freeze({
  id: "openai",
  roles: Object.freeze({
    hunter: Object.freeze({
      model: "opencode:openai/gpt-6.1-terra",
      effort: "xhigh",
    }),
    refuter: Object.freeze({
      model: "opencode:openai/gpt-6.1-sol",
      effort: "high",
    }),
    consolidate: Object.freeze({
      model: "opencode:openai/gpt-6.1-terra",
      effort: "high",
    }),
    scout: Object.freeze({ model: "opencode:openai/gpt-6.1-terra" }),
    summary: Object.freeze({ model: "opencode:openai/gpt-6-luna" }),
    judge: Object.freeze({ model: "opencode:openai/gpt-6.1-terra" }),
  }),
  // Terra first, the judge a plan with no `models.judge` runs. Then the two
  // models the judge was measured on through Claude Code: this profile runs
  // the same default prompts, so `models.judge` may still pick them.
  judgeModels: Object.freeze([
    "opencode:openai/gpt-6.1-terra",
    "claude:sonnet-latest",
    "claude:opus-latest",
  ]),
} satisfies ModelProfile);
