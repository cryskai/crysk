// The workflow variants a scenario runs its PR branch under. Each is a pure
// transform of the product scaffold rendered for the ref (seed.ts workflowFor),
// so a fault enters only through the sandbox workflow's own inputs and never
// through product code (ROADMAP CI sandbox S4).
//
// Each edit anchors on one exact rendered line and refuses unless that line is
// there exactly once. A scaffold that changed must fail the run loudly: a
// variant that quietly edits some other line would test a different workflow
// and report it as this one.

import { RUN_STEP_NAME } from "./markers";
import { workflowFor } from "./seed";

export const VARIANT_NAMES = [
  "normal",
  "no-credential",
  "bad-routing",
  "advisory",
  "size-skip",
  "stale-tmp",
] as const;

export type VariantName = (typeof VARIANT_NAMES)[number];

export class WorkflowVariantError extends Error {
  constructor(message: string) {
    super(`sandbox variant: ${message}`);
    this.name = "WorkflowVariantError";
  }
}

// The model-route credential inputs the scaffold wires to the action (src/ci/setup.ts,
// the Run pr-hero step). no-credential removes all three, not only the one the
// trigger reads, so no model credential reaches the action by any other input.
// `github-token` is deliberately kept: it is the runner's GITHUB_TOKEN, which the
// publisher needs to post the PRH-CRED-MISSING outcome and its status, so
// removing it would make the expected outcome unreachable.
// The GitHub expressions are escaped in template literals, as src/ci/setup.ts escapes them.
const CREDENTIAL_LINES = [
  `          anthropic-api-key: \${{ secrets.ANTHROPIC_API_KEY }}`,
  `          claude-token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`,
  `          opencode-auth: \${{ secrets.OPENCODE_AUTH_JSON }}`,
] as const;

const ROUTING_LINE = `          routing: "\${{ vars.CRYSK_ROUTING || vars.PRHERO_ROUTING }}"`;

// A literal that is valid YAML and invalid routing JSON. The setup step rejects
// it as config-parse/routing, which the publisher renders as PRH-ROUTING-INVALID.
const BAD_ROUTING_LINE = '          routing: "{not json"';

// The scaffold names its gate mode on its own line (src/ci/setup.ts writes it
// explicitly), so advisory replaces that line. A second `mode:` beside it would
// be a duplicate key in the `with:` block.
const MODE_GATE_LINE = "          mode: gate";
const MODE_ADVISORY_LINE = "          mode: advisory";

// The size gate is written only when a repo sets it, so size-skip inserts the
// line after the opencode-auth input it follows in the scaffold (the same
// anchor no-credential uses). The threshold of 1 makes any real diff a skip.
const OPENCODE_AUTH_LINE = `          opencode-auth: \${{ secrets.OPENCODE_AUTH_JSON }}`;
const SIZE_SKIP_LINE = "          max-changed-lines: 1";

// SB3 stale-tmp: a killed earlier run leaves its fixed-name temp records in the outcome
// directory. The product's writes use unique temp names (trigger.ts recordTempPath), so
// these must not break the run. The fault is a step the sandbox adds before the action
// step, in the runner's own temp directory, where the product's outcome records go.
// The anchor is the action step's name line; the injected step keeps its indentation.
const RUN_STEP_LINE = `      - name: ${RUN_STEP_NAME}`;
const STALE_TMP_STEP = [
  "      - name: Leave stale temp records from a killed run",
  "        run: |",
  '          mkdir -p "$RUNNER_TEMP/pr-hero-outcome"',
  '          printf \'{"stale":true}\' > "$RUNNER_TEMP/pr-hero-outcome/trigger.json.tmp"',
  '          printf \'{"stale":true}\' > "$RUNNER_TEMP/pr-hero-outcome/setup.json.tmp"',
  "",
  RUN_STEP_LINE,
].join("\n");

// Replaces the one line equal to `line`, or removes it when `replacement` is
// undefined. Refuses unless exactly one line matches.
function replaceExactLine(
  source: string,
  line: string,
  replacement: string | undefined,
): string {
  const hits = source.split("\n").filter((l) => l === line).length;
  if (hits !== 1) {
    throw new WorkflowVariantError(
      `expected exactly one line ${JSON.stringify(line)} in the scaffold, found ${hits}; ` +
        "the scaffold changed, so this variant cannot be applied",
    );
  }
  return source
    .split("\n")
    .flatMap((l) => {
      if (l !== line) return [l];
      return replacement === undefined ? [] : [replacement];
    })
    .join("\n");
}

// Applies a variant to a scaffold. Pure: the input is never modified.
export function applyVariant(name: VariantName, scaffold: string): string {
  switch (name) {
    case "normal":
      return scaffold;
    case "no-credential":
      return CREDENTIAL_LINES.reduce<string>(
        (source, line) => replaceExactLine(source, line, undefined),
        scaffold,
      );
    case "bad-routing":
      return replaceExactLine(scaffold, ROUTING_LINE, BAD_ROUTING_LINE);
    case "advisory":
      return replaceExactLine(scaffold, MODE_GATE_LINE, MODE_ADVISORY_LINE);
    case "size-skip":
      return replaceExactLine(
        scaffold,
        OPENCODE_AUTH_LINE,
        `${OPENCODE_AUTH_LINE}\n${SIZE_SKIP_LINE}`,
      );
    case "stale-tmp":
      return replaceExactLine(scaffold, RUN_STEP_LINE, STALE_TMP_STEP);
  }
}

// The workflow a variant puts on a PR branch, for a given action ref.
export function workflowVariant(name: VariantName, ref: string): string {
  return applyVariant(name, workflowFor(ref));
}
