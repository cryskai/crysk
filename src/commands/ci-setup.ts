import path from "node:path";
import { runCiSetup } from "#ci/setup";
import { resolveOptionalRepoRoot } from "#config/config";
import {
  type CliOptions,
  GOTCHAS_PLACEHOLDER_MARKER,
  gotchasUnusableReason,
} from "#review/preflight";
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
  let step = 0;
  const next = () => `  ${++step}.`;
  log(`${next()} Commit .github/workflows/pr-hero.yml`);
  log(
    `${next()} Add a repository secret: ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN)`,
  );
  // The first PR of a new repository goes red without gotchas: every hunter's
  // prompt carries them, and PRH-GOTCHAS-MISSING refuses the review while the
  // file is absent or still the scaffold. So the init steps print only then;
  // a repo that already wrote real gotchas is not told to write them again.
  // Asked through gotchasUnusableReason, the one gate the review itself uses,
  // so a scaffold with no marker line gets the steps it will need.
  const gotchasPath = path.join(repoRoot, ".prhero", "gotchas.md");
  const gotchas = (await Bun.file(gotchasPath).exists())
    ? await Bun.file(gotchasPath).text()
    : undefined;
  if (gotchas === undefined || gotchasUnusableReason(gotchas) !== undefined) {
    log(
      `${next()} Run \`npx -y pr-hero init\` in a clone of the repository (it creates .prhero/config.json and .prhero/gotchas.md)`,
    );
    log(
      `${next()} Replace the placeholder lines in .prhero/gotchas.md with real facts about this repository, and delete the ${GOTCHAS_PLACEHOLDER_MARKER} marker line if it is there: pr-hero refuses to review the scaffold`,
    );
    log(
      `${next()} Commit .prhero/ to the default branch (comment-triggered runs read the base branch)`,
    );
  }
  // The check to require is `pr-hero` (the commit status, the gate), not the
  // `review` job, which stays green even when it finds blocking issues.
  log(
    `${next()} In branch protection, require the \`pr-hero\` status check (not the \`review\` job); a private repository on GitHub Free cannot require status checks`,
  );
  log(`${next()} Open a pull request to trigger the workflow`);
  // GitHub reads a comment-triggered workflow from the DEFAULT branch, so a
  // `/pr-hero review` on a pull request that only ADDS this file starts
  // nothing, with no error anywhere. Said here because this is where a new
  // user first reads how to force a review.
  log(
    `${next()} Comment /pr-hero review on a pull request to force a review; it works once this file is on the default branch`,
  );
  return 0;
}
