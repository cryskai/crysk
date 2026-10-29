// Canonical product store (Fundamentals #6 / observability-canonical-store.md),
// server pure half: route contracts, query parameter parsers, payload types,
// and URL path matching.
//
// Pure and testable offline: no network, no database handles, no filesystem.

import type { HopTrail, Tier } from "#review/findings";
import type {
  CanonicalFindingRow,
  CanonicalRunRow,
  FindingTriageRow,
  ProjectedCompleteRun,
} from "#store/preflight";

export interface HealthResponse {
  status: "ok";
  schema_version: number;
  runs_count: number;
}

export interface SaveRunRequestBody {
  projected: ProjectedCompleteRun;
}

export interface SaveRunResponse {
  ok: true;
  run_id: number;
  run_dir: string;
}

export interface ListRunsQuery {
  repo_id?: string;
  pr?: number;
  limit?: number;
}

export interface ListRunsResponse {
  runs: CanonicalRunRow[];
}

export interface GetRunResponse {
  run: CanonicalRunRow;
}

export interface UsageQueryParams {
  repo_id?: string;
  all?: boolean;
}

export interface UsageResponse {
  rows: CanonicalRunRow[];
  total_tokens: number;
  total_cost_usd: number;
}

export interface SearchQueryParams {
  repo_id?: string;
  run_id?: number;
  tier?: Tier;
  path?: string;
  limit?: number;
}

export interface FindingDetail extends CanonicalFindingRow {
  proof_refs: string[];
  hop_trail: HopTrail;
  run_dir: string;
  repo_id: string;
}

export interface SearchFindingsResponse {
  findings: FindingDetail[];
}

export interface GetTriageResponse {
  triage: FindingTriageRow[];
}

export interface RecordTriageRequestBody {
  finding_id: string;
  comment_id?: number | null;
  tag: string;
  verdict?: string | null;
  actor: string;
  reasoning: string;
  issue_number?: number | null;
  created_at?: string;
}

export interface RecordTriageResponse {
  ok: true;
  id: number;
}

export interface ErrorResponse {
  error: string;
}

export type RoutePattern =
  | { name: "health"; method: "GET"; path: "/health" }
  | { name: "save_run"; method: "POST"; path: "/v1/runs" }
  | { name: "list_runs"; method: "GET"; path: "/v1/runs" }
  | { name: "get_run"; method: "GET"; pathPattern: "/v1/runs/:id" }
  | {
      name: "get_run_findings_doc";
      method: "GET";
      pathPattern: "/v1/runs/:id/findings-document";
    }
  | {
      name: "get_run_triage";
      method: "GET";
      pathPattern: "/v1/runs/:id/triage";
    }
  | {
      name: "record_run_triage";
      method: "POST";
      pathPattern: "/v1/runs/:id/triage";
    }
  | { name: "get_usage"; method: "GET"; path: "/v1/usage" }
  | { name: "search_findings"; method: "GET"; path: "/v1/findings" };

export interface MatchedRoute {
  name:
    | "health"
    | "save_run"
    | "list_runs"
    | "get_run"
    | "get_run_findings_doc"
    | "get_run_triage"
    | "record_run_triage"
    | "get_usage"
    | "search_findings";
  params: Record<string, string>;
}

export function matchRoute(
  method: string,
  pathname: string,
): MatchedRoute | null {
  const m = method.toUpperCase();

  if (m === "GET" && pathname === "/health") {
    return { name: "health", params: {} };
  }

  if (m === "POST" && pathname === "/v1/runs") {
    return { name: "save_run", params: {} };
  }

  if (m === "GET" && pathname === "/v1/runs") {
    return { name: "list_runs", params: {} };
  }

  if (m === "GET" && pathname === "/v1/usage") {
    return { name: "get_usage", params: {} };
  }

  if (m === "GET" && pathname === "/v1/findings") {
    return { name: "search_findings", params: {} };
  }

  const triageMatch = /^\/v1\/runs\/(\d+)\/triage$/.exec(pathname);
  if (triageMatch) {
    if (m === "GET") {
      return { name: "get_run_triage", params: { id: triageMatch[1] ?? "" } };
    }
    if (m === "POST") {
      return {
        name: "record_run_triage",
        params: { id: triageMatch[1] ?? "" },
      };
    }
  }

  const findingsDocMatch = /^\/v1\/runs\/(\d+)\/findings-document$/.exec(
    pathname,
  );
  if (m === "GET" && findingsDocMatch) {
    return {
      name: "get_run_findings_doc",
      params: { id: findingsDocMatch[1] ?? "" },
    };
  }

  const runIdMatch = /^\/v1\/runs\/(\d+)$/.exec(pathname);
  if (m === "GET" && runIdMatch) {
    return { name: "get_run", params: { id: runIdMatch[1] ?? "" } };
  }

  return null;
}

export function parseUsageQuery(url: URL): UsageQueryParams {
  const all = url.searchParams.get("all") === "true";
  const repo_id = url.searchParams.get("repo_id") ?? undefined;
  return { repo_id, all };
}

export function parseListRunsQuery(url: URL): ListRunsQuery {
  const repo_id = url.searchParams.get("repo_id") ?? undefined;
  const prStr = url.searchParams.get("pr");
  const pr = prStr ? Number(prStr) : undefined;
  const limitStr = url.searchParams.get("limit");
  const limit = limitStr ? Number(limitStr) : undefined;
  return { repo_id, pr, limit };
}

export function parseSearchFindingsQuery(url: URL): SearchQueryParams {
  const repo_id = url.searchParams.get("repo_id") ?? undefined;
  const runIdStr = url.searchParams.get("run_id");
  const run_id = runIdStr ? Number(runIdStr) : undefined;
  const tier = url.searchParams.get("tier") as Tier | undefined;
  const path = url.searchParams.get("path") ?? undefined;
  const limitStr = url.searchParams.get("limit");
  const limit = limitStr ? Number(limitStr) : undefined;
  return { repo_id, run_id, tier, path, limit };
}
