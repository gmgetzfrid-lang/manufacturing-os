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
// "Running for" is the WORKER's own account, never this thread's: the
// worker writes the text it is on and when it started it into shared memory
// (on the process's monotonic clock), and its results arrive on a dedicated
// port this thread drains synchronously before deciding anything. So a
// stall of THIS thread's event loop (another request, a large JSON parse, a
// GC pause) — during which Node runs the expired watchdog before it
// delivers the queued results — never reads as a match that did not return
// (LNK-6 fix pass 3). A watchdog that itself fires a full ceiling late is a
// host stall: the worker gets one more ceiling before it is judged.
// A terminated worker is replaced on the next skill (the texts are sent
// again); a skill that only skipped documents keeps the worker.
// Start-up has its own allowance (fix pass 4): loading the texts into a
// cold worker may take up to WORKER_START_MS, bounded by what is left of
// the RUN's budget — never by one skill's share of it, which may be a few
// hundred ms. A skill whose time ran out while the worker was still loading
// read nothing (its budget is spent, `startPending`); the worker keeps
// loading for the next skill. Only a worker that has not started within
// WORKER_START_MS is given up on, and that is said with that limit.
//
// Server-only (node:worker_threads). The engine (lib/linkProposerServer.ts)
// is also reachable from browser bundles through the publish pipeline, so it
// never imports this module: the /api/links/propose route hands it in.

import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";

/** LNK-6: the longest one text may run under one skill before the worker is
 *  terminated — the ceiling on a single match that never returns. */
export const SKILL_DOC_HARD_MS = 1_000;
/** A worker that has not loaded the texts within this long is given up on. */
export const WORKER_START_MS = 10_000;

