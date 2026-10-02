// projects Round G — COST-13 / COST-8 (route limb) / COST-3 dw3 on the
// document-reading routes: the true page count and the pages actually read
// land on the row, travel in the response and the audit row, and a currency
// is stored only as a known ISO-4217 code.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  updateErrorsOnce: null as null | { code: string; message: string },
  aiText: "{}",
  pagesTotal: null as number | null,
  images: 8,
}));
function chain(table: string) {
  const filters: Array<[string, unknown]> = [];
  const inFilters: Array<[string, unknown[]]> = [];
  let isUpdate = false;
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every(([k, v]) => (r[k] ?? null) === v) && inFilters.every(([k, vs]) => vs.includes(r[k])));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => {
        if (isUpdate && state.updateErrorsOnce) { const e = state.updateErrorsOnce; state.updateErrorsOnce = null; return resolve({ data: null, error: e }); }
        return resolve({ data: rows(), error: null });
      };
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "update") isUpdate = true;
        if (prop === "eq" || prop === "is") filters.push([String(args[0]), args[1]]);
        if (prop === "in") inFilters.push([String(args[0]), args[1] as unknown[]]);
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: rows()[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    auth: { getUser: vi.fn(async () => state.user ? { data: { user: state.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (t: string) => chain(t),
  },
}));
const ai = vi.hoisted(() => ({ duringCall: null as null | (() => void) }));
vi.mock("@/lib/ai/governedCall", () => ({
  governedAiCall: vi.fn(async () => { ai.duringCall?.(); return { text: state.aiText }; }),
  GovernedCallError: class extends Error { status = 500; },
}));
vi.mock("@/lib/knowledgePageRender", () => ({
  renderKnowledgePages: vi.fn(async (_k: string, pages: number[], max: number) =>
    pages.slice(0, Math.min(max, state.images)).map((page) => ({ page, mediaType: "image/png", base64: "" }))),
}));
vi.mock("@/lib/pdfPageCount", () => ({ countPdfPages: vi.fn(async () => state.pagesTotal) }));
// PERF-6 (J12): the route's deadline, pulled in by a test to stand for a
// slow render / a slow model.
const dl = vi.hoisted(() => ({ leftMs: null as number | null }));
vi.mock("@/lib/routeDeadline", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/routeDeadline")>();
  return { ...real, routeDeadline: (s: number) => (dl.leftMs == null ? real.routeDeadline(s) : Date.now() + dl.leftMs) };
});
vi.mock("@/lib/docFileServer", () => ({ resolveDocumentFile: vi.fn(async () => ({ ok: true, file: { documentId: "doc1", fileKey: "orgs/o1/manual.pdf", label: "QM-1" } })) }));

import { POST as readCostDoc } from "@/app/api/projects/cost-docs/route";
import { governedAiCall } from "@/lib/ai/governedCall";
import { renderKnowledgePages } from "@/lib/knowledgePageRender";
import { tooLargeToReadMessage } from "@/lib/routeDeadline";
import { validateParsedInvoice, closedProjectReadMessage, INVOICE_MAX_LINES } from "@/lib/costDocParse";
import { barredCompanyFor } from "@/lib/bidTab";
import { POST as evaluateManual } from "@/app/api/companies/quality-manual/route";

