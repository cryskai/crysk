---
name: crysk-release
description: "Trigger: release, cut a release, publish a version, sacar release, bump version, tag vX.Y.Z, npm publish crysk. Step-by-step Crysk release: changelog audit, version bump in five files, release PR, dev to main, npm publish, tags, verification."
license: MIT
metadata:
  author: pr-hero
  version: "1.0"
  # Maintainer-only (needs npm and repo write access): hidden from skills.sh / `npx skills add`.
  internal: true
---

## Activation Contract

Load when the maintainer asks to release Crysk, publish a version, or move `dev` to `main` for a
release. Run the steps in order and do not skip the checks. `docs/release-runbook.md` is the long
reference: it explains each guard and covers failure recovery (§6). This skill is the checklist.

## Hard Rules

- **The version number is the maintainer's call.** Ask for it if they did not give it. Never pick one.
- **The order is fixed:** bump, then commit, then npm, then tag. `release.yml`'s `verify-version`
  fails when the tag differs from `package.json`, and a publish that fails after the tag push leaves a
  half-release.
- **Merge commits only** (`gh pr merge --merge`). The repo allows no squash.
- **No AI attribution** in release commits or tags.
- **`npm login` is interactive.** Ask the maintainer to run `! npm login`. Never handle npm credentials.
- **Never move a tag that was already pushed**, except the floating `v0`.
- zsh: do not use `set -- $VAR` to split words, and `timeout` does not exist on macOS.

## Steps

Set `V=X.Y.Z` (no `v`), `PREV` to the last released version (`git tag --sort=-creatordate | head -3`), and
`SCRATCH=$(mktemp -d)` for build output outside the repo.

### 1. Branch off the latest `dev`

```bash
git switch dev && git pull --ff-only
git switch -c release/v$V
```

### 2. Audit the changelog against what merged

The `## [Unreleased]` section is written PR by PR, so it misses some PRs, and an entry can go stale
when a later PR changes what it describes. Compare it to the merges:

```bash
git log --oneline --merges v$PREV..dev
awk '/^## \[Unreleased\]/{f=1} /^## \[/{if(f&&!/Unreleased/)exit} f' CHANGELOG.md
```

For each merged PR, read its title and summary (`gh pr view <n> --json title,body`). It needs an entry
when a user sees the change: CLI, config, action, gate, posted comments, shipped skills, or the
runtime. Eval scripts, roadmap and docs-only PRs do not. Also look for entries a later PR made wrong,
such as a "Known limitation" that a fix removed. Write entries in plain English, under
`Added` / `Changed` / `Fixed`. A change that breaks something (for example a required status check)
says what the user must do.

### 3. Turn Unreleased into the release section

