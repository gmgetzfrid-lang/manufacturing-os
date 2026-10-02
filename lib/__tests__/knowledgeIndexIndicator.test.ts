// @vitest-environment jsdom
//
// intelligence Round G, I-02b (2026-10-01) — the app-shell indexing driver
// (components/providers/KnowledgeIndexIndicator.tsx) and parked documents
// (ING-6 / ING-8 handoff). Before: every two minutes, in every controller
// tab, each document parked for AI vision or backing off from a failed
// batch was POSTed again (≈8 queries, a 409), and the card was re-shown —
// "Indexing <doc>", then "caught up — 0 documents indexed" — even after the
// user dismissed it. Now:
//   * a back-off in force (a future stamp WITH its reason in `error`) is left
//     out by the query itself — a future stamp with no reason (a row the
//     drawing rebuild reset) holds nothing back and is read (review fix);
//   * a parked row (a reason or a lapsed stamp) is tried once per state per
//     tab — the try its message promises while a controller has the app
//     open — and not POSTed again while it is unchanged;
//   * the card shows only when a batch made progress;
//   * it never passes retryNow (that is a person's Resume).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  /** One answer per query, in order; the last repeats. */
  answers: [] as Array<{ data: Row[] | null; error: { code?: string; message: string } | null }>,
  queries: [] as Array<Array<{ method: string; args: unknown[] }>>,
}));
const ing = vi.hoisted(() => ({ ingestKnowledgeDocument: vi.fn(), isIngestActive: vi.fn(() => false) }));

vi.mock("@/lib/supabase", () => {
  const from = () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    db.queries.push(calls);
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const n = db.queries.indexOf(calls);
          const res = db.answers[Math.min(n, db.answers.length - 1)] ?? { data: [], error: null };
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => { calls.push({ method: prop, args }); return new Proxy({}, h); };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from } };
});
vi.mock("@/components/providers/RoleContext", () => ({
  useRole: () => ({ activeOrgId: "o1", hasAnyRole: (rs: string[]) => rs.includes("DocCtrl") }),
}));
vi.mock("@/lib/knowledge", () => ing);
vi.mock("@/lib/uploadActivity", () => ({ isUploading: () => false, onUploadActivity: () => () => undefined }));
vi.mock("@/components/ui/CornerDock", () => ({
  CornerPortal: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  // No dock in this harness: every card the indicator asks for may show.
  useDockAllowance: (_slot: string, _priority: number, count: number) => count,
  DOCK_PRIORITY: { backup: 10, knowledge: 20, upload: 30, toast: 10 },
}));

