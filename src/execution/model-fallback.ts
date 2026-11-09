// Fallback models (odd/tasks/role-model-routing.md S4): a step whose role
// lists several models runs them in order, moving to the next only when the
// PROVIDER failed the one before. Juanma: move "only on a provider error, a
// rate limit, no quota or a timeout, never on a bad answer, and record which
// model actually ran"; and never on context-window, output-limit or
// safety-refusal errors (L6 item 8).
//
// WHY this wraps whole runs and does not live in the harness: the harness
// binds ONE transport, credential projection and spend bucket per run and
// retries only on them. A fallback model may sit on another backend and
// another credential, so each model is its own harness run, with its own
// retries, its own reservations and its own usage.

import type { ModelAttempt, StepResult, StepSpec } from "#review/step-runner";
import { sumUsage } from "../usage";
import type { ResolvedModelRoute } from "./contracts";
import type { FailureCause } from "./failure-policy";
import {
  type NormalizedUsage,
  projectLegacyUsage,
  sumNormalizedUsage,
} from "./usage-normalized";

// The causes that are the provider's, not the model's answer. An allowlist:
// anything not named here stops the step on the model it ran. That keeps a
// bad answer (format_violation), the three L6 item 8 errors (context window,
// output limit, safety refusal), configuration and protocol conformance
// failures, cancellations and unconfirmed settlements from ever spending on
// another model, and it makes a cause added later stop by default.
const PROVIDER_FAILURES: ReadonlySet<FailureCause> = new Set([
  "rate_limit",
  "quota_exhausted",
  "network_transient",
  "protocol_truncation",
  "watchdog_timeout",
  "model_unavailable",
]);

// What a failed model's cause means for the rest of the list.
//   next             run the next model;
//   next_credential  the login was refused: skip every model on the same
//                    credential, then run the next one on another;
//   stop             the step ends on this model.
export type FallbackMove = "next" | "next_credential" | "stop";

export function fallbackMove(cause: FailureCause | undefined): FallbackMove {
  if (cause === undefined) return "stop";
  if (cause === "auth_invalid") return "next_credential";
  return PROVIDER_FAILURES.has(cause) ? "next" : "stop";
}

// The route of the model that ran: the last one not skipped. A model that
// never reached its provider is recorded `skipped`, so it is never named here.
// Undefined for a step with one model, whose route is the step's own, and for
// a list none of whose models reached a provider.
export function ranRoute(
  result: Pick<StepResult, "modelAttempts">,
): ResolvedModelRoute | undefined {
  return result.modelAttempts?.findLast((entry) => entry.status !== "skipped")
    ?.route;
}

export interface RunWithFallbackInput {
  readonly step: StepSpec;
  // Runs the step on exactly one route (`step.route`), with its retries.
  readonly runOn: (step: StepSpec) => Promise<StepResult>;
  // The credential a route runs on, as an opaque identity: two routes with the
  // same value share a login. Undefined when the route has no binding.
  readonly credentialOf: (route: ResolvedModelRoute) => string | undefined;
  // True once the run is cancelled: no further model starts.
  readonly cancelled: () => boolean;
}

