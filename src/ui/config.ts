// `pr-hero config`'s output, as LINES. Fourth member of the terminal
// surface's pure half (ui/primitives.ts formats, ui/select.ts asks, ui/result.ts
// reports, this one explains): same contract as all three — everything is a
// total function of its inputs, the style flag and the width arrive as
// PARAMETERS, and the I/O shell in cli.ts owns the printing and the exit code.
//
// WHY the command exists at all (C5 D10): two layers that cannot be inspected
// are worse DX than one layer that can. The first question a teammate asks is
// "why is this value what it is", and before this the answer was "read two
// files and know the rules". The data was already there — D7 makes
// pipeline.json carry the same per-key source record — so this is a renderer,
// not a mechanism.
//
// WHY it lists DEFAULTS too, unlike the plan card: the card tags only the
// surprising values (global, capped) because it sits between the operator and
// a spend decision and is already dense; cli.ts's configTag says so and names
// this file as where the exhaustive list belongs (judgment ledger JD-21).
// Here the exhaustive list IS the product — a key missing from the listing
// would read as "pr-hero has no such setting".

import type {
  ConfigSource,
  ConfigSources,
  LocalConfig,
  SummaryConfig,
} from "#review/preflight";
import type { SuspicionPrior } from "#review/prompt-set";
import {
  bold,
  cyan,
  dim,
  labelColumnWidth,
  row,
  terminalWidth,
  wrapText,
  yellow,
} from "./primitives";

export interface ConfigViewInput {
  // The MERGED config and its provenance, exactly as a review resolved them —
  // loadEffectiveConfig's own output, never a re-derivation. §3.10's "what it
  // prints cannot drift from what actually runs" is only true while this stays
  // the same fold the engine path takes.
  effective: LocalConfig;
  sources: ConfigSources;
  // Both paths, named whether or not the file is there: "where do I even
  // write this" is the other half of the question a teammate is asking, and a
  // path that only appears once the file exists answers it for exactly the
  // people who did not need the answer. Printed verbatim rather than
  // home-collapsed, because a path you can copy beats a path that is short —
  // and shortPath()'s homedir() default would be a sniff inside a renderer.
  repoConfigPath: string;
  repoPresent: boolean;
  globalConfigPath: string;
  globalPresent: boolean;
  styles: boolean;
  // Optional for the reason PlanContext.width is: the shell may leave the one
  // sniff to this entry point, and the tests ALWAYS pin it.
  width?: number;
}

interface ConfigCell {
  value: string;
  source: ConfigSource;
}

interface ConfigRow extends ConfigCell {
  key: string;
}

// The keys that get one row each. `summary` is excluded and expanded into its
// two fields below, exactly as ConfigSources splits it — its fields have
// different directions and one row could not name two layers.
type ConfigRowKey = Exclude<keyof LocalConfig, "summary">;

// Nothing named the key, so there is no value to print. NOT a rendered
// default: the built-in fallbacks are not uniform and two of them are not even
// values — `default_base` falls through to remote-head autodetection at run
// time, and `agents_dir` has no default at all (resolveAgentsDirSetting hard-
// errors). Printing an invented one would be this command's own version of
// "a wrong answer with a plausible face".
const UNSET = "(unset)";
// A layer DID name the key and named it empty. Distinct from UNSET on
// purpose: `"parity_trigger_paths": []` is a repo deliberately disarming the
// parity hunter, and it is the fact §3.2's parser change exists to keep
// distinguishable from silence.
const EMPTY = "(empty)";

function cell(value: string | undefined, source: ConfigSource): ConfigCell {
  return { value: value ?? UNSET, source };
}

function listCell(values: readonly string[], source: ConfigSource): ConfigCell {
  if (source === "default") return { value: UNSET, source };
  return { value: values.length === 0 ? EMPTY : values.join(", "), source };
}

// Path plus weight, never the reason: the reason is prose written for a
// hunter's prompt and would swamp the row. The path is what identifies the
// prior, and the file it came from is one row above.
function priorsCell(
  priors: readonly SuspicionPrior[],
  source: ConfigSource,
): ConfigCell {
  return listCell(
    priors.map((prior) => `${prior.path} (${prior.weight})`),
    source,
  );
}

