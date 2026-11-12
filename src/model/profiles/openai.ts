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
// Nothing was measured on these models yet (S10). So no `promptSet` (the
// default prompts) and no `measured`: the judge list is the fallback
// profile's, which holds no OpenAI model, so the materiality judge stands down
// on this profile until a measurement adds Terra (S9). A person can still
// pick a measured judge explicitly with `models.judge`.
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
} satisfies ModelProfile);
