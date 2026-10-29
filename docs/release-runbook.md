# Release Runbook

This document is the operational runbook for releasing new versions of Crysk (npm package `crysk`, GitHub repository `cryskai/crysk`; the package was called `pr-hero` before the rename, see Step 4c). It covers the repository branching model, versioning rules, step-by-step release instructions, CI/CD pipeline automation, post-release verification, and rollback procedures.

---

## 1. Branching Model & Commit Standards

Crysk uses **Trunk-Based Development** centered on the `main` branch:

- **Primary Branch (`main`)**: The stable source of truth. All releases are tagged directly from `main`.
- **Feature & Fix Branches**: Work happens in short-lived branches branched off `main` (e.g. `feat/new-hunter`, `fix/tui-wrap`, `chore/bump-deps`).
- **Pull Request Gating**: Branches merge into `main` via pull requests only after passing automated CI checks (`.github/workflows/ci.yml`: test suite, type checking, linter check, and binary compilation).
- **Conventional Commits**: Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:
  - `feat:` New user-facing features or capabilities
  - `fix:` Bug fixes and defect corrections
  - `chore:` Toolchain updates, dependency bumps, maintenance
  - `chore(release):` Release commits bumping versions and changelog
  - `docs:` Documentation improvements
  - `test:` Test additions or test framework refactoring
  - `refactor:` Code restructuring without behavior changes
  - `perf:` Performance optimizations

---

## 2. Versioning Scheme

Crysk adheres to **[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)** (`MAJOR.MINOR.PATCH`):

- **`MAJOR`**: Breaking changes to CLI behavior, configuration schema, public API exports, or GitHub Actions contracts.
- **`MINOR`**: Backwards-compatible new features, new agent classes, or enhanced tooling.
- **`PATCH`**: Backwards-compatible bug fixes, performance improvements, or documentation updates.

### Version Synchronization Invariant

The project version is maintained in five locations and must always remain identical:

1. `package.json`: `"version": "X.Y.Z"` — the canonical source of truth.
2. `src/index.ts`: `export const ENGINE_VERSION = "X.Y.Z";` — the published API's version constant.
3. `src/assets.ts` (`resolveVersion()`, fallback `return "X.Y.Z";`) — used only when neither the
   compiled `__PRHERO_VERSION__` define nor a readable `package.json` is available.
4. `src/updater.ts` (`detectInstallMethod()`, `options.version ?? "X.Y.Z"`) — the default version
   assumed when no version is passed in.
5. `install.sh` (`VERSION="X.Y.Z"`) — the fallback used when the GitHub API "latest release" lookup
   fails or returns no tag.

`MCP_SERVER_VERSION` in `src/mcp/preflight.ts` is a separate, independent MCP protocol-server version —
it is not part of this invariant and must not be bumped alongside a package release.

### Git Tagging Strategy

Two distinct tag types are used:

1. **Immutable Release Tags (`vX.Y.Z`)**:
   - Annotated Git tags representing specific point-in-time releases (e.g. `v1.0.0`, `v1.1.0`).
   - Once pushed to GitHub, immutable release tags must **never** be moved or re-pointed. The one
     narrow, checked exception is a release run that failed before any GitHub Release existed for the
     tag — see §6, Scenario D. Everything else is a patch release (Scenario A).
2. **Floating Major Tags (`v0`, `v1`, `v2`, etc.)**:
   - Floating tags pointing to the latest release within a major version line. The current floating
     tag is `v0` while the project is pre-1.0 (0.x minor bumps may still break the CLI/config/Action
     contract — see the pre-1.0 semantics note below).
   - Consumed by GitHub Actions users referencing the composite action (e.g., `uses: cryskai/crysk@v0`).
   - Moved/force-updated on every release within that major version line.
   - `v1` is a **frozen legacy tag**: it stopped moving at the last 1.x release (1.1.0) when versions
     were renumbered to 0.x, and must never be moved again. It is kept only so pre-existing workflows
     pinned to `@v1` keep resolving.

### Pre-1.0 semantics (SemVer §4)

While the major version is `0`, a MINOR bump (`0.x.0`) may contain breaking changes to CLI behavior,
configuration schema, or the GitHub Actions contract — SemVer does not guarantee compatibility below
`1.0.0`. Treat every `0.x` release note as "may break" until the project ships `1.0.0` again on its own
merits.

---

## 3. Step-by-Step Release Process

Follow these steps sequentially to execute a release.

### Step 1: Pre-Release Verification

Ensure your local repository is up-to-date with `main` and all verification suites pass:

