// intelligence Round G (I-14) — GM-7: the graph's proposal read tells a
// failed read and a capped one apart from an empty queue, and counts the
// queue rather than what it drew.
//
// Reproduction: listPendingPairs answered `[]` on ANY error and read a
// single `.limit(4000)` — which PostgREST cuts at db-max-rows (1,000) with
// no error — so a failed read, a cut read and an empty queue looked the
// same, and the map's chip counted only what it drew.
//
// Fix pass 3: the read is cheap again. The first build sorted the whole
// pending queue by `confidence` (no index) and paged it by OFFSET with an
// exact count, so every window re-sorted the queue and re-evaluated the
// RESTRICTIVE proposed_links_read_endpoints policy over all of it. Now it
// reads KEYSET windows on (created_at desc, then id desc) — the order of
// proposed_links_org_status_idx for created_at; the index holds no id — and
// counts the queue once, only when the cap is reached.
//
// Fix pass 4: each later window also carries `created_at <= c`, which the
// `or` tree alone does not hand the planner as an index bound. Inside one
// Find-connections run (one created_at) each window still reads the run's
// remaining rows, as the index cannot order the tie by id (GM-7's residual).

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { id: string; document_id: string; target_document_id: string; proposer: string; created_at: string };
type Call = { method: string; args: unknown[] };
const db = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; document_id: string; target_document_id: string; proposer: string; created_at: string }>,
  maxRows: 1000,
  error: null as null | { code?: string; message: string },
  errorOnWindow: -1,
  countError: null as null | { message: string },
  requests: [] as Array<{ calls: Array<{ method: string; args: unknown[] }> }>,
}));

vi.mock("@/lib/supabase", () => {
  const isHead = (calls: Call[]) => !!(calls.find((c) => c.method === "select")?.args[1] as { head?: boolean } | undefined)?.head;
  const answer = (req: { calls: Call[] }) => {
    if (isHead(req.calls)) {
      return db.countError ? { data: null, error: db.countError, count: null } : { data: null, error: null, count: db.rows.length };
    }
    const window = db.requests.filter((r) => !isHead(r.calls)).indexOf(req);
    if (db.error && (db.errorOnWindow < 0 || db.errorOnWindow === window)) return { data: null, error: db.error, count: null };
    let rows = [...db.rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    for (const c of req.calls.filter((x) => x.method === "lte")) {
      const [col, v] = c.args as ["created_at", string];
      if (col !== "created_at") throw new Error(`unexpected range filter on ${col}`);
      rows = rows.filter((r) => r.created_at <= v);
    }
    const or = req.calls.find((c) => c.method === "or")?.args[0] as string | undefined;
    if (or) {
      const m = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([^)]+)\)$/.exec(or);
      if (!m || m[1] !== m[2]) throw new Error(`unexpected keyset filter: ${or}`);
      rows = rows.filter((r) => r.created_at < m[1] || (r.created_at === m[1] && r.id < m[3]));
    }
    const limit = req.calls.find((c) => c.method === "limit")?.args[0] as number;
    return { data: rows.slice(0, Math.min(limit, db.maxRows)), error: null, count: null };
  };
  const chain = () => {
    const req = { calls: [] as Call[] };
    db.requests.push(req);
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(answer(req));
        return (...args: unknown[]) => { req.calls.push({ method: prop, args }); return new Proxy({}, h); };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: () => chain() } };
});

import { readPendingProposalPairs, listPendingPairs, PENDING_PAIRS_CAP } from "@/lib/linkProposals";

/** A PostgREST timestamptz, as the API returns it (microseconds, offset). */
const ts = (sec: number) => new Date(Date.UTC(2026, 8, 30) + sec * 1000).toISOString().replace(/\.\d{3}Z$/, ".123456+00:00");
const mk = (i: number, createdAt = ts(100_000 - i)): Row => ({
  id: `p${String(i).padStart(5, "0")}`, document_id: `d${i}`, target_document_id: `t${i}`, proposer: "tag", created_at: createdAt,
});
const dataRequests = () => db.requests.filter((r) => !(r.calls.find((c) => c.method === "select")?.args[1] as { head?: boolean } | undefined)?.head);
const countRequests = () => db.requests.filter((r) => !!(r.calls.find((c) => c.method === "select")?.args[1] as { head?: boolean } | undefined)?.head);
const methods = (r: { calls: Call[] }) => r.calls.map((c) => c.method);

