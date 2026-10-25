// The five Martian offline corpora as data, shared by scripts/martian-cal.ts
// (reviews) and scripts/martian-inject.ts (export to Martian's pipeline).
//
// Each corpus's docs files share the `martian-<corpus>-` prefix. Cal.com keeps
// the paths of its 2026-08-19 baseline (a full blobless clone, runs/ at the
// root). The others start from an empty repo and fetch only the two commits
// each PR needs (`shallow`), and get their own runs root so
// `schedule-<arm>.json` never collides across corpora.

import { homedir } from "node:os";
import path from "node:path";

export interface Corpus {
  clone: string;
  runs: string;
  upstream: string;
  shallow: boolean;
}

export const BENCH_HOME = path.join(homedir(), "Desktop", "martian-cal");

export const CORPORA: Record<string, Corpus> = {
  cal: {
    clone: "cal.com",
    runs: "runs",
    upstream: "https://github.com/calcom/cal.com.git",
    shallow: false,
  },
  sentry: {
    clone: "sentry",
    runs: "runs-sentry",
    upstream: "https://github.com/getsentry/sentry.git",
    shallow: true,
  },
  grafana: {
    clone: "grafana",
    runs: "runs-grafana",
    upstream: "https://github.com/grafana/grafana.git",
    shallow: true,
  },
  keycloak: {
    clone: "keycloak",
    runs: "runs-keycloak",
    upstream: "https://github.com/keycloak/keycloak.git",
    shallow: true,
  },
  discourse: {
    clone: "discourse",
    runs: "runs-discourse",
    upstream: "https://github.com/discourse/discourse.git",
    shallow: true,
  },
};

export function corpusDocsFile(corpus: string, suffix: string): string {
  return path.join(
    import.meta.dir,
    "..",
    "docs",
    "benchmarks",
    `martian-${corpus}-${suffix}`,
  );
}

export interface CaseRow {
  pr: number;
  title: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseSha: string;
  headSha: string;
  // Clone URL holding the SHAs when it is not the corpus upstream (the
  // synthetic `ai-code-review-evaluation/*` forks). Absent on Cal.com.
  remote?: string;
}

export interface CasesFile {
  repo: string;
  pilot: number[];
  prs: CaseRow[];
}
