import { createHash } from "node:crypto";
import type { Severity } from "#review/findings";

export interface FindingObservation {
  readonly observationId: string;
  readonly specialty: string;
  readonly legId: string;
  readonly backend: string;
  readonly provider: string;
  readonly modelFamily: string;
  readonly modelSnapshot: string;
  readonly modelVariant?: string;
  readonly replicate: number;
  readonly attempt: number;
  readonly promptFingerprint: string;
  readonly routeFingerprint: string;
  readonly path: string;
  readonly line?: number;
  readonly symbol?: string;
  readonly category: number;
  readonly severity: Severity;
  readonly claim: string;
  readonly evidence: string;
  readonly proofRefs: readonly string[];
  readonly causalHypothesis: string;
  readonly artifactSha256: string;
  readonly dedupeKey?: string;
}

export type ObservationRelation =
  | "strong_same_defect"
  | "ambiguous"
  | "distinct";

export interface ProofAnchor {
  readonly path: string;
  readonly symbol?: string;
  readonly anchorHash: string;
}

export function canonicalProofAnchor(
  path: string,
  symbol: string | undefined,
  span: string,
): ProofAnchor {
  const normalizedPath = path.replace(/\\/g, "/");
  const anchorHash = createHash("sha256")
    .update(`${normalizedPath}|${symbol ?? ""}|${span}`)
    .digest("hex");
  return { path: normalizedPath, symbol, anchorHash };
}

export function normalizedDedupeKey(observation: FindingObservation): string {
  const anchors = [...observationAnchorKeys(observation)].sort().join(";");
  return createHash("sha256")
    .update(
      `${observation.specialty}|${observation.path}|${observation.symbol ?? ""}|${observation.category}|${anchors}`,
    )
    .digest("hex");
}

export function observationAnchorKeys(
  observation: FindingObservation,
): readonly string[] {
  return observation.proofRefs.map(
    (proofRef) =>
      canonicalProofAnchor(observation.path, observation.symbol, proofRef)
        .anchorHash,
  );
}

export function compareObservations(
  left: FindingObservation,
  right: FindingObservation,
  lineWindow = 100,
): ObservationRelation {
  if (left.specialty !== right.specialty) return "distinct";
  const leftAnchors = new Set(observationAnchorKeys(left));
  const rightAnchors = new Set(observationAnchorKeys(right));
  const sharedAnchors = [...leftAnchors].filter((anchor) =>
    rightAnchors.has(anchor),
  );
  if (sharedAnchors.length > 0) {
    return left.symbol === right.symbol ? "strong_same_defect" : "ambiguous";
  }

  const sameSymbol =
    left.symbol !== undefined &&
    right.symbol !== undefined &&
    left.symbol === right.symbol;
  if (sameSymbol && left.line !== undefined && right.line !== undefined) {
    if (Math.abs(left.line - right.line) <= lineWindow) {
      return "ambiguous";
    }
  }
  if (left.path !== right.path) return "distinct";
  return "ambiguous";
}

export interface FindingCluster {
  readonly clusterId: string;
  readonly observations: readonly FindingObservation[];
  readonly schedulingSeverity: Severity;
}

export interface AdjudicationGroup {
  readonly groupId: string;
  readonly clusters: readonly FindingCluster[];
  readonly ambiguous: boolean;
}

const SEVERITY_RANK: Record<Severity, number> = {
  BLOCKER: 0,
  CRITICAL: 1,
  WARNING: 2,
  SUGGESTION: 3,
};

function maxSeverity(observations: readonly FindingObservation[]): Severity {
  return observations.reduce<Severity>((best, observation) => {
    return SEVERITY_RANK[observation.severity] < SEVERITY_RANK[best]
      ? observation.severity
      : best;
  }, "SUGGESTION");
}

function sortObservations(
  observations: readonly FindingObservation[],
): FindingObservation[] {
  return [...observations].sort((a, b) => {
    const path = a.path.localeCompare(b.path);
    if (path !== 0) return path;
    const symbol = (a.symbol ?? "").localeCompare(b.symbol ?? "");
    if (symbol !== 0) return symbol;
    const line = (a.line ?? -1) - (b.line ?? -1);
    if (line !== 0) return line;
    return a.observationId.localeCompare(b.observationId);
  });
}

