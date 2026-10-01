// The library page's resumable indexing loop (lib/knowledge.ts ingestLoop),
// against the ingest route's contract since the ingest claim (ING-2, DEC-58):
// a `busy` answer is waiting, not a stall; a vision retry that re-reads
// failed pages is progress even though pagesIndexed does not move; three
// rounds with no progress of any kind are still a stall, said as one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) } },
}));
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn() }));

import { ingestKnowledgeDocument, INGEST_BUSY_ROUNDS_MAX } from "@/lib/knowledge";

type Answer = Record<string, unknown>;
let answers: Answer[] = [];
let calls = 0;

beforeEach(() => {
  answers = []; calls = 0;
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => {
    const a = answers[Math.min(calls, answers.length - 1)];
    calls++;
    return { ok: true, status: 200, json: async () => a } as unknown as Response;
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Run the loop to completion while fake timers fire its waits. */
async function run(id: string): Promise<unknown> {
  let outcome: unknown = "pending";
  const p = ingestKnowledgeDocument(id).then(() => { outcome = "done"; }, (e: Error) => { outcome = e; });
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
