// @vitest-environment jsdom
//
// projects Round G — J10b UI REMAINDERS, the bid tab (QuotesPanel):
//   MON-10 (projects-tab) the J4 panel wiring J3 handed over —
//     * the award's warning (rivals that could not be marked not selected,
//       or the ungrouped quotes left open) is shown after the award, and is
//       what stays on screen after the tab's re-read;
//     * the award confirm promises a decline only for a GROUPED award ("the
//       other open bids in this RFQ group"); an ungrouped award promises none
//       and says to decline the bids that competed;
//     * an open UNGROUPED quote offers Decline — lib/costDocs declineQuote,
//       an optional recorded reason — and a refusal is said;
//     * a DECLINED bid offers Void (it moved no money) through
//       lib/costDocs voidCostDoc.
//   PR-2 criterion 2 (intelligence) the bid table shows the extraction's
//     total check beside the total ("lines ≠ total" and the sentence) when
//     the AI read lines that do not add up to the total it read; a total a
//     person restated is reconciled on screen instead, and the stored note is
//     never shown beside a corrected total (DEC-72 item 5). Never a block:
//     Award is still offered.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Res = { data: unknown; error: null | { code?: string; message: string } };
const db = vi.hoisted(() => ({
  byOp: {} as Record<string, Res>,
  results: {} as Record<string, Res>,
  calls: [] as Array<{ table: string; op: string; method: string; args: unknown[] }>,
}));
const reg = vi.hoisted(() => ({ listCompanies: vi.fn(), listBarredCompanies: vi.fn(), getCompany: vi.fn() }));
const dlg = vi.hoisted(() => ({ appPrompt: vi.fn(), appConfirm: vi.fn(), appAlert: vi.fn() }));
const cd = vi.hoisted(() => ({ awardQuote: vi.fn(), declineQuote: vi.fn(), voidCostDoc: vi.fn() }));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    let op = "";
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const res = db.byOp[`${table}.${op}`] ?? db.results[table] ?? { data: [], error: null };
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => {
          if (!op) op = prop;
          db.calls.push({ table, op, method: prop, args });
          if (prop === "maybeSingle") return Promise.resolve({ data: null, error: null });
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

import QuotesPanel, { quoteTotalNote } from "@/components/projects/cost/QuotesPanel";
import type { CostDocument } from "@/lib/costDocs";
import { validateParsedQuote, withHumanTotal } from "@/lib/bidTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = (over: Partial<CostDocument>): CostDocument => ({
  id: "d", orgId: "o1", projectId: "p1", partyId: null, kind: "quote", fileUrl: "k", fileName: "q.pdf", mimeType: "application/pdf",
  docNumber: null, docDate: null, vendorName: null, currency: "USD", totalAmount: null, status: "parsed", parsed: null,
  rfqGroup: null, intakeLinkId: null, postedAt: null, createdAt: null, ...over,
});
const parsedQuote = (vendor: string, total: number, lineTotal: number) => ({
  vendorName: vendor, total, currency: "USD", lineItems: [{ description: "Base bid", total: lineTotal, hours: 1500 }], exclusions: [],
});
const ACCOUNT = { id: "a1", projectId: "p1", code: null, name: "Piping", costType: null, budget: 1, currency: "USD", partyId: null, wbsMilestoneId: null, status: "active" as const };

