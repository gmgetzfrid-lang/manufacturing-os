// @vitest-environment jsdom
//
// projects Round G (J13 records reconcile, review fix pass) — committed
// pins for two records that were flipped on code that had no test:
//   * projects-tab MON-8 done-when 2: the Award button ALWAYS clears its busy
//     state — the award call sits inside try / catch / finally { setBusy(null) },
//     so a THROWN error (not only a { ok: false } result) re-enables the
//     button and reaches the user.
//   * projects-and-cost INTK-12 done-whens 1, 3 and 4, the Costs-tab half:
//     the quote-link form refuses a blank or past expiry and writes
//     expires_at; the insert reads back its id and the audit row names the
//     LINK (never token material: no INTAKE_TOKEN_PREFIX_LEN-character window
//     of the token anywhere in the row); a failed audit insert is surfaced; Revoke
//     writes only revoked_at, scoped to the project and to a still-unrevoked
//     row, reads its rows back, audits by link id, and audits nothing when
//     no row changed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Res = { data: unknown; error: null | { code?: string; message: string } };
const db = vi.hoisted(() => ({
  /** `${table}.${firstMethod}` → the result that chain resolves to. */
  byOp: {} as Record<string, Res>,
  /** table → the result of any chain without a byOp entry. */
  results: {} as Record<string, Res>,
  calls: [] as Array<{ table: string; op: string; method: string; args: unknown[] }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));
const reg = vi.hoisted(() => ({ listCompanies: vi.fn(), listBarredCompanies: vi.fn(), getCompany: vi.fn() }));
const dlg = vi.hoisted(() => ({ appPrompt: vi.fn(), appConfirm: vi.fn(), appAlert: vi.fn() }));
const cd = vi.hoisted(() => ({ awardQuote: vi.fn() }));

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
          if (prop === "insert") db.inserts.push({ table, row: args[0] as Record<string, unknown> });
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

import QuotesPanel from "@/components/projects/cost/QuotesPanel";
import { INTAKE_TOKEN_PREFIX_LEN } from "@/lib/intakeLinks";
import type { CostDocument } from "@/lib/costDocs";
import type { Company } from "@/lib/companies";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = (over: Partial<CostDocument>): CostDocument => ({
  id: "d", orgId: "o1", projectId: "p1", partyId: null, kind: "quote", fileUrl: "k", fileName: "q.pdf", mimeType: "application/pdf",
  docNumber: null, docDate: null, vendorName: null, currency: "EUR", totalAmount: null, status: "parsed", parsed: null,
  rfqGroup: "Unit 300 Repipe", intakeLinkId: null, postedAt: null, createdAt: null, ...over,
});
const docs: CostDocument[] = [
  doc({ id: "bay", vendorName: "Bayline", totalAmount: 140_000,
    parsed: { vendorName: "Bayline", total: 140_000, currency: "EUR", lineItems: [{ description: "Repipe", total: 140_000, hours: 1500 }], exclusions: [] } }),
];

let host: HTMLDivElement;
let root: Root;
let errors: Array<string | null> = [];
beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  for (const f of [...Object.values(reg), ...Object.values(dlg), cd.awardQuote]) f.mockReset();
  reg.listCompanies.mockResolvedValue([]); reg.listBarredCompanies.mockResolvedValue([]);
  db.byOp = {}; db.calls = []; db.inserts = [];
  db.results = {
    cost_documents: { data: docs.map((d) => ({ id: d.id, company_id: null, pages_total: 3, pages_read: 3 })), error: null },
    project_parties: { data: [], error: null },
  };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = async () => {
  errors = [];
  await act(async () => {
    root.render(React.createElement(QuotesPanel, {
      orgId: "o1", projectId: "p1", canManage: true, actor: { uid: "u1", email: "u1@example.com" },
      accounts: [{ id: "a1", projectId: "p1", code: null, name: "Piping", costType: null, budget: 1, currency: "EUR", partyId: null, wbsMilestoneId: null, status: "active" }],
      docs, onChanged: () => undefined, setErr: (m: string | null) => { errors.push(m); },
    }));
  });
  await settle();
};
const lastError = () => errors.filter(Boolean).at(-1);
/** Every INTAKE_TOKEN_PREFIX_LEN-character window of the token found in the
 *  serialised row — the app's own prefix (6) is the shortest fragment the
 *  lists show, so no window of that length may reach audit_logs. */
const tokenWindowsIn = (row: unknown, token: string) => {
  const json = JSON.stringify(row);
  return Array.from({ length: token.length - INTAKE_TOKEN_PREFIX_LEN + 1 }, (_, i) => token.slice(i, i + INTAKE_TOKEN_PREFIX_LEN))
    .filter((w) => json.includes(w));
};
const awardBtn = () => [...host.querySelectorAll("tbody tr button")].find((b) => /Award/.test(b.textContent ?? "")) as HTMLButtonElement;
const pickAccount = async () => {
  const sel = [...host.querySelectorAll("tbody tr select")][0] as HTMLSelectElement;
  await act(async () => { sel.value = "a1"; sel.dispatchEvent(new Event("change", { bubbles: true })); });
};

describe("MON-8 dw2 — the Award button always clears its busy state", () => {
  it("awardQuote THROWS: the error is surfaced and Award is enabled again, with no spinner", async () => {
    dlg.appConfirm.mockResolvedValue(true);
    cd.awardQuote.mockRejectedValue(new Error("Cannot read properties of undefined (reading 'toLowerCase')"));
    await render();
    await pickAccount();
    expect(awardBtn().disabled).toBe(false);
    await act(async () => { awardBtn().click(); });
    await settle();
    expect(cd.awardQuote).toHaveBeenCalledTimes(1);
    expect(lastError()).toMatch(/toLowerCase/);
    expect(awardBtn().disabled).toBe(false);
    expect(awardBtn().querySelector(".animate-spin")).toBeNull();
  });

  it("the lib asks for an override and the retry THROWS: busy still clears, and the recorded override is closed as abandoned", async () => {
    dlg.appConfirm.mockResolvedValue(true);
    dlg.appPrompt.mockResolvedValue("Sole qualified bidder for the tie-in window");
    const flagged: Pick<Company, "id" | "name" | "status"> = { id: "c-bay", name: "Bayline", status: "inactive" };
    cd.awardQuote
      .mockResolvedValueOnce({ ok: false, error: "flagged", needsOverride: { companyId: flagged.id, companyName: flagged.name, status: flagged.status } })
      .mockRejectedValueOnce(new Error("network down"));
    db.byOp["audit_logs.insert"] = { data: null, error: null };
    await render();
    await pickAccount();
    await act(async () => { awardBtn().click(); });
    await settle();
    expect(cd.awardQuote).toHaveBeenCalledTimes(2);
    expect(cd.awardQuote.mock.calls[1][0]).toMatchObject({ overrideReason: "Sole qualified bidder for the tie-in window" });
    expect(lastError()).toMatch(/network down/);
    expect(awardBtn().disabled).toBe(false);
    expect(awardBtn().querySelector(".animate-spin")).toBeNull();
    const actions = db.inserts.filter((i) => i.table === "audit_logs").map((i) => i.row.action);
    expect(actions).toEqual(["COST_DOC_AWARD_OVERRIDE_DO_NOT_USE", "COST_DOC_AWARD_OVERRIDE_ABANDONED"]);
  });
});

describe("INTK-12 — the Costs tab's quote links", () => {
  const openLinks = async () => {
    const toggle = [...host.querySelectorAll("button")].find((b) => /Quote links for contractors/.test(b.textContent ?? ""))!;
    await act(async () => { toggle.click(); });
    await settle();
  };
  const setInput = async (el: HTMLInputElement, v: string) => {
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    await act(async () => { proto.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const localIso = (days: number) => {
    const d = new Date(Date.now() + days * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const linkInserts = () => db.inserts.filter((i) => i.table === "project_intake_links");

  it("create: a blank or past expiry inserts nothing and says why; a future expiry is written; the insert reads back its id; the audit row names the link and carries no token; a failed audit is surfaced", async () => {
    db.results.project_intake_links = { data: [], error: null };
    db.byOp["project_intake_links.insert"] = { data: { id: "link-123" }, error: null };
    db.byOp["audit_logs.insert"] = { data: null, error: { message: "audit denied" } };
    await render(); await openLinks();
    const company = host.querySelector('input[placeholder="Company name"]') as HTMLInputElement;
    const expiry = host.querySelector('input[aria-label="Quote link expiry date"]') as HTMLInputElement;
    const create = [...host.querySelectorAll("button")].find((b) => /Create link/.test(b.textContent ?? ""))!;
    await setInput(company, "Gulf Mechanical");
    // blank: refused, nothing inserted
    await setInput(expiry, "");
    await act(async () => { create.click(); }); await settle();
    expect(linkInserts()).toHaveLength(0);
    expect(lastError()).toMatch(/expiry date in the future/);
    // in the past: refused, nothing inserted
    await setInput(expiry, localIso(-2));
    await act(async () => { create.click(); }); await settle();
    expect(linkInserts()).toHaveLength(0);
    expect(lastError()).toMatch(/expiry date in the future/);
    // in the future: written
    await setInput(expiry, localIso(10));
    await act(async () => { create.click(); }); await settle();
    expect(linkInserts()).toHaveLength(1);
    const ins = linkInserts()[0];
    expect(ins.row.purpose).toBe("quote");
    expect(typeof ins.row.expires_at).toBe("string");
    expect(Date.parse(String(ins.row.expires_at))).toBeGreaterThan(Date.now());
    const linkCalls = db.calls.filter((c) => c.table === "project_intake_links" && c.op === "insert").map((c) => c.method);
    expect(linkCalls).toEqual(["insert", "select", "single"]);
    const audit = db.inserts.filter((i) => i.table === "audit_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0].row.action).toBe("INTAKE_QUOTE_LINK_CREATED");
    expect(audit[0].row.resource_id).toBe("link-123");
    const token = String(ins.row.token);
    expect(token.length).toBeGreaterThan(INTAKE_TOKEN_PREFIX_LEN);
    expect(JSON.stringify(audit[0].row)).not.toContain(token.slice(0, INTAKE_TOKEN_PREFIX_LEN));
    expect(tokenWindowsIn(audit[0].row, token)).toEqual([]);
    expect(lastError()).toMatch(/audit record failed: audit denied/);
  });

  it("revoke: writes only revoked_at, scoped and read back; audits by link id; a failed audit is surfaced; zero rows audits nothing", async () => {
    db.results.project_intake_links = { data: [{ id: "L1", token_prefix: "abc123", company_name: "Bayline", rfq_group: null, revoked_at: null, expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), submission_count: 0, purpose: "quote" }], error: null };
    dlg.appConfirm.mockResolvedValue(true);
    db.byOp["project_intake_links.update"] = { data: [{ id: "L1" }], error: null };
    db.byOp["audit_logs.insert"] = { data: null, error: null };
    await render(); await openLinks();
    const revoke = () => [...host.querySelectorAll<HTMLButtonElement>("li button")].find((b) => /Revoke/.test(b.textContent ?? ""))!;
    await act(async () => { revoke().click(); }); await settle();
    const upd = db.calls.filter((c) => c.table === "project_intake_links" && c.op === "update");
    expect(Object.keys(upd[0].args[0] as object)).toEqual(["revoked_at"]);
    expect(upd.map((c) => c.method)).toEqual(["update", "eq", "eq", "is", "select"]);
    expect(upd.map((c) => c.args)).toEqual([
      [expect.objectContaining({ revoked_at: expect.any(String) })], ["id", "L1"], ["project_id", "p1"], ["revoked_at", null], ["id"],
    ]);
    let audit = db.inserts.filter((i) => i.table === "audit_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0].row).toMatchObject({ action: "INTAKE_QUOTE_LINK_REVOKED", resource_type: "project_intake_link", resource_id: "L1" });
    // a failed audit insert is surfaced, not swallowed
    db.inserts = []; db.calls = [];
    db.byOp["audit_logs.insert"] = { data: null, error: { message: "audit denied" } };
    await act(async () => { revoke().click(); }); await settle();
    expect(lastError()).toMatch(/revoked but its audit record failed: audit denied/);
    // zero rows (already revoked, or not permitted): no audit row, and the user is told
    db.inserts = []; db.calls = [];
    db.byOp["project_intake_links.update"] = { data: [], error: null };
    db.byOp["audit_logs.insert"] = { data: null, error: null };
    await act(async () => { revoke().click(); }); await settle();
    audit = db.inserts.filter((i) => i.table === "audit_logs");
    expect(audit).toHaveLength(0);
    expect(lastError()).toMatch(/was not revoked/);
  });
});
