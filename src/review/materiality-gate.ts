// The materiality gate's PURE half (odd/tasks/materiality-gate.md S3, S4,
// S12): the safety guard, the judge's input window and prompt, and the
// verdict→demotion map. The impure half (spawning the judge) lives in the
// pipeline; the judge's instructions are `prompts/materiality.md`.

import { type MaterialityVerdict, normalizeClaim } from "#compare/materiality";
import { blockForgesNonce, wrapBlock } from "#review/boundary";
import type { Tier } from "#review/findings";
import { redactEvidenceText } from "../security/evidence-redaction";

// Deterministic carve-out from the posting policy: a finding that touches
// security, credentials, isolation or data integrity is never sent to the
// judge and never demoted, whatever a model would say. It over-protects on
// purpose (an "argv token" matches `token\w*`): a false positive costs one
// finding staying blocking, a false negative hides a real exposure. Extended
// for the two misses the offline exam surfaced: a lost-update race that
// silently drops a user's edit, and hard deletes.
export const SAFETY_PATTERN =
  /\b(auth\w*|credential\w*|secret\w*|passw\w*|token\w*|api[ _-]?key\w*|permission\w*|privilege\w*|access[ -]control|sandbox\w*|symlink\w*|isolation|escap\w+ (the )?(sandbox|worktree)|inject\w*|xss|csrf|ssrf|rce|traversal|sanitiz\w*|encrypt\w*|decrypt\w*|signature\w*|verif\w+ (the )?signature|data loss|lose[sd]? (the )?(data|rows|records|findings|audit)|corrupt\w*|overwrit\w+|delet\w+ (the )?(user|data|rows|records|cache)|leak\w* (the )?(secret|token|credential|key)|lost[ -]update\w*|los[et]s? (the )?(user'?s? |concurrent |other )?(edit|update|write|change)s?|silently (drop|discard|overwrit|delet|lost)\w*|(is|are|gets?) (silently )?lost|hard[- ]delet\w*|(race|concurren\w*)[^.]{0,80}(overwrit|delet|hard-delet|clobber|drop)\w*)\b/i;

export function isSafetyProtected(f: { claim: string; path: string }): boolean {
  return SAFETY_PATTERN.test(f.claim) || SAFETY_PATTERN.test(f.path);
}

export const MATERIALITY_WINDOW_LINES = 25;

// The finding's line ±25 at the reviewed head, 1-based, the finding line
// marked with ">". A trailing newline does not count as an extra empty line.
export function codeWindow(fileText: string, line: number): string {
  const lines = fileText.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const first = Math.max(1, line - MATERIALITY_WINDOW_LINES);
  const last = Math.min(lines.length, line + MATERIALITY_WINDOW_LINES);
  const out: string[] = [];
  for (let n = first; n <= last; n++) {
    out.push(`${n}${n === line ? ">" : " "} ${lines[n - 1]}`);
  }
  return redactEvidenceText(out.join("\n"));
}

// The title, the claim, the path and the window are all author-controlled, so
// each block is wrapped with the run's boundary nonce (S12). Content that
// already carries the nonce returns null rather than throwing: wrapBlock's
// throw would kill a paid run, and the caller treats null as "cannot judge
// safely" and leaves the finding blocking (fail-open toward blocking, S6).
// The check runs on the exact strings handed to wrapBlock, so it never throws.
export function renderMaterialityPrompt(
  input: {
    prTitle: string;
    claim: string;
    path: string;
    window: string | null;
  },
  nonce: string,
): string | null {
  const title = input.prTitle.replace(/\s+/g, " ").trim();
  const claim = normalizeClaim(redactEvidenceText(input.claim));
  const filePath = input.path.replace(/\s+/g, " ").trim();
  const window = input.window ?? "";
  if (
    [title, claim, filePath, window].some((part) =>
      blockForgesNonce(part, nonce),
    )
  ) {
    return null;
  }
  const parts = [
    "Pull request title:",
    wrapBlock("pr_title", nonce, title),
    "",
    "Review comment:",
    wrapBlock("review_comment", nonce, claim),
    "",
    `File: ${filePath}`,
  ];
  if (input.window !== null) {
    parts.push("", "Code:", wrapBlock("code_window", nonce, window));
  }
  return parts.join("\n");
}

export function materialityCandidates<
  T extends { tier: Tier; claim: string; path: string },
>(findings: T[]): { judge: T[]; protectedCount: number } {
  const judge: T[] = [];
  let protectedCount = 0;
  for (const f of findings) {
    if (f.tier !== "blocking") continue;
    if (isSafetyProtected(f)) protectedCount++;
    else judge.push(f);
  }
  return { judge, protectedCount };
}

// The guard is re-checked here, not only in materialityCandidates: a verdict
// that reaches this map for a protected finding must still never demote it.
export function applyMaterialityVerdicts<
  T extends { id: string; tier: Tier; claim: string; path: string },
>(
  findings: T[],
  verdicts: Map<string, MaterialityVerdict>,
): (T & { materiality?: MaterialityVerdict })[] {
  return findings.map((f) => {
    const verdict = verdicts.get(f.id);
    if (
      f.tier !== "blocking" ||
      verdict?.label !== "immaterial" ||
      isSafetyProtected(f)
    ) {
      return f;
    }
    return { ...f, tier: "advisory" as const, materiality: verdict };
  });
}