function routingCell(
  routing: LocalConfig["routing"],
  source: ConfigSource,
): ConfigCell {
  if (source === "default" || routing === undefined) {
    return { value: UNSET, source };
  }
  const mappingsCount = routing.mappings
    ? Array.isArray(routing.mappings)
      ? routing.mappings.length
      : Object.keys(routing.mappings).length
    : 0;
  if (mappingsCount === 0 && routing.default) {
    return {
      value: "default route",
      source,
    };
  }
  if (mappingsCount > 0 && routing.default) {
    return {
      value: `${mappingsCount} mapping${mappingsCount === 1 ? "" : "s"} (+ default)`,
      source,
    };
  }
  return {
    value: `${mappingsCount} mapping${mappingsCount === 1 ? "" : "s"}`,
    source,
  };
}

// One row per key, and the two Records below are what stops a key from
// silently going missing: both are exhaustive over their key union, so adding
// a member to LocalConfig or SummaryConfig fails tsc until it has a cell here.
// The plan card's configTags makes the same promise in a comment ("a direction
// change must not silently drop a key off the card") with a hand-written
// array behind it; a Record is the version a compiler holds. (Judgment ledger
// JD-12 is about the parser's key set, which this does not close — it closes
// the same class for this surface.)
export function configRows(
  effective: LocalConfig,
  sources: ConfigSources,
): ConfigRow[] {
  const cells: Record<ConfigRowKey, ConfigCell> = {
    agents_dir: cell(effective.agents_dir, sources.agents_dir),
    default_base: cell(effective.default_base, sources.default_base),
    parity_trigger_paths: listCell(
      effective.parity_trigger_paths,
      sources.parity_trigger_paths,
    ),
    suspicion_priors: priorsCell(
      effective.suspicion_priors,
      sources.suspicion_priors,
    ),
    routing: routingCell(effective.routing, sources.routing),
    max_verification_steps: cell(
      effective.max_verification_steps?.toString(),
      sources.max_verification_steps,
    ),
    max_concurrent_steps: cell(
      effective.max_concurrent_steps?.toString(),
      sources.max_concurrent_steps,
    ),
    max_changed_lines: cell(
      effective.max_changed_lines?.toString(),
      sources.max_changed_lines,
    ),
    max_changed_files: cell(
      effective.max_changed_files?.toString(),
      sources.max_changed_files,
    ),
    scout: cell(effective.scout?.toString(), sources.scout),
    post: cell(effective.post?.toString(), sources.post),
    ci_review_policy: cell(
      effective.ci_review_policy,
      sources.ci_review_policy,
    ),
    ci_max_attempts: cell(
      effective.ci_max_attempts?.toString(),
      sources.ci_max_attempts,
    ),
    ci_max_reviews: cell(
      effective.ci_max_reviews?.toString(),
      sources.ci_max_reviews,
    ),
    ci_rereview_min_score: cell(
      effective.ci_rereview_min_score?.toString(),
      sources.ci_rereview_min_score,
    ),
    ci_blocking_weight: cell(
      effective.ci_blocking_weight?.toString(),
      sources.ci_blocking_weight,
    ),
    ci_advisory_weight: cell(
      effective.ci_advisory_weight?.toString(),
      sources.ci_advisory_weight,
    ),
    ci_trusted_actors: listCell(
      effective.ci_trusted_actors ?? [],
      sources.ci_trusted_actors,
    ),
    ci_admission_observe_only: cell(
      effective.ci_admission_observe_only?.toString(),
      sources.ci_admission_observe_only,
    ),
  };
  const summaryCells: Record<keyof SummaryConfig, ConfigCell> = {
    enabled: cell(
      effective.summary?.enabled?.toString(),
      sources.summary.enabled,
    ),
    model: cell(effective.summary?.model, sources.summary.model),
  };
  // Object.entries over an object literal keeps declaration order, which is
  // the same guarantee CONFIG_DIRECTION already leans on for its derived key
  // sets. The summary pair lands last rather than in `summary`'s declared
  // slot: an ordering constant that a new key could fall outside of would
  // reintroduce exactly the silent-drop this Record is here to prevent.
  return [
    ...Object.entries(cells).map(([key, value]) => ({ key, ...value })),
    ...Object.entries(summaryCells).map(([key, value]) => ({
      key: `summary.${key}`,
      ...value,
    })),
  ];
}