let host: HTMLDivElement;
let root: Root;
const events: string[] = [];
beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  for (const f of [...Object.values(reg), ...Object.values(dlg), ...Object.values(cd)]) f.mockReset();
  reg.listCompanies.mockResolvedValue([]); reg.listBarredCompanies.mockResolvedValue([]);
  db.byOp = {}; db.results = {}; db.calls = [];
  db.results.project_parties = { data: [], error: null };
  events.length = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render(docs: CostDocument[]) {
  db.results.cost_documents = { data: docs.map((d) => ({ id: d.id, company_id: null, pages_total: 3, pages_read: 3 })), error: null };
  await act(async () => {
    root.render(React.createElement(QuotesPanel, {
      orgId: "o1", projectId: "p1", canManage: true, actor: { uid: "u1", email: "u1@example.com" },
      accounts: [ACCOUNT], docs,
      onChanged: () => { events.push("changed"); },
      setErr: (m: string | null) => { events.push(`err:${m}`); },
    }));
  });
  await settle();
}
const rowOf = (vendor: string) => [...host.querySelectorAll("tbody tr")].find((tr) => tr.textContent?.includes(vendor)) as HTMLTableRowElement;
const btn = (scope: ParentNode, re: RegExp) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => re.test(b.textContent ?? ""));
async function award(vendor: string) {
  const row = rowOf(vendor);
  const sel = row.querySelector("select") as HTMLSelectElement;
  await act(async () => { sel.value = "a1"; sel.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { btn(row, /Award/)!.click(); });
  await settle();
}
const lastErr = () => events.filter((e) => e.startsWith("err:") && e !== "err:null").at(-1)?.slice(4);

describe("MON-10 — the award's warning, its promise, and the hand decline", () => {
  const BAY = doc({ id: "bay", vendorName: "Bayline", totalAmount: 140_000, parsed: parsedQuote("Bayline", 140_000, 140_000) });
  const COLE = doc({ id: "cole", vendorName: "Cole Paint", totalAmount: 150_000, parsed: parsedQuote("Cole Paint", 150_000, 150_000) });

  it("an UNGROUPED award promises no decline, and its warning (the quotes left open) is shown after the re-read and stays", async () => {
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: true, warning: "Awarded. 1 other ungrouped quote stays open (Cole Paint) — decline it if it competed for this scope." });
    await render([BAY, COLE]);
    await award("Bayline");
    const ask = String((dlg.appConfirm.mock.calls[0][0] as { message: string }).message);
    expect(ask).toContain('This posts a commitment on "Piping". This quote has no RFQ group, so no other bid is marked not selected — decline any that competed for this scope.');
    expect(ask).not.toContain("marks the other");
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    // the re-read (onChanged) first, then the warning — so the warning is what stays
    const at = events.indexOf("changed");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(events.slice(at)).toContain("err:Awarded. 1 other ungrouped quote stays open (Cole Paint) — decline it if it competed for this scope.");
    expect(lastErr()).toBe("Awarded. 1 other ungrouped quote stays open (Cole Paint) — decline it if it competed for this scope.");
  });

  it("a GROUPED award promises the decline of the other open bids in its RFQ group; a clean award shows no warning", async () => {
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: true });
    const A = doc({ ...BAY, rfqGroup: "Unit 300 Repipe" });
    const B = doc({ ...COLE, rfqGroup: "Unit 300 Repipe" });
    await render([A, B]);
    await award("Bayline");
    const ask = String((dlg.appConfirm.mock.calls[0][0] as { message: string }).message);
    expect(ask).toContain('This posts a commitment on "Piping" and marks the other open bids in this RFQ group not selected.');
    expect(events).toContain("changed");
    expect(lastErr()).toBeUndefined();
  });

  it("Decline is offered on an open UNGROUPED quote only; it asks for an optional reason, calls declineQuote with it and re-reads", async () => {
    await render([BAY, doc({ ...COLE, rfqGroup: "Unit 300 Repipe" })]);
    expect(btn(rowOf("Bayline"), /Decline/)).toBeTruthy();
    expect(btn(rowOf("Cole Paint"), /Decline/)).toBeUndefined();   // grouped: the award declines it
    dlg.appPrompt.mockResolvedValueOnce("  Awarded to Gulf Mechanical  ");
    cd.declineQuote.mockResolvedValueOnce({ ok: true });
    await act(async () => { btn(rowOf("Bayline"), /Decline/)!.click(); });
    await settle();
    expect(String((dlg.appPrompt.mock.calls[0][0] as { title: string }).title)).toBe("Decline Bayline?");
    expect(cd.declineQuote).toHaveBeenCalledWith({ doc: BAY, actor: { uid: "u1", email: "u1@example.com" }, reason: "Awarded to Gulf Mechanical" });
    expect(events).toContain("changed");
  });

  it("a cancelled Decline writes nothing; a refused one is said and nothing is re-read", async () => {
    await render([BAY]);
    dlg.appPrompt.mockResolvedValueOnce(null);
    await act(async () => { btn(rowOf("Bayline"), /Decline/)!.click(); });
    await settle();
    expect(cd.declineQuote).not.toHaveBeenCalled();
    dlg.appPrompt.mockResolvedValueOnce("");
    cd.declineQuote.mockResolvedValueOnce({ ok: false, error: "This quote is already awarded — refresh to see the latest." });
    await act(async () => { btn(rowOf("Bayline"), /Decline/)!.click(); });
    await settle();
    expect(cd.declineQuote).toHaveBeenCalledWith(expect.objectContaining({ reason: null }));
    expect(lastErr()).toBe("This quote is already awarded — refresh to see the latest.");
    expect(events).not.toContain("changed");
  });

  it("a DECLINED bid offers Void, through lib/costDocs voidCostDoc (never the open-only panel write)", async () => {
    const DECLINED = doc({ ...COLE, status: "declined" });
    await render([DECLINED]);
    const row = rowOf("Cole Paint");
    expect(row.textContent).toContain("not selected");
    expect(btn(row, /Decline/)).toBeUndefined();
    dlg.appConfirm.mockResolvedValueOnce(true);
    cd.voidCostDoc.mockResolvedValueOnce({ ok: true });
    await act(async () => { btn(row, /Void/)!.click(); });
    await settle();
    expect(cd.voidCostDoc).toHaveBeenCalledWith({ doc: DECLINED, actor: { uid: "u1", email: "u1@example.com" } });
    expect(db.calls.filter((c) => c.table === "cost_documents" && c.op === "update")).toHaveLength(0);
    expect(events).toContain("changed");
  });
});

