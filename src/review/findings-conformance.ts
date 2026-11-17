// Immutable cross-repository conformance cases for findings schema v1.0/v1.1.
// Both pr-hero and deep-review parse fresh copies of these bytes and run their
// independent validators — duplicated fixtures drift; shared bytes do not.

export type FindingsConformanceExpectation = "accept" | "reject";

export interface FindingsConformanceCase {
  readonly id: string;
  readonly raw: string;
  readonly expect: FindingsConformanceExpectation;
}

// Minimal shared finding object embedded in every case below.
const FINDING_V10 =
  '{"id":"F001","category":1,"path":"src/a.ts","line":1,"severity":"BLOCKER","evidence_class":"deterministic","refuter_verdict":"not_submitted","causal_disposition":"introduced","claim":"x","proof_refs":[],"hunter":"reliability","tier":"blocking","hops_used":0,"hop_trail":[],"dedupe_key":"k"}';
const FINDING_V11_SECURITY =
  '{"id":"F001","category":1,"path":"src/a.ts","line":1,"severity":"BLOCKER","evidence_class":"deterministic","refuter_verdict":"not_submitted","causal_disposition":"introduced","claim":"x","proof_refs":[],"hunter":"security","tier":"blocking","hops_used":0,"hop_trail":[],"dedupe_key":"k"}';
const FINDING_V11_CODE_QUALITY =
  '{"id":"F001","category":1,"path":"src/a.ts","line":1,"severity":"BLOCKER","evidence_class":"deterministic","refuter_verdict":"not_submitted","causal_disposition":"introduced","claim":"x","proof_refs":[],"hunter":"code-quality","tier":"blocking","hops_used":0,"hop_trail":[],"dedupe_key":"k"}';
const FINDING_V11_BAD_HUNTER =
  '{"id":"F001","category":1,"path":"src/a.ts","line":1,"severity":"BLOCKER","evidence_class":"deterministic","refuter_verdict":"not_submitted","causal_disposition":"introduced","claim":"x","proof_refs":[],"hunter":"Security","tier":"blocking","hops_used":0,"hop_trail":[],"dedupe_key":"k"}';

const TELEMETRY =
  '{"index_ms":1,"index_mode":"fresh","index_disk_mb":1,"wall_ms":1,"tokens_in":1,"tokens_out":1,"tokens_total":2}';

function envelope(
  schemaVersion: string,
  finding: string,
  engine?: string,
): string {
  const engineField = engine === undefined ? "" : `,"engine":${engine}`;
  return `{"schema_version":"${schemaVersion}","pr":1,"base_sha":"abc","head_sha":"def","model":"sonnet","iteration":1,"parity_hunter_fired":false,"run_status":"complete","telemetry":${TELEMETRY}${engineField},"findings":[${finding}],"debug":{"refuted":[]}}`;
}

export const FINDINGS_CONFORMANCE_CASES: readonly FindingsConformanceCase[] = [
  {
    id: "v10-minimal-closed-hunter",
    raw: envelope("1.0.0", FINDING_V10),
    expect: "accept",
  },
  {
    id: "v10-optional-engine",
    raw: envelope("1.0.0", FINDING_V10, '{"name":"pr-hero","version":"1.0.0"}'),
    expect: "accept",
  },
  {
    id: "v10-rejects-open-hunter",
    raw: envelope("1.0.0", FINDING_V11_SECURITY),
    expect: "reject",
  },
  {
    id: "v11-arbitrary-specialty-slug",
    raw: envelope(
      "1.1.0",
      FINDING_V11_SECURITY,
      '{"name":"pr-hero","version":"1.0.0"}',
    ),
    expect: "accept",
  },
  {
    id: "v11-hyphenated-specialty-slug",
    raw: envelope(
      "1.1.0",
      FINDING_V11_CODE_QUALITY,
      '{"name":"pr-hero","version":"1.0.0"}',
    ),
    expect: "accept",
  },
  {
    id: "v11-optional-revision",
    raw: envelope(
      "1.1.0",
      FINDING_V11_SECURITY,
      '{"name":"pr-hero","version":"1.0.0","revision":"abc123"}',
    ),
    expect: "accept",
  },
  {
    id: "v11-missing-engine",
    raw: envelope("1.1.0", FINDING_V11_SECURITY),
    expect: "reject",
  },
  {
    id: "v11-invalid-hunter-slug",
    raw: envelope(
      "1.1.0",
      FINDING_V11_BAD_HUNTER,
      '{"name":"pr-hero","version":"1.0.0"}',
    ),
    expect: "reject",
  },
  {
    id: "v11-engine-name-untrimmed",
    raw: envelope(
      "1.1.0",
      FINDING_V11_SECURITY,
      '{"name":" pr-hero","version":"1.0.0"}',
    ),
    expect: "reject",
  },
  {
    id: "v11-engine-revision-control-char",
    raw: envelope(
      "1.1.0",
      FINDING_V11_SECURITY,
      '{"name":"pr-hero","version":"1.0.0","revision":"bad\\u0007"}',
    ),
    expect: "reject",
  },
  {
    id: "unknown-schema-version",
    raw: envelope("0.9.0", FINDING_V10),
    expect: "reject",
  },
  {
    id: "malformed-schema-version",
    raw: envelope("1.0", FINDING_V10),
    expect: "reject",
  },
] as const;
