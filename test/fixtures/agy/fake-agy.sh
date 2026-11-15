#!/bin/sh
# A fake `agy` for offline tests (odd/tasks/antigravity-oauth.md T4). It records
# its argv, stdin and cwd under $HOME, then plays the scenario named by
# FAKE_AGY_SCENARIO. auth-failed.ndjson and the auth stderr lines are RECORDED
# from agy 1.5.7 (fake token, isolated HOME, 2026-11-15). The other event files
# and the AGY_ERROR lines are SYNTHESIZED from the Log (L5, L6) and the field
# names in the agy binary (`step_type`, `state`, `short_error`, `retryable`);
# their exact nesting is unverified against a signed-in run.
dir=$(cd "$(dirname "$0")" && pwd)
: > "$HOME/fake-agy-argv"
for arg in "$@"; do printf '%s\n' "$arg" >> "$HOME/fake-agy-argv"; done
cat > "$HOME/fake-agy-stdin"
pwd > "$HOME/fake-agy-cwd"
env | grep -E '^(GEMINI|GOOGLE)_' > "$HOME/fake-agy-env"
case "$FAKE_AGY_SCENARIO" in
  success) cat "$dir/success.ndjson"; exit 0 ;;
  no-tools) cat "$dir/no-tools.ndjson"; exit 0 ;;
  real-steps) cat "$dir/real-steps.ndjson"; exit 0 ;;
  print-timeout-agy-error)
    cat "$dir/print-timeout.ndjson"
    echo 'AGY_ERROR: {"short_error":"print timeout after 10m0s with the turn still in progress; the response is partial"}' >&2
    echo "[agy] print timeout after 10m0s" >&2
    exit 3 ;;
  auth)
    cat "$dir/auth-failed.ndjson"
    echo "Error: authentication required. Run 'agy' to log in, then retry." >&2
    echo "error: authentication failed or timed out" >&2
    exit 1 ;;
  quota)
    cat "$dir/model-error.ndjson"
    echo 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"short_error":"Quota exceeded for the Antigravity plan","error_id":"e-1"}' >&2
    exit 3 ;;
  rate-limit)
    cat "$dir/model-error.ndjson"
    echo 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":true,"short_error":"Too many requests","error_id":"e-2"}' >&2
    exit 3 ;;
  unavailable)
    cat "$dir/model-error.ndjson"
    echo 'AGY_ERROR: {"status":"UNAVAILABLE","code":503,"retryable":true,"short_error":"The service is currently unavailable","error_id":"e-3"}' >&2
    exit 3 ;;
  unauthenticated)
    cat "$dir/model-error.ndjson"
    echo 'AGY_ERROR: {"status":"UNAUTHENTICATED","code":401,"retryable":false,"short_error":"invalid_grant: token has been expired or revoked","error_id":"e-4"}' >&2
    exit 3 ;;
  short-limit)
    cat "$dir/model-error.ndjson"
    echo 'AGY_ERROR: {"short_error":"Too many requests, please slow down"}' >&2
    exit 3 ;;
  short-quota)
    cat "$dir/model-error.ndjson"
    echo 'AGY_ERROR: {"short_error":"Quota exceeded: no AI credits left"}' >&2
    exit 3 ;;
  short-auth)
    cat "$dir/model-error.ndjson"
    echo 'AGY_ERROR: {"short_error":"authentication failed"}' >&2
    exit 3 ;;
  short-unavailable)
    cat "$dir/model-error.ndjson"
    echo 'AGY_ERROR: {"short_error":"The model is overloaded, try again later"}' >&2
    exit 3 ;;
  short-unknown)
    cat "$dir/model-error.ndjson"
    echo 'AGY_ERROR: {"short_error":"something unexpected"}' >&2
    exit 3 ;;
  error-no-line)
    cat "$dir/model-error.ndjson"
    exit 3 ;;
  deep-steps)
    echo '{"event":"step_update","update":{"step":{"step_type":"tool","state":"DONE"}}}'
    cat "$dir/no-tools.ndjson"
    exit 0 ;;
  print-timeout)
    cat "$dir/print-timeout.ndjson"
    echo "[agy] print timeout after 10m0s" >&2
    exit 3 ;;
  flag-error)
    echo "error: unknown flag: --bogus" >&2
    exit 2 ;;
  unknown-agent)
    echo 'error: unknown agent "crysk-step"' >&2
    exit 1 ;;
  no-result)
    echo '{"event":"init","session_id":"s-5","model":"gemini-4-argon-high","tools":["read_file"]}'
    echo '{"event":"step_update","step_id":"1","step_type":"tool","tool_name":"read_file","state":"DONE"}'
    echo "not json at all"
    exit 0 ;;
  overflow)
    i=0
    while [ $i -lt 400 ]; do
      echo '{"event":"step_update","step_id":"x","step_type":"planner_response","state":"ACTIVE","text":"padding padding padding padding padding padding padding padding padding padding padding padding"}'
      i=$((i + 1))
    done
    cat "$dir/success.ndjson"
    exit 0 ;;
  hang)
    echo '{"event":"init","session_id":"s-6","model":"gemini-4-argon-high","tools":["read_file"]}'
    sleep 30
    exit 0 ;;
  *) echo "fake agy: unknown scenario '$FAKE_AGY_SCENARIO'" >&2; exit 9 ;;
esac