beforeEach(() => {
  db.rows = []; db.maxRows = 1000; db.error = null; db.errorOnWindow = -1; db.countError = null; db.requests = [];
});

describe("GM-7 — error, capped and empty are three different answers", () => {
  it("empty: no pairs, total 0, no error — one request, no count", async () => {
    expect(await readPendingProposalPairs("o1")).toEqual({ pairs: [], total: 0, capped: false, error: null });
    expect(db.requests).toHaveLength(1);
  });

  it("a failed read is an error, never an empty queue", async () => {
    db.error = { code: "57014", message: "canceling statement due to statement timeout" };
    const r = await readPendingProposalPairs("o1");
    expect(r.error).toMatch(/statement timeout/);
    expect(r.pairs).toEqual([]);
    // The compatibility wrapper keeps its old contract (an error reads as none).
    expect(await listPendingPairs("o1")).toEqual([]);
  });

  it("a read that fails on a later window keeps what it read and says it failed", async () => {
    db.rows = Array.from({ length: 1500 }, (_, i) => mk(i));
    db.error = { message: "connection reset" }; db.errorOnWindow = 1;
    const r = await readPendingProposalPairs("o1");
    expect(r.pairs).toHaveLength(1000);
    expect(r.error).toBe("connection reset");
    expect(r.total).toBeNull();
  });

  it("before 20260807 (no proposed_links table) there is nothing pending — not an error", async () => {
    db.error = { code: "42P01", message: 'relation "proposed_links" does not exist' };
    expect(await readPendingProposalPairs("o1")).toEqual({ pairs: [], total: 0, capped: false, error: null });
  });

  it("PostgREST's own missing-table answer (PGRST205) is also nothing pending — not an error", async () => {
    db.error = { code: "PGRST205", message: "Could not find the table 'public.proposed_links' in the schema cache" };
    expect(await readPendingProposalPairs("o1")).toEqual({ pairs: [], total: 0, capped: false, error: null });
  });

  it("a missing COLUMN is an error, never an empty queue (fails closed)", async () => {
    db.error = { code: "42703", message: "column proposed_links.created_at does not exist" };
    const r = await readPendingProposalPairs("o1");
    expect(r.error).toMatch(/created_at does not exist/);
    expect(r.total).toBeNull();
  });

  it("past the cap: draws the newest 4,000 and says how many are pending — one count, at the cap", async () => {
    db.rows = Array.from({ length: 4300 }, (_, i) => mk(i));
    const r = await readPendingProposalPairs("o1");
    expect(r.pairs).toHaveLength(PENDING_PAIRS_CAP);
    expect(r.pairs[0].documentId).toBe("d0");                 // the newest first
    expect(r.pairs[PENDING_PAIRS_CAP - 1].documentId).toBe("d3999");
    expect(r.total).toBe(4300);
    expect(r.capped).toBe(true);
    expect(r.error).toBeNull();
    expect(dataRequests().map((q) => q.calls.find((c) => c.method === "limit")?.args[0])).toEqual([1000, 1000, 1000, 1000]);
    expect(countRequests()).toHaveLength(1);
  });

  it("below the cap the read is the count: no count request at all, and nothing capped", async () => {
    db.rows = Array.from({ length: 1500 }, (_, i) => mk(i));
    const r = await readPendingProposalPairs("o1");
    expect(r).toMatchObject({ total: 1500, capped: false, error: null });
    expect(new Set(r.pairs.map((p) => p.documentId)).size).toBe(1500);
    expect(countRequests()).toHaveLength(0);
    // 1,000, the remaining 500, then an empty window ends the read.
    expect(dataRequests()).toHaveLength(3);
  });

  it("a server cutting responses shorter than a window is paged on, never reported complete over a cut set", async () => {
    db.rows = Array.from({ length: 1200 }, (_, i) => mk(i));
    db.maxRows = 500;
    const r = await readPendingProposalPairs("o1");
    expect(r.pairs).toHaveLength(1200);
    expect(r).toMatchObject({ total: 1200, capped: false, error: null });
  });

  it("the count failing at the cap says 'at least the cap', never a wrong total", async () => {
    db.rows = Array.from({ length: 4001 }, (_, i) => mk(i));
    db.countError = { message: "timeout" };
    const r = await readPendingProposalPairs("o1");
    expect(r).toMatchObject({ total: null, capped: true, error: null });
    expect(r.pairs).toHaveLength(PENDING_PAIRS_CAP);
  });

  it("both ends carry their kind: graph node ids of documents", async () => {
    db.rows = [mk(1)];
    const r = await readPendingProposalPairs("o1");
    expect(r.pairs).toEqual([{ documentId: "d1", targetDocumentId: "t1", proposer: "tag", nodeA: "doc:d1", nodeB: "doc:t1" }]);
    expect(r).toMatchObject({ total: 1, capped: false });
  });
});

