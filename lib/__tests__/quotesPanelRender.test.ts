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
  /** What `.maybeSingle()` on a table answers. An ARRAY is a table of rows:
   *  the answer is the first row matching every `.eq(column, value)` of the
   *  chain (none: null) — so an org-bound read of another org's row reads
   *  null, as the database answers it. */
  single: {} as Record<string, unknown>,
  /** What `supabase.rpc(name)` answers. Unset: the function is absent
   *  (PGRST202) — the database before 20261157. */
  rpc: {} as Record<string, { data: unknown; error: null | { code?: string; message: string } }>,
  /** An insert this answers an error for fails with it (unset: every insert succeeds). */
  insertError: null as null | ((table: string, row: Record<string, unknown>) => { code?: string; message: string } | null),
}));
const reg = vi.hoisted(() => ({ listCompanies: vi.fn(), listBarredCompanies: vi.fn(), getCompany: vi.fn() }));
const dlg = vi.hoisted(() => ({ appPrompt: vi.fn(), appConfirm: vi.fn(), appAlert: vi.fn() }));
const cd = vi.hoisted(() => ({ awardQuote: vi.fn() }));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    let single = false;
    let insertErr: { code?: string; message: string } | null = null;
    const eqs: Array<[string, unknown]> = [];
    const pick = () => {
      const s = db.single[table];
      if (!Array.isArray(s)) return s ?? null;
      return (s as Array<Record<string, unknown>>).find((r) => eqs.every(([k, v]) => r[k] === v)) ?? null;
    };
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const res = insertErr ? { data: null, error: insertErr } : single ? { data: pick(), error: null } : db.results[table] ?? { data: [], error: null };
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => {
          db.calls.push({ table, method: prop, args });
          if (prop === "insert") {
            db.inserts.push({ table, row: args[0] as Record<string, unknown> });
            insertErr = db.insertError?.(table, args[0] as Record<string, unknown>) ?? null;
          }
          if (prop === "eq") eqs.push([args[0] as string, args[1]]);
          if (prop === "maybeSingle") single = true;
          return new Proxy({}, h);
        };
      },
    };
    return new Proxy({}, h);
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    db.calls.push({ table: `rpc:${name}`, method: "rpc", args: [args] });
    return db.rpc[name] ?? { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache` } };
  };
  return { supabase: { from: (t: string) => chain(t), rpc, auth: { getSession: async () => ({ data: { session: null } }) } } };
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
import { barredCompanyFor } from "@/lib/bidTab";

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
  db.inserts = []; db.calls = []; db.single = {}; db.rpc = {}; db.insertError = null;
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
/** A registry row as the companies table holds it (what an org-bound read returns). */
const companyRow = (c: Pick<Company, "id" | "orgId" | "name" | "status">) => ({ id: c.id, org_id: c.orgId, name: c.name, status: c.status });
/** The `.eq()` filters of every single-row read of the companies table, in order. */
const companyReads = () => {
  const out: Array<Record<string, unknown>> = [];
  let cur: Record<string, unknown> | null = null;
  for (const c of db.calls) {
    if (c.table !== "companies") continue;
    if (c.method === "select") { cur = {}; out.push(cur); }
    if (c.method === "eq" && cur) cur[c.args[0] as string] = c.args[1];
  }
  return out;
};

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
    db.single.companies = [companyRow(apex)];
    dlg.appPrompt.mockResolvedValue(null);
    await render();
    await awardOn(/Bayline/);
    expect(companyReads()).toEqual([{ id: "c-apex", org_id: "o1" }]);           // the org-bound read of the link
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

// projects Round G — projects-joint J12, review fix pass 7 (projects-tab MON-12 / COST-3): the bid tab's
// prompt and its intent row (COST_DOC_AWARD_OVERRIDE_DO_NOT_USE) name the company award_quote's
// COST_DOC_AWARD_OVERRIDE records. Cause 1: the panel checked the letterhead the AI read, while the
// award checks the STORED vendor name — with two do-not-use look-alikes the exact-name tie-break then
// picked a different row. Cause 2: a contractor whose linked company is flagged answers first at the
// award; the panel only knew the name. The panel now asks the award's own question at the click
// (companyAwardAnswersFor): the database's cost_doc_company_barred once 20261157 is applied, the same
// steps from the client before it.
describe("MON-12 (J12 review fix 7) — the bid tab names the company the award records", () => {
  const GULF = company("00000000-0000-0000-0000-0000000000c1", "Gulf Mechanical", "do_not_use");           // lower id, exact to the stored name
  const GULF_INC = company("00000000-0000-0000-0000-0000000000c2", "Gulf Mechanical, Inc.", "do_not_use"); // higher id, exact to the letterhead
  const COASTAL = company("c-coastal", "Coastal Fabricators", "do_not_use");                               // the contractor's linked company
  const gulfDoc = (over: Partial<CostDocument> = {}) => doc({
    id: "gulf", vendorName: "Gulf Mechanical", currency: "EUR", totalAmount: 150_000,
    parsed: { vendorName: "Gulf Mechanical, Inc.", total: 150_000, currency: "EUR", lineItems: [{ description: "Repipe exchanger circuits", total: 150_000, hours: 1500 }], exclusions: [] },
    ...over,
  });
  const list = (d: CostDocument) => {
    db.results.cost_documents = { data: [d, docs[1]].map((x) => ({ id: x.id, company_id: null, pages_total: 3, pages_read: 3 })), error: null };
    return [d, docs[1]];
  };
  const present = (c: Company | null) => { db.rpc.cost_doc_company_barred = { data: c ? { id: c.id, name: c.name, status: c.status } : null, error: null }; };
  const rpcCalls = () => db.calls.filter((c) => c.table === "rpc:cost_doc_company_barred").map((c) => c.args[0]);
  const intent = () => db.inserts.find((i) => i.row.action === "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE")?.row.details as Record<string, unknown> | undefined;
  beforeEach(() => {
    reg.listCompanies.mockResolvedValue([GULF, GULF_INC]);
    reg.listBarredCompanies.mockResolvedValue([GULF, GULF_INC]);
    dlg.appPrompt.mockResolvedValue("Sole bidder for the outage window");
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: true });
  });

  it("cause 1, before 20261157 (the function absent): the prompt, the intent row and the chip name the look-alike of the STORED vendor name — never the letterhead's", async () => {
    const d = gulfDoc();
    await render(list(d));
    expect(rowOf(/Gulf Mechanical/).textContent).toMatch(/do not use\? · Gulf Mechanical(?!,)/);
    await awardOn(/Gulf Mechanical/);
    // asked at the click, and again after the dialogs (J12 review fix pass 8)
    expect(rpcCalls()).toEqual(Array(2).fill({ p_org: "o1", p_company: null, p_party: null, p_vendor: "Gulf Mechanical" }));
    expect(dlg.appPrompt).toHaveBeenCalledTimes(1);   // the override is a do-not-use row of the stored name's key, which the letterhead shares: no second prompt
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toBe("Gulf Mechanical is flagged DO NOT USE");
    expect(intent()).toMatchObject({ companyId: GULF.id, company: "Gulf Mechanical", companyStatus: "do_not_use" });
    // what award_quote / the lib record for this row: the exact name of the stored vendor name, first
    expect(barredCompanyFor(d.vendorName, null, [GULF_INC, GULF])?.id).toBe(GULF.id);
    expect(cd.awardQuote.mock.calls[0][0].overrideReason).toBe("Sole bidder for the outage window");
  });

  it("cause 1, after 20261157: the database's own gate is asked with the stored name, and its answer is the one named — no client-side guess", async () => {
    present(GULF);
    await render(list(gulfDoc()));
    await awardOn(/Gulf Mechanical/);
    expect(rpcCalls()).toEqual(Array(2).fill({ p_org: "o1", p_company: null, p_party: null, p_vendor: "Gulf Mechanical" }));
    expect(reg.listBarredCompanies).toHaveBeenCalledTimes(1);          // the table's own read — no fallback read at the click
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toBe("Gulf Mechanical is flagged DO NOT USE");
    expect(intent()).toMatchObject({ companyId: GULF.id, company: "Gulf Mechanical" });
  });

  it("cause 2, after 20261157: the contractor's flagged company — the one the database answers — is named, not the vendor name's look-alike", async () => {
    present(COASTAL);
    await render(list(gulfDoc({ partyId: "pp1" })));
    await awardOn(/Gulf Mechanical/);
    expect(rpcCalls()).toEqual(Array(2).fill({ p_org: "o1", p_company: null, p_party: "pp1", p_vendor: "Gulf Mechanical" }));
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toBe("Coastal Fabricators is flagged DO NOT USE");
    expect(intent()).toMatchObject({ companyId: "c-coastal", company: "Coastal Fabricators", companyStatus: "do_not_use" });
    // J12 review fix 9: the contractor answers first, so the override never names the stored name's look-alike —
    // the bid tab stops on it for an acknowledgement (review 9's S1c shape)
    expect(promptTitles()).toEqual(["Coastal Fabricators is flagged DO NOT USE", "The vendor on file could be Gulf Mechanical — flagged DO NOT USE"]);
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK")).toMatchObject({ companyId: GULF.id, company: "Gulf Mechanical", matchedOn: ["vendorOnFile", "letterhead"], overrideCompanyId: "c-coastal" });
  });

  it("cause 2, before 20261157: the client asks the client sequence's order — the contractor's flagged company first; an ACTIVE one falls through to the look-alike (negative control)", async () => {
    db.single.cost_documents = { id: "gulf", org_id: "o1", company_id: null, party_id: "pp1", vendor_name: "Gulf Mechanical" };
    db.single.project_parties = { company_id: "c-coastal" };
    db.single.companies = [companyRow(COASTAL)];
    await render(list(gulfDoc({ partyId: "pp1" })));
    await awardOn(/Gulf Mechanical/);
    expect(companyReads()[0]).toEqual({ id: "c-coastal", org_id: "o1" });
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toBe("Coastal Fabricators is flagged DO NOT USE");
    expect(intent()).toMatchObject({ companyId: "c-coastal" });
    // J12 review fix 9: and the stored name's look-alike the contractor hides is acknowledged
    expect(promptTitles()).toEqual(["Coastal Fabricators is flagged DO NOT USE", "The vendor on file could be Gulf Mechanical — flagged DO NOT USE"]);
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK")).toMatchObject({ companyId: GULF.id });

    // negative control: the same contractor's company ACTIVE — it binds, but never hides the look-alike
    db.inserts = []; dlg.appPrompt.mockClear();
    db.single.companies = [companyRow({ ...COASTAL, status: "active" })];
    await awardOn(/Gulf Mechanical/);
    expect(promptTitles()).toEqual(["Gulf Mechanical is flagged DO NOT USE"]);      // the override names the look-alike: no acknowledgement
    expect(intent()).toMatchObject({ companyId: GULF.id });
  });

  it("before 20261157, an explicit link decides only to a company of the document's org — another org's company is skipped, as the lib's org-bound read skips it", async () => {
    db.single.cost_documents = { id: "gulf", org_id: "o1", company_id: "c-elsewhere", party_id: null, vendor_name: "Gulf Mechanical" };
    db.single.companies = [companyRow({ ...COASTAL, id: "c-elsewhere", orgId: "o2" })];       // readable (a member of both orgs), but not this org's
    await render(list(gulfDoc()));
    await awardOn(/Gulf Mechanical/);
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toBe("Gulf Mechanical is flagged DO NOT USE");
    expect(intent()).toMatchObject({ companyId: GULF.id });
    // negative control: the same link to a company of the org decides, flagged or not
    db.inserts = []; dlg.appPrompt.mockClear(); cd.awardQuote.mockClear();
    db.single.companies = [companyRow({ ...COASTAL, id: "c-elsewhere", orgId: "o1", status: "active" })];
    await awardOn(/Gulf Mechanical/);
    expect(dlg.appPrompt).not.toHaveBeenCalled();
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
  });

  it("an inactive company the database answers for is asked about as inactive, recorded as inactive, and the reason goes with the first award call", async () => {
    present({ ...COASTAL, status: "inactive" });
    await render(list(gulfDoc({ partyId: "pp1" })));
    await awardOn(/Gulf Mechanical/);
    expect(String(dlg.appPrompt.mock.calls[0][0].title)).toBe("Coastal Fabricators is marked INACTIVE");
    expect(intent()).toMatchObject({ companyId: "c-coastal", companyStatus: "inactive" });
    // J12 review fix 9: the inactive contractor answers first; the stored name's do-not-use look-alike is acknowledged (review 9's S1 shape)
    expect(promptTitles()).toEqual(["Coastal Fabricators is marked INACTIVE", "The vendor on file could be Gulf Mechanical — flagged DO NOT USE"]);
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    expect(cd.awardQuote.mock.calls[0][0].overrideReason).toBe("Sole bidder for the outage window");
  });

  it("negative controls: the database answering null asks for no reason and records no intent; a failed call (not an absent function) stops the award with no fallback", async () => {
    present(null);
    await render(list(gulfDoc()));
    await awardOn(/Gulf Mechanical/);
    expect(dlg.appPrompt).not.toHaveBeenCalled();
    expect(intent()).toBeUndefined();
    expect(cd.awardQuote.mock.calls[0][0].overrideReason ?? null).toBeNull();

    cd.awardQuote.mockClear();
    db.rpc.cost_doc_company_barred = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    await awardOn(/Gulf Mechanical/);
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(reg.listBarredCompanies).toHaveBeenCalledTimes(1);          // no client-side fallback behind a real error
    expect(errors.at(-1)).toMatch(/^Award stopped — the Known Companies registry couldn't be checked/);
  });

  it("a do-not-use row only the LETTERHEAD could be is labelled on the row, and the award's override is still the database's question over the vendor on file (J12 review fix pass 8: the award STOPS on it — below)", async () => {
    const apexBarred = company("c-apex", "Apex Industrial", "do_not_use");
    reg.listCompanies.mockResolvedValue([apexBarred]);
    reg.listBarredCompanies.mockResolvedValue([apexBarred]);
    const d = doc({ id: "front", vendorName: "Bayline Scaffold", currency: "EUR", totalAmount: 150_000,
      parsed: { vendorName: "Apex Industrial, Inc.", total: 150_000, currency: "EUR", lineItems: [{ description: "Repipe exchanger circuits", total: 150_000, hours: 1500 }], exclusions: [] } });
    await render(list(d));
    const chip = [...rowOf(/Apex Industrial, Inc\./).querySelectorAll("span")].find((s) => /letterhead: do not use\?/.test(s.textContent ?? ""))!;
    expect(chip.textContent).toBe("letterhead: do not use? · Apex Industrial");
    expect(chip.getAttribute("title")).toMatch(/The award's override is checked against the vendor name on file \("Bayline Scaffold"\), which no barred record matches — so Award stops for a typed acknowledgement/);
    await awardOn(/Apex Industrial, Inc\./);
    expect(rpcCalls()).toEqual(Array(2).fill({ p_org: "o1", p_company: null, p_party: null, p_vendor: "Bayline Scaffold" }));
    expect(intent()).toBeUndefined();
    expect(cd.awardQuote.mock.calls[0][0].overrideReason ?? null).toBeNull();
  });
});

// projects Round G — projects-joint J12, review fix pass 8 (projects-tab MON-12 / COST-3). Fix pass 7
// moved the award's override onto the database's question over the STORED vendor name, and with it
// dropped the stop the bid tab made through pass 6 for a bid whose LETTERHEAD (the vendor name the AI
// read) could be a do-not-use company: review 8's fixture — "Apex Industrial" do-not-use, vendor on file
// "Bayline Scaffold", letterhead "Apex Industrial, Inc." — awarded with no prompt and nothing recorded.
// The stop is back, as what it is: no gate in the lib or the database reads the letterhead, so it is a
// typed ACKNOWLEDGEMENT under its own audit action (COST_DOC_AWARD_LETTERHEAD_ACK), never the override
// intent and never award_quote's override reason. Each case runs before 20261157 (the function absent:
// the client sequence) and after it (the function present: its answer).
const APEX = company("c-apex", "Apex Industrial", "do_not_use");
const BAYLINE_CO = company("c-bayline", "Bayline Scaffold");
const COASTAL_CO = company("c-coastal", "Coastal Fabricators", "do_not_use");
const parsedFrom = (vendorName: string) => ({ vendorName, total: 150_000, currency: "EUR", lineItems: [{ description: "Repipe exchanger circuits", total: 150_000, hours: 1500 }], exclusions: [] });
/** Review 8's bid: the vendor on file is Bayline Scaffold, the letterhead the AI read is Apex Industrial, Inc. */
const frontBid = (over: Partial<CostDocument> = {}) => doc({ id: "front", vendorName: "Bayline Scaffold", currency: "EUR", totalAmount: 150_000, parsed: parsedFrom("Apex Industrial, Inc."), ...over });
/** The cost_documents row as the click re-reads it. */
const storedRow = (d: CostDocument, over: Record<string, unknown> = {}) => ({ id: d.id, org_id: d.orgId, company_id: null, party_id: d.partyId, vendor_name: d.vendorName, parsed: d.parsed, ...over });
const fieldOf = (d: CostDocument, pages: [number, number] = [3, 3]) => {
  db.results.cost_documents = { data: [d, docs[1]].map((x) => ({ id: x.id, company_id: null, pages_total: pages[1], pages_read: pages[0] })), error: null };
  return [d, docs[1]];
};
const gateAnswers = (c: Pick<Company, "id" | "name" | "status"> | null) => { db.rpc.cost_doc_company_barred = { data: c ? { id: c.id, name: c.name, status: c.status } : null, error: null }; };
const auditRow = (action: string) => db.inserts.find((i) => i.table === "audit_logs" && i.row.action === action)?.row.details as Record<string, unknown> | undefined;
const promptTitles = () => dlg.appPrompt.mock.calls.map((c) => String((c[0] as { title?: string }).title));
const promptText = (i: number) => {
  const m = (dlg.appPrompt.mock.calls[i][0] as { message: React.ReactNode }).message;
  return typeof m === "string" ? m : renderToStaticMarkup(React.createElement(React.Fragment, null, m));
};
const LETTERHEAD_TITLE = "The letterhead could be Apex Industrial — flagged DO NOT USE";

const MODES = [
  { mode: "before 20261157 (the function absent)", after: false },
  { mode: "after 20261157 (the function present)", after: true },
] as const;

describe.each(MODES)("MON-12 (J12 review fix 8) — a do-not-use company only the letterhead could be stops the award, $mode", ({ after }) => {
  /** What the database's gate answers for the case — set only when the function is present. */
  const database = (c: Pick<Company, "id" | "name" | "status"> | null) => { if (after) gateAnswers(c); };
  beforeEach(() => {
    reg.listCompanies.mockResolvedValue([APEX]);
    reg.listBarredCompanies.mockResolvedValue([APEX]);
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: true });
  });

  it("review 8's fixture: a danger-tone prompt names the letterhead, the company it could be and the vendor on file; the acknowledgement is recorded under its own action; the award carries no override reason", async () => {
    database(null);                                                   // the stored name matches no barred row
    const d = frontBid();
    db.single.cost_documents = storedRow(d);
    dlg.appPrompt.mockResolvedValue("Bayline bought Apex's scaffold division — W-9 checked");
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual([LETTERHEAD_TITLE]);
    const opts = dlg.appPrompt.mock.calls[0][0] as { tone?: string; required?: boolean };
    expect(opts.tone).toBe("danger");
    expect(opts.required).toBe(true);
    expect(promptText(0)).toMatch(/The AI read the letterhead as "Apex Industrial, Inc\.", which could be Apex Industrial, flagged DO NOT USE/);
    expect(promptText(0)).toMatch(/The vendor on file is "Bayline Scaffold"/);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK"]);
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK")).toMatchObject({
      letterhead: "Apex Industrial, Inc.", companyId: "c-apex", company: "Apex Industrial", companyStatus: "do_not_use",
      vendorOnFile: "Bayline Scaffold", reason: "Bayline bought Apex's scaffold division — W-9 checked",
      total: 150_000, currency: "EUR", rfqGroup: "Unit 300 Repipe", costAccountId: "a1",
    });
    expect(db.inserts.find((i) => i.table === "audit_logs")!.row).toMatchObject({ resource_type: "cost", resource_id: "front", org_id: "o1", user_id: "u1" });
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    expect(cd.awardQuote.mock.calls[0][0].overrideReason ?? null).toBeNull();     // never an override reason
    // the confirm carries the warning, in the danger tone
    const confirm = dlg.appConfirm.mock.calls[0][0] as { message: string; tone?: string };
    expect(confirm.tone).toBe("danger");
    expect(confirm.message).toMatch(/The letterhead the AI read \("Apex Industrial, Inc\."\) could be Apex Industrial, flagged DO NOT USE — the vendor on file is "Bayline Scaffold"/);
  });

  it("the paper path: a truncated read's check-the-paper prompt carries the same warning, after the acknowledgement", async () => {
    database(null);
    const d = frontBid();
    db.single.cost_documents = storedRow(d);
    dlg.appPrompt.mockResolvedValueOnce("Bayline is the bidder; Apex letterhead reused").mockResolvedValueOnce("150000");
    await render(fieldOf(d, [8, 14]));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()[0]).toBe(LETTERHEAD_TITLE);
    expect(promptTitles()[1]).toMatch(/^Check the total on the paper/);
    expect(promptText(1)).toMatch(/The letterhead the AI read \(&quot;Apex Industrial, Inc\.&quot;\) could be Apex Industrial, flagged DO NOT USE/);
    expect(dlg.appConfirm).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK"]);
    expect(cd.awardQuote.mock.calls[0][0]).toMatchObject({ confirmedTotal: 150000 });
    expect(cd.awardQuote.mock.calls[0][0].overrideReason ?? null).toBeNull();
  });

  it("the letterhead is the RE-READ row's parsed vendor name, never the table's copy — both ways", async () => {
    database(null);
    dlg.appPrompt.mockResolvedValue("checked");
    // the table loaded a Bayline letterhead; the row now reads Apex's (re-read since)
    const d = frontBid({ parsed: parsedFrom("Bayline Scaffold") });
    db.single.cost_documents = storedRow(d, { parsed: parsedFrom("Apex Industrial, Inc.") });
    await render(fieldOf(d));
    await awardOn(/Bayline/);
    expect(promptTitles()).toEqual([LETTERHEAD_TITLE]);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK"]);
    // and the other way: the table's copy reads Apex, the row now reads Bayline — no stop
    db.inserts = []; dlg.appPrompt.mockClear(); cd.awardQuote.mockClear();
    const e = frontBid();
    db.single.cost_documents = storedRow(e, { parsed: parsedFrom("Bayline Scaffold") });
    await render(fieldOf(e));
    await awardOn(/Apex Industrial, Inc\./);
    expect(dlg.appPrompt).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
  });

  it("regression pin: a letterhead no do-not-use row matches asks nothing and records nothing", async () => {
    database(null);
    const d = frontBid({ parsed: parsedFrom("Harbor Rigging Ltd") });
    db.single.cost_documents = storedRow(d);
    await render(fieldOf(d));
    await awardOn(/Harbor Rigging/);
    expect(dlg.appPrompt).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    expect(cd.awardQuote.mock.calls[0][0].overrideReason ?? null).toBeNull();
    expect(String((dlg.appConfirm.mock.calls[0][0] as { message: string }).message)).not.toMatch(/letterhead/);
  });

  it("the letterhead names the company the database names — by the same name key, or as the contractor's flagged company: ONE prompt, the override, and no acknowledgement", async () => {
    dlg.appPrompt.mockResolvedValue("Sole bidder for the outage window");
    // (a) the stored name and the letterhead normalise alike: the database's question already covers the name
    database(APEX);
    const a = frontBid({ vendorName: "Apex Industrial" });
    db.single.cost_documents = storedRow(a);
    await render(fieldOf(a));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual(["Apex Industrial is flagged DO NOT USE"]);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(cd.awardQuote.mock.calls[0][0].overrideReason).toBe("Sole bidder for the outage window");

    // (b) the contractor's company is the flagged Apex the letterhead could be: the database names it
    db.inserts = []; db.calls = []; dlg.appPrompt.mockClear(); cd.awardQuote.mockClear();
    database(APEX);
    const b = frontBid({ partyId: "pp1" });
    db.single.cost_documents = storedRow(b);
    db.single.project_parties = { company_id: "c-apex" };
    db.single.companies = [companyRow(APEX)];
    await render(fieldOf(b));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual(["Apex Industrial is flagged DO NOT USE"]);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(auditRow("COST_DOC_AWARD_OVERRIDE_DO_NOT_USE")).toMatchObject({ companyId: "c-apex" });
  });

  it("cancelling the acknowledgement stops the award: nothing is recorded and nothing is awarded", async () => {
    database(null);
    const d = frontBid();
    db.single.cost_documents = storedRow(d);
    dlg.appPrompt.mockResolvedValue(null);
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual([LETTERHEAD_TITLE]);
    expect(dlg.appConfirm).not.toHaveBeenCalled();
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
    expect(errors.at(-1)).toBe('Award stopped — the letterhead "Apex Industrial, Inc." could be Apex Industrial (flagged do-not-use) and no acknowledgement was given.');
  });

  it("the database names another company (the contractor's) AND the letterhead could be Apex: both are asked and recorded apart; only the override's reason goes with the award", async () => {
    reg.listBarredCompanies.mockResolvedValue([APEX, COASTAL_CO]);
    database(COASTAL_CO);
    const d = frontBid({ partyId: "pp1" });
    db.single.cost_documents = storedRow(d);
    db.single.project_parties = { company_id: "c-coastal" };
    db.single.companies = [companyRow(COASTAL_CO)];
    dlg.appPrompt.mockResolvedValueOnce("Coastal's suspension lifted on 09-28").mockResolvedValueOnce("Bayline bid on Apex paper — checked");
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual(["Coastal Fabricators is flagged DO NOT USE", LETTERHEAD_TITLE]);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(auditRow("COST_DOC_AWARD_OVERRIDE_DO_NOT_USE")).toMatchObject({ companyId: "c-coastal", reason: "Coastal's suspension lifted on 09-28" });
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK")).toMatchObject({ companyId: "c-apex", reason: "Bayline bid on Apex paper — checked" });
    expect(cd.awardQuote.mock.calls[0][0].overrideReason).toBe("Coastal's suspension lifted on 09-28");
  });

  it("a person's link to a company of the org decides — no letterhead stop; a link to no company of the org does not decide", async () => {
    database(null);
    dlg.appPrompt.mockResolvedValue("checked");
    const d = frontBid();
    db.single.cost_documents = storedRow(d, { company_id: "c-bayline" });
    db.single.companies = [companyRow(BAYLINE_CO)];
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(dlg.appPrompt).not.toHaveBeenCalled();
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    // the same link to another org's company (readable to a member of both): not a link of this org — the stop stands
    db.inserts = []; cd.awardQuote.mockClear();
    db.single.companies = [companyRow({ ...BAYLINE_CO, orgId: "o2" })];
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual([LETTERHEAD_TITLE]);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK"]);
  });

  it("an award that fails after the acknowledgement closes it with its own abandonment row", async () => {
    database(null);
    const d = frontBid();
    db.single.cost_documents = storedRow(d);
    dlg.appPrompt.mockResolvedValue("checked");
    cd.awardQuote.mockResolvedValue({ ok: false, error: "Someone else just decided this document — refresh to see the latest." });
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED"]);
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED")).toMatchObject({ letterhead: "Apex Industrial, Inc.", companyId: "c-apex", why: "Someone else just decided this document — refresh to see the latest." });
    expect(errors.at(-1)).toBe("Someone else just decided this document — refresh to see the latest.");
  });

  it("an acknowledgement that cannot be recorded stops the award before anything else is written; an override intent that cannot be recorded after it closes the acknowledgement", async () => {
    reg.listBarredCompanies.mockResolvedValue([APEX, COASTAL_CO]);
    database(COASTAL_CO);
    const d = frontBid({ partyId: "pp1" });
    db.single.cost_documents = storedRow(d);
    db.single.project_parties = { company_id: "c-coastal" };
    db.single.companies = [companyRow(COASTAL_CO)];
    dlg.appPrompt.mockResolvedValue("reason");
    const refuse = (action: string) => { db.insertError = (table, row) => (table === "audit_logs" && row.action === action ? { code: "42501", message: "new row violates row-level security policy" } : null); };
    refuse("COST_DOC_AWARD_LETTERHEAD_ACK");
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK"]);            // the one attempted write — nothing after it
    expect(errors.at(-1)).toMatch(/^The letterhead acknowledgement could not be recorded \(.+\) — award stopped\.$/);
    // the acknowledgement written, the override intent refused: the acknowledgement is closed
    db.inserts = [];
    refuse("COST_DOC_AWARD_OVERRIDE_DO_NOT_USE");
    await awardOn(/Apex Industrial, Inc\./);
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE", "COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED"]);
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED")).toMatchObject({ companyId: "c-apex", why: expect.stringMatching(/^The override could not be recorded/) });
    expect(errors.at(-1)).toMatch(/^The override could not be recorded \(.+\) — award stopped\.$/);
  });

  it("the lib finds a flag after the acknowledgement was recorded and no reason is given: the award stops and the acknowledgement is closed", async () => {
    database(null);
    const d = frontBid();
    db.single.cost_documents = storedRow(d);
    dlg.appPrompt.mockResolvedValueOnce("checked").mockResolvedValueOnce(null);
    cd.awardQuote.mockResolvedValueOnce({ ok: false, error: "flagged", needsOverride: { companyId: "c-bay", companyName: "Bayline", status: "inactive" } });
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED"]);
    expect(errors.at(-1)).toBe("Award stopped — Bayline is flagged and no override reason was given.");
  });
});

describe("MON-12 / COST-3 (J12 review fix 8) — the reviewer's nits", () => {
  beforeEach(() => {
    reg.listCompanies.mockResolvedValue([APEX]);
    reg.listBarredCompanies.mockResolvedValue([APEX]);
    dlg.appConfirm.mockResolvedValue(true);
    dlg.appPrompt.mockResolvedValue("Sole bidder");
    cd.awardQuote.mockResolvedValue({ ok: true });
  });
  const bid = (vendorName: string, over: Partial<CostDocument> = {}) => doc({ id: "solo", vendorName, currency: "EUR", totalAmount: 150_000, parsed: parsedFrom(vendorName), ...over });

  it("nit 1, before 20261157: a link to a company the read cannot see (another org's, hidden by RLS) is skipped as the lib skips it — the award is not stopped for good; the question falls through to the vendor name", async () => {
    const d = bid("Apex Industrial");
    db.single.cost_documents = storedRow(d, { company_id: "c-hidden" });
    db.single.companies = [];                                         // RLS: no row
    await render(fieldOf(d));
    await awardOn(/Apex Industrial/);
    expect(companyReads()[0]).toEqual({ id: "c-hidden", org_id: "o1" });   // org-bound, as lib/costDocs.ts byId
    expect(errors.filter((e) => /couldn't be checked/.test(e ?? ""))).toEqual([]);
    expect(promptTitles()).toEqual(["Apex Industrial is flagged DO NOT USE"]);   // the vendor name's look-alike answers
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
  });

  // (J12 review fix 9: a realistic shape — the database answers a company whose name key is not the stored
  // name's only through a link or a contractor; here the contractor's company is re-filed meanwhile.)
  it("nit 2: the database's answer moves while the confirm is open — the new company is asked about; the intent and the award carry ITS reason, never the one typed for the first", async () => {
    gateAnswers(APEX);                                                // the contractor's company: Apex
    const d = bid("Bayline Scaffold", { partyId: "pp1" });
    db.single.cost_documents = storedRow(d);
    dlg.appPrompt.mockResolvedValueOnce("typed for Apex").mockResolvedValueOnce("typed for Coastal");
    dlg.appConfirm.mockImplementation(async () => { gateAnswers(COASTAL_CO); return true; });   // someone re-files the bid's contractor meanwhile
    await render(fieldOf(d));
    await awardOn(/Bayline Scaffold/);
    expect(promptTitles()).toEqual(["Apex Industrial is flagged DO NOT USE", "Coastal Fabricators is flagged DO NOT USE"]);
    expect(promptText(1)).toMatch(/changed while the award was being confirmed — it answered for Apex Industrial; the award now answers for Coastal Fabricators/);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(auditRow("COST_DOC_AWARD_OVERRIDE_DO_NOT_USE")).toMatchObject({ companyId: "c-coastal", reason: "typed for Coastal" });
    expect(cd.awardQuote.mock.calls[0][0].overrideReason).toBe("typed for Coastal");
  });

  it("nit 2: the flag clears while the confirm is open — no intent is recorded and no reason goes with the award", async () => {
    gateAnswers(APEX);
    const d = bid("Apex Industrial");
    db.single.cost_documents = storedRow(d);
    dlg.appConfirm.mockImplementation(async () => { gateAnswers(null); return true; });
    await render(fieldOf(d));
    await awardOn(/Apex Industrial/);
    expect(auditActions()).toEqual([]);
    expect(cd.awardQuote.mock.calls[0][0].overrideReason ?? null).toBeNull();
  });

  it("nit 2, before 20261157: a letterhead re-read while the confirm is open is asked about after it — acknowledged, recorded, then awarded", async () => {
    const d = frontBid({ parsed: parsedFrom("Bayline Scaffold") });
    db.single.cost_documents = storedRow(d);
    dlg.appPrompt.mockResolvedValue("checked the bidder");
    dlg.appConfirm.mockImplementation(async () => { db.single.cost_documents = storedRow(d, { parsed: parsedFrom("Apex Industrial, Inc.") }); return true; });
    await render(fieldOf(d));
    await awardOn(/Bayline/);
    expect(dlg.appConfirm.mock.invocationCallOrder[0]).toBeLessThan(dlg.appPrompt.mock.invocationCallOrder[0]);
    expect(promptTitles()).toEqual([LETTERHEAD_TITLE]);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK"]);
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
  });

  it("nit 2: an answer that keeps moving stops the award after three re-asks, with nothing recorded", async () => {
    let n = 0;
    gateAnswers(company(`c-${n}`, `Mover ${n}`, "do_not_use"));       // the contractor's company, re-filed at every prompt
    dlg.appPrompt.mockImplementation(async () => { n++; gateAnswers(company(`c-${n}`, `Mover ${n}`, "do_not_use")); return "reason"; });
    const d = bid("Bayline Scaffold", { partyId: "pp1" });
    db.single.cost_documents = storedRow(d);
    await render(fieldOf(d));
    await awardOn(/Bayline Scaffold/);
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
    expect(dlg.appPrompt).toHaveBeenCalledTimes(3);
    expect(errors.at(-1)).toMatch(/kept changing while the award was being confirmed/);
  });

  it("nit 3, before 20261157: a contractor's flagged company of ANOTHER org (readable to a member of both) is not this bid's — no override is asked", async () => {
    const d = bid("Bayline Scaffold", { partyId: "pp1" });
    db.single.cost_documents = storedRow(d);
    db.single.project_parties = { company_id: "c-coastal" };
    db.single.companies = [companyRow({ ...COASTAL_CO, orgId: "o2" })];
    await render(fieldOf(d));
    await awardOn(/Bayline Scaffold/);
    expect(companyReads()[0]).toEqual({ id: "c-coastal", org_id: "o1" });
    expect(dlg.appPrompt).not.toHaveBeenCalled();
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
  });

  it("nit 3, both sides of 20261157: the vendor name asked about is the RE-READ row's, not the table's copy", async () => {
    // the table loaded "Bayline Scaffold"; the row's vendor name now reads "Apex Industrial"
    const d = bid("Bayline Scaffold");
    db.single.cost_documents = storedRow(d, { vendor_name: "Apex Industrial" });
    await render(fieldOf(d));
    await awardOn(/Bayline Scaffold/);
    expect(promptTitles()).toEqual(["Apex Industrial is flagged DO NOT USE"]);    // before: the client's look-alike of the stored name
    db.inserts = []; db.calls = []; dlg.appPrompt.mockClear();
    gateAnswers(null);
    await awardOn(/Bayline Scaffold/);
    expect(db.calls.filter((c) => c.table === "rpc:cost_doc_company_barred").map((c) => (c.args[0] as { p_vendor: string }).p_vendor)).toEqual(["Apex Industrial", "Apex Industrial"]);
  });

  it("nit 3, after 20261157: an answer that is not flagged (an active company) asks for nothing", async () => {
    gateAnswers({ id: "c-active", name: "Active Co", status: "active" });
    const d = bid("Bayline Scaffold");
    db.single.cost_documents = storedRow(d);
    await render(fieldOf(d));
    await awardOn(/Bayline Scaffold/);
    expect(dlg.appPrompt).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
    expect(cd.awardQuote.mock.calls[0][0].overrideReason ?? null).toBeNull();
  });
});

// projects Round G — projects-joint J12, review fix pass 9 (projects-tab MON-12 / COST-3). Fix pass 8 skipped a
// letterhead that normalises as the stored vendor name, on the premise that the stored name's look-alikes are
// already the database's question. They are not when a flagged contractor answers first: the override names ONE
// company, the first its order reaches (the link, a flagged contractor, the stored name's do-not-use look-alike,
// the bound company's own flag). Review 9's S1: vendor on file "Apex Industrial", letterhead "Apex Industrial,
// Inc.", "Apex Industrial" do-not-use, the contractor's company "Coastal Fabricators" inactive — pass 8 asked
// only about Coastal, and Apex appeared in no prompt and no audit row. The bid tab now stops for an
// acknowledgement on the do-not-use look-alike of the STORED name too (a typed-total bid included — S6), unless
// the override is a do-not-use row with that name's key (or, for the stored name, there is none); one prompt
// per name key. Each case runs before 20261157 (the client sequence) and after it (the database's answer).
const COASTAL_INACTIVE = company("c-coastal", "Coastal Fabricators", "inactive");
const ZENITH = company("c-zenith", "Zenith Rigging", "do_not_use");
const VENDOR_TITLE = "The vendor on file could be Apex Industrial — flagged DO NOT USE";

describe.each(MODES)("MON-12 (J12 review fix 9) — a do-not-use look-alike a flagged contractor hides from the override is acknowledged, $mode", ({ after }) => {
  const database = (c: Pick<Company, "id" | "name" | "status"> | null) => { if (after) gateAnswers(c); };
  /** The bid filed against contractor pp1, whose company is `contractor`. */
  const filed = (d: CostDocument, contractor: Company) => {
    db.single.cost_documents = storedRow(d);
    db.single.project_parties = { company_id: contractor.id };
    db.single.companies = [companyRow(contractor)];
  };
  const OVERRIDE_REASON = "Coastal reinstated for the outage window";
  const ACK_REASON = "Apex's name on a Coastal bid — checked with purchasing";
  beforeEach(() => {
    reg.listCompanies.mockResolvedValue([APEX]);
    reg.listBarredCompanies.mockResolvedValue([APEX]);
    dlg.appConfirm.mockResolvedValue(true);
    dlg.appPrompt.mockResolvedValueOnce(OVERRIDE_REASON).mockResolvedValueOnce(ACK_REASON);
    cd.awardQuote.mockResolvedValue({ ok: true });
  });

  it("S1: an INACTIVE contractor, the vendor on file and the letterhead both Apex's key — Coastal's override AND one acknowledgement naming Apex; the ack row names Apex, the intent row Coastal", async () => {
    database(COASTAL_INACTIVE);
    const d = frontBid({ vendorName: "Apex Industrial", partyId: "pp1" });
    filed(d, COASTAL_INACTIVE);
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual(["Coastal Fabricators is marked INACTIVE", VENDOR_TITLE]);   // Apex once: two names, one key
    const opts = dlg.appPrompt.mock.calls[1][0] as { tone?: string; required?: boolean; placeholder?: string };
    expect(opts).toMatchObject({ tone: "danger", required: true, placeholder: "Acknowledgement reason (required)" });
    expect(promptText(1)).toMatch(/^The vendor on file, "Apex Industrial", and the letterhead the AI read, "Apex Industrial, Inc\.", could be Apex Industrial, flagged DO NOT USE in the registry\./);
    expect(promptText(1)).toMatch(/here that is Coastal Fabricators, marked inactive, so no override for Apex Industrial is recorded/);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK")).toMatchObject({
      matchedOn: ["vendorOnFile", "letterhead"], vendorOnFile: "Apex Industrial", letterhead: "Apex Industrial, Inc.",
      companyId: "c-apex", company: "Apex Industrial", companyStatus: "do_not_use",
      overrideCompanyId: "c-coastal", overrideCompany: "Coastal Fabricators", reason: ACK_REASON,
      total: 150_000, currency: "EUR", rfqGroup: "Unit 300 Repipe", costAccountId: "a1",
    });
    expect(auditRow("COST_DOC_AWARD_OVERRIDE_DO_NOT_USE")).toMatchObject({ companyId: "c-coastal", company: "Coastal Fabricators", companyStatus: "inactive", reason: OVERRIDE_REASON });
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    expect(cd.awardQuote.mock.calls[0][0].overrideReason).toBe(OVERRIDE_REASON);              // never the acknowledgement's
    const confirm = dlg.appConfirm.mock.calls[0][0] as { message: string; tone?: string };
    expect(confirm.tone).toBe("danger");
    expect(confirm.message).toMatch(/The vendor on file \("Apex Industrial"\) and the letterhead the AI read \("Apex Industrial, Inc\."\) could be Apex Industrial, flagged DO NOT USE — the award's override names Coastal Fabricators/);
  });

  it("S1b: the same contractor, the vendor on file 'Bayline Scaffold' — Coastal's override and the LETTERHEAD's acknowledgement for Apex (unchanged from fix pass 8)", async () => {
    database(COASTAL_INACTIVE);
    const d = frontBid({ partyId: "pp1" });
    filed(d, COASTAL_INACTIVE);
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual(["Coastal Fabricators is marked INACTIVE", LETTERHEAD_TITLE]);
    expect(promptText(1)).toMatch(/The AI read the letterhead as "Apex Industrial, Inc\.", which could be Apex Industrial, flagged DO NOT USE/);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK")).toMatchObject({ matchedOn: ["letterhead"], letterhead: "Apex Industrial, Inc.", vendorOnFile: "Bayline Scaffold", companyId: "c-apex", company: "Apex Industrial", reason: ACK_REASON });
    expect(auditRow("COST_DOC_AWARD_OVERRIDE_DO_NOT_USE")).toMatchObject({ companyId: "c-coastal", companyStatus: "inactive", reason: OVERRIDE_REASON });
    expect(cd.awardQuote.mock.calls[0][0].overrideReason).toBe(OVERRIDE_REASON);
  });

  it("S1c: a DO-NOT-USE contractor (Coastal), the vendor on file 'Apex Industrial' — Coastal's override and one acknowledgement naming Apex", async () => {
    reg.listBarredCompanies.mockResolvedValue([APEX, COASTAL_CO]);
    database(COASTAL_CO);
    const d = frontBid({ vendorName: "Apex Industrial", partyId: "pp1" });
    filed(d, COASTAL_CO);
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual(["Coastal Fabricators is flagged DO NOT USE", VENDOR_TITLE]);
    expect(promptText(1)).toMatch(/here that is Coastal Fabricators, flagged do-not-use, so no override for Apex Industrial is recorded/);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK")).toMatchObject({ matchedOn: ["vendorOnFile", "letterhead"], companyId: "c-apex", company: "Apex Industrial", overrideCompanyId: "c-coastal", reason: ACK_REASON });
    expect(auditRow("COST_DOC_AWARD_OVERRIDE_DO_NOT_USE")).toMatchObject({ companyId: "c-coastal", company: "Coastal Fabricators", companyStatus: "do_not_use", reason: OVERRIDE_REASON });
    expect(cd.awardQuote.mock.calls[0][0].overrideReason).toBe(OVERRIDE_REASON);
  });

  it("S6: a typed-total bid (no letterhead) on file as 'Apex Industrial', the contractor inactive — the stored name's acknowledgement is asked, naming no letterhead", async () => {
    database(COASTAL_INACTIVE);
    const d = doc({ id: "front", vendorName: "Apex Industrial", currency: "EUR", totalAmount: 150_000, parsed: null, partyId: "pp1" });
    filed(d, COASTAL_INACTIVE);
    await render(fieldOf(d, [0, 0]));
    await awardOn(/Apex Industrial/);
    expect(promptTitles()).toEqual(["Coastal Fabricators is marked INACTIVE", VENDOR_TITLE]);
    expect(promptText(1)).toMatch(/^The vendor on file, "Apex Industrial" could be Apex Industrial, flagged DO NOT USE in the registry\./);
    expect(promptText(1)).not.toMatch(/letterhead/);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK")).toMatchObject({ matchedOn: ["vendorOnFile"], letterhead: null, vendorOnFile: "Apex Industrial", companyId: "c-apex", company: "Apex Industrial", reason: ACK_REASON });
    expect(auditRow("COST_DOC_AWARD_OVERRIDE_DO_NOT_USE")).toMatchObject({ companyId: "c-coastal", companyStatus: "inactive", reason: OVERRIDE_REASON });
    expect(cd.awardQuote.mock.calls[0][0].overrideReason).toBe(OVERRIDE_REASON);
  });

  it("cancelling the stored name's acknowledgement stops the award: nothing recorded, nothing awarded", async () => {
    database(COASTAL_INACTIVE);
    const d = frontBid({ vendorName: "Apex Industrial", partyId: "pp1" });
    filed(d, COASTAL_INACTIVE);
    dlg.appPrompt.mockReset();
    dlg.appPrompt.mockResolvedValueOnce(OVERRIDE_REASON).mockResolvedValueOnce(null);
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual(["Coastal Fabricators is marked INACTIVE", VENDOR_TITLE]);
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([]);
    expect(errors.at(-1)).toBe('Award stopped — the vendor on file "Apex Industrial" could be Apex Industrial (flagged do-not-use) and no acknowledgement was given.');
  });

  it("two DIFFERENT do-not-use companies — the vendor on file's and the letterhead's — are each acknowledged; a failed award closes both", async () => {
    reg.listBarredCompanies.mockResolvedValue([APEX, ZENITH]);
    database(COASTAL_INACTIVE);
    const d = frontBid({ vendorName: "Zenith Rigging", partyId: "pp1" });
    filed(d, COASTAL_INACTIVE);
    dlg.appPrompt.mockReset();
    dlg.appPrompt.mockResolvedValueOnce(OVERRIDE_REASON).mockResolvedValueOnce("for Zenith").mockResolvedValueOnce("for Apex");
    cd.awardQuote.mockResolvedValue({ ok: false, error: "Someone else just decided this document — refresh to see the latest." });
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual(["Coastal Fabricators is marked INACTIVE", "The vendor on file could be Zenith Rigging — flagged DO NOT USE", LETTERHEAD_TITLE]);
    const acks = db.inserts.filter((i) => i.row.action === "COST_DOC_AWARD_LETTERHEAD_ACK").map((i) => i.row.details);
    expect(acks).toMatchObject([
      { matchedOn: ["vendorOnFile"], companyId: "c-zenith", company: "Zenith Rigging", letterhead: null, reason: "for Zenith" },
      { matchedOn: ["letterhead"], companyId: "c-apex", company: "Apex Industrial", letterhead: "Apex Industrial, Inc.", reason: "for Apex" },
    ]);
    expect(auditActions()).toEqual([
      "COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE",
      "COST_DOC_AWARD_OVERRIDE_ABANDONED", "COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED", "COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED",
    ]);
    const closed = db.inserts.filter((i) => i.row.action === "COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED").map((i) => i.row.details);
    expect(closed).toMatchObject([{ companyId: "c-zenith", company: "Zenith Rigging" }, { companyId: "c-apex", company: "Apex Industrial" }]);
  });

  it("the second acknowledgement cannot be recorded: the award stops and the first is closed", async () => {
    reg.listBarredCompanies.mockResolvedValue([APEX, ZENITH]);
    database(COASTAL_INACTIVE);
    const d = frontBid({ vendorName: "Zenith Rigging", partyId: "pp1" });
    filed(d, COASTAL_INACTIVE);
    dlg.appPrompt.mockReset();
    dlg.appPrompt.mockResolvedValue("checked");
    db.insertError = (table, row) => (table === "audit_logs" && row.action === "COST_DOC_AWARD_LETTERHEAD_ACK" && (row.details as { companyId?: string }).companyId === "c-apex"
      ? { code: "42501", message: "new row violates row-level security policy" } : null);
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(cd.awardQuote).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED"]);
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK_ABANDONED")).toMatchObject({ companyId: "c-zenith", why: expect.stringMatching(/^The letterhead acknowledgement could not be recorded/) });
    expect(errors.at(-1)).toMatch(/^The letterhead acknowledgement could not be recorded \(.+\) — award stopped\.$/);
  });

  it("the contractor's company turns inactive while the confirm is open: the new override and the look-alike it now hides are asked after it; the award carries the new override's reason", async () => {
    const COASTAL_ACTIVE = company("c-coastal", "Coastal Fabricators", "active");
    database(APEX);                                                   // an active contractor binds; the stored name's look-alike answers
    const d = frontBid({ vendorName: "Apex Industrial", partyId: "pp1" });
    filed(d, COASTAL_ACTIVE);
    dlg.appPrompt.mockReset();
    dlg.appPrompt.mockResolvedValueOnce("typed for Apex").mockResolvedValueOnce(OVERRIDE_REASON).mockResolvedValueOnce(ACK_REASON);
    dlg.appConfirm.mockImplementation(async () => { database(COASTAL_INACTIVE); db.single.companies = [companyRow(COASTAL_INACTIVE)]; return true; });
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual(["Apex Industrial is flagged DO NOT USE", "Coastal Fabricators is marked INACTIVE", VENDOR_TITLE]);
    expect(promptText(1)).toMatch(/it answered for Apex Industrial; the award now answers for Coastal Fabricators/);
    expect(promptText(2)).toMatch(/^This bid's company link, contractor, vendor name or letterhead changed while the award was being confirmed\./);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_LETTERHEAD_ACK", "COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(auditRow("COST_DOC_AWARD_LETTERHEAD_ACK")).toMatchObject({ companyId: "c-apex", reason: ACK_REASON });
    expect(auditRow("COST_DOC_AWARD_OVERRIDE_DO_NOT_USE")).toMatchObject({ companyId: "c-coastal", reason: OVERRIDE_REASON });
    expect(cd.awardQuote.mock.calls[0][0].overrideReason).toBe(OVERRIDE_REASON);
  });

  it("negative controls: a person's link to a company of the org decides — its override is asked, no acknowledgement behind it; an ACTIVE contractor leaves the look-alike to the override — one prompt", async () => {
    // the link (to a do-not-use company) decides, though the stored name's do-not-use look-alike is another company (DEC-48)
    reg.listBarredCompanies.mockResolvedValue([APEX, COASTAL_CO]);
    database(COASTAL_CO);
    const d = frontBid({ vendorName: "Apex Industrial" });
    db.single.cost_documents = storedRow(d, { company_id: "c-coastal" });
    db.single.companies = [companyRow(COASTAL_CO)];
    dlg.appPrompt.mockReset(); dlg.appPrompt.mockResolvedValue("Linked on purpose");
    await render(fieldOf(d));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual(["Coastal Fabricators is flagged DO NOT USE"]);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    // the contractor's company ACTIVE, no link: the override is Apex's (the stored name's look-alike) — asked once, no acknowledgement
    db.inserts = []; dlg.appPrompt.mockReset(); dlg.appPrompt.mockResolvedValue("Sole bidder"); cd.awardQuote.mockClear();
    database(APEX);
    const e = frontBid({ vendorName: "Apex Industrial", partyId: "pp1" });
    await render(fieldOf(e));
    filed(e, company("c-coastal", "Coastal Fabricators", "active"));
    await awardOn(/Apex Industrial, Inc\./);
    expect(promptTitles()).toEqual(["Apex Industrial is flagged DO NOT USE"]);
    expect(auditActions()).toEqual(["COST_DOC_AWARD_OVERRIDE_DO_NOT_USE"]);
    expect(auditRow("COST_DOC_AWARD_OVERRIDE_DO_NOT_USE")).toMatchObject({ companyId: "c-apex" });
  });
});
