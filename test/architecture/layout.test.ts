// Domain reorg T2 (odd/tasks/domain-reorg.md): the layout ratchet. Structural
// drift here is invisible to `bun test` and `tsc --noEmit` — a file placed
// back at `src/` root, or dropped into a domain directory with the wrong
// name, still compiles and passes every behavioral test (the task doc's
// demonstrated gap: a flat file mixing `child_process`, raw I/O, and a god
// function passes all 3647 tests and typecheck; biome flags only a style
// nit). This is an rg-style filesystem scan, not a behavioral test — it
// polices WHERE files live, not what they do. Same pattern as the transports
// drift guard in `import-boundaries.test.ts`.
//
// Each entry in MIGRATED_DOMAINS is one already-migrated domain. Later
// domain moves (ui, ci, store, model, ...) append one entry here — the two
// assertions below (absence at src/ root, exact presence in the domain dir)
// are generic over the list, so a new domain never needs new test logic.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";

const SRC_DIR = path.join(import.meta.dir, "../../src");

interface MigratedDomain {
  domain: string;
  // Basenames without the .ts extension, as they live in src/<domain>/.
  files: string[];
}

const MIGRATED_DOMAINS: MigratedDomain[] = [
  {
    domain: "rereview",
    files: ["classify", "identity", "plan", "prepare", "state", "verify"],
  },
  {
    domain: "ui",
    files: [
      "activity",
      "config",
      "config-edit",
      "menu",
      "plan",
      "primitives",
      "progress",
      "result",
      "review-menu",
      "select",
      "tree",
    ],
  },
  {
    domain: "ci",
    files: [
      "admission-ledger",
      "force-comment",
      "gates",
      "outcome",
      "publish",
      "reporter",
      "review-admission",
      "review-policy",
      "review-risk",
      "setup",
      "trigger",
    ],
  },
  {
    domain: "store",
    files: [
      "activity",
      "backfill",
      "backfill-preflight",
      "gc",
      "gc-preflight",
      "metrics",
      "metrics-preflight",
      "preflight",
      "store",
    ],
  },
  {
    domain: "model",
    files: [
      "catalog",
      "exec-snapshots",
      "free-discovery",
      "provider-capabilities",
      "routing",
    ],
  },
  {
    domain: "triage",
    files: ["reply", "triage", "write"],
  },
  {
    domain: "watch",
    files: ["preflight", "watch"],
  },
  {
    domain: "corpus",
    files: ["corpus", "preflight"],
  },
  {
    domain: "mcp",
    files: ["mcp", "preflight"],
  },
  {
    domain: "server",
    files: ["client", "preflight", "server"],
  },
  {
    domain: "compare",
    files: [
      "compare",
      "floor-test",
      "greptile",
      "ledger",
      "martian-adapter",
      "report",
    ],
  },
  {
    domain: "review",
    files: [
      "boundary",
      "dedupe",
      "drafts",
      "findings",
      "findings-conformance",
      "pipeline",
      "preflight",
      "prompt-set",
      "proof-refs",
      "report",
      "review",
      "root-cause",
      "route-preflight",
      "run",
      "scout",
      "size-gate",
      "spec",
      "step-runner",
    ],
  },
  {
    domain: "pr",
    files: [
      "admission",
      "ci-admission-gate",
      "ci-publish",
      "comparison",
      "discovery",
      "inline",
      "plan",
      "pr",
      "posting",
      "preflight",
      "publish-outcome",
      "range",
      "reverts",
      "reverts-preflight",
      "review-pr",
      "status",
      "target",
      "teardown",
      "worktree-setup",
    ],
  },
  {
    domain: "git",
    files: ["git", "identity", "refs"],
  },
];

function srcRootFiles(): string[] {
  return readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name);
}

function domainDirFiles(domain: string): string[] {
  return readdirSync(path.join(SRC_DIR, domain))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.replace(/\.ts$/, ""))
    .sort();
}

describe("layout ratchet: migrated domains stay out of src/ root", () => {
  test("no flat <domain>-*.ts file remains at src/ root", () => {
    const rootFiles = srcRootFiles();
    for (const { domain } of MIGRATED_DOMAINS) {
      const prefix = `${domain}-`;
      const stray = rootFiles.filter((name) => name.startsWith(prefix));
      expect(
        stray,
        `src/ root still has flat ${domain}-*.ts file(s): ${stray.join(", ")}`,
      ).toEqual([]);
    }
  });

  // Gap closed by T3 (odd/tasks/domain-reorg.md): the `<domain>-` prefix check
  // above only catches a stray HYPHENATED file. It says nothing about a BARE
  // `<domain>.ts` at src/ root — a name with no hyphen to match the prefix.
  // rereview (T1) never exposed this hole because it had no bare
  // `rereview.ts` to begin with; ui (T3) does — `src/ui.ts` held the shared
  // terminal primitives and moved to `src/ui/primitives.ts`. Without this
  // check, a forgotten `src/ui.ts` left behind (or reintroduced later) would
  // pass the ratchet green while silently shadowing/duplicating
  // `src/ui/primitives.ts`. Kept generic over MIGRATED_DOMAINS, like the
  // prefix check above, so a future domain with the same shape needs no new
  // test logic.
  test("no bare <domain>.ts file remains at src/ root", () => {
    const rootFiles = srcRootFiles();
    for (const { domain } of MIGRATED_DOMAINS) {
      const bareName = `${domain}.ts`;
      expect(
        rootFiles.includes(bareName),
        `src/ root still has a bare ${bareName} file`,
      ).toBe(false);
    }
  });

  // Sanity: the absence check above only proves the specific `<domain>-`
  // prefix is gone from src/ root — it would pass vacuously forever if a
  // domain move silently failed (files never landed in src/<domain>/ at all,
  // or landed with the wrong names) because there would still be nothing at
  // root matching the prefix. This positive half proves the domain directory
  // actually holds exactly the migrated files, so the ratchet discriminates
  // instead of being trivially green.
  test("each migrated domain directory contains exactly its expected files", () => {
    for (const { domain, files } of MIGRATED_DOMAINS) {
      const actual = domainDirFiles(domain);
      const expected = [...files].sort();
      expect(actual, `src/${domain}/ contents`).toEqual(expected);
    }
  });
});
