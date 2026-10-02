// The library page's resumable indexing loop (lib/knowledge.ts ingestLoop),
// against the ingest route's contract since the ingest claim (ING-2, DEC-58):
// a `busy` answer is waiting, not a stall; a vision retry that re-reads
// failed pages is progress even though pagesIndexed does not move; three
// rounds with no progress of any kind are still a stall, said as one.
//
// intelligence Round G, I-02b (2026-10-01): a retry batch whose tries all
// failed (visionRetryAttempts > 0) is activity too — it rotated the queue —
// so a round of failing pages ends on the route's 409 and its reason, never
// on a false "stalled"; a person's Resume says so (`retryNow`, ING-8) until
// its run's first answer that is not `busy` — never again after a transient,
// which may already have let the re-run through — and no automatic loop ever
// does; a Resume on a document another loop in the tab owns is said, not
// dropped; the accept-partial and table-aware re-index calls speak the
// route's contract (ING-6, ING-4), and a re-index that fails part-way keeps
// what it already reset.
//
// Review fix pass 2 (2026-10-01): a document the re-index reset whose old
// passages could not all be deleted is a leftover, never "could not be
// reset", and an earlier call's failure that a later call reset is dropped;
// the confirmation says AI vision re-reads a page only on a usable key —
// the clicking person's first — and what becomes of it otherwise; the
// person's own key is checked by the ingest route's own test.
//
// Integration (2026-10-01): the confirmation quotes the route's figure as a
// count, neither a floor nor a ceiling, and says why each way (an older
// document's count can include earlier indexings; a page that needs AI
// vision but is not counted is read, and billed, too) — never the flat "No
// page needs AI vision again"; the nightly run's conditions include the
// signed AI agreement; and in a read-every-page library an unsponsored
// document is said to be indexed text-only by a keyless controller's open
// app, not to stay out of Ask.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** The rows `knowledge_documents` answers with (listKnowledgeDocuments). */
const docRows = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/supabase", () => {
  const chain = {
    select: () => chain, eq: () => chain,
    order: async () => ({ data: docRows.rows, error: null }),
  };
  return {
    supabase: {
      auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
      from: () => chain,
    },
  };
});
vi.mock("@/lib/storage", () => ({ uploadToPath: vi.fn() }));

import {
  ingestKnowledgeDocument, INGEST_BUSY_ROUNDS_MAX, acceptPartialIndex, planTableAwareReindex, runTableAwareReindex,
  tableAwareReindexMessage, listKnowledgeDocuments, ownVisionKeyProblem, tableAwareReindexKeyRefusal,
} from "@/lib/knowledge";

type Answer = Record<string, unknown>;
let answers: Answer[] = [];
let calls = 0;
/** Every POST body the loop sent, in order. */
let bodies: Array<Record<string, unknown>> = [];
/** Every URL fetched, in order. */
let urls: string[] = [];

