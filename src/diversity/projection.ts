import type { Finding } from "#review/findings";
import { deriveTier } from "#review/findings";
import type { ClusterAdjudication } from "./adjudication";

export function projectAdjudicationToFindings(
  adjudication: ClusterAdjudication,
  specialty: string,
  startingId = 1,
): { findings: Finding[]; partial: boolean } {
  if (
    adjudication.relation === "no_defect" ||
    adjudication.relation === "inconclusive"
  ) {
    return { findings: [], partial: adjudication.relation === "inconclusive" };
  }
  const findings: Finding[] = [];
  let id = startingId;
  for (const canonical of adjudication.canonicalFindings) {
    const refuterVerdict: Finding["refuter_verdict"] =
      adjudication.relation === "same_defect" ? "corroborated" : "corroborated";
    const finding: Finding = {
      id: `F${String(id).padStart(3, "0")}`,
      category: canonical.category,
      path: canonical.path,
      line: canonical.line ?? 1,
      symbol: canonical.symbol,
      severity: canonical.severity,
      evidence_class: canonical.evidenceClass,
      refuter_verdict: refuterVerdict,
      causal_disposition: canonical.causalDisposition,
      claim: canonical.claim,
      proof_refs: [...canonical.proofRefs],
      hunter: specialty,
      tier: deriveTier({
        severity: canonical.severity,
        evidence_class: canonical.evidenceClass,
        refuter_verdict: refuterVerdict,
        causal_disposition: canonical.causalDisposition,
        claim: canonical.claim,
        path: canonical.path,
      }),
      hops_used: canonical.hopsUsed,
      hop_trail: canonical.hopTrail,
      dedupe_key: `${canonical.path}:${canonical.symbol ?? ""}:${canonical.category}`,
    };
    findings.push(finding);
    id++;
  }
  return { findings, partial: false };
}

export function stableProjectionOrder(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const path = a.path.localeCompare(b.path);
    if (path !== 0) return path;
    const line = a.line - b.line;
    if (line !== 0) return line;
    return a.id.localeCompare(b.id);
  });
}
