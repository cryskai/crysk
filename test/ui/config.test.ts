// Offline tests for `pr-hero config`'s renderer (C5 O-12, §5 row 12): one
// case per direction, the cap-narrowed value that must read `capped` and not
// `repo`, the key absent from both files that must read `default`, and the
// zero-`\x1b` companion CLAUDE.md requires of every renderer beside
// ui/result/ui/tree/ui/select.
//
// Every case feeds the renderer `mergeConfig`'s REAL output rather than a
// hand-written `sources` record. Hand-written provenance would prove the
// renderer can print the word `capped`; only the fold can prove a cap
// actually produces it, and that is the fact the command exists to report.

import { describe, expect, test } from "bun:test";
import {
  CONFIG_DIRECTION,
  type ConfigLayer,
  mergeConfig,
} from "#review/preflight";
import { type ConfigViewInput, configRows, renderConfig } from "#ui/config";

const PATHS = {
  repoConfigPath: "/repo/.prhero/config.json",
  globalConfigPath: "/home/me/.prhero/config.json",
} as const;

function render(
  global: ConfigLayer | undefined,
  repo: ConfigLayer,
  overrides: {
    repoPresent?: boolean;
    globalPresent?: boolean;
    styles?: boolean;
    width?: number;
  } = {},
): string[] {
  return renderConfig({
    ...mergeConfig(global, repo),
    ...PATHS,
    repoPresent: overrides.repoPresent ?? true,
    globalPresent: overrides.globalPresent ?? global !== undefined,
    styles: overrides.styles ?? false,
    // Pinned, never sniffed: these renderers were the reason `bun test` in a
    // narrow pane could fail on a wrap point no test could stub.
    width: overrides.width ?? 100,
  });
}

// The row for `key`, as its whitespace-collapsed tokens.
function rowFor(lines: string[], key: string): string {
  const line = lines.find((l) => l.trimStart().startsWith(`${key} `));
  if (line === undefined) throw new Error(`no row for ${key}: ${lines}`);
  return line.trim().replace(/\s+/g, " ");
}

