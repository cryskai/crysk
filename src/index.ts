// pr-hero — a multi-agent PR-review engine (hunters → dedupe → refuter → tier).
// Public API surface; the deep-review lab consumes exactly these exports.

export const ENGINE_NAME = "pr-hero";
export const ENGINE_VERSION = "0.3.0";

// errors and git/refs used to reach this surface only through re-exports in
// review/preflight.ts; they are exported directly now that those re-exports
// are gone, so the published symbol set is unchanged.
export * from "./errors";
// attemptLogPath/settlementReceiptPath/attemptEvidencePath/FORMAT_RETRY_REMINDER,
// classifyFailure/isTransientSessionFailure/isTerminalSessionFailure/FailureClass,
// and SpawnedProcess/ACTIVE_CHILD_PROCS/killAllChildProcesses moved out of
// review/step-runner.ts into these three leaves (architecture guard C2); exported
// directly now that step-runner.ts no longer re-exports them, so the published
// symbol set is unchanged.
export * from "./execution/failure-classification";
export * from "./execution/spawned-process";
export * from "./execution/step-artifacts";
export * from "./git/refs";
export * from "./model/routing";
export * from "./review/dedupe";
export * from "./review/drafts";
export * from "./review/findings";
export * from "./review/findings-conformance";
export * from "./review/pipeline";
export * from "./review/preflight";
export * from "./review/prompt-set";
export * from "./review/report";
export * from "./review/root-cause";
export * from "./review/spec";
export * from "./review/step-runner";
export * from "./transport-registry";
export * from "./usage";
