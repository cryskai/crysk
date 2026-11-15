// odd/tasks/antigravity-oauth.md T4b (S5, L17): `.gitignore` for the search
// MCP's walks, close to what ripgrep does for Claude's Grep. Pure: callers
// hand it a file's text (confine.ts reads it, confined like any other file).
//
// The dialect is the engine's own (src/ignore-file.ts): each line goes through
// parseIgnoreFile and each rule is matched with compileIgnoreRules. What this
// file adds is what a TREE WALK needs and a flat diff list never did:
//  - layers: every `.gitignore` applies to paths relative to its own
//    directory, and a deeper file overrides a shallower one. Within one file
//    the last matching rule wins, and `!` re-includes. compileIgnoreRules'
//    match() returns undefined both for "nothing matched" and "the last match
//    was a negation", which cannot say whether a deeper file decided, so each
//    rule is compiled alone (as a positive rule) and the order is walked here;
//  - entries, not contents: parseIgnoreFile emits each rule's own glob plus a
//    `<glob>/**` form that matches everything under a matched directory. A
//    walk prunes an ignored directory instead, so only the entry's own form
//    is used. That is also what lets a path the model names explicitly be
//    searched with everything under it, as ripgrep does (`rg x build/` where
//    `build/` is ignored), while rules still apply below it;
//  - directory-only rules (`build/`): matched against directories only, which
//    a walk knows and a path string does not (ignore-file.ts's KNOWN
//    DIVERGENCE does not arise here).
//
// A line parseIgnoreFile refuses (a bare `!`, a bare `/`, a trailing
// backslash) is skipped, as git skips what it cannot use: a repository's
// `.gitignore` never breaks a search or reaches the model as an error.
// Matching is case-sensitive, like git on Linux (ignore-file.ts's header).
import {
  compileIgnoreRules,
  IgnoreFileError,
  type IgnoreMatcher,
  type IgnoreRule,
  parseIgnoreFile,
} from "../ignore-file";

export const GITIGNORE_NAME = ".gitignore";

interface EntryRule {
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly matcher: IgnoreMatcher;
}

export interface GitignoreLayer {
  // The directory the file sits in, repo-relative ("" for the root).
  readonly baseRel: string;
  readonly rules: readonly EntryRule[];
}

// The entry's own glob out of parseIgnoreFile's emission: [own, own/**] for a
// plain rule, [own/**] for a directory-only one. A shape this file does not
// recognise drops the rule, so a change there searches more, never less.
function entryRule(rule: IgnoreRule): EntryRule | undefined {
  const directoryOnly = rule.pattern.endsWith("/");
  const [first, second] = rule.globs;
  if (first === undefined) return undefined;
  let own: string;
  if (directoryOnly) {
    if (rule.globs.length !== 1 || !first.endsWith("/**")) return undefined;
    own = first.slice(0, -"/**".length);
  } else {
    if (rule.globs.length !== 2 || second !== `${first}/**`) return undefined;
    own = first;
  }
  return {
    negated: rule.negated,
    directoryOnly,
    matcher: compileIgnoreRules([{ ...rule, negated: false, globs: [own] }]),
  };
}

export function parseGitignore(
  text: string,
  baseRel: string,
): GitignoreLayer | undefined {
  const rules: EntryRule[] = [];
  for (const line of text.split("\n")) {
    let parsed: IgnoreRule[];
    try {
      parsed = parseIgnoreFile(line, "user", GITIGNORE_NAME);
    } catch (error) {
      if (error instanceof IgnoreFileError) continue;
      throw error;
    }
    for (const rule of parsed) {
      const entry = entryRule(rule);
      if (entry !== undefined) rules.push(entry);
    }
  }
  return rules.length === 0 ? undefined : { baseRel, rules };
}

// True when the deepest layer with a matching rule says ignore. `rel` is the
// entry's repo-relative path; every layer is one of its ancestors.
export function isGitignored(
  layers: readonly GitignoreLayer[],
  rel: string,
  isDirectory: boolean,
): boolean {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i] as GitignoreLayer;
    const subject =
      layer.baseRel === "" ? rel : rel.slice(layer.baseRel.length + 1);
    let decision: boolean | undefined;
    for (const rule of layer.rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.matcher.match(subject) !== undefined) decision = !rule.negated;
    }
    if (decision !== undefined) return decision;
  }
  return false;
}
