// lib/routeDeadline.ts — PERF-6: a route that renders pages and then calls a
// model must answer before its own function limit.
//
// A platform timeout is not an answer: it arrives as a non-JSON 504, the
// client prints "HTTP 504" after two minutes of spinner, and the model call
// the caller's own key paid for is lost. So a page-reading route keeps a
// deadline of `maxDuration` minus a reserve (for the gates in front of the
// model, the usage write after it and the response itself), gives up on the
// render when the deadline passes, budgets the model from what is left
// rather than a fixed 90 s, and — when too little is left to be worth the
// caller's key — refuses before spending it. Every one of those exits is a
// readable JSON 504 that names the page cap.

/** Held back from `maxDuration` for everything around the render and the
 *  model: the governed-call gates, the usage write, the response. */
export const DEADLINE_RESERVE_MS = 15_000;

/** Below this, a model call over page images will not finish — refuse
 *  rather than spend the caller's key on a call that cannot land. */
export const MIN_AI_BUDGET_MS = 10_000;

/** The instant (epoch ms) by which the route must have its answer. */
export function routeDeadline(maxDurationSeconds: number, now: number = Date.now()): number {
  return now + maxDurationSeconds * 1000 - DEADLINE_RESERVE_MS;
}

export function remainingMs(deadline: number, now: number = Date.now()): number {
  return Math.max(0, deadline - now);
}

export const DEADLINE_PASSED: unique symbol = Symbol("deadline passed");

/** Wait for `work` until the deadline; DEADLINE_PASSED if it has not
 *  settled by then. The work is not cancelled (the renderer has no signal)
 *  — the route simply stops waiting for it and answers. */
export async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T | typeof DEADLINE_PASSED> {
  const ms = remainingMs(deadline);
  if (ms <= 0) {
    work.catch(() => undefined);
    return DEADLINE_PASSED;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof DEADLINE_PASSED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_PASSED), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The model's time budget: what is left before the deadline, capped at
 *  `capMs`; `null` when less than MIN_AI_BUDGET_MS is left. */
export function aiBudgetMs(deadline: number, capMs: number, now: number = Date.now()): number | null {
  const left = remainingMs(deadline, now);
  if (left < MIN_AI_BUDGET_MS) return null;
  return Math.min(capMs, left);
}

/** The readable answer when a page read runs out of time — it names the
 *  cap so the user knows what "fewer pages" means. */
export function tooLargeToReadMessage(pageCap: number): string {
  return `The document was too large to read in time — try fewer pages (this reader reads at most the first ${pageCap}).`;
}
