// projects Round G — J3 MONEY-LEDGER: the money paths, driven against an
// in-memory PostgREST chain (filters, checked UPDATEs, RLS-shaped zero-row
// matches, one-shot failures).
//
//   MON-3 / COST-14  void + manual total decide against the DB row (CAS)
//   MON-1 / COST-11  post-failure + revert-failure is REPORTED as stuck; the
//                    rival-decline is checked; orphans are listed and repaired
//   MON-8            an unmapped status reads as itself, never a throw
//   MON-9            CO numbering retries on 23505, then a human message
//   MON-10           a grouped award declines its group's open rivals; an
//                    ungrouped award declines nothing and names the open
//                    ungrouped quotes; declineQuote is the explicit decline
//   MON-11           award + CO approval notify through lib/notify
//   MON-12           do-not-use / inactive companies need a reasoned, audited override
//   COST-6           self-decision refused while another decider exists; org threshold
//   COST-8           currency mismatch refused at posting
//   COST-9           source_document_id on every posted entry; unwind voids exactly posted_entry_id
//   COST-13          a truncated / unknown-extent read needs the total typed back
//   SAF-3 / REL-2    zero-row writes write no audit row; failed reads throw
//   review fix pass 2: legacy (pre-Round-G, unlinked) entries attend their
//   document; the orphan line waits for 20261093; approved COs whose entry
//   is void stop revising the budget, are listed, and are repaired (link /
//   reverse); an already-void entry does not block the unwind
//   verification fix (2026-09-30): the linked entries' status is read by id
//   (not from the loaded page) and the CO summary counts by the same rule;
//   Reverse on an already-void entry applies the repair's look-alike check;
//   the typed-back confirmation is explicit (confirmedTotal); a document
//   whose entry was voided by hand is not reverted

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── an in-memory PostgREST chain ────────────────────────────────────────────
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  /** Positional failures per `${table}:${op}` (op = select | update | insert):
   *  each call shifts one entry; `null` lets that call pass, an error fails it. */
  fail: {} as Record<string, Array<{ message: string; code?: string } | null>>,
  /** Tables whose UPDATE matches zero rows — the shape an RLS filter produces. */
  denyUpdate: new Set<string>(),
  seq: 0,
}));
function takeFail(table: string, op: string) {
  const q = db.fail[`${table}:${op}`];
  return q && q.length ? q.shift() ?? null : null;
}
function chain(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  let mode: "select" | "update" | "insert" = "select";
  let patch: Row = {};
  let insertRow: Row | null = null;
  const rows = () => (db.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
  const applyUpdate = () => {
    const err = takeFail(table, "update");
    if (err) return { data: null, error: err };
    if (db.denyUpdate.has(table)) return { data: [], error: null };
    const hit = rows();
    for (const r of hit) Object.assign(r, patch);
    return { data: hit.map((r) => ({ id: r.id })), error: null };
  };
  const applyInsert = () => {
    const err = takeFail(table, "insert");
    if (err) return { data: null, error: err };
    const row = { id: `${table}-${++db.seq}`, ...insertRow };
    (db.tables[table] ??= []).push(row);
    return { data: row, error: null };
  };
  const applySelect = () => {
    const err = takeFail(table, "select");
    if (err) return { data: null, error: err };
    return { data: rows(), error: null };
  };
  const c: Row = {};
  const h: ProxyHandler<Row> = {
    get(_t, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) =>
          resolve(mode === "update" ? applyUpdate() : mode === "insert" ? applyInsert() : applySelect());
      }
      return (...args: unknown[]) => {
        switch (prop) {
          case "eq": preds.push((r) => r[args[0] as string] === args[1]); break;
          case "neq": preds.push((r) => r[args[0] as string] !== args[1]); break;
          case "in": preds.push((r) => (args[1] as unknown[]).includes(r[args[0] as string])); break;
          case "is": preds.push((r) => (args[1] === null ? r[args[0] as string] == null : r[args[0] as string] === args[1])); break;
          case "not": {
            const [col, op, val] = args as [string, string, unknown];
            if (op === "is") preds.push((r) => !(val === null ? r[col] == null : r[col] === val));
            break;
          }
          case "ilike": {
            const want = String(args[1]).replace(/\\([%_\\])/g, "$1").toLowerCase();
            preds.push((r) => String(r[args[0] as string] ?? "").toLowerCase() === want);
            break;
          }
          case "update": mode = "update"; patch = args[0] as Row; break;
          case "insert": mode = "insert"; insertRow = args[0] as Row; break;
          case "select":
            if (mode === "update") return Promise.resolve(applyUpdate());
            break;
          case "maybeSingle": case "single": {
            if (mode === "insert") return Promise.resolve(applyInsert());
            const out = applySelect();
            return Promise.resolve({ data: out.error ? null : (out.data as Row[])[0] ?? null, error: out.error });
          }
          default: break; // order, limit — no-ops
        }
        return new Proxy(c, h);
      };
    },
  };
  return new Proxy(c, h);
}
const emitted = vi.hoisted(() => [] as Array<Row>);
const audited = vi.hoisted(() => [] as Array<Row>);
const deleted = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock("@/lib/notify/dispatch", () => ({ emit: vi.fn(async (e: Row) => { emitted.push(e); }) }));
vi.mock("@/lib/audit", () => ({ logAuditAction: vi.fn(async (e: Row) => { audited.push(e); }) }));
vi.mock("@/lib/storage", () => ({
  uploadToPath: vi.fn(async () => undefined),
  deleteFile: vi.fn(async (p: string) => { deleted.push(p); }),
}));

import {
  awardQuote, declineQuote, postInvoice, voidCostDoc, setManualTotal, listLedgerOrphans, repairCostDoc, costDocStatusLabel,
  uploadCostDoc, listCostDocs, normalizeCurrency, type CostDocument,
} from "@/lib/costDocs";
import {
  proposeChangeOrder, decideChangeOrder, unwindChangeOrder, listChangeOrders, repairChangeOrder,
  approvedChangesByAccount, changeOrderOnLedger, summarizeChangeOrders, parseThresholdAmount, isReversal, type ChangeOrder,
} from "@/lib/changeOrders";
import { voidEntry, listAccounts, listEntries, saveAccount, NO_ROW_MATCHED } from "@/lib/costs";

const actor = { uid: "u-owner", email: "owner@x.test" };
const docRow = (over: Row): Row => ({
  id: "d1", org_id: "o1", project_id: "p1", party_id: null, kind: "quote", status: "parsed",
  total_amount: 1000, vendor_name: "Acme", rfq_group: "G1", currency: null, doc_number: "Q-1", file_name: "q.pdf", parsed: null,
  ...over,
});
const doc = (over: Partial<CostDocument> = {}): CostDocument => ({
  id: "d1", orgId: "o1", projectId: "p1", partyId: null, kind: "quote", fileUrl: null, fileName: "q.pdf", mimeType: null,
  docNumber: "Q-1", docDate: null, vendorName: "Acme", currency: null, totalAmount: 1000, status: "parsed", parsed: null,
  rfqGroup: "G1", intakeLinkId: null, postedAt: null, createdAt: null, ...over,
});
const coRow = (over: Row): Row => ({
  id: "co1", org_id: "o1", project_id: "p1", cost_account_id: "a1", party_id: null, co_number: "CO-001", title: "More pipe",
  description: null, amount: 500, reason_code: "field_condition", status: "proposed", decided_at: null, decided_by: null,
  decided_by_name: null, decision_note: null, posted_entry_id: null, created_by: "u-proposer", created_by_name: "prop", created_at: null,
  ...over,
});
const co = (over: Partial<ChangeOrder> = {}): ChangeOrder => ({
  id: "co1", orgId: "o1", projectId: "p1", costAccountId: "a1", partyId: null, coNumber: "CO-001", title: "More pipe",
  description: null, amount: 500, reasonCode: "field_condition", status: "proposed", decidedAt: null, decidedBy: null,
  decidedByName: null, decisionNote: null, createdBy: "u-proposer", createdByName: "prop", createdAt: null,
  postedEntryId: null, selfDecided: false, ...over,
});
const auditRows = (action: string) => (db.tables.audit_logs ?? []).filter((r) => r.action === action);
const entries = () => db.tables.cost_entries ?? [];