describe("pr-hero config names the layer behind every value", () => {
  test("one case per direction: global, repo, capped and default", () => {
    const lines = render(
      {
        agents_dir: "/home/me/agents/clean",
        summary: { enabled: false },
        max_verification_steps: 4,
      },
      {
        default_base: "dev",
        summary: { enabled: true },
        max_verification_steps: 12,
      },
    );

    // global — only the global file named it.
    expect(rowFor(lines, "agents_dir")).toBe(
      "agents_dir global /home/me/agents/clean",
    );
    // repo — only the repo file named it, and `default_base` can never be
    // anything else: it is a `repo` key and parseGlobalConfig rejects it.
    expect(rowFor(lines, "default_base")).toBe("default_base repo dev");
    // capped, NOT repo. The repo asked for 12, the global ceiling of 4 took
    // it away, and a listing that said `repo` here would name the layer whose
    // value is not on screen.
    expect(rowFor(lines, "max_verification_steps")).toBe(
      "max_verification_steps capped 4 ← narrowed by the global ceiling",
    );
    expect(rowFor(lines, "summary.enabled")).toBe(
      "summary.enabled capped false ← narrowed by the global ceiling",
    );
    // default — neither file named it. §5 row 12's "a key absent from both
    // files", and the whole reason §3.2 stopped the parser materialising the
    // two arrays.
    expect(rowFor(lines, "parity_trigger_paths")).toBe(
      "parity_trigger_paths default (unset)",
    );
    expect(rowFor(lines, "suspicion_priors")).toBe(
      "suspicion_priors default (unset)",
    );
    expect(rowFor(lines, "scout")).toBe("scout default (unset)");
    expect(rowFor(lines, "post")).toBe("post default (unset)");
    expect(rowFor(lines, "materiality_gate")).toBe(
      "materiality_gate default (unset)",
    );
  });

  test("materiality_gate displays its value and the capped marker", () => {
    expect(
      rowFor(render(undefined, { materiality_gate: true }), "materiality_gate"),
    ).toBe("materiality_gate repo true");
    expect(
      rowFor(
        render({ materiality_gate: false }, { materiality_gate: true }),
        "materiality_gate",
      ),
    ).toBe("materiality_gate capped false ← narrowed by the global ceiling");
  });

  test("scout and post display capped marker when global ceiling narrows repo setting", () => {
    const lines = render(
      { scout: false, post: false },
      { scout: true, post: true },
    );
    expect(rowFor(lines, "scout")).toBe(
      "scout capped false ← narrowed by the global ceiling",
    );
    expect(rowFor(lines, "post")).toBe(
      "post capped false ← narrowed by the global ceiling",
    );
  });

  test("a value a cap did NOT narrow keeps its own layer and no marker", () => {
    // Same shape as above with the inequality reversed: the repo is already
    // the narrower side, so nothing was taken away and `capped` would be a
    // narrowing the operator could not find by deleting the global file.
    const lines = render(
      { summary: { enabled: true }, max_verification_steps: 12 },
      { summary: { enabled: false }, max_verification_steps: 4 },
    );
    expect(rowFor(lines, "max_verification_steps")).toBe(
      "max_verification_steps repo 4",
    );
    expect(rowFor(lines, "summary.enabled")).toBe("summary.enabled repo false");
    expect(lines.join("\n")).not.toContain("narrowed by the global ceiling");
  });

  test("an explicitly empty list is not the same row as an unset one", () => {
    // The distinction §3.2's parser change bought: `"parity_trigger_paths":
    // []` is a repo deliberately disarming the parity hunter, and printing it
    // as `(unset)` would hide a decision someone made on purpose.
    const lines = render(undefined, {
      parity_trigger_paths: [],
      suspicion_priors: [
        { path: "src/pipeline.ts", weight: "high", reason: "" },
      ],
    });
    expect(rowFor(lines, "parity_trigger_paths")).toBe(
      "parity_trigger_paths repo (empty)",
    );
    expect(rowFor(lines, "suspicion_priors")).toBe(
      "suspicion_priors repo src/pipeline.ts (high)",
    );
  });
});

describe("pr-hero config names both files, present or not", () => {
  test("an absent file still gets its path printed", () => {
    const lines = render(undefined, {}, { repoPresent: false });
    expect(lines).toContain("  repo   /repo/.prhero/config.json (absent)");
    expect(lines).toContain("  global /home/me/.prhero/config.json (absent)");
  });

  test("a present pair says so", () => {
    const lines = render({}, {});
    expect(lines).toContain("  repo   /repo/.prhero/config.json (present)");
    expect(lines).toContain("  global /home/me/.prhero/config.json (present)");
  });

  test("the flag caveat is always printed", () => {
    // Judgment ledger JD-10: ConfigSource has no `flag` member, so no row can
    // ever attribute a flag-decided value to a layer. §3.10's "what it prints
    // cannot drift from what actually runs" is only honest while the output
    // says which decisions happen after this merge.
    // Whitespace-normalised: the caveat is wrapped to the terminal width, so
    // a raw substring would pin the wrap points rather than the sentence.
    const prose = render(undefined, {}).join(" ").replace(/\s+/g, " ");
    expect(prose).toContain(
      "Flags (--base, --model, --agents, --no-summary) and PRHERO_AGENTS_DIR " +
        "are applied after this merge, by the resolvers, so no row above can " +
        "say flag.",
    );
  });
});

describe("pr-hero config styling", () => {
  test("zero \\x1b bytes with styles off", () => {
    const lines = render(
      { agents_dir: "/a", summary: { enabled: false } },
      { summary: { enabled: true }, max_verification_steps: 2 },
    );
    expect(lines.join("\n")).not.toContain("\x1b");
  });

  test("and real escapes with styles on, so the test above is not vacuous", () => {
    // Annotated rather than inferred, so ConfigViewInput has a real consumer:
    // an exported type nothing imports is how dead code hides in a module
    // whose contract is its input shape.
    const input: ConfigViewInput = {
      ...mergeConfig({ agents_dir: "/a" }, { default_base: "dev" }),
      ...PATHS,
      repoPresent: true,
      globalPresent: true,
      styles: true,
      width: 100,
    };
    expect(renderConfig(input).join("\n")).toContain("\x1b[");
  });
});

