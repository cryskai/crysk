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
# nothing. The source release is downloaded and checked before the first write
# to the mirror; a failure after that point is completed by a re-run.
set -euo pipefail

V="${1:?usage: mirror-release.sh vX.Y.Z}"
SOURCE="${SOURCE_REPO:-cryskai/crysk}"
MIRROR="${MIRROR_REPO:-juanmaagd/pr-hero}"
MIRROR_URL="https://github.com/${MIRROR}.git"

if [[ ! "$V" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  # A prerelease neither moves the floating tag nor becomes latest at the source, and a
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

git fetch -q origin --tags --force # CI's moved floating tag and the release tag objects
COMMIT=$(git rev-parse --verify "$V^{commit}")
MAJOR="${V%%.*}" # the floating tag release.yml moves: v0 for 0.x, v1 for 1.x
FLOAT=$(git rev-parse --verify "$MAJOR^{commit}")
[ "$FLOAT" = "$COMMIT" ] || {
  echo "$MAJOR points at $FLOAT, not at $V ($COMMIT): the source release did not finish"
  exit 1
}

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT

# Every asset must be on its SHA256SUMS line and match it. `-c` alone passes an
# asset the file does not list.
check_assets() {
  local dir="$1"
  [ -f "$dir/SHA256SUMS" ] || { echo "$dir has no SHA256SUMS"; return 1; }
  (cd "$dir" && { sha256sum -c SHA256SUMS >/dev/null 2>&1 || shasum -a 256 -c SHA256SUMS >/dev/null; }) \
    || { echo "assets in $dir do not match SHA256SUMS"; return 1; }
  local listed
  for f in "$dir"/*; do
    [ "$(basename "$f")" = SHA256SUMS ] && continue
    listed=$(awk -v n="$(basename "$f")" '$2 == n || $2 == "*" n' "$dir/SHA256SUMS")
    [ -n "$listed" ] || { echo "$(basename "$f") has no SHA256SUMS line"; return 1; }
  done
}

# Everything is downloaded and checked BEFORE the first write to the mirror, so
# a failure here leaves the mirror exactly as it was.
gh release download "$V" -R "$SOURCE" -D "$d/source"
check_assets "$d/source"
gh release view "$V" -R "$SOURCE" --json body -q .body >"$d/notes.md"

echo "== refs: $V and $MAJOR at $COMMIT"
# main on the mirror serves the old install URL; the release commit is the tip
# that matches the release (a plain push: the mirror's main never moves ahead).
mirror_git push -q "$MIRROR_URL" "$COMMIT:refs/heads/main"
mirror_git push -q "$MIRROR_URL" "refs/tags/$V"
mirror_git push -q --force "$MIRROR_URL" "refs/tags/$MAJOR" # exists there at the previous release

if mirror_gh release view "$V" -R "$MIRROR" >/dev/null 2>&1; then
  echo "== release: $V already on $MIRROR, verifying it"
else
  echo "== release: creating $V on $MIRROR"
  mirror_gh release create "$V" -R "$MIRROR" --verify-tag --latest --title "$V" \
    --notes-file "$d/notes.md" "$d"/source/*
fi

echo "== verify"
for t in "$MAJOR" "$V"; do
  got=$(git ls-remote "$MIRROR_URL" "refs/tags/$t^{}" | cut -f1)
  [ "$got" = "$COMMIT" ] || { echo "mirror $t is '${got:-missing}', expected $COMMIT"; exit 1; }
done
latest=$(mirror_gh release view -R "$MIRROR" --json tagName -q .tagName)
[ "$latest" = "$V" ] || { echo "mirror latest release is $latest, expected $V"; exit 1; }
gh release download "$V" -R "$MIRROR" -D "$d/mirror"
diff -r "$d/source" "$d/mirror" >/dev/null || { echo "mirror assets differ from $SOURCE's"; exit 1; }
check_assets "$d/mirror"
echo "mirror OK: $MIRROR $V = $SOURCE $V ($COMMIT)"
