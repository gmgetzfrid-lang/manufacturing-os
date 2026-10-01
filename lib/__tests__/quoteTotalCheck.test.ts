// intelligence Round G, package I-04 — PR-2: an AI-extracted quote's bottom
// line is reconciled against its own priced lines, and a mismatch is FLAGGED
// on the parsed record for the review screen — never corrected, never
// blocking (the plan default; DEC-44 (I-04)).
//
//   * the finding's scenario: a base bid of 1,820,000 whose lines add up to
//     it, read with the 182,000 alternate as the total → flagged, with both
//     numbers; the total stays what was read;
//   * a rounding gap is not a flag; a quote with no priced line has nothing
//     to reconcile; unpriced lines are counted;
//   * the check is recomputed from the stored extraction (parsedQuoteFrom
//     re-validates), so a stored row and a fresh read agree;
//   * /api/projects/cost-docs (not edited here) stores the flag in
//     cost_documents.parsed and returns it, because it stores and returns
//     validateParsedQuote's record.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { validateParsedQuote, reconcileQuoteTotal, withHumanTotal, TOTAL_RECONCILE_TOLERANCE } from "@/lib/bidTab";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  aiText: "{}",
}));
function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) => (r[k] ?? null) === v));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "eq" || prop === "is") filters.push([String(args[0]), args[1]]);
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: rows()[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1", email: "u1@x.io" } }, error: null })) },
    from: (t: string) => chain(t),
  },
}));
vi.mock("@/lib/ai/governedCall", () => ({
  governedAiCall: vi.fn(async () => ({ text: state.aiText })),
  GovernedCallError: class extends Error { status = 500; },
}));
vi.mock("@/lib/knowledgePageRender", () => ({
  renderKnowledgePages: vi.fn(async () => [{ page: 1, mediaType: "image/png", base64: "" }]),
}));
vi.mock("@/lib/pdfPageCount", () => ({ countPdfPages: vi.fn(async () => 1) }));

import { POST as readCostDoc } from "@/app/api/projects/cost-docs/route";

const BASE_BID = {
  vendorName: "Gulf Mechanical",
  // The model read the 182,000 alternate as the bottom line…
  total: 182000,
  currency: "USD",
  // …while the priced base-bid lines add up to 1,820,000.
  lineItems: [
    { description: "Demolition", total: 220000 },
    { description: "Repipe — pipefitters", total: 1400000, hours: 14000, headcount: 12 },
    { description: "Hydrotest", total: 200000 },
    { description: "Alternate 1 — insulation (option)", total: null },
  ],
  exclusions: ["Scaffolding"],
};

describe("PR-2 — the bottom line is reconciled against its own priced lines; a mismatch is flagged, never corrected or blocking", () => {
  it("the finding's scenario: 182,000 read as the total of a 1,820,000 base bid is flagged with both numbers — and the total stays as read", () => {
    const q = validateParsedQuote(BASE_BID, "d1");
    expect(q.total).toBe(182000);
    expect(q.totalCheck).toMatchObject({ lineItemsSum: 1820000, difference: -1638000, mismatch: true, pricedLines: 3, unpricedLines: 1 });
    expect(q.totalCheck?.note).toMatch(/1,820,000/);
    expect(q.totalCheck?.note).toMatch(/182,000/);
    expect(q.totalCheck?.note).toMatch(/1 line\(s\) print no price/);
  });

  it("lines that add up (to within rounding) are not a flag; a quote with no priced line has nothing to reconcile", () => {
    const ok = validateParsedQuote({ ...BASE_BID, total: 1820000 }, "d1");
    expect(ok.totalCheck).toMatchObject({ mismatch: false, difference: 0, note: null });
    const rounding = reconcileQuoteTotal(1000.6, [{ description: "a", total: 333.33 }, { description: "b", total: 666.67 }]);
    expect(rounding).toMatchObject({ mismatch: false });
    // 0.5 % of the total, or 1 unit, whichever is larger.
    expect(TOTAL_RECONCILE_TOLERANCE).toEqual({ absolute: 1, relative: 0.005 });
    expect(reconcileQuoteTotal(100000, [{ description: "a", total: 99400 }])).toMatchObject({ mismatch: true, difference: 600 });
    expect(reconcileQuoteTotal(100000, [{ description: "a", total: 99600 }])).toMatchObject({ mismatch: false });
    const unpriced = validateParsedQuote({ ...BASE_BID, lineItems: [{ description: "Lump sum work" }] }, "d1");
    expect(unpriced).not.toHaveProperty("totalCheck");
  });

  it("recomputed from the stored extraction — a stored row and a fresh read agree; a human-corrected total keeps the extraction's flag", () => {
    const fresh = validateParsedQuote(BASE_BID, "d1");
    const stored = validateParsedQuote(JSON.parse(JSON.stringify(fresh)), "d1");
    expect(stored.totalCheck).toEqual(fresh.totalCheck);
    const corrected = withHumanTotal(fresh, 1820000);
    expect(corrected.total).toBe(1820000);
    expect(corrected.extractedTotal).toBe(182000);
    expect(corrected.totalCheck?.mismatch).toBe(true);
  });
});

describe("PR-2 — /api/projects/cost-docs stores the flag on the parsed record and returns it (the route is unchanged)", () => {
  beforeEach(() => {
    state.calls = [];
    state.rows = {
      org_members: [{ org_id: "o1", uid: "u1", role: "DocCtrl", roles: ["DocCtrl"], status: "active" }],
      projects: [{ id: "pr1", org_id: "o1", owner_user_id: "someone-else" }],
      cost_documents: [{ id: "d1", org_id: "o1", project_id: "pr1", kind: "quote", status: "draft", file_url: "orgs/o1/q.pdf", file_name: "q.pdf", mime_type: "application/pdf", vendor_name: null }],
    };
    state.aiText = JSON.stringify(BASE_BID);
  });

  it("the extraction is saved and returned with totalCheck.mismatch — the total is the one read, and the read is not refused", async () => {
    const res = await readCostDoc(new NextRequest("http://x/api/projects/cost-docs", {
      method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ orgId: "o1", projectId: "pr1", costDocId: "d1" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { parsed: { totalCheck?: { mismatch: boolean } } };
    expect(body.parsed.totalCheck?.mismatch).toBe(true);
    const patch = state.calls.find((c) => c.table === "cost_documents" && c.method === "update")!.args[0] as Record<string, unknown>;
    expect(patch.total_amount).toBe(182000);
    expect((patch.parsed as { totalCheck?: { lineItemsSum: number } }).totalCheck?.lineItemsSum).toBe(1820000);
  });
});
