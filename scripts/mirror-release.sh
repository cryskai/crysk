#!/usr/bin/env bash
# Mirror one final release from cryskai/crysk to juanmaagd/pr-hero (runbook Step 4d).
#
# WHY the mirror exists: binaries from before the repository move read their
# upgrades from juanmaagd/pr-hero's latest release, the old install URL serves
# juanmaagd/pr-hero's main, and `uses: juanmaagd/pr-hero@v0` resolves its tags.
# GitHub does not redirect any of those reliably after a transfer, so every
# final release must land there too, or those installs silently stop upgrading.
#
# Usage: scripts/mirror-release.sh vX.Y.Z
# Run from a full checkout of cryskai/crysk (all tags fetched). Reads the source
# release with the ambient gh credentials; writes the mirror with MIRROR_TOKEN
# (a token that can write juanmaagd/pr-hero), or the ambient credentials when it
# is unset. Idempotent: a re-run verifies what is already there and changes
# nothing. Stops at the first failure, before anything is published.
set -euo pipefail

V="${1:?usage: mirror-release.sh vX.Y.Z}"
SOURCE="${SOURCE_REPO:-cryskai/crysk}"
MIRROR="${MIRROR_REPO:-juanmaagd/pr-hero}"
MIRROR_URL="https://github.com/${MIRROR}.git"

if [[ ! "$V" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  # A prerelease neither moves v0 nor becomes latest at the source, and a
  # pre-move binary must never be offered one.
  echo "$V is not a final release tag: not mirrored"
  exit 0
fi

# Writes to the mirror authenticate as MIRROR_TOKEN when it is set. gh is the
# git credential helper so the token never appears in a URL or the log.
mirror_gh() {
  if [ -n "${MIRROR_TOKEN:-}" ]; then GH_TOKEN="$MIRROR_TOKEN" gh "$@"; else gh "$@"; fi
}
mirror_git() {
  if [ -n "${MIRROR_TOKEN:-}" ]; then
    GH_TOKEN="$MIRROR_TOKEN" git -c credential.helper= -c credential.helper='!gh auth git-credential' "$@"
  else
    git -c credential.helper= -c credential.helper='!gh auth git-credential' "$@"
  fi
}

git fetch -q origin --tags --force # CI's moved v0 and the release tag objects
COMMIT=$(git rev-parse --verify "$V^{commit}")
V0=$(git rev-parse --verify "v0^{commit}")
[ "$V0" = "$COMMIT" ] || {
  echo "v0 points at $V0, not at $V ($COMMIT): the source release did not finish"
  exit 1
}

echo "== refs: $V and v0 at $COMMIT"
# main on the mirror serves the old install URL; the release commit is the tip
# that matches the release (a plain push: the mirror's main never moves ahead).
mirror_git push -q "$MIRROR_URL" "$COMMIT:refs/heads/main"
mirror_git push -q "$MIRROR_URL" "refs/tags/$V"
mirror_git push -q --force "$MIRROR_URL" refs/tags/v0 # v0 exists there at the previous release

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
gh release download "$V" -R "$SOURCE" -D "$d/source"
(cd "$d/source" && sha256sum -c SHA256SUMS >/dev/null 2>&1 || shasum -a 256 -c SHA256SUMS >/dev/null) \
  || { echo "the source release's assets do not match its SHA256SUMS"; exit 1; }

if mirror_gh release view "$V" -R "$MIRROR" >/dev/null 2>&1; then
  echo "== release: $V already on $MIRROR, verifying it"
else
  echo "== release: creating $V on $MIRROR"
  gh release view "$V" -R "$SOURCE" --json body -q .body >"$d/notes.md"
  mirror_gh release create "$V" -R "$MIRROR" --verify-tag --latest --title "$V" \
    --notes-file "$d/notes.md" "$d"/source/*
fi

echo "== verify"
for t in v0 "$V"; do
  got=$(git ls-remote "$MIRROR_URL" "refs/tags/$t^{}" | cut -f1)
  [ "$got" = "$COMMIT" ] || { echo "mirror $t is '${got:-missing}', expected $COMMIT"; exit 1; }
done
latest=$(mirror_gh release view -R "$MIRROR" --json tagName -q .tagName)
[ "$latest" = "$V" ] || { echo "mirror latest release is $latest, expected $V"; exit 1; }
gh release download "$V" -R "$MIRROR" -D "$d/mirror"
diff -r "$d/source" "$d/mirror" >/dev/null || { echo "mirror assets differ from $SOURCE's"; exit 1; }
echo "mirror OK: $MIRROR $V = $SOURCE $V ($COMMIT)"
