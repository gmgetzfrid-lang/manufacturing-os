// projects Round G — PERF-1 / PERF-11 / REL-1 / UX-9 / COST-12 (registry
// half). The Known Companies gather is ONE batched read per evidence table
// per chunk of ids — the query count does not grow with the registry —
// every read pages past PostgREST's row cap, awards derive from posted
// commitments that are not change-order postings, an unlinked company says
// so, and the pages carry a tri-state load and a separate action-error
// banner.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// A PostgREST double that behaves like the real one where it matters: eq /
// in / is / or(ilike) filters, ORDER BY, range(), the max-rows cap on EVERY
// response (1000 — a query that doesn't page gets the first thousand and
// no more), and a missing column refused with 42703.
const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  missingColumns: {} as Record<string, string[]>,
}));
const MAX_ROWS = 1000;
/** PostgREST or() value grammar: comma-separated `col.op.value`, a value
 *  double-quoted when it carries reserved characters; like/ilike use * as %. */
function orPredicate(expr: string): (r: Record<string, unknown>) => boolean {
  const terms: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quoted && ch === "\\") { cur += ch + expr[++i]; continue; }
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) { terms.push(cur); cur = ""; continue; }
    cur += ch;
  }
  terms.push(cur);
  const preds = terms.map((t) => {
    const [col, op, ...rest] = t.split(".");
    let v = rest.join(".");
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    if (op !== "ilike") throw new Error(`mock: unsupported or() op ${op}`);
    const re = new RegExp(`^${v.split("").map((ch) => (ch === "*" || ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`, "is");
    return (r: Record<string, unknown>) => re.test(String(r[col] ?? ""));
  });
  return (r) => preds.some((p) => p(r));
}
function chain(table: string) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  const orders: Array<{ col: string; asc: boolean }> = [];
  let range: [number, number] | null = null;
  let count = false;
  let refused: string | null = null;
  const matching = () => (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const rows = () => {
    const out = matching();
    for (const o of [...orders].reverse()) {
      out.sort((a, b) => { const x = String(a[o.col] ?? ""), y = String(b[o.col] ?? ""); return (x < y ? -1 : x > y ? 1 : 0) * (o.asc ? 1 : -1); });
    }
    const windowed = range ? out.slice(range[0], range[1] + 1) : out;
    return windowed.slice(0, MAX_ROWS);
  };
  const result = () => (refused
    ? { data: null, error: { code: "42703", message: `column ${table}.${refused} does not exist` }, count: null }
    : { data: rows(), error: null, count: count ? matching().length : null });
  const c: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
      return (...args: unknown[]) => {
        state.calls.push({ table, method: prop, args });
        if (prop === "select") {
          if ((args[1] as { count?: string } | undefined)?.count) count = true;
          const cols = String(args[0] ?? "").split(",").map((x) => x.trim());
          refused = (state.missingColumns[table] ?? []).find((m) => cols.includes(m)) ?? null;
        }
        if (prop === "eq") filters.push((r) => r[String(args[0])] === args[1]);
        if (prop === "in") filters.push((r) => (args[1] as unknown[]).includes(r[String(args[0])]));
        if (prop === "is") filters.push((r) => (r[String(args[0])] ?? null) === args[1]);
        if (prop === "or") filters.push(orPredicate(String(args[0])));
        if (prop === "order") orders.push({ col: String(args[0]), asc: (args[1] as { ascending?: boolean } | undefined)?.ascending !== false });
        if (prop === "range") range = [Number(args[0]), Number(args[1])];
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

beforeEach(() => { state.rows = {}; state.calls = []; state.missingColumns = {}; });

describe("PERF-1 — one batched gather per table, independent of the registry's size", () => {
  it("a full page of companies costs the same query count as one, and even 150 stay far under 200", async () => {
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
    const m50 = await gatherCompanyProfiles(seed(50, 1));   // one registry page (COMPANY_PAGE_SIZE)
    const q50 = fromCalls();
    state.calls = [];
    const many = seed(150, 1);
    const m150 = await gatherCompanyProfiles(many);
    const q150 = fromCalls();
    expect(m1.size).toBe(1);
    expect(m50.size).toBe(50);
    expect(m150.size).toBe(150);
    expect(q1).toBe(11);              // one query per table per chunk of ids
    expect(q50).toBe(q1);             // a whole page: the same eleven
    // 150 names split the milestone name filter into bounded slices (request-line size),
    // two more queries — never one per company.
    expect(q150).toBe(13);
    // 300 party ids = two chunks: the party-keyed tables run twice, nothing runs per company.
    state.calls = [];
    const m300 = await gatherCompanyProfiles(seed(150, 2));
    const q300 = fromCalls();
    expect(q300).toBe(18);
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
    // Every approved CO posts its own party-tagged commitment (decideChangeOrder), exactly as in production.
    state.rows.cost_entries = [
      { id: "e1", party_id: "p1", amount: 400_000, reference: "Q-100", entry_type: "commitment", status: "posted" },
      { id: "e2", party_id: "p1", amount: 100_000, reference: "Q-101", entry_type: "commitment", status: "posted" },
      { id: "e3", party_id: "p1", amount: 125_000, reference: "CO-001", entry_type: "commitment", status: "posted" },
      { id: "e4", party_id: "p1", amount: 20_000, reference: "CO-002", entry_type: "commitment", status: "posted" },
    ];
    // owner_request growth of 25% must NOT count against them; a scope_gap does.
    state.rows.change_orders = [
      { id: "co1", project_id: "proj1", party_id: "p1", co_number: "CO-001", title: "owner add", amount: 125_000, reason_code: "owner_request", status: "approved", posted_entry_id: "e3" },
      { id: "co2", project_id: "proj1", party_id: "p1", co_number: "CO-002", title: "field", amount: 20_000, reason_code: "field_condition", status: "approved", posted_entry_id: "e4" },
    ];
    const p = await gatherCompanyProfile(company(0));
    expect(p.awardsSource).toBe("entries");
    const cost = p.scorecard.dimensions.find((d) => d.key === "cost")!;
    expect(cost.score).toBe(100);
    expect(cost.detail).toContain("finished on their bid");
    // 125k over an award base of 500k — the CO's own commitment is not in the base.
    expect(cost.detail).toContain("1 owner-driven CO (25% growth on our side");
    expect(cost.detail).toContain("1 field-condition/other CO not scored");

    // Only CO postings on the party: no award has posted, so the typed value is the (labelled) fallback.
    state.rows.cost_entries = [
      { id: "e3", party_id: "p1", amount: 125_000, reference: "CO-001", entry_type: "commitment", status: "posted" },
    ];
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

describe("COST-12 / COST-7 — change-order money is growth over the award, never part of its base", () => {
  it("award $500k + an approved $125k scope_gap CO reads 25% growth — linked by posted_entry_id or, where that link was never written, by the CO number on the entry", async () => {
    state.rows.project_parties = [{ id: "p1", project_id: "proj1", company_id: "c0", trade: null, contract_value: null }];
    state.rows.projects = [{ id: "proj1", name: "Job" }];
    state.rows.cost_entries = [
      { id: "e1", party_id: "p1", amount: 500_000, reference: "RFQ-7", entry_type: "commitment", status: "posted" },
      { id: "e2", party_id: "p1", amount: 125_000, reference: "CO-003", entry_type: "commitment", status: "posted" },
    ];
    state.rows.change_orders = [
      { id: "co3", project_id: "proj1", party_id: "p1", co_number: "CO-003", title: "missed insulation", amount: 125_000, reason_code: "scope_gap", status: "approved", posted_entry_id: "e2" },
    ];
    const linked = (await gatherCompanyProfile(company(0))).scorecard.dimensions.find((d) => d.key === "cost")!;
    expect(linked.detail).toMatch(/^25% cost growth over bid/);

    // The best-effort link write failed: the entry is still recognised as the CO's by its reference.
    state.rows.change_orders = [{ ...state.rows.change_orders[0], posted_entry_id: null }];
    const unlinked = (await gatherCompanyProfile(company(0))).scorecard.dimensions.find((d) => d.key === "cost")!;
    expect(unlinked.detail).toMatch(/^25% cost growth over bid/);
    expect(unlinked.score).toBe(linked.score);
  });
});

describe("PERF-1 — every batched read pages past PostgREST's 1000-row cap", () => {
  it("50 companies × 3 parties × 50 turnover items (7,500 rows) — every card keeps its own count", async () => {
    const companies = Array.from({ length: 50 }, (_, i) => company(i));
    state.rows.project_parties = companies.flatMap((c, i) => [0, 1, 2].map((k) => ({ id: `p${i}-${k}`, project_id: `proj${i}`, company_id: c.id, trade: null, contract_value: null })));
    state.rows.projects = companies.map((_, i) => ({ id: `proj${i}`, name: `Job ${i}` }));
    state.rows.turnover_items = state.rows.project_parties.flatMap((p) => Array.from({ length: 50 }, (_, j) => ({
      id: `${String(p.id)}-t${String(j).padStart(2, "0")}`, party_id: p.id, status: j < 40 ? "accepted" : "rejected",
    })));
    expect(state.rows.turnover_items).toHaveLength(7500);
    const m = await gatherCompanyProfiles(companies);
    for (const c of companies) {
      expect(m.get(c.id)!.scorecard.dimensions.find((d) => d.key === "quality")!.detail).toBe("turnover 120/150 accepted");
    }
    // Paged in stable windows: ORDER BY id, range(0, 999), range(1000, 1999), …
    const turnoverRanges = state.calls.filter((c) => c.table === "turnover_items" && c.method === "range").map((c) => c.args);
    expect(turnoverRanges).toContainEqual([7000, 7999]);
    expect(state.calls.some((c) => c.table === "turnover_items" && c.method === "order" && c.args[0] === "id")).toBe(true);
  });

  it("milestones are filtered by the company's name IN THE DATABASE and paged: a 2,500-activity schedule keeps all 1,200 of theirs", async () => {
    const gulf = company(0, { name: "Gulf Mechanical, Inc." });
    state.rows.project_parties = [{ id: "p1", project_id: "proj1", company_id: gulf.id, trade: null, contract_value: null }];
    state.rows.projects = [{ id: "proj1", name: "Unit 300" }];
    state.rows.milestones = Array.from({ length: 2500 }, (_, i) => ({
      id: `m${String(i).padStart(5, "0")}`, project_id: "proj1",
      // The schedule importer writes one row per activity; theirs are the LAST 1,200.
      responsible_party: i < 1300 ? (i % 2 ? "Bayline Scaffold" : "Gulf Mechanical") : "  gulf mechanical, inc. ",
      status: "completed", planned_at: "2026-01-10", actual_at: i % 3 === 0 ? "2026-01-20" : "2026-01-09",
    }));
    const p = await gatherCompanyProfile(gulf);
    const schedule = p.scorecard.dimensions.find((d) => d.key === "schedule")!;
    expect(schedule.detail).toBe("800/1200 milestones on time");
    const msOr = state.calls.find((c) => c.table === "milestones" && c.method === "or")!;
    // The comma in the name is quoted so it stays one value; "Gulf Mechanical" (another row's text) is not theirs.
    expect(msOr.args[0]).toBe('responsible_party.ilike."*Gulf Mechanical, Inc.*"');
  });

  it("pre-20261096 (no cost_documents.company_id yet): the bid history still reads through the party", async () => {
    state.missingColumns = { cost_documents: ["company_id"] };
    state.rows.project_parties = [{ id: "p1", project_id: "proj1", company_id: "c0", trade: null, contract_value: null }];
    state.rows.projects = [{ id: "proj1", name: "Job" }];
    state.rows.cost_documents = [
      { id: "d1", project_id: "proj1", party_id: "p1", rfq_group: "G", total_amount: 10, status: "awarded", doc_date: null, kind: "quote" },
      { id: "d2", project_id: "proj1", party_id: "p1", rfq_group: "H", total_amount: 12, status: "declined", doc_date: null, kind: "quote" },
    ];
    const p = await gatherCompanyProfile(company(0));
    expect(p.bids).toHaveLength(2);
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