// The four layer names, padded to one column so the eye can scan them. Derived
// from the ConfigSource union's own members, so a fifth source cannot leave
// the column too narrow to hold it.
const SOURCE_NAMES: readonly ConfigSource[] = [
  "global",
  "repo",
  "capped",
  "default",
];
const SOURCE_WIDTH = labelColumnWidth(SOURCE_NAMES);

// The marker D10 asks for by name ("marks any value a cap narrowed"). The
// `capped` source already says it; this says what it MEANS, because `capped`
// is the one layer name that describes an event rather than a file — the team
// asked for something wider and the global ceiling took it away.
const CAPPED_MARKER = "← narrowed by the global ceiling";

type Painter = (text: string, styles: boolean) => string;

function sourcePainter(source: ConfigSource): Painter {
  switch (source) {
    case "capped":
      return yellow;
    case "global":
      return cyan;
    default:
      // `repo` and `default` are the unsurprising layers, and colouring them
      // would cost the two above the contrast they exist for.
      return dim;
  }
}

const INDENT = 2;

// A value column assembled from spans that are coloured INDEPENDENTLY, so
// that row() never receives a string containing an escape byte.
//
// WHY that invariant, spelled out because breaking it is silent: row() places
// the wrap with raw `value.length`, so escape bytes are counted as visible
// width and a painted row wraps EARLIER than the same row unpainted; then
// wrapText splits on whitespace, which can leave a colour's opening escape on
// one line and its reset on the next — and that colour bleeds into whatever
// the terminal prints after the block. This module shipped with exactly that
// bug: `paintSource(...) + value + yellow(marker)` handed straight to row().
//
// WHY not the established fix — cli.ts's markerRowLines builds the row
// unstyled and paints the whole LINE afterwards (`row(..., { styles: false })
// .map(line => paint(line))`) — a config row has TWO spans coloured
// differently, the layer tag and the cap marker, with an uncoloured value
// between them, and one whole-line painter cannot express that. So the same
// discipline is applied one level down: row() lays out the plain
// concatenation, and the colours go back onto the chunks it hands back.
//
// WHY not fold the layer tag into row()'s label column instead, which would
// dodge the wrap entirely: it moves the layout. A long `agents_dir` already
// wraps at 80 columns today (its value lands on the continuation line), and
// widening the label column would pull it back up onto the first line.
interface Span {
  text: string;
  paint?: Painter;
}

const WHITESPACE = /\s/;

interface SpanRowOptions {
  width: number;
  styles: boolean;
  indent: number;
  labelWidth: number;
}

function spanRow(
  label: string,
  spans: readonly Span[],
  opts: SpanRowOptions,
): string[] {
  const plain = spans.map((span) => span.text).join("");
  // The span each non-whitespace character belongs to, in order. wrapText
  // collapses whitespace, but it never reorders or drops a non-whitespace
  // character — so this sequence is enough to walk any chunk row() returns
  // back to the spans it came from, wrapped or verbatim.
  const anchors: number[] = [];
  spans.forEach((span, index) => {
    for (let i = 0; i < span.text.length; i += 1) {
      if (!WHITESPACE.test(span.text[i])) anchors.push(index);
    }
  });

  // row() is handed styles:false so its head is exactly `indent + labelWidth`
  // characters wide and every chunk is recoverable by slicing there. The
  // label is dimmed below instead, with the same dim() row() would have used.
  const head = " ".repeat(opts.indent) + label.padEnd(opts.labelWidth);
  const valueCol = opts.indent + opts.labelWidth;
  const lines = row(label, plain, {
    width: opts.width,
    styles: false,
    indent: opts.indent,
    labelWidth: opts.labelWidth,
  });

  // The anchor cursor is shared across chunks — each one resumes where the
  // previous stopped — so the chunks MUST be painted in order.
  let cursor = 0;
  const paintChunk = (chunk: string): string => {
    if (chunk.length === 0) return "";
    const ids: number[] = [];
    // Whitespace inherits the span of the character BEFORE it, which is what
    // keeps a padded tag's trailing spaces inside its own colour. Leading
    // whitespace has no such character, so it takes the span the chunk is
    // about to resolve.
    let owner = anchors[cursor] ?? 0;
    for (let i = 0; i < chunk.length; i += 1) {
      if (!WHITESPACE.test(chunk[i])) {
        owner = anchors[cursor] ?? owner;
        cursor += 1;
      }
      ids.push(owner);
    }
    let painted = "";
    let start = 0;
    for (let i = 1; i <= chunk.length; i += 1) {
      if (i < chunk.length && ids[i] === ids[start]) continue;
      const span = spans[ids[start]];
      const text = chunk.slice(start, i);
      painted +=
        span.paint === undefined ? text : span.paint(text, opts.styles);
      start = i;
    }
    return painted;
  };

  return lines.map((line, index) => {
    const first = index === 0;
    const prefix = first
      ? " ".repeat(opts.indent) +
        dim(label.padEnd(opts.labelWidth), opts.styles)
      : " ".repeat(valueCol);
    return prefix + paintChunk(line.slice(first ? head.length : valueCol));
  });
}