beforeEach(() => {
  db.tables = {
    cost_documents: [], cost_entries: [], cost_accounts: [{ id: "a1", currency: "USD" }], change_orders: [],
    audit_logs: [], project_parties: [], companies: [], projects: [{ id: "p1", owner_user_id: "u-owner" }],
    org_members: [{ uid: "u-owner", org_id: "o1", status: "active", role: "Requester", roles: [] }],
    org_configurations: [],
  };
  db.fail = {};
  db.denyUpdate = new Set();
  db.seq = 0;
  emitted.length = 0; audited.length = 0; deleted.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

// ── MON-3 / COST-14 ─────────────────────────────────────────────────────────
describe("void + manual total decide against the DATABASE row (MON-3 / COST-14)", () => {
  it("voiding a document whose stored status is awarded is refused even when the snapshot says parsed", async () => {
    db.tables.cost_documents.push(docRow({ status: "awarded" }));
    const res = await voidCostDoc({ doc: doc({ status: "parsed" }), actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already awarded/);
    expect(db.tables.cost_documents[0].status).toBe("awarded");
    expect(auditRows("COST_DOC_VOIDED")).toHaveLength(0);
  });

  it("a void that loses the race (zero rows matched) is reported, and a real void does not stamp posted_at", async () => {
    db.tables.cost_documents.push(docRow({ status: "parsed" }));
    db.denyUpdate.add("cost_documents");
    const lost = await voidCostDoc({ doc: doc(), actor });
    expect(lost.ok).toBe(false);
    expect(lost.error).toMatch(/Someone else just decided/);
    db.denyUpdate.clear();
    const res = await voidCostDoc({ doc: doc(), actor });
    expect(res.ok).toBe(true);
    expect(db.tables.cost_documents[0].status).toBe("void");
    expect(db.tables.cost_documents[0].posted_at).toBeUndefined();
    expect(auditRows("COST_DOC_VOIDED")).toHaveLength(1);
  });

  it("setting a manual total on an awarded document is refused with the row's real status; a draft takes it and becomes parsed", async () => {
    db.tables.cost_documents.push(docRow({ status: "awarded", total_amount: 1000 }));
    const res = await setManualTotal({ doc: doc({ status: "parsed" }), total: 5, actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already awarded — its total is locked/);
    expect(db.tables.cost_documents[0].total_amount).toBe(1000);
    expect(auditRows("COST_DOC_MANUAL_TOTAL")).toHaveLength(0);

    db.tables.cost_documents.push(docRow({ id: "d2", status: "draft", total_amount: null }));
    const ok = await setManualTotal({ doc: doc({ id: "d2", status: "draft", totalAmount: null }), total: 250, actor });
    expect(ok.ok).toBe(true);
    expect(db.tables.cost_documents[1]).toMatchObject({ status: "parsed", total_amount: 250 });
  });

  it("review fix: a refused manual-total UPDATE reads as a refused WRITE (never as a failed read), logged under setManualTotal", async () => {
    db.tables.cost_documents.push(docRow({ status: "parsed", total_amount: 1000 }));
    db.fail["cost_documents:update"] = [{ message: 'new row violates row-level security policy for table "cost_documents"', code: "42501" }];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await setManualTotal({ doc: doc({ status: "parsed" }), total: 5, actor });
    expect(res).toEqual({ ok: false, error: "You don't have permission to do this — nothing was changed." });
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("setManualTotal");
    errSpy.mockRestore();
    expect(db.tables.cost_documents[0].total_amount).toBe(1000);
  });

  it("a DECLINED document moved no money: it can be voided, and a typed total corrects it WITHOUT reopening it", async () => {
    db.tables.cost_documents.push(docRow({ status: "declined", total_amount: 1000 }), docRow({ id: "d2", status: "declined" }));
    const fixed = await setManualTotal({ doc: doc({ status: "declined" }), total: 900, actor });
    expect(fixed.ok).toBe(true);
    expect(db.tables.cost_documents[0]).toMatchObject({ status: "declined", total_amount: 900 });
    expect(auditRows("COST_DOC_MANUAL_TOTAL")).toHaveLength(1);

    const voided = await voidCostDoc({ doc: doc({ id: "d2", status: "declined" }), actor });
    expect(voided.ok).toBe(true);
    expect(db.tables.cost_documents[1].status).toBe("void");
    expect(auditRows("COST_DOC_VOIDED")).toHaveLength(1);
  });

  it("a posted invoice still refuses both, whatever the snapshot says (the allowed set is every status that moved no money)", async () => {
    db.tables.cost_documents.push(docRow({ kind: "invoice", status: "posted", total_amount: 700 }));
    const v = await voidCostDoc({ doc: doc({ kind: "invoice", status: "declined" }), actor });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/already posted to budget/);
    const t = await setManualTotal({ doc: doc({ kind: "invoice", status: "declined" }), total: 5, actor });
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/already posted to budget — its total is locked/);
    expect(db.tables.cost_documents[0]).toMatchObject({ status: "posted", total_amount: 700 });
  });
});

// ── MON-8 ───────────────────────────────────────────────────────────────────
describe("an unmapped status is readable, never a throw (MON-8)", () => {
  it("costDocStatusLabel is total; the award path names the odd status instead of hanging", async () => {
    expect(costDocStatusLabel("awarded")).toBe("Awarded");
    expect(costDocStatusLabel("restored_weird")).toBe("restored_weird");
    db.tables.cost_documents.push(docRow({ status: "restored_weird" }));
    const res = await awardQuote({ doc: doc(), siblings: [], costAccountId: "a1", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("This document is already restored_weird — refresh to see the latest.");
  });
});

// ── awardQuote ──────────────────────────────────────────────────────────────
describe("awardQuote — the award as a checked transaction (MON-1 / MON-10 / MON-11 / MON-12 / COST-8 / COST-9 / COST-11)", () => {
  it("posts the commitment WITH the document as its source, declines the group's open rivals, audits and notifies the owner", async () => {
    db.tables.cost_documents.push(
      docRow({}),
      docRow({ id: "r1", vendor_name: "Rival", status: "parsed" }),
      docRow({ id: "r2", vendor_name: "Other group", status: "parsed", rfq_group: "G2" }),
      docRow({ id: "r3", vendor_name: "Ungrouped", status: "parsed", rfq_group: null }),
    );
    const siblings = [doc(), doc({ id: "r1", vendorName: "Rival" }), doc({ id: "r2", rfqGroup: "G2" }), doc({ id: "r3", rfqGroup: null })];
    const res = await awardQuote({ doc: doc(), siblings, costAccountId: "a1", actor: { uid: "u-ctl", email: "ctl@x.test" } });
    expect(res).toEqual({ ok: true });
    expect(db.tables.cost_documents[0].status).toBe("awarded");
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ entry_type: "commitment", amount: 1000, source_document_id: "d1", cost_account_id: "a1" });
    expect(db.tables.cost_documents.map((d) => d.status)).toEqual(["awarded", "declined", "parsed", "parsed"]);
    const a = auditRows("COST_DOC_AWARDED");
    expect(a).toHaveLength(1);
    expect(a[0].details).toMatchObject({ rivalsDeclined: 1, postedEntryId: entries()[0].id });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ kind: "project_status", category: "status", resource: { type: "project", id: "p1" } });
    expect((emitted[0].audience as { involved: string[] }).involved).toEqual(["u-owner"]);
  });

  it("MON-10: an UNGROUPED award declines NOTHING — unrelated ungrouped bids stay awardable and the caller is told which stay open", async () => {
    // Two intake-link quotes with a null group (the common case): Acme Electrical
    // and Bravo Plumbing are different scopes. Awarding Acme must not kill Bravo.
    db.tables.cost_documents.push(
      docRow({ rfq_group: null, vendor_name: "Acme Electrical" }),
      docRow({ id: "r1", status: "parsed", rfq_group: null, vendor_name: "Bravo Plumbing" }),
      docRow({ id: "r2", status: "draft", rfq_group: null, vendor_name: "Cole Paint" }),
      docRow({ id: "r3", status: "parsed", rfq_group: "G9" }),
      docRow({ id: "r4", status: "declined", rfq_group: null }),
    );
    const siblings = [doc({ rfqGroup: null, vendorName: "Acme Electrical" }), doc({ id: "r1", rfqGroup: null, vendorName: "Bravo Plumbing" }),
      doc({ id: "r2", rfqGroup: null, status: "draft", vendorName: "Cole Paint" }),
      doc({ id: "r3", rfqGroup: "G9" }), doc({ id: "r4", rfqGroup: null, status: "declined" })];
    const res = await awardQuote({ doc: doc({ rfqGroup: null, vendorName: "Acme Electrical" }), siblings, costAccountId: "a1", actor });
    expect(res.ok).toBe(true);
    expect(db.tables.cost_documents.map((d) => d.status)).toEqual(["awarded", "parsed", "draft", "parsed", "declined"]);
    expect(res.warning).toBe("Awarded. 2 other ungrouped quotes stay open (Bravo Plumbing, Cole Paint) — decline them if they competed for this scope.");
    expect(auditRows("COST_DOC_AWARDED")[0].details).toMatchObject({ rivalsDeclined: 0, ungroupedLeftOpen: 2 });

    // Bravo is still awardable on its own budget line.
    const bravo = await awardQuote({ doc: doc({ id: "r1", rfqGroup: null, vendorName: "Bravo Plumbing" }), siblings: [], costAccountId: "a1", actor });
    expect(bravo).toEqual({ ok: true });
    expect(db.tables.cost_documents[1].status).toBe("awarded");
  });

  it("MON-10: declineQuote is the explicit, audited decline — draft|parsed only, no posted_at stamp, never an awarded bid", async () => {
    db.tables.cost_documents.push(docRow({ id: "r1", rfq_group: null, status: "parsed" }), docRow({ id: "r2", status: "awarded" }));
    const ok = await declineQuote({ doc: doc({ id: "r1", rfqGroup: null }), actor, reason: "Competed with the Acme award" });
    expect(ok).toEqual({ ok: true });
    expect(db.tables.cost_documents[0].status).toBe("declined");
    expect(db.tables.cost_documents[0].posted_at).toBeUndefined();
    expect(auditRows("COST_DOC_DECLINED")[0].details).toMatchObject({ reason: "Competed with the Acme award", rfqGroup: null });

    const stale = await declineQuote({ doc: doc({ id: "r2", status: "parsed" }), actor });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/already awarded/);
    expect(db.tables.cost_documents[1].status).toBe("awarded");

    db.tables.cost_documents.push(docRow({ id: "i1", kind: "invoice" }));
    expect((await declineQuote({ doc: doc({ id: "i1", kind: "invoice" }), actor })).ok).toBe(false);
    expect(auditRows("COST_DOC_DECLINED")).toHaveLength(1);
  });

  it("MON-10: a grouped award names no ungrouped quotes — they are not its scope", async () => {
    db.tables.cost_documents.push(docRow({}), docRow({ id: "u1", rfq_group: null }));
    const res = await awardQuote({ doc: doc(), siblings: [doc(), doc({ id: "u1", rfqGroup: null })], costAccountId: "a1", actor });
    expect(res).toEqual({ ok: true });
    expect(db.tables.cost_documents[1].status).toBe("parsed");
  });

  it("MON-1: post failure + revert failure is reported as STUCK with the document id, never silence", async () => {
    db.tables.cost_documents.push(docRow({}));
    db.fail["cost_entries:insert"] = [{ message: "network dropped" }];
    // 1st cost_documents UPDATE = the claim (passes); 2nd = the revert (fails).
    db.fail["cost_documents:update"] = [null, { message: "revert refused" }];
    const res = await awardQuote({ doc: doc(), siblings: [], costAccountId: "a1", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/stuck as awarded/);
    expect(res.error).toContain("d1");
    expect(res.error).toContain("network dropped");
    expect(entries()).toHaveLength(0);
  });

  it("MON-1: post failure with a clean revert reports the post error and the document is back to parsed", async () => {
    db.tables.cost_documents.push(docRow({}));
    db.fail["cost_entries:insert"] = [{ message: "RLS refused" }];
    const res = await awardQuote({ doc: doc(), siblings: [], costAccountId: "a1", actor });
    expect(res).toEqual({ ok: false, error: "RLS refused" });
    expect(db.tables.cost_documents[0]).toMatchObject({ status: "parsed", posted_at: null, posted_by: null });
  });

  it("COST-11: a failed rival-decline is a PARTIAL outcome — awarded, with a warning naming the count", async () => {
    db.tables.cost_documents.push(docRow({}), docRow({ id: "r1", status: "parsed" }));
    db.fail["cost_documents:update"] = [null, { message: "timeout" }];   // claim passes; the rival-decline fails
    const res = await awardQuote({ doc: doc(), siblings: [doc(), doc({ id: "r1" })], costAccountId: "a1", actor });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/1 of 1 competing bid\(s\) could not be marked not-selected/);
    expect(res.warning).toContain("timeout");
    expect(db.tables.cost_documents[1].status).toBe("parsed");
  });

  it("COST-8: a document in another currency than the budget line is refused BEFORE the claim", async () => {
    db.tables.cost_documents.push(docRow({ currency: "EUR" }));
    const res = await awardQuote({ doc: doc({ currency: "EUR" }), siblings: [], costAccountId: "a1", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/in EUR but the budget line is in USD/);
    expect(db.tables.cost_documents[0].status).toBe("parsed");
    expect(entries()).toHaveLength(0);
    // the same rule on invoices
    db.tables.cost_documents.push(docRow({ id: "i1", kind: "invoice", currency: "eur" }));
    const inv = await postInvoice({ doc: doc({ id: "i1", kind: "invoice", currency: "eur" }), costAccountId: "a1", actor });
    expect(inv.ok).toBe(false);
    expect(inv.error).toMatch(/EUR/);
  });

  it("MON-12: a do-not-use company (by the party's registry link) needs a reasoned override, which is audited by company id", async () => {
    db.tables.project_parties.push({ id: "pp1", company_id: "c1" });
    db.tables.companies.push({ id: "c1", org_id: "o1", name: "Acme", status: "do_not_use" });
    db.tables.cost_documents.push(docRow({ party_id: "pp1" }));
    const refused = await awardQuote({ doc: doc({ partyId: "pp1" }), siblings: [], costAccountId: "a1", actor });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/DO NOT USE/);
    // The caller is told the refusal is the flag alone, so it can ask for a reason.
    expect(refused.needsOverride).toEqual({ companyId: "c1", companyName: "Acme", status: "do_not_use" });
    expect(db.tables.cost_documents[0].status).toBe("parsed");

    const ok = await awardQuote({ doc: doc({ partyId: "pp1" }), siblings: [], costAccountId: "a1", actor, overrideReason: "Sole source; VP approved" });
    expect(ok.ok).toBe(true);
    const ov = auditRows("COST_DOC_AWARD_OVERRIDE");
    expect(ov).toHaveLength(1);
    expect(ov[0].details).toMatchObject({ companyId: "c1", companyStatus: "do_not_use", reason: "Sole source; VP approved" });
  });

  it("MON-12: an inactive company matched by exact name is refused the same way; an unknown vendor is not blocked", async () => {
    db.tables.companies.push({ id: "c2", org_id: "o1", name: "acme", status: "inactive" });
    db.tables.cost_documents.push(docRow({}));
    const refused = await awardQuote({ doc: doc(), siblings: [], costAccountId: "a1", actor });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/inactive/);
    expect(refused.needsOverride).toEqual({ companyId: "c2", companyName: "acme", status: "inactive" });
    db.tables.cost_documents.push(docRow({ id: "d2", vendor_name: "Nobody Known" }));
    const ok = await awardQuote({ doc: doc({ id: "d2", vendorName: "Nobody Known" }), siblings: [], costAccountId: "a1", actor });
    expect(ok.ok).toBe(true);
  });

  it("COST-9: postInvoice writes the invoice as the actual's source document", async () => {
    db.tables.cost_documents.push(docRow({ id: "i1", kind: "invoice", doc_number: "INV-7" }));
    const res = await postInvoice({ doc: doc({ id: "i1", kind: "invoice" }), costAccountId: "a1", actor });
    expect(res.ok).toBe(true);
    expect(entries()[0]).toMatchObject({ entry_type: "actual", source_document_id: "i1", reference: "INV-7" });
  });
});

