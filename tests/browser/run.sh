#!/usr/bin/env bash
# Runs every browser test against a local copy of the app. Needs Node and Playwright with Chromium
# (npm i -D playwright && npx playwright install chromium, unless they're already installed).
# The app talks to a stand-in Supabase (stand-in-supabase.mjs) that applies the same access rules,
# so no network or real database is needed. Usage: tests/browser/run.sh [test file ...]
set -u
cd "$(dirname "$0")/../.."
PORT="${PORT:-8766}"
export TRIPSPLIT_BASE="http://localhost:$PORT/"
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
for _ in $(seq 1 20); do curl -s -o /dev/null "$TRIPSPLIT_BASE" && break; sleep 0.25; done
tests=("$@")
[ ${#tests[@]} -eq 0 ] && tests=(tests/browser/permissions.test.cjs tests/browser/trip-lifecycle.test.cjs tests/browser/groups.test.cjs tests/browser/demo-mode.test.cjs tests/browser/csp.test.mjs)
failed=0
for t in "${tests[@]}"; do
  echo "=== $t"
  node "$t" || failed=$((failed + 1))
done
echo
[ $failed -eq 0 ] && echo "All browser tests passed." || echo "$failed browser test file(s) failed."
exit $failed
