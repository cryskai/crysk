// Slice-3 live micro-eval (plan §Evals): one REAL step run, through the route
// seam onto the production runner (the Claude Code CLI on sonnet), with a
// trivial StepSpec. Proves the actual spawn path, JSON envelope parsing and
// usage capture outside the fake — costs cents. Run: bun run scripts/live-micro-eval.ts
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultEffortForRole } from "#model/catalog";
import {
  prepareSingleStepRunner,
  routeIdentityFields,
  singleStepRoute,
} from "../src/harness/single-step";
import { resolveRunClaudeCredential } from "../src/security/claude-credential";

const dir = mkdtempSync(path.join(tmpdir(), "pr-hero-micro-eval-"));
const systemPromptPath = path.join(dir, "system.md");
writeFileSync(
  systemPromptPath,
  "When asked for output, reply with exactly this JSON object and nothing " +
    'else: {"findings":[]}',
);
// The transport's prompt-integrity check refuses a system prompt that is not
// mode 600 and never spawns (the pipeline chmods its own the same way). Without
// this the probe reported `failed` from a denial, not from the real CLI.
chmodSync(systemPromptPath, 0o600);
const mcpConfigPath = path.join(dir, "mcp.json");
writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

// The model this probe has always measured, as an explicit choice on the route
// seam (src/harness/single-step.ts): `claude:sonnet-latest`, as a harness-only
// step. Prepared as a review prepares it: the run's Claude credential,
// production admission.
const MODEL = "sonnet";
const route = singleStepRoute({ key: "micro-eval" }, MODEL);
const runner = await prepareSingleStepRunner({
  workspaceRoot: dir,
  route,
  claudeRun: resolveRunClaudeCredential({}),
});
const started = performance.now();
const result = await runner.run({
  name: "micro-eval",
  systemPromptPath,
  prompt: "Produce your output now.",
  tools: ["Read"],
  mcpConfigPath,
  model: MODEL,
  // Explicit, like every step: the transport refuses a request without one.
  effort: defaultEffortForRole("other"),
  cwd: dir,
  outPath: path.join(dir, "out.json"),
  timeoutMs: 5 * 60 * 1000,
  maxAttempts: 2,
  parse: (finalText) => {
    const parsed: unknown = JSON.parse(finalText.trim());
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { findings?: unknown }).findings)
    ) {
      throw new Error("not the mandated {findings:[]} shape");
    }
    return parsed;
  },
});
// A throw above exits the process, which ends the runtime with it.
await runner.dispose();

const wallMs = Math.round(performance.now() - started);
console.log(
  JSON.stringify(
    {
      mode: "trivial",
      model: MODEL,
      ...routeIdentityFields(route.identity),
      status: result.status,
      attempts: result.attempts,
      output: result.output,
      usage: result.usage,
      wall_ms: wallMs,
      run_dir: dir,
    },
    null,
    2,
  ),
);
if (result.status !== "ok") process.exit(1);
