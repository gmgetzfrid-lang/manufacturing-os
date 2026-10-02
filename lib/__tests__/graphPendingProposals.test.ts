// intelligence Round G (I-14) — GM-7: the graph's proposal read tells a
// failed read and a capped one apart from an empty queue, and counts the
// queue rather than what it drew.
//
// Reproduction: listPendingPairs answered `[]` on ANY error and read a
// single `.limit(4000)` — which PostgREST cuts at db-max-rows (1,000) with
// no error — so a failed read, a cut read and an empty queue looked the
// same, and the map's chip counted only what it drew.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { id: string; document_id: string; target_document_id: string; proposer: string; confidence: number };
const db = vi.hoisted(() => ({
  rows: [] as Row[],
  maxRows: 1000,
  error: null as null | { code?: string; message: string },
  errorOnWindow: -1,
  calls: [] as Array<{ method: string; args: unknown[] }>,
}));

vi.mock("@/lib/supabase", () => {
  const chain = () => {
    let from = 0, to = 0, counting = false;
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const window = Math.floor(from / 1000);
          const sorted = [...db.rows].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
          const res = db.error && (db.errorOnWindow < 0 || db.errorOnWindow === window)
            ? { data: null, error: db.error, count: null }
            : { data: sorted.slice(from, Math.min(to + 1, from + db.maxRows)), error: null, count: counting ? db.rows.length : null };
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => {
          db.calls.push({ method: prop, args });
          if (prop === "select") counting = !!(args[1] as { count?: string } | undefined)?.count;
          if (prop === "range") { from = args[0] as number; to = args[1] as number; }
          return new Proxy({}, h);
        };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: () => chain() } };
});

import { readPendingProposalPairs, listPendingPairs, PENDING_PAIRS_CAP } from "@/lib/linkProposals";

const mk = (i: number): Row => ({
  id: `p${String(i).padStart(5, "0")}`, document_id: `d${i}`, target_document_id: `t${i}`, proposer: "tag", confidence: 0.5,
});

beforeEach(() => {
  db.rows = []; db.maxRows = 1000; db.error = null; db.errorOnWindow = -1; db.calls = [];
});

describe("GM-7 — error, capped and empty are three different answers", () => {
  it("empty: no pairs, total 0, no error", async () => {
    expect(await readPendingProposalPairs("o1")).toEqual({ pairs: [], total: 0, capped: false, error: null });
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
    db.error = { code: "42703", message: "column proposed_links.confidence does not exist" };
    const r = await readPendingProposalPairs("o1");
    expect(r.error).toMatch(/confidence does not exist/);
    expect(r.total).toBeNull();
  });

  it("past the cap: draws the first 4,000 in order and says how many are pending", async () => {
    db.rows = Array.from({ length: 4300 }, (_, i) => mk(i));
    const r = await readPendingProposalPairs("o1");
    expect(r.pairs).toHaveLength(PENDING_PAIRS_CAP);
    expect(r.total).toBe(4300);
    expect(r.capped).toBe(true);
    expect(r.error).toBeNull();
    // Windows of at most 1,000 rows (PostgREST's silent cut), in a fixed order.
    const ranges = db.calls.filter((c) => c.method === "range").map((c) => c.args);
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999], [3000, 3999]]);
    expect(db.calls.filter((c) => c.method === "order").map((c) => c.args[0])).toEqual(
      Array.from({ length: 4 }, () => ["confidence", "id"]).flat(),
    );
  });

  it("a server cutting responses shorter than a window is reported as capped, not complete", async () => {
    db.rows = Array.from({ length: 1200 }, (_, i) => mk(i));
    db.maxRows = 500;
    const r = await readPendingProposalPairs("o1");
    expect(r.pairs).toHaveLength(500);
    expect(r.total).toBe(1200);
    expect(r.capped).toBe(true);
  });

  it("both ends carry their kind: graph node ids of documents", async () => {
    db.rows = [mk(1)];
    const r = await readPendingProposalPairs("o1");
    expect(r.pairs).toEqual([{ documentId: "d1", targetDocumentId: "t1", proposer: "tag", nodeA: "doc:d1", nodeB: "doc:t1" }]);
    expect(r).toMatchObject({ total: 1, capped: false });
  });
});
