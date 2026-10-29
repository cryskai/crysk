// Canonical product store (Fundamentals #6 / observability-canonical-store.md),
// server impure half: local HTTP server over Unix domain socket (Bun.serve).
//
// Invariant: The server is the exclusive runtime owner of SQLite.

import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import type { HopTrail } from "#review/findings";
import type { CanonicalFindingRow, CanonicalRunRow } from "#store/preflight";
import {
  exportFindingsDocument,
  getFindingTriageByRunId,
  getRunById,
  openProductStore,
  recordFindingTriage,
  saveRunTransaction,
} from "#store/store";
import {
  type FindingDetail,
  type HealthResponse,
  type ListRunsResponse,
  matchRoute,
  parseListRunsQuery,
  parseSearchFindingsQuery,
  parseUsageQuery,
  type RecordTriageRequestBody,
  type RecordTriageResponse,
  type SaveRunRequestBody,
  type SaveRunResponse,
  type SearchFindingsResponse,
  type UsageResponse,
} from "./preflight";

export interface ServerOptions {
  dbPath: string;
  socketPath?: string;
  port?: number;
  hostname?: string;
}

export interface StoreServerHandle {
  db: Database;
  url: string;
  socketPath?: string;
  stop: () => void;
}

export function startProductStoreServer(
  options: ServerOptions,
): StoreServerHandle {
  const db = openProductStore(options.dbPath);

  if (options.socketPath) {
    try {
      unlinkSync(options.socketPath);
    } catch {}
  }

  async function fetchHandler(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const match = matchRoute(req.method, url.pathname);

      if (!match) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }

      switch (match.name) {
        case "health": {
          const count = (
            db.query("SELECT COUNT(*) as c FROM runs;").get() as { c: number }
          ).c;
          const version = (
            db.query("PRAGMA user_version;").get() as { user_version: number }
          ).user_version;
          const body: HealthResponse = {
            status: "ok",
            schema_version: version,
            runs_count: count,
          };
          return Response.json(body);
        }

        case "save_run": {
          const body = (await req.json()) as SaveRunRequestBody;
          if (!body?.projected?.run) {
            return Response.json(
              { error: "Invalid payload: projected run required" },
              { status: 400 },
            );
          }
          const runId = saveRunTransaction(db, body.projected);
          const response: SaveRunResponse = {
            ok: true,
            run_id: runId,
            run_dir: body.projected.run.run_dir,
          };
          return Response.json(response);
        }

        case "list_runs": {
          const query = parseListRunsQuery(url);
          let sql = "SELECT * FROM runs WHERE 1=1";
          const params: (string | number)[] = [];

          if (query.repo_id) {
            sql += " AND repo_id = ?";
            params.push(query.repo_id);
          }
          if (query.pr !== undefined) {
            if (query.pr === 0) {
              sql += " AND (pr = 0 OR pr IS NULL)";
            } else {
              sql += " AND pr = ?";
              params.push(query.pr);
            }
          }
          sql += " ORDER BY generated_at DESC";
          if (query.limit !== undefined) {
            sql += " LIMIT ?";
            params.push(query.limit);
          }

          const runs = db.query(sql).all(...params) as CanonicalRunRow[];
          const response: ListRunsResponse = { runs };
          return Response.json(response);
        }

        case "get_run": {
          const id = Number(match.params.id);
          const run = getRunById(db, id);
          if (!run) {
            return Response.json({ error: "Run not found" }, { status: 404 });
          }
          return Response.json({ run });
        }

        case "get_run_findings_doc": {
          const id = Number(match.params.id);
          const doc = exportFindingsDocument(db, id);
          if (!doc) {
            return Response.json(
              { error: "Run not found or invalid" },
              { status: 404 },
            );
          }
          return Response.json(doc);
        }

        case "get_run_triage": {
          const id = Number(match.params.id);
          const triage = getFindingTriageByRunId(db, id);
          return Response.json({ triage });
        }

        case "record_run_triage": {
          const id = Number(match.params.id);
          const run = getRunById(db, id);
          if (!run) {
            return Response.json({ error: "Run not found" }, { status: 404 });
          }
          const body = (await req.json()) as RecordTriageRequestBody;
          const triageId = recordFindingTriage(db, {
            run_id: id,
            finding_id: body.finding_id,
            comment_id: body.comment_id ?? null,
            tag: body.tag,
            verdict: body.verdict ?? null,
            actor: body.actor,
            reasoning: body.reasoning,
            issue_number: body.issue_number ?? null,
            created_at: body.created_at ?? new Date().toISOString(),
          });
          const response: RecordTriageResponse = { ok: true, id: triageId };
          return Response.json(response);
        }

        case "get_usage": {
          const query = parseUsageQuery(url);
          let sql = "SELECT * FROM runs";
          const params: string[] = [];

          if (!query.all && query.repo_id) {
            sql += " WHERE repo_id = ?";
            params.push(query.repo_id);
          }
          sql += " ORDER BY generated_at DESC;";

          const rows = db.query(sql).all(...params) as CanonicalRunRow[];
          let total_tokens = 0;
          let total_cost_usd = 0;

          for (const r of rows) {
            total_tokens += r.tokens_total;
            total_cost_usd += r.cost_usd_est;
          }

          const response: UsageResponse = {
            rows,
            total_tokens,
            total_cost_usd,
          };
          return Response.json(response);
        }

        case "search_findings": {
          const query = parseSearchFindingsQuery(url);
          let sql = `
              SELECT f.*, r.run_dir, r.repo_id
              FROM findings f
              JOIN runs r ON f.run_id = r.id
              WHERE 1=1
            `;
          const params: (string | number)[] = [];

          if (query.repo_id) {
            sql += " AND r.repo_id = ?";
            params.push(query.repo_id);
          }
          if (query.run_id !== undefined) {
            sql += " AND f.run_id = ?";
            params.push(query.run_id);
          }
          if (query.tier) {
            sql += " AND f.tier = ?";
            params.push(query.tier);
          }
          if (query.path) {
            sql += " AND f.path = ?";
            params.push(query.path);
          }
          sql += " ORDER BY f.run_id DESC, f.finding_order ASC";
          if (query.limit !== undefined) {
            sql += " LIMIT ?";
            params.push(query.limit);
          }

          const rows = db.query(sql).all(...params) as (CanonicalFindingRow & {
            id: number;
            run_dir: string;
            repo_id: string;
          })[];

          const findings: FindingDetail[] = [];
          for (const row of rows) {
            const proofRefRows = db
              .query(
                "SELECT proof_ref FROM finding_proof_refs WHERE finding_id = ? ORDER BY ref_order ASC",
              )
              .all(row.id) as { proof_ref: string }[];

            const hopTrailRows = db
              .query(
                "SELECT step_num, kind, query, reached, is_raw_string FROM finding_hop_trail WHERE finding_id = ? ORDER BY step_order ASC",
              )
              .all(row.id) as {
              step_num: number;
              kind: string;
              query: string;
              reached: string | null;
              is_raw_string: number;
            }[];

            const isRaw =
              hopTrailRows.length > 0 && hopTrailRows[0]?.is_raw_string === 1;
            const hop_trail: HopTrail = isRaw
              ? hopTrailRows.map((h) => h.query)
              : hopTrailRows.map((h) => ({
                  step: h.step_num,
                  kind: h.kind,
                  query: h.query,
                  reached: h.reached ?? "",
                }));

            findings.push({
              ...row,
              proof_refs: proofRefRows.map((p) => p.proof_ref),
              hop_trail,
            });
          }

          const response: SearchFindingsResponse = { findings };
          return Response.json(response);
        }
      }
    } catch (error) {
      return Response.json(
        { error: (error as Error).message },
        { status: 500 },
      );
    }
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = options.socketPath
      ? Bun.serve({
          unix: options.socketPath,
          fetch: fetchHandler,
        })
      : Bun.serve({
          ...(options.port !== undefined ? { port: options.port } : {}),
          ...(options.hostname !== undefined
            ? { hostname: options.hostname }
            : {}),
          fetch: fetchHandler,
        });
  } catch (err) {
    db.close();
    throw err;
  }

  return {
    db,
    url: server.url?.toString() ?? `unix:${options.socketPath}`,
    socketPath: options.socketPath,
    stop: () => {
      server.stop(true);
      db.close();
      if (options.socketPath) {
        try {
          unlinkSync(options.socketPath);
        } catch {}
      }
    },
  };
}
