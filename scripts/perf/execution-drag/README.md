# Execution-board drag timing (PERF-5)

This harness measures `audit-reports/projects-tab/09-performance-scale.md`
`PERF-5` done-when 1: dragging a task on a 400-row schedule must not drop
frames, at normal CPU speed and at 4× CPU throttle. It is a measurement only.
The deterministic evidence is the counted test in
`lib/__tests__/j14ExecutionDragMemo.test.ts`.

## What it does

- `main.tsx` renders `components/projects/ExecutionView.tsx` alone, with 400
  stubbed rows: 20 phases of 19 tasks, a third of them chained.
- `stubs/` stand in for `lib/supabase` and for `next/dynamic`, `next/link` and
  `next/navigation`.
- `vite.config.mjs` bundles the board with the app's own code (`@/`).
- `build-css.mjs` builds the app's stylesheet into `public/app.css`. It runs
  `app/globals.css` through the app's PostCSS plugin.
- `measure.mjs` serves the bundle and opens it in headless Chromium through
  Playwright. At 1× and at 4× CPU (CDP `Emulation.setCPUThrottlingRate`) it
  sweeps the pointer 120 steps (360 px) across the fourth bar, once dragging
  it and once as the no-drag control. It prints JSON for each of the four
  runs: frame gaps from `requestAnimationFrame`, frames over 25 ms and over
  50 ms, and long tasks.
- `run-ab.sh` builds everything and runs `measure.mjs` `RUNS` times (default
  6), then prints `summarize.mjs`'s totals.

## Run it

You need Node 22 and the app's `npm ci`. Playwright with Chromium is not an
app dependency. Install it where you run this:
`npm i --no-save playwright && npx playwright install chromium`. Or point
`PLAYWRIGHT_MODULE` at an installed copy's entry file.

```sh
# the board as checked out, six runs
scripts/perf/execution-drag/run-ab.sh

# alternate with another checkout (e.g. the board before a change), run by run
git worktree add /tmp/board-before <commit>
BEFORE_ROOT=/tmp/board-before RUNS=8 scripts/perf/execution-drag/run-ab.sh
```

Results go to `runs/`, or to `OUT`: `after<n>.json`, `before<n>.json`, and
each run's `uptime`. `node summarize.mjs <dir>` prints the totals again.
`dist/`, `dist-before/`, `public/` and `runs/` are not committed.

## Reading it

Run on a quiet host. The load average is saved next to each run, and a loaded
host shows dropped frames in the control too. Done-when 1 holds at 4× when
the drag's frames over 25 ms are not above its own no-drag control's, over
six or more runs, with no long task the control does not also show. Record
the browser version, the host load and the totals in `PERF-5`.
