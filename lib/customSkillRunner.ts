// lib/customSkillRunner.ts — Connection Skill patterns run off the request
// thread, under a HARD wall-clock limit (LNK-6, DEC-55).
//
// The bounded pattern subset (patternSafetyIssue) refuses the known
// catastrophic shapes, but it is a filter, not a proof: a pattern inside it
// can still backtrack for seconds on one pathological chunk (`\w+a\w+X`
// over a long run of letters), and V8 cannot interrupt a single RegExp exec.
// So the matching runs in a worker thread and this module is the clock:
//   * the worker reads its own clock between matches; a skill whose time on
//     ONE TEXT (a page of indexed text) passes the per-text budget skips the
//     rest of that document and goes on with the next one (the same rule
//     as runCustomSkill, measured where the regex runs). The budget is per
//     text so it measures backtracking, not how long a manual is;
//   * this thread terminates the worker when one text has been running for
//     longer than `hardDocMs` (a single exec that never returns), or when
//     the skill's budget is spent — whatever the regex is doing.
// A terminated worker is replaced on the next skill (the texts are sent
// again); a skill that only skipped documents keeps the worker.
//
// Server-only (node:worker_threads). The engine (lib/linkProposerServer.ts)
// is also reachable from browser bundles through the publish pipeline, so it
// never imports this module: the /api/links/propose route hands it in.

import { Worker } from "node:worker_threads";

/** LNK-6: the longest one text may run under one skill before the worker is
 *  terminated — the ceiling on a single match that never returns. */
export const SKILL_DOC_HARD_MS = 1_000;
/** A worker that has not loaded the texts within this long is given up on. */
const WORKER_START_MS = 10_000;

export interface SkillMatchLimits {
  /** Per-text budget, read between matches inside the worker. */
  softDocMs: number;
  /** What this skill may spend, from now (its share of the run's budget). */
  budgetMs: number;
  /** Matches kept per pattern per text. */
  maxMatches: number;
}

export interface SkillMatchOutcome {
  /** found[i]: the strings matched in text i, in match order — set for
   *  every text the skill finished; unset for texts it never reached or
   *  skipped. */
  found: string[][];
  /** One text ran past the hard ceiling — a match that did not return — and
   *  the worker was terminated there. */
  terminated: { index: number; ms: number } | null;
  /** Soft overruns: on text `index` the skill passed the per-text budget,
   *  so the rest of that document was skipped for this skill (one entry
   *  per document). */
  skipped: Array<{ index: number; ms: number }>;
  /** The skill's budget ran out while it was running. */
  budgetSpent: boolean;
  /** The worker could not run the skill at all (start-up failure, crash). */
  error: string | null;
}

export interface SkillMatcher {
  match(sources: readonly string[], limits: SkillMatchLimits): Promise<SkillMatchOutcome>;
  close(): Promise<void>;
}

/** Opens a matcher over one run's texts; `keys[i]` is the document text i
 *  belongs to (a soft overrun skips the rest of that document). */
export type SkillMatcherFactory = (texts: readonly string[], keys: readonly string[]) => SkillMatcher;

