// Pipeline-as-data: the review DAG is a validated TS literal, convoy-style —
// creating, removing, or re-wiring subagents is a config change, never an
// engine edit. The engine consumes a ReviewSpec; defaultReviewSpec() encodes
// EXACTLY the wiring the engine used to hard-code (prose Step 4), so a caller
// that passes nothing gets byte-identical behavior.

import { modelNameFromAlias } from "#model/model-name";

const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A conditional hunter's trigger. `string[]` is a glob/contains pattern list
// matched against the diff's changed paths with the same parityTriggered
// semantics the parity hunter always used. The `"input"` sentinel means "use
// PipelineInput.parityTriggerPaths" — the trigger PATHS stay lab config
// (deep-review.config.json), only the WIRING ("parity is conditional") lives
// in the spec. Chosen over a second optional field because a union keeps
// "has a trigger" a single presence check.
export type AgentTrigger = string[] | "input";

export interface AgentSpec {
  // Stable id: becomes the per_agent telemetry key and the step-name suffix
  // ("hunter-<key>"; the single refuter step keeps the fixed name "refuter").
  key: string;
  // Semantic specialty stamped into finding.hunter. Defaults to key when
  // omitted — the execution identity and the specialty diverge only when D3
  // fans multiple model legs at the same specialty.
  specialty?: string;
  // Agent .md basename inside agentsDir, e.g. "deep-review-reliability.md".
  file: string;
  role: "hunter" | "refuter";
  // Hunters only. Omitted → the hunter always runs. Present → it runs only
  // when any changed path matches (see AgentTrigger).
  trigger?: AgentTrigger;
  // Per-agent model override. Precedence for every step:
  // input.model (CLI --model) > spec.model > agent frontmatter model.
  model?: string;
  // D3 fan-out: when multiModelDiversity.enabled, each model becomes a leg.
  models?: readonly string[];
}

export interface MultiModelDiversityConfig {
  readonly enabled: true;
  readonly armId: string;
  readonly maxLegs: number;
  readonly cashCapUsd: number;
}

export interface ReviewSpec {
  agents: AgentSpec[];
  multiModelDiversity?: MultiModelDiversityConfig;
}

export function isSafeSlug(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && SAFE_SLUG_RE.test(value);
}

export function resolveSpecialty(agent: AgentSpec): string {
  return agent.specialty ?? agent.key;
}

export class ReviewSpecValidationError extends Error {}

function must(condition: boolean, message: string): void {
  if (!condition) throw new ReviewSpecValidationError(message);
}

