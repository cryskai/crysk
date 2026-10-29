// The workflow variants are pure transforms of the product scaffold, so they are
// pinned against the real rendered scaffold and parsed back as YAML. A transform
// that edits a line the scaffold no longer has must throw, not silently test a
// different workflow.

import { describe, expect, test } from "bun:test";
import { workflowFor } from "../../scripts/sandbox/seed";
import {
  applyVariant,
  VARIANT_NAMES,
  WorkflowVariantError,
  workflowVariant,
} from "../../scripts/sandbox/variants";

const REF = "v0.2.0";
const NORMAL = workflowFor(REF);

// The Run Crysk step's `with:` block, found by walking the parsed YAML rather
// than by line position, so the test does not depend on where the scaffold puts it.
function actionWith(yaml: string): Record<string, unknown> {
  const doc = Bun.YAML.parse(yaml) as {
    jobs: Record<
      string,
      { steps: { uses?: string; with?: Record<string, unknown> }[] }
    >;
  };
  for (const job of Object.values(doc.jobs)) {
    for (const step of job.steps) {
      if (
        step.uses?.startsWith("juanmaagd/pr-hero@") &&
        step.with !== undefined
      ) {
        return step.with;
      }
    }
  }
  throw new Error("no pr-hero action step with inputs");
}

describe("workflow variants: the real scaffold", () => {
  test("normal is the scaffold as rendered for the ref, unchanged", () => {
    expect(workflowVariant("normal", REF)).toBe(NORMAL);
    expect(VARIANT_NAMES).toEqual([
      "normal",
      "no-credential",
      "bad-routing",
      "advisory",
      "size-skip",
      "stale-tmp",
    ]);
  });

  test("every variant is still a valid workflow for the action", () => {
    for (const name of VARIANT_NAMES) {
      expect(() => actionWith(workflowVariant(name, REF))).not.toThrow();
    }
  });

  test("no-credential: no credential input reaches the action, and routing is kept", () => {
    const inputs = actionWith(workflowVariant("no-credential", REF));
    // github-token stays: it is the runner's own GITHUB_TOKEN, which the
    // publisher uses to post the outcome comment and the status. It names no
    // model route, so it is not a credential the variant is testing.
    // `mode` is the scaffold's explicit gate mode (S4): not a credential, kept.
    expect(Object.keys(inputs).sort()).toEqual([
      "budget-usd",
      "github-token",
      "mode",
      "routing",
    ]);
    expect(inputs.routing).toBe(
      `\${{ vars.CRYSK_ROUTING || vars.PRHERO_ROUTING }}`,
    );
  });

  test("no-credential removes exactly the three credential lines and nothing else", () => {
    const before = NORMAL.split("\n");
    const after = workflowVariant("no-credential", REF).split("\n");
    expect(before.length - after.length).toBe(3);
    const removed = before.filter((line) => !after.includes(line));
    expect(removed.map((line) => line.trim().split(":")[0])).toEqual([
      "anthropic-api-key",
      "claude-token",
      "opencode-auth",
    ]);
  });

  test("bad-routing: the routing input is a malformed literal, and the credential is still wired", () => {
    const inputs = actionWith(workflowVariant("bad-routing", REF));
    expect(inputs.routing).toBe("{not json");
    expect(inputs["opencode-auth"]).toBe(`\${{ secrets.OPENCODE_AUTH_JSON }}`);
  });

  test("bad-routing changes one line, and only the routing line", () => {
    const before = NORMAL.split("\n");
    const after = workflowVariant("bad-routing", REF).split("\n");
    expect(after.length).toBe(before.length);
    const changed = before.filter((line, i) => line !== after[i]);
    expect(changed).toEqual([
      `          routing: "\${{ vars.CRYSK_ROUTING || vars.PRHERO_ROUTING }}"`,
    ]);
  });

  test("each variant is a pure function of the scaffold: same input, same bytes, input untouched", () => {
    const snapshot = NORMAL;
    for (const name of VARIANT_NAMES) {
      expect(workflowVariant(name, REF)).toBe(workflowVariant(name, REF));
    }
    expect(NORMAL).toBe(snapshot);
  });
});

