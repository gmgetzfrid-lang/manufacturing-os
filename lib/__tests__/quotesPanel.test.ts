// projects Round G — the bid table's pure contracts (BID-1 / BID-6 / BID-8 /
// BID-10 / BID-11 / COST-13), pinned on the helpers QuotesPanel renders
// from so the screen cannot drift from them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeBidEconomics, scoreBids, withHumanTotal, priceOnlyQuote, mergeQuoteGroups,
  snapRfqGroup, rfqGroupKey, quoteExpired, readExtent, alignGroupSpelling, type ParsedQuote,
} from "@/lib/bidTab";

// The panel's guarded write runs against a recording supabase double: the
// UPDATE's filters are captured, and `matched` decides how many rows the
// status predicate lets through (0 = someone moved the document).
const db = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  matched: 1,
  auditError: null as null | { message: string },
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const res = table === "audit_logs" ? { data: null, error: db.auditError } : { data: Array.from({ length: db.matched }, () => ({ id: "d1" })), error: null };
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => { db.calls.push({ table, method: prop, args }); return new Proxy({}, h); };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
});

import { guardedCostDocWrite } from "@/components/projects/cost/QuotesPanel";

const quote = (over: Partial<ParsedQuote>): ParsedQuote => ({
  id: "q1", vendorName: "V", total: 100_000, lineItems: [], exclusions: [],
  currency: "USD", validUntil: null, notes: null, ...over,
});

describe("BID-1 — one authoritative total for display, score and award", () => {
  it("display and award agree after setManualTotal: the row's total overlays the extraction and re-normalises the field", () => {
    const misread = quote({ id: "a", total: 182_000, lineItems: [{ description: "Repipe exchanger circuits", total: 182_000, hours: 1800 }] });
    const rival = quote({ id: "b", total: 400_000, lineItems: [{ description: "Repipe exchanger circuits", total: 400_000, hours: 3600 }] });
    // Before the correction the misread bid wins price outright.
    const before = scoreBids(computeBidEconomics([misread, rival]));
    expect(before.find((s) => s.quoteId === "a")!.parts.price).toBe(100);
    // setManualTotal writes total_amount = 1,182,000; the panel overlays it.
    const corrected = withHumanTotal(misread, 1_182_000);
    const econ = computeBidEconomics([corrected, rival]);
    const a = econ.find((e) => e.quoteId === "a")!;
    expect(a.total).toBe(1_182_000);                 // what the Price column shows AND what the award confirm shows
    expect(a.totalSource).toBe("human");
    expect(a.extractedTotal).toBe(182_000);          // the AI's original is never hidden (GAP-407)
    const after = scoreBids(econ);
    expect(after.find((s) => s.quoteId === "b")!.parts.price).toBe(100);   // the whole field re-normalised
    expect(after.find((s) => s.quoteId === "a")!.parts.price).toBe(34);
    expect(after.find((s) => s.best)!.quoteId).toBe("b");
  });

  it("an equal or absent row total leaves the extraction as-is and marks it extracted", () => {
    const q = quote({ id: "a", total: 182_000 });
    expect(withHumanTotal(q, null).totalSource).toBe("extracted");
    expect(withHumanTotal(q, 182_000).totalSource).toBe("extracted");
    expect(withHumanTotal(q, 0).total).toBe(182_000);
  });
});

describe("BID-8 — typed-total bids sit in the same field", () => {
  it("participate in price normalisation and read 'not scored', never 0, where they cannot be scored", () => {
    const parsed = quote({ id: "p", total: 120_000, lineItems: [{ description: "Repipe exchanger circuits", total: 120_000, hours: 1200 }] });
    const typed = priceOnlyQuote({ id: "t", vendorName: "Scan Co", total: 80_000, currency: "USD" });
    const econ = computeBidEconomics([parsed, typed]);
    const t = econ.find((e) => e.quoteId === "t")!;
    expect(t.priceOnly).toBe(true);
    expect(t.missingScope).toEqual([]);              // unknown scope is not "undisclosed" scope
    const scores = scoreBids(econ);
    const st = scores.find((s) => s.quoteId === "t")!, sp = scores.find((s) => s.quoteId === "p")!;
    expect(st.parts.price).toBe(100);
    expect(sp.parts.price).toBe(67);                  // the cheaper typed bid moved the parsed bid's price part
    expect(st.parts.manpower).toBeNull();
    expect(st.score).toBeNull();
    expect(st.unscored).toBe("price-only");
    expect(st.best).toBe(false);
    // With only one SCORED bid there is no field to badge.
    expect(sp.best).toBe(false);
  });
});

describe("BID-6 — single bid: score, no badge", () => {
  it("one scored bid carries a score and no best-value badge", () => {
    const [s] = scoreBids(computeBidEconomics([quote({ id: "solo", lineItems: [{ description: "Repipe circuits", total: 100_000, hours: 1000 }] })]));
    expect(s.score).not.toBeNull();
    expect(s.best).toBe(false);
    expect(s.tied).toBe(false);
  });
});

