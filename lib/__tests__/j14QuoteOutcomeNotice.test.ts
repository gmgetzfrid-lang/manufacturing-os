// @vitest-environment jsdom
//
// projects Round G — J14 PROJECTS FOLLOW-UPS: projects-tab MON-10 done-when 2.
// The contractor is told how a quote was decided: after an award (the
// awarded bidder and every open rival of its RFQ group — the bids the award
// declines) and after a hand decline, the bid tab asks J12's notice route
// (notifyQuoteOutcome → /api/intake/outcome-notice), which reads each
// quote's stored status and emails only the contact the org entered on the
// quote link it came through. Only link-filed quotes are asked; an answer
// that means nothing went wrong says nothing; a failed send is said.
//
// (The harness below is j10bQuotesAwardDecline.test.ts's.)
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
//     * (fix pass) Decline and Void are gated apart from the award: ANY open
//       quote in a group that already holds an award keeps them — a second
//       quote from the same vendor (both tabulate under "Ungrouped —
//       <vendor>"), or a grouped rival whose automatic decline failed — and
//       an unread ungrouped quote the warning names is declined from the
//       "not read yet" strip;
//     * a DECLINED bid offers Void (it moved no money) through
//       lib/costDocs voidCostDoc — in an awarded RFQ group too, where a
//       grouped award's own decline leaves it (the common case).
//   PR-2 criterion 2 (intelligence) the bid table shows the extraction's
//     total check beside the total ("lines ≠ total" and the sentence) when
//     the AI read lines that do not add up to the total it read; a total a
//     person restated is reconciled on screen instead, and the stored note is
//     never shown beside a corrected total (DEC-72 item 5). Never a block:
//     Award is still offered. (fix pass) A total restated into another
//     currency is never summed against lines still in the currency read.

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
  // J12 (merged beside this file): the award's gate asks the database's
  // cost_doc_company_barred. Unset here, as before 20261157 is pasted: the
  // function is absent (PGRST202) and the panel's own fallback answers.
  const rpc = async (name: string) => ({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache` } });
  return { supabase: { from: (t: string) => chain(t), rpc, auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/components/providers/DialogProvider", () => dlg);
vi.mock("@/lib/costDocs", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/costDocs")>()), ...cd }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async () => undefined) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/companies", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/companies")>()), ...reg }));
const nq = vi.hoisted(() => ({ notifyQuoteOutcome: vi.fn() }));
vi.mock("@/lib/intakeOutcomeNotice", () => nq);

import QuotesPanel, { noticeQuoteOutcomes } from "@/components/projects/cost/QuotesPanel";
import type { CostDocument } from "@/lib/costDocs";

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
  for (const f of [...Object.values(reg), ...Object.values(dlg), ...Object.values(cd), nq.notifyQuoteOutcome]) f.mockReset();
  nq.notifyQuoteOutcome.mockResolvedValue({ sent: true });
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

describe("MON-10 (J14) — the contractor is told how the quote was decided", () => {
  const GULF = doc({ id: "gulf", vendorName: "Gulf Mechanical", rfqGroup: "Unit 300 Repipe", intakeLinkId: "l1", totalAmount: 140_000, parsed: parsedQuote("Gulf Mechanical", 140_000, 140_000) });
  const APEX = doc({ id: "apex", vendorName: "Apex Industrial", rfqGroup: "unit 300  repipe", intakeLinkId: "l2", totalAmount: 150_000, parsed: parsedQuote("Apex Industrial", 150_000, 150_000) });
  const HAND = doc({ id: "hand", vendorName: "Harbor Welding", rfqGroup: "Unit 300 Repipe", intakeLinkId: null, totalAmount: 155_000, parsed: parsedQuote("Harbor Welding", 155_000, 155_000) });
  const OTHER = doc({ id: "other", vendorName: "Cole Paint", rfqGroup: "Paint", intakeLinkId: "l3", totalAmount: 20_000, parsed: parsedQuote("Cole Paint", 20_000, 20_000) });

  it("an award tells the awarded bidder and each open rival of its RFQ group that came through a link — never a hand-filed quote or another group's", async () => {
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: true });
    await render([GULF, APEX, HAND, OTHER]);
    await award("Gulf Mechanical");
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    const asked = nq.notifyQuoteOutcome.mock.calls.map((c) => c[1]).sort();
    expect(asked).toEqual(["apex", "gulf"]);
    for (const c of nq.notifyQuoteOutcome.mock.calls) expect(c[0]).toBe("o1");
    // the table re-reads first; a clean round of notices says nothing
    expect(events.indexOf("changed")).toBeGreaterThanOrEqual(0);
    expect(lastErr()).toBeUndefined();
  });

  it("the award's warning still stands, and a notice that failed is said beside it; the quiet answers (no contact, a rival the award did not decline) say nothing", async () => {
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: true, warning: "Awarded, but 1 of 1 competing bid(s) could not be marked not-selected — refresh and decline them by hand." });
    nq.notifyQuoteOutcome.mockImplementation(async (_o: string, id: string) => (id === "gulf" ? { sent: false, reason: "send_failed" } : { sent: false, reason: "undecided" }));
    await render([GULF, APEX]);
    await award("Gulf Mechanical");
    expect(lastErr()).toBe("Awarded, but 1 of 1 competing bid(s) could not be marked not-selected — refresh and decline them by hand. The email telling the bidder the outcome could not be sent: Gulf Mechanical (send_failed) — their portal still shows it.");
    nq.notifyQuoteOutcome.mockReset().mockResolvedValue({ sent: false, reason: "no_contact" });
    expect(await noticeQuoteOutcomes("o1", [GULF, APEX])).toBeNull();
  });

  it("a failed award tells nobody", async () => {
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockResolvedValue({ ok: false, error: "Someone else just decided this document — refresh to see the latest." });
    await render([GULF, APEX]);
    await award("Gulf Mechanical");
    expect(nq.notifyQuoteOutcome).not.toHaveBeenCalled();
    expect(lastErr()).toBe("Someone else just decided this document — refresh to see the latest.");
  });

  it("a hand decline tells that bidder (when its quote came through a link); a refused decline, and a hand-filed quote's, tell nobody", async () => {
    const LONE = doc({ ...APEX, id: "lone", rfqGroup: null });
    const LONE_HAND = doc({ ...HAND, id: "lone-hand", vendorName: "Bayline", rfqGroup: null, parsed: parsedQuote("Bayline", 155_000, 155_000) });
    await render([LONE, LONE_HAND]);
    dlg.appPrompt.mockResolvedValueOnce("");
    cd.declineQuote.mockResolvedValueOnce({ ok: false, error: "This quote is already awarded — refresh to see the latest." });
    await act(async () => { btn(rowOf("Apex Industrial"), /Decline/)!.click(); });
    await settle();
    expect(nq.notifyQuoteOutcome).not.toHaveBeenCalled();
    dlg.appPrompt.mockResolvedValueOnce("Awarded to Gulf Mechanical");
    cd.declineQuote.mockResolvedValueOnce({ ok: true });
    await act(async () => { btn(rowOf("Apex Industrial"), /Decline/)!.click(); });
    await settle();
    expect(nq.notifyQuoteOutcome).toHaveBeenCalledTimes(1);
    expect(nq.notifyQuoteOutcome).toHaveBeenCalledWith("o1", "lone");
    dlg.appPrompt.mockResolvedValueOnce("");
    cd.declineQuote.mockResolvedValueOnce({ ok: true });
    await act(async () => { btn(rowOf("Bayline"), /Decline/)!.click(); });
    await settle();
    expect(nq.notifyQuoteOutcome).toHaveBeenCalledTimes(1);
  });
});
