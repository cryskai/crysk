// The workflow variants a scenario runs its PR branch under. Each is a pure
// transform of the product scaffold rendered for the ref (seed.ts workflowFor),
// so a fault enters only through the sandbox workflow's own inputs and never
// through product code (ROADMAP CI sandbox S4).
//
// Each edit anchors on one exact rendered line and refuses unless that line is
// there exactly once. A scaffold that changed must fail the run loudly: a
// variant that quietly edits some other line would test a different workflow
// and report it as this one.

import { workflowFor } from "./seed";

export const VARIANT_NAMES = [
  "normal",
  "no-credential",
  "bad-routing",
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

const ROUTING_LINE = `          routing: "\${{ vars.PRHERO_ROUTING }}"`;

// A literal that is valid YAML and invalid routing JSON. The setup step rejects
// it as config-parse/routing, which the publisher renders as PRH-ROUTING-INVALID.
const BAD_ROUTING_LINE = '          routing: "{not json"';

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
  }
}

// The workflow a variant puts on a PR branch, for a given action ref.
export function workflowVariant(name: VariantName, ref: string): string {
  return applyVariant(name, workflowFor(ref));
}
