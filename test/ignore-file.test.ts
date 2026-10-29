// The gitignore dialect `.cryskignore` speaks: parse, translate to
// Bun.Glob-ready globs, and match with per-RULE last-match-wins. Pure,
// offline-tested — nothing here reads a file or shells out.
//
// Escape-passthrough probe (run once, by hand, before these tests were
// written — see the session transcript, not re-run here): `bun -e` against
// this repo's Bun 1.3.14 confirmed Bun.Glob's OWN backslash-escape handling
// already does what gitignore's dialect needs for `\!` and `\#` — this
// parser leaves both untouched and lets Bun.Glob resolve them at match
// time. An escaped trailing space is handled on OUR side instead (the
// escaping backslash is dropped, the space is kept as a plain literal
// character, which needs no escaping of its own):
//   new Bun.Glob("\\!foo").match("!foo")  === true
//   new Bun.Glob("\\#foo").match("#foo")  === true
//   new Bun.Glob("foo\\ ").match("foo ")  === true  (and "foo" === false)
// The tests below assert the OBSERVED behavior, not an assumed one.

import { describe, expect, test } from "bun:test";
import {
  BUILTIN_IGNORE_LINES,
  BUILTIN_IGNORE_RULES,
  compileIgnoreRules,
  IgnoreFileError,
  parseIgnoreFile,
  parseIgnoreLsTree,
} from "../src/ignore-file";

// Compile a single-line rule and report whether `path` is excluded.
function excludes(line: string, path: string): boolean {
  const rules = parseIgnoreFile(line, "user");
  return compileIgnoreRules(rules).match(path) !== undefined;
}

describe("parseIgnoreFile — comments, blank lines, whitespace", () => {
  test("blank lines and comment lines produce no rules", () => {
    const rules = parseIgnoreFile("\n# a comment\n\nfoo\n", "user");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pattern).toBe("foo");
  });

  test("a line of only whitespace reduces to blank, not an empty-pattern rule", () => {
    const rules = parseIgnoreFile("   \nfoo\n", "user");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pattern).toBe("foo");
  });

  test("plain trailing whitespace is stripped", () => {
    const rules = parseIgnoreFile("foo   \n", "user");
    expect(rules[0]?.pattern).toBe("foo");
  });

  // PROBE-DERIVED: Bun.Glob("foo\\ ").match("foo ") === true and
  // Bun.Glob("foo\\ ").match("foo") === false — an escaped trailing space
  // survives as a REAL trailing space in the matched filename.
  test("an escaped trailing space is preserved, not stripped", () => {
    expect(excludes("foo\\ ", "foo ")).toBe(true);
    expect(excludes("foo\\ ", "foo")).toBe(false);
  });

  // PROBE-DERIVED: Bun.Glob("\\#foo").match("#foo") === true.
  test("\\# is a literal hash, not a comment marker", () => {
    const rules = parseIgnoreFile("\\#literal.txt\n", "user");
    expect(rules).toHaveLength(1);
    expect(excludes("\\#literal.txt", "#literal.txt")).toBe(true);
  });

  // PROBE-DERIVED: Bun.Glob("\\!foo").match("!foo") === true.
  test("\\! is a literal bang, not a negation marker", () => {
    const rules = parseIgnoreFile("\\!foo\n", "user");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.negated).toBe(false);
    expect(excludes("\\!foo", "!foo")).toBe(true);
  });

  test("CRLF line endings are handled the same as LF", () => {
    const rules = parseIgnoreFile("foo\r\nbar\r\n", "user");
    expect(rules.map((r) => r.pattern)).toEqual(["foo", "bar"]);
  });
});

