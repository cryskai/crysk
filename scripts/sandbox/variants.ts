// The workflow variants a scenario runs its PR branch under. Each is a pure
// transform of the product scaffold rendered for the ref (seed.ts workflowFor),
// so a fault enters only through the sandbox workflow's own inputs and never
// through product code (ROADMAP CI sandbox S4).
//
// Each edit anchors on one exact rendered line and refuses unless that line is
// there exactly once. A scaffold that changed must fail the run loudly: a
// variant that quietly edits some other line would test a different workflow
// and report it as this one.

import { CREDENTIALS_INPUT_LINE } from "#ci/outcome";
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

// The scaffold hands the action its credentials in one input, `crysk-secrets: |`, a
// block of CRYSK_* lines (src/ci/setup.ts, the Run Crysk step). no-credential removes
// that input whole, its key line and every line of its block, so no model credential
// reaches the action by any other line. `models` and `credentials` stay: they name
// models and an order, never a credential. `github-token` is deliberately kept: it is
// the runner's GITHUB_TOKEN, which the publisher needs to post the CRYSK-CRED-MISSING
// outcome and its status, so removing it would make the expected outcome unreachable.
const CRYSK_SECRETS_LINE = "          crysk-secrets: |";
// The block's lines sit deeper than its key, and each one is a CRYSK_* line.
const CRYSK_SECRETS_BLOCK_INDENT = "            ";
const CRYSK_SECRET_ENTRY = /^ {12}CRYSK_/;

// The scaffold's last input before the gate mode, the line bad-routing and size-skip
// add theirs after. It is the product's own constant, so the anchor cannot drift from
// the rendered line; never a line inside the crysk-secrets block, where an inserted
// line would become part of that literal.
const CREDENTIALS_LINE = `          ${CREDENTIALS_INPUT_LINE}`;

// A literal that is valid YAML. The routing input is gone (S2): the trigger stops
// a workflow that passes it any value, which the publisher renders as CRYSK-INPUT-REMOVED.
const BAD_ROUTING_LINE = '          routing: "{not json"';

// The scaffold names its gate mode on its own line (src/ci/setup.ts writes it
// explicitly), so advisory replaces that line. A second `mode:` beside it would
// be a duplicate key in the `with:` block.
const MODE_GATE_LINE = "          mode: gate";
const MODE_ADVISORY_LINE = "          mode: advisory";

// The size gate is written only when a repo sets it, so size-skip inserts the
// line after the credentials input. The threshold of 1 makes any real diff a skip.
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

// Removes the one line equal to `line` and the block under it: every following line
// that starts with `blockIndent`. Refuses unless `line` is there exactly once and its
// block is not empty and every line of it matches `entry`, so a block that changed
// shape fails the variant instead of losing lines nobody checked.
function removeExactBlock(
  source: string,
  line: string,
  blockIndent: string,
  entry: RegExp,
): string {
  const lines = source.split("\n");
  const hits = lines.filter((l) => l === line).length;
  if (hits !== 1) {
    throw new WorkflowVariantError(
      `expected exactly one line ${JSON.stringify(line)} in the scaffold, found ${hits}; ` +
        "the scaffold changed, so this variant cannot be applied",
    );
  }
  const at = lines.indexOf(line);
  let end = at + 1;
  while (end < lines.length && (lines[end] ?? "").startsWith(blockIndent)) {
    end += 1;
  }
  const block = lines.slice(at + 1, end);
  const odd = block.find((l) => !entry.test(l));
  if (block.length === 0 || odd !== undefined) {
    throw new WorkflowVariantError(
      `the block under ${JSON.stringify(line)} is ${
        odd === undefined
          ? "empty"
          : `not only lines matching ${entry}: ${JSON.stringify(odd)}`
      }; the scaffold changed, so this variant cannot be applied`,
    );
  }
  return [...lines.slice(0, at), ...lines.slice(end)].join("\n");
}

// Applies a variant to a scaffold. Pure: the input is never modified.
export function applyVariant(name: VariantName, scaffold: string): string {
  switch (name) {
    case "normal":
      return scaffold;
    case "no-credential":
      return removeExactBlock(
        scaffold,
        CRYSK_SECRETS_LINE,
        CRYSK_SECRETS_BLOCK_INDENT,
        CRYSK_SECRET_ENTRY,
      );
    case "bad-routing":
      return replaceExactLine(
        scaffold,
        CREDENTIALS_LINE,
        `${CREDENTIALS_LINE}\n${BAD_ROUTING_LINE}`,
      );
    case "advisory":
      return replaceExactLine(scaffold, MODE_GATE_LINE, MODE_ADVISORY_LINE);
    case "size-skip":
      return replaceExactLine(
        scaffold,
        CREDENTIALS_LINE,
        `${CREDENTIALS_LINE}\n${SIZE_SKIP_LINE}`,
      );
    case "stale-tmp":
      return replaceExactLine(scaffold, RUN_STEP_LINE, STALE_TMP_STEP);
  }
}

// The workflow a variant puts on a PR branch, for a given action ref.
export function workflowVariant(name: VariantName, ref: string): string {
  return applyVariant(name, workflowFor(ref));
}
