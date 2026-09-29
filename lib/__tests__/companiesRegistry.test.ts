// projects Round G — PERF-1 / PERF-11 / REL-1 / UX-9 / COST-12 (registry
// half). The Known Companies gather is ONE batched read per evidence table
// per chunk of ids — the query count does not grow with the registry —
// awards derive from posted commitments, an unlinked company says so, and
// the pages carry a tri-state load and a separate action-error banner.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));
function chain(table: string) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  let count = false;
  const rows = () => (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null, count: count ? rows().length : null });
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select" && (args[1] as { count?: string } | undefined)?.count) count = true;
        if (prop === "eq") filters.push((r) => r[String(args[0])] === args[1]);
        if (prop === "in") filters.push((r) => (args[1] as unknown[]).includes(r[String(args[0])]));
        if (prop === "maybeSingle" || prop === "single") return Promise.resolve({ data: rows()[0] ?? null, error: null });
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));

import { gatherCompanyProfiles, gatherCompanyProfile, listCompaniesPage, type Company } from "@/lib/companies";

const company = (i: number, over: Partial<Company> = {}): Company => ({
  id: `c${i}`, orgId: "o1", name: `Company ${i}`, kind: "contractor", trade: null, status: "active",
  contactName: null, contactEmail: null, contactPhone: null, qualityManualDocId: null, qualityManualScore: null,
  qualityManualGaps: null, qualityManualReviewedAt: null, qualityManualPagesRead: null, qualityManualPagesTotal: null,
  notes: null, createdAt: null, ...over,
});
const fromCalls = () => state.calls.filter((c) => c.method === "select").length;

beforeEach(() => { state.rows = {}; state.calls = []; });

describe("PERF-1 — one batched gather per table, independent of the registry's size", () => {
  it("150 companies with linked parties cost the same query count as one, and far under 200", async () => {
    const seed = (n: number, partiesEach: 1 | 2) => {
      state.rows = {};
      const companies = Array.from({ length: n }, (_, i) => company(i));
      state.rows.project_parties = companies.flatMap((c, i) => [
        { id: `p${i}a`, project_id: `proj${i % 7}`, company_id: c.id, trade: "piping", contract_value: null },
        ...(partiesEach === 2 ? [{ id: `p${i}b`, project_id: `proj${(i + 1) % 7}`, company_id: c.id, trade: null, contract_value: null }] : []),
      ]);
      state.rows.projects = Array.from({ length: 7 }, (_, i) => ({ id: `proj${i}`, name: `Project ${i}` }));
      state.rows.change_orders = companies.map((_, i) => ({ project_id: `proj${i % 7}`, party_id: `p${i}a`, co_number: "CO-001", title: "x", amount: 1000, reason_code: "scope_gap", status: "approved" }));
      state.rows.cost_entries = companies.map((_, i) => ({ party_id: `p${i}a`, amount: 50_000, entry_type: "commitment", status: "posted" }));
      return companies;
    };
    const one = seed(1, 1);
    const m1 = await gatherCompanyProfiles(one);
    const q1 = fromCalls();
    state.calls = [];
    const many = seed(150, 1);
    const m150 = await gatherCompanyProfiles(many);
    const q150 = fromCalls();
    expect(m1.size).toBe(1);
    expect(m150.size).toBe(150);
    expect(q1).toBe(q150);            // one query per table per chunk of ids — 150 ids is one chunk
    expect(q150).toBe(11);
    // 300 party ids = two chunks: the party-keyed tables run twice, nothing runs per company.
    state.calls = [];
    const m300 = await gatherCompanyProfiles(seed(150, 2));
    const q300 = fromCalls();
    expect(q300).toBe(16);
    expect(q300).toBeLessThan(200);   // PERF-1 done-when, with room to spare
    // Every company got its own evidence back out of the batch.
    for (let i = 0; i < 150; i++) {
      const p = m300.get(`c${i}`)!;
      expect(p.partiesLinked).toBe(2);
      expect(p.changeOrders).toHaveLength(1);
      expect(p.projects.map((x) => x.projectName).sort()).toEqual([`Project ${i % 7}`, `Project ${(i + 1) % 7}`].sort());
    }
  });

  it("the gather never issues a per-company query: no filter on a single company_id when many are asked", async () => {
    state.rows.project_parties = [];
    await gatherCompanyProfiles(Array.from({ length: 40 }, (_, i) => company(i)));
    const singleCompanyEq = state.calls.filter((c) => c.method === "eq" && c.args[0] === "company_id");
    expect(singleCompanyEq).toHaveLength(0);
    const batchedIn = state.calls.filter((c) => c.method === "in" && c.args[0] === "company_id");
    expect(batchedIn.length).toBeGreaterThan(0);
    for (const call of batchedIn) expect((call.args[1] as string[]).length).toBe(40);
  });
});

