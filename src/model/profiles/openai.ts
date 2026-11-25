import type { ModelProfile } from "../profiles";

// The `openai` profile: every step on OpenAI models through OpenCode, the same
// parallel hunters `claude` runs. Juanma's approved table (odd/tasks/
// openai-profile.md S2, "Asi si"): Sol for the refuter (6.2 since 2026-11-22), Terra for the hunters,
// consolidate and judge, Luna for the summary. Since the general hunter became
// the product's only one (2026-11-26) it runs Sol 6.2 instead (`hunters` below).
//
// An effort becomes the OpenCode variant (OpenAI's Responses variants run
// none..max). A role with no effort sends no variant, so it runs at the
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
      model: "opencode:openai/gpt-6.2-sol",
      effort: "high",
    }),
    consolidate: Object.freeze({
      model: "opencode:openai/gpt-6.1-terra",
      effort: "high",
    }),
    summary: Object.freeze({ model: "opencode:openai/gpt-6-luna" }),
    judge: Object.freeze({ model: "opencode:openai/gpt-6.1-terra" }),
  }),
  // The general hunter runs Sol 6.2 at high effort by Juanma's choice, not a
  // measurement: no OpenAI measurement is possible for now. High mirrors the
  // general hunter's Opus at high on the claude profile; the refuter already
  // runs this model at that level. `roles.hunter` (Terra) stays for a hunter
  // the spec adds.
  hunters: Object.freeze({
    general: Object.freeze({
      model: "opencode:openai/gpt-6.2-sol",
      effort: "high",
    }),
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