```bash
# 1. Switch to clean main branch
git checkout main
git pull origin main

# 2. Install dependencies with frozen lockfile
bun install --frozen-lockfile

# 3. Execute test suite, type check, linter, and build bundle
bun test
bun run typecheck
bun run check
bun run build

# 4. (Optional) Run domain-specific probes
bun run fixture-eval
bun run refuter-probe
```

All commands must exit cleanly with code `0`.

**macOS is only tested by `release.yml`.** `ci.yml` runs on `ubuntu-latest` alone, so no pull request ever
runs the suite, the compile or the compiled-binary smoke on darwin; the first time they run is the
release itself (the `0.2.0` release run failed on both macOS legs for exactly this reason). On a Mac,
rehearse that leg before tagging. The empty `HOME` matters: a developer machine with a Claude login hides
tests that silently depend on the macOS keychain.

```bash
# Suite as a bare macOS runner sees it (no keychain item, empty HOME)
env CI=true GITHUB_ACTIONS=true HOME="$(mktemp -d)" bun test

# Compile and smoke the binary exactly as release.yml does (use your own target)
bun build --compile --target=bun-darwin-arm64 --minify --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig --define __PRHERO_VERSION__='"X.Y.Z"' src/cli.ts \
  --outfile /tmp/crysk-darwin-arm64
bun run scripts/compiled-smoke.ts /tmp/crysk-darwin-arm64
```

### Step 2: Update Changelog

Open `CHANGELOG.md` and prepare the release section:

1. Change `## [Unreleased]` into the new release header: `## [X.Y.Z] - YYYY-MM-DD` (e.g., `## [1.0.0] - 2026-08-25`).
2. Add a fresh, empty `## [Unreleased]` section above it.
3. Update the link references at the bottom of `CHANGELOG.md`:
   ```markdown
   [Unreleased]: https://github.com/cryskai/crysk/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/cryskai/crysk/releases/tag/vX.Y.Z
   ```

### Step 3: Bump Version Numbers

Update the version string in all five synchronization targets:

- In `package.json`:
  ```json
  "version": "X.Y.Z",
  ```
- In `src/index.ts`:
  ```typescript
  export const ENGINE_VERSION = "X.Y.Z";
  ```
- In `src/assets.ts` (`resolveVersion()`'s fallback, used when neither the compiled define nor
  `package.json` is readable):
  ```typescript
  return "X.Y.Z";
  ```