describe("COST-12 / COST-7 — awards, attribution and the unlinked state", () => {
  it("awardsTotal derives from posted commitment entries; contract_value is only a labelled fallback", async () => {
    state.rows.project_parties = [{ id: "p1", project_id: "proj1", company_id: "c0", trade: null, contract_value: 999_999 }];
    state.rows.projects = [{ id: "proj1", name: "Job" }];
    state.rows.cost_entries = [
      { party_id: "p1", amount: 400_000, entry_type: "commitment", status: "posted" },
      { party_id: "p1", amount: 100_000, entry_type: "commitment", status: "posted" },
    ];
    // owner_request growth of 25% must NOT count against them; a scope_gap does.
    state.rows.change_orders = [
      { project_id: "proj1", party_id: "p1", co_number: "CO-001", title: "owner add", amount: 125_000, reason_code: "owner_request", status: "approved" },
      { project_id: "proj1", party_id: "p1", co_number: "CO-002", title: "field", amount: 20_000, reason_code: "field_condition", status: "approved" },
    ];
    const p = await gatherCompanyProfile(company(0));
    expect(p.awardsSource).toBe("entries");
    const cost = p.scorecard.dimensions.find((d) => d.key === "cost")!;
    expect(cost.score).toBe(100);
    expect(cost.detail).toContain("finished on their bid");
    expect(cost.detail).toContain("1 owner-driven CO");
    expect(cost.detail).toContain("1 field-condition/other CO not scored");

    state.rows.cost_entries = [];
    const q = await gatherCompanyProfile(company(0));
    expect(q.awardsSource).toBe("contract_value");
    expect(q.scorecard.dimensions.find((d) => d.key === "cost")!.detail).toContain("awards from the typed contract value");
  });

  it("an unlinked company reports 'unlinked', distinct from a linked company with no work", async () => {
    state.rows.project_parties = [{ id: "p1", project_id: "proj1", company_id: "c1", trade: null, contract_value: null }];
    state.rows.projects = [{ id: "proj1", name: "Job" }];
    const m = await gatherCompanyProfiles([company(0), company(1)]);
    expect(m.get("c0")!.partiesLinked).toBe(0);
    expect(m.get("c0")!.scorecard.dimensions.find((d) => d.key === "cost")!.detail).toMatch(/Unlinked/);
    expect(m.get("c1")!.partiesLinked).toBe(1);
    expect(m.get("c1")!.scorecard.dimensions.find((d) => d.key === "cost")!.detail).toBe("No awarded work yet");
    // Zero rows never invent a score.
    expect(m.get("c0")!.scorecard.composite).toBeNull();
  });

  it("quotes reach a company through the explicit company_id link OR its party, without double counting", async () => {
    state.rows.project_parties = [{ id: "p1", project_id: "proj1", company_id: "c0", trade: null, contract_value: null }];
    state.rows.projects = [{ id: "proj1", name: "Job" }];
    state.rows.cost_documents = [
      { id: "d1", project_id: "proj1", party_id: "p1", company_id: "c0", rfq_group: "G", total_amount: 10, status: "awarded", doc_date: null, kind: "quote" },
      { id: "d2", project_id: "proj1", party_id: null, company_id: "c0", rfq_group: "G", total_amount: 12, status: "declined", doc_date: null, kind: "quote" },
      { id: "d3", project_id: "proj1", party_id: "p1", company_id: null, rfq_group: "G", total_amount: 14, status: "declined", doc_date: null, kind: "quote" },
    ];
    const p = await gatherCompanyProfile(company(0));
    expect(p.bids).toHaveLength(3);
    expect(p.bids.filter((b) => b.won)).toHaveLength(1);
  });
});

