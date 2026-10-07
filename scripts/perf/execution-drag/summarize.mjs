// PERF-5 harness: totals over a directory of measure.mjs outputs
// (before*.json / after*.json), per board, throttle and drag / control.
// The 4x drag's frames over 25 ms against its own control's is the
// comparison PERF-5's done-when 1 reads. See README.md.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] || path.join(import.meta.dirname, "runs");
const totals = {};
for (const name of fs.readdirSync(dir).filter((f) => /^(before|after)\d+\.json$/.test(f)).sort()) {
  const board = name.startsWith("before") ? "before" : "after";
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { console.warn(`skipped ${name}: not a finished run`); continue; }
  for (const r of parsed.runs) {
    const key = `${board} ${r.cpuThrottle} ${r.drag ? "drag" : "control"}`;
    const t = (totals[key] ??= { runs: 0, over25ms: 0, over50ms: 0, longTasks: 0, longTaskMs: 0, worstFrameMs: 0, errors: 0 });
    t.runs += 1; t.over25ms += r.over25ms; t.over50ms += r.over50ms; t.longTasks += r.longTasks; t.longTaskMs += r.longTaskMs;
    t.worstFrameMs = Math.max(t.worstFrameMs, r.max ?? 0); t.errors += r.errors.length;
  }
}
console.table(totals);
