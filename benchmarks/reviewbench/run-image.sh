#!/usr/bin/env bash
# Runs the image on ReviewBench's test set through its own try-agent.sh, for
# private scoring on a subscription token. See README.md.
#
#   CLAUDE_CODE_OAUTH_TOKEN=... run-image.sh <reviewbench clone> <out dir> [index]
#
# Findings land in <out>/findings. A pull request with findings is skipped, and
# the run stops at the first failure, which is usually the plan's quota.
set -euo pipefail

[ $# -ge 2 ] || { sed -n '5p' "$0" >&2; exit 2; }
clone="$(cd "$1" && pwd)"
mkdir -p "$2"
out="$(cd "$2" && pwd)"
only="${3:-}"
: "${CLAUDE_CODE_OAUTH_TOKEN:?set it to the token of the account to spend}"
image="${IMAGE:-crysk-reviewbench:dev}"
manifest="$clone/corpus/test/test.json"
count="$(jq length "$manifest")"

cd "$out"
for i in $(if [ -n "$only" ]; then echo "$only"; else seq 0 $((count - 1)); fi); do
  key="$(jq -r ".[$i] | \"\(.nwo | sub(\"/\"; \"_\"))_\(.pr_number)-\(.head[0:8])\"" "$manifest")"
  if [ -f "findings/$key.json" ]; then
    echo "$key: findings exist, skipped" >&2
    continue
  fi
  TRY_AGENT_WORK="$out/work" "$clone/scripts/try-agent.sh" "$image" --pr "$i" \
    -e CLAUDE_CODE_OAUTH_TOKEN -e RB_STRICT=1 -e RB_RUN_DIR=/work/out/run \
    -e RB_CONFIG_MODEL="${RB_CONFIG_MODEL:-}"
done
