# Open or update a pull request in a repository that uses Crysk

This playbook applies only where Crysk reviews pull requests. If you got here in a repository without a Crysk workflow or
`.crysk/` folder, open the pull request the way the repository normally does and ignore the rest.

## 1. Branch and checks

1. Never commit or push to the default branch, or to the integration branch the repository declares (for example `dev` in a
   repository whose rules say so). If you are on one, create a focused branch first (`feat/<slug>`, `fix/<slug>`,
   `chore/<slug>`, `refactor/<slug>`).
2. Find the base branch in `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` or an active project PR skill. With no rule, use
   `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.
3. Run the project's fast checks (tests, typecheck, linter), then `git push -u origin HEAD`.

## 2. Title and description

Follow `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE/` or the repository's written rules when they exist.
Otherwise, never rely on a bare `gh pr create --fill`:

- **Title:** Conventional Commit format (`<type>(<scope>): <imperative summary>`, at most 72 characters).
- **Body,** passed with `--body-file`:

  ```markdown
  ## Summary
  - **What & Why:** 1 to 3 bullets on the problem solved and why it was needed.

  ## Key Changes
  - `<path/or/module>`: what changed, and any non-obvious decision.

  ## Verification
  - The exact commands you ran and their results.

  ## Related Issues
  - `Closes #<id>` / `Refs #<id>`, or `None`.
  ```

Attribution lines follow the repository's rules and the user's instructions. This skill adds none and removes none.

Create it with `gh pr create --base <base> --title "<title>" --body-file <file>`. If the branch already has an open pull
request, use `gh pr view --json number,url`. Keep the number `<n>`.

## 3. Hand off to the review loop

Do not stop after creating the pull request. Wait for the review in the same turn:

```bash
npx -y crysk@0.9.0 status --pr <n> --wait --json
```

It waits for the run to start and finish, then returns the settled state.

- **Anything but `next_action=done`:** load the loop and follow it:

  ```bash
  npx -y crysk@0.9.0 skills load crysk-loop
  ```

- **`next_action=done`:** the loop has little left, but load it too when `findings` has a row with `comment_id: null` or
  `report.head` is not `head`: it says how to handle both. Otherwise report the pull request's URL and the review's result.
