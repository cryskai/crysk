// The materiality judge's one spawn, shared by the exam
// (scripts/materiality-probe.ts) and the noise baseline
// (scripts/noise-baseline.ts), so both measure with the same judge. The lab
// imports judgeClaim by path, so its name and signature stay.
//
// The spawn itself lives in src/harness/materiality-judge.ts, on the route
// seam: tools [], empty MCP config, a fresh tmp dir per spawn, opus (the
// hunters run sonnet, so the judge never grades its own model's output), and
// the judge's route recorded on every outcome. Never throws: a failed spawn or
// parse comes back as `label: null` with the error, so one bad claim never
// discards judgments already paid for.
import {
  type JudgeOutcome,
  MATERIALITY_JUDGE_CHOICE,
  materialityJudgeIdentity,
  runMaterialityJudge,
} from "../src/harness/materiality-judge";

export type { JudgeOutcome };

// The judge's model alias, as results files have always recorded it.
export const JUDGE_MODEL = "opus";

// The route and fingerprint a results file records beside judge_model.
export function judgeRouteFields(): {
  judge_route: JudgeOutcome["route"];
  judge_route_fingerprint: string;
} {
  const identity = materialityJudgeIdentity(MATERIALITY_JUDGE_CHOICE);
  if (identity.route.modelSnapshot !== JUDGE_MODEL) {
    throw new Error(
      `the judge route runs ${identity.route.modelSnapshot}, not ${JUDGE_MODEL}`,
    );
  }
  return {
    judge_route: identity.route,
    judge_route_fingerprint: identity.routeFingerprint,
  };
}

export async function judgeClaim(input: {
  name: string;
  prTitle: string;
  claim: string;
}): Promise<JudgeOutcome> {
  return runMaterialityJudge(input, { judge: MATERIALITY_JUDGE_CHOICE });
}
