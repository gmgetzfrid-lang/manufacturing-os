// @vitest-environment jsdom
//
// projects Round G — the bid table as RENDERED (MON-12 UI half, BID-7,
// COST-3 dw3): Award is withheld while the registry or the bidder links
// are loading or failed (a missing do-not-use flag must never read as
// "clear"); a bid with no printed currency is shown in the field's
// currency and says so; a quality-manual percentage from a partial read
// carries its read extent.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const db = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: null | { code?: string; message: string } }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  single: {} as Record<string, unknown>,
}));
const reg = vi.hoisted(() => ({ listCompanies: vi.fn(), getCompany: vi.fn() }));
const dlg = vi.hoisted(() => ({ appPrompt: vi.fn(), appConfirm: vi.fn(), appAlert: vi.fn() }));
const cd = vi.hoisted(() => ({ awardQuote: vi.fn() }));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    let single = false;
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const res = single ? { data: db.single[table] ?? null, error: null } : db.results[table] ?? { data: [], error: null };
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => {
          if (prop === "insert") db.inserts.push({ table, row: args[0] as Record<string, unknown> });
          if (prop === "maybeSingle") single = true;
          return new Proxy({}, h);
        };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/components/providers/DialogProvider", () => dlg);
vi.mock("@/lib/costDocs", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/costDocs")>()), ...cd }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/companies", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/companies")>()), ...reg }));

import { renderToStaticMarkup } from "react-dom/server";
import QuotesPanel from "@/components/projects/cost/QuotesPanel";
import type { CostDocument } from "@/lib/costDocs";
import type { Company } from "@/lib/companies";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = (over: Partial<CostDocument>): CostDocument => ({
  id: "d", orgId: "o1", projectId: "p1", partyId: null, kind: "quote", fileUrl: "k", fileName: "q.pdf", mimeType: "application/pdf",
  docNumber: null, docDate: null, vendorName: null, currency: null, totalAmount: null, status: "parsed", parsed: null,
  rfqGroup: "Unit 300 Repipe", intakeLinkId: null, postedAt: null, createdAt: null, ...over,
});
const docs: CostDocument[] = [
  doc({ id: "apex", vendorName: "Apex Industrial, Inc.", currency: "EUR", totalAmount: 150_000,
    parsed: { vendorName: "Apex Industrial, Inc.", total: 150_000, currency: "EUR", lineItems: [{ description: "Repipe exchanger circuits", total: 150_000, hours: 1500 }], exclusions: [] } }),
  doc({ id: "bay", vendorName: "Bayline", currency: null, totalAmount: 140_000,
    parsed: { vendorName: "Bayline", total: 140_000, currency: null, lineItems: [{ description: "Repipe exchanger circuits", total: 140_000, hours: 1500 }], exclusions: [] } }),
];
const apex: Company = {
  id: "c-apex", orgId: "o1", name: "Apex Industrial", kind: "contractor", trade: null, status: "do_not_use",
  contactName: null, contactEmail: null, contactPhone: null, qualityManualDocId: null, qualityManualScore: 38,
  qualityManualGaps: null, qualityManualReviewedAt: null, qualityManualPagesRead: 10, qualityManualPagesTotal: 62,
  notes: null, createdAt: null,
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  reg.listCompanies.mockReset(); reg.getCompany.mockReset();
  for (const f of [...Object.values(dlg), cd.awardQuote]) f.mockReset();
  db.inserts = []; db.single = {};
  db.results = {
    cost_documents: { data: docs.map((d) => ({ id: d.id, company_id: null, pages_total: 3, pages_read: 3 })), error: null },
    project_parties: { data: [], error: null },
  };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

let errors: Array<string | null> = [];
const render = async (list: CostDocument[] = docs, accountCurrency = "EUR") => {
  errors = [];
  await act(async () => {
    root.render(React.createElement(QuotesPanel, {
      orgId: "o1", projectId: "p1", canManage: true, actor: { uid: "u1", email: "u1@example.com" },
      accounts: [{ id: "a1", projectId: "p1", code: null, name: "Piping", costType: null, budget: 1, currency: accountCurrency, partyId: null, wbsMilestoneId: null, status: "active" }],
      docs: list, onChanged: () => undefined, setErr: (m: string | null) => { errors.push(m); },
    }));
  });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const awardButtons = () => [...host.querySelectorAll("button")].filter((b) => /Award/.test(b.textContent ?? ""));

describe("MON-12 — Award never runs ahead of the do-not-use check", () => {
  it("registry failed to load: Award is withheld on every row and the table says why", async () => {
    reg.listCompanies.mockRejectedValue(new Error("timeout"));
    await render();
    expect(awardButtons()).toHaveLength(0);
    expect(host.textContent).toMatch(/registry unavailable — reload to award/);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Award is withheld/);
  });

  it("the bidder-link read failed (not a pending migration): Award is withheld too", async () => {
    reg.listCompanies.mockResolvedValue([apex]);
    db.results.cost_documents = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    await render();
    expect(awardButtons()).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/bidder-to-company links couldn't be loaded/);
  });

  it("before migration 20261096 (link columns absent) the links read as none and Award is offered", async () => {
    reg.listCompanies.mockResolvedValue([]);
    db.results.cost_documents = { data: null, error: { code: "42703", message: "column cost_documents.company_id does not exist" } };
    await render();
    expect(awardButtons()).toHaveLength(2);
  });

  it("both loaded: Award is offered, and the barred match is flagged beside its price with its quality-manual read extent", async () => {
    reg.listCompanies.mockResolvedValue([apex]);
    await render();
    expect(awardButtons()).toHaveLength(2);
    expect(host.textContent).toMatch(/matched to Apex Industrial · QM 38% \(read pages 1–10 of 62\)/);
    expect(host.textContent).toMatch(/do not use/);
  });
});

describe("BID-7 — a bid with no printed currency beside a euro bid", () => {
  it("is shown in euros and marked as assumed, never as dollars", async () => {
    reg.listCompanies.mockResolvedValue([]);
    await render();
    const rows = [...host.querySelectorAll("tbody tr")];
    const bay = rows.find((r) => /Bayline/.test(r.textContent ?? ""))!;
    expect(bay.textContent).toMatch(/€140,000/);
    expect(bay.textContent).not.toMatch(/\$140,000/);
    expect(bay.textContent).toMatch(/currency not printed — assumed EUR/);
  });
});

const awardOn = async (vendor: RegExp) => {
  const row = [...host.querySelectorAll("tbody tr")].find((r) => vendor.test(r.textContent ?? ""))!;
  const btn = [...row.querySelectorAll("button")].find((b) => /Award/.test(b.textContent ?? ""))!;
  await act(async () => { btn.click(); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const auditActions = () => db.inserts.filter((i) => i.table === "audit_logs").map((i) => i.row.action);

describe("MON-12 — the do-not-use override at award time", () => {
  it("re-reads the registry at the click: a company barred AFTER the table loaded still needs the override", async () => {
    reg.listCompanies.mockResolvedValueOnce([{ ...apex, status: "active" }]);   // what the table rendered from
    reg.listCompanies.mockResolvedValue([apex]);                                // the registry now
    dlg.appPrompt.mockResolvedValue(null);                                      // no reason given
    await render();
    await awardOn(/Apex/);
    expect(dlg.appPrompt).toHaveBeenCalledTimes(1);
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toMatch(/DO NOT USE/);
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
    expect(errors.at(-1)).toMatch(/no override reason was given/);
  });

  it("the override row is written only once every confirmation passed — cancelling the confirm leaves no override on the record", async () => {
    reg.listCompanies.mockResolvedValue([apex]);
    dlg.appPrompt.mockResolvedValue("Sole qualified bidder for the outage window");
    dlg.appConfirm.mockResolvedValue(false);
    await render();
    await awardOn(/Apex/);
    expect(dlg.appConfirm).toHaveBeenCalledTimes(1);
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
  });

  it("an award that fails after the override was recorded closes it with an abandonment row", async () => {
    reg.listCompanies.mockResolvedValue([apex]);
    dlg.appPrompt.mockResolvedValue("Sole qualified bidder");
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: false, error: "Someone else just decided this document — refresh to see the latest." });
    await render();
    await awardOn(/Apex/);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_OVERRIDE_DO_NOT_USE", "COST_DOC_AWARD_OVERRIDE_ABANDONED"]);
    expect(db.inserts[0].row.details).toMatchObject({ companyId: "c-apex", reason: "Sole qualified bidder" });
    expect(errors.at(-1)).toMatch(/Someone else just decided/);
  });

  it("an explicit link re-read from the row outranks the name match", async () => {
    reg.listCompanies.mockResolvedValue([]);                                    // no name match at all
    db.single.cost_documents = { company_id: "c-apex" };
    reg.getCompany.mockResolvedValue(apex);
    dlg.appPrompt.mockResolvedValue(null);
    await render();
    await awardOn(/Bayline/);
    expect(reg.getCompany).toHaveBeenCalledWith("c-apex");
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toMatch(/Apex Industrial is flagged DO NOT USE/);
    expect(cd.awardQuote).not.toHaveBeenCalled();
  });
});

describe("BID-10 / BID-7 / COST-13 at award time", () => {
  it("hands the award every case variant of the merged field under one spelling", async () => {
    reg.listCompanies.mockResolvedValue([]);
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: true });
    const variant = doc({ id: "var", vendorName: "Coastal", currency: "EUR", totalAmount: 160_000, rfqGroup: "unit 300  repipe",
      parsed: { vendorName: "Coastal", total: 160_000, currency: "EUR", lineItems: [{ description: "Repipe exchanger circuits", total: 160_000, hours: 1500 }], exclusions: [] } });
    db.results.cost_documents = { data: [...docs, variant].map((d) => ({ id: d.id, company_id: null, pages_total: 3, pages_read: 3 })), error: null };
    await render([...docs, variant]);
    await awardOn(/Bayline/);
    const siblings = cd.awardQuote.mock.calls[0][0].siblings as CostDocument[];
    expect(siblings.find((d) => d.id === "var")!.rfqGroup).toBe("Unit 300 Repipe");
  });

  it("a mixed field awards only a bid already in the budget line's currency", async () => {
    reg.listCompanies.mockResolvedValue([]);
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: true });
    const usd = doc({ id: "usd", vendorName: "Delta", currency: "USD", totalAmount: 170_000,
      parsed: { vendorName: "Delta", total: 170_000, currency: "USD", lineItems: [{ description: "Repipe exchanger circuits", total: 170_000, hours: 1500 }], exclusions: [] } });
    const mixed = [docs[0], usd];
    db.results.cost_documents = { data: mixed.map((d) => ({ id: d.id, company_id: null, pages_total: 3, pages_read: 3 })), error: null };
    await render(mixed, "USD");
    await awardOn(/Apex/);                          // EUR bid, USD budget line: refused with the remedy
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(errors.at(-1)).toMatch(/Restate this EUR bid in USD with "correct total" \(e\.g\. 162000 USD\)/);
    await awardOn(/Delta/);                         // USD bid: awardable
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    expect(cd.awardQuote.mock.calls[0][0].doc.id).toBe("usd");
  });

  it("a truncated read asks for the total FROM THE PAPER — the prompt never prints the figure it expects", async () => {
    reg.listCompanies.mockResolvedValue([]);
    db.results.cost_documents = { data: docs.map((d) => ({ id: d.id, company_id: null, pages_total: 14, pages_read: 8 })), error: null };
    dlg.appPrompt.mockResolvedValue("140000");
    cd.awardQuote.mockResolvedValue({ ok: true });
    await render();
    await awardOn(/Bayline/);
    const opts = dlg.appPrompt.mock.calls[0][0] as { title: string; message: React.ReactNode; placeholder: string };
    const text = renderToStaticMarkup(React.createElement(React.Fragment, null, opts.message));
    expect(text).toMatch(/read pages 1–8 of 14/);
    expect(`${opts.title} ${text} ${opts.placeholder}`).not.toMatch(/140[,.]?000/);
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);   // the typed figure matched the row
  });
});