describe("PERF-1 — server-side page and search", () => {
  it("asks the database for one page, sorted, with kind and ILIKE filters and a sanitised term", async () => {
    state.rows.companies = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, org_id: "o1", name: `N${i}`, kind: "vendor" }));
    const res = await listCompaniesPage("o1", { search: "gulf, (mech)", kind: "vendor", page: 2 });
    expect(res.pageSize).toBe(50);
    expect(res.page).toBe(2);
    expect(state.calls.find((c) => c.method === "range")!.args).toEqual([100, 149]);
    expect(state.calls.find((c) => c.method === "order")!.args[0]).toBe("name");
    expect(state.calls.find((c) => c.method === "eq" && c.args[0] === "kind")!.args[1]).toBe("vendor");
    expect(state.calls.find((c) => c.method === "or")!.args[0]).toBe("name.ilike.%gulf mech%,trade.ilike.%gulf mech%");
    expect(state.calls.find((c) => c.method === "select")!.args[1]).toEqual({ count: "exact" });
  });
});

describe("REL-1 / UX-9 / A11Y-9 — the pages (source pins)", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const list = src("app/(protected)/companies/page.tsx");
  const detail = src("app/(protected)/companies/[id]/page.tsx");

  it("null org renders an actionable error with retry, not a spinner: tri-state load, no boolean early return", () => {
    expect(list).toMatch(/useState<"loading" \| "ready" \| "failed">/);
    expect(list).toMatch(/const orgUnresolved = !activeOrgId && !roleLoading/);
    expect(list).toMatch(/Couldn't determine your organization/);
    expect(list).toMatch(/Retry/);
    expect(list).not.toMatch(/if \(!activeOrgId\) return;\n\s*setError\(null\);/);
    // No per-company gather loop remains; the page uses the batched gather and a cancel flag.
    expect(list).not.toMatch(/gatherCompanyProfile\(c\)/);
    expect(list).toMatch(/gatherCompanyProfiles\(res\.rows\)/);
    expect(list).toMatch(/const ctl = \{ cancelled: false \};[\s\S]*return \(\) => \{ ctl\.cancelled = true; \};/);
    expect(list).toMatch(/if \(!ctl\.cancelled\) setProfiles\(gathered\)/);
    expect(list).not.toMatch(/localStorage|sessionStorage|profileCache/); // GAP-409: no client cache
  });

  it("/companies has its own in-shell loading skeleton and error boundary", () => {
    expect(existsSync(join(process.cwd(), "app/(protected)/companies/loading.tsx"))).toBe(true);
    expect(existsSync(join(process.cwd(), "app/(protected)/companies/error.tsx"))).toBe(true);
    expect(src("app/(protected)/companies/error.tsx")).toMatch(/reset\(\)/);
  });

  it("a failed action renders as a dismissible banner and leaves the company page mounted", () => {
    expect(detail).toMatch(/const \[actionError, setActionError\]/);
    // Only a LOAD error unmounts the record; both panels report through the action channel.
    expect(detail).toMatch(/if \(error \|\| !company\) return \(/);
    expect(detail).not.toMatch(/if \(error \|\| actionError \|\| !company\)/);
    expect((detail.match(/setErr=\{setActionError\}/g) ?? []).length).toBe(2);
    expect(detail).not.toMatch(/setErr=\{setError\}/);
    expect(detail).toMatch(/aria-label="Dismiss"/);
  });

  it("A11Y-9: dimension rows carry no fixed width below sm: and the cards clip overflow", () => {
    for (const page of [list, detail]) {
      expect(page).not.toMatch(/className="w-24 shrink-0 font-bold/);
      expect(page).not.toMatch(/className="w-28 shrink-0 font-bold/);
      expect(page).toMatch(/w-full sm:w-(24|28) shrink-0 font-bold/);
      expect(page).toMatch(/flex-1 sm:flex-none sm:w-(24|32) min-w-10 rounded-full/);
    }
    expect(list).toMatch(/min-w-0 overflow-hidden bg-\[var\(--color-surface\)\] rounded-2xl/);
    expect(detail).toMatch(/shadow-sm min-w-0 overflow-hidden/);
  });
});