beforeEach(() => {
  answers = []; calls = 0; bodies = []; urls = [];
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    urls.push(url);
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const a = answers[Math.min(calls, answers.length - 1)];
    calls++;
    const status = typeof a.__status === "number" ? a.__status : 200;
    const { __status: _s, __html: html, ...json } = a;
    // `__html`: the platform's own error page (a gateway timeout, a killed
    // invocation) — not JSON, so apiPost flags it transient.
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => { if (html) throw new SyntaxError("Unexpected token <"); return json; },
    } as unknown as Response;
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Run the loop to completion while fake timers fire its waits. */
async function run(id: string, opts?: { retryNow?: boolean }): Promise<unknown> {
  let outcome: unknown = "pending";
  const p = ingestKnowledgeDocument(id, undefined, opts).then((r) => { outcome = r === "indexed" ? "done" : r; }, (e: Error) => { outcome = e; });
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
  it("Resume (retryNow) keeps retryNow through busy answers, and drops it after the first answer that is not busy", async () => {
    answers = [
      { ...base, pagesIndexed: 10, busy: true, retryAfterMs: 5_000 },
      { ...base, pagesIndexed: 10, busy: true, retryAfterMs: 5_000 },
      { ...base, pagesIndexed: 30 },
      { ...base, pagesIndexed: 35 },
      { ...base, pagesIndexed: 40, done: true },
    ];
    expect(await run("doc-resume", { retryNow: true })).toBe("done");
    expect(bodies).toEqual([
      { documentId: "doc-resume", retryNow: true },
      { documentId: "doc-resume", retryNow: true },
      { documentId: "doc-resume", retryNow: true }, // performed: the person's re-run is settled
      { documentId: "doc-resume" },
      { documentId: "doc-resume" },
    ]);
  });

  it("a transient failure settles it too: one click never re-runs a held-back batch more than once", async () => {
    // A batch heavy on AI vision that the platform keeps killing (an HTML
    // 504, writing nothing). The killed invocation may already have passed
    // the gate and recorded the re-run, so its re-POSTs go without the flag;
    // the old failure's back-off still holds, and the second POST meets its
    // 409 — before, each of five re-POSTs passed the gate again (audited,
    // re-billing up to four vision pages each).
    const reason = "Indexing failed: render timed out — attempt 2 of 3. Indexing is tried again automatically on the next indexing pass…";
    answers = [
      { __status: 504, __html: true },
      { __status: 409, ...base, failureRetryBlocked: true, failureRetryMessage: reason, error: reason },
    ];
    const out = await run("doc-killed", { retryNow: true });
    expect((out as Error).message).toBe(reason);
    expect(bodies).toEqual([{ documentId: "doc-killed", retryNow: true }, { documentId: "doc-killed" }]);
  });

  it("busy, then a transient: the flag rode the busy answers and is dropped after the transient", async () => {
    answers = [
      { ...base, pagesIndexed: 10, busy: true, retryAfterMs: 5_000 },
      { __status: 502, __html: true },
      { ...base, pagesIndexed: 40, done: true },
    ];
    expect(await run("doc-busy-killed", { retryNow: true })).toBe("done");
    expect(bodies.map((b) => b.retryNow === true)).toEqual([true, true, false]);
  });

  it("a Resume on a document another loop in this tab owns sends nothing and says so (never a silent success)", async () => {
    answers = [
      { ...base, pagesIndexed: 10, busy: true, retryAfterMs: 20_000 },
      { ...base, pagesIndexed: 40, done: true },
    ];
    // The page's automatic loop owns the document, waiting out a busy answer.
    let first: unknown = "pending";
    const p = ingestKnowledgeDocument("doc-owned").then((r) => { first = r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies).toEqual([{ documentId: "doc-owned" }]);
    // A controller clicks Resume meanwhile.
    expect(await ingestKnowledgeDocument("doc-owned", undefined, { retryNow: true })).toBe("already-active");
    expect(bodies.some((b) => b.retryNow === true)).toBe(false);
    for (let i = 0; i < 5 && first === "pending"; i++) await vi.advanceTimersByTimeAsync(21_000);
    await p;
    expect(first).toBe("indexed");
    expect(bodies.some((b) => b.retryNow === true)).toBe(false);
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
    expect(await runTableAwareReindex("lib-1")).toEqual({ reset: 8, busy: 1, errors: [], leftovers: [], remaining: 1, stopped: null });
    expect(bodies).toEqual(Array.from({ length: 3 }, () => ({ action: "reindex", libraryId: "lib-1", chunker: 2 })));
  });

  it("a run whose documents are all reset ends at once", async () => {
    answers = [{ ok: true, chunker: 2, reset: 9, busy: 0, errors: [], toReset: 9, visionPagesToReread: 140, remaining: 0 }];
    expect(await runTableAwareReindex("lib-1")).toEqual({ reset: 9, busy: 0, errors: [], leftovers: [], remaining: 0, stopped: null });
    expect(calls).toBe(1);
  });

  it("a document that fails in every round is named once — by the last call, which tried it last", async () => {
    answers = [
      { __status: 207, ok: false, chunker: 2, reset: 5, busy: 0, errors: ["d-9: row: timeout"], remaining: 1 },
      { __status: 207, ok: false, chunker: 2, reset: 0, busy: 0, errors: ["d-9: row: permission denied"], remaining: 1 },
    ];
    expect(await runTableAwareReindex("lib-1")).toEqual({
      reset: 5, busy: 0, errors: ["d-9: row: permission denied"], leftovers: [], remaining: 1, stopped: null,
    });
    expect(calls).toBe(2);
  });

  it("a document reset whose old passages could not all be deleted is a leftover — counted in reset, never as 'could not be reset'", async () => {
    // resetKnowledgeIndex pushes such a document to BOTH `reset` and
    // `errors`: the row is queued (out of Ask), the deletes failed.
    const left = "d-9: chunks: timeout (the row is queued; the re-index's first batch clears what is left)";
    answers = [{ __status: 207, ok: false, chunker: 2, reset: 4, busy: 0, errors: [left], remaining: 0 }];
    expect(await runTableAwareReindex("lib-1")).toEqual({
      reset: 4, busy: 0, errors: [], leftovers: [left], remaining: 0, stopped: null,
    });
  });

  it("ING-13: a route that returns structured leftovers is read by id — never by the engine's wording — and a leftover's message is not filed again as an error", async () => {
    // A wording the old regex would not recognise: only the structured field
    // can tell this document was reset.
    const msg = "d-9: chunks: timeout (queued — cleared by its first batch)";
    answers = [{
      __status: 207, ok: false, chunker: 2, reset: 4, busy: 0, errors: [msg, "d-4: row: permission denied"],
      leftovers: [{ documentId: "d-9", left: ["chunks: timeout"], message: msg }], remaining: 1,
    }, {
      __status: 207, ok: false, chunker: 2, reset: 0, busy: 0, errors: ["d-4: row: permission denied"], leftovers: [], remaining: 1,
    }];
    expect(await runTableAwareReindex("lib-1")).toEqual({
      reset: 4, busy: 0, errors: ["d-4: row: permission denied"], leftovers: [msg], remaining: 1, stopped: null,
    });
    expect(calls).toBe(2);
  });

  it("ING-13: structured leftovers are kept from every call, one per document; a route without the field still files the engine's wording (an app that predates the field)", async () => {
    const first = "d-1: page entities: timeout (the row is queued; the re-index's first batch clears what is left)";
    const second = "d-2: mentions: timeout (queued)";
    answers = [
      { __status: 207, ok: false, chunker: 2, reset: 5, busy: 0, errors: [first], remaining: 2 },
      { __status: 207, ok: false, chunker: 2, reset: 2, busy: 0, errors: [second],
        leftovers: [{ documentId: "d-2", left: ["mentions: timeout"], message: second }], remaining: 0 },
    ];
    expect(await runTableAwareReindex("lib-1")).toEqual({
      reset: 7, busy: 0, errors: [], leftovers: [first, second], remaining: 0, stopped: null,
    });
  });

  it("an earlier call's failure that a later call reset is not reported — leftovers are kept from every call", async () => {
    const left = "d-1: page entities: timeout (the row is queued; the re-index's first batch clears what is left)";
    answers = [
      { __status: 207, ok: false, chunker: 2, reset: 5, busy: 0, errors: ["d-3: row: the claim was lost before the reset committed", left], remaining: 2 },
      { ok: true, chunker: 2, reset: 2, busy: 0, errors: [], remaining: 0 },
    ];
    expect(await runTableAwareReindex("lib-1")).toEqual({
      reset: 7, busy: 0, errors: [], leftovers: [left], remaining: 0, stopped: null,
    });
    expect(calls).toBe(2);
  });

  it("a later call that fails keeps what the calls before it reset — with the reason the run stopped", async () => {
    const why = "The re-index could not be recorded, so nothing was changed: insert failed";
    answers = [
      { ok: true, chunker: 2, reset: 8, busy: 0, errors: ["d-3: row: the claim was lost before the reset committed"], remaining: 2 },
      { __status: 500, error: why },
    ];
    expect(await runTableAwareReindex("lib-1")).toEqual({
      reset: 8, busy: 0, errors: ["d-3: row: the claim was lost before the reset committed"], leftovers: [], remaining: 2, stopped: why,
    });
  });

  it("the first call's refusal is thrown as is — nothing was reset", async () => {
    answers = [{ __status: 500, error: "The re-index could not be recorded, so nothing was changed: insert failed" }];
    await expect(runTableAwareReindex("lib-1")).rejects.toThrow(/could not be recorded/);
  });

  it("a row with no chunk_version key (a database without 20261122) reads `undefined`, never chunker 1; a null one stays null", async () => {
    const row = { id: "d", library_id: "lib-1", name: "a.pdf", status: "ready", pages_indexed: 4, page_count: 4 };
    docRows.rows = [
      { ...row, id: "legacy-db" },
      { ...row, id: "not-yet", chunk_version: null },
      { ...row, id: "v1", chunk_version: 1 },
    ];
    const list = await listKnowledgeDocuments("lib-1");
    expect(list.map((d) => [d.id, d.chunkVersion])).toEqual([["legacy-db", undefined], ["not-yet", null], ["v1", 1]]);
  });

  it("a migration the run needs (424) is said, not swallowed", async () => {
    answers = [{ __status: 424, error: "Choosing a chunker needs migration 20261122_intel_roundG_ingest_integrity.sql — apply it first." }];
    await expect(planTableAwareReindex("lib-1")).rejects.toThrow(/needs migration 20261122/);
  });

  it("the confirmation says what the dry run counts AND what it leaves out: the library drops out of Ask until each document is re-indexed", () => {
    const msg = tableAwareReindexMessage({ documents: 12, toReset: 9, visionPagesToReread: 140 });
    expect(msg).toContain("9 of 12 documents");
    expect(msg).toMatch(/drops out of Ask/);
    expect(msg).toMatch(/until it is re-indexed/);
    expect(msg).toMatch(/nightly maintenance run/);
    expect(msg).toMatch(/can take days/);
  });

  it("the confirmation never promises the AI-vision pages come back: only on a usable key — yours first — and what becomes of them otherwise", () => {
    const msg = tableAwareReindexMessage({ documents: 6, toReset: 4, visionPagesToReread: 52 });
    // The first-pass promise is gone.
    expect(msg).not.toContain("AI vision reads 52 pages again, billed to the AI key of whoever indexes them");
    expect(msg).toContain(
      "AI vision reads, and bills, a page only where whoever indexes it has an AI key with budget left: this page starts "
      + "on your key as soon as you confirm; after that, an Admin or Doc Control member with the app open indexes on their "
      + "own key, and the nightly maintenance run on the uploader's key — only if they have one with budget left and have "
      + "signed the AI agreement (a doc-control mirror has no uploader).",
    );
    expect(msg).toContain(
      "A page indexed with no such key comes back with only what its text layer holds — for a scan or a CAD sheet, "
      + "nothing — and AI vision does not read it again until the document is re-indexed on a key (Re-index all).",
    );
    // Not a read-every-page library: no claim about the nightly run skipping documents.
    expect(msg).not.toMatch(/never indexes a document/);
    expect(tableAwareReindexMessage({ documents: 2, toReset: 1, visionPagesToReread: 1 }))
      .toContain("The dry run counts 1 page of them as read by AI vision before.");
  });

  it("the nightly run's conditions include the signed AI agreement (loadSponsorVision's gate), stated as conditions it needs — never as enough", () => {
    for (const plan of [
      { documents: 6, toReset: 4, visionPagesToReread: 52 },
      { documents: 6, toReset: 4, visionPagesToReread: 0 },
    ]) {
      for (const visionAllPages of [false, true]) {
        const msg = tableAwareReindexMessage(plan, { visionAllPages });
        expect(msg, `${plan.visionPagesToReread} / ${visionAllPages}`).toContain(
          "the nightly maintenance run on the uploader's key — only if they have one with budget left and have signed the AI agreement",
        );
        expect(msg).not.toContain("the nightly maintenance run on the uploader's key (a doc-control mirror");
      }
    }
  });

  it("the route's figure is quoted as is, as a count — neither a floor nor a ceiling, and the confirmation says why each way", () => {
    const msg = tableAwareReindexMessage({ documents: 6, toReset: 4, visionPagesToReread: 3000 });
    expect(msg).toContain(
      "The dry run counts 3000 pages of them as read by AI vision before. That count is not exact either way: an older "
      + "document's count can include pages read in earlier indexings, and a page that needs AI vision but is not counted "
      + "— never read by it, found blank, or one it could not read — is read, and billed, too.",
    );
    // Never stated as the pages the run re-reads, nor as a floor.
    expect(msg).not.toMatch(/They are read again|It is read again|were read by AI vision\./);
    expect(msg).not.toContain("That count is only the pages AI vision read and kept");
  });

  it("no counted vision page: never the flat 'No page needs AI vision again' — a textless page may still be read, and billed", () => {
    const msg = tableAwareReindexMessage({ documents: 1, toReset: 1, visionPagesToReread: 0 });
    expect(msg).not.toContain("No page needs AI vision again");
    expect(msg).toContain(
      "No page of those documents is counted as read by AI vision. Even so, a page that needs AI vision — one with no "
      + "usable text layer, such as a scan or a CAD sheet, that was indexed before with no key, or that AI vision found "
      + "blank or could not read — may still be read, and billed, on the re-index, but only where whoever indexes it has "
      + "an AI key with budget left: this page starts as soon as you confirm, on your key if you have one with budget "
      + "left; after that, an Admin or Doc Control member with the app open indexes on their own key, and the nightly "
      + "maintenance run on the uploader's key — only if they have one with budget left and have signed the AI agreement "
      + "(a doc-control mirror has no uploader). With no such key it comes back with its text layer only.",
    );
    // With nothing counted (and not a read-every-page library) the page asks
    // for no key, so it never says the run starts "on your key" outright.
    expect(msg).not.toContain("this page starts on your key as soon as you confirm");
  });

  it("ING-13: where the database records what a reset owes AI vision (keylessHolds), the confirmation and the key refusal say a keyless driver holds those pages — never that they come back text-only for good", () => {
    const plan = { documents: 6, toReset: 4, visionPagesToReread: 52, keylessHolds: true };
    const msg = tableAwareReindexMessage(plan);
    expect(msg).toContain(
      "A page AI vision read before, and would read again, that is reached with no such key waits for one — listed as "
      + "waiting on AI vision, the document searchable but not marked ready until the page is read or an admin accepts the "
      + "partial index.",
    );
    // A document indexed before chunks said how their text was read owes
    // every page that needs AI vision (the reset's OWES_EVERY_VISION_PAGE),
    // and the confirmation says so.
    expect(msg).toContain("In a document indexed before the app recorded which pages AI vision read, every page that needs AI vision waits.");
    expect(msg).not.toMatch(/does not read it again until the document is re-indexed on a key/);
    const all = tableAwareReindexMessage({ ...plan, visionPagesToReread: 0 }, { visionAllPages: true });
    expect(all).toMatch(/no usable key of their own indexes them, holding the pages AI vision read before for a key and the rest text-only\./);
    expect(all).not.toMatch(/indexes them text-only\./);
    const refusal = tableAwareReindexKeyRefusal(plan, "you have no AI key saved — add yours in AI settings first");
    expect(refusal).toMatch(/those pages would wait for one, and their documents would not be marked ready until they are read or an admin accepts the partial index\.$/);
    expect(refusal).not.toMatch(/only their text layer/);
  });

  it("ING-13: the plan carries keylessHolds only when the route says so — a route that predates it plans as before", async () => {
    answers = [{ ok: true, dryRun: true, chunker: 2, documents: 3, toReset: 2, visionPagesToReread: 9, keylessHolds: true }];
    expect(await planTableAwareReindex("lib-1")).toEqual({ documents: 3, toReset: 2, visionPagesToReread: 9, keylessHolds: true });
    answers = [{ ok: true, dryRun: true, chunker: 2, documents: 3, toReset: 2, visionPagesToReread: 9, keylessHolds: false }];
    expect(await planTableAwareReindex("lib-1")).toEqual({ documents: 3, toReset: 2, visionPagesToReread: 9 });
  });

  it("a read-every-page library: the nightly run skips a document with no uploader key (every doc-control mirror), and a keyless controller's open app indexes it text-only — said, even when no vision page was counted", () => {
    const skipped =
      "Because this library reads every page with AI vision, the nightly run never indexes a document whose uploader "
      + "has no AI key with budget left and a signed AI agreement — every doc-control mirror among them. Until a driver "
      + "with a usable key reaches those documents, the nightly run skips them, but any Admin or Doc Control member with "
      + "the app open and no usable key of their own indexes them text-only.";
    const msg = tableAwareReindexMessage({ documents: 6, toReset: 4, visionPagesToReread: 52 }, { visionAllPages: true });
    expect(msg).toContain(skipped);
    expect(msg).toContain("This library reads every page with AI vision. The dry run counts 52 pages of them as read by "
      + "AI vision before. Every page of those documents is read, and billed, whatever that count, but only where whoever "
      + "indexes it has an AI key with budget left");
    // The second false claim is gone: they do not "stay out of Ask until" a keyed controller indexes them.
    expect(msg).not.toMatch(/stay out of Ask until/);
    const none = tableAwareReindexMessage({ documents: 6, toReset: 4, visionPagesToReread: 0 }, { visionAllPages: true });
    expect(none).not.toContain("No page of those documents is counted");
    expect(none).not.toContain("The dry run counts");
    expect(none).toContain("This library reads every page with AI vision. Every page of those documents is read, and "
      + "billed, whatever that count, but only where whoever indexes it has an AI key with budget left");
    expect(none).toContain(skipped);
  });

  it("the refusal for a person whose own key cannot read quotes the count as a count, the reason, and what would be lost", () => {
    expect(tableAwareReindexKeyRefusal({ documents: 6, toReset: 4, visionPagesToReread: 52 }, "you have no AI key saved — add yours in AI settings first"))
      .toBe("Nothing was reset. The dry run counts 52 pages of this library as read by AI vision, and this re-index reads "
        + "such pages with AI vision again; this page starts indexing what it resets on your key as soon as it runs — but "
        + "you have no AI key saved — add yours in AI settings first. Indexed with no usable key, those pages would come "
        + "back with only their text layer, and AI vision would not read them again until the document is re-indexed on a key.");
    expect(tableAwareReindexKeyRefusal({ documents: 6, toReset: 4, visionPagesToReread: 0 }, "x", { visionAllPages: true }))
      .toContain("This re-index reads every page of the documents it resets with AI vision;");
    expect(tableAwareReindexKeyRefusal({ documents: 6, toReset: 4, visionPagesToReread: 52 }, "x", { visionAllPages: true }))
      .toContain("This re-index reads every page of the documents it resets with AI vision;");
    // Nothing counted and not a read-every-page library: the page never asks
    // for a key then, so this wording is for any other caller.
    expect(tableAwareReindexKeyRefusal({ documents: 6, toReset: 4, visionPagesToReread: 0 }, "x"))
      .toContain("This re-index reads the AI-vision pages of the documents it resets with AI vision again;");
  });
});

describe("ownVisionKeyProblem — the clicking person's own key, by the ingest route's test", () => {
  const conn = (provider: string) => ({
    provider, model: "m", keyLast4: "abcd", updatedAt: "2026-09-01T00:00:00Z",
    embeddingProvider: null, embeddingModel: null, embeddingKeyLast4: null,
  });
  const conns = (c: ReturnType<typeof conn> | null) => ({ org: null, personal: c, effective: c, canManageOrg: true });
  const usage = (spentUsd: number, capUsd: number) => ({
    spentUsd, capUsd, percent: 0, inputTokens: 0, outputTokens: 0, asks: 0, avgPromptTokens: 0, monthLabel: "October 2026",
  });

  it("a usable key (allowed provider, under its cap) has no problem — asked of the connection and the usage routes", async () => {
    answers = [conns(conn("anthropic")), usage(2, 10)];
    expect(await ownVisionKeyProblem("o1")).toBeNull();
    expect(urls).toEqual(["/api/ai/connection?orgId=o1", "/api/ai/usage?orgId=o1"]);
  });

  it("no key saved: the reason, and the usage route is not asked", async () => {
    answers = [conns(null)];
    expect(await ownVisionKeyProblem("o1")).toBe("you have no AI key saved — add yours in AI settings first");
    expect(calls).toBe(1);
  });

  it("a provider indexing may not use is a problem, as the route's ALLOWED_PROVIDERS test makes it", async () => {
    answers = [conns(conn("google"))];
    expect(await ownVisionKeyProblem("o1")).toBe("your AI key's provider (google) cannot be used for indexing — change it in AI settings");
  });

  it("a monthly budget reached is a problem; a cap of 0 is the LOCK (GOV-3 — the I-05 merge gate)", async () => {
    answers = [conns(conn("openai")), usage(10, 10)];
    expect(await ownVisionKeyProblem("o1")).toBe("your monthly AI budget is reached ($10.00 of $10.00) — it resets next month, or an admin can raise it");
    const lock = "your monthly AI cap is set to $0, so AI is locked for you until someone who manages AI caps raises it";
    calls = 0; urls = [];
    answers = [conns(conn("openai")), { ...usage(0, 0), locked: true }];
    expect(await ownVisionKeyProblem("o1")).toBe(lock);
    calls = 0; urls = [];
    answers = [conns(conn("openai")), usage(50, 0)];
    expect(await ownVisionKeyProblem("o1")).toBe(lock);
  });

  it("a check that cannot be made throws, never answers 'usable'", async () => {
    answers = [{ __status: 500, error: "Couldn't load your connection: timeout" }];
    await expect(ownVisionKeyProblem("o1")).rejects.toThrow(/Couldn't load your connection: timeout/);
  });
});