describe("PR-2 criterion 2 — the bid table shows the total check, never the stored note beside a corrected total", () => {
  it("an extraction whose lines add up to 1,820,000 under a total of 182,000 is flagged beside the total and in full under the row — and Award is still offered", async () => {
    const MISREAD = doc({ id: "m", vendorName: "Gulf Mechanical", totalAmount: 182_000, parsed: parsedQuote("Gulf Mechanical", 182_000, 1_820_000) });
    await render([MISREAD]);
    const row = rowOf("Gulf Mechanical");
    expect(row.textContent).toContain("lines ≠ total — check the PDF");
    expect(host.textContent).toContain("total check: The priced lines add up to 1,820,000, not the quoted total of 182,000");
    expect(btn(row, /Award/)).toBeTruthy();
  });

  it("a person restated the total to the lines' 1,820,000: no note (the stored one described the extraction)", async () => {
    const FIXED = doc({ id: "f", vendorName: "Gulf Mechanical", totalAmount: 1_820_000, parsed: parsedQuote("Gulf Mechanical", 182_000, 1_820_000) });
    await render([FIXED]);
    expect(host.textContent).toContain("corrected");
    expect(host.textContent).not.toContain("total check:");
    expect(host.textContent).not.toContain("not the quoted total of 182,000");
  });

  it("a person restated it to a figure the lines still do not reach: the ON-SCREEN total is reconciled and named", async () => {
    const OFF = doc({ id: "o", vendorName: "Gulf Mechanical", totalAmount: 1_900_000, parsed: parsedQuote("Gulf Mechanical", 182_000, 1_820_000) });
    await render([OFF]);
    expect(host.textContent).toContain("total check: The priced lines add up to 1,820,000, not the quoted total of 1,900,000");
    expect(host.textContent).not.toContain("not the quoted total of 182,000");
  });

  it("quoteTotalNote (the rule): extraction → the stored check; human → reconciled on screen; matching or price-only → none", () => {
    const read = validateParsedQuote(parsedQuote("V", 182_000, 1_820_000), "x");
    expect(quoteTotalNote(read)).toBe(read.totalCheck!.note);
    expect(quoteTotalNote(withHumanTotal(read, 1_820_000))).toBeNull();
    expect(quoteTotalNote(withHumanTotal(read, 1_900_000))).toMatch(/not the quoted total of 1,900,000/);
    expect(quoteTotalNote(validateParsedQuote(parsedQuote("V", 140_000, 140_000), "y"))).toBeNull();
    expect(quoteTotalNote({ ...read, priceOnly: true })).toBeNull();
  });
});
