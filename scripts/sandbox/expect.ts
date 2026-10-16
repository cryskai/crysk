// What a scenario phase asserts about its observation. Pure: a check reads one
// Observation and says pass or fail with the fact it saw, so every expectation
// is pinned by a fixture and the report can print each one. The S7 invariants
// are not checks here: the runner applies them to every observation itself.

import { RUN_STEP_NAME } from "./markers";
import { classifyPath, type Observation } from "./observe";

export type Check =
  // `skipped` accepts any documented skip, `skipped:<reason>`.
  | { kind: "path"; accept: readonly string[] }
  | { kind: "outcome"; code: string }
  | { kind: "no-outcome" }
  | { kind: "status"; state: string; descriptionStartsWith?: string }
  | { kind: "report-min"; min: number }
  | { kind: "no-report" }
  | { kind: "run-completed"; event: string }
  // The review step of the observed run itself succeeded. A report and a status
  // on the head can be left by an earlier run, so this is the run's own evidence.
  | { kind: "step-succeeded" };

export interface CheckResult {
  label: string;
  pass: boolean;
  // What was seen, when it was not what the check asked for.
  detail?: string;
  // Set on a failed check whose phase observed `hunters-failed`: the free
  // model's flake, which a re-run is expected to clear.
  cause?: "free-model-hunters-failed";
}

// The label a check is printed under. Exported so the runner can name a check it
// did not assert, in the same words the table would have used.
export function describeCheck(check: Check): string {
  switch (check.kind) {
    case "path":
      return `path is ${check.accept.join(" or ")}`;
    case "outcome":
      return `outcome comment with code ${check.code}`;
    case "no-outcome":
      return "no outcome comment";
    case "status":
      return check.descriptionStartsWith === undefined
        ? `status is ${check.state}`
        : `status is ${check.state}, description starts with ${check.descriptionStartsWith}`;
    case "report-min":
      return `at least ${check.min} report on the head`;
    case "no-report":
      return "no report on the head";
    case "run-completed":
      return `${check.event} run completed`;
    case "step-succeeded":
      return "the run's review step succeeded";
  }
}

function headReports(obs: Observation): number {
  return obs.comments.filter(
    (c) => c.kind === "report" && c.head === obs.headSha,
  ).length;
}

export function evaluateCheck(check: Check, obs: Observation): CheckResult {
  const label = describeCheck(check);
  const pass = (ok: boolean, detail?: string): CheckResult =>
    ok ? { label, pass: true } : { label, pass: false, detail };
  switch (check.kind) {
    case "path": {
      const path = classifyPath(obs);
      const ok = check.accept.some(
        (a) => a === path || (a === "skipped" && path.startsWith("skipped:")),
      );
      return pass(ok, `got ${path}`);
    }
    case "outcome": {
      const codes = obs.comments
        .filter((c) => c.kind === "outcome")
        .map((c) => c.code ?? "no-code");
      return pass(
        codes.includes(check.code),
        codes.length === 0 ? "no outcome comment" : `got ${codes.join(", ")}`,
      );
    }
    case "no-outcome": {
      const codes = obs.comments
        .filter((c) => c.kind === "outcome")
        .map((c) => c.code ?? "no-code");
      return pass(codes.length === 0, `got ${codes.join(", ")}`);
    }
    case "status": {
      const status = obs.status;
      if (status === undefined) return pass(false, "no status on the head");
      const prefixOk =
        check.descriptionStartsWith === undefined ||
        status.description.startsWith(check.descriptionStartsWith);
      return pass(
        status.state === check.state && prefixOk,
        `got ${status.state}: ${status.description}`,
      );
    }
    case "report-min": {
      const n = headReports(obs);
      return pass(n >= check.min, `found ${n}`);
    }
    case "no-report": {
      const n = headReports(obs);
      return pass(n === 0, `found ${n}`);
    }
    case "run-completed": {
      const run = obs.run;
      if (run === undefined) return pass(false, "no run was found");
      const ok = run.event === check.event && run.status === "completed";
      return pass(
        ok,
        `got run ${run.id} ${run.event ?? "no-event"} ${run.status}`,
      );
    }
    case "step-succeeded": {
      const step = obs.run?.steps.find((s) => s.name === RUN_STEP_NAME);
      if (obs.run === undefined) return pass(false, "no run was found");
      return pass(
        step?.conclusion === "success",
        `got ${step?.conclusion ?? "no step"} for ${RUN_STEP_NAME}`,
      );
    }
  }
}

export function evaluateChecks(
  checks: readonly Check[],
  obs: Observation,
): CheckResult[] {
  return checks.map((check) => evaluateCheck(check, obs));
}
