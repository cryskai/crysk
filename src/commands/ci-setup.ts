import { runCiSetup } from "#ci/setup";
import { resolveOptionalRepoRoot } from "#config/config";
import type { CliOptions } from "#review/preflight";
import { log } from "#ui/primitives";

// Shared shell for `pr-hero setup --ci` and `pr-hero ci init` — both are the
// same scaffolding action (runCiSetup), reached by two different command
// spellings. The refusal-without-force branch is a safety property (see
// spec.md §4.1 / ci/setup.ts's header comment), not a usage error, so it
// returns 1 rather than throwing CliUsageError: the invocation was valid,
// the outcome is just "nothing was written".
export async function ciSetupCommand(options: CliOptions): Promise<number> {
  const repoRoot = (await resolveOptionalRepoRoot(options)) ?? process.cwd();
  const result = await runCiSetup({ cwd: repoRoot, force: options.force });

  if (result.status === "skipped-existing") {
    log(`${result.path} already exists.`);
    log(result.hint);
    return 1;
  }

  log(
    result.status === "overwritten"
      ? `Overwrote ${result.path}`
      : `Created ${result.path}`,
  );
  log();
  log("Next steps:");
  log("  1. Commit .github/workflows/pr-hero.yml");
  log(
    "  2. Add a repository secret: ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN)",
  );
  log("  3. Open a pull request to trigger the workflow");
  // GitHub reads a comment-triggered workflow from the DEFAULT branch, so a
  // `/pr-hero review` on a pull request that only ADDS this file starts
  // nothing, with no error anywhere. Said here because this is where a new
  // user first reads how to force a review.
  log(
    "  4. Comment /pr-hero review on a pull request to force a review; it works once this file is on the default branch",
  );
  return 0;
}
