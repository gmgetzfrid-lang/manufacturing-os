// The library page's resumable indexing loop (lib/knowledge.ts ingestLoop),
// against the ingest route's contract since the ingest claim (ING-2, DEC-58):
// a `busy` answer is waiting, not a stall; a vision retry that re-reads
// failed pages is progress even though pagesIndexed does not move; three
// rounds with no progress of any kind are still a stall, said as one.
//
// intelligence Round G, I-02b (2026-10-01): a retry batch whose tries all
// failed (visionRetryAttempts > 0) is activity too — it rotated the queue —
// so a round of failing pages ends on the route's 409 and its reason, never
// on a false "stalled"; a person's Resume says so on every POST of its run
// (`retryNow`, ING-8) and no automatic loop ever does; the accept-partial
// and table-aware re-index calls speak the route's contract (ING-6, ING-4).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn() }));

import {
  ingestKnowledgeDocument, INGEST_BUSY_ROUNDS_MAX, acceptPartialIndex, planTableAwareReindex, runTableAwareReindex,
  tableAwareReindexMessage,
} from "@/lib/knowledge";

type Answer = Record<string, unknown>;
let answers: Answer[] = [];
let calls = 0;
/** Every POST body the loop sent, in order. */
let bodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  answers = []; calls = 0; bodies = [];
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const a = answers[Math.min(calls, answers.length - 1)];
    calls++;
    const status = typeof a.__status === "number" ? a.__status : 200;
    const { __status: _s, ...json } = a;
    return { ok: status >= 200 && status < 300, status, json: async () => json } as unknown as Response;
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Run the loop to completion while fake timers fire its waits. */
async function run(id: string, opts?: { retryNow?: boolean }): Promise<unknown> {
  let outcome: unknown = "pending";
  const p = ingestKnowledgeDocument(id, undefined, opts).then(() => { outcome = "done"; }, (e: Error) => { outcome = e; });
  for (let i = 0; i < 200 && outcome === "pending"; i++) await vi.advanceTimersByTimeAsync(31_000);
  await p;
  return outcome;
}

const base = { done: false, pageCount: 40, pagesIndexed: 20 };

describe("ingestLoop — busy, retry progress and a real stall", () => {
  it("busy answers (another driver holds the claim) are waited through, then indexing carries on and finishes", async () => {
    answers = [
      { ...base, pagesIndexed: 10 },
      { ...base, pagesIndexed: 10, busy: true, retryAfterMs: 60_000 },
      { ...base, pagesIndexed: 10, busy: true, retryAfterMs: 30_000 },
      { ...base, pagesIndexed: 10, busy: true, retryAfterMs: 5_000 },
      { ...base, pagesIndexed: 10, busy: true, retryAfterMs: 5_000 },
      { ...base, pagesIndexed: 30 },
      { ...base, pagesIndexed: 40, done: true },
    ];
    expect(await run("doc-busy")).toBe("done");
    expect(calls).toBe(7);
  });

  it("a vision retry that re-reads failed pages (pagesIndexed unchanged) is progress — never a false 'stalled'", async () => {
    answers = [
      { ...base, pagesIndexed: 40, visionFailedPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], pagesReadable: 24 },
      { ...base, pagesIndexed: 40, visionFailedPages: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], pagesReadable: 28 },
      { ...base, pagesIndexed: 40, visionFailedPages: [9, 10, 11, 12, 13, 14, 15, 16], pagesReadable: 32 },
      { ...base, pagesIndexed: 40, visionFailedPages: [13, 14, 15, 16], pagesReadable: 36 },
      { ...base, pagesIndexed: 40, visionFailedPages: [], pagesReadable: 40, done: true },
    ];
    expect(await run("doc-retry")).toBe("done");
  });

  it("three rounds with no progress of any kind are still a stall, said as one", async () => {
    answers = [{ ...base, pagesIndexed: 12, visionFailedPages: [3], pagesReadable: 11 }];
    const out = await run("doc-stall");
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toMatch(/^Indexing stalled at page 12 of 40/);
  });

  it("a claim that never frees ends the loop with the true reason, not the vision advice", async () => {
    answers = [{ ...base, busy: true, retryAfterMs: 30_000 }];
    const out = await run("doc-held");
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toMatch(/^Another session is indexing this document right now/);
    expect((out as Error).message).not.toMatch(/AI vision/);
    expect(calls).toBe(INGEST_BUSY_ROUNDS_MAX + 1);
  });
});

describe("ING-6 handoff (I-02b) — a retry batch whose tries all failed is activity, not a stall", () => {
  it("twenty failed pages that fail every time: the loop walks the whole round and stops on the 409's reason — never 'stalled'", async () => {
    // The engine tries four untried pages a batch and rotates them to the
    // back; only the batch that completes the round backs off (409). After
    // the loop's first answer, three batches in a row move neither
    // pagesIndexed nor visionFailedPages — before this, the third threw
    // "Indexing stalled … then rebuild" (a rebuild re-bills every vision page).
    const failing = Array.from({ length: 20 }, (_, i) => i + 1);
    const round = { ...base, pagesIndexed: 40, pageCount: 40, visionFailedPages: failing, pagesReadable: 20, visionRetryAttempts: 4 };
    const reason = "AI vision could not read 20 pages (p. 1, 2, 3, …): provider 529 overloaded. They are tried again automatically on the next indexing pass…";
    answers = [
      round, round, round, round,
      { __status: 409, ...round, visionRetryBlocked: true, visionRetryMessage: reason, error: reason },
    ];
    const out = await run("doc-rotating");
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toBe(reason);
    expect((out as Error).message).not.toMatch(/stalled|rebuild/);
    expect(calls).toBe(5);
  });

  it("a batch that tried nothing and moved nothing still counts toward the stall", async () => {
    answers = [{ ...base, pagesIndexed: 40, pageCount: 40, visionFailedPages: [3], pagesReadable: 39, visionRetryAttempts: 0 }];
    const out = await run("doc-idle");
    expect((out as Error).message).toMatch(/^Indexing stalled at page 40 of 40/);
  });
});