describe("parseIgnoreFile — anchoring and trailing-slash matrix", () => {
  // any-depth, no trailing slash: dual-emit (bare form AND contents form).
  test("no slash at all matches at any depth, file and directory contents", () => {
    expect(excludes("node_modules", "node_modules")).toBe(true);
    expect(excludes("node_modules", "src/node_modules")).toBe(true);
    expect(excludes("node_modules", "node_modules/x.ts")).toBe(true);
    expect(excludes("node_modules", "src/node_modules/x.ts")).toBe(true);
  });

  // any-depth, trailing slash: directory-CONTENTS only. A same-named FILE
  // must NOT match — the whole reason the "ONLY" row exists: emitting the
  // bare form too would wrongly match a file that merely shares the name.
  test("a trailing slash restricts to directory contents, never a same-named file", () => {
    expect(excludes("node_modules/", "node_modules")).toBe(false);
    expect(excludes("build/", "src/build")).toBe(false);
    expect(excludes("node_modules/", "node_modules/x.ts")).toBe(true);
  });

  // Trailing-only slash does NOT anchor to the repo root — it only makes
  // the rule directory-only. `frotz/` still matches `a/frotz/x.ts` at any
  // depth, exactly like git's own gitignore(5) `frotz/` vs `doc/frotz/`
  // example: only a slash ELSEWHERE in the pattern anchors it.
  test("a trailing-only slash does not anchor to the repo root", () => {
    expect(excludes("frotz/", "frotz")).toBe(false); // dir-only, not the dir itself as a file
    expect(excludes("frotz/", "a/frotz/x.ts")).toBe(true);
  });

  // Anchored, no trailing slash: dual-emit. This is the case a naive
  // single-glob translation gets wrong — `foo/bar` alone does NOT cover the
  // directory's own contents (verified: Bun.Glob("foo/bar").match("foo/bar/x.ts")
  // === false), so the second glob is a REAL gap, not redundant.
  test("an anchored rule with no trailing slash matches itself AND its contents", () => {
    expect(excludes("/openspec", "openspec")).toBe(true);
    expect(excludes("/openspec", "openspec/changes/x/y.md")).toBe(true);
    expect(excludes("foo/bar", "other/foo/bar")).toBe(false); // anchored to root
  });

  // Anchored, trailing slash: directory-contents ONLY.
  test("an anchored trailing-slash rule matches contents only, not the bare path", () => {
    expect(excludes("doc/frotz/", "doc/frotz")).toBe(false);
    expect(excludes("doc/frotz/", "doc/frotz/x.ts")).toBe(true);
    expect(excludes("/openspec/", "openspec")).toBe(false);
    expect(excludes("/openspec/", "openspec/x.md")).toBe(true);
  });
});

describe("parseIgnoreFile — wildcards, character classes, and **", () => {
  // A pattern with no slash at all matches at ANY depth (that is what
  // "any-depth" means in the anchoring matrix) — so this alone does not
  // isolate the "does not cross /" property. An ANCHORED single-segment
  // wildcard does: `docs/*.md` must match a file directly under `docs/`,
  // never one nested further, because `*` cannot span the `sub/` boundary.
  test("* and ? do not cross a path separator", () => {
    expect(excludes("*.md", "a.md")).toBe(true);
    expect(excludes("docs/*.md", "docs/a.md")).toBe(true);
    expect(excludes("docs/*.md", "docs/sub/a.md")).toBe(false);
    expect(excludes("a?.txt", "ab.txt")).toBe(true);
    expect(excludes("a?.txt", "a/b.txt")).toBe(false);
  });

  // The any-depth semantics themselves, stated as their own assertion: a
  // pattern with no slash excludes matching files at EVERY depth, not just
  // the repo root — this is standard gitignore behavior, not a Bun.Glob
  // quirk, and it is why the any-depth translation prefixes `**/`.
  test("a no-slash pattern matches at every depth, not only the root", () => {
    expect(excludes("*.md", "docs/a.md")).toBe(true);
  });

  test("character classes work", () => {
    expect(excludes("[a-c].txt", "b.txt")).toBe(true);
    expect(excludes("[a-c].txt", "d.txt")).toBe(false);
  });

  // Middle `**` matches ZERO directories too, not only one-or-more.
  test("a middle ** matches zero directories as well as deeper ones", () => {
    expect(excludes("a/**/b", "a/b")).toBe(true);
    expect(excludes("a/**/b", "a/x/b")).toBe(true);
    expect(excludes("a/**/b", "a/x/y/b")).toBe(true);
  });

  test("three or more consecutive asterisks are tolerated, not rejected", () => {
    expect(() => parseIgnoreFile("***/foo\n", "user")).not.toThrow();
    expect(excludes("***/foo", "a/foo")).toBe(true);
  });
});

