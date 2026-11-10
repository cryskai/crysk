// The CLI's error classifier for cli.json (odd/tasks/agent-first-ci.md, T2c). It maps
// a thrown error to a class by instanceof, or by the class the throw site named on
// the error (T2d-1: CliError.cls, or a record class beside a plain error), which wins.
// A message is never parsed, so a wording change cannot move an error to another owner.
//
// Each mapping is justified by the throw site and by the catalog text of its code
// (src/ci/outcome.ts ERROR_CATALOG):
// - No route class: the alias-keyed routing and its codes were removed
//   (odd/tasks/role-model-routing.md S2, E-f F0). A model is now a name that parses
//   or a usage error that says how to write it.
// - OpenCodeVersionAdmissionError (src/transport-registry.ts) with reason "version"
//   -> capability/version_unsupported: the pinned version-pair checks
//   (admitOpenCodeVersionPair, loadOpenCodeSdk); CRYSK-RUNTIME-UNAVAILABLE calls the
//   action-installed runtime a pr-hero defect, which the pinned version is.
// - The same class with reason "identity" -> unknown: the observed identity is missing
//   in production, or the declared versions contradict it (transport-registry.ts). That
//   is not a version mismatch, and nothing here can name its owner, so the record does
//   not guess one.
// - OpenCodeSdkUnavailableError (src/transports/opencode-admission.ts) -> capability/
//   sdk_unavailable: "is not installed"; the same code, the local text says reconcile.
//
// - CredentialRefusalError (src/security/claude-credential.ts) names its own class
//   (CliError.cls): a Claude route with no credential -> trigger/no-credential
//   (CRYSK-CRED-MISSING), an OpenCode route with no auth record -> credential/
//   missing_provider_record or missing_subscription_record (CRYSK-CRED-UNUSABLE). Its
//   params (cliErrorParams below) let the record name the route and its fixes.
//
// Not mapped, on purpose: ModelRoutingError and InvalidModelError (their message is
// the fix, and no catalog text names it),
// RouteAdmissionError and OpenCodeProductionGatedError (a readiness gate, which no
// capability issue names), CliError and everything else.
//
// This module imports runtime classes from the repo, unlike outcome.ts and
// trigger.ts: it is imported only by the CLI, after the install, never by a step
// that runs before it.

import { CliError, CliUsageError, recordClassOf } from "../errors";
import { CredentialRefusalError } from "../security/claude-credential";
import { OpenCodeVersionAdmissionError } from "../transport-registry";
import { OpenCodeSdkUnavailableError } from "../transports/opencode-admission";
import type { CliErrorClass, ErrorParams } from "./outcome";

export function classifyCliError(error: unknown): CliErrorClass {
  // The class the throw site named wins over the instanceof mapping below. WHY: the
  // parser or the step that threw knows its failure, and no class of its type can.
  const named = recordClassOf(error);
  if (named !== undefined) return named;
  if (
    (error instanceof CliError || error instanceof CliUsageError) &&
    error.cls !== undefined
  ) {
    return error.cls;
  }
  if (error instanceof OpenCodeVersionAdmissionError) {
    return error.reason === "identity"
      ? { kind: "unknown" }
      : { kind: "capability", issue: "version_unsupported" };
  }
  if (error instanceof OpenCodeSdkUnavailableError) {
    return { kind: "capability", issue: "sdk_unavailable" };
  }
  return { kind: "unknown" };
}

// The params a throw site named for the record, or undefined. Only a credential
// refusal names any today. Provider and model pass the record's own checks
// (safeProviderName, safeModelName) in the writer.
export function cliErrorParams(error: unknown): ErrorParams | undefined {
  return error instanceof CredentialRefusalError ? error.params : undefined;
}
