// Slice-3 live micro-eval (plan §Evals): one REAL step run, through the route
// seam onto the production runner (the Claude Code CLI on sonnet), with a
// trivial StepSpec. Proves the actual spawn path, JSON envelope parsing and
// usage capture outside the fake — costs cents. Run: bun run scripts/live-micro-eval.ts
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultEffortForRole } from "#model/catalog";
import { selectBoundaryNonce } from "#review/boundary";
import { parseAgentFile } from "#review/prompt-set";
import { scoutPrompt, validateScoutLeads } from "#review/scout";
import {
  prepareSingleStepRunner,
  routeIdentityFields,
  singleStepRoute,
} from "../src/harness/single-step";
import { resolveRunClaudeCredential } from "../src/security/claude-credential";

// `--scout` (ROADMAP-DOORDASH M5, §3.12.8) runs the SCOUT's real spawn shape
// instead of the trivial one: the bundled prompt, the real output contract,
// the real parse — and, the part no offline test can prove, `tools: []`
// reaching a live session. `--tools ""` is asserted at the argv layer
// (step-runner.test.ts), but until this ran, nothing had ever confirmed that
// the CLI on the other side ACCEPTS an empty allow-list rather than treating
// it as "no restriction" or dying. §3.5 mechanism 1 is the guarantee the
// whole design rests on, and it is the one this milestone could most
// embarrassingly have been wrong about.
const scoutMode = Bun.argv.includes("--scout");

const dir = mkdtempSync(path.join(tmpdir(), "pr-hero-micro-eval-"));
const systemPromptPath = path.join(dir, "system.md");
const SCOUT_PROMPT_PATH = path.join(
  import.meta.dir,
  "..",
  "prompts",
  "scout.md",
);
// A diff whose defect is visible without opening a file — the scout cannot
// open one, and a probe that needed it would be measuring the wrong thing.
const MICRO_PATCH = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -10,7 +10,7 @@ export function total(items: Item[]): number {",
  "   let sum = 0;",
  "-  for (const item of items) {",
  "-    sum += item.price * item.qty;",
  "+  for (let i = 0; i <= items.length; i++) {",
  "+    sum += items[i].price * items[i].qty;",
  "   }",
  "   return sum;",
  " }",
  "",
].join("\n");

if (scoutMode) {
  writeFileSync(
    systemPromptPath,
    (await parseAgentFile(SCOUT_PROMPT_PATH)).body,
  );
} else {
  writeFileSync(
    systemPromptPath,
    "When asked for output, reply with exactly this JSON object and nothing " +
      'else: {"findings":[]}',
  );
}
// The transport's prompt-integrity check refuses a system prompt that is not
// mode 600 and never spawns (the pipeline chmods its own the same way). Without
// this the probe reported `failed` from a denial, not from the real CLI.
chmodSync(systemPromptPath, 0o600);
const mcpConfigPath = path.join(dir, "mcp.json");
writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));

// The model this probe has always measured, as an explicit choice on the route
// seam (src/harness/single-step.ts): `claude:sonnet-latest`, the scout's own
// step in --scout mode and a harness-only step otherwise. Prepared as a review
// prepares it: the run's Claude credential, production admission.
const MODEL = "sonnet";
const route = singleStepRoute(
  scoutMode ? "scout" : { key: "micro-eval" },
  MODEL,
);
const runner = await prepareSingleStepRunner({
  workspaceRoot: dir,
  route,
  claudeRun: resolveRunClaudeCredential({}),
});
const started = performance.now();
const result = await runner.run({
  name: scoutMode ? "scout" : "micro-eval",
  systemPromptPath,
  prompt: scoutMode
    ? scoutPrompt(MICRO_PATCH, selectBoundaryNonce([MICRO_PATCH]))
    : "Produce your output now.",
  // The load-bearing difference. Empty, not omitted.
  tools: scoutMode ? [] : ["Read"],
  mcpConfigPath,
  model: MODEL,
  // Explicit, like every step: the transport refuses a request without one.
  effort: defaultEffortForRole(scoutMode ? "scout" : "other"),
  cwd: dir,
  outPath: path.join(dir, "out.json"),
  timeoutMs: scoutMode ? 15 * 60 * 1000 : 5 * 60 * 1000,
  maxAttempts: scoutMode ? 1 : 2,
  parse: (finalText) => {
    if (scoutMode) {
      const parsed: unknown = JSON.parse(finalText.trim());
      return validateScoutLeads(parsed);
    }
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
      mode: scoutMode ? "scout" : "trivial",
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
