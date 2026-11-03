// The materiality judge's one spawn, shared by the exam
// (scripts/materiality-probe.ts) and the noise baseline
// (scripts/noise-baseline.ts), so both measure with the same judge.
//
// Isolation: tools [], empty MCP config, a fresh tmp dir per spawn, opus (the
// hunters run sonnet, so the judge never grades its own model's output).
// Never throws: a failed spawn or parse comes back as `label: null` with the
// error, so one bad claim never discards judgments already paid for.

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
import { ClaudeCodeRunner } from "#review/step-runner";
import { resolveRunnerAuthority } from "../src/runner-authority";

export const JUDGE_MODEL = "opus";

export interface JudgeOutcome {
  label: MaterialityLabel | null;
  reason?: string;
  error?: string;
  cost: number;
}

export async function judgeClaim(input: {
  name: string;
  prTitle: string;
  claim: string;
}): Promise<JudgeOutcome> {
  const tmp = mkdtempSync(path.join(tmpdir(), "materiality-judge-"));
  try {
    const systemPromptPath = path.join(tmp, "system.md");
    const mcpConfigPath = path.join(tmp, "mcp.json");
    writeFileSync(systemPromptPath, JUDGE_SYSTEM);
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    chmodSync(systemPromptPath, 0o600);
    // Re-resolved per spawn: workspaceRoot must name the tmp dir this judge
    // actually runs in.
    const authority = await resolveRunnerAuthority({ workspaceRoot: tmp });
    if (authority.error !== undefined) {
      return {
        label: null,
        error: `execution authority unavailable: ${authority.error}`,
        cost: 0,
      };
    }
    const result = await new ClaudeCodeRunner(authority.runnerOptions).run({
      name: input.name,
      systemPromptPath,
      prompt: renderJudgePrompt(input.prTitle, input.claim),
      tools: [],
      mcpConfigPath,
      model: JUDGE_MODEL,
      effort: defaultEffortForRole("other"),
      cwd: tmp,
      outPath: path.join(tmp, "out.json"),
      timeoutMs: 3 * 60 * 1000,
      maxAttempts: 2,
      parse: parseJudgeVerdict,
    });
    const cost = result.usage.cost_usd_est;
    if (result.status !== "ok" || result.output === undefined) {
      return { label: null, error: result.stderrTail.slice(-300), cost };
    }
    const verdict = result.output as ReturnType<typeof parseJudgeVerdict>;
    return { label: verdict.label, reason: verdict.reason, cost };
  } catch (error) {
    return {
      label: null,
      error: error instanceof Error ? error.message : String(error),
      cost: 0,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