export async function runWithFallback(
  input: RunWithFallbackInput,
): Promise<StepResult> {
  const { step } = input;
  const fallbacks = step.fallbackRoutes ?? [];
  // A step with one model runs exactly as it did before fallbacks existed:
  // the same call, the same result, nothing added to it.
  if (step.route === undefined || fallbacks.length === 0) {
    return input.runOn(step);
  }

  const candidates = [step.route, ...fallbacks];
  const modelAttempts: ModelAttempt[] = [];
  const results: StepResult[] = [];
  const refusedCredentials = new Set<string>();
  let attemptsSoFar = 0;

  for (const [index, route] of candidates.entries()) {
    if (index > 0 && input.cancelled()) break;
    const credential = input.credentialOf(route);
    if (credential !== undefined && refusedCredentials.has(credential)) {
      modelAttempts.push({
        route,
        status: "skipped",
        attempts: 0,
        cause: "auth_invalid",
      });
      continue;
    }
    const { fallbackRoutes: _list, routeKey: _key, ...single } = step;
    const result = await input.runOn({
      ...single,
      route,
      // The first model keeps the caller's frozen route key; a fallback is
      // matched to its own binding by route.
      ...(index === 0 && step.routeKey !== undefined
        ? { routeKey: step.routeKey }
        : {}),
      ...(attemptsSoFar === 0 ? {} : { attemptOffset: attemptsSoFar }),
      // A fallback's request names its own model (attempt evidence records
      // it beside the route); the first keeps the caller's.
      ...(index === 0 ? {} : { model: route.modelSnapshot || step.model }),
    });
    const reached = reachedAttempts(result);
    attemptsSoFar += reached;
    results.push(result);
    if (reached === 0) {
      // Never reached its provider: not the model that ran, and not the one
      // whose outcome the step reports.
      modelAttempts.push({ route, status: "skipped", attempts: 0 });
      // A fenced bucket refuses every model on it at no cost, and another
      // credential may still run. Anything else that stops a model before
      // its first request is not the provider's, so it stops the step.
      if (result.spendFenced === true) continue;
      break;
    }
    modelAttempts.push({
      route,
      status: result.status,
      attempts: reached,
      ...(result.status === "ok" || result.finalCause === undefined
        ? {}
        : { cause: result.finalCause }),
      ...(result.usageV2 === undefined ? {} : { usageV2: result.usageV2 }),
    });
    if (result.status === "ok") break;
    const move = fallbackMove(result.finalCause);
    if (move === "stop") break;
    if (move === "next_credential") {
      // Without a credential identity the refusal cannot be scoped, so it
      // stops rather than spend another try on what may be the same login.
      if (credential === undefined) break;
      refusedCredentials.add(credential);
    }
  }

  return mergeResults(results, modelAttempts, attemptsSoFar);
}

// The attempts of one model's run that reached its provider. An attempt
// refused by a fenced bucket is always the run's last (the harness stops on
// it), never reached the provider and wrote no file, so it takes no number:
// the next model's attempts follow the ones that did run.
function reachedAttempts(result: StepResult): number {
  return result.attempts - (result.spendFenced === true ? 1 : 0);
}

// The step's one result: the outcome of the last model that reached its
// provider (or the last model, when none did), with what every model spent.
// Usage and reservations are summed, never replaced, because a failed
// model's attempts still cost what they cost. Why each later model did not
// run is kept in the tail, after the reported model's own.
function mergeResults(
  results: readonly StepResult[],
  modelAttempts: ModelAttempt[],
  attempts: number,
): StepResult {
  // The first model is always handed to `runOn` (a skip needs a refused
  // login before it), so `results` is never empty.
  const ranIndex = results.findLastIndex(
    (result) => reachedAttempts(result) > 0,
  );
  const reported = ranIndex === -1 ? results.length - 1 : ranIndex;
  // biome-ignore lint/style/noNonNullAssertion: results is never empty (above)
  const last = results[reported]!;
  const notRun = results
    .slice(reported + 1)
    .map((result) => result.stderrTail.trim())
    .filter((tail) => tail.length > 0);
  let usageV2: NormalizedUsage | undefined;
  for (const result of results) {
    if (result.usageV2 === undefined) continue;
    usageV2 =
      usageV2 === undefined
        ? result.usageV2
        : sumNormalizedUsage(usageV2, result.usageV2);
  }
  const reservations = results.flatMap((result) => result.reservations ?? []);
  const {
    usageV2: _lastUsage,
    reservations: _lastReservations,
    spendFenced: _lastFenced,
    ...outcome
  } = last;
  return {
    ...outcome,
    ...(notRun.length === 0
      ? {}
      : {
          stderrTail: [outcome.stderrTail, ...notRun]
            .filter((tail) => tail.length > 0)
            .join("\n"),
        }),
    // The legacy shape is projected from the normalized one whenever any
    // model reported it, exactly as the harness projects its own attempts.
    usage:
      usageV2 !== undefined
        ? projectLegacyUsage(usageV2)
        : results.map((result) => result.usage).reduce(sumUsage),
    ...(usageV2 === undefined ? {} : { usageV2 }),
    ...(reservations.length === 0 ? {} : { reservations }),
    attempts,
    modelAttempts,
  };
}
