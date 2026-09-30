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
vi.mock("@/lib/docFileServer", () => ({ resolveDocumentFile: vi.fn(async () => ({ ok: true, file: { documentId: "doc1", fileKey: "orgs/o1/manual.pdf", label: "QM-1" } })) }));

import { POST as readCostDoc } from "@/app/api/projects/cost-docs/route";
import { POST as evaluateManual } from "@/app/api/companies/quality-manual/route";

const post = (fn: (req: NextRequest) => Promise<Response>, url: string, body: unknown) => fn(new NextRequest(url, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const updatePatch = () => state.calls.filter((c) => c.table === "cost_documents" && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
const auditDetails = () => (state.calls.find((c) => c.table === "audit_logs" && c.method === "insert")!.args[0] as { details: Record<string, unknown> }).details;

beforeEach(() => {
  state.user = { id: "u1", email: "u1@x.io" }; state.calls = []; state.updateErrorsOnce = null; state.images = 8; state.pagesTotal = 14;
  ai.duringCall = null;
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

  it("a Read from a stale table on a document someone has since totalled by hand is refused before the model runs — the typed total stands", async () => {
    // User B typed a total on the draft (it is now parsed, with no extraction); user A's table still shows it unread.
    Object.assign(state.rows.cost_documents[0], { status: "parsed", total_amount: 162_000, parsed: null });
    let modelCalled = false;
    ai.duringCall = () => { modelCalled = true; };
    const res = await post(readCostDoc, "http://x/api/projects/cost-docs", { orgId: "o1", projectId: "pr1", costDocId: "d1" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already been read, or its total typed by hand — nothing was changed/);
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