// The worker's whole program. Plain CommonJS, evaluated from this string, so
// the bundler never has to place a separate worker file.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
let texts = [];
let keys = [];
parentPort.on("message", (msg) => {
  if (msg.t === "load") { texts = msg.texts; keys = msg.keys; parentPort.postMessage({ t: "ready" }); return; }
  const res = msg.sources.map((src) => new RegExp(src, "gi"));
  const skipped = new Set();
  for (let i = 0; i < texts.length; i++) {
    if (skipped.has(keys[i])) continue;
    const t0 = performance.now();
    const found = [];
    let over = false;
    for (const re of res) {
      re.lastIndex = 0;
      let m;
      let n = 0;
      while (n < msg.maxMatches && (m = re.exec(texts[i])) !== null) {
        n++;
        if (m.index === re.lastIndex) re.lastIndex++;
        found.push(m[0]);
        if (performance.now() - t0 > msg.softDocMs) { over = true; break; }
      }
      if (over || performance.now() - t0 > msg.softDocMs) { over = true; break; }
    }
    if (over) { skipped.add(keys[i]); parentPort.postMessage({ t: "over", i, ms: performance.now() - t0 }); continue; }
    parentPort.postMessage({ t: "doc", i, found });
  }
  parentPort.postMessage({ t: "done" });
});
`;

type WorkerMessage =
  | { t: "ready" }
  | { t: "doc"; i: number; found: string[] }
  | { t: "over"; i: number; ms: number }
  | { t: "done" };

/** The engine's matcher: one worker per run, replaced after a termination. */
export function workerSkillMatcher(opts?: { hardDocMs?: number }): SkillMatcherFactory {
  const hardDocMs = opts?.hardDocMs ?? SKILL_DOC_HARD_MS;
  return (texts, keys) => {
    let worker: Worker | null = null;
    let ready: Promise<string | null> | null = null;

    const kill = () => {
      const w = worker;
      worker = null;
      ready = null;
      if (w) void w.terminate().catch(() => { /* already gone */ });
    };

    /** A loaded worker, or the reason there is none. */
    const start = (deadline: number): Promise<string | null> => {
      if (worker && ready) return ready;
      let w: Worker;
      try {
        w = new Worker(WORKER_SOURCE, { eval: true });
      } catch (e) {
        return Promise.resolve(`the custom-skill worker could not start (${(e as Error).message})`);
      }
      worker = w;
      ready = new Promise<string | null>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        function done(reason: string | null) {
          if (timer) clearTimeout(timer);
          w.off("message", onMessage);
          w.off("error", onError);
          w.off("exit", onExit);
          if (reason) kill();
          resolve(reason);
        }
        function onMessage(m: WorkerMessage) { if (m.t === "ready") done(null); }
        function onError(e: Error) { done(`the custom-skill worker failed (${e.message})`); }
        function onExit() { done("the custom-skill worker stopped before it started"); }
        w.on("message", onMessage);
        w.on("error", onError);
        w.on("exit", onExit);
        timer = setTimeout(() => done(`the custom-skill worker did not start within ${WORKER_START_MS / 1000} s`),
          Math.max(0, Math.min(WORKER_START_MS, deadline - Date.now())));
        w.postMessage({ t: "load", texts: [...texts], keys: [...keys] });
      });
      return ready;
    };

    return {
      async match(sources, limits) {
        const deadline = Date.now() + Math.max(0, limits.budgetMs);
        const found: string[][] = [];
        const skipped: SkillMatchOutcome["skipped"] = [];
        const empty = (over: Partial<SkillMatchOutcome>): SkillMatchOutcome =>
          ({ found, terminated: null, skipped, budgetSpent: false, error: null, ...over });
        if (Date.now() >= deadline) return empty({ budgetSpent: true });
        const startError = await start(deadline);
        if (startError) return empty({ error: startError });
        if (Date.now() >= deadline) return empty({ budgetSpent: true });
        const w = worker as Worker;

        return new Promise<SkillMatchOutcome>((resolve) => {
          let last = -1;
          let beat = Date.now();
          const skippedKeys = new Set<string>();
          let timer: ReturnType<typeof setTimeout> | null = null;
          let settled = false;
          function finish(out: Partial<SkillMatchOutcome>, terminate: boolean) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            w.off("message", onMessage);
            w.off("error", onError);
            w.off("exit", onExit);
            if (terminate) kill();
            resolve(empty(out));
          }
          // The watchdog: re-armed on every text the worker finishes or skips.
          // The text it is stuck on is the next one it has not reported
          // (texts of a skipped document are passed over).
          function arm() {
            if (timer) clearTimeout(timer);
            const wait = Math.max(0, Math.min(beat + hardDocMs, deadline) - Date.now());
            timer = setTimeout(() => {
              const t = Date.now();
              if (t >= deadline) { finish({ budgetSpent: true }, true); return; }
              let stuck = last + 1;
              while (stuck < keys.length && skippedKeys.has(keys[stuck])) stuck += 1;
              finish({ terminated: { index: stuck, ms: t - beat } }, true);
            }, wait);
          }
          function onMessage(m: WorkerMessage) {
            if (m.t === "doc" || m.t === "over") {
              if (m.t === "doc") found[m.i] = m.found;
              else { skipped.push({ index: m.i, ms: Math.round(m.ms) }); skippedKeys.add(keys[m.i]); }
              last = m.i;
              beat = Date.now();
              arm();
            } else if (m.t === "done") {
              finish({}, false);
            }
          }
          function onError(e: Error) { finish({ error: `the custom-skill worker failed (${e.message})` }, true); }
          function onExit() { finish({ error: "the custom-skill worker stopped unexpectedly" }, true); }
          w.on("message", onMessage);
          w.on("error", onError);
          w.on("exit", onExit);
          arm();
          w.postMessage({ t: "run", sources: [...sources], softDocMs: limits.softDocMs, maxMatches: limits.maxMatches });
        });
      },
      async close() {
        const w = worker;
        worker = null;
        ready = null;
        if (w) await w.terminate().catch(() => 0);
      },
    };
  };
}