describe("workflow variants: a scaffold that changed", () => {
  test("a missing anchor line throws, and the message names the line", () => {
    const changed = NORMAL.replace(
      `          opencode-auth: \${{ secrets.OPENCODE_AUTH_JSON }}\n`,
      "",
    );
    expect(() => applyVariant("no-credential", changed)).toThrow(
      WorkflowVariantError,
    );
    expect(() => applyVariant("no-credential", changed)).toThrow(
      /opencode-auth: \$\{\{ secrets\.OPENCODE_AUTH_JSON \}\}.*found 0/,
    );
  });

  test("a duplicated anchor line throws rather than editing an arbitrary one", () => {
    const routing = `          routing: "\${{ vars.CRYSK_ROUTING || vars.PRHERO_ROUTING }}"`;
    const changed = NORMAL.replace(routing, `${routing}\n${routing}`);
    expect(() => applyVariant("bad-routing", changed)).toThrow(/found 2/);
  });

  test("bad-routing refuses a scaffold whose routing input moved to another form", () => {
    const changed = NORMAL.replace(
      `          routing: "\${{ vars.CRYSK_ROUTING || vars.PRHERO_ROUTING }}"`,
      `          routing: \${{ vars.PRHERO_ROUTING_V2 }}`,
    );
    expect(() => applyVariant("bad-routing", changed)).toThrow(
      WorkflowVariantError,
    );
  });
});

// S4: the scaffold names its gate mode, so the advisory variant replaces that
// one line. Inserting a second `mode:` key beside it would be a duplicate key
// in the `with:` block, which GitHub rejects.
describe("workflow variants: the gate mode (S4)", () => {
  function linesOf(source: string): string[] {
    return source.split("\n");
  }

  test("the normal scaffold names its gate mode explicitly", () => {
    expect(actionWith(NORMAL).mode).toBe("gate");
  });

  test("advisory changes exactly the mode line and nothing else", () => {
    const advisory = workflowVariant("advisory", REF);
    expect(actionWith(advisory).mode).toBe("advisory");
    const before = linesOf(NORMAL);
    const after = linesOf(advisory);
    expect(after).toHaveLength(before.length);
    expect(
      after.flatMap((line, i) => (line === before[i] ? [] : [line])),
    ).toEqual(["          mode: advisory"]);
  });

  test("size-skip adds max-changed-lines: 1 once and keeps the gate mode", () => {
    const sized = workflowVariant("size-skip", REF);
    const inputs = actionWith(sized);
    expect(inputs["max-changed-lines"]).toBe(1);
    expect(inputs.mode).toBe("gate");
    expect(
      linesOf(sized).filter((line) => line.includes("max-changed-lines")),
    ).toEqual(["          max-changed-lines: 1"]);
  });

  test("advisory refuses a scaffold that lost its mode line", () => {
    const changed = NORMAL.replace("          mode: gate\n", "");
    expect(() => applyVariant("advisory", changed)).toThrow(
      WorkflowVariantError,
    );
  });
});

describe("the stale-tmp variant (SB3): the stale records are planted before the action step", () => {
  test("adds one run step before the action step and changes nothing else", () => {
    const stale = workflowVariant("stale-tmp", REF);
    const lines = stale.split("\n");
    const normal = NORMAL.split("\n");
    // Six lines before the action step: its name, `run: |`, the mkdir and the two writes, a blank.
    expect(lines.length).toBe(normal.length + 6);
    const at = lines.indexOf("      - name: Run Crysk");
    expect(at).toBeGreaterThan(0);
    expect(lines.filter((l) => l === "      - name: Run Crysk").length).toBe(1);
    expect(lines[at - 6]).toBe(
      "      - name: Leave stale temp records from a killed run",
    );
    expect(lines.slice(at - 3, at).join("\n")).toContain(
      'printf \'{"stale":true}\' > "$RUNNER_TEMP/pr-hero-outcome/trigger.json.tmp"',
    );
    expect(lines.slice(at - 3, at).join("\n")).toContain(
      'printf \'{"stale":true}\' > "$RUNNER_TEMP/pr-hero-outcome/setup.json.tmp"',
    );
    // Everything else is the scaffold, byte for byte.
    expect([...lines.slice(0, at - 6), ...lines.slice(at)]).toEqual(normal);
  });
});
