// smoke is the review-free scenario: one planted-bug PR through the free route,
// end to end, then cleanup. It stays a command of its own because the SB1 runs
// use it. The behaviour is the generic runner's (scenario.ts), not a second copy.

import type { SandboxDeps } from "./ports";
import { type RunOptions, runScenarios } from "./scenario";

export function runSmoke(
  input: SandboxDeps,
  options: RunOptions,
): Promise<number> {
  return runScenarios(input, ["review-free"], options);
}