const post = (fn: (req: NextRequest) => Promise<Response>, url: string, body: unknown) => fn(new NextRequest(url, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const updatePatch = () => state.calls.filter((c) => c.table === "cost_documents" && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const auditDetails = () => (state.calls.find((c) => c.table === "audit_logs" && c.method === "insert")!.args[0] as { details: Record<string, unknown> }).details;

beforeEach(() => {
  state.user = { id: "u1", email: "u1@x.io" }; state.calls = []; state.updateErrorsOnce = null; state.images = 8; state.pagesTotal = 14;
  ai.duringCall = null;
  dl.leftMs = null;
  vi.mocked(governedAiCall).mockClear();
  vi.mocked(renderKnowledgePages).mockClear();
  state.rows = {
    org_members: [{ org_id: "o1", uid: "u1", role: "DocCtrl", roles: ["DocCtrl"], status: "active" }],
    projects: [{ id: "pr1", org_id: "o1", owner_user_id: "someone-else" }],
    cost_documents: [{ id: "d1", org_id: "o1", project_id: "pr1", kind: "quote", status: "draft", file_url: "orgs/o1/q.pdf", file_name: "q.pdf", mime_type: "application/pdf", vendor_name: null }],
    companies: [{ id: "c1", org_id: "o1", name: "Gulf Mechanical" }],
  };
  state.aiText = JSON.stringify({ vendorName: "Gulf Mechanical, Inc.", total: 182000, currency: "eur", validUntil: "2026-10-01", lineItems: [{ description: "Repipe", total: 182000, hours: 1800 }], exclusions: [], notes: "Includes weekend premium" });
});

describe("POST /api/projects/cost-docs — read extent is recorded, returned and audited (COST-13)", () => {
  it("writes pages_total and pages_read on the row, returns both, and the audit row carries the pair with a truncated flag", async () => {
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagesRead).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(body.pagesTotal).toBe(14);
    const [patch] = updatePatch();
    expect(patch.pages_total).toBe(14);
    expect(patch.pages_read).toBe(8);
    expect(patch.total_amount).toBe(182000);
    // validUntil / notes persist in the stored extraction (BID-11 lib half).
    expect((patch.parsed as { validUntil: string; notes: string }).validUntil).toBe("2026-10-01");
    expect((patch.parsed as { validUntil: string; notes: string }).notes).toBe("Includes weekend premium");
    const d = auditDetails();
    expect(d.pagesTotal).toBe(14);
    expect(d.pagesRead).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(d.truncated).toBe(true);
  });

  it("an unknown page count is stored as NULL (never 'complete'), and a short document reads as not truncated", async () => {
    state.pagesTotal = null;
    await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(updatePatch()[0].pages_total).toBeNull();
    expect(auditDetails().truncated).toBeNull();
    state.calls = []; state.pagesTotal = 3; state.images = 3;
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect((await res.json()).pagesTotal).toBe(3);
    expect(updatePatch()[0].pages_read).toBe(3);
    expect(auditDetails().truncated).toBe(false);
  });

  it("pre-migration (columns absent) the extent still travels in the response and audit; the row write retries without it", async () => {
    state.updateErrorsOnce = { code: "42703", message: 'column "pages_total" does not exist' };
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(200);
    const patches = updatePatch();
    expect(patches).toHaveLength(2);
    expect(patches[1]).not.toHaveProperty("pages_total");
    expect(patches[1]).not.toHaveProperty("pages_read");
    expect(auditDetails().pagesTotal).toBe(14);
  });
});

describe("POST /api/projects/cost-docs — a read that finishes after a decision changes nothing (MON-3 / COST-13)", () => {
  const updateChain = () => {
    const i = state.calls.findIndex((c) => c.table === "cost_documents" && c.method === "update");
    return state.calls.slice(i, i + 6).map((c) => [c.method, ...c.args]);
  };

  it("the save carries the same status predicate as the check, scoped to the org, and reads back the row", async () => {
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(200);
    const chain = updateChain();
    expect(chain).toContainEqual(["eq", "id", "d1"]);
    expect(chain).toContainEqual(["eq", "org_id", "o1"]);
    expect(chain).toContainEqual(["eq", "status", "draft"]);
    // …and the total it started from (none yet on a fresh draft).
    expect(chain).toContainEqual(["is", "total_amount", null]);
    expect(chain).toContainEqual(["select", "id"]);
  });

  it("a total typed by hand while the model read the document is kept: 409, nothing overwritten, nothing audited", async () => {
    // "type total" on the still-open draft: total_amount is written and the document moves to parsed — still open.
    ai.duringCall = () => { Object.assign(state.rows.cost_documents[0], { total_amount: 162_000, status: "parsed" }); };
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/or its total typed by hand, while it was being read — nothing was changed/);
    expect(updateChain()).toContainEqual(["is", "total_amount", null]);
    expect(state.rows.cost_documents[0].total_amount).toBe(162_000);
    expect(state.calls.some((c) => c.table === "audit_logs")).toBe(false);
  });

  it("a Read from a stale table on a document someone has since totalled by hand never replaces the typed total — the extraction lands beside it (COST-15)", async () => {
    // User B typed a total on the draft (it is now parsed, with no extraction); user A's table still shows it unread.
    Object.assign(state.rows.cost_documents[0], { status: "parsed", total_amount: 162_000, parsed: null });
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(200);
    const [patch] = updatePatch();
    expect(patch).not.toHaveProperty("total_amount");
    expect(patch).not.toHaveProperty("status");
    expect((patch.parsed as { total: number }).total).toBe(182_000);
    expect(state.rows.cost_documents[0].total_amount).toBe(162_000);
  });

  it("a parsed document that already carries an extraction is refused before the model runs", async () => {
    Object.assign(state.rows.cost_documents[0], { status: "parsed", total_amount: 182_000, parsed: { total: 182_000, lineItems: [] } });
    let modelCalled = false;
    ai.duringCall = () => { modelCalled = true; };
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already been read — nothing was changed/);
    expect(modelCalled).toBe(false);
    expect(updatePatch()).toHaveLength(0);
    expect(state.calls.some((c) => c.table === "audit_logs")).toBe(false);
  });

  it("a draft that already carries a total saves only while that total is unchanged — the predicate is the total the read started from", async () => {
    Object.assign(state.rows.cost_documents[0], { total_amount: 150_000 });
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(200);
    expect(updateChain()).toContainEqual(["eq", "total_amount", 150_000]);
    // A total changed during the read without the status moving is kept too.
    state.calls = [];
    ai.duringCall = () => { state.rows.cost_documents[0].total_amount = 162_000; };
    expect((await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" })).status).toBe(409);
  });

  it("the quote was typed, awarded and posted while the model read it: 409, the row is not reopened, nothing is audited", async () => {
    ai.duringCall = () => { state.rows.cost_documents[0].status = "awarded"; };
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/decided, or its total typed by hand, while it was being read — nothing was changed/);
    expect(state.calls.some((c) => c.table === "audit_logs")).toBe(false);
  });

  it("the pre-migration retry carries the predicate too — a decided invoice is not re-posted by a late read", async () => {
    state.rows.cost_documents[0].kind = "invoice";
    state.aiText = JSON.stringify({ vendorName: "X", total: 4100, currency: "USD", docNumber: "INV-1" });
    state.updateErrorsOnce = { code: "42703", message: 'column "pages_total" does not exist' };
    ai.duringCall = () => { state.rows.cost_documents[0].status = "posted"; };
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(409);
    const statusPredicates = state.calls.filter((c) => c.table === "cost_documents" && c.method === "eq" && c.args[0] === "status").map((c) => c.args);
    expect(statusPredicates).toEqual([["status", "draft"], ["status", "draft"]]);
    expect(state.calls.some((c) => c.table === "audit_logs")).toBe(false);
  });
});

describe("POST /api/projects/cost-docs — currency is a known ISO code or NULL (COST-8 route limb)", () => {
  it("stores 'eur' as EUR and free text as NULL, in both the column and the stored extraction", async () => {
    await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(updatePatch()[0].currency).toBe("EUR");
    expect((updatePatch()[0].parsed as { currency: string }).currency).toBe("EUR");
    state.calls = [];
    state.aiText = JSON.stringify({ vendorName: "X", total: 5000, currency: "dollars", lineItems: [], exclusions: [] });
    await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(updatePatch()[0].currency).toBeNull();
    expect((updatePatch()[0].parsed as { currency: string | null }).currency).toBeNull();
    // Invoices too.
    state.calls = [];
    state.rows.cost_documents[0].kind = "invoice";
    state.aiText = JSON.stringify({ vendorName: "X", total: 4100, currency: "US$", docNumber: "INV-1" });
    await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(updatePatch()[0].currency).toBeNull();
    expect(updatePatch()[0].doc_number).toBe("INV-1");
  });
});

describe("POST /api/companies/quality-manual — the proposal carries how much was read (COST-3 dw3)", () => {
  it("returns pagesRead, pagesTotal and a truncated flag beside the score", async () => {
    state.pagesTotal = 62; state.images = 10;
    state.aiText = JSON.stringify({ findings: [{ area: "doc_control", covered: true, finding: "Section 4" }, { area: "welding", covered: false, finding: "none" }] });
    const res = await post(evaluateManual, "http://x/api/companies/quality-manual", { orgId: "o1", companyId: "c1", documentId: "doc1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagesRead).toHaveLength(10);
    expect(body.pagesTotal).toBe(62);
    expect(body.truncated).toBe(true);
    expect(typeof body.score).toBe("number");
  });
});

describe("POST /api/projects/cost-docs — a total typed before any read can still have its line items read (COST-15)", () => {
  const typed = () => Object.assign(state.rows.cost_documents[0], { status: "parsed", total_amount: 175_000, currency: "USD", parsed: null });
  const updateChain = () => {
    const i = state.calls.findIndex((c) => c.table === "cost_documents" && c.method === "update");
    return state.calls.slice(i, i + 7).map((c) => [c.method, ...c.args]);
  };

  it("reads a parsed row with no extraction and saves the extraction BESIDE the typed total — total, currency and status untouched", async () => {
    typed();
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ totalKept: 175_000, extractedTotal: 182_000 });
    const [patch] = updatePatch();
    expect(Object.keys(patch).sort()).toEqual(["pages_read", "pages_total", "parsed", "vendor_name"]);
    const parsed = patch.parsed as { total: number; lineItems: Array<{ hours: number }> };
    expect(parsed.total).toBe(182_000);
    expect(parsed.lineItems[0].hours).toBe(1800);
    // The typed total survives the read.
    expect(state.rows.cost_documents[0].total_amount).toBe(175_000);
    expect(state.rows.cost_documents[0].status).toBe("parsed");
    const d = auditDetails();
    expect(d).toMatchObject({ besideTypedTotal: true, total: 175_000, totalKept: 175_000, extractedTotal: 182_000 });
  });

  it("the save's predicate is the state the read started from: still parsed, still no extraction, the same total", async () => {
    typed();
    await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    const chain = updateChain();
    expect(chain).toContainEqual(["eq", "status", "parsed"]);
    expect(chain).toContainEqual(["is", "parsed", null]);
    expect(chain).toContainEqual(["eq", "total_amount", 175_000]);
    expect(chain).not.toContainEqual(["eq", "status", "draft"]);
  });

  it("awarded, corrected or read by someone else while the model read it: 409, nothing written over, nothing audited", async () => {
    for (const meanwhile of [
      { status: "awarded" },
      { total_amount: 171_000 },
      { parsed: { total: 182_000, lineItems: [] } },
    ]) {
      state.calls = [];
      typed();
      ai.duringCall = () => { Object.assign(state.rows.cost_documents[0], meanwhile); };
      const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
      expect(res.status, JSON.stringify(meanwhile)).toBe(409);
      expect((await res.json()).error).toMatch(/decided, read, or its total changed while it was being read — nothing was changed/);
      expect(state.calls.some((c) => c.table === "audit_logs")).toBe(false);
    }
  });

  it("an invoice whose amount was typed: the read lands beside it — never its amount, number or date", async () => {
    state.rows.cost_documents[0].kind = "invoice";
    Object.assign(state.rows.cost_documents[0], { status: "parsed", total_amount: 4_000, parsed: null, doc_number: null });
    state.aiText = JSON.stringify({ vendorName: "X", total: 4100, currency: "USD", docNumber: "INV-1", docDate: "2026-09-01" });
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(200);
    const [patch] = updatePatch();
    for (const k of ["total_amount", "currency", "doc_number", "doc_date", "status"]) expect(patch, k).not.toHaveProperty(k);
    expect((patch.parsed as { total: number }).total).toBe(4100);
  });

  it("a declined, void, awarded or posted document is still not readable", async () => {
    for (const status of ["declined", "void", "awarded", "posted"]) {
      state.calls = [];
      Object.assign(state.rows.cost_documents[0], { status, total_amount: 1, parsed: null });
      const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
      expect(res.status, status).toBe(409);
      expect(updatePatch(), status).toHaveLength(0);
    }
  });

  it("the Costs tab offers Read on a parsed row with no extraction — in the bid table and the invoice list", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/projects/cost/QuotesPanel.tsx", "utf8");
    expect(src).toMatch(/function typedTotalUnread\(doc: CostDocument\): boolean \{\n\s+return doc\.status === "parsed" && doc\.parsed == null;/);
    expect(src.match(/typedTotalUnread\(doc\) && \(\s*(<div className="mt-0\.5">)?<ReadButton busy=\{busy === doc\.id\} onClick=\{\(\) => void readDoc\(doc\)\} \/>/g)).toHaveLength(2);
  });
});

// ── projects Round G J12 ────────────────────────────────────────────────────
const read = () => post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });

