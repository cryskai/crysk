import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { StepSpec } from "#review/step-runner";
import type {
  ResolvedModelRoute,
  RuntimeBinding,
} from "../execution/contracts";

export const BINDING_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "mcp__codegraph__codegraph_explore",
] as const;

const BINDING_ALLOWED_TOOL_SET = new Set<string>(BINDING_ALLOWED_TOOLS);

export function routesMatch(
  a: ResolvedModelRoute,
  b: ResolvedModelRoute,
): boolean {
  return (
    a.backend === b.backend &&
    a.provider === b.provider &&
    a.modelFamily === b.modelFamily &&
    a.modelSnapshot === b.modelSnapshot &&
    a.modelVariant === b.modelVariant
  );
}

export function validateRouteDrift(
  bindingRoute: ResolvedModelRoute,
  stepRoute: ResolvedModelRoute | undefined,
): string | undefined {
  if (stepRoute === undefined) {
    return undefined;
  }
  if (!routesMatch(bindingRoute, stepRoute)) {
    return "Route drift detected under frozen routeKey; re-probe required before transport execute";
  }
  return undefined;
}

export interface ValidateBindingAdmissionDeps {
  readonly lstatFn?: typeof lstat;
  readonly readFileFn?: typeof readFile;
}

export async function validateBindingAdmission(
  step: StepSpec,
  binding: RuntimeBinding,
  deps: ValidateBindingAdmissionDeps = {},
): Promise<string | undefined> {
  const lstatImpl = deps.lstatFn ?? lstat;
  const readFileImpl = deps.readFileFn ?? readFile;

  for (const tool of step.tools) {
    if (binding.tools.deniedTools.includes(tool)) {
      return `Tool "${tool}" is denied by binding allow-map policy`;
    }
    if (binding.tools.allowMapOnly && !BINDING_ALLOWED_TOOL_SET.has(tool)) {
      return `Tool "${tool}" is not in the allow map`;
    }
    if (tool.startsWith("mcp__") && !tool.startsWith("mcp__codegraph__")) {
      return `MCP tool "${tool}" is not allowed; only codegraph MCP prefix is permitted`;
    }
  }

  if (!binding.mcp.verifiedConfigRequired) {
    return undefined;
  }

  try {
    const stat = await lstatImpl(step.mcpConfigPath);
    if (stat.isSymbolicLink()) {
      return "mcp.json must not be a symlink";
    }
  } catch {
    return `Could not stat mcp.json at ${step.mcpConfigPath}`;
  }

  let content: string;
  try {
    content = await readFileImpl(step.mcpConfigPath, "utf8");
  } catch {
    return `Could not read mcp.json at ${step.mcpConfigPath}`;
  }

  if (binding.mcp.codegraphOnly) {
    try {
      const parsed = JSON.parse(content) as {
        mcpServers?: Record<string, unknown>;
      };
      const serverNames = Object.keys(parsed.mcpServers ?? {});
      if (
        serverNames.length > 0 &&
        (serverNames.length !== 1 || serverNames[0] !== "codegraph")
      ) {
        return "mcp.json may only register the codegraph server";
      }
    } catch {
      return "mcp.json is not valid JSON";
    }
  }

  if (step.mcpConfigSha256 !== undefined) {
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== step.mcpConfigSha256) {
      return "mcp.json content hash mismatch";
    }
  }

  return undefined;
}