// ── reconciliation + repair ─────────────────────────────────────────────────
describe("orphans are listed and repaired, never deleted (MON-1 / COST-11 dw3)", () => {
  it("lists awarded/posted paper with no entry and approved COs with no link; linked paper is not an orphan", async () => {
    db.tables.cost_documents.push(docRow({ id: "stuck", status: "awarded" }), docRow({ id: "fine", status: "awarded" }), docRow({ id: "open", status: "parsed" }));
    db.tables.cost_entries.push({ id: "e1", org_id: "o1", project_id: "p1", status: "posted", source_document_id: "fine" });
    db.tables.change_orders.push(coRow({ id: "co-orphan", status: "approved", posted_entry_id: null }), coRow({ id: "co-ok", status: "approved", posted_entry_id: "e1" }));
    const o = await listLedgerOrphans("o1", "p1");
    expect(o.docs.map((d) => d.id)).toEqual(["stuck"]);
    expect(o.changeOrders.map((c) => c.id)).toEqual(["co-orphan"]);
  });

  it("a document whose linked entry was VOIDED by hand is attended — not listed, and never re-posted at its locked total", async () => {
    // Award posted $1000; the controller found the quote was wrong, voided the
    // entry (the MOVED_MONEY instruction) and hand-posted the right amount.
    db.tables.cost_documents.push(docRow({ id: "d1", status: "awarded" }));
    db.tables.cost_entries.push({ id: "e1", org_id: "o1", project_id: "p1", status: "void", source_document_id: "d1" });
    const o = await listLedgerOrphans("o1", "p1");
    expect(o.docs).toEqual([]);
    const res = await repairCostDoc({ doc: doc({ status: "awarded" }), action: "repost", costAccountId: "a1", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/voided by hand/);
    expect(entries()).toHaveLength(1);
    expect(auditRows("COST_DOC_REPAIRED")).toHaveLength(0);
    // Verification fix: nor is it reverted — reopening it would let it be
    // awarded again, a second commitment beside the hand-posted correction.
    const back = await repairCostDoc({ doc: doc({ status: "awarded" }), action: "revert", actor });
    expect(back.ok).toBe(false);
    expect(back.error).toMatch(/voided by hand — that void was the correction, so the document is not reopened/);
    expect(db.tables.cost_documents[0].status).toBe("awarded");
    expect(auditRows("COST_DOC_REPAIRED")).toHaveLength(0);
    // …and with it still awarded, the Award path cannot post it a second time.
    const again = await awardQuote({ doc: doc(), siblings: [], costAccountId: "a1", actor });
    expect(again.ok).toBe(false);
    expect(entries()).toHaveLength(1);
  });

  it("re-post posts the missing commitment with the document as source and audits; a second repair is refused", async () => {
    db.tables.cost_documents.push(docRow({ status: "awarded" }));
    const res = await repairCostDoc({ doc: doc({ status: "awarded" }), action: "repost", costAccountId: "a1", actor });
    expect(res.ok).toBe(true);
    expect(entries()[0]).toMatchObject({ entry_type: "commitment", amount: 1000, source_document_id: "d1" });
    expect(auditRows("COST_DOC_REPAIRED")[0].details).toMatchObject({ action: "repost", postedEntryId: entries()[0].id });
    const again = await repairCostDoc({ doc: doc({ status: "awarded" }), action: "repost", costAccountId: "a1", actor });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already has its cost entry/);
    expect(entries()).toHaveLength(1);
  });

  it("revert puts a stuck award back to parsed, audited", async () => {
    db.tables.cost_documents.push(docRow({ status: "awarded", posted_at: "2026-01-01" }));
    const res = await repairCostDoc({ doc: doc({ status: "awarded" }), action: "revert", actor });
    expect(res.ok).toBe(true);
    expect(db.tables.cost_documents[0]).toMatchObject({ status: "parsed", posted_at: null });
    expect(auditRows("COST_DOC_REPAIRED")[0].details).toMatchObject({ action: "revert", from: "awarded", to: "parsed" });
  });

  it("a parsed document is nothing to repair", async () => {
    db.tables.cost_documents.push(docRow({ status: "parsed" }));
    const res = await repairCostDoc({ doc: doc(), action: "revert", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing to repair/);
  });
});

// ── change orders ───────────────────────────────────────────────────────────
describe("change orders — numbering, authority, unwind (MON-9 / COST-6 / COST-9 / COST-11 / MON-11)", () => {
  const propose = () => proposeChangeOrder({ orgId: "o1", projectId: "p1", costAccountId: "a1", title: "T", amount: 100, reasonCode: "other", actorId: "u-owner" });

  it("MON-9: two concurrent proposals both succeed with distinct numbers — the loser retries past the collision", async () => {
    db.tables.change_orders.push(coRow({ id: "x", co_number: "CO-001" }));
    db.fail["change_orders:insert"] = [{ message: "duplicate key value violates unique constraint", code: "23505" }];
    const c = await propose();
    expect(c.coNumber).toBe("CO-003");     // CO-002 collided (the rival's row not yet visible) → steps past it
    expect(db.tables.change_orders.map((r) => r.co_number)).toEqual(["CO-001", "CO-003"]);
  });

  it("MON-9: three collisions produce a human sentence, never the constraint text", async () => {
    const dup = { message: "duplicate key value violates unique constraint", code: "23505" };
    db.fail["change_orders:insert"] = [dup, dup, dup];
    await expect(propose()).rejects.toThrow(/numbered at the same moment/);
    await expect(propose()).resolves.toMatchObject({ coNumber: "CO-001" });
  });

  it("COST-6: the proposer cannot decide their own CO while another eligible decider exists; the refusal says so", async () => {
    db.tables.change_orders.push(coRow({ created_by: "u-owner" }));
    db.tables.org_members.push({ uid: "u-ctl", org_id: "o1", status: "active", role: "Requester", roles: ["DocCtrl"] });
    await expect(decideChangeOrder({ co: co({ createdBy: "u-owner" }), decision: "approved", shownAmount: 500, shownAccountId: "a1", actorId: "u-owner" }))
      .rejects.toThrow(/second person has to decide it \(1 other eligible decider/);
    expect(db.tables.change_orders[0].status).toBe("proposed");
    expect(entries()).toHaveLength(0);
  });

  it("COST-6: with nobody else able to decide, the self-decision goes through and is MARKED", async () => {
    db.tables.change_orders.push(coRow({ created_by: "u-owner" }));
    const out = await decideChangeOrder({ co: co({ createdBy: "u-owner" }), decision: "approved", shownAmount: 500, shownAccountId: "a1", actorId: "u-owner" });
    expect(out.warning).toBeNull();
    expect(db.tables.change_orders[0]).toMatchObject({ status: "approved", decided_by: "u-owner" });
    expect(audited.find((a) => a.action === "CHANGE_ORDER_APPROVED")?.details).toMatchObject({ selfDecided: true });
    const [row] = await listChangeOrders("p1");
    expect(row.selfDecided).toBe(true);
    expect(row.postedEntryId).toBe(entries()[0].id);
  });

  it("COST-6: above the org's threshold only a controller approves — the owner is refused, a DocCtrl holder is not", async () => {
    db.tables.org_configurations.push({ org_id: "o1", key: "change_order_approval_threshold", data: { amount: 1000 } });
    db.tables.org_members.push({ uid: "u-ctl", org_id: "o1", status: "active", role: "Requester", roles: ["DocCtrl"] });
    db.tables.change_orders.push(coRow({ amount: 5000 }));
    await expect(decideChangeOrder({ co: co({ amount: 5000 }), decision: "approved", shownAmount: 5000, shownAccountId: "a1", actorId: "u-owner" }))
      .rejects.toThrow(/above this org's change-order approval threshold \(1,000\)/);
    expect(db.tables.change_orders[0].status).toBe("proposed");
    const out = await decideChangeOrder({ co: co({ amount: 5000 }), decision: "approved", shownAmount: 5000, shownAccountId: "a1", actorId: "u-ctl" });
    expect(out.warning).toBeNull();
    expect(db.tables.change_orders[0].status).toBe("approved");
    expect(entries()[0]).toMatchObject({ entry_type: "commitment", amount: 5000 });
  });

  it("MON-11: an approval notifies the proposer (and not the decider)", async () => {
    db.tables.change_orders.push(coRow({}));
    await decideChangeOrder({ co: co(), decision: "approved", shownAmount: 500, shownAccountId: "a1", actorId: "u-owner", actorName: "owner" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ kind: "project_status", actorUserId: "u-owner" });
    expect((emitted[0].audience as { involved: string[] }).involved).toEqual(["u-proposer"]);
  });

  it("COST-11: post failure + revert failure names the CO as stuck; a saved-link failure is a warning on success", async () => {
    db.tables.change_orders.push(coRow({}));
    db.fail["cost_entries:insert"] = [{ message: "insert refused" }];
    db.fail["change_orders:update"] = [null, { message: "revert refused" }];   // claim passes; the revert fails
    await expect(decideChangeOrder({ co: co(), decision: "approved", shownAmount: 500, shownAccountId: "a1", actorId: "u-owner" }))
      .rejects.toThrow(/insert refused AND the change order could not be put back \(revert refused\) — CO-001 is stuck as approved/);

    db.tables.change_orders = [coRow({ id: "co2", co_number: "CO-002" })];
    db.fail["change_orders:update"] = [null, { message: "link refused" }];     // claim passes; the posted_entry_id write fails
    const out = await decideChangeOrder({ co: co({ id: "co2", coNumber: "CO-002" }), decision: "approved", shownAmount: 500, shownAccountId: "a1", actorId: "u-owner" });
    expect(out.warning).toMatch(/CO-002 was approved and its money posted, but the link/);
    expect(entries()).toHaveLength(1);
  });

  it("REL-9 / COST-9: the unwind voids EXACTLY posted_entry_id, marks the CO void and records the entry id", async () => {
    db.tables.cost_entries.push(
      { id: "e-co", org_id: "o1", project_id: "p1", status: "posted", amount: 500, entry_type: "commitment" },
      { id: "e-other", org_id: "o1", project_id: "p1", status: "posted", amount: 500, entry_type: "commitment" },
    );
    db.tables.change_orders.push(coRow({ status: "approved", posted_entry_id: "e-co", decided_by: "u-owner" }));
    await unwindChangeOrder({ co: co({ status: "approved", postedEntryId: "e-co" }), note: "wrong contractor", actorId: "u-ctl", actorName: "bob" });
    expect(db.tables.cost_entries.map((e) => e.status)).toEqual(["void", "posted"]);
    // the reverser and the date are on the note; decided_by keeps the approver
    expect(db.tables.change_orders[0]).toMatchObject({ status: "void", decided_by: "u-owner" });
    expect(String(db.tables.change_orders[0].decision_note)).toMatch(/^Reversed by bob on \d{4}-\d{2}-\d{2}: wrong contractor$/);
    const [row] = await listChangeOrders("p1");
    expect(isReversal(row)).toBe(true);
    expect(audited.find((a) => a.action === "CHANGE_ORDER_VOIDED")?.details).toMatchObject({
      reversedEntryId: "e-co", coNumber: "CO-001", alreadyVoided: false, approvedBy: "u-owner",
    });
    expect(auditRows("COST_ENTRY_VOIDED")).toHaveLength(1);
  });

  it("an unwind with no linked entry is refused and points at the reconciliation line; a failed void changes nothing", async () => {
    db.tables.change_orders.push(coRow({ status: "approved", posted_entry_id: null }));
    await expect(unwindChangeOrder({ co: co({ status: "approved" }), actorId: "u-owner" })).rejects.toThrow(/no linked cost entry/);
    // a linked entry that cannot be found is refused BEFORE anything is written
    db.tables.change_orders = [coRow({ status: "approved", posted_entry_id: "missing" })];
    await expect(unwindChangeOrder({ co: co({ status: "approved", postedEntryId: "missing" }), actorId: "u-owner" }))
      .rejects.toThrow(/linked cost entry can't be found — it is listed under "Ledger needs attention"/);
    expect(db.tables.change_orders[0].status).toBe("approved");
    // the money moves FIRST: a void that fails leaves the CO untouched (no put-back needed)
    db.tables.cost_entries.push({ id: "e-co", org_id: "o1", project_id: "p1", status: "posted", amount: 500, entry_type: "commitment" });
    db.tables.change_orders = [coRow({ status: "approved", posted_entry_id: "e-co" })];
    db.fail["cost_entries:update"] = [{ message: "void refused" }];
    await expect(unwindChangeOrder({ co: co({ status: "approved", postedEntryId: "e-co" }), actorId: "u-owner" }))
      .rejects.toThrow(/Couldn't void CO-001's cost entry \(void refused\) — nothing was changed; the change order is still approved/);
    expect(db.tables.change_orders[0]).toMatchObject({ status: "approved", decision_note: null });
    expect(db.tables.cost_entries[0].status).toBe("posted");
    expect(audited.filter((a) => a.action === "CHANGE_ORDER_VOIDED")).toHaveLength(0);
  });

  it("second verification fix: the unwind voids the entry BEFORE the CO — a CO claim that then fails is said out loud and leaves a listed orphan", async () => {
    db.tables.cost_entries.push({ id: "e-co", org_id: "o1", project_id: "p1", status: "posted", amount: 500, entry_type: "commitment" });
    db.tables.change_orders.push(coRow({ status: "approved", posted_entry_id: "e-co", decided_by: "u-ctl" }));
    db.fail["change_orders:update"] = [{ message: "claim refused" }];
    await expect(unwindChangeOrder({ co: co({ status: "approved", postedEntryId: "e-co" }), actorId: "u-owner" }))
      .rejects.toThrow(/CO-001's cost entry is void, but the change order could not be marked void \(claim refused\) — it no longer revises the budget and is listed under "Ledger needs attention"/);
    expect(db.tables.cost_entries[0].status).toBe("void");
    expect(db.tables.change_orders[0].status).toBe("approved");
    expect((await listLedgerOrphans("o1", "p1")).changeOrders.map((c) => [c.id, c.reason])).toEqual([["co1", "entry_void"]]);
    // …and Reverse finishes it: the entry is already void, no look-alike remains
    await unwindChangeOrder({ co: co({ status: "approved", postedEntryId: "e-co" }), actorId: "u-owner", actorName: "owner" });
    expect(db.tables.change_orders[0].status).toBe("void");
    expect(audited.find((a) => a.action === "CHANGE_ORDER_VOIDED")?.details).toMatchObject({ alreadyVoided: true, approvedBy: "u-ctl" });
    expect(auditRows("COST_ENTRY_VOIDED")).toHaveLength(1);   // voided once
    // a concurrent reversal that already won is named as such
    const rival = coRow({ id: "co2", co_number: "CO-002", posted_entry_id: "e-co" });
    const seen = ["approved", "void"];   // our read sees approved; the rival's claim lands before ours
    Object.defineProperty(rival, "status", { get: () => (seen.length > 1 ? seen.shift() : seen[0]), enumerable: true });
    db.tables.change_orders = [rival];
    db.denyUpdate.add("change_orders");   // our compare-and-swap matches nothing
    await expect(unwindChangeOrder({ co: co({ id: "co2", coNumber: "CO-002", status: "approved", postedEntryId: "e-co" }), actorId: "u-owner" }))
      .rejects.toThrow(/Someone else just reversed CO-002 — refresh/);
  });

  it("third verification fix: the unwind's claim is pinned to the link it voided — a repair that re-links the CO meanwhile is not voided with the old entry", async () => {
    db.tables.cost_entries.push(
      { id: "f40", org_id: "o1", project_id: "p1", cost_account_id: "a1", entry_type: "commitment", status: "posted", amount: 500, reference: "CO-001", source_document_id: null },
      { id: "f41", org_id: "o1", project_id: "p1", cost_account_id: "a1", entry_type: "commitment", status: "posted", amount: 500, reference: "CO-001", source_document_id: null },
    );
    const row = coRow({ status: "approved", posted_entry_id: "f40", decided_by: "u-ctl" });
    // our read sees the link to f40; between our entry void and our claim a
    // second user repair-links the CO to the posted look-alike f41
    const links = ["f40"];
    Object.defineProperty(row, "posted_entry_id", { get: () => (links.length ? links.shift() : "f41"), enumerable: true });
    db.tables.change_orders.push(row);
    await expect(unwindChangeOrder({ co: co({ status: "approved", postedEntryId: "f40" }), actorId: "u-owner" }))
      .rejects.toThrow(/CO-001 was re-linked to another cost entry while it was being reversed — its old entry is void, and it stays approved on the new one/);
    expect(db.tables.change_orders[0].status).toBe("approved");          // NOT a void CO over posted f41
    expect(db.tables.cost_entries.map((e) => [e.id, e.status])).toEqual([["f40", "void"], ["f41", "posted"]]);
    expect(audited.filter((a) => a.action === "CHANGE_ORDER_VOIDED")).toHaveLength(0);
  });

  it("third verification fix: a decision binds to the amount the decider was SHOWN — a changed amount is refused, never decided at the new figure", async () => {
    // the owner raised the proposed amount 900 → 90,000 after the controller opened it
    db.tables.org_members.push({ uid: "u-ctl", org_id: "o1", status: "active", role: "Requester", roles: ["DocCtrl"] });
    db.tables.change_orders.push(coRow({ co_number: "CO-120", amount: 90_000 }));
    await expect(decideChangeOrder({ co: co({ coNumber: "CO-120", amount: 900 }), decision: "approved", shownAmount: 900, shownAccountId: "a1", actorId: "u-ctl" }))
      .rejects.toThrow(/The amount of CO-120 changed since you opened it \(you were shown 900, it is now 90,000\) — nothing was decided/);
    expect(db.tables.change_orders[0]).toMatchObject({ status: "proposed", decided_by: null });
    expect(entries()).toHaveLength(0);
    // …and a change that lands between the re-read and the claim is caught by the compare-and-swap on amount
    const row = coRow({ id: "co9", co_number: "CO-121" });
    const amounts = [900];
    Object.defineProperty(row, "amount", { get: () => (amounts.length ? amounts.shift() : 90_000), enumerable: true });
    db.tables.change_orders = [row];
    await expect(decideChangeOrder({ co: co({ id: "co9", coNumber: "CO-121", amount: 900 }), decision: "approved", shownAmount: 900, shownAccountId: "a1", actorId: "u-ctl" }))
      .rejects.toThrow(/The amount of CO-121 changed since you opened it \(you were shown 900, it is now 90,000\)/);
    expect(db.tables.change_orders[0].status).toBe("proposed");
    expect(entries()).toHaveLength(0);
    // the amount as shown decides normally
    db.tables.change_orders = [coRow({ id: "co10", co_number: "CO-122", amount: 900 })];
    await decideChangeOrder({ co: co({ id: "co10", coNumber: "CO-122", amount: 900 }), decision: "approved", shownAmount: 900, shownAccountId: "a1", actorId: "u-ctl" });
    expect(db.tables.change_orders[0].status).toBe("approved");
    expect(entries()[0]).toMatchObject({ amount: 900, reference: "CO-122" });
  });

  it("fourth verification fix: a decision binds to the budget line the decider was SHOWN — a re-picked line is refused, nothing posts on a line the confirm did not name", async () => {
    db.tables.org_members.push({ uid: "u-ctl", org_id: "o1", status: "active", role: "Requester", roles: ["DocCtrl"] });
    db.tables.cost_accounts.push({ id: "a2", currency: "USD" });
    // the confirm named a1; the owner re-picked a2 before the approver's click
    db.tables.change_orders.push(coRow({ co_number: "CO-201", amount: 700, cost_account_id: "a2" }));
    await expect(decideChangeOrder({ co: co({ coNumber: "CO-201", amount: 700 }), decision: "approved", shownAmount: 700, shownAccountId: "a1", actorId: "u-ctl" }))
      .rejects.toThrow(/The budget line of CO-201 changed since you opened it — nothing was decided/);
    expect(db.tables.change_orders[0]).toMatchObject({ status: "proposed", decided_by: null });
    expect(entries()).toHaveLength(0);
    // …and a re-pick that lands between the re-read and the claim is caught by the compare-and-swap on the line
    const row = coRow({ id: "co7", co_number: "CO-202", amount: 700 });
    const lines = ["a1"];
    Object.defineProperty(row, "cost_account_id", { get: () => (lines.length ? lines.shift() : "a2"), enumerable: true });
    db.tables.change_orders = [row];
    await expect(decideChangeOrder({ co: co({ id: "co7", coNumber: "CO-202", amount: 700 }), decision: "approved", shownAmount: 700, shownAccountId: "a1", actorId: "u-ctl" }))
      .rejects.toThrow(/The budget line of CO-202 changed since you opened it/);
    expect(db.tables.change_orders[0].status).toBe("proposed");
    expect(entries()).toHaveLength(0);
    // a CO with no line shown (a rejection) claims on "no line"
    db.tables.change_orders = [coRow({ id: "co8", co_number: "CO-203", cost_account_id: null })];
    await decideChangeOrder({ co: co({ id: "co8", coNumber: "CO-203", costAccountId: null }), decision: "rejected", shownAmount: 500, shownAccountId: null, actorId: "u-ctl" });
    expect(db.tables.change_orders[0].status).toBe("rejected");
  });
});

// ── review fix pass 2 — legacy entries, the migration gate, CO orphans ─────
describe("legacy (pre-Round-G) entries attend their document — never a second post (MON-1 / COST-9 / COST-11)", () => {
  // The base's addEntry never wrote source_document_id: every award / invoice
  // posted before this branch is an UNLINKED entry of the award/invoice shape.
  const legacyAward = (over: Row): Row => ({
    id: "e-legacy", org_id: "o1", project_id: "p1", cost_account_id: "a1", entry_type: "commitment", amount: 1000,
    description: "Award — Acme (G1)", reference: "Q-1", status: "posted", source_document_id: null, ...over,
  });

  it("an awarded quote whose POSTED legacy entry is unlinked is not listed, and both repairs are refused", async () => {
    db.tables.cost_documents.push(docRow({ status: "awarded" }));
    db.tables.cost_entries.push(legacyAward({}));
    const o = await listLedgerOrphans("o1", "p1");
    expect(o.available).toBe(true);
    expect(o.docs).toEqual([]);
    for (const action of ["repost", "revert"] as const) {
      const res = await repairCostDoc({ doc: doc({ status: "awarded" }), action, costAccountId: "a1", actor });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/an unlinked entry that looks like this document's exists .* Link it, don't re-post/i);
    }
    expect(entries()).toHaveLength(1);                         // no second 1,000 commitment
    expect(db.tables.cost_documents[0].status).toBe("awarded"); // and the Award button does not come back
    expect(auditRows("COST_DOC_REPAIRED")).toHaveLength(0);
  });

  it("a legacy award entry VOIDED by hand (the MOVED_MONEY correction) attends its document too — no re-post of the locked total", async () => {
    db.tables.cost_documents.push(docRow({ status: "awarded" }));
    db.tables.cost_entries.push(legacyAward({ status: "void" }));
    expect((await listLedgerOrphans("o1", "p1")).docs).toEqual([]);
    const res = await repairCostDoc({ doc: doc({ status: "awarded" }), action: "repost", costAccountId: "a1", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/voided\) — its money reached the ledger/);
    expect(entries()).toHaveLength(1);
  });

  it("a legacy posted INVOICE attends its document; a hand-posted entry with another description does not", async () => {
    db.tables.cost_documents.push(docRow({ id: "i1", kind: "invoice", status: "posted", doc_number: "INV-9" }));
    db.tables.cost_entries.push({ id: "e-i", org_id: "o1", project_id: "p1", entry_type: "actual", amount: 700,
      description: "Invoice — Acme", reference: "INV-9", status: "posted", source_document_id: null });
    expect((await listLedgerOrphans("o1", "p1")).docs).toEqual([]);
    db.tables.cost_entries[0].description = "Hand-posted catch-up";
    expect((await listLedgerOrphans("o1", "p1")).docs.map((d) => d.id)).toEqual(["i1"]);
  });

  it("two awarded quotes sharing a file name ('Quote.pdf', no doc number) are the backfill's ambiguous residue — neither is listed or re-posted", async () => {
    db.tables.cost_documents.push(
      docRow({ id: "qa", status: "awarded", doc_number: null, file_name: "Quote.pdf", vendor_name: "Acme" }),
      docRow({ id: "qb", status: "awarded", doc_number: null, file_name: "Quote.pdf", vendor_name: "Bravo", rfq_group: "G2" }),
    );
    db.tables.cost_entries.push(
      legacyAward({ id: "ea", reference: "Quote.pdf", description: "Award — Acme (G1)" }),
      legacyAward({ id: "eb", reference: "Quote.pdf", description: "Award — Bravo (G2)" }),
    );
    expect((await listLedgerOrphans("o1", "p1")).docs).toEqual([]);
    const res = await repairCostDoc({ doc: doc({ id: "qb", status: "awarded", docNumber: null, fileName: "Quote.pdf" }), action: "repost", costAccountId: "a1", actor });
    expect(res.ok).toBe(false);
    expect(entries()).toHaveLength(2);
  });

  it("the orphan line waits for 20261093: with the view missing, nothing is listed (available: false)", async () => {
    db.tables.cost_documents.push(docRow({ id: "stuck", status: "awarded" }));
    db.fail["cost_ledger_orphans:select"] = [{ code: "PGRST205", message: "Could not find the table 'public.cost_ledger_orphans' in the schema cache" }];
    const o = await listLedgerOrphans("o1", "p1");
    expect(o).toEqual({ available: false, docs: [], changeOrders: [] });
    // any other probe failure is a failed read (REL-2), never "nothing wrong"
    db.fail["cost_ledger_orphans:select"] = [{ message: "permission denied for view cost_ledger_orphans" }];
    // REL-3 (J10): in words, not the driver's
    await expect(listLedgerOrphans("o1", "p1")).rejects.toThrow("Couldn't check the ledger for orphans: You don't have permission to see this.");
  });

  it("the linked-entry check reads only this project's moved documents, in chunks — a large project never mis-lists a healthy award", async () => {
    for (let i = 0; i < 250; i++) {
      db.tables.cost_documents.push(docRow({ id: `d${i}`, status: "awarded", doc_number: `Q-${i}` }));
      db.tables.cost_entries.push({ id: `e${i}`, org_id: "o1", project_id: "p1", status: "posted", source_document_id: `d${i}` });
    }
    db.tables.cost_documents.push(docRow({ id: "orphan", status: "awarded", doc_number: "Q-X" }));
    const o = await listLedgerOrphans("o1", "p1");
    expect(o.docs.map((d) => d.id)).toEqual(["orphan"]);
  });
});

describe("approved change orders whose entry is gone — budget, listing, unwind and repair (COST-4 / REL-9 / COST-11 dw3)", () => {
  it("COST-4: only an approved CO whose linked entry is POSTED revises the budget", () => {
    const cos = [
      co({ id: "c1", status: "approved", amount: 50_000, postedEntryId: "e1", postedEntryStatus: "posted" }),   // posted → counts
      co({ id: "c2", status: "approved", amount: 20_000, postedEntryId: "e2", postedEntryStatus: "void" }),     // voided by hand → does not
      co({ id: "c3", status: "approved", amount: 7_000, postedEntryId: null }),                                 // no link → does not
      co({ id: "c5", status: "approved", amount: 3_000, postedEntryId: "e5", postedEntryStatus: "missing" }),   // entry gone → does not
      co({ id: "c6", status: "approved", amount: 1_000, postedEntryId: "e6" }),                                 // status never read → does not
      co({ id: "c4", status: "proposed", amount: 9_000, postedEntryId: null }),
    ];
    const map = approvedChangesByAccount(cos);
    expect(map.get("a1")).toBe(50_000);
    expect(cos.filter(changeOrderOnLedger).map((c) => c.id)).toEqual(["c1"]);
  });

  it("COST-4 (verification fix): listChangeOrders reads the linked entries BY ID — an approval older than the loaded entry page still counts", async () => {
    // 150 approved COs (two .in chunks); their entries are nowhere in any
    // "newest 2,000" page the Costs tab loads — the budget no longer asks it.
    for (let i = 0; i < 150; i++) {
      db.tables.change_orders.push(coRow({ id: `c${i}`, co_number: `CO-${i}`, status: "approved", amount: 100, posted_entry_id: `e${i}` }));
      db.tables.cost_entries.push({ id: `e${i}`, org_id: "o1", project_id: "p1", status: i === 0 ? "void" : "posted" });
    }
    db.tables.change_orders.push(coRow({ id: "c-gone", co_number: "CO-X", status: "approved", amount: 100, posted_entry_id: "e-nowhere" }));
    const cos = await listChangeOrders("p1");
    const byId = new Map(cos.map((c) => [c.id, c]));
    expect(byId.get("c0")?.postedEntryStatus).toBe("void");
    expect(byId.get("c1")?.postedEntryStatus).toBe("posted");
    expect(byId.get("c149")?.postedEntryStatus).toBe("posted");
    expect(byId.get("c-gone")?.postedEntryStatus).toBe("missing");
    expect(approvedChangesByAccount(cos).get("a1")).toBe(149 * 100);
    // a failed entry read is a failed read (REL-2), never a budget that silently dropped its changes
    db.fail["cost_entries:select"] = [{ message: "statement timeout" }];
    await expect(listChangeOrders("p1")).rejects.toThrow("Couldn't read the change orders' cost entries: The database took too long to answer — try again.");
  });

  it("COST-4 (verification fix): the CO tiles and the report figure count by the same rule as the revised budget", async () => {
    db.tables.cost_entries.push(
      { id: "e-ok", org_id: "o1", project_id: "p1", status: "posted" },
      { id: "e-void", org_id: "o1", project_id: "p1", status: "void" },
    );
    db.tables.change_orders.push(
      coRow({ id: "c-ok", status: "approved", amount: 50_000, posted_entry_id: "e-ok", reason_code: "scope_gap" }),
      coRow({ id: "c-void", co_number: "CO-002", status: "approved", amount: 20_000, posted_entry_id: "e-void", reason_code: "scope_gap" }),
      coRow({ id: "c-null", co_number: "CO-003", status: "approved", amount: 7_000, posted_entry_id: null, reason_code: "design_error" }),
      coRow({ id: "c-open", co_number: "CO-004", status: "proposed", amount: 9_000 }),
    );
    const cos = await listChangeOrders("p1");
    const sum = summarizeChangeOrders(cos);
    expect(sum).toMatchObject({ open: 1, approvedCount: 1, approvedAmount: 50_000, approvedOffLedger: 2 });
    expect(sum.byReason).toEqual([{ reason: "scope_gap", count: 1, amount: 50_000 }]);
    const budget = [...approvedChangesByAccount(cos).values()].reduce((a, b) => a + b, 0);
    expect(sum.approvedAmount).toBe(budget);
  });

  it("an approved CO whose entry was voided by hand is listed (entry_void), and so are unlinked / missing ones; a posted link is not", async () => {
    db.tables.cost_entries.push(
      { id: "e-ok", org_id: "o1", project_id: "p1", status: "posted" },
      { id: "e-void", org_id: "o1", project_id: "p1", status: "void" },
    );
    db.tables.change_orders.push(
      coRow({ id: "c-ok", status: "approved", posted_entry_id: "e-ok" }),
      coRow({ id: "c-void", co_number: "CO-003", status: "approved", posted_entry_id: "e-void" }),
      coRow({ id: "c-null", co_number: "CO-004", status: "approved", posted_entry_id: null }),
      coRow({ id: "c-gone", co_number: "CO-005", status: "approved", posted_entry_id: "e-nowhere" }),
    );
    const o = await listLedgerOrphans("o1", "p1");
    expect(o.changeOrders.map((c) => [c.id, c.reason])).toEqual([["c-void", "entry_void"], ["c-null", "unlinked"], ["c-gone", "entry_missing"]]);
  });

  it("REL-9: Reverse on an approved CO whose entry is ALREADY void voids the CO (alreadyVoided) instead of putting it back", async () => {
    db.tables.cost_entries.push({ id: "e-co", org_id: "o1", project_id: "p1", status: "void", amount: 500, entry_type: "commitment" });
    db.tables.change_orders.push(coRow({ status: "approved", posted_entry_id: "e-co", decided_by: "u-owner" }));
    await unwindChangeOrder({ co: co({ status: "approved", postedEntryId: "e-co" }), note: "voided by hand last year", actorId: "u-owner", actorName: "owner" });
    expect(db.tables.change_orders[0].status).toBe("void");
    expect(audited.find((a) => a.action === "CHANGE_ORDER_VOIDED")?.details).toMatchObject({ reversedEntryId: "e-co", alreadyVoided: true });
    expect(auditRows("COST_ENTRY_VOIDED")).toHaveLength(0);   // nothing was voided twice
  });

  it("REL-9 (verification fix): Reverse on an already-void entry applies the repair's look-alike check — refused while a posted commitment carrying the CO number remains", async () => {
    db.tables.cost_entries.push(
      { id: "e-co", org_id: "o1", project_id: "p1", cost_account_id: "a1", entry_type: "commitment", status: "void", amount: 500, reference: "CO-001", source_document_id: null },
      { id: "e-hand", org_id: "o1", project_id: "p1", cost_account_id: "a1", entry_type: "commitment", status: "posted", amount: 500, reference: "CO-001", source_document_id: null },
    );
    db.tables.change_orders.push(coRow({ status: "approved", posted_entry_id: "e-co", decided_by: "u-owner" }));
    await expect(unwindChangeOrder({ co: co({ status: "approved", postedEntryId: "e-co" }), actorId: "u-owner" }))
      .rejects.toThrow(/CO-001's own entry is void, but a posted commitment referencing CO-001 is still on the budget line — link it/);
    expect(db.tables.change_orders[0]).toMatchObject({ status: "approved", decision_note: null });
    expect(audited.filter((a) => a.action === "CHANGE_ORDER_VOIDED")).toHaveLength(0);
    // once the look-alike is gone the reverse goes through, exactly as the repair's reverse
    db.tables.cost_entries[1].status = "void";
    await unwindChangeOrder({ co: co({ status: "approved", postedEntryId: "e-co" }), actorId: "u-owner", actorName: "owner" });
    expect(db.tables.change_orders[0].status).toBe("void");
    expect(audited.filter((a) => a.action === "CHANGE_ORDER_VOIDED")).toHaveLength(1);
  });

  it("repairChangeOrder link: a posted commitment on the CO's line carrying its number is linked (checked, audited); anything else is refused", async () => {
    db.tables.cost_entries.push(
      { id: "e-right", org_id: "o1", project_id: "p1", cost_account_id: "a1", entry_type: "commitment", status: "posted", reference: "CO-001", source_document_id: null },
      { id: "e-wrongref", org_id: "o1", project_id: "p1", cost_account_id: "a1", entry_type: "commitment", status: "posted", reference: "CO-009", source_document_id: null },
      { id: "e-taken", org_id: "o1", project_id: "p1", cost_account_id: "a1", entry_type: "commitment", status: "posted", reference: "CO-001", source_document_id: null },
    );
    db.tables.change_orders.push(
      coRow({ status: "approved", posted_entry_id: null }),
      coRow({ id: "co-other", co_number: "CO-001-B", status: "approved", posted_entry_id: "e-taken" }),
    );
    await expect(repairChangeOrder({ co: { id: "co1" }, action: "link", entryId: "e-wrongref", actorId: "u-owner" }))
      .rejects.toThrow(/That entry is not CO-001's/);
    await expect(repairChangeOrder({ co: { id: "co1" }, action: "link", entryId: "e-taken", actorId: "u-owner" }))
      .rejects.toThrow(/already linked to another change order/);
    await repairChangeOrder({ co: { id: "co1" }, action: "link", entryId: "e-right", actorId: "u-owner" });
    expect(db.tables.change_orders[0].posted_entry_id).toBe("e-right");
    expect(audited.find((a) => a.action === "CHANGE_ORDER_REPAIRED")?.details).toMatchObject({ action: "link", entryId: "e-right", previousEntryId: null });
    // linked to a posted entry → no longer an orphan, and a second repair is refused
    await expect(repairChangeOrder({ co: { id: "co1" }, action: "reverse", actorId: "u-owner" })).rejects.toThrow(/entry is posted — nothing to repair/);
  });

  it("repairChangeOrder reverse: refused while a posted look-alike remains; voids the CO once none does, crediting the reverser", async () => {
    db.tables.cost_entries.push(
      { id: "e-void", org_id: "o1", project_id: "p1", cost_account_id: "a1", entry_type: "commitment", status: "void", reference: "CO-001", source_document_id: null },
      { id: "e-repost", org_id: "o1", project_id: "p1", cost_account_id: "a1", entry_type: "commitment", status: "posted", reference: "CO-001", source_document_id: null },
    );
    db.tables.change_orders.push(coRow({ status: "approved", posted_entry_id: "e-void", decided_by: "u-owner" }));
    await expect(repairChangeOrder({ co: { id: "co1" }, action: "reverse", actorId: "u-ctl", actorName: "bob" }))
      .rejects.toThrow(/A posted commitment referencing CO-001 is still on the budget line — link it/);
    expect(db.tables.change_orders[0].status).toBe("approved");
    db.tables.cost_entries[1].status = "void";
    await repairChangeOrder({ co: { id: "co1" }, action: "reverse", note: "voided by hand", actorId: "u-ctl", actorName: "bob" });
    expect(db.tables.change_orders[0]).toMatchObject({ status: "void", decided_by: "u-owner" });
    expect(String(db.tables.change_orders[0].decision_note)).toMatch(/^Reversed by bob on .*: voided by hand$/);
    expect(audited.find((a) => a.action === "CHANGE_ORDER_VOIDED")?.details).toMatchObject({ repair: "reverse", reversedEntryId: "e-void", entryStatus: "void" });
  });
});

describe("COST-13 posting limb — a total from a truncated (or unknown-extent) read is typed back before it posts", () => {
  const aiRead = (over: Row): Row => docRow({ parsed: { total: 1000 }, total_amount: 1000, ...over });

  it("a truncated read (pages 1–8 of 14) refuses the award; a matching typed total lets it post and the audit carries the extent", async () => {
    db.tables.cost_documents.push(aiRead({ pages_read: 8, pages_total: 14 }));
    const refused = await awardQuote({ doc: doc(), siblings: [], costAccountId: "a1", actor });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/read only pages 1–8 of 14/);
    expect(db.tables.cost_documents[0].status).toBe("parsed");
    const wrong = await awardQuote({ doc: doc(), siblings: [], costAccountId: "a1", actor, confirmedTotal: 900 });
    expect(wrong.error).toMatch(/doesn't match the stored total/);
    expect(entries()).toHaveLength(0);
    const ok = await awardQuote({ doc: doc(), siblings: [], costAccountId: "a1", actor, confirmedTotal: 1000 });
    expect(ok.ok).toBe(true);
    expect(auditRows("COST_DOC_AWARDED")[0].details).toMatchObject({ pagesRead: 8, pagesTotal: 14, totalConfirmed: true });
  });

  it("once the extent is recordable, UNKNOWN fails safe; a fully read document and a total nobody read need no typed total", async () => {
    db.tables.cost_documents.push(
      aiRead({ id: "unk", pages_read: null, pages_total: null }),
      aiRead({ id: "full", pages_read: 3, pages_total: 3 }),
      docRow({ id: "typed", parsed: null, total_amount: 800, pages_read: null, pages_total: null, rfq_group: "G2" }),   // no AI read at all
    );
    const unk = await awardQuote({ doc: doc({ id: "unk" }), siblings: [], costAccountId: "a1", actor });
    expect(unk.error).toMatch(/How much of this document the AI read is unknown/);
    expect((await awardQuote({ doc: doc({ id: "full" }), siblings: [], costAccountId: "a1", actor })).ok).toBe(true);
    expect((await awardQuote({ doc: doc({ id: "typed", rfqGroup: "G2" }), siblings: [], costAccountId: "a1", actor })).ok).toBe(true);
    expect(auditRows("COST_DOC_AWARDED").map((r) => (r.details as Row).pagesTotal)).toEqual([3, null]);
  });

  it("verification fix: the confirmation is EXPLICIT — a typed-back total equal to the extraction posts with confirmedTotal; a hand-corrected total on a truncated read needs it too", async () => {
    // The user typed the figure from the paper and it equals the AI's
    // reading (setManualTotal wrote the same number): before the fix the
    // lib read that as "from the read" and the award could never post
    // unless the caller also passed confirmedTotal — which is exactly the
    // explicit signal now, and the only one.
    db.tables.cost_documents.push(aiRead({ id: "same", pages_read: 8, pages_total: 14 }));
    const typed = await setManualTotal({ doc: doc({ id: "same" }), total: 1000, actor });
    expect(typed.ok).toBe(true);
    expect((await awardQuote({ doc: doc({ id: "same" }), siblings: [], costAccountId: "a1", actor })).error).toMatch(/read only pages 1–8 of 14/);
    const ok = await awardQuote({ doc: doc({ id: "same" }), siblings: [], costAccountId: "a1", actor, confirmedTotal: 1000.4 });
    expect(ok.ok).toBe(true);
    expect(entries()[0]).toMatchObject({ amount: 1000, source_document_id: "same" });
    // a hand-corrected total (differs from the extraction) is no longer waved through on a truncated read
    db.tables.cost_documents.push(aiRead({ id: "i9", kind: "invoice", parsed: { total: 700 }, total_amount: 750, pages_read: 2, pages_total: 5 }));
    const corrected = await postInvoice({ doc: doc({ id: "i9", kind: "invoice" }), costAccountId: "a1", actor });
    expect(corrected.error).toMatch(/read only pages 1–2 of 5/);
    expect((await postInvoice({ doc: doc({ id: "i9", kind: "invoice" }), costAccountId: "a1", actor, confirmedTotal: 750 })).ok).toBe(true);
    // a confirmedTotal that disagrees with the row is refused even on a FULL read — the paper and the row differ
    db.tables.cost_documents.push(aiRead({ id: "full2", pages_read: 3, pages_total: 3, rfq_group: "G3" }));
    const wrong = await awardQuote({ doc: doc({ id: "full2", rfqGroup: "G3" }), siblings: [], costAccountId: "a1", actor, confirmedTotal: 1200 });
    expect(wrong.error).toMatch(/confirmed total \(1,200\) doesn't match the stored total \(1,000\)/);
    expect(entries()).toHaveLength(2);
  });

  it("an invoice follows the same rule, and before the extent columns exist the check is a no-op (the brief's fail-open window)", async () => {
    db.tables.cost_documents.push(docRow({ id: "i1", kind: "invoice", parsed: { total: 700 }, total_amount: 700, pages_read: 8, pages_total: 20 }));
    const refused = await postInvoice({ doc: doc({ id: "i1", kind: "invoice" }), costAccountId: "a1", actor });
    expect(refused.error).toMatch(/pages 1–8 of 20/);
    const ok = await postInvoice({ doc: doc({ id: "i1", kind: "invoice" }), costAccountId: "a1", actor, confirmedTotal: 700 });
    expect(ok.ok).toBe(true);
    expect(auditRows("COST_DOC_POSTED")[0].details).toMatchObject({ pagesRead: 8, pagesTotal: 20, totalConfirmed: true });
    // no pages_* keys on the row = 20261096 not applied: nothing to compare
    db.tables.cost_documents.push(docRow({ id: "i2", kind: "invoice", parsed: { total: 50 }, total_amount: 50 }));
    expect((await postInvoice({ doc: doc({ id: "i2", kind: "invoice" }), costAccountId: "a1", actor })).ok).toBe(true);
  });
});

describe("MON-12 / COST-8 / MON-10 — registry lookups fail closed, currencies normalise, groups compare by key", () => {
  it("MON-12: a failed company lookup REFUSES the award instead of passing it", async () => {
    db.tables.cost_documents.push(docRow({ party_id: "pp1" }));
    db.fail["project_parties:select"] = [{ message: "statement timeout" }];
    const res = await awardQuote({ doc: doc({ partyId: "pp1" }), siblings: [], costAccountId: "a1", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Couldn't check the company registry \(The database took too long to answer — try again\.\)/);
    expect(db.tables.cost_documents[0].status).toBe("parsed");
    db.fail["companies:select"] = [{ message: "timeout" }];
    const byName = await awardQuote({ doc: doc(), siblings: [], costAccountId: "a1", actor });
    expect(byName.error).toMatch(/Couldn't check the company registry/);
    expect(entries()).toHaveLength(0);
  });

  it("MON-12: the document's own registry link (cost_documents.company_id) outranks the party and the name", async () => {
    db.tables.companies.push({ id: "c-bad", org_id: "o1", name: "Acme Holdings", status: "do_not_use" }, { id: "c-ok", org_id: "o1", name: "Acme", status: "active" });
    db.tables.project_parties.push({ id: "pp1", company_id: "c-ok" });
    db.tables.cost_documents.push(docRow({ party_id: "pp1", company_id: "c-bad" }));
    const res = await awardQuote({ doc: doc({ partyId: "pp1" }), siblings: [], costAccountId: "a1", actor });
    expect(res.error).toMatch(/Acme Holdings is flagged DO NOT USE/);
    const ok = await awardQuote({ doc: doc({ partyId: "pp1" }), siblings: [], costAccountId: "a1", actor, overrideReason: "Sole source" });
    expect(ok.ok).toBe(true);
    expect(auditRows("COST_DOC_AWARD_OVERRIDE")[0].details).toMatchObject({ companyId: "c-bad" });
  });

  it("COST-8: '$' / 'US$' read as USD, non-codes as unstated; a null account currency is USD; setManualTotal corrects the currency", async () => {
    expect(normalizeCurrency("$")).toBe("USD");
    expect(normalizeCurrency(" us$ ")).toBe("USD");
    expect(normalizeCurrency("eur")).toBe("EUR");
    expect(normalizeCurrency("Euros")).toBeNull();
    db.tables.cost_documents.push(docRow({ id: "d-usd", currency: "$" }));
    expect((await awardQuote({ doc: doc({ id: "d-usd" }), siblings: [], costAccountId: "a1", actor })).ok).toBe(true);
    // an account with no currency renders as USD, so it is compared as USD
    db.tables.cost_accounts.push({ id: "a-null", currency: null });
    db.tables.cost_documents.push(docRow({ id: "d-eur", currency: "EUR" }));
    const refused = await awardQuote({ doc: doc({ id: "d-eur" }), siblings: [], costAccountId: "a-null", actor });
    expect(refused.error).toMatch(/in EUR but the budget line is in USD/);
    // the in-app correction
    const bad = await setManualTotal({ doc: doc({ id: "d-eur" }), total: 1000, currency: "euros", actor });
    expect(bad.error).toMatch(/not a currency code/);
    const fixed = await setManualTotal({ doc: doc({ id: "d-eur" }), total: 1000, currency: "usd", actor });
    expect(fixed.ok).toBe(true);
    expect(db.tables.cost_documents[1]).toMatchObject({ currency: "USD", total_amount: 1000 });
    expect((await awardQuote({ doc: doc({ id: "d-eur" }), siblings: [], costAccountId: "a-null", actor })).ok).toBe(true);
  });

  it("MON-10: the award compares RFQ groups by key — 'Piping' declines the open 'piping ' bid the table shows beside it", async () => {
    db.tables.cost_documents.push(docRow({ rfq_group: "Piping" }), docRow({ id: "r1", rfq_group: "piping ", status: "parsed" }), docRow({ id: "r2", rfq_group: "Pipe racks" }));
    const res = await awardQuote({
      doc: doc({ rfqGroup: "Piping" }), costAccountId: "a1", actor,
      siblings: [doc({ rfqGroup: "Piping" }), doc({ id: "r1", rfqGroup: "piping " }), doc({ id: "r2", rfqGroup: "Pipe racks" })],
    });
    expect(res).toEqual({ ok: true });
    expect(db.tables.cost_documents.map((d) => d.status)).toEqual(["awarded", "declined", "parsed"]);
  });

  it("COST-6: a malformed threshold ('10k') is NO threshold in the lib, exactly as the trigger reads it", async () => {
    expect(parseThresholdAmount(1000)).toBe(1000);
    expect(parseThresholdAmount(" 2500.50 ")).toBe(2500.5);
    expect(parseThresholdAmount("10k")).toBeNull();
    expect(parseThresholdAmount("-5")).toBeNull();
    expect(parseThresholdAmount("1e3")).toBeNull();
    db.tables.org_configurations.push({ org_id: "o1", key: "change_order_approval_threshold", data: { amount: "10k" } });
    db.tables.change_orders.push(coRow({ amount: 50_000 }));
    const out = await decideChangeOrder({ co: co({ amount: 50_000 }), decision: "approved", shownAmount: 50_000, shownAccountId: "a1", actorId: "u-owner" });
    expect(out.warning).toBeNull();
    expect(db.tables.change_orders[0].status).toBe("approved");
  });
});

// ── SAF-3 / REL-2 ───────────────────────────────────────────────────────────
describe("checked writes and honest reads (SAF-3 / REL-2)", () => {
  it("SAF-3: a zero-row void (RLS-filtered) returns the permission-or-changed error and writes NO audit row", async () => {
    db.tables.cost_entries.push({ id: "e1", status: "posted", amount: 5 });
    db.denyUpdate.add("cost_entries");
    const res = await voidEntry({ orgId: "o1", entryId: "e1", actor });
    expect(res).toEqual({ ok: false, error: NO_ROW_MATCHED });
    expect(auditRows("COST_ENTRY_VOIDED")).toHaveLength(0);
    expect(db.tables.cost_entries[0].status).toBe("posted");
    // and a second void of an already-void row is a zero-row match too
    db.denyUpdate.clear();
    db.tables.cost_entries[0].status = "void";
    expect((await voidEntry({ orgId: "o1", entryId: "e1", actor })).ok).toBe(false);
  });

  it("SAF-3: a zero-row account update is refused before its audit row", async () => {
    db.tables.cost_accounts.push({ id: "a9", budget: 1, name: "x" });
    db.denyUpdate.add("cost_accounts");
    const res = await saveAccount({ orgId: "o1", projectId: "p1", id: "a9", patch: { budget: 5 }, actor });
    expect(res).toEqual({ ok: false, error: NO_ROW_MATCHED });
    expect(auditRows("COST_ACCOUNT_UPDATED")).toHaveLength(0);
  });

  it("REL-2: a failed read THROWS instead of returning an empty list", async () => {
    db.fail["cost_accounts:select"] = [{ message: "permission denied for table cost_accounts" }];
    await expect(listAccounts("o1", "p1")).rejects.toThrow("Couldn't load cost accounts: You don't have permission to see this.");
    db.fail["cost_documents:select"] = [{ message: "relation does not exist" }];
    await expect(listCostDocs("o1", "p1")).rejects.toThrow(/Couldn't load quotes & invoices/);
  });

  it("REL-4: a non-numeric amount enters the model as 0 and a null source link as null, never NaN / undefined", async () => {
    db.tables.cost_entries.push({ id: "e1", org_id: "o1", project_id: "p1", status: "posted", amount: "abc", entry_type: "actual" });
    const [e] = await listEntries("o1", "p1");
    expect(e.amount).toBe(0);
    expect(e.sourceDocumentId).toBeNull();
  });

  it("REL-2 dw2: a failed insert after the upload removes the orphaned object", async () => {
    db.fail["cost_documents:insert"] = [{ message: "insert refused" }];
    const file = { name: "q.pdf", type: "application/pdf" } as unknown as File;
    const res = await uploadCostDoc({ orgId: "o1", projectId: "p1", kind: "quote", file, actor });
    expect(res.ok).toBe(false);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^orgs\/o1\/project-costs\/p1\//);
  });
});