function noteLines(text: string, width: number, styles: boolean): string[] {
  return wrapText(text, Math.max(width - INDENT, 20)).map(
    (line) => " ".repeat(INDENT) + dim(line, styles),
  );
}

export function renderConfig(input: ConfigViewInput): string[] {
  const width = input.width ?? terminalWidth();
  const styles = input.styles;
  const rows = configRows(input.effective, input.sources);
  const keyWidth = labelColumnWidth(rows.map((r) => r.key));
  const fileWidth = labelColumnWidth(["global"]);
  const lines: string[] = [bold("pr-hero config", styles), ""];

  for (const [label, filePath, present] of [
    ["repo", input.repoConfigPath, input.repoPresent],
    ["global", input.globalConfigPath, input.globalPresent],
  ] as const) {
    lines.push(
      ...row(label, `${filePath} (${present ? "present" : "absent"})`, {
        width,
        styles,
        indent: INDENT,
        labelWidth: fileWidth,
      }),
    );
  }
  lines.push("");

  for (const entry of rows) {
    // The marker's two leading spaces are their own span so they stay OUTSIDE
    // the yellow, exactly as `value + "  " + yellow(marker)` used to put them.
    const spans: Span[] = [
      {
        text: entry.source.padEnd(SOURCE_WIDTH),
        paint: sourcePainter(entry.source),
      },
      { text: entry.value },
      ...(entry.source === "capped"
        ? [{ text: "  " }, { text: CAPPED_MARKER, paint: yellow }]
        : []),
    ];
    lines.push(
      ...spanRow(entry.key, spans, {
        width,
        styles,
        indent: INDENT,
        labelWidth: keyWidth,
      }),
    );
  }
  lines.push("");

  // The vocabulary, always printed: this command's whole product is the layer
  // column, and a column of words nobody can define is not an answer.
  lines.push(
    ...noteLines(
      "repo beats global, except on a capped key — there the NARROWER value " +
        "wins, so a committed file can spend less of your money but never " +
        "more. capped means the repo asked for the wider value and the " +
        "global ceiling took it away; default means neither file named the " +
        "key, and the resolver's own fallback decides at run time.",
      width,
      styles,
    ),
  );
  lines.push("");
  // The honest limit of "what it prints cannot drift from what actually runs"
  // (judgment ledger JD-10). ConfigSource has no `flag` member and cannot
  // grow one here: flags never enter mergeConfig at all — they are applied
  // AFTER it, by the resolvers — so no row above can ever read `flag`, and a
  // row that named a layer for a flag-decided value would be naming the file
  // that lost. Saying so is the only way the sentence above stays true.
  lines.push(
    ...noteLines(
      "Flags (--base, --model, --agents, --no-summary) and PRHERO_AGENTS_DIR " +
        "are applied after this merge, by the resolvers, so no row above can " +
        "say flag. A review passing one of them uses the flag's value, not " +
        "the layer named here.",
      width,
      styles,
    ),
  );
  return lines;
}
