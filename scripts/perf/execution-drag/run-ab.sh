#!/usr/bin/env bash
# PERF-5 harness: build the board's bundle and run measure.mjs RUNS times
# (default 6). With BEFORE_ROOT (another checkout of the app, e.g. a git
# worktree of the commit before a change) it also builds that board and
# alternates the two, before then after, run by run. Each run's host load
# is kept beside it (uptime). See README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
runs="${RUNS:-6}"
out="${OUT:-$here/runs}"
vite="$root/node_modules/.bin/vite"
cd "$here"
[ -f public/app.css ] || node build-css.mjs
PERF_OUT=dist "$vite" build --config vite.config.mjs
if [ -n "${BEFORE_ROOT:-}" ]; then
  PERF_APP_ROOT="$BEFORE_ROOT" PERF_OUT=dist-before "$vite" build --config vite.config.mjs
fi
mkdir -p "$out"
for i in $(seq 1 "$runs"); do
  if [ -n "${BEFORE_ROOT:-}" ]; then
    uptime > "$out/load_before$i.txt"
    DIST=dist-before node measure.mjs > "$out/before$i.json"
  fi
  uptime > "$out/load_after$i.txt"
  DIST=dist node measure.mjs > "$out/after$i.json"
done
node summarize.mjs "$out"