// The zero-`\x1b`-with-styles-off test above passes against a row whose value
// arrives at row() ALREADY PAINTED — it only ever walks the styles-off path,
// so it cannot see the defect that costs: row() places the wrap with raw
// `value.length`, counting escape bytes as visible width, and wrapText then
// splits on whitespace and can put a colour's opening escape on one line and
// its reset on the next. These four pin the styles-ON path instead.
// Composed rather than written as a literal, because biome's two relevant
// rules disagree: `/…/` is a noControlCharactersInRegex ERROR, and
// `new RegExp("\\u001b…")` is a useRegexLiterals warning that would be fixed
// back into the error. Interpolating the byte satisfies both — the same
// escape-in-a-regex problem corpus/preflight.ts dodges with a codepoint loop.
// `.replace` and `.match` each reset a global regex's lastIndex, so one shared
// instance is safe.
const ESC = "\x1b";
const ESCAPE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

function stripEscapes(line: string): string {
  return line.replace(ESCAPE, "");
}

// A line must close every colour it opens and must never begin with a reset
// belonging to a colour opened on the line above: an unbalanced line bleeds
// its colour into whatever the terminal prints next.
function unbalanced(line: string): string | undefined {
  let depth = 0;
  for (const token of line.match(ESCAPE) ?? []) {
    if (token === "\x1b[0m") {
      depth -= 1;
      if (depth < 0) return `orphaned reset: ${JSON.stringify(line)}`;
      continue;
    }
    depth += 1;
  }
  return depth === 0 ? undefined : `unclosed colour: ${JSON.stringify(line)}`;
}

// One fixture for all four, built from mergeConfig's real fold like every
// other case in this file. It carries the two shapes the defect needs: a
// `global` agents_dir short enough to fit the value column UNPAINTED but not
// once the cyan escapes are counted, and two `capped` rows whose multi-word
// marker is long enough that the whitespace split lands inside it.
const WRAP_GLOBAL = {
  agents_dir: "/home/me/agents/clean-24",
  max_verification_steps: 4,
  summary: { enabled: false },
};
const WRAP_REPO = {
  default_base: "dev",
  max_verification_steps: 12,
  summary: { enabled: true },
};
// Value column starts at 25 (indent 2 + the 23 `max_verification_steps` needs),
// so 64 leaves enough columns after `ci_admission_observe_only` widened the
// label column — narrow enough that escape bytes decide the wrap, wide enough
// that nothing hits row()'s MIN_VALUE_WIDTH floor.
const WRAP_WIDTH = 64;

describe("pr-hero config wraps the same way painted and unpainted", () => {
  test("every line of a wrapped, styled row closes the colours it opens", () => {
    const lines = render(WRAP_GLOBAL, WRAP_REPO, {
      styles: true,
      width: WRAP_WIDTH,
    });
    expect(lines.map(unbalanced).filter((m) => m !== undefined)).toEqual([]);
  });

  test("styles on and styles off wrap at exactly the same points", () => {
    // The property that generalises: styling is a projection over the layout,
    // never an input to it. Full-array equality rather than a line count —
    // a wrap that merely moves is the same defect as one that appears.
    const plain = render(WRAP_GLOBAL, WRAP_REPO, { width: WRAP_WIDTH });
    const styled = render(WRAP_GLOBAL, WRAP_REPO, {
      styles: true,
      width: WRAP_WIDTH,
    });
    expect(styled.map(stripEscapes)).toEqual(plain);
  });

  test("a capped row's marker stays closed on both lines it is split across", () => {
    const lines = render(WRAP_GLOBAL, WRAP_REPO, {
      styles: true,
      width: WRAP_WIDTH,
    });
    const plain = lines.map(stripEscapes);
    const first = plain.findIndex((l) =>
      l.startsWith("  max_verification_steps"),
    );
    expect(first).toBeGreaterThanOrEqual(0);
    expect(unbalanced(lines[first])).toBeUndefined();
    expect(unbalanced(lines[first + 1])).toBeUndefined();
    // Not vacuous: the marker really is cut in two here. It is the one span
    // wrapText's whitespace split can separate from its own reset, because it
    // is the only painted span made of more than one word.
    expect(plain[first]).toContain("← narrowed by the global");
    expect(plain[first]).not.toContain("ceiling");
    expect(plain[first + 1].trim()).toBe("ceiling");
  });

  test("the layer tag keeps its own colour, distinct from the marker's", () => {
    // The reason the established fix (cli.ts's markerRowLines: build unstyled,
    // paint the whole line) does not transfer — a config row has two spans
    // coloured independently, with an uncoloured value between them.
    const lines = render({ agents_dir: "/a" }, {}, { styles: true });
    const agents = lines.find((l) =>
      stripEscapes(l).startsWith("  agents_dir"),
    );
    expect(agents).toContain("\x1b[36mglobal");
    const capped = render(WRAP_GLOBAL, WRAP_REPO, { styles: true }).find((l) =>
      stripEscapes(l).startsWith("  max_verification_steps"),
    );
    expect(capped).toContain("\x1b[33mcapped");
    expect(capped).toContain("\x1b[33m← narrowed by the global ceiling\x1b[0m");
  });
});

