// The watcher's reviewed-local set comes from each run dir's findings.json:
// comparison.json is no longer written, so a findings-only run dir
// is the only local evidence that a PR was already reviewed. These tests drive
// the real scanRunDirs against real files in a tmpdir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError } from "../../src/errors";
import { scanRunDirs } from "../../src/watch/watch";

const HEAD = "c".repeat(40);
const BASE = "b".repeat(40);

function findingsDoc(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0.0",
    pr: 1971,
    base_sha: BASE,
    head_sha: HEAD,
    model: "sonnet",
    iteration: 1,
    parity_hunter_fired: false,
    run_status: "complete",
    telemetry: {
      index_ms: 1000,
      index_mode: "fresh",
      index_disk_mb: 12,
      wall_ms: 5000,
      tokens_in: 100,
      tokens_out: 50,
      tokens_total: 150,
      cost_usd_est: 0.5,
    },
    findings: [],
    debug: { refuted: [] },
    ...overrides,
  };
}

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "crysk-scan-runs-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runDir(name: string, findings?: unknown): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  if (findings !== undefined) {
    await writeFile(
      path.join(dir, "findings.json"),
      typeof findings === "string" ? findings : JSON.stringify(findings),
    );
  }
  return dir;
}

describe("scanRunDirs — reviewed-local set comes from findings.json", () => {
  test("a run dir with only findings.json (pr > 0) counts as reviewed", async () => {
    await runDir("pr-1971-run", findingsDoc({ sessionFailed: false }));
    const { localReviews } = await scanRunDirs(root);
    expect(localReviews).toEqual([{ pr: 1971, head: HEAD }]);
  });

  test("a session-failed run (sessionFailed: true) does not count as reviewed", async () => {
    await runDir("pr-1971-failed", findingsDoc({ sessionFailed: true }));
    const { localReviews } = await scanRunDirs(root);
    expect(localReviews).toEqual([]);
  });

  // findings.ts: an absent sessionFailed MUST mean "unknown", never "false".
  // The repo's back-compat rule for that case (commands/post.ts) falls back to
  // run_status: a legacy "complete" document is a finished review.
  test("sessionFailed absent with run_status complete counts as reviewed", async () => {
    await runDir("pr-1971-legacy", findingsDoc({ run_status: "complete" }));
    const { localReviews } = await scanRunDirs(root);
    expect(localReviews).toEqual([{ pr: 1971, head: HEAD }]);
  });

  test("sessionFailed absent with run_status partial does not count as reviewed", async () => {
    await runDir("pr-1971-unknown", findingsDoc({ run_status: "partial" }));
    const { localReviews } = await scanRunDirs(root);
    expect(localReviews).toEqual([]);
  });

  test("a local-mode run (pr: 0) does not count as reviewed", async () => {
    await runDir("local-run", findingsDoc({ pr: 0 }));
    const { localReviews } = await scanRunDirs(root);
    expect(localReviews).toEqual([]);
  });

  test("a run dir without findings.json is skipped but still yields a fact", async () => {
    await runDir("no-findings");
    const { facts, localReviews } = await scanRunDirs(root);
    expect(localReviews).toEqual([]);
    expect(facts.map((f) => f.name)).toEqual(["no-findings"]);
  });

  test("a malformed findings.json throws a CliError naming its path", async () => {
    const dir = await runDir("pr-1971-broken", "{ not json");
    const error = await scanRunDirs(root).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect(
      (error as Error).message.startsWith(path.join(dir, "findings.json")),
    ).toBe(true);
  });

  test("a schema-invalid findings.json throws a CliError naming its path", async () => {
    const dir = await runDir(
      "pr-1971-invalid",
      findingsDoc({ schema_version: "0.9.0" }),
    );
    const error = await scanRunDirs(root).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect(
      (error as Error).message.startsWith(path.join(dir, "findings.json")),
    ).toBe(true);
  });
});
