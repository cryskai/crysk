// The CLI's error classifier for cli.json (odd/tasks/agent-first-ci.md, T2c). It maps
// a thrown error to a class by instanceof alone. A message is never parsed, so a
// wording change cannot move an error to another owner.
//
// Each mapping is justified by the throw site and by the catalog text of its code
// (src/ci/outcome.ts ERROR_CATALOG):
// - UnmappedRouteError (src/model/routing.ts) -> route/unmapped: "No route mapping
//   found" and "supplies no modelSnapshot"; PRH-ROUTE-UNRESOLVABLE's unmapped text
//   asks for a modelSnapshot in PRHERO_ROUTING.
// - AmbiguousMappingError (src/model/routing.ts) -> route/ambiguous: "found N
//   duplicate mappings"; its text asks to remove the duplicate.
// - UnauthorizedRouteError (src/model/routing.ts) -> route/spend-disabled: every
//   throw says "Spend is disabled"; its text asks to enable spend.
// - OpenCodeVersionAdmissionError (src/transport-registry.ts) -> capability/
//   version_unsupported: every throw is a version pair check; PRH-RUNTIME-UNAVAILABLE
//   calls the action-installed runtime a pr-hero defect, which the pinned version is.
// - OpenCodeSdkUnavailableError (src/transports/opencode-admission.ts) -> capability/
//   sdk_unavailable: "is not installed"; the same code, the local text says reconcile.
//
// Not mapped, on purpose: ModelRoutingError (its own throws name no route fault),
// RouteAdmissionError and OpenCodeProductionGatedError (a readiness gate, which no
// capability issue names), CliError and everything else.
//
// This module imports runtime classes from the repo, unlike outcome.ts and
// trigger.ts: it is imported only by the CLI, after the install, never by a step
// that runs before it.

import {
  AmbiguousMappingError,
  UnauthorizedRouteError,
  UnmappedRouteError,
} from "../model/routing";
import { OpenCodeVersionAdmissionError } from "../transport-registry";
import { OpenCodeSdkUnavailableError } from "../transports/opencode-admission";
import type { CliErrorClass } from "./outcome";

export function classifyCliError(error: unknown): CliErrorClass {
  if (error instanceof UnmappedRouteError) {
    return { kind: "route", reason: "unmapped" };
  }
  if (error instanceof AmbiguousMappingError) {
    return { kind: "route", reason: "ambiguous" };
  }
  if (error instanceof UnauthorizedRouteError) {
    return { kind: "route", reason: "spend-disabled" };
  }
  if (error instanceof OpenCodeVersionAdmissionError) {
    return { kind: "capability", issue: "version_unsupported" };
  }
  if (error instanceof OpenCodeSdkUnavailableError) {
    return { kind: "capability", issue: "sdk_unavailable" };
  }
  return { kind: "unknown" };
}
