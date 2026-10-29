import { existsSync } from "node:fs";
import os from "node:os";
import { resolveRepoRoot } from "#git/git";
import type { CliOptions } from "#review/preflight";
import { queryUsage } from "#store/metrics";
import { type RunRow, renderUsage } from "#store/metrics-preflight";
import { openProductStore, queryRuns } from "#store/store";
import { log, styleEnabled } from "#ui/primitives";
import { resolveRepoHome } from "../home";
import { prheroLayout } from "../home-preflight";

// `pr-hero usage` (W4 / #23) — the thin read side of the observability
// store every completed review auto-ingests into. Origin-scoped by default
// (spec "Origin-Scoped Usage By Default"); `--all` is the operator-wide
// escape hatch and DELIBERATELY skips resolveRepoHome entirely — it must
// run from anywhere, including outside a git repo (design "usage render").
// A checkout with no resolvable origin fails/warns via the SAME CliError
// gitOriginUrl already throws (spec "No-origin checkout"): resolveRepoRoot
// still needs the cwd to be a git repo, resolveRepoHome still needs an
// origin, and neither is bypassed in scoped mode.
// The scoped-mode half of `usage`'s origin resolution, pulled out on its own
// (W4 Phase 6 remediation, GitHub #23 option D) so a no-origin checkout's
// failure path — the pre-existing CliError/missingOriginMessage that
// resolveRepoHome's gitOriginUrl call already throws — is exercisable
// directly, without needing `usageCommand`'s whole `--all`/parseArgs
// surface around it. persist:false: `usage` must never write a registry.
export async function originUsageScope(
  home: string,
  operatorRoot: string,
): Promise<{ repoId: string }> {
  const repoHome = await resolveRepoHome({
    home,
    operatorRoot,
    persist: false,
  });
  return { repoId: repoHome.repoId };
}

export async function usageCommand(options: CliOptions): Promise<number> {
  const layout = prheroLayout(os.homedir());
  const scope = options.all
    ? ({ all: true } as const)
    : await originUsageScope(os.homedir(), await resolveRepoRoot(options.repo));

  const canonicalRows = existsSync(layout.prheroDbPath)
    ? (() => {
        const db = openProductStore(layout.prheroDbPath);
        try {
          return queryRuns(db, scope);
        } finally {
          db.close();
        }
      })()
    : [];

  let runRows: RunRow[] = canonicalRows.map((r) => ({
    repo_id: r.repo_id,
    run_dir: r.run_dir,
    pr: r.pr,
    checkout_path: r.checkout_path,
    head_sha: r.head_sha,
    base_sha: r.base_sha,
    run_status: r.run_status,
    session_failed: r.session_failed === 1 ? 1 : 0,
    model: r.model,
    generated_at: r.generated_at,
    wall_ms: r.wall_ms,
    index_ms: r.index_ms,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    tokens_total: r.tokens_total,
    cost_usd_est: r.cost_usd_est,
    blocking: r.blocking,
    advisory: r.advisory,
  }));

  if (runRows.length === 0 && existsSync(layout.metricsDbPath)) {
    runRows = queryUsage(layout.metricsDbPath, scope);
  }

  // An empty store is a valid state of the world (no review has ingested
  // yet, or none matches this scope), not an error — same split as
  // every read-only report command: a human note on stderr, stdout left clean, exit 0.
  if (runRows.length === 0) {
    log(
      `no usage rows found in ${layout.prheroDbPath} — run \`crysk review\` or ` +
        "`crysk review --pr <n>` first",
    );
    return 0;
  }
  // The report IS this command's product, same stdout/stderr split as
  // every read-only report command: everything human-facing above went to stderr via log(),
  // so stdout stays pipeable.
  process.stdout.write(
    `${renderUsage(runRows, { styles: styleEnabled() }).join("\n")}\n`,
  );
  return 0;
}