describe("parseIgnoreFile — literal brace auto-escaping", () => {
  // gitignore has no brace syntax; Bun.Glob reads {a,b} as alternation.
  // Verified directly: Bun.Glob("{a,b}.md").match("{a,b}.md") === false and
  // Bun.Glob("{a,b}.md").match("a.md") === true — the OPPOSITE of what a
  // gitignore-faithful translation must do.
  test("an unescaped brace is matched literally, never as alternation", () => {
    expect(excludes("{a,b}.md", "{a,b}.md")).toBe(true);
    expect(excludes("{a,b}.md", "a.md")).toBe(false);
    expect(excludes("{a,b}.md", "b.md")).toBe(false);
  });

  test("a user-escaped brace is also matched literally", () => {
    expect(excludes("\\{a,b\\}.md", "{a,b}.md")).toBe(true);
    expect(excludes("\\{a,b\\}.md", "a.md")).toBe(false);
  });
});

describe("parseIgnoreFile — negation and rule-level last-match-wins", () => {
  // THE ORDER-SWAP TEST. A single negation example cannot distinguish a
  // correct per-RULE last-match-wins matcher from a broken `.some()`-based
  // one: both would re-include `docs/a.md` for the ORIGINAL order alone.
  // Swapping the order must produce the OPPOSITE answer — that is the only
  // thing that proves order (not "any rule matched") decides the outcome.
  test("rule order changes the outcome — proves last-match-wins, not .some()", () => {
    const forward = compileIgnoreRules([
      ...parseIgnoreFile("*.md", "user"),
      ...parseIgnoreFile("!docs/a.md", "user"),
    ]);
    expect(forward.match("docs/a.md")).toBeUndefined(); // included

    const swapped = compileIgnoreRules([
      ...parseIgnoreFile("!docs/a.md", "user"),
      ...parseIgnoreFile("*.md", "user"),
    ]);
    expect(swapped.match("docs/a.md")).toBeDefined(); // excluded — opposite
  });

  test("a user rule re-includes a built-in default", () => {
    const rules = [
      ...BUILTIN_IGNORE_RULES,
      ...parseIgnoreFile("!**/Cargo.lock", "user"),
    ];
    expect(compileIgnoreRules(rules).match("Cargo.lock")).toBeUndefined();
  });
});

describe("parseIgnoreFile — deviation from git's re-inclusion restriction", () => {
  // gitignore(5), quoted verbatim: "It is not possible to re-include a file
  // if a parent directory of that file is excluded. Git doesn't list
  // excluded directories for performance reasons, so any patterns on
  // contained files have no effect, no matter where they are defined."
  //
  // pr-hero does NOT walk a tree — it matches a FINITE DIFF FILE LIST, so
  // there is no directory-listing optimization to protect, and a `!` rule
  // CAN re-include a file under an excluded parent. This is a deliberate
  // deviation from git parity, not a bug: nobody should "fix" this matcher
  // to reject re-inclusion the way git does.
  test("a negated rule re-includes a file under an excluded parent directory", () => {
    const rules = [
      ...parseIgnoreFile("docs/", "user"),
      ...parseIgnoreFile("!docs/keep.md", "user"),
    ];
    const matcher = compileIgnoreRules(rules);
    expect(matcher.match("docs/keep.md")).toBeUndefined(); // re-included
    // Proves rule 1 actually excludes files under docs/ — the re-inclusion
    // above is not just "rule 1 never matched in the first place".
    expect(matcher.match("docs/other.md")).toBeDefined();
  });
});

