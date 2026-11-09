// The Run Crysk step's entry (odd/tasks/role-model-routing.md, S8, L27, U5).
//
// The workflow passes its Crysk credentials as the `crysk-secrets` input, one
// `CRYSK_*=value` line per secret. action.yml pipes that input to this script on
// stdin (`printf '%s' "$CRYSK_SECRETS_INPUT" | CRYSK_SECRETS_INPUT= bun run.ts ...`),
// the way the trigger and the setup step take it, and runs bun with the variable
// emptied: Bun hands a child the environment it STARTED with, so a variable bun
// received would reach every git, gh and agent child of the review.
//
// This script parses the input with the setup step's own grammar
// (parseCryskSecrets), masks every value again (the setup step already did, in the
// same job; this keeps the mask even if a later edit reorders the steps), hands the
// Claude values to the credential intake (src/security/claude-credential.ts), and
// runs the CLI with its own arguments. Nothing is written to process.env. The
// OpenCode secrets are not read here: the setup step already built the OpenCode
// auth file and its manifest from them (U3).
//
// The intake is taken even when the input holds no Claude secret, so in the action
// the review reads its Claude credential only from this input (or a login on the
// runner), never from a job-level ANTHROPIC_API_KEY nobody passed in it.

import { runCli } from "../cli";
import { takeCryskClaudeSecrets } from "../security/claude-credential";
import { parseCryskSecrets } from "./crysk-secrets";

export interface CiRunDeps {
  // The crysk-secrets input, read from stdin by the entry point below.
  readonly cryskSecrets: string;
  // The CLI's arguments, as the step built them (`review --pr <n> --ci --yes ...`).
  readonly argv: readonly string[];
  readonly stdout: (text: string) => void;
  readonly runCli: (argv: string[]) => Promise<void>;
}

// Workflow-command data escaping, as the runner's own toolkit does it.
function escapeCommandData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export async function runCiReview(deps: CiRunDeps): Promise<void> {
  const parsed = parseCryskSecrets(deps.cryskSecrets);
  for (const value of parsed.masks) {
    deps.stdout(`::add-mask::${escapeCommandData(value)}\n`);
  }
  takeCryskClaudeSecrets(parsed.secrets.claude);
  await deps.runCli([...deps.argv]);
}

// The env variable action.yml binds the input to in this step. A non-empty one
// here means the step was wired wrongly, and the script refuses to run.
const CRYSK_SECRETS_ENV = "CRYSK_SECRETS_INPUT";

if (import.meta.main) {
  if ((process.env[CRYSK_SECRETS_ENV] ?? "") !== "") {
    process.stderr.write(
      `crysk: the crysk-secrets input reached run.ts through its environment, which every child it spawns would inherit; pipe it on stdin and run bun with ${CRYSK_SECRETS_ENV} empty.\n`,
    );
    process.exit(1);
  }
  // WHY read to EOF first, before anything else: the step pipes printf into this
  // process under `pipefail`, and a reader that exits without draining the pipe
  // could leave printf with SIGPIPE, making the step's exit something other than
  // the CLI's.
  const cryskSecrets = await Bun.stdin.text();
  await runCiReview({
    cryskSecrets,
    argv: process.argv.slice(2),
    stdout: (text) => {
      process.stdout.write(text);
    },
    runCli,
  });
}
