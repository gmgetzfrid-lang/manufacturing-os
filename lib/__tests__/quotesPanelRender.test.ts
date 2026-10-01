// @vitest-environment jsdom
//
// projects Round G — the bid table as RENDERED (MON-12 UI half, BID-7,
// COST-3 dw3): Award is withheld while the registry or the bidder links
// are loading or failed (a missing do-not-use flag must never read as
// "clear"); the flag survives two registry rows that normalise alike and a
// registry larger than the name list's cap; a bid with no printed currency
// is shown in the field's currency and says so; a quality-manual
// percentage from a partial read carries its read extent.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const db = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: null | { code?: string; message: string } }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  single: {} as Record<string, unknown>,
}));
const reg = vi.hoisted(() => ({ listCompanies: vi.fn(), listBarredCompanies: vi.fn(), getCompany: vi.fn() }));
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
          db.calls.push({ table, method: prop, args });
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
  reg.listCompanies.mockReset(); reg.getCompany.mockReset(); reg.listBarredCompanies.mockReset();
  reg.listBarredCompanies.mockResolvedValue([]);
  for (const f of [...Object.values(dlg), cd.awardQuote]) f.mockReset();
  db.inserts = []; db.calls = []; db.single = {};
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
    reg.listBarredCompanies.mockResolvedValue([apex]);
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
    reg.listCompanies.mockResolvedValue([{ ...apex, status: "active" }]);       // what the table rendered from
    reg.listBarredCompanies.mockResolvedValueOnce([]);                          // nothing barred when it loaded
    reg.listBarredCompanies.mockResolvedValue([apex]);                          // the registry now
    dlg.appPrompt.mockResolvedValue(null);                                      // no reason given
    await render();
    expect(host.textContent).not.toMatch(/do not use/);
    await awardOn(/Apex/);
    expect(dlg.appPrompt).toHaveBeenCalledTimes(1);
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toMatch(/DO NOT USE/);
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
    expect(errors.at(-1)).toMatch(/no override reason was given/);
  });

  it("the override row is written only once every confirmation passed — cancelling the confirm leaves no override on the record", async () => {
    reg.listCompanies.mockResolvedValue([apex]);
    reg.listBarredCompanies.mockResolvedValue([apex]);
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
    reg.listBarredCompanies.mockResolvedValue([apex]);
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
    // Integration (J3 x J4): the typed figure itself reaches the lib as
    // confirmedTotal — the lib's truncated-read refusal needs it.
    expect(cd.awardQuote.mock.calls[0][0].confirmedTotal).toBe(140000);
  });

  it("the override reason reaches the lib with the award (J3 x J4: the lib refuses a flagged company without it)", async () => {
    reg.listCompanies.mockResolvedValue([apex]);
    reg.listBarredCompanies.mockResolvedValue([apex]);
    dlg.appPrompt.mockResolvedValue("Sole qualified bidder");
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: true });
    await render();
    await awardOn(/Apex/);
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    expect(cd.awardQuote.mock.calls[0][0].overrideReason).toBe("Sole qualified bidder");
    expect(auditActions()).toEqual(["COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
  });

  it("a flag the lib finds and the table did not (an inactive company) asks for a reason, records the intent, and retries with it", async () => {
    reg.listCompanies.mockResolvedValue([]);
    dlg.appConfirm.mockResolvedValue(true);
    dlg.appPrompt.mockResolvedValue("Reactivated vendor, paperwork pending");
    cd.awardQuote
      .mockResolvedValueOnce({ ok: false, error: "Bayline is marked inactive in the company registry.", needsOverride: { companyId: "c-bay", companyName: "Bayline", status: "inactive" } })
      .mockResolvedValueOnce({ ok: true });
    await render();
    await awardOn(/Bayline/);
    expect(cd.awardQuote).toHaveBeenCalledTimes(2);
    expect(cd.awardQuote.mock.calls[0][0].overrideReason ?? null).toBeNull();
    expect(cd.awardQuote.mock.calls[1][0].overrideReason).toBe("Reactivated vendor, paperwork pending");
    expect(String(dlg.appPrompt.mock.calls.at(-1)![0].title)).toMatch(/Bayline is marked INACTIVE/);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(db.inserts[0].row.details).toMatchObject({ companyId: "c-bay", companyStatus: "inactive", reason: "Reactivated vendor, paperwork pending" });
  });

  it("no reason for a lib-found flag stops the award and records nothing", async () => {
    reg.listCompanies.mockResolvedValue([]);
    dlg.appConfirm.mockResolvedValue(true);
    dlg.appPrompt.mockResolvedValue(null);
    cd.awardQuote.mockResolvedValueOnce({ ok: false, error: "flagged", needsOverride: { companyId: "c-bay", companyName: "Bayline", status: "inactive" } });
    await render();
    await awardOn(/Bayline/);
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    expect(auditActions()).toEqual([]);
    expect(errors.at(-1)).toMatch(/no override reason was given/);
  });
});

