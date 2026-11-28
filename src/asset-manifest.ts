/// <reference path="./assets.d.ts" />

// Authoritative asset manifest for pr-hero.
// Every packaged asset is imported using `with { type: "file" }` so Bun's compiler embeds them.
// compile.assets is a silent no-op on Bun 1.3.14 — this manifest is the permanent mechanism.

import consolidatePrompt from "../prompts/consolidate.md" with { type: "file" };
import generalPrompt from "../prompts/default/deep-review-general.md" with {
  type: "file",
};
import refuterPrompt from "../prompts/default/review-refuter.md" with {
  type: "file",
};
import materialityPrompt from "../prompts/materiality.md" with { type: "file" };
import summarizerPrompt from "../prompts/summarizer.md" with { type: "file" };
import verifierPrompt from "../prompts/verifier.md" with { type: "file" };
import generalPlaybook from "../skill-content/crysk/playbook.md" with {
  type: "file",
};
import ciSetupWorkflow from "../skill-content/crysk-ci-setup/assets/workflow.yml" with {
  type: "file",
};
import ciSetupPlaybook from "../skill-content/crysk-ci-setup/playbook.md" with {
  type: "file",
};
import ciSetupAdmissionRef from "../skill-content/crysk-ci-setup/references/ci-admission.md" with {
  type: "file",
};
import ciSetupOperationsRef from "../skill-content/crysk-ci-setup/references/ci-operations.md" with {
  type: "file",
};
import ciSetupOpenCodeRef from "../skill-content/crysk-ci-setup/references/opencode-ci.md" with {
  type: "file",
};
import triageAdjudicator from "../skill-content/crysk-loop/adjudicator.md" with {
  type: "file",
};
import triageDismissal from "../skill-content/crysk-loop/dismissal.md" with {
  type: "file",
};
import triageFixTheClass from "../skill-content/crysk-loop/fix-the-class.md" with {
  type: "file",
};
import triageGateRules from "../skill-content/crysk-loop/gate-rules.md" with {
  type: "file",
};
import triagePlaybook from "../skill-content/crysk-loop/playbook.md" with {
  type: "file",
};
import prPlaybook from "../skill-content/crysk-pr/playbook.md" with {
  type: "file",
};
import generalSkill from "../skills/crysk/SKILL.md" with { type: "file" };
import ciSetupSkill from "../skills/crysk-ci-setup/SKILL.md" with {
  type: "file",
};
import triageSkill from "../skills/crysk-loop/SKILL.md" with { type: "file" };
import prSkill from "../skills/crysk-pr/SKILL.md" with { type: "file" };

export const BUNDLED_AGENT_FILES: Record<string, string> = {
  "deep-review-general.md": generalPrompt,
  "review-refuter.md": refuterPrompt,
};

// Model-profile prompt sets (odd/tasks/model-profiles.md S4): set name ->
// logical filename -> path, read from `prompts/profiles/<set>/<file>`. A set
// holds only the files that differ from the default set; every other file
// falls back to it (profilePromptSet, src/review/prompt-set.ts). Bun embeds
// only what is imported, so each override needs its own `with { type: "file" }`
// import above and an entry here; test/assets.test.ts checks this map against
// the disk. No profile ships a set yet.
export const PROFILE_PROMPT_FILES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {};

export const CONSOLIDATE_PROMPT_PATH = consolidatePrompt;
export const MATERIALITY_PROMPT_PATH = materialityPrompt;
export const SUMMARIZER_PROMPT_PATH = summarizerPrompt;
export const VERIFIER_PROMPT_PATH = verifierPrompt;

export const TRIAGE_SKILL_FILES: Record<string, string> = {
  "SKILL.md": triageSkill,
  "playbook.md": triagePlaybook,
  "adjudicator.md": triageAdjudicator,
  "dismissal.md": triageDismissal,
  "fix-the-class.md": triageFixTheClass,
  "gate-rules.md": triageGateRules,
};

export const CI_SETUP_SKILL_FILES: Record<string, string> = {
  "SKILL.md": ciSetupSkill,
  "playbook.md": ciSetupPlaybook,
  "assets/workflow.yml": ciSetupWorkflow,
  "references/ci-admission.md": ciSetupAdmissionRef,
  "references/ci-operations.md": ciSetupOperationsRef,
  "references/opencode-ci.md": ciSetupOpenCodeRef,
};

export const PR_SKILL_FILES: Record<string, string> = {
  "SKILL.md": prSkill,
  "playbook.md": prPlaybook,
};

export const GENERAL_SKILL_FILES: Record<string, string> = {
  "SKILL.md": generalSkill,
  "playbook.md": generalPlaybook,
};