function isCompleteGraph(
  edges: Set<string>,
  nodes: readonly string[],
): boolean {
  if (nodes.length <= 1) return true;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (!edges.has(`${a}|${b}`) && !edges.has(`${b}|${a}`)) return false;
    }
  }
  return true;
}

export function buildClusters(
  observations: readonly FindingObservation[],
): readonly FindingCluster[] {
  const sorted = sortObservations(observations);
  const strongEdges = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const left = sorted[i];
      const right = sorted[j];
      if (!left || !right) continue;
      if (compareObservations(left, right) === "strong_same_defect") {
        strongEdges.add(`${left.observationId}|${right.observationId}`);
      }
    }
  }

  const visited = new Set<string>();
  const clusters: FindingCluster[] = [];
  for (const seed of sorted) {
    if (visited.has(seed.observationId)) continue;
    const component = sorted.filter((candidate) => {
      if (candidate.observationId === seed.observationId) return true;
      return (
        strongEdges.has(`${seed.observationId}|${candidate.observationId}`) ||
        strongEdges.has(`${candidate.observationId}|${seed.observationId}`)
      );
    });
    const ids = component.map((observation) => observation.observationId);
    if (!isCompleteGraph(strongEdges, ids)) {
      for (const observation of component) {
        clusters.push({
          clusterId: createHash("sha256")
            .update(`singleton:${observation.observationId}`)
            .digest("hex")
            .slice(0, 16),
          observations: [observation],
          schedulingSeverity: observation.severity,
        });
        visited.add(observation.observationId);
      }
      continue;
    }
    for (const observation of component) visited.add(observation.observationId);
    const clusterId = createHash("sha256")
      .update(ids.sort().join(";"))
      .digest("hex")
      .slice(0, 16);
    clusters.push({
      clusterId,
      observations: component,
      schedulingSeverity: maxSeverity(component),
    });
  }
  return clusters.sort((a, b) =>
    sortObservations(a.observations)[0]?.observationId.localeCompare(
      sortObservations(b.observations)[0]?.observationId ?? "",
    ),
  );
}

export function buildAdjudicationGroups(
  observations: readonly FindingObservation[],
): readonly AdjudicationGroup[] {
  const clusters = buildClusters(observations);
  const ambiguousPairs: Array<[string, string]> = [];
  for (let i = 0; i < observations.length; i++) {
    for (let j = i + 1; j < observations.length; j++) {
      const left = observations[i];
      const right = observations[j];
      if (!left || !right) continue;
      if (compareObservations(left, right) === "ambiguous") {
        ambiguousPairs.push([left.observationId, right.observationId]);
      }
    }
  }

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };
  for (const cluster of clusters) {
    for (const observation of cluster.observations) {
      parent.set(observation.observationId, observation.observationId);
    }
  }
  for (const [left, right] of ambiguousPairs) union(left, right);

  const grouped = new Map<string, FindingCluster[]>();
  for (const cluster of clusters) {
    const root = find(
      cluster.observations[0]?.observationId ?? cluster.clusterId,
    );
    const existing = grouped.get(root) ?? [];
    existing.push(cluster);
    grouped.set(root, existing);
  }

  const groups: AdjudicationGroup[] = [];
  for (const [root, groupClusters] of grouped) {
    const clusterObservationIds = new Set(
      groupClusters.flatMap((cluster) =>
        cluster.observations.map((observation) => observation.observationId),
      ),
    );
    const ambiguous = ambiguousPairs.some(
      ([left, right]) =>
        clusterObservationIds.has(left) && clusterObservationIds.has(right),
    );
    groups.push({
      groupId: root,
      clusters: groupClusters,
      ambiguous,
    });
  }
  return groups.sort((a, b) => a.groupId.localeCompare(b.groupId));
}

export function projectClusterIds(
  observations: readonly FindingObservation[],
): readonly string[] {
  return buildClusters(observations).map((cluster) => cluster.clusterId);
}