const company = (id: string, name: string, status: Company["status"] = "active"): Company => ({ ...apex, id, name, status, qualityManualScore: null });
const rowOf = (vendor: RegExp) => [...host.querySelectorAll("tbody tr")].find((r) => vendor.test(r.textContent ?? ""))!;

describe("BID-12 / MON-12 regression — two registry rows that normalise alike", () => {
  it("an exact-name bid from the barred company keeps its flag and its award gate beside a same-normalised sibling", async () => {
    const barred = company("c-barred", "Apex Industrial, Inc.", "do_not_use");
    const sibling = company("c-sib", "Apex Industrial");
    reg.listCompanies.mockResolvedValue([barred, sibling]);
    reg.listBarredCompanies.mockResolvedValue([barred]);
    dlg.appPrompt.mockResolvedValue(null);
    await render();
    const row = rowOf(/Apex/);
    expect(row.textContent).toMatch(/matched to Apex Industrial, Inc\./);   // exact name binds
    expect(row.textContent).toMatch(/do not use/);
    await awardOn(/Apex/);
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toMatch(/Apex Industrial, Inc\. is flagged DO NOT USE/);
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
  });

  it("a variant that could be either row binds to neither, says so, and still prompts for the override", async () => {
    const barred = company("c-barred", "Apex Industrial Inc", "do_not_use");
    const sibling = company("c-sib", "Apex Industrial");
    reg.listCompanies.mockResolvedValue([barred, sibling]);
    reg.listBarredCompanies.mockResolvedValue([barred]);
    dlg.appPrompt.mockResolvedValue("Only bidder with the certified welders");
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: true });
    await render();
    const row = rowOf(/Apex/);
    expect(row.textContent).not.toMatch(/matched to/);
    expect(row.textContent).toMatch(/ambiguous — link to registry/);
    expect(row.textContent).toMatch(/do not use\? · Apex Industrial Inc/);
    await awardOn(/Apex/);
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toMatch(/Apex Industrial Inc is flagged DO NOT USE/);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(db.inserts[0].row.details).toMatchObject({ companyId: "c-barred", reason: "Only bidder with the certified welders" });
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
  });
});

describe("MON-12 — a registry larger than the name list's cap keeps its flags", () => {
  it("the barred company sorts past the first thousand names: the chip and the award gate read the full barred list", async () => {
    const filler = Array.from({ length: 1000 }, (_, i) => company(`f${i}`, `AAA Filler ${String(i).padStart(4, "0")}`));
    reg.listCompanies.mockResolvedValue(filler);                // capped: Apex is not in it
    reg.listBarredCompanies.mockResolvedValue([apex]);          // read in full, server-side
    dlg.appPrompt.mockResolvedValue(null);
    await render();
    expect(rowOf(/Apex/).textContent).toMatch(/do not use/);
    await awardOn(/Apex/);
    expect(reg.listBarredCompanies).toHaveBeenCalledTimes(2);   // the table's read and the click's re-read
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toMatch(/DO NOT USE/);
    expect(cd.awardQuote).not.toHaveBeenCalled();
  });

  it("a failed barred-list read withholds Award like a failed registry read", async () => {
    reg.listCompanies.mockResolvedValue([]);
    reg.listBarredCompanies.mockRejectedValue(new Error("timeout"));
    await render();
    expect(awardButtons()).toHaveLength(0);
    expect(host.textContent).toMatch(/registry unavailable — reload to award/);
  });
});

