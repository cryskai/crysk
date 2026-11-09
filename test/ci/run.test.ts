// U5 (odd/tasks/role-model-routing.md, S8, L27): the Run Crysk step pipes the
// crysk-secrets input to src/ci/run.ts on stdin, which masks it, hands the Claude
// values to the credential intake and runs the CLI. Assertions are booleans or
// names: no test prints an env or a value.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCiReview } from "#ci/run";
import {
  clearCryskClaudeIntake,
  resolveRunClaudeCredential,
} from "../../src/security/claude-credential";

const MODULE_PATH = path.resolve(import.meta.dir, "../../src/ci/run.ts");

// The platform stub's shape (v3): the Claude pair, an OpenAI subscription record,
// and five OpenCode slots, the unused ones exactly `CRYSK_OPENCODE__API_KEY=`.
const OPENAI_RECORD = Buffer.from(
  JSON.stringify({
    type: "oauth",
    access: "SENTINEL-ACCESS-9d2",
    refresh: "SENTINEL-REFRESH-9d2",
  }),
).toString("base64");
const STUB_INPUT = [
  "CRYSK_CLAUDE_OAUTH_TOKEN=SENTINEL-OAUTH-9d2",
  "CRYSK_CLAUDE_API_KEY=SENTINEL-KEY-9d2",
  `CRYSK_OPENCODE_OPENAI_OAUTH=${OPENAI_RECORD}`,
  "CRYSK_OPENCODE_DEEPSEEK_API_KEY=SENTINEL-DS-9d2",
  "CRYSK_OPENCODE__API_KEY=",
  "CRYSK_OPENCODE__API_KEY=",
  "CRYSK_OPENCODE__API_KEY=",
  "CRYSK_OPENCODE__API_KEY=",
].join("\n");

afterEach(() => {
  clearCryskClaudeIntake();
});

async function review(cryskSecrets: string) {
  let stdout = "";
  const calls: string[][] = [];
  await runCiReview({
    cryskSecrets,
    argv: ["review", "--pr", "7", "--ci", "--yes"],
    stdout: (text) => {
      stdout += text;
    },
    runCli: async (argv) => {
      calls.push(argv);
    },
  });
  return { stdout, calls };
}

describe("runCiReview", () => {
  test("masks every value, then runs the CLI with the step's arguments unchanged", async () => {
    const run = await review(STUB_INPUT);
    const masked = run.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.startsWith("::add-mask::"));
    expect(masked.length).toBeGreaterThan(0);
    expect(masked.every(Boolean)).toBe(true);
    for (const value of [
      "SENTINEL-OAUTH-9d2",
      "SENTINEL-KEY-9d2",
      "SENTINEL-DS-9d2",
      "SENTINEL-ACCESS-9d2",
      "SENTINEL-REFRESH-9d2",
    ]) {
      expect(run.stdout.includes(`::add-mask::${value}\n`), value).toBe(true);
    }
    expect(run.calls).toEqual([["review", "--pr", "7", "--ci", "--yes"]]);
  });

  test("the Claude secrets reach the run's credential choice, in the default order", async () => {
    await review(STUB_INPUT);
    const run = resolveRunClaudeCredential({ loginPresent: false });
    expect(run.kind).toBe("subscription");
    expect(run.env.CLAUDE_CODE_OAUTH_TOKEN === "SENTINEL-OAUTH-9d2").toBe(true);
    expect(run.env.ANTHROPIC_API_KEY).toBeUndefined();
    const keyFirst = resolveRunClaudeCredential({
      credentials: { claude: ["api_key"] },
      loginPresent: false,
    });
    expect(keyFirst.env.ANTHROPIC_API_KEY === "SENTINEL-KEY-9d2").toBe(true);
  });

  test("an input with no Claude secret leaves the run no Claude credential from the job env", async () => {
    await review("CRYSK_OPENCODE_DEEPSEEK_API_KEY=SENTINEL-DS-9d2");
    const run = resolveRunClaudeCredential({
      credentials: { claude: ["api_key"] },
      loginPresent: false,
    });
    expect(run.selection.status).toBe("none");
  });

  test("an empty input prints nothing and still runs the CLI", async () => {
    const run = await review("");
    expect(run.stdout).toBe("");
    expect(run.calls).toHaveLength(1);
  });
});

describe("src/ci/run.ts as a process", () => {
  function spawnRun(input: string, env: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crysk-run-step-"));
    try {
      const result = Bun.spawnSync([process.execPath, MODULE_PATH, "--help"], {
        cwd: dir,
        stdin: Buffer.from(input),
        env: {
          HOME: dir,
          PATH: path.dirname(process.execPath),
          ...env,
        },
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("reads the input on stdin, masks it, and runs the CLI with its arguments", () => {
    const run = spawnRun(STUB_INPUT);
    expect(run.exitCode).toBe(0);
    // stdout holds only the masks; the CLI ran (its --help is on stderr).
    const lines = run.stdout.split("\n").filter((line) => line !== "");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith("::add-mask::"))).toBe(true);
    expect(run.stderr).toContain("Usage:");
    expect(run.stderr.includes("SENTINEL")).toBe(false);
  });

  test("refuses to run when the input reaches it through its environment, naming no value", () => {
    const run = spawnRun("", {
      CRYSK_SECRETS_INPUT: "CRYSK_CLAUDE_OAUTH_TOKEN=SENTINEL-ENV-9d2",
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "the crysk-secrets input reached run.ts through its environment",
    );
    expect(run.stdout.includes("SENTINEL")).toBe(false);
    expect(run.stderr.includes("SENTINEL")).toBe(false);
  });
});
