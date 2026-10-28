// Integration tests for the Canonical Product Store Local Server & Typed Client (Slice 2).
// Tests HTTP RPC over Unix Domain Socket: health check, run ingestion, document export,
// usage aggregation, finding searches, and 404 / error boundaries.
//
// 100% offline, temporary DB and Unix domain socket per test.

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Finding, FindingsDocument } from "#review/findings";
import type { PerAgentUsage } from "#review/pipeline";
import { ProductStoreClient } from "#server/client";
import { startProductStoreServer } from "#server/server";
import {
  CURRENT_PRODUCT_SCHEMA_VERSION,
  projectCompleteRun,
} from "#store/preflight";

async function tmpServerEnv(): Promise<{
  dbPath: string;
  socketPath: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "pr-hero-server-"));
  return {
    dbPath: path.join(dir, "prhero.db"),
    socketPath: path.join(dir, "store.sock"),
  };
}

function sampleFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    category: 2,
    path: "src/engine.ts",
    line: 42,
    symbol: "startEngine",
    severity: "CRITICAL",
    evidence_class: "deterministic",
    refuter_verdict: "corroborated",
    causal_disposition: "introduced",
    claim: "Resource leak in timeout handler without cleanup",
    proof_refs: ["src/engine.ts:42-45"],
    hunter: "lifecycle",
    tier: "blocking",
    hops_used: 1,
    hop_trail: [
      {
        step: 1,
        kind: "symbol_search",
        query: "startEngine",
        reached: "src/engine.ts:40",
      },
    ],
    dedupe_key: "src/engine.ts:42:lifecycle",
    root_cause_id: "RC001",
    ...overrides,
  };
}

function sampleDoc(
  overrides: Partial<FindingsDocument> = {},
): FindingsDocument {
  return {
    schema_version: "1.0.0",
    pr: 42,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    model: "sonnet",
    iteration: 1,
    parity_hunter_fired: true,
    run_status: "complete",
    sessionFailed: false,
    summary: {
      prose: "Found 1 critical lifecycle defect.",
      score: 4,
      score_reason: "High quality findings.",
    },
    telemetry: {
      index_ms: 100,
      index_mode: "sync",
      index_disk_mb: 10,
      wall_ms: 3000,
      tokens_in: 5000,
      tokens_out: 500,
      tokens_total: 5500,
      cost_usd_est: 0.2,
      per_agent: {
        lifecycle: { tokens_total: 5500, duration_ms: 2500 },
      },
    },
    findings: [
      sampleFinding(),
      sampleFinding({
        id: "F002",
        category: 1,
        path: "src/client.ts",
        line: 10,
        severity: "WARNING",
        evidence_class: "inferential",
        refuter_verdict: "inconclusive",
        causal_disposition: "pre-existing",
        claim: "Unchecked error return value",
        proof_refs: ["src/client.ts:10"],
        hunter: "reliability",
        tier: "advisory",
        hops_used: 1,
        hop_trail: [],
        dedupe_key: "src/client.ts:10:reliability",
        root_cause_id: "RC002",
      }),
    ],
    debug: {
      refuted: [],
    },
    ...overrides,
  };
}

const SAMPLE_PER_AGENT: Record<string, PerAgentUsage> = {
  lifecycle: {
    tokens_total: 5500,
    duration_ms: 2500,
    tokens_in: 5000,
    tokens_out: 500,
    cost_usd_est: 0.2,
    attempts: 1,
    status: "ok",
  },
};