- Insert `## [$V] - YYYY-MM-DD` (today's date) right under `## [Unreleased]`, leaving Unreleased empty.
- Update the link references at the bottom:
  ```
  [Unreleased]: https://github.com/cryskai/crysk/compare/v$V...HEAD
  [$V]: https://github.com/cryskai/crysk/compare/v$PREV...v$V
  ```

### 4. Bump the version in all five places

```bash
sed -i '' "s/\"version\": \"$PREV\"/\"version\": \"$V\"/" package.json
sed -i '' "s/ENGINE_VERSION = \"$PREV\"/ENGINE_VERSION = \"$V\"/" src/index.ts
sed -i '' "s/  return \"$PREV\";/  return \"$V\";/" src/assets.ts
sed -i '' "s/options.version ?? \"$PREV\"/options.version ?? \"$V\"/" src/updater.ts
sed -i '' "s/VERSION=\"$PREV\"/VERSION=\"$V\"/" install.sh
grep -n "$PREV" package.json src/index.ts src/assets.ts src/updater.ts install.sh   # must print nothing
grep -n "$V" package.json src/index.ts src/assets.ts src/updater.ts install.sh      # must print 5 lines
```

### 5. Pre-flight, including the macOS leg

`ci.yml` runs only on Ubuntu, so macOS runs only inside `release.yml`. Rehearse it here. The empty
`HOME` hides your Claude login and keychain:

```bash
bun install --frozen-lockfile && bun run typecheck && bun run check && bun run build
env CI=true GITHUB_ACTIONS=true HOME="$(mktemp -d)" bun test          # expect 0 fail
bun build --compile --target=bun-darwin-arm64 --minify --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig --define __PRHERO_VERSION__="\"$V\"" src/cli.ts \
  --outfile "$SCRATCH/crysk-darwin-arm64"
bun run scripts/compiled-smoke.ts "$SCRATCH/crysk-darwin-arm64"      # expect compiled-smoke: PASS
```

Check each exit code. Never pipe a check into `tail` and then act on it: the pipe hides the exit code.

### 6. Release PR into `dev`

```bash
git add package.json src/index.ts src/assets.ts src/updater.ts install.sh CHANGELOG.md
git commit -m "chore(release): v$V"
git push -u origin release/v$V
gh pr create -R cryskai/crysk --base dev --title "chore(release): v$V" --body "<changelog section>"
```

Wait for the checks and the Crysk review (`crysk status --pr <n> --wait --json`). Triage any finding
with `crysk-loop`. Then merge: `gh pr merge <n> -R cryskai/crysk --merge --match-head-commit <sha>`.

### 7. Promote `dev` to `main`

```bash
gh pr create -R cryskai/crysk --base main --head dev --title "chore: promote dev to main for v$V" \
  --body "Release v$V. See CHANGELOG.md."
```

Wait for the checks. The `crysk` gate on this PR is usually red: the whole diff since the last release is over the size
gate, so no review runs. Every change in it was already reviewed in its own PR into `dev`. Only the
`Test, typecheck & lint` check is required on `main`. Ask the maintainer how to close it. Their usual
choice is `/crysk override`, posted only on their explicit instruction. The comment must be exactly
`/crysk override` and nothing else: with any extra text, the workflow says "This comment is not a
crysk command" and does nothing.

Once the gate is settled the way the maintainer chose, merge with `--merge`, then go to step 8.

### 8. Publish to npm by hand, before any tag

`release.yml` skips npm because there is no `NPM_TOKEN`. Build the release commit on `main` first,
because both paths below need it:

```bash
git switch main && git pull --ff-only origin main
git log --oneline -1                                   # must be the dev → main merge for v$V
bun install --frozen-lockfile && bun run build         # the tarball ships dist/
npm view crysk@$V version --prefer-online              # prints $V if already published; E404 if not
```

Then take exactly one path.

**8a. Already published** (the maintainer may publish by hand). Do not publish again. Check that the
package on npm is byte-identical to a local pack of the release commit, `dist/` included:

```bash
npm pack --pack-destination "$SCRATCH" --silent
mkdir "$SCRATCH/local" "$SCRATCH/npm"
tar xzf "$SCRATCH/crysk-$V.tgz" -C "$SCRATCH/local"
(cd "$SCRATCH/npm" && npm pack crysk@$V --silent && tar xzf crysk-$V.tgz)
diff -rq "$SCRATCH/local/package" "$SCRATCH/npm/package"   # must print nothing
```

If the diff prints anything, the package does not match the release commit: stop and tell the
maintainer. If it prints nothing, go to step 9. The npm-side checks in step 10 still apply.

**8b. Not published yet.**

```bash
npm whoami                                             # E401: ask the maintainer to run `! npm login`
npm publish --access public                            # prerelease: add --tag next
```

If the publish fails, stop here. Nothing is tagged yet, so the release can be retried cleanly. An
`E404` on `PUT` means missing credentials, not a missing package.

After a successful publish, wait for the registry for at most 15 minutes. Run this in the background,
because a foreground `sleep` may be blocked:

```bash
for i in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/crysk/$V)" = 200 ] && echo "crysk@$V is live" && break
  sleep 30
done
npm view crysk dist-tags --prefer-online               # latest: $V
```

If it is still missing after 15 minutes, look for `PUT ... 202` in `~/.npm/_logs/*-debug-0.log`. A 202
means the registry accepted the upload and is still processing it. Never publish twice. Once it is
live, go to step 9.

### 9. Tag and push

```bash
git tag -a v$V -m "Release v$V" \
  && git tag -fa v0 -m "Release v0 (points to v$V)" \
  && git push origin v$V \
  && git push origin v0 --force
```

The `&&` chain matters: if `v$V` fails to push, `v0` must not move. Workflows that use `@v0` would
otherwise run code that has no release.

The tag starts `release.yml`. It runs `verify-version`, then four binary builds (each runs the suite and
the compiled smoke), then the GitHub Release (`make_latest: true`), then `mirror-legacy`, which copies
the release to `juanmaagd/pr-hero`. Watch it:

```bash
gh run list -R cryskai/crysk --workflow release.yml --limit 1
gh run watch <run-id> -R cryskai/crysk --exit-status
```

### 10. Verify

```bash
gh release view v$V -R cryskai/crysk --json assets,isPrerelease --jq '.isPrerelease, (.assets[].name)'
gh release list -R cryskai/crysk --limit 3           # v$V is Latest
git ls-remote origin 'refs/tags/v0^{}'               # equals the release commit
gh release list -R juanmaagd/pr-hero --limit 2       # mirror has v$V as Latest
npm view crysk version --prefer-online               # $V
```

A failed `mirror-legacy` job usually means `LEGACY_MIRROR_TOKEN` expired. Renew it and re-run the
job, or run `scripts/mirror-release.sh v$V` by hand. The script is idempotent. A failed binary leg
leaves a pushed tag with no release: see the runbook, §6 Scenario D.

### 11. Close out

- Return to `dev`: `git switch dev && git pull --ff-only`. Delete the local `release/v$V` branch.
- Issues fixed by PRs into `dev` stay open, because only merges to `main` auto-close them. Close the
  ones this release shipped and cite the release.
- Report: the version, the release URL, the npm version, and anything that needs the user's action,
  such as a breaking change from the changelog. Bumping a consumer repo's pin (for example musive's
  workflow) is a separate change in that repo.