import KnowledgeIndexIndicator from "@/components/providers/KnowledgeIndexIndicator";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** One more poll (the component's setInterval). */
const poll = async () => { await act(async () => { vi.advanceTimersByTime(120_000); }); await flush(); };
const answer = (rows: Row[]) => { db.answers = [{ data: rows, error: null }]; db.queries = []; };

const PAST = "2026-09-30T00:00:00.000Z";
const KEYLESS = "AI vision could not read 2 pages (p. 3, 7), and retrying needs an AI key with budget left. The rest of the document is searchable meanwhile.";
const parked = (over: Row = {}): Row => ({
  id: "parked", name: "025-PID-0101.pdf", status: "indexing", pages_indexed: 40, page_count: 40,
  error: KEYLESS, vision_retry_after: PAST, ...over,
});
const fresh = (over: Row = {}): Row => ({
  id: "fresh", name: "API-650.pdf", status: "pending", pages_indexed: 0, page_count: null,
  error: null, vision_retry_after: null, ...over,
});
const refused409 = () => Promise.reject(Object.assign(new Error(KEYLESS), { visionRetryBlocked: true }));
const progresses = (to: number, total: number) =>
  async (_id: string, onIndex?: (i: number, t: number | null, p?: { visionPages: number }) => void) => { onIndex?.(to, total, { visionPages: 0 }); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  ing.ingestKnowledgeDocument.mockReset();
  ing.isIngestActive.mockReset();
  ing.isIngestActive.mockReturnValue(false);
  db.answers = []; db.queries = [];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

async function mount() {
  await act(async () => { root.render(React.createElement(KnowledgeIndexIndicator)); });
  await flush();
}

describe("the queue leaves out a back-off in force", () => {
  it("the query filters out vision_retry_after in the future — unless the row carries no reason — and orders unstamped work first", async () => {
    answer([]);
    await mount();
    const q = db.queries[0];
    const or = q.find((c) => c.method === "or");
    expect(String(or?.args[0])).toMatch(/^vision_retry_after\.is\.null,vision_retry_after\.lte\.\d{4}-\d{2}-\d{2}T[^,]+,error\.is\.null$/);
    expect(q.find((c) => c.method === "order")?.args).toEqual(["vision_retry_after", { ascending: true, nullsFirst: true }]);
    expect(String(q.find((c) => c.method === "select")?.args[0])).toContain("vision_retry_after");
    expect(ing.ingestKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("a row the drawing rebuild reset (error nulled, a future stamp kept) is driven — the engine holds it back for nothing", async () => {
    // The engine holds a failed batch only while `error` names the attempt,
    // and a vision retry only past a finished main pass; the rebuild nulls
    // `error` and resets the row to page 0. The query lets it through
    // (error.is.null), and the indicator drives it like any queued row.
    answer([fresh({ id: "rebuilt", status: "stale", error: null, vision_retry_after: "2099-01-01T00:00:00.000Z" })]);
    ing.ingestKnowledgeDocument.mockImplementation(progresses(4, 40));
    await mount();
    expect(ing.ingestKnowledgeDocument.mock.calls.map((c) => c[0])).toEqual(["rebuilt"]);
    expect(host.textContent).toMatch(/1 document indexed\./);
  });

  it("a database without 20261122 (no stamp column) falls back to the plain queue", async () => {
    db.answers = [
      { data: null, error: { code: "42703", message: "column knowledge_documents.vision_retry_after does not exist" } },
      { data: [fresh({ vision_retry_after: undefined })], error: null },
      { data: [], error: null },
    ];
    ing.ingestKnowledgeDocument.mockImplementation(progresses(10, 10));
    await mount();
    expect(db.queries[1].some((c) => c.method === "or")).toBe(false);
    expect(String(db.queries[1].find((c) => c.method === "select")?.args[0])).not.toContain("vision_retry_after");
    expect(ing.ingestKnowledgeDocument).toHaveBeenCalledWith("fresh", expect.any(Function));
  });
});

describe("a parked document is tried once per state per tab — never on every poll", () => {
  it("unchanged on the next poll, it is not POSTed again; a new state (a re-stamp, a new reason) is tried once more", async () => {
    answer([parked()]);
    ing.ingestKnowledgeDocument.mockImplementation(refused409);
    await mount();
    expect(ing.ingestKnowledgeDocument).toHaveBeenCalledTimes(1);
    await poll();
    await poll();
    expect(ing.ingestKnowledgeDocument).toHaveBeenCalledTimes(1);
    // Someone (the cron drain, another tab) moved the row: a new state.
    answer([parked({ vision_retry_after: "2026-10-01T00:00:00.000Z" })]);
    await poll();
    expect(ing.ingestKnowledgeDocument).toHaveBeenCalledTimes(2);
    await poll();
    expect(ing.ingestKnowledgeDocument).toHaveBeenCalledTimes(2);
  });

  it("a failed batch whose back-off lapsed is tried (the promised try while the app is open) — once", async () => {
    const lapsed = parked({ id: "failed", error: "Indexing failed: connection reset — attempt 1 of 3. …", status: "pending", pages_indexed: 0 });
    answer([lapsed]);
    ing.ingestKnowledgeDocument.mockImplementation(() => Promise.reject(new Error("Indexing failed: connection reset")));
    await mount();
    await poll();
    expect(ing.ingestKnowledgeDocument.mock.calls.map((c) => c[0])).toEqual(["failed"]);
  });

  it("parked rows already tried never keep fresh work behind them", async () => {
    answer([parked(), fresh()]);
    ing.ingestKnowledgeDocument.mockImplementation(async (id: string, onIndex?: (i: number, t: number | null) => void) => {
      if (id === "parked") throw new Error(KEYLESS);
      onIndex?.(5, 10);
    });
    await mount();
    await poll();
    expect(ing.ingestKnowledgeDocument.mock.calls.map((c) => c[0])).toEqual(["parked", "fresh", "fresh"]);
  });

  it("no automatic call ever passes retryNow", async () => {
    answer([parked(), fresh()]);
    ing.ingestKnowledgeDocument.mockImplementation(progresses(5, 10));
    await mount();
    await poll();
    expect(ing.ingestKnowledgeDocument.mock.calls.length).toBeGreaterThan(0);
    for (const c of ing.ingestKnowledgeDocument.mock.calls) expect(c.length).toBe(2);
  });
});

describe("the card shows only on progress", () => {
  it("an attempt that moved nothing shows no card", async () => {
    answer([parked()]);
    ing.ingestKnowledgeDocument.mockImplementation(refused409);
    await mount();
    expect(host.textContent).toBe("");
  });

  it("a batch that indexed pages shows it, then 'caught up — 1 document indexed'; dismissed, it stays dismissed while nothing moves", async () => {
    answer([fresh()]);
    ing.ingestKnowledgeDocument.mockImplementation(progresses(10, 10));
    await mount();
    expect(host.textContent).toMatch(/Knowledge indexing caught up/);
    expect(host.textContent).toMatch(/1 document indexed\./);
    await act(async () => { (host.querySelector('button[title="Dismiss"]') as HTMLElement).click(); });
    expect(host.textContent).toBe("");
    // A parked document in a new state is tried — and refused: the card stays away.
    answer([parked({ vision_retry_after: "2026-10-01T00:00:00.000Z" })]);
    ing.ingestKnowledgeDocument.mockImplementation(refused409);
    await poll();
    expect(ing.ingestKnowledgeDocument).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("");
    // A batch that moves comes back as the minimized pill at most — never the
    // full card the person closed — and a pass that ends clean after the
    // dismissal shows nothing (STACK-6 / TAX-8, notifications Round G N7;
    // before, `setHidden(false)` re-opened the full card on every pass).
    answer([fresh({ id: "next", name: "B31.3.pdf" })]);
    let release!: () => void;
    ing.ingestKnowledgeDocument.mockImplementation(
      async (_id: string, onIndex?: (i: number, t: number | null, p?: { visionPages: number }) => void) => {
        onIndex?.(4, 10, { visionPages: 0 });
        await new Promise<void>((r) => { release = r; });
      });
    await poll();
    expect(host.textContent).toMatch(/Indexing 40%/);
    expect(host.textContent).not.toMatch(/Indexing knowledge in the background/);
    await act(async () => { release(); });
    await flush();
    expect(host.textContent).toBe("");
  });

  it("a vision retry that reads pages without moving the resume point is progress", async () => {
    answer([parked({ error: null, vision_retry_after: null })]);
    ing.ingestKnowledgeDocument.mockImplementation(
      async (_id: string, onIndex?: (i: number, t: number | null, p?: { visionPages: number; visionSkipReason: string | null }) => void) => {
        onIndex?.(40, 40, { visionPages: 2, visionSkipReason: null });
      });
    await mount();
    expect(host.textContent).toMatch(/1 document indexed\./);
  });

  it("a busy answer (another session holds the claim) shows nothing", async () => {
    answer([fresh({ status: "indexing", pages_indexed: 20, page_count: 40 })]);
    ing.ingestKnowledgeDocument.mockImplementation(
      async (_id: string, onIndex?: (i: number, t: number | null, p?: { visionPages: number }) => void) => {
        onIndex?.(20, 40, { visionPages: 0 });
        throw new Error("Another session is indexing this document right now.");
      });
    await mount();
    expect(host.textContent).toBe("");
  });
});