export function validateReviewSpec(candidate: unknown): ReviewSpec {
  must(
    typeof candidate === "object" && candidate !== null,
    "review spec must be an object",
  );
  const spec = candidate as Record<string, unknown>;
  must(Array.isArray(spec.agents), "spec.agents must be an array");
  const diversityEnabled =
    spec.multiModelDiversity !== undefined &&
    typeof spec.multiModelDiversity === "object" &&
    spec.multiModelDiversity !== null &&
    (spec.multiModelDiversity as Record<string, unknown>).enabled === true;
  if (spec.multiModelDiversity !== undefined) {
    const diversity = spec.multiModelDiversity as Record<string, unknown>;
    must(
      diversity.enabled === true,
      "multiModelDiversity.enabled must be true when present",
    );
    must(
      typeof diversity.armId === "string" &&
        isSafeSlug(diversity.armId as string),
      "multiModelDiversity.armId must be a safe slug",
    );
    must(
      typeof diversity.maxLegs === "number" &&
        Number.isInteger(diversity.maxLegs) &&
        (diversity.maxLegs as number) >= 1,
      "multiModelDiversity.maxLegs must be a positive integer",
    );
    must(
      typeof diversity.cashCapUsd === "number" &&
        Number.isFinite(diversity.cashCapUsd) &&
        (diversity.cashCapUsd as number) > 0,
      "multiModelDiversity.cashCapUsd must be a positive number",
    );
  }
  const agents = spec.agents as unknown[];
  const keys = new Set<string>();
  const hunterSpecialties = new Set<string>();
  let hunterCount = 0;
  let refuterCount = 0;
  agents.forEach((entry, i) => {
    must(
      typeof entry === "object" && entry !== null,
      `agents[${i}] must be an object`,
    );
    const a = entry as Record<string, unknown>;
    must(
      typeof a.key === "string" && a.key.length > 0,
      `agents[${i}].key required`,
    );
    must(
      isSafeSlug(a.key as string),
      `agents[${i}].key "${a.key}" is not a safe slug (^[a-z0-9]+(?:-[a-z0-9]+)*$, 1-64 chars)`,
    );
    must(!keys.has(a.key as string), `agents[${i}].key duplicates "${a.key}"`);
    keys.add(a.key as string);
    must(
      a.specialty === undefined ||
        (typeof a.specialty === "string" && isSafeSlug(a.specialty)),
      `agents[${i}].specialty must be a safe slug when present`,
    );
    must(
      typeof a.file === "string" && a.file.length > 0,
      `agents[${i}].file required`,
    );
    must(
      a.role === "hunter" || a.role === "refuter",
      `agents[${i}].role must be hunter|refuter`,
    );
    must(
      a.models === undefined ||
        (diversityEnabled &&
          Array.isArray(a.models) &&
          (a.models as unknown[]).length >= 1 &&
          (a.models as unknown[]).every(
            (model) => typeof model === "string" && model.length > 0,
          )),
      diversityEnabled
        ? `agents[${i}].models must be a non-empty string array when multiModelDiversity is enabled`
        : `agents[${i}].models is not supported in D2; fan-out is a D3 capability`,
    );
    if (diversityEnabled && Array.isArray(a.models)) {
      for (const model of a.models as string[]) {
        try {
          modelNameFromAlias(model);
        } catch (error) {
          must(
            false,
            `agents[${i}].models contains invalid model identity "${model}": ${(error as Error).message}`,
          );
        }
      }
    }
    must(
      a.model === undefined ||
        (typeof a.model === "string" && a.model.length > 0),
      `agents[${i}].model must be a non-empty string when present`,
    );
    if (a.model !== undefined) {
      try {
        modelNameFromAlias(a.model as string);
      } catch (error) {
        must(
          false,
          `agents[${i}].model "${a.model}" is not a valid model identity: ${(error as Error).message}`,
        );
      }
    }
    if (a.role === "hunter") {
      hunterCount++;
      const specialty =
        a.specialty === undefined ? (a.key as string) : (a.specialty as string);
      if (!diversityEnabled || a.models === undefined) {
        must(
          !hunterSpecialties.has(specialty),
          `agents[${i}] specialty "${specialty}" duplicates another hunter's effective specialty`,
        );
        hunterSpecialties.add(specialty);
      }
      must(
        a.trigger === undefined ||
          a.trigger === "input" ||
          (Array.isArray(a.trigger) &&
            (a.trigger as unknown[]).every(
              (p) => typeof p === "string" && p.length > 0,
            )),
        `agents[${i}].trigger must be "input" or a string array`,
      );
    } else {
      refuterCount++;
      must(
        a.specialty === undefined,
        `agents[${i}] is a refuter and cannot carry a specialty`,
      );
      must(
        a.trigger === undefined,
        `agents[${i}] is a refuter and cannot carry a trigger`,
      );
    }
  });
  must(hunterCount >= 1, "spec needs at least one hunter");
  must(refuterCount <= 1, "spec allows at most one refuter");
  return spec as unknown as ReviewSpec;
}

// EXACTLY today's hard-coded wiring (prose Step 4): reliability + resilience
// unconditional, parity conditional on the lab's parityTriggerPaths (the
// "input" sentinel), one refuter. runPipeline without an explicit spec uses
// this, which is what keeps the default engine behavior byte-stable.
export function defaultReviewSpec(): ReviewSpec {
  return {
    agents: [
      {
        key: "reliability",
        file: "deep-review-reliability.md",
        role: "hunter",
      },
      { key: "resilience", file: "deep-review-resilience.md", role: "hunter" },
      {
        key: "parity",
        file: "deep-review-parity.md",
        role: "hunter",
        trigger: "input",
      },
      { key: "refuter", file: "review-refuter.md", role: "refuter" },
    ],
  };
}
