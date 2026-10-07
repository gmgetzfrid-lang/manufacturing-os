// projects Round G — PERF-6: the page-reading routes answer before their own
// function limit. The arithmetic (deadline, what is left, the model's
// budget) and the race are pinned here; the routes' use of them is pinned in
// apiRouteAuth.test.ts, and a census below keeps every page-reading route
// that this package owns on the deadline.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  routeDeadline, remainingMs, beforeDeadline, aiBudgetMs, tooLargeToReadMessage,
  DEADLINE_PASSED, DEADLINE_RESERVE_MS, MIN_AI_BUDGET_MS,
} from "@/lib/routeDeadline";

afterEach(() => { vi.useRealTimers(); });

describe("routeDeadline / remainingMs / aiBudgetMs", () => {
  it("the deadline is maxDuration less the reserve: 120 s → 105 s", () => {
    expect(DEADLINE_RESERVE_MS).toBe(15_000);
    expect(routeDeadline(120, 1_000)).toBe(1_000 + 105_000);
  });
  it("remaining time never goes negative", () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
    expect(remainingMs(10_000, 12_000)).toBe(0);
  });
  it("the model gets what is left, capped — and nothing when too little is left to be worth the key", () => {
    const deadline = routeDeadline(120, 0);                     // 105 000
    expect(aiBudgetMs(deadline, 90_000, 0)).toBe(90_000);        // capped
    expect(aiBudgetMs(deadline, 90_000, 40_000)).toBe(65_000);   // what is left
    expect(aiBudgetMs(deadline, 90_000, deadline - MIN_AI_BUDGET_MS)).toBe(MIN_AI_BUDGET_MS);
    expect(aiBudgetMs(deadline, 90_000, deadline - MIN_AI_BUDGET_MS + 1)).toBeNull();
    expect(aiBudgetMs(deadline, 90_000, deadline + 5_000)).toBeNull();
  });
  it("the timeout message names the page cap and says what to do", () => {
    expect(tooLargeToReadMessage(10)).toBe(
      "The document was too large to read in time — try fewer pages (this reader reads at most the first 10).");
    expect(tooLargeToReadMessage(10)).not.toMatch(/HTTP/);
  });
});

describe("beforeDeadline — the route stops waiting at the deadline", () => {
  it("returns the work's value when it settles first", async () => {
    await expect(beforeDeadline(Promise.resolve(7), Date.now() + 60_000)).resolves.toBe(7);
  });
  it("returns DEADLINE_PASSED when the work outlives the deadline, and clears its timer either way", async () => {
    vi.useFakeTimers();
    const p = beforeDeadline(new Promise<number>(() => undefined), Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe(DEADLINE_PASSED);
    expect(vi.getTimerCount()).toBe(0);
    await beforeDeadline(Promise.resolve(1), Date.now() + 5_000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a deadline already past answers at once, and a later rejection of the abandoned work is swallowed", async () => {
    let reject!: (e: Error) => void;
    const work = new Promise<number>((_, r) => { reject = r; });
    await expect(beforeDeadline(work, Date.now() - 1)).resolves.toBe(DEADLINE_PASSED);
    reject(new Error("late"));
    await new Promise((r) => setTimeout(r, 0)); // an unhandled rejection would fail the run
  });
  it("the work's own rejection propagates while there is time", async () => {
    await expect(beforeDeadline(Promise.reject(new Error("render broke")), Date.now() + 60_000)).rejects.toThrow("render broke");
  });
});

describe("census — the page-reading routes this package owns are on the deadline", () => {
  // PERF-6 (projects Round G J12): the cost-document read joined the census.
  for (const file of ["app/api/projects/checklist/route.ts", "app/api/companies/quality-manual/route.ts", "app/api/projects/cost-docs/route.ts"]) {
    it(file, () => {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src).toMatch(/const deadline = routeDeadline\(maxDuration\);/);
      expect(src).toMatch(/beforeDeadline\(\s*renderKnowledgePages\(/);
      expect(src).toMatch(/if \(isTimeoutError\(e\)\) return bad\(/);
      // No fixed model budget left behind: every governed call takes the
      // budget computed from the deadline.
      expect(src).not.toMatch(/timeoutMs: 90_000/);
      expect(src).toMatch(/timeoutMs: budget/);
    });
  }
});