describe("PM-1 — a closed project's documents are not read", () => {
  for (const status of ["completed", "cancelled", "archived"]) {
    it(`${status}: 409 with the sentence, before the file is rendered and before the caller's key is spent`, async () => {
      state.rows.projects[0].status = status;
      const res = await read();
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(closedProjectReadMessage(status));
      expect(renderKnowledgePages).not.toHaveBeenCalled();
      expect(governedAiCall).not.toHaveBeenCalled();
      expect(updatePatch()).toHaveLength(0);
    });
  }
  it("an active or paused project reads as before", async () => {
    for (const status of ["active", "paused"]) {
      state.rows.projects[0].status = status; state.calls = [];
      expect((await read()).status).toBe(200);
    }
    expect(closedProjectReadMessage("completed")).toBe("This project is completed — its cost records are read-only, so nothing is read into them. An Admin / Document Control can reopen it.");
  });
});

describe("PERF-6 — the read answers inside the function's own limit, with a readable 504", () => {
  it("the model's budget is what is left of the deadline, capped at 90 s", async () => {
    expect((await read()).status).toBe(200);
    const opts = vi.mocked(governedAiCall).mock.calls[0][0] as { timeoutMs: number };
    expect(opts.timeoutMs).toBe(90_000);
    dl.leftMs = 40_000; vi.mocked(governedAiCall).mockClear(); state.calls = [];
    expect((await read()).status).toBe(200);
    const tight = (vi.mocked(governedAiCall).mock.calls[0][0] as { timeoutMs: number }).timeoutMs;
    expect(tight).toBeLessThanOrEqual(40_000);
    expect(tight).toBeGreaterThan(30_000);
  });
  it("a render that cannot finish before the deadline is a 504 naming the page cap — the model is never called", async () => {
    dl.leftMs = 30;
    vi.mocked(renderKnowledgePages).mockImplementationOnce(() => new Promise(() => undefined));
    const res = await read();
    expect(res.status).toBe(504);
    expect((await res.json()).error).toBe(tooLargeToReadMessage(8));
    expect(governedAiCall).not.toHaveBeenCalled();
    expect(updatePatch()).toHaveLength(0);
  });
  it("too little time left for the model after the render: 504 before the key is spent", async () => {
    dl.leftMs = 5_000;
    const res = await read();
    expect(res.status).toBe(504);
    expect((await res.json()).error).toMatch(/too large to read in time — try fewer pages/);
    expect(governedAiCall).not.toHaveBeenCalled();
  });
  it("a model call that times out is a 504 with the same sentence, never a bare 502", async () => {
    vi.mocked(governedAiCall).mockRejectedValueOnce(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    const res = await read();
    expect(res.status).toBe(504);
    expect((await res.json()).error).toBe(tooLargeToReadMessage(8));
    expect(updatePatch()).toHaveLength(0);
  });
  it("a page count that never answers is UNKNOWN (null) after its own short budget — never a refusal, and the model keeps its time", async () => {
    const { countPdfPages } = await import("@/lib/pdfPageCount");
    vi.mocked(countPdfPages).mockImplementationOnce(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const p = read();
      await vi.advanceTimersByTimeAsync(10_001);
      const res = await p;
      expect(res.status).toBe(200);
      expect((await res.json()).pagesTotal).toBeNull();
      expect(auditDetails().truncated).toBeNull();
      // 105 s of route time minus the 10 s the count was given: the 90 s cap still holds
      expect((vi.mocked(governedAiCall).mock.calls[0][0] as { timeoutMs: number }).timeoutMs).toBe(90_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PR-2 criterion 3 — the invoice's extraction is validated before it is stored", () => {
  beforeEach(() => { state.rows.cost_documents[0].kind = "invoice"; });
  it("only the schema's fields are stored, typed and bounded; a non-calendar date and junk keys are dropped", async () => {
    state.aiText = JSON.stringify({
      vendorName: "  Gulf Mechanical  ", docNumber: "INV-1042", docDate: "2026-02-30", total: 41250, currency: "usd",
      lineItems: [{ description: "Repipe", total: 41250, sneaky: "x" }, "junk", { description: "", total: null }],
      injected: "<script>", total_amount: 1,
    });
    const res = await read();
    expect(res.status).toBe(200);
    const [patch] = updatePatch();
    expect(patch.parsed).toEqual({
      vendorName: "Gulf Mechanical", docNumber: "INV-1042", docDate: null, total: 41250, currency: "USD",
      lineItems: [{ description: "Repipe", total: 41250 }],
    });
    expect(patch.total_amount).toBe(41250);
    expect(patch).not.toHaveProperty("doc_date");
    expect(patch.doc_number).toBe("INV-1042");
    expect(patch.vendor_name).toBe("Gulf Mechanical");
  });
  it("an amount due that is not a positive number (a string, zero, missing) is a 422 and nothing is stored", async () => {
    for (const total of ["41250", 0, -5, null]) {
      state.calls = [];
      state.aiText = JSON.stringify({ vendorName: "X", total });
      const res = await read();
      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe("Couldn't read an amount due from the invoice.");
      expect(updatePatch()).toHaveLength(0);
    }
  });
  it("validateParsedInvoice caps the billed lines and the free text", () => {
    const v = validateParsedInvoice({ total: 10, vendorName: "v".repeat(500), docNumber: "n".repeat(100), docDate: "2026-02-28",
      lineItems: Array.from({ length: 500 }, (_, i) => ({ description: `L${i}`, total: 1 })) });
    expect(v.lineItems).toHaveLength(INVOICE_MAX_LINES);
    expect(v.vendorName).toHaveLength(200);
    expect(v.docNumber).toHaveLength(60);
    expect(v.docDate).toBe("2026-02-28");
    expect(() => validateParsedInvoice("not an object")).toThrow(/amount due/);
    expect(() => validateParsedInvoice({ total: Number.POSITIVE_INFINITY })).toThrow(/amount due/);
  });
});

describe("COST-3 done-when 2 (DEC-48, J12 line) — a read never links the quote to a Known Company (review fix 2)", () => {
  const linkWrites = () => updatePatch().filter((p) => "company_id" in p);
  beforeEach(() => { Object.assign(state.rows.cost_documents[0], { company_id: null, vendor_name: "Gulf Mechanical", party_id: null }); });

  it("a name that could be only ONE Known Company is not linked, and the registry is not read; a look-alike added later still flags the bid", async () => {
    const res = await read();
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("companyLinked");
    expect(linkWrites()).toHaveLength(0);
    expect(state.calls.some((c) => c.table === "companies")).toBe(false);
    expect(auditDetails()).not.toHaveProperty("companyLinked");
    expect(state.rows.cost_documents[0].company_id).toBeNull();
    // The do-not-use look-alike an admin adds afterwards: the bid tab's gate
    // reads the row's link (none), so the name's candidates flag the bid.
    const registry = [
      { id: "c1", name: "Gulf Mechanical", status: "active" },
      { id: "dnu", name: "Gulf Mechanical, Inc.", status: "do_not_use" },
    ];
    expect(barredCompanyFor("Gulf Mechanical", (state.rows.cost_documents[0].company_id as string | null) ?? null, registry)?.id).toBe("dnu");
  });
  it("no letterhead, row or contractor shape links: normalised, the model's own name, a contractor named or not", async () => {
    for (const over of [
      { vendor_name: "Gulf Mechanical, Inc." },
      { vendor_name: null },                                // the model's "Gulf Mechanical, Inc." fills vendor_name
      { vendor_name: "Gulf Mechanical", party_id: "pp1" },
    ]) {
      state.calls = []; Object.assign(state.rows.cost_documents[0], over);
      state.rows.project_parties = [{ id: "pp1", company_id: null }];
      const res = await read();
      expect(res.status).toBe(200);
      expect(linkWrites()).toHaveLength(0);
      expect(state.calls.some((c) => c.table === "companies")).toBe(false);
    }
  });
});