export interface SkillMatchLimits {
  /** Per-text budget, read between matches inside the worker. */
  softDocMs: number;
  /** What this skill may spend once the worker is ready (its share of the
   *  run's budget). */
  budgetMs: number;
  /** What is left of the RUN's budget, from now: it bounds the wait for a
   *  starting worker and this skill's own deadline. Defaults to budgetMs. */
  runLeftMs?: number;
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
  /** Its time ran out while the worker was still loading the texts: nothing
   *  was read for this skill (budgetSpent is set too). */
  startPending?: boolean;
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
// the bundler never has to place a separate worker file. `progress` is
// shared memory: [0] the text the worker is on (-1 between runs), [1] when
// it started that text, in process.hrtime nanoseconds (monotonic, the same
// clock in every thread of the process). Results go out on `out`, the port
// the parent drains synchronously.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
let texts = [];
let keys = [];
let out = null;
let progress = null;
parentPort.on("message", (msg) => {
  if (msg.t === "load") {
    texts = msg.texts; keys = msg.keys; out = msg.port; progress = new BigInt64Array(msg.progress);
    parentPort.postMessage({ t: "ready" });
    return;
  }
  const res = msg.sources.map((src) => new RegExp(src, "gi"));
  const skipped = new Set();
  for (let i = 0; i < texts.length; i++) {
    if (skipped.has(keys[i])) continue;
    Atomics.store(progress, 1, process.hrtime.bigint());
    Atomics.store(progress, 0, BigInt(i));
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
    if (over) { skipped.add(keys[i]); out.postMessage({ t: "over", i, ms: performance.now() - t0 }); continue; }
    out.postMessage({ t: "doc", i, found });
  }
  Atomics.store(progress, 0, -1n);
  out.postMessage({ t: "done" });
});
`;

/** Nanoseconds on the clock the worker stamps `progress` with. */
const hrNow = () => process.hrtime.bigint();

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
    /** The worker's results port (drained synchronously) and its progress. */
    let port: MessagePort | null = null;
    let progress: BigInt64Array | null = null;

    const kill = () => {
      const w = worker;
      worker = null;
      ready = null;
      port?.close();
      port = null;
      progress = null;
      if (w) void w.terminate().catch(() => { /* already gone */ });
    };

    /** A loaded worker, or the reason there is none. The wait is the
     *  worker's own allowance (WORKER_START_MS), shared by every skill that
     *  asks while it loads. */
    const start = (): Promise<string | null> => {
      if (worker && ready) return ready;
      let w: Worker;
      try {
        w = new Worker(WORKER_SOURCE, { eval: true });
      } catch (e) {
        return Promise.resolve(`the custom-skill worker could not start (${(e as Error).message})`);
      }
      worker = w;
      const channel = new MessageChannel();
      // The worker keeps the process alive while it runs; its port does not.
      channel.port1.unref();
      port = channel.port1;
      const shared = new SharedArrayBuffer(2 * BigInt64Array.BYTES_PER_ELEMENT);
      progress = new BigInt64Array(shared);
      Atomics.store(progress, 0, BigInt(-1));
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
        timer = setTimeout(() => done(`the custom-skill worker did not start within ${WORKER_START_MS / 1000} s`), WORKER_START_MS);
        w.postMessage({ t: "load", texts: [...texts], keys: [...keys], port: channel.port2, progress: shared }, [channel.port2]);
      });
      return ready;
    };

    return {
      async match(sources, limits) {
        const runDeadline = Date.now() + Math.max(0, limits.runLeftMs ?? limits.budgetMs);
        const found: string[][] = [];
        const skipped: SkillMatchOutcome["skipped"] = [];
        const empty = (over: Partial<SkillMatchOutcome>): SkillMatchOutcome =>
          ({ found, terminated: null, skipped, budgetSpent: false, error: null, ...over });
        if (Date.now() >= runDeadline || limits.budgetMs <= 0) return empty({ budgetSpent: true });
        // Wait for the worker no longer than the run has left; a worker still
        // loading then is this skill's spent budget, not the run's end.
        const STILL_LOADING = Symbol("loading");
        let waitTimer: ReturnType<typeof setTimeout> | null = null;
        const startError = await Promise.race([
          start(),
          new Promise<typeof STILL_LOADING>((resolve) => {
            waitTimer = setTimeout(() => resolve(STILL_LOADING), Math.max(0, runDeadline - Date.now()));
          }),
        ]);
        if (waitTimer) clearTimeout(waitTimer);
        if (startError === STILL_LOADING) return empty({ budgetSpent: true, startPending: true });
        if (startError) return empty({ error: startError });
        // The skill's share runs from when the worker is ready, within the run's.
        const deadline = Math.min(Date.now() + Math.max(0, limits.budgetMs), runDeadline);
        if (Date.now() >= deadline) return empty({ budgetSpent: true });
        const w = worker as Worker;
        const results = port as MessagePort;
        const at = progress as BigInt64Array;

        return new Promise<SkillMatchOutcome>((resolve) => {
          /** The last text the worker reported (finished or skipped). */
          let last = -1;
          let timer: ReturnType<typeof setTimeout> | null = null;
          /** When the armed watchdog should fire (this thread's clock). */
          let dueAt = 0;
          let settled = false;
          function finish(out: Partial<SkillMatchOutcome>, terminate: boolean) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            results.off("message", onMessage);
            w.off("error", onError);
            w.off("exit", onExit);
            if (terminate) kill();
            resolve(empty(out));
          }
          function arm(waitMs: number) {
            if (timer) clearTimeout(timer);
            const wait = Math.max(0, Math.min(waitMs, deadline - Date.now()));
            dueAt = performance.now() + wait;
            timer = setTimeout(check, wait);
          }
          // The watchdog. It decides on the worker's own state: first every
          // result the worker already sent (queued behind this timer when
          // this thread was busy), then the text the worker says it is on
          // and when it started it.
          function check() {
            timer = null;
            const late = performance.now() - dueAt;
            for (let r = receiveMessageOnPort(results); r && !settled; r = receiveMessageOnPort(results)) {
              onMessage(r.message as WorkerMessage);
            }
            if (settled) return;
            if (Date.now() >= deadline) { finish({ budgetSpent: true }, true); return; }
            const on = Number(Atomics.load(at, 0));
            // Between texts, or not started yet: nothing is running long.
            if (on <= last) { arm(hardDocMs); return; }
            const ranMs = Number(hrNow() - Atomics.load(at, 1)) / 1e6;
            // This thread was stalled for a full ceiling: the host may have
            // held the worker too — it gets one more ceiling from now.
            if (late >= hardDocMs) { arm(hardDocMs); return; }
            if (ranMs >= hardDocMs) { finish({ terminated: { index: on, ms: Math.round(ranMs) } }, true); return; }
            arm(hardDocMs - ranMs);
          }
          function onMessage(m: WorkerMessage) {
            if (m.t === "doc" || m.t === "over") {
              if (m.t === "doc") found[m.i] = m.found;
              else skipped.push({ index: m.i, ms: Math.round(m.ms) });
              last = m.i;
            } else if (m.t === "done") {
              finish({}, false);
            }
          }
          function onError(e: Error) { finish({ error: `the custom-skill worker failed (${e.message})` }, true); }
          function onExit() { finish({ error: "the custom-skill worker stopped unexpectedly" }, true); }
          results.on("message", onMessage);
          w.on("error", onError);
          w.on("exit", onExit);
          Atomics.store(at, 0, BigInt(-1));
          arm(hardDocMs);
          w.postMessage({ t: "run", sources: [...sources], softDocMs: limits.softDocMs, maxMatches: limits.maxMatches });
        });
      },
      async close() {
        const w = worker;
        worker = null;
        ready = null;
        port?.close();
        port = null;
        progress = null;
        if (w) await w.terminate().catch(() => 0);
      },
    };
  };
}
