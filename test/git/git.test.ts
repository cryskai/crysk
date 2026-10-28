import { describe, expect, test } from "bun:test";
import {
  type GitRunner,
  parseNameOnly,
  readBaseRefIgnoreRules,
} from "#git/git";

// Fake GitRunner: records every call's repo+args (in order) and answers from
// a small script keyed on the git subcommand — enough to discriminate
// absent-vs-failure and to PROVE a rejected/absent branch never falls
// through to a second call (the retry/fallback bug a bare "it throws"
// assertion would miss).
function fakeGit(
  script: (
    args: string[],
  ) => { ok: boolean; stdout?: string; stderr?: string } | null,
): { runner: GitRunner; calls: { repo: string; args: string[] }[] } {
  const calls: { repo: string; args: string[] }[] = [];
  const runner: GitRunner = async (repo, args) => {
    calls.push({ repo, args });
    const scripted = script(args);
    if (scripted === null) {
      throw new Error(`unscripted git call: ${args.join(" ")}`);
    }
    return {
      ok: scripted.ok,
      stdout: scripted.stdout ?? "",
      stderr: scripted.stderr ?? "",
    };
  };
  return { runner, calls };
}

describe("readBaseRefIgnoreRules — the base-ref read (CI mode, design D2)", () => {
  const SHA = "a".repeat(40);
  const LEGACY = ".prheroignore";

  test("absent at base ref (ls-tree exit 0, empty stdout for both names): defaults only, no error, no cat-file call", async () => {
    const { runner, calls } = fakeGit((args) =>
      args[0] === "ls-tree" ? { ok: true, stdout: "" } : null,
    );
    const result = await readBaseRefIgnoreRules(runner, "/repo", SHA);
    expect(result).toEqual({ rules: [], found: false });
    expect(calls.map((c) => c.args.at(-1))).toEqual([
      ".cryskignore",
      ".prheroignore",
    ]);
    expect(calls[0]?.repo).toBe("/repo");
    expect(calls[0]?.args).toContain("--full-tree");
    expect(calls[0]?.args).toContain(SHA);
    expect(calls.some((c) => c.args[0] === "cat-file")).toBe(false);
  });

  test("ls-tree lookup failure (non-zero exit): loud abort, zero cat-file calls, never falls back to defaults", async () => {
    const { runner, calls } = fakeGit((args) =>
      args[0] === "ls-tree"
        ? { ok: false, stderr: "fatal: bad revision" }
        : null,
    );
    await expect(readBaseRefIgnoreRules(runner, "/repo", SHA)).rejects.toThrow(
      /lookup failed/,
    );
    expect(calls.filter((c) => c.args[0] === "cat-file")).toHaveLength(0);
  });

  test("valid blob (mode 100644): reads via cat-file and parses as user rules", async () => {
    const blobSha = "b".repeat(40);
    const { runner } = fakeGit((args) => {
      if (args[0] === "ls-tree") {
        return {
          ok: true,
          stdout:
            args.at(-1) === LEGACY ? `100644 blob ${blobSha}\t${LEGACY}` : "",
        };
      }
      if (args[0] === "cat-file") return { ok: true, stdout: "vendor/**\n" };
      return null;
    });
    const result = await readBaseRefIgnoreRules(runner, "/repo", SHA);
    expect(result.found).toBe(true);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.pattern).toBe("vendor/**");
  });

  test("mode 100755 (executable) is accepted the same as 100644", async () => {
    const blobSha = "b".repeat(40);
    const { runner } = fakeGit((args) => {
      if (args[0] === "ls-tree") {
        return { ok: true, stdout: `100755 blob ${blobSha}\t${args.at(-1)}` };
      }
      if (args[0] === "cat-file") return { ok: true, stdout: "vendor/**\n" };
      return null;
    });
    expect((await readBaseRefIgnoreRules(runner, "/repo", SHA)).found).toBe(
      true,
    );
  });

  test.each([["120000"], ["040000"], ["160000"]])(
    "mode %s is rejected, never read as a blob — the link/tree/gitlink hazard",
    async (mode) => {
      const { runner, calls } = fakeGit((args) =>
        args[0] === "ls-tree"
          ? {
              ok: true,
              stdout: `${mode} blob ${"c".repeat(40)}\t.prheroignore`,
            }
          : null,
      );
      await expect(
        readBaseRefIgnoreRules(runner, "/repo", SHA),
      ).rejects.toThrow(new RegExp(`mode ${mode}`));
      expect(calls.filter((c) => c.args[0] === "cat-file")).toHaveLength(0);
    },
  );

  test("cat-file failure: loud abort", async () => {
    const blobSha = "b".repeat(40);
    const { runner } = fakeGit((args) => {
      if (args[0] === "ls-tree") {
        return { ok: true, stdout: `100644 blob ${blobSha}\t${args.at(-1)}` };
      }
      if (args[0] === "cat-file") {
        return { ok: false, stderr: "fatal: bad object" };
      }
      return null;
    });
    await expect(readBaseRefIgnoreRules(runner, "/repo", SHA)).rejects.toThrow(
      /blob read failed/,
    );
  });

  test("malformed blob content: loud abort naming the <sha>:<file read> locator", async () => {
    const blobSha = "b".repeat(40);
    const { runner } = fakeGit((args) => {
      if (args[0] === "ls-tree") {
        return { ok: true, stdout: `100644 blob ${blobSha}\t${args.at(-1)}` };
      }
      if (args[0] === "cat-file") return { ok: true, stdout: "ok/**\n!\n" };
      return null;
    });
    await expect(readBaseRefIgnoreRules(runner, "/repo", SHA)).rejects.toThrow(
      new RegExp(`^${SHA}:\\.cryskignore:2:`),
    );
  });

  // The rename's read order: .cryskignore first, the legacy name only when the
  // new one is absent at that ref.
  test(".cryskignore present: it is read, the legacy name is never asked for", async () => {
    const blobSha = "b".repeat(40);
    const { runner, calls } = fakeGit((args) => {
      if (args[0] === "ls-tree") {
        return { ok: true, stdout: `100644 blob ${blobSha}\t.cryskignore` };
      }
      if (args[0] === "cat-file") return { ok: true, stdout: "new/**\n" };
      return null;
    });
    const result = await readBaseRefIgnoreRules(runner, "/repo", SHA);
    expect(result.rules[0]?.pattern).toBe("new/**");
    expect(calls.filter((c) => c.args[0] === "ls-tree")).toHaveLength(1);
  });

  test("only .prheroignore present: it is read exactly as before", async () => {
    const blobSha = "b".repeat(40);
    const { runner } = fakeGit((args) => {
      if (args[0] === "ls-tree") {
        return {
          ok: true,
          stdout:
            args.at(-1) === LEGACY ? `100644 blob ${blobSha}\t${LEGACY}` : "",
        };
      }
      if (args[0] === "cat-file") return { ok: true, stdout: "old/**\n" };
      return null;
    });
    const result = await readBaseRefIgnoreRules(runner, "/repo", SHA);
    expect(result).toMatchObject({ found: true });
    expect(result.rules[0]?.pattern).toBe("old/**");
  });

  test("a malformed legacy file names .prheroignore, the file actually read", async () => {
    const blobSha = "b".repeat(40);
    const { runner } = fakeGit((args) => {
      if (args[0] === "ls-tree") {
        return {
          ok: true,
          stdout:
            args.at(-1) === LEGACY ? `100644 blob ${blobSha}\t${LEGACY}` : "",
        };
      }
      if (args[0] === "cat-file") return { ok: true, stdout: "ok/**\n!\n" };
      return null;
    });
    await expect(readBaseRefIgnoreRules(runner, "/repo", SHA)).rejects.toThrow(
      new RegExp(`^${SHA}:\\.prheroignore:2:`),
    );
  });

  test("an unusable .cryskignore aborts; it never falls through to the legacy file", async () => {
    const { runner, calls } = fakeGit((args) =>
      args[0] === "ls-tree"
        ? { ok: true, stdout: `120000 blob ${"c".repeat(40)}\t.cryskignore` }
        : null,
    );
    await expect(readBaseRefIgnoreRules(runner, "/repo", SHA)).rejects.toThrow(
      /\.cryskignore at .* has mode 120000/,
    );
    expect(calls).toHaveLength(1);
  });
});

describe("parseNameOnly", () => {
  test("sorts, trims, and drops blanks and duplicates", () => {
    expect(parseNameOnly("src/b.ts\n\nsrc/a.ts\nsrc/b.ts\n")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });
});