describe("parseIgnoreFile — loud rejection of invalid patterns", () => {
  // Deliberately narrower than gitignore(5): git leaves a trailing backslash
  // undefined, and Bun.Glob itself does NOT throw for one — it silently
  // matches nothing (verified: new Bun.Glob("foo\\").match("foo") === false,
  // with no exception). A silent no-op exclusion is exactly the failure
  // mode this parser exists to make loud instead.
  test("a trailing unescaped backslash aborts loudly, naming file/line/text", () => {
    const text = "a\nb\nfoo\\\nc\n";
    let caught: unknown;
    try {
      parseIgnoreFile(text, "user");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IgnoreFileError);
    const err = caught as IgnoreFileError;
    expect(err.line).toBe(3);
    expect(err.text).toBe("foo\\");
    expect(err.message).toContain(".cryskignore");
    expect(err.message).toContain("3");
    expect(err.message).toContain("foo\\");
  });

  // Undocumented by gitignore(5): a bare "/" names nothing to anchor to.
  test("a bare / aborts loudly", () => {
    let caught: unknown;
    try {
      parseIgnoreFile("/\n", "user");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IgnoreFileError);
    expect((caught as IgnoreFileError).line).toBe(1);
    expect((caught as IgnoreFileError).text).toBe("/");
  });

  // Undocumented by gitignore(5): a bare "!" negates nothing.
  test("a bare ! aborts loudly", () => {
    let caught: unknown;
    try {
      parseIgnoreFile("!\n", "user");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IgnoreFileError);
    expect((caught as IgnoreFileError).line).toBe(1);
    expect((caught as IgnoreFileError).text).toBe("!");
  });

  // A present-but-malformed file aborts the WHOLE file, not just the bad
  // line — none of the 5 valid lines around it may silently take effect.
  test("one bad line aborts the entire file, not just that line", () => {
    const text = "a\nb\nc\n!\nd\ne\n";
    expect(() => parseIgnoreFile(text, "user")).toThrow(IgnoreFileError);
  });
});

describe("IgnoreRule — data, not a closure", () => {
  test("rules compare with toEqual, and the pattern is the source line", () => {
    const rules = parseIgnoreFile("vendor/**\n", "user");
    expect(rules).toEqual([
      {
        pattern: "vendor/**",
        negated: false,
        globs: expect.any(Array),
        source: "user",
        line: 1,
      },
    ]);
  });

  test("builtin rules carry no line number; user rules are 1-based", () => {
    expect(BUILTIN_IGNORE_RULES[0]?.line).toBeUndefined();
    const rules = parseIgnoreFile("a\nb\n", "user");
    expect(rules[0]?.line).toBe(1);
    expect(rules[1]?.line).toBe(2);
  });

  // The 9 defaults are gitignore LINES through the SAME parser as user
  // rules, not hand-written globs — a user `!bun.lock` textually mirrors
  // the builtin it negates.
  test("the 9 builtins are produced by the same parser as user rules", () => {
    expect(BUILTIN_IGNORE_LINES).toHaveLength(9);
    expect(BUILTIN_IGNORE_RULES).toEqual(
      parseIgnoreFile(BUILTIN_IGNORE_LINES.join("\n"), "builtin"),
    );
    const bunLockRule = BUILTIN_IGNORE_RULES.find(
      (r) => r.pattern === "bun.lock",
    );
    if (bunLockRule === undefined) throw new Error("expected a bun.lock rule");
    const negated = parseIgnoreFile("!bun.lock\n", "user")[0];
    if (negated === undefined) throw new Error("expected a negated rule");
    expect(negated.pattern).toBe(bunLockRule.pattern);
  });
});

