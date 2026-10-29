// Shared location rules for pr-hero findings: how a repo path is normalized and
// how wide the line window is when a finding is said to sit "near" a location.
// Re-review identity, scout lead matching, the CI review-risk path set and the
// floor-test case gate all compare paths through `normalizePath`; the floor-test
// case gate and the scout probe use `DEFAULT_LINE_WINDOW`.
//
// Pure: no I/O, no clock.

// The subset of a pr-hero `Finding` that location matching needs. Deliberately
// structural rather than an import of `Finding`: artifacts written by an older
// schema version must still be readable without failing on unrelated fields.
export interface PrHeroFindingRef {
  id: string;
  path: string;
  line: number;
  claim: string;
  tier: string;
}

export const DEFAULT_LINE_WINDOW = 25;

// Normalization is intentionally minimal — trim and drop one leading `./`.
// Both sides quote repo-relative paths already; anything more aggressive
// (case folding, basename matching) would start inventing matches across
// packages/, which this monorepo has plenty of duplicate filenames in.
export function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "");
}
