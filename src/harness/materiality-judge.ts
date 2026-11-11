// The materiality judge's one spawn for the probes (scripts/materiality-spawn.ts,
// shared by the exam, the noise baseline and the lab's judgeClaim), on the
// route seam (odd/tasks/route-plan-harness.md S4). The judge's route comes
// from a plan through the production path, and every outcome records it.
//
// Isolation: tools [], empty MCP config, a fresh tmp dir per spawn, which is
// also the workspace admission names. Opus by default (S6): the hunters run
// sonnet, so the judge never grades its own model's output, and the lab's
// opus-x3 experiment assumes it. Never throws: a refused plan, a failed
// admission, spawn or parse comes back as `label: null` with the error, so one
// bad claim never discards judgments already paid for.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  JUDGE_SYSTEM,
  type MaterialityLabel,
  parseJudgeVerdict,
  renderJudgePrompt,
} from "#compare/materiality";
import { defaultEffortForRole } from "#model/catalog";
import { MATERIALITY_STEP_KEY, type ResolvedRoutePlan } from "#model/routing";
import type { StepRunner } from "#review/step-runner";
import type { ResolvedModelRoute } from "../execution/contracts";
import { resolveRunClaudeCredential } from "../security/claude-credential";
import {
  buildHarnessRoutePlan,
  type HarnessIdentity,
  harnessIdentity,
  prepareHarnessRunner,
  routeStep,
} from "./route-runner";

// A `models.judge` entry, so it must be on the profile's measured list.
export const MATERIALITY_JUDGE_CHOICE = "claude:opus-latest";

export function materialityJudgePlan(
  judge: string = MATERIALITY_JUDGE_CHOICE,
): ResolvedRoutePlan {
  return buildHarnessRoutePlan({
    materiality: true,
    models: { judge: [judge] },
  });
}

// The judge's identity, for a results file's header. Pure: no spawn.
export function materialityJudgeIdentity(
  judge: string = MATERIALITY_JUDGE_CHOICE,
): HarnessIdentity {
  return harnessIdentity(materialityJudgePlan(judge));
}

export interface JudgeOutcome {
  label: MaterialityLabel | null;
  reason?: string;
  error?: string;
  cost: number;
  // The route the judge was planned on, absent only when no plan was built.
  route?: ResolvedModelRoute;
  routeFingerprint?: string;
}

interface PreparedJudge {
  runner: StepRunner;
  dispose(): Promise<void>;
}

export interface MaterialityJudgeOptions {
  judge?: string;
  // Test seam: prepares the runner for the plan in the spawn's workspace.
  prepare?: (
    workspaceRoot: string,
    plan: ResolvedRoutePlan,
  ) => Promise<PreparedJudge>;
}

const prepareLive = (workspaceRoot: string, plan: ResolvedRoutePlan) =>
  prepareHarnessRunner({
    workspaceRoot,
    buildRoutePlan: () => plan,
    claudeRun: resolveRunClaudeCredential({}),
  });

export async function runMaterialityJudge(
  input: { name: string; prTitle: string; claim: string },
  options: MaterialityJudgeOptions = {},
): Promise<JudgeOutcome> {
  let identity: HarnessIdentity | undefined;
  const tmp = mkdtempSync(path.join(tmpdir(), "materiality-judge-"));
  let prepared: PreparedJudge | undefined;
  try {
    const plan = materialityJudgePlan(options.judge);
    identity = harnessIdentity(plan);
    const recorded = {
      route: identity.route,
      routeFingerprint: identity.routeFingerprint,
    };
    const systemPromptPath = path.join(tmp, "system.md");
    const mcpConfigPath = path.join(tmp, "mcp.json");
    writeFileSync(systemPromptPath, JUDGE_SYSTEM);
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    chmodSync(systemPromptPath, 0o600);
    prepared = await (options.prepare ?? prepareLive)(tmp, plan);
    const result = await prepared.runner.run(
      routeStep(plan, MATERIALITY_STEP_KEY, {
        name: input.name,
        systemPromptPath,
        prompt: renderJudgePrompt(input.prTitle, input.claim),
        tools: [],
        mcpConfigPath,
        model: identity.route.modelSnapshot,
        effort: defaultEffortForRole("other"),
        cwd: tmp,
        outPath: path.join(tmp, "out.json"),
        timeoutMs: 3 * 60 * 1000,
        maxAttempts: 2,
        parse: parseJudgeVerdict,
      }),
    );
    const cost = result.usage.cost_usd_est;
    if (result.status !== "ok" || result.output === undefined) {
      return {
        label: null,
        error: result.stderrTail.slice(-300),
        cost,
        ...recorded,
      };
    }
    const verdict = result.output as ReturnType<typeof parseJudgeVerdict>;
    return {
      label: verdict.label,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      cost,
      ...recorded,
    };
  } catch (error) {
    return {
      label: null,
      error: error instanceof Error ? error.message : String(error),
      cost: 0,
      ...(identity === undefined
        ? {}
        : {
            route: identity.route,
            routeFingerprint: identity.routeFingerprint,
          }),
    };
  } finally {
    // The runtime first: it may still hold the workspace it was admitted on.
    await prepared?.dispose().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  }
}