describe("parseIgnoreLsTree", () => {
  test("empty stdout is absent, not an error", () => {
    expect(parseIgnoreLsTree("")).toEqual({ kind: "absent" });
    expect(parseIgnoreLsTree("   \n")).toEqual({ kind: "absent" });
  });

  test("a regular-file mode is a blob, with its sha", () => {
    const sha = "a".repeat(40);
    const stdout = `100644 blob ${sha}\t.cryskignore\n`;
    expect(parseIgnoreLsTree(stdout)).toEqual({ kind: "blob", sha });
  });

  test("an executable-file mode is also a blob", () => {
    const sha = "b".repeat(40);
    const stdout = `100755 blob ${sha}\t.cryskignore\n`;
    expect(parseIgnoreLsTree(stdout)).toEqual({ kind: "blob", sha });
  });

  // The symlink hazard: a root symlink commits as `120000 blob <sha>`, and
  // `cat-file blob` on it returns the link TARGET, not ignore patterns.
  test("a symlink mode is rejected, never treated as a blob", () => {
    const sha = "c".repeat(40);
    const stdout = `120000 blob ${sha}\t.cryskignore\n`;
    expect(parseIgnoreLsTree(stdout)).toEqual({
      kind: "reject",
      mode: "120000",
    });
  });

  test("a directory (submodule tree) mode is rejected", () => {
    const stdout = `040000 tree ${"d".repeat(40)}\t.cryskignore\n`;
    expect(parseIgnoreLsTree(stdout)).toEqual({
      kind: "reject",
      mode: "040000",
    });
  });

  test("a gitlink (submodule commit) mode is rejected", () => {
    const stdout = `160000 commit ${"e".repeat(40)}\t.cryskignore\n`;
    expect(parseIgnoreLsTree(stdout)).toEqual({
      kind: "reject",
      mode: "160000",
    });
  });
});

// Case sensitivity: DELIBERATE, pinned here so it cannot flip silently (a
// future matcher swap, or Bun changing a default, would otherwise pass every
// existing test while quietly changing this). Matches git's own behavior —
// git tracks paths case-sensitively regardless of the filesystem — and
// DELIBERATELY diverges from the `ignore` npm package's case-INSENSITIVE
// default, which is where most JS users' intuitions come from (its README
// documents that as its own deviation from git). Probed directly at THIS
// layer (compileIgnoreRules(parseIgnoreFile(...)), never bare Bun.Glob:
// probing the primitive in isolation answers a different question than
// probing it through the actual translation pipeline (see the order-swap /
// re-inclusion lessons elsewhere in this file) — on Bun 1.3.14:
// `**/README.md` vs `readme.md` => false, `**/*.MD` vs `a.md` => false.
describe("case sensitivity — deliberate, matches git, diverges from `ignore`", () => {
  test("a pattern does not match a differently-cased path", () => {
    expect(excludes("README.md", "readme.md")).toBe(false);
    expect(excludes("readme.md", "README.md")).toBe(false);
  });

  test("a case-varying extension pattern does not match", () => {
    expect(excludes("*.MD", "a.md")).toBe(false);
    expect(excludes("*.md", "a.MD")).toBe(false);
  });

  test("an exact-case match still fires", () => {
    expect(excludes("README.md", "README.md")).toBe(true);
  });
});

// A trailing-slash rule is directory-only, so it emits ONLY `**/<name>/**`
// — content after the directory name. A SUBMODULE BUMP is the case that
// makes this reachable rather than theoretical: git reports a gitlink as a
// bare directory-shaped path (`git diff --numstat` emits `1 1 sub`, the
// patch header is `diff --git a/sub b/sub` with mode 160000), so it arrives
// here as the string "sub" with nothing after it.
//
// The first assertion pins a real user-visible gap: `sub/` does NOT ignore
// submodule bumps. The second pins the workaround that does. Both are here
// because ignore-file.ts once claimed this case was unreachable, and an
// unreachability claim is precisely what stops the next person from testing
// it — the differential suite cannot cover it either, since its scratch
// repo has no submodule.
describe("bare directory-shaped paths — the submodule gitlink case", () => {
  test("a trailing-slash rule does not match a bare gitlink path", () => {
    expect(excludes("sub/", "sub")).toBe(false);
    expect(excludes("vendor/lib/", "vendor/lib")).toBe(false);
  });

  test("the no-trailing-slash form is the workaround, and it does match", () => {
    expect(excludes("sub", "sub")).toBe(true);
    expect(excludes("vendor/lib", "vendor/lib")).toBe(true);
  });

  test("both forms still cover paths nested under the directory", () => {
    expect(excludes("sub/", "sub/a.ts")).toBe(true);
    expect(excludes("sub", "sub/a.ts")).toBe(true);
  });
});
