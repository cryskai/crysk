// The prompt set's IDENTITY, and it exists for one claim: M6's write-up will
// say "both arms ran the same prompt set". Until M5 that was believed —
// review/findings.ts declared `prompt_set` and nothing ever populated it — and a
// believed claim is what an A/B is least able to survive being wrong about.
//
// The algorithm is the lab's, ported rather than re-invented
// (`../deep-review/runner/session.ts`): sha256 over the concatenated file
// TEXTS in the given order, truncated to 16 hex. Truncation length, hash and
// order are all load-bearing — changing any one silently moves every
// fingerprint recorded on either side of the boundary.

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseAgentFile,
  parseAgentSource,
  promptSetFingerprint,
  promptSetIdentity,
  renderAgentBody,
} from "#review/prompt-set";

async function setDir(
  files: Record<string, string>,
  prefix = "pr-hero-set-",
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  for (const [name, body] of Object.entries(files)) {
    await Bun.write(path.join(dir, name), body);
  }
  return dir;
}

// PR #464 F002: the instructions text is the repo owner's (and, on a
// pull_request run, the PR author's). String replacements read `$$`, `$&`,
// `` $` `` and `$'` as patterns, which halved dollar-quoting and spliced the
// body around the anchor into the block. The text must arrive verbatim.
describe("renderAgentBody", () => {
  test("inserts gotchas and priors text verbatim, `$` patterns included", () => {
    const gotchas =
      "SQL uses $$dollar quoting$$; $& and $' and $` stay as typed.";
    const out = renderAgentBody("before\n{{GOTCHAS}}\nafter\n{{PRIORS}}", {
      priors: [{ path: "src/$&.ts", weight: "high", reason: "$$ cost" }],
      gotchas,
      nonce: "abcd1234",
    });
    expect(out).toContain(`<gotchas abcd1234>\n${gotchas}`);
    expect(out).toContain("- src/$&.ts (weight high): $$ cost");
    expect(out).not.toContain("{{");
    expect(out.split("before").length).toBe(2);
  });
});

describe("promptSetFingerprint", () => {
  test("is stable for the same bytes and 16 hex chars wide", async () => {
    const dir = await setDir({ "a.md": "alpha", "b.md": "beta" });
    const files = [path.join(dir, "a.md"), path.join(dir, "b.md")];

    const first = await promptSetFingerprint(files);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await promptSetFingerprint(files)).toBe(first);
  });

  test("ORDER is part of the identity, which is why the caller supplies it", async () => {
    // Same files, different order = different concatenation = different hash.
    // The caller passes the ReviewSpec's declaration order for exactly this
    // reason; a directory listing would make the fingerprint depend on the
    // filesystem.
    const dir = await setDir({ "a.md": "alpha", "b.md": "beta" });
    const a = path.join(dir, "a.md");
    const b = path.join(dir, "b.md");

    expect(await promptSetFingerprint([a, b])).not.toBe(
      await promptSetFingerprint([b, a]),
    );
  });

  test("one changed byte in one file moves it", async () => {
    const before = await setDir({ "a.md": "alpha", "b.md": "beta" });
    const after = await setDir({ "a.md": "alpha", "b.md": "betb" });

    expect(
      await promptSetFingerprint([
        path.join(before, "a.md"),
        path.join(before, "b.md"),
      ]),
    ).not.toBe(
      await promptSetFingerprint([
        path.join(after, "a.md"),
        path.join(after, "b.md"),
      ]),
    );
  });

  test("concatenation is unseparated, matching the lab's hasher exactly", async () => {
    // A separator would be a silent divergence: the same four agent files
    // would fingerprint differently here and there, and the two sides could
    // never be compared again. Pinned against a hand-computed digest.
    const dir = await setDir({ "a.md": "alpha", "b.md": "beta" });
    const expected = new Bun.CryptoHasher("sha256")
      .update("alphabeta")
      .digest("hex")
      .slice(0, 16);

    expect(
      await promptSetFingerprint([
        path.join(dir, "a.md"),
        path.join(dir, "b.md"),
      ]),
    ).toBe(expected);
  });
});

describe("promptSetIdentity", () => {
  test("names the directory and fingerprints the files", async () => {
    const dir = await setDir({ "a.md": "alpha" }, "baseline-");
    const identity = await promptSetIdentity(dir, [path.join(dir, "a.md")]);

    expect(identity.name).toBe(path.basename(dir));
    expect(identity.sha256).toBe(
      await promptSetFingerprint([path.join(dir, "a.md")]),
    );
  });

  // The compiled binary has no prompt-set directory to take a name from — its
  // prompts are embedded at hashed, flattened paths. It must still report
  // "default", byte-identical to what dev and npm derive from prompts/default,
  // or the same prompt set would name itself differently in three runtimes and
  // every cross-run comparison of `prompt_set` would split into three rows.
  test("an explicit name overrides the directory basename", async () => {
    const dir = await setDir({ "a.md": "alpha" }, "bunfs-root-");
    const identity = await promptSetIdentity(
      "bundled default (from engine)",
      [path.join(dir, "a.md")],
      "default",
    );

    expect(identity.name).toBe("default");
    expect(identity.sha256).toBe(
      await promptSetFingerprint([path.join(dir, "a.md")]),
    );
  });

  test("a trailing slash does not become the name", async () => {
    // `agents/baseline/` and `agents/baseline` are the same set, and a ledger
    // that split them into two rows would be counting one arm twice.
    const dir = await setDir({ "a.md": "alpha" });
    const identity = await promptSetIdentity(`${dir}/`, [
      path.join(dir, "a.md"),
    ]);

    expect(identity.name).toBe(path.basename(dir));
  });
});

describe("agent frontmatter effort", () => {
  const agent = (frontmatter: string): string =>
    `---\nname: a\n${frontmatter}\n---\nbody\n`;

  test("parses an optional `effort:` key beside `model:`", () => {
    const parsed = parseAgentSource(agent("model: sonnet\neffort: xhigh"));
    expect(parsed.model).toBe("sonnet");
    expect(parsed.effort).toBe("xhigh");
  });

  test("an omitted key stays absent, so the engine's per-role default applies", () => {
    const parsed = parseAgentSource(agent("model: sonnet"));
    expect("effort" in parsed).toBe(false);
  });

  test("an unknown level fails loud and names the closed vocabulary", () => {
    expect(() => parseAgentSource(agent("effort: turbo"))).toThrow(
      /effort "turbo".*low, medium, high, xhigh, max/,
    );
  });

  test("a present-but-empty key is a malformed frontmatter, not an omission", () => {
    expect(() => parseAgentSource(agent("effort:"))).toThrow(/effort/);
  });

  test("parseAgentFile names the offending file", async () => {
    const dir = await setDir({ "bad-hunter.md": agent("effort: turbo") });
    const file = path.join(dir, "bad-hunter.md");
    await expect(parseAgentFile(file)).rejects.toThrow(file);
    await expect(parseAgentFile(file)).rejects.toThrow(/effort "turbo"/);
  });
});