describe("ING-8 handoff (I-02b) — Resume is a person's re-run; the automatic loop never says so", () => {
  it("Resume (retryNow) sends retryNow: true on every POST of its run — a busy answer first does not drop it", async () => {
    answers = [
      { ...base, pagesIndexed: 10, busy: true, retryAfterMs: 5_000 },
      { ...base, pagesIndexed: 30 },
      { ...base, pagesIndexed: 40, done: true },
    ];
    expect(await run("doc-resume", { retryNow: true })).toBe("done");
    expect(bodies).toEqual([
      { documentId: "doc-resume", retryNow: true },
      { documentId: "doc-resume", retryNow: true },
      { documentId: "doc-resume", retryNow: true },
    ]);
  });

  it("the automatic loop (no option) never sends retryNow", async () => {
    answers = [{ ...base, pagesIndexed: 30 }, { ...base, pagesIndexed: 40, done: true }];
    expect(await run("doc-auto")).toBe("done");
    expect(bodies.every((b) => !("retryNow" in b))).toBe(true);
    expect(bodies).toEqual([{ documentId: "doc-auto" }, { documentId: "doc-auto" }]);
  });

  it("inside a back-off the automatic loop stops on the route's reason; Resume's re-run is what runs it", async () => {
    const reason = "Indexing failed: connection reset — attempt 1 of 3. Indexing is tried again automatically on the next indexing pass…";
    answers = [{ __status: 409, ...base, failureRetryBlocked: true, failureRetryMessage: reason, error: reason }];
    const out = await run("doc-held-back");
    expect((out as Error).message).toBe(reason);
    expect(bodies).toEqual([{ documentId: "doc-held-back" }]);
  });
});

describe("the accept-partial and table-aware re-index calls (ING-6, ING-4)", () => {
  it("acceptPartialIndex posts the route's accept-partial action and returns the pages accepted unread", async () => {
    answers = [{ ok: true, done: true, acceptedPages: [3, 7] }];
    expect(await acceptPartialIndex("doc-1")).toEqual({ acceptedPages: [3, 7] });
    expect(bodies).toEqual([{ documentId: "doc-1", action: "accept-partial" }]);
  });

  it("acceptPartialIndex surfaces the route's refusal, never a silent success", async () => {
    answers = [{ __status: 409, error: "This document is being indexed right now — try again in a moment." }];
    await expect(acceptPartialIndex("doc-1")).rejects.toThrow(/being indexed right now/);
  });

  it("the dry run changes nothing and asks only for the plan", async () => {
    answers = [{ ok: true, dryRun: true, chunker: 2, documents: 12, toReset: 9, visionPagesToReread: 140 }];
    expect(await planTableAwareReindex("lib-1")).toEqual({ documents: 12, toReset: 9, visionPagesToReread: 140 });
    expect(bodies).toEqual([{ action: "reindex", libraryId: "lib-1", chunker: 2, dryRun: true }]);
  });

  it("the run repeats while documents remain and the last run reset something — and stops when a run resets nothing", async () => {
    answers = [
      { ok: true, chunker: 2, reset: 5, busy: 0, errors: [], toReset: 9, visionPagesToReread: 140, remaining: 4 },
      { ok: true, chunker: 2, reset: 3, busy: 1, errors: [], toReset: 4, visionPagesToReread: 60, remaining: 1 },
      { ok: true, chunker: 2, reset: 0, busy: 1, errors: [], toReset: 1, visionPagesToReread: 20, remaining: 1 },
    ];
    expect(await runTableAwareReindex("lib-1")).toEqual({ reset: 8, busy: 1, errors: [], remaining: 1 });
    expect(bodies).toEqual(Array.from({ length: 3 }, () => ({ action: "reindex", libraryId: "lib-1", chunker: 2 })));
  });

  it("a run whose documents are all reset ends at once", async () => {
    answers = [{ ok: true, chunker: 2, reset: 9, busy: 0, errors: [], toReset: 9, visionPagesToReread: 140, remaining: 0 }];
    expect(await runTableAwareReindex("lib-1")).toEqual({ reset: 9, busy: 0, errors: [], remaining: 0 });
    expect(calls).toBe(1);
  });

  it("a migration the run needs (424) is said, not swallowed", async () => {
    answers = [{ __status: 424, error: "Choosing a chunker needs migration 20261122_intel_roundG_ingest_integrity.sql — apply it first." }];
    await expect(planTableAwareReindex("lib-1")).rejects.toThrow(/needs migration 20261122/);
  });

  it("the confirmation says what the dry run counts AND what it leaves out: the library drops out of Ask until each document is re-indexed", () => {
    const msg = tableAwareReindexMessage({ documents: 12, toReset: 9, visionPagesToReread: 140 });
    expect(msg).toContain("9 of 12 documents");
    expect(msg).toContain("AI vision reads 140 pages again");
    expect(msg).toMatch(/drops out of Ask/);
    expect(msg).toMatch(/until it is re-indexed/);
    expect(msg).toMatch(/nightly maintenance run/);
    expect(msg).toMatch(/can take days/);
    expect(tableAwareReindexMessage({ documents: 1, toReset: 1, visionPagesToReread: 0 })).toContain("No page needs AI vision again");
  });
});