describe("GM-7 — keyset windows on (created_at desc, id desc), never a confidence sort or an offset (fix pass 3)", () => {
  it("orders by created_at desc (the index's column), then id desc — never by confidence, never by offset", async () => {
    db.rows = Array.from({ length: 2500 }, (_, i) => mk(i));
    await readPendingProposalPairs("o1");
    for (const q of dataRequests()) {
      expect(q.calls.filter((c) => c.method === "order").map((c) => c.args)).toEqual([
        ["created_at", { ascending: false }], ["id", { ascending: false }],
      ]);
      expect(methods(q)).not.toContain("range");
      // No data window asks for a count (each would re-evaluate the policy over the whole queue).
      expect((q.calls.find((c) => c.method === "select")?.args[1] as { count?: string } | undefined)?.count).toBeUndefined();
      expect(q.calls.filter((c) => c.method === "eq").map((c) => c.args)).toEqual([["org_id", "o1"], ["status", "pending"]]);
    }
    expect(JSON.stringify(dataRequests().flatMap((q) => q.calls))).not.toContain("confidence");
  });

  it("each window starts after the last row read, with the timestamp quoted (it carries . : +)", async () => {
    db.rows = Array.from({ length: 1001 }, (_, i) => mk(i));
    await readPendingProposalPairs("o1");
    const [first, second] = dataRequests();
    expect(methods(first)).not.toContain("or");
    const or = second.calls.find((c) => c.method === "or")?.args[0];
    const lastRead = mk(999);
    expect(or).toBe(`created_at.lt."${lastRead.created_at}",and(created_at.eq."${lastRead.created_at}",id.lt.${lastRead.id})`);
  });

  it("each later window also bounds the index range: created_at <= the last row's, beside the or (fix pass 4)", async () => {
    // Without it the planner reads the or tree as two bitmap scans and sorts
    // every remaining row (PG16, 9,000 pending: 8,000 rows and policy checks
    // for window 2); with it window 2 is one index range of 1,001 rows.
    db.rows = Array.from({ length: 2500 }, (_, i) => mk(i));
    const r = await readPendingProposalPairs("o1");
    const windows = dataRequests();
    expect(windows).toHaveLength(4);
    expect(methods(windows[0])).not.toContain("lte");
    const lastOf = [mk(999), mk(1999), mk(2499)];
    windows.slice(1).forEach((q, k) => {
      expect(q.calls.filter((c) => c.method === "lte").map((c) => c.args)).toEqual([["created_at", lastOf[k].created_at]]);
      expect(methods(q)).toContain("or");
    });
    // The bound changes no row and no order.
    expect(r.pairs.map((p) => p.documentId)).toEqual(Array.from({ length: 2500 }, (_, i) => `d${i}`));
  });

  it("rows sharing one created_at across a window edge are neither skipped nor read twice", async () => {
    const same = ts(7);
    db.rows = Array.from({ length: 2300 }, (_, i) => mk(i, same));
    const r = await readPendingProposalPairs("o1");
    expect(r.pairs).toHaveLength(2300);
    expect(new Set(r.pairs.map((p) => p.documentId)).size).toBe(2300);
    expect(r).toMatchObject({ total: 2300, capped: false });
  });

  it("a row with no usable key ends the read with an error rather than looping", async () => {
    db.rows = Array.from({ length: 1000 }, (_, i) => mk(i));
    db.rows[999] = { ...db.rows[999], created_at: "" };
    const r = await readPendingProposalPairs("o1");
    expect(r.error).toMatch(/cannot page/);
    expect(dataRequests()).toHaveLength(1);
  });
});