describe("BID-12 / COST-12 — a decided bid's company link does not move", () => {
  it("no picker on an awarded or declined row; an open row's link write carries the status predicate", async () => {
    const other = company("c-other", "Bayline Scaffold");
    reg.listCompanies.mockResolvedValue([other]);
    const list = [{ ...docs[0], status: "awarded" as const }, docs[1]];
    await render(list);
    expect(rowOf(/Apex/).textContent).not.toMatch(/link to registry|change/);
    const bay = rowOf(/Bayline/);
    const linkBtn = [...bay.querySelectorAll("button")].find((b) => /link to registry/.test(b.textContent ?? ""))!;
    await act(async () => { linkBtn.click(); });
    const select = rowOf(/Bayline/).querySelector("select")!;
    await act(async () => {
      select.value = "c-other";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const upd = db.calls.findIndex((c) => c.table === "cost_documents" && c.method === "update" && (c.args[0] as Record<string, unknown>).company_id === "c-other");
    expect(upd).toBeGreaterThanOrEqual(0);
    const after = db.calls.slice(upd, upd + 5);
    expect(after).toContainEqual({ table: "cost_documents", method: "in", args: ["status", ["draft", "parsed"]] });
    expect(after).toContainEqual({ table: "cost_documents", method: "select", args: ["id"] });
    expect(auditActions()).toEqual(["COST_DOC_COMPANY_LINKED"]);
  });
});

describe("COST-13 / BID-12 — the link and extent read covers exactly the rendered documents", () => {
  it("reads by the documents' own ids, never an arbitrary .limit()", async () => {
    reg.listCompanies.mockResolvedValue([]);
    await render();
    const read = db.calls.filter((c) => c.table === "cost_documents" && c.method === "in" && c.args[0] === "id");
    expect(read).toHaveLength(1);
    expect(read[0].args[1]).toEqual(["apex", "bay"]);
    expect(db.calls.some((c) => c.table === "cost_documents" && c.method === "limit")).toBe(false);
  });
});

describe("BID-7 — a field where no bid prints a currency", () => {
  it("says the prices are only shown as USD, and refuses to award into a line kept in another currency", async () => {
    reg.listCompanies.mockResolvedValue([]);
    dlg.appConfirm.mockResolvedValue(true);
    const bare = docs.map((d) => ({ ...d, currency: null, parsed: { ...(d.parsed as Record<string, unknown>), currency: null } }));
    await render(bare, "EUR");
    expect(rowOf(/Bayline/).textContent).toMatch(/currency not printed — shown as USD/);
    await awardOn(/Bayline/);
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(errors.at(-1)).toMatch(/currency isn't printed and "Piping" is kept in EUR/);
  });
});

describe("COST-5 dw3 / BID-9 — what the row says, and what a typed total may be", () => {
  const hoursDoc = (id: string, vendorName: string, total: number, hours: number, currency: string | null) => doc({
    id, vendorName, currency, totalAmount: total,
    parsed: { vendorName, total, currency, lineItems: [{ description: "Repipe exchanger circuits", total, hours }], exclusions: [] },
  });

  it("implausible hours are marked on the row — only the out-of-line bid's, once three bids state hours", async () => {
    reg.listCompanies.mockResolvedValue([]);
    // Amended (verification of 2026-09-30): two statements are no longer judged — this field has three in line and one far out.
    await render([...docs, hoursDoc("coastal", "Coastal", 160_000, 1600, "EUR"), hoursDoc("delta", "Delta", 145_000, 2, "EUR")]);
    expect(rowOf(/Delta/).textContent).toMatch(/implausible hours — check/);
    for (const v of [/Apex/, /Bayline/, /Coastal/]) expect(rowOf(v).textContent).not.toMatch(/implausible/);
    expect(host.textContent).toMatch(/flagged and scored as not stated/);
  });

  it("two bids stating hours: neither row is marked, and the value score says it is price alone", async () => {
    reg.listCompanies.mockResolvedValue([]);
    const oneHour = [docs[0], { ...docs[1], parsed: { ...(docs[1].parsed as Record<string, unknown>), lineItems: [{ description: "Repipe exchanger circuits", total: 140_000, hours: 1 }] } }];
    await render(oneHour);
    expect(host.textContent).not.toMatch(/implausible/);
    expect(host.textContent).toMatch(/Value score = price alone/);
    expect(host.textContent).toMatch(/nobody's manpower is scored/);
  });

  it("BID-8: a field scored on price alone scores and badges a typed-total bid like any other — the cheapest ranks first", async () => {
    reg.listCompanies.mockResolvedValue([]);
    const typed = doc({ id: "typed", vendorName: "Scanned Co", currency: "EUR", totalAmount: 90_000, parsed: null });
    await render([typed, hoursDoc("p100", "Parsed Hundred", 100_000, 0, "EUR"), hoursDoc("p110", "Parsed Tenten", 110_000, 0, "EUR")]);
    const t = rowOf(/Scanned Co/);
    expect(t.textContent).toMatch(/typed total — price only/);
    expect(t.textContent).toMatch(/best value/);
    expect(t.querySelector("td:nth-child(7)")?.textContent).toBe("100");
    expect(rowOf(/Parsed Hundred/).textContent).not.toMatch(/best value/);
    expect(rowOf(/Parsed Hundred/).querySelector("td:nth-child(7)")?.textContent).toBe("90");
    expect(host.textContent).toMatch(/On price alone the cheapest bid ranks first/);
    expect(host.textContent).toMatch(/every bid — typed totals included — is scored on price/);
  });

  it("BID-8: a field that scores manpower keeps a typed-total bid 'price only — not scored on manpower', with no badge", async () => {
    reg.listCompanies.mockResolvedValue([]);
    const typed = doc({ id: "typed", vendorName: "Scanned Co", currency: "EUR", totalAmount: 90_000, parsed: null });
    await render([typed, docs[0], hoursDoc("coastal", "Coastal", 160_000, 1600, "EUR"), hoursDoc("delta", "Delta", 155_000, 1550, "EUR")]);
    const t = rowOf(/Scanned Co/);
    expect(t.textContent).not.toMatch(/best value/);
    const cell = t.querySelector("td:nth-child(7) span");
    expect(cell?.textContent).toBe("not scored");
    expect(cell?.getAttribute("title")).toMatch(/^Price only — not scored on manpower/);
    expect(rowOf(/Apex/).textContent).toMatch(/best value/);
    expect(host.textContent).toMatch(/typed-total bid \(price only\) has no hours, so it is not scored on manpower/);
  });

  it("a mixed-currency field marks no row, however far one currency's figures sit from another's", async () => {
    reg.listCompanies.mockResolvedValue([]);
    await render([docs[0], hoursDoc("bay", "Bayline", 140_000, 1500, "USD"), hoursDoc("coastal", "Coastal", 160_000, 1600, "USD"), hoursDoc("delta", "Delta", 145_000, 2, "USD")]);
    expect(host.textContent).not.toMatch(/implausible/);
    expect(host.textContent).toMatch(/This field mixes currencies, so no bid is scored or ranked/);
  });

  it("a figure that could be read two ways is refused — nothing is written", async () => {
    reg.listCompanies.mockResolvedValue([]);
    dlg.appPrompt.mockResolvedValue("162.000 EUR");
    await render();
    const btn = [...rowOf(/Bayline/).querySelectorAll("button")].find((b) => /correct total/.test(b.textContent ?? ""))!;
    await act(async () => { btn.click(); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(errors.at(-1)).toMatch(/^Nothing was saved — "162\.000" can be read two ways/);
    expect(db.calls.some((c) => c.table === "cost_documents" && c.method === "update")).toBe(false);
  });
});

// projects Round G (J11) — projects-and-cost COST-15 (fix pass): a read saved
// BESIDE a total typed before any read leaves the row's currency as the
// person left it. The bid table must not re-denominate the typed figure in
// the currency the AI read.
describe("COST-15 — a read beside a typed total never re-denominates the typed figure", () => {
  const usd = (id: string, vendorName: string, total: number) => doc({
    id, vendorName, currency: "USD", totalAmount: total,
    parsed: { vendorName, total, currency: "USD", lineItems: [{ description: "Repipe exchanger circuits", total, hours: 1500 }], exclusions: [] },
  });
  const typedThenRead = doc({
    id: "typed", vendorName: "Scanned Co", currency: null, totalAmount: 150_000,
    parsed: { vendorName: "Scanned Co", total: 148_000, currency: "EUR", lineItems: [{ description: "Repipe exchanger circuits", total: 148_000, hours: 1500 }], exclusions: [] },
  });
  it("the typed figure's currency stays unknown, as before the read and as posting sees it — never the read's euro; the field is not mixed by it", async () => {
    reg.listCompanies.mockResolvedValue([]);
    await render([usd("alpha", "Alpha Piping", 140_000), usd("beta", "Beta Mechanical", 160_000), typedThenRead], "USD");
    const row = [...host.querySelectorAll("tbody tr")].find((r) => /Scanned Co/.test(r.textContent ?? ""))!;
    expect(row.textContent).not.toMatch(/€150,000/);
    expect(row.textContent).toMatch(/\$150,000/);
    expect(row.textContent).toMatch(/currency not printed — assumed USD/);
    expect(host.textContent).not.toMatch(/This field mixes currencies/);
  });
  it("a row whose currency WAS set keeps it (an ordinary read, a restated correction) — unchanged", async () => {
    reg.listCompanies.mockResolvedValue([]);
    await render([usd("alpha", "Alpha Piping", 140_000), usd("beta", "Beta Mechanical", 160_000), { ...typedThenRead, currency: "EUR" }], "USD");
    const row = [...host.querySelectorAll("tbody tr")].find((r) => /Scanned Co/.test(r.textContent ?? ""))!;
    expect(row.textContent).toMatch(/€150,000/);
    expect(host.textContent).toMatch(/This field mixes currencies/);
  });
});

// projects Round G (J11) — projects-tab SEC-19 (fix pass 2): an EXPIRED quote
// link answers "This link has expired." — a re-issued address or an RFQ
// built on it would send the vendor to a dead door. The row offers no RFQ,
// Copy link or Re-issue (the Intake tab's gate); a live link still does.
describe("SEC-19 — an expired quote link offers no Re-issue, RFQ or Copy link", () => {
  const linkRow = (id: string, company: string, expiresAt: string) => ({
    id, token_prefix: id.slice(0, 6), company_name: company, rfq_group: "Unit 300 Repipe", revoked_at: null,
    expires_at: expiresAt, submission_count: 0, purpose: "quote",
  });
  it("the expired row shows 'expired' and Revoke only; the live row with no known address offers Re-issue", async () => {
    reg.listCompanies.mockResolvedValue([]);
    db.results.project_intake_links = { data: [
      linkRow("live01", "Live Bidder", new Date(Date.now() + 30 * 86_400_000).toISOString()),
      linkRow("dead01", "Lapsed Bidder", new Date(Date.now() - 86_400_000).toISOString()),
    ], error: null };
    await render();
    const toggle = [...host.querySelectorAll("button")].find((b) => /Quote links for contractors/.test(b.textContent ?? ""))!;
    await act(async () => { toggle.click(); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const item = (name: RegExp) => [...host.querySelectorAll("li")].find((li) => name.test(li.textContent ?? ""))!;
    const labels = (li: Element) => [...li.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    const dead = item(/Lapsed Bidder/);
    expect(dead.textContent).toMatch(/expired/);
    expect(labels(dead)).toEqual(["Revoke"]);
    const live = item(/Live Bidder/);
    expect(labels(live)).toEqual(["Re-issue", "Revoke"]);
  });
});
