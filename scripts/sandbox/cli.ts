// Argument parsing and dispatch for the sandbox runner. Pure apart from the deps
// it is given, so --help and usage errors are testable without gh or git.
// Exit codes: 0 success, 1 a failed run or refused operation, 2 a usage error.

import { runInit } from "./init";
import type { SandboxDeps } from "./ports";
import { runClean, runList } from "./pr";
import { SANDBOX_REPO } from "./rails";
import { runScenarios } from "./scenario";
import { findScenario, SCENARIOS, scenarioNames } from "./scenarios";
import { DEFAULT_ROUTE, parseRoute, type Route } from "./seed";
import { runSmoke } from "./smoke";

export const USAGE = `usage: bun scripts/sandbox.ts <command> [options]

  init --ref <ref> [--route claude|opencode:<modelSnapshot>]
                          idempotent: repo, seeded main, pinned workflow, secrets, routing (default route: claude)
  run <scenario...> --ref <ref> [--keep] [--no-retry]
                          run scenarios in order, one PR each; a free-model flake is re-run once; exit 1 on any failed expectation or S7 check
  smoke --ref <ref> [--keep] [--no-retry]
                          alias of \`run review-free\`
  list                    open sandbox/ PRs, then the scenario names
  clean                   close open sandbox/ PRs and delete their branches

scenarios: ${scenarioNames().join(", ")}
<ref> is a tag or branch of juanmaagd/pr-hero, pinned into the sandbox workflow.
--route claude runs reviews on the subscription token (CLAUDE_CODE_OAUTH_TOKEN); opencode:<modelSnapshot> runs them on one OpenCode model.
Only ${SANDBOX_REPO} is ever touched.`;

export type ParsedArgs =
  | { command: "help" }
  | { command: "init"; ref: string; route: Route }
  | { command: "smoke"; ref: string; keep: boolean; noRetry: boolean }
  | {
      command: "run";
      scenarios: string[];
      ref: string;
      keep: boolean;
      noRetry: boolean;
    }
  | { command: "list" }
  | { command: "clean" };

export function parseCliArgs(
  argv: readonly string[],
): ParsedArgs | { error: string } {
  const [command, ...rest] = argv;
  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    return { command: "help" };
  }
  let ref: string | undefined;
  let keep = false;
  let noRetry = false;
  let route: Route = DEFAULT_ROUTE;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (arg === "--ref") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--"))
        return { error: "--ref needs a value" };
      ref = value;
      i += 1;
    } else if (arg === "--route" && command === "init") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--"))
        return {
          error: "--route needs a value: claude or opencode:<modelSnapshot>",
        };
      const parsedRoute = parseRoute(value);
      if ("error" in parsedRoute) return parsedRoute;
      route = parsedRoute.route;
      i += 1;
    } else if (arg === "--keep" && (command === "smoke" || command === "run")) {
      keep = true;
    } else if (
      arg === "--no-retry" &&
      (command === "smoke" || command === "run")
    ) {
      noRetry = true;
    } else if (command === "run" && !arg.startsWith("--") && arg !== "") {
      positional.push(arg);
    } else {
      return { error: `unexpected argument: ${arg}` };
    }
  }
  switch (command) {
    case "init":
      return ref === undefined
        ? { error: "init needs --ref <ref>" }
        : { command, ref, route };
    case "smoke":
      return ref === undefined
        ? { error: "smoke needs --ref <ref>" }
        : { command, ref, keep, noRetry };
    case "run": {
      if (ref === undefined) return { error: "run needs --ref <ref>" };
      if (positional.length === 0) {
        return {
          error: `run needs at least one scenario: ${scenarioNames().join(", ")}`,
        };
      }
      const unknown = positional.filter((n) => findScenario(n) === undefined);
      if (unknown.length > 0) {
        return { error: `unknown scenario: ${unknown.join(", ")}` };
      }
      return { command, scenarios: positional, ref, keep, noRetry };
    }
    case "list":
    case "clean":
      return rest.length === 0
        ? { command }
        : { error: `${command} takes no arguments` };
    default:
      return { error: `unknown command: ${command}` };
  }
}

export async function runCli(
  argv: readonly string[],
  deps: SandboxDeps,
): Promise<number> {
  const parsed = parseCliArgs(argv);
  if ("error" in parsed) {
    deps.log(parsed.error);
    deps.log(USAGE);
    return 2;
  }
  try {
    switch (parsed.command) {
      case "help":
        deps.log(USAGE);
        return 0;
      case "init":
        await runInit(deps, parsed.ref, parsed.route);
        return 0;
      case "smoke":
        return await runSmoke(deps, {
          ref: parsed.ref,
          keep: parsed.keep,
          noRetry: parsed.noRetry,
        });
      case "run":
        return await runScenarios(deps, parsed.scenarios, {
          ref: parsed.ref,
          keep: parsed.keep,
          noRetry: parsed.noRetry,
        });
      case "list": {
        const code = await runList(deps);
        for (const scenario of SCENARIOS) {
          deps.log(`scenario ${scenario.name}: ${scenario.description}`);
        }
        return code;
      }
      case "clean":
        return await runClean(deps);
    }
  } catch (error) {
    deps.log(
      `sandbox: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