- In `src/updater.ts` (`detectInstallMethod()`'s default when no version is passed in):
  ```typescript
  const version = options.version ?? "X.Y.Z";
  ```
- In `install.sh` (the fallback used when the GitHub API "latest release" lookup fails):
  ```bash
  VERSION="X.Y.Z"
  ```

### Step 4: Commit and Tag Release

The tag you push in the next step MUST carry the exact version you just set in `package.json` (Step 3):
`.github/workflows/release.yml` now runs a `verify-version` job before anything is built that fails the
whole run with `::error::` when `${GITHUB_REF_NAME#v}` (the tag, minus its leading `v`) differs from
`package.json`'s `version`. Do the version bump and the changelog heading first, commit, THEN tag —
tagging before bumping the version is exactly the mismatch this guard exists to catch.

Create the release commit and annotate the Git tags:

```bash
# 1. Stage modified files
git add package.json src/index.ts src/assets.ts src/updater.ts install.sh CHANGELOG.md

# 2. Create conventional release commit
git commit -m "chore(release): vX.Y.Z"

# 3. Create immutable annotated tag
git tag -a vX.Y.Z -m "Release vX.Y.Z"

# 4. Update the floating major tag (v0 while pre-1.0; e.g. v1 once back on a 1.x.y line)
git tag -fa v0 -m "Release v0 (points to vX.Y.Z)"
```

### Step 4b: Publish to npm (manual, before pushing the tag)

`release.yml` publishes to npm only when the `NPM_TOKEN` secret exists, and today it does not. The CI token
failed with `E404` on `PUT /pr-hero`: the `v1.1.0` run created its GitHub Release and the floating tag and
then died at that step, so `1.1.0` never reached npm, and the secret was removed on 2026-09-29. Until npm
trusted publishing is set up, npm is published by hand from the release commit.

Do it **before** pushing the tag. If the publish fails, nothing else has moved; CI used to publish last,
after the GitHub Release, so a failure left a half-release.

```bash
git switch main && git pull --ff-only origin main   # the release commit, clean tree
bun install --frozen-lockfile && bun run build      # the tarball ships dist/
npm login             # interactive (browser or passkey); `npm whoami` fails with E401 without a session
npm whoami            # must print the package owner (see `npm owner ls crysk`)
npm publish --access public
```

- No `--provenance`: it only works from a supported CI provider (OIDC), so a manual publish carries none.
- **Prereleases** (`vX.Y.Z-rc.N`): add `--tag next`. Without it npm points `latest` at the prerelease.
- `npm publish` moves `latest` to the version it publishes, whatever the SemVer order. That is intended for
  the `1.x → 0.x` renumbering (`latest` went from `1.0.0` to `0.2.0`), and it is why an existing `^1` range
  never sees the `0.x` line.
- `E404` on `PUT` for a package that exists means no valid credentials, not a missing package. A
  `PUT ... 202` (see `~/.npm/_logs/*-debug-0.log`) means the registry accepted the upload and is processing
  it asynchronously: for `0.2.0` the version and `latest` took about 9 minutes to appear. Poll, and do not
  publish again:
  ```bash
  until [ "$(curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/crysk/X.Y.Z)" = 200 ]; do sleep 30; done
  npm view crysk dist-tags --prefer-online   # expect latest: X.Y.Z
  ```
- The workflow's npm step stays in place and is skipped without the secret. If `NPM_TOKEN` is ever restored,
  stop publishing by hand: the step would fail on a version that already exists.

### Step 4c: The rename release (`pr-hero` → `crysk`), one time

The release that carries the rename publishes two packages built from the **same commit**, in this order. This
section describes the sequence; each command is run by the maintainer, never by CI or an agent.

1. **`crysk`** — Step 4b as written: the package whose `package.json` `name` is `crysk`.
2. **One last `pr-hero`** — the same build and the same version, published once more under the old name, so an
   install that runs `npx pr-hero` or `npm i -g pr-hero` lands on a CLI that already reads both the old and the
   new names (markers, `/pr-hero` commands, `PRHERO_*` variables, `~/.prhero`). It must be the full dual-read
   build, not a stub that only prints "renamed": an agent holding an old `pr-hero` cannot parse `<!-- crysk-`
   markers, so the last `pr-hero` the registry serves has to understand them. Only the `name` field differs, set in
   a scratch copy of the package; nothing about it is committed.
3. **`npm deprecate pr-hero "renamed to crysk"`** — after both versions are visible on the registry (Step 5 below,
   NPM Registry Verification), deprecate every `pr-hero` version with that message so `npm install` prints it. No
   further `pr-hero` version is published after this one.

`pr-hero` stays on the registry (an unpublish would break the pinned installs it is meant to carry forward). The GitHub
Release uploads each binary under both names for one version (§4). The repository moved to `cryskai/crysk`;
`juanmaagd/pr-hero` is a mirror kept for workflows and binaries that still name it (Step 4d).

### Step 4d: The repository move (`juanmaagd/pr-hero` → `cryskai/crysk`), one time

GitHub does not guarantee that `uses:` follows a renamed or transferred repository ("GitHub will not redirect
calls to an action hosted by a renamed repository", [Renaming a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)).
So the move keeps a repository at the old name. Each step is run by the maintainer, never by CI or an agent:

1. **Transfer and rename** `juanmaagd/pr-hero` to `cryskai/crysk` (Settings → Transfer, new name `crysk`).
   Issues, pull requests, stars, history, tags, releases, secrets and variables move with it. Check the
   repository's Actions secrets and variables afterwards.
2. **Recreate `juanmaagd/pr-hero` at once** as a public mirror: `git push --mirror` of `main` and every tag,
   so `uses: juanmaagd/pr-hero@v0` (and every `@v0.x.y`) keeps resolving and
   `https://raw.githubusercontent.com/juanmaagd/pr-hero/main/install.sh` keeps serving the installer.
   Creating it stops GitHub's web and git redirect to `cryskai/crysk`: point local clones at the new remote
   (`git remote set-url origin https://github.com/cryskai/crysk.git`).
3. **Every release while the mirror lives also goes to the mirror:** push the release commit and both tags
   (`vX.Y.Z` and the moved `v0`) there, and create the same GitHub Release with the same assets and
   `SHA256SUMS`. A binary from before the move (`src/updater.ts` read `juanmaagd/pr-hero`) finds its upgrade
   there; without the mirrored release, `pr-hero upgrade` on such a binary reports no new version.
4. Archive the mirror once the version that drops the legacy names ships; an archived repository keeps serving
   its tags.

### Step 5: Push to Remote

Push only after Step 4b succeeded. Pushing the tag starts the release pipeline (§4). Push the release
commit, immutable tag, and updated floating tag to GitHub:

```bash
# 1. Push main branch
git push origin main

# 2. Push the immutable release tag
git push origin vX.Y.Z

# 3. Force-push the floating major tag
git push origin v0 --force
```

---

## 4. Automated CI/CD Release Pipeline

Pushing a `v*` tag automatically triggers the GitHub Actions Release Workflow (`.github/workflows/release.yml`):

```mermaid
flowchart TD
    A["Push git tag vX.Y.Z"] --> V["Job: verify-version"]
    V --> B["Job: build-binaries (Matrix)"]
    B --> B1["darwin-arm64 (macOS Apple Silicon)"]
    B --> B2["darwin-x64 (macOS Intel)"]
    B --> B3["linux-x64 (Ubuntu x64)"]
    B --> B4["linux-arm64 (Ubuntu ARM64)"]
    B1 & B2 & B3 & B4 --> C["Upload Binary Artifacts"]
    C --> D["Job: publish-release (Ubuntu)"]
    D --> E["Generate SHA256SUMS"]
    D --> F["Create GitHub Release with Binaries (make_latest: true)"]
    D --> G["Build npm Bundle (bun run build)"]
    D --> H["Publish to NPM (only if NPM_TOKEN is set; skipped today, see Step 4b)"]
```

### Pipeline Workflow Stages

0. **`verify-version`**:
   - Runs first, before anything is built. Compares `${GITHUB_REF_NAME#v}` (the pushed tag, minus its
     leading `v`) against `package.json`'s `"version"`. A mismatch fails the job immediately with an
     `::error::` annotation and nothing else in the pipeline runs.
   - WHY this exists: the compiled binary embeds its version from the **tag** (`__PRHERO_VERSION__` in
     the "Compile standalone binary" step below), while `npm publish` ships whatever `package.json` says.
     Those are two independently-settable strings for the same release — without this gate, a tagging
     mistake ships two different version numbers under one release, silently.
1. **`build-binaries`**:
   - Executes across a matrix of 4 runner environments (`macos-latest`, `macos-15-intel`, `ubuntu-latest`, `ubuntu-24.04-arm`), each on its target's own architecture so the smoke below can execute what it built. `fail-fast: false`, so a failing leg does not cancel the other three — they finish and upload, and the run reports every failure rather than only the first. This does **not** keep the release publishing: `publish-release` has a bare `needs: build-binaries`, so any failed leg skips it. That is deliberate — a release missing one platform binary would give `install.sh` a 404 on that architecture, while a failed release leaves the previous version installable.
   - Runs full test suite and typechecks on each OS. This is the only place the suite runs on macOS
     (`ci.yml` is ubuntu-only), so a darwin-only failure surfaces here first; rehearse it in Step 1. A
     failed leg leaves a pushed tag with no release: see §6, Scenario D.
   - Compiles standalone executables using `bun build --compile --minify` with embedded version definitions.
   - **Runs the compiled binary** (`scripts/compiled-smoke.ts`) before uploading it. v1.0.0 shipped a binary whose `review` failed for every user because this step did not exist.
   - Uploads each binary under both names for one version: `crysk-<target>` and a byte-identical `pr-hero-<target>` copy made after the smoke (targets `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`). The old name is what an installed `pr-hero upgrade` downloads.
2. **`publish-release`**:
   - Gathers all compiled binaries and computes cryptographic `SHA256SUMS`.
   - Creates a GitHub Release via `softprops/action-gh-release@v2` containing all binaries and checksums,
     with `make_latest: true`. This is explicit rather than left to GitHub's own SemVer-highest default:
     `crysk upgrade` and `install.sh` both resolve GitHub's "latest release", and after the 1.x → 0.x
     renumbering the next release (`0.2.0`) is SemVer-**lower** than the already-published `1.1.0` —
     without `make_latest: true`, GitHub would keep calling `1.1.0` latest forever and every
     upgrade/install would silently stay stuck on the old numbering.
   - Generates release notes automatically from commit history and pull requests.
   - Builds the npm distribution bundle and, **only when the `NPM_TOKEN` secret exists**, publishes it with
     `npm publish --provenance`. The secret is currently unset, so this step is skipped and npm is
     published by hand (Step 4b).

---

## 5. Post-Release Verification

Perform these sanity checks immediately following a release:

1. **GitHub Release Verification**:
   - Visit `https://github.com/cryskai/crysk/releases/tag/vX.Y.Z`.
   - Confirm all 4 platform binaries and `SHA256SUMS` are attached as release assets, and that the release
     is the one GitHub marks `Latest` (after the renumbering it must not be `1.1.0`):
     ```bash
     gh release view vX.Y.Z --json assets,isPrerelease --jq '.isPrerelease, (.assets[].name)'
     gh release list --limit 3
     ```
   - Confirm the floating tag moved: `git ls-remote origin 'refs/tags/v0^{}'` must equal the release commit.
2. **NPM Registry Verification** (the version can lag the upload by ~10 minutes, see Step 4b; on the rename release also run both commands for `pr-hero`, see Step 4c):
   ```bash
   # Check published package version
   npm view crysk version --prefer-online
   npm view crysk dist-tags --prefer-online
   ```
3. **Installer Script Test**:
   - Test standalone installer download in a temporary environment:
     ```bash
     PRHERO_VERSION="vX.Y.Z" curl -fsSL https://raw.githubusercontent.com/cryskai/crysk/main/install.sh | bash
     ~/.crysk/bin/crysk --version   # ~/.prhero/bin/pr-hero on a machine that already had ~/.prhero
     ```
4. **GitHub Action Reference**:
   - Confirm workflows referencing `cryskai/crysk@v0` or `cryskai/crysk@vX.Y.Z` resolve the new
     release. (Workflows still pinned to the frozen `@v1` continue resolving the last 1.x release, by
     design — they receive no further updates.)
5. **Doctor Diagnostic**:
   - Run `crysk doctor` locally to verify runtime integrity and toolchain health.

---

## 6. Rollback & Hotfix Procedures

### Scenario A: Urgent Bug Discovered in Released Version

**Rule: Never mutate existing immutable tags or rewrite release history.**

1. Create a hotfix branch from `main`:
   ```bash
   git checkout -b fix/hotfix-issue-name main
   ```
2. Apply the fix and add regression tests.
3. Update `CHANGELOG.md` with patch notes and increment the patch version (`vX.Y.Z+1`) in `package.json` and `src/index.ts`.
4. Merge into `main` and execute the release process for `vX.Y.Z+1`.
5. The floating `v0` tag will automatically update to point to the new patch release, instantly protecting Action users. (The frozen `v1` tag never moves again — see §2.)

### Scenario B: Compromised or Broken NPM Package

If a critical flaw requires immediately warning package consumers:

1. **Deprecate the flawed version on npm**:
   ```bash
   npm deprecate crysk@X.Y.Z "Critical issue in X.Y.Z; please upgrade to X.Y.Z+1 immediately."
   ```
2. **Unpublishing (Emergency only)**:
   - NPM allows unpublishing only within 72 hours of initial release if no dependents exist (`npm unpublish crysk@X.Y.Z --force`).
   - Prefer deprecation + immediate patch release (`vX.Y.Z+1`) to avoid breaking downstream builds.

### Scenario C: Mispointed Floating Tag

If the floating tag `v0` was pushed to an incorrect commit SHA:

```bash
# Re-align floating tag locally to the correct release commit
git tag -fa v0 <target-commit-sha> -m "Re-align floating v0 tag"

# Force push updated floating tag
git push origin v0 --force
```

Never apply this to `v1` — it is frozen at the last 1.x release and must never be re-pointed.

### Scenario D: Release Run Failed Before the GitHub Release Existed

Typically a `build-binaries` leg failed, so `publish-release` was skipped: the tag is pushed, but there is
no GitHub Release, no binaries and no floating tag. Re-running the failed jobs does not help when the
failure is deterministic, because the run builds the tag's own commit.

The default is still a patch release (Scenario A). Moving the tag is allowed only when **all** of these hold:

1. `gh release view vX.Y.Z` reports `release not found`: nothing consumable hangs off the tag.
2. The fix changes nothing that ships. This must print nothing, and `package.json` must still say `X.Y.Z`
   (if npm was already published, its tarball stays valid because none of its files changed):
   ```bash
   git diff --name-only <old-tag-commit>..origin/main | grep -v '^test/'
   ```
3. The fix reached `main` through the normal pull request flow first.

Then re-point the tag with a lease on its current remote value, so the push fails if anyone touched it in
between. A forced tag update starts a fresh `release.yml` run:

```bash
git fetch origin main
git tag -fa vX.Y.Z -m "Release vX.Y.Z" origin/main
git push origin vX.Y.Z --force-with-lease=refs/tags/vX.Y.Z:$(git ls-remote origin refs/tags/vX.Y.Z | cut -f1)
```

Record the deviation in the promotion pull request. Precedent: `v0.2.0` moved from `d36e51a` to `05feaac`
on 2026-09-29 after five keychain-dependent tests failed on both macOS legs (fixed test-only).