describe("Local Store Server & Typed Client", () => {
  test("health check returns schema version and runs count over Unix socket", async () => {
    const env = await tmpServerEnv();
    const serverHandle = startProductStoreServer({
      dbPath: env.dbPath,
      socketPath: env.socketPath,
    });
    const client = new ProductStoreClient({ socketPath: env.socketPath });

    try {
      const health = await client.health();
      expect(health.status).toBe("ok");
      expect(health.schema_version).toBe(CURRENT_PRODUCT_SCHEMA_VERSION);
      expect(health.runs_count).toBe(0);
    } finally {
      serverHandle.stop();
    }
  });

  test("saveRun persists run and exports matching FindingsDocument", async () => {
    const env = await tmpServerEnv();
    const serverHandle = startProductStoreServer({
      dbPath: env.dbPath,
      socketPath: env.socketPath,
    });
    const client = new ProductStoreClient({ socketPath: env.socketPath });

    try {
      const originalDoc = sampleDoc();
      const projected = projectCompleteRun({
        doc: originalDoc,
        perAgent: SAMPLE_PER_AGENT,
        diffFromSha: "c".repeat(40),
        repoId: "github.com/juanmaagd/pr-hero",
        runDir: "run-42",
        checkoutPath: "/Users/juanma/Desktop/pr-hero",
        generatedAt: "2026-08-23T18:00:00.000Z",
      });

      const saveRes = await client.saveRun(projected);
      expect(saveRes.ok).toBe(true);
      expect(saveRes.run_id).toBeGreaterThan(0);
      expect(saveRes.run_dir).toBe("run-42");

      // Verify health count increments
      const health = await client.health();
      expect(health.runs_count).toBe(1);

      // Get run
      const run = await client.getRun(saveRes.run_id);
      expect(run).not.toBeNull();
      expect(run?.repo_id).toBe("github.com/juanmaagd/pr-hero");
      expect(run?.blocking).toBe(1);
      expect(run?.advisory).toBe(1);

      // Get findings document
      const doc = await client.getFindingsDocument(saveRes.run_id);
      expect(doc).toEqual(originalDoc);
    } finally {
      serverHandle.stop();
    }
  });

  test("listRuns and getUsage filter and aggregate across repositories", async () => {
    const env = await tmpServerEnv();
    const serverHandle = startProductStoreServer({
      dbPath: env.dbPath,
      socketPath: env.socketPath,
    });
    const client = new ProductStoreClient({ socketPath: env.socketPath });

    try {
      await client.saveRun(
        projectCompleteRun({
          doc: sampleDoc({ pr: 1 }),
          repoId: "github.com/org/repo-a",
          runDir: "run-1",
          checkoutPath: null,
          generatedAt: "2026-08-23T18:00:00.000Z",
        }),
      );

      await client.saveRun(
        projectCompleteRun({
          doc: sampleDoc({ pr: 2 }),
          repoId: "github.com/org/repo-b",
          runDir: "run-2",
          checkoutPath: null,
          generatedAt: "2026-08-23T18:01:00.000Z",
        }),
      );

      await client.saveRun(
        projectCompleteRun({
          doc: sampleDoc({ pr: 0 }),
          repoId: "github.com/org/repo-c",
          runDir: "local-run-1",
          checkoutPath: null,
          generatedAt: "2026-08-23T18:02:00.000Z",
        }),
      );

      const allRuns = await client.listRuns();
      expect(allRuns.length).toBe(3);

      const localRuns = await client.listRuns({ pr: 0 });
      expect(localRuns.length).toBe(1);
      expect(localRuns[0]?.run_dir).toBe("local-run-1");

      const repoARuns = await client.listRuns({
        repo_id: "github.com/org/repo-a",
      });
      expect(repoARuns.length).toBe(1);
      expect(repoARuns[0]?.run_dir).toBe("run-1");

      const usageAll = await client.getUsage({ all: true });
      expect(usageAll.rows.length).toBe(3);
      expect(usageAll.total_tokens).toBe(16500);
      expect(usageAll.total_cost_usd).toBeCloseTo(0.6, 2);

      const usageRepoA = await client.getUsage({
        repo_id: "github.com/org/repo-a",
      });
      expect(usageRepoA.rows.length).toBe(1);
      expect(usageRepoA.total_tokens).toBe(5500);
    } finally {
      serverHandle.stop();
    }
  });

  test("searchFindings filters findings by tier, repo, and path with proof refs and hop trail", async () => {
    const env = await tmpServerEnv();
    const serverHandle = startProductStoreServer({
      dbPath: env.dbPath,
      socketPath: env.socketPath,
    });
    const client = new ProductStoreClient({ socketPath: env.socketPath });

    try {
      await client.saveRun(
        projectCompleteRun({
          doc: sampleDoc(),
          repoId: "github.com/juanmaagd/pr-hero",
          runDir: "run-search",
          checkoutPath: null,
          generatedAt: "2026-08-23T18:00:00.000Z",
        }),
      );

      const blockingFindings = await client.searchFindings({
        tier: "blocking",
      });
      expect(blockingFindings.length).toBe(1);
      expect(blockingFindings[0]?.finding_id).toBe("F001");
      expect(blockingFindings[0]?.proof_refs).toEqual(["src/engine.ts:42-45"]);
      expect(blockingFindings[0]?.hop_trail.length).toBe(1);
      expect(blockingFindings[0]?.run_dir).toBe("run-search");
      expect(blockingFindings[0]?.repo_id).toBe("github.com/juanmaagd/pr-hero");

      const pathFindings = await client.searchFindings({
        path: "src/client.ts",
      });
      expect(pathFindings.length).toBe(1);
      expect(pathFindings[0]?.finding_id).toBe("F002");
    } finally {
      serverHandle.stop();
    }
  });

  test("returns null on 404 for nonexistent run or document", async () => {
    const env = await tmpServerEnv();
    const serverHandle = startProductStoreServer({
      dbPath: env.dbPath,
      socketPath: env.socketPath,
    });
    const client = new ProductStoreClient({ socketPath: env.socketPath });

    try {
      const run = await client.getRun(9999);
      expect(run).toBeNull();

      const doc = await client.getFindingsDocument(9999);
      expect(doc).toBeNull();

      // comparison.json is retired: the route is gone, so it is an unknown
      // route (404 "Not found"), not an empty comparison.
      const retired = await fetch("http://localhost/v1/runs/9999/comparison", {
        unix: env.socketPath,
      });
      expect(retired.status).toBe(404);
    } finally {
      serverHandle.stop();
    }
  });

  test("recordTriage and getTriage record and fetch triage events via client", async () => {
    const env = await tmpServerEnv();
    const serverHandle = startProductStoreServer({
      dbPath: env.dbPath,
      socketPath: env.socketPath,
    });
    const client = new ProductStoreClient({ socketPath: env.socketPath });

    try {
      const doc = sampleDoc();
      const saveRes = await client.saveRun(
        projectCompleteRun({
          doc,
          repoId: "github.com/juanmaagd/pr-hero",
          runDir: "run-triage-test",
          checkoutPath: null,
        }),
      );
      const runId = saveRes.run_id;

      const triageId = await client.recordTriage(runId, {
        finding_id: "F001",
        comment_id: 998877,
        tag: "applied",
        verdict: null,
        actor: "agent",
        reasoning: "Fixed in commit 12345",
      });
      expect(triageId).toBeGreaterThan(0);

      const events = await client.getTriage(runId);
      expect(events.length).toBe(1);
      expect(events[0]?.finding_id).toBe("F001");
      expect(events[0]?.comment_id).toBe(998877);
      expect(events[0]?.tag).toBe("applied");
      expect(events[0]?.reasoning).toBe("Fixed in commit 12345");
    } finally {
      serverHandle.stop();
    }
  });
});
