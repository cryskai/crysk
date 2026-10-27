---
name: pr-hero-pr
description: "Open or update a GitHub pull request with a structured title and reviewer-focused description, then automatically subscribe to the pr-hero review via `pr-hero status --pr <n> --wait --json` and hand off to `pr-hero-triage` if findings are reported. Trigger: open a PR, create a PR, gh pr create, submit PR, push branch and open PR, ship PR, crear PR, abrir PR."
license: Apache-2.0
metadata:
  author: juanmaagd
  version: "1.0"
---

## When to Use

Load this skill whenever the user asks to open, create, submit, or update a pull request (or push a branch and open a PR).

## Step 1: Branch, Pre-Push Checks & Repo Conventions

1. **Protect integration branches:** Never commit or push directly to the default branch, or to the integration branch the repository declares (for example `dev` in a repo whose rules say so). If currently on one, create a focused branch first (`feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `refactor/<slug>`).
2. **Resolve target base branch:**
   - Check `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, or an active project PR skill (such as `branch-pr` or `gh-stack`) for the required target branch (e.g. `dev` vs `main`).
   - If the repo defines no rule, inspect whether an active `dev` integration branch exists or fall back to `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.
3. **Run local gates before pushing:** Run the project's fast verification commands (tests, typecheck, linter) before pushing the branch (`git push -u origin HEAD`).

## Step 2: PR Title & Description (Repo Template or Built-in Fallback)

1. **Check repo rules first:**
   - If the repository has `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE/`, or instructions in `AGENTS.md` / `CONTRIBUTING.md` / an active PR skill, follow that structure.
2. **Fallback template (when the repository has no PR template or rules):**
   - Never rely on a bare `gh pr create --fill` dump.
   - **Title:** Conventional Commit format (`<type>(<scope>): <imperative summary>`, max 72 chars), stating *what* changed clearly.
   - **Body:** Pass via `--body-file` (or a quoted heredoc) using this structure:

     ```markdown
     ## Summary
     - **What & Why:** 1–3 concise bullets explaining the problem solved or capability added and why it was needed.

     ## Key Changes
     - `<path/or/module>` — what changed and any non-obvious design or tradeoff decision.

     ## Verification
     - Exact local commands executed (`test`, `typecheck`, `lint`) and their results.

     ## Related Issues
     - `Closes #<id>` / `Refs #<id>` (or `None`).
     ```

   - Attribution lines (`Co-Authored-By`, generated-by footers) follow the repository's rules and the user's own instructions; this skill adds none and removes none.

3. **Create (or locate) the PR:**
   - Run `gh pr create --base <base> --title "<title>" --body-file <file>` (or `gh pr view --json number,url` if a PR for the current branch is already open and you just pushed new commits).
   - Capture the pull request number `<n>`.

## Step 3: Auto-Subscribe to `pr-hero` & Enter the Triage Loop (No Human Friction)

Check whether the repository uses `pr-hero` (e.g., `.github/workflows/pr-hero.yml` or `.prhero/` exists in the repo, or `pr-hero` status checks run on PRs). If not, report the PR URL and stop.

When `pr-hero` is active on the repository, **never stop right after `gh pr create`**. Immediately continue in the same turn:

1. **Subscribe to the initial review from second zero:**
   ```bash
   npx -y pr-hero status --pr <n> --wait --json
   ```
   `--wait` holds automatically during the 3-minute startup grace window while `gate.state` is `"none"` (waiting for GitHub Actions to pick up the new PR), continues polling every 15s while `gate.state` is `"pending"`, and returns as soon as the review settles.

2. **Route on `next_action`:**
   - **`next_action === "done"`:** Check whether `report.head` is non-null and `report.head !== head` (a green status carried forward over an unreviewed push under `once_per_pr`, `thresholded`, or `risk_aware`). If so and `git diff <report.head>..<head>` contains non-trivial logic or risky changes, explicitly recommend running `/pr-hero review` to the user naming those changes. Otherwise, the review passed the gate with zero untriaged findings: report the PR URL and clean review summary to the user.
   - **`next_action !== "done"` (`"triage"`, `"fix"`, `"recheck"`, `"review"`, `"override-or-fix"`):**
     Immediately load the `pr-hero-triage` skill (`skills/pr-hero-triage/SKILL.md`) and run its autonomous loop (`while (next_action !== "done")`) to judge findings, reply, push verified fixes, and wait for re-review until the PR is ready to merge.