describe("BID-10 — RFQ group normalisation on the client", () => {
  it("case-variant groups tabulate as one, under the first-seen spelling", () => {
    const merged = mergeQuoteGroups([
      { group: "Unit 300 Repipe", docs: [{ id: "a" }] },
      { group: "unit 300  repipe", docs: [{ id: "b" }] },
      { group: "Scaffold", docs: [{ id: "c" }] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].group).toBe("Unit 300 Repipe");
    expect(merged[0].docs.map((d) => d.id)).toEqual(["a", "b"]);
  });
  it("a typed variant snaps onto the existing spelling so no second field is ever written", () => {
    expect(snapRfqGroup("unit 300  repipe", ["Unit 300 Repipe", "Scaffold"])).toBe("Unit 300 Repipe");
    expect(snapRfqGroup("Unit 300 repipe — phase 2", ["Unit 300 Repipe"])).toBe("Unit 300 repipe — phase 2");
    expect(snapRfqGroup("   ", ["Unit 300 Repipe"])).toBe("");
    expect(rfqGroupKey(" Unit  300 Repipe ")).toBe("unit 300 repipe");
  });
});

describe("BID-11 — validity", () => {
  it("an expired quote is detected; unknown dates never count as expired", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(quoteExpired("2026-09-01", now)).toBe(true);
    expect(quoteExpired("2026-09-23", now)).toBe(false);   // valid through the end of its day
    expect(quoteExpired("2026-10-01", now)).toBe(false);
    expect(quoteExpired(null, now)).toBe(false);
    expect(quoteExpired("not a date", now)).toBe(false);
  });
});

describe("COST-13 — read extent", () => {
  it("says 'read pages 1–8 of N' for a truncated read and 'unknown' for NULLs — never 'complete'", () => {
    expect(readExtent(8, 14)).toEqual({ truncated: true, known: true, label: "read pages 1–8 of 14" });
    expect(readExtent(3, 3)).toEqual({ truncated: false, known: true, label: "all 3 pages read" });
    expect(readExtent(null, null)).toEqual({ truncated: false, known: false, label: "read extent unknown" });
    expect(readExtent(8, null).known).toBe(false);
  });
});

describe("BID-9 / MON-3 — correct total and Void go through a status-guarded write", () => {
  const actor = { uid: "u1", email: "u1@example.com" };
  const doc = { id: "d1", orgId: "o1" };
  beforeEach(() => { db.calls = []; db.matched = 1; db.auditError = null; });

  it("the UPDATE carries the open-status predicate and reads back the rows it changed; the audit row follows", async () => {
    const res = await guardedCostDocWrite({ doc, actor, patch: { status: "void" }, audit: { action: "COST_DOC_VOIDED", details: { vendor: "V" } } });
    expect(res).toEqual({ ok: true, auditError: null });
    const upd = db.calls.filter((c) => c.table === "cost_documents");
    expect(upd.map((c) => c.method)).toEqual(["update", "eq", "eq", "in", "select"]);
    expect(upd.find((c) => c.method === "in")!.args).toEqual(["status", ["draft", "parsed"]]);
    expect(upd.find((c) => c.method === "eq" && c.args[0] === "org_id")!.args[1]).toBe("o1");
    const audit = db.calls.find((c) => c.table === "audit_logs" && c.method === "insert")!;
    expect((audit.args[0] as { action: string }).action).toBe("COST_DOC_VOIDED");
  });

  it("a stale tab: the document was awarded meanwhile — zero rows match, the write is refused and nothing is audited", async () => {
    db.matched = 0;
    const res = await guardedCostDocWrite({ doc, actor, patch: { total_amount: 1 }, audit: { action: "COST_DOC_MANUAL_TOTAL", details: {} } });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/already awarded, posted or voided/);
    expect(db.calls.some((c) => c.table === "audit_logs")).toBe(false);
  });

  it("a failed audit row is reported, never swallowed", async () => {
    db.auditError = { message: "rls denied" };
    const res = await guardedCostDocWrite({ doc, actor, patch: { total_amount: 5 }, audit: { action: "COST_DOC_MANUAL_TOTAL", details: {} } });
    expect(res).toEqual({ ok: true, auditError: "rls denied" });
  });
});

describe("BID-10 — the award declines rivals under every spelling of a merged field", () => {
  it("variant-spelled rivals are handed to the award under the awarded doc's spelling; other fields are untouched", () => {
    const docs = [
      { id: "a", kind: "quote", rfqGroup: "Unit 300 Repipe" },
      { id: "b", kind: "quote", rfqGroup: "unit 300  repipe" },
      { id: "c", kind: "quote", rfqGroup: "Scaffold" },
      { id: "i", kind: "invoice", rfqGroup: null },
    ];
    const aligned = alignGroupSpelling(docs, "Unit 300 Repipe");
    // awardQuote's rival filter is exact string equality on rfq_group.
    const rivals = aligned.filter((d) => d.id !== "a" && d.kind === "quote" && d.rfqGroup === "Unit 300 Repipe");
    expect(rivals.map((d) => d.id)).toEqual(["b"]);
    expect(aligned.find((d) => d.id === "c")!.rfqGroup).toBe("Scaffold");
    expect(alignGroupSpelling(docs, null)).toBe(docs);
  });
});