describe("configRows", () => {
  // Iterated off CONFIG_DIRECTION, the type-locked table that IS the known-key
  // set — not a hand-written fixture. A fixture can only enumerate what its
  // author remembered (judgment ledger JD-19); the table cannot gain a key
  // without tsc noticing, so this witnesses the real union.
  test("covers every key CONFIG_DIRECTION declares", () => {
    const merged = mergeConfig(undefined, {});
    const rows = configRows(merged.effective, merged.sources);
    const keys = rows.map((r) => r.key);
    for (const key of Object.keys(CONFIG_DIRECTION)) {
      if (key === "summary") {
        // The one nested key, expanded per field. `summary.model` is gone:
        // the summary model is the `summary` role under `models`.
        expect(keys).toContain("summary.enabled");
        expect(keys).not.toContain("summary.model");
        continue;
      }
      expect(keys).toContain(key);
    }
    expect(keys).toHaveLength(Object.keys(CONFIG_DIRECTION).length);
  });

  test("routing cell formats unset, default route, and mappings counts correctly", () => {
    // Unset
    const unmerged = mergeConfig(undefined, {});
    const unsetRows = configRows(unmerged.effective, unmerged.sources);
    const unsetRouting = unsetRows.find((r) => r.key === "routing");
    expect(unsetRouting?.value).toBe("(unset)");

    // Only default
    const withDefault = mergeConfig(
      {
        routing: {
          default: {
            backend: "claude-code",
            provider: "anthropic",
          },
        },
      },
      {},
    );
    const defaultRows = configRows(withDefault.effective, withDefault.sources);
    const defaultRouting = defaultRows.find((r) => r.key === "routing");
    expect(defaultRouting?.value).toBe("default route");

    // Only mappings
    const withMappings = mergeConfig(
      {
        routing: {
          mappings: [
            {
              logical: "sonnet",
              backend: "claude-code",
              provider: "anthropic",
            },
          ],
        },
      },
      {},
    );
    const mappingsRows = configRows(
      withMappings.effective,
      withMappings.sources,
    );
    const mappingsRouting = mappingsRows.find((r) => r.key === "routing");
    expect(mappingsRouting?.value).toBe("1 mapping");

    // Mappings + default
    const withBoth = mergeConfig(
      {
        routing: {
          default: {
            backend: "claude-code",
            provider: "anthropic",
          },
          mappings: [
            {
              logical: "sonnet",
              backend: "claude-code",
              provider: "anthropic",
            },
            {
              logical: "opus",
              backend: "claude-code",
              provider: "anthropic",
            },
          ],
        },
      },
      {},
    );
    const bothRows = configRows(withBoth.effective, withBoth.sources);
    const bothRouting = bothRows.find((r) => r.key === "routing");
    expect(bothRouting?.value).toBe("2 mappings (+ default)");
  });
});
