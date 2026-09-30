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
//   SAF-3 / REL-2    zero-row writes write no audit row; failed reads throw

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
  uploadCostDoc, listCostDocs, type CostDocument,
} from "@/lib/costDocs";
import { proposeChangeOrder, decideChangeOrder, unwindChangeOrder, listChangeOrders, type ChangeOrder } from "@/lib/changeOrders";
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
    // …but it can still be put back to parsed: none of its money is on the ledger.
    const back = await repairCostDoc({ doc: doc({ status: "awarded" }), action: "revert", actor });
    expect(back.ok).toBe(true);
    expect(db.tables.cost_documents[0].status).toBe("parsed");
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
    await expect(decideChangeOrder({ co: co({ createdBy: "u-owner" }), decision: "approved", actorId: "u-owner" }))
      .rejects.toThrow(/second person has to decide it \(1 other eligible decider/);
    expect(db.tables.change_orders[0].status).toBe("proposed");
    expect(entries()).toHaveLength(0);
  });

  it("COST-6: with nobody else able to decide, the self-decision goes through and is MARKED", async () => {
    db.tables.change_orders.push(coRow({ created_by: "u-owner" }));
    const out = await decideChangeOrder({ co: co({ createdBy: "u-owner" }), decision: "approved", actorId: "u-owner" });
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
    await expect(decideChangeOrder({ co: co({ amount: 5000 }), decision: "approved", actorId: "u-owner" }))
      .rejects.toThrow(/above this org's change-order approval threshold \(1,000\)/);
    expect(db.tables.change_orders[0].status).toBe("proposed");
    const out = await decideChangeOrder({ co: co({ amount: 5000 }), decision: "approved", actorId: "u-ctl" });
    expect(out.warning).toBeNull();
    expect(db.tables.change_orders[0].status).toBe("approved");
    expect(entries()[0]).toMatchObject({ entry_type: "commitment", amount: 5000 });
  });

  it("MON-11: an approval notifies the proposer (and not the decider)", async () => {
    db.tables.change_orders.push(coRow({}));
    await decideChangeOrder({ co: co(), decision: "approved", actorId: "u-owner", actorName: "owner" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ kind: "project_status", actorUserId: "u-owner" });
    expect((emitted[0].audience as { involved: string[] }).involved).toEqual(["u-proposer"]);
  });

  it("COST-11: post failure + revert failure names the CO as stuck; a saved-link failure is a warning on success", async () => {
    db.tables.change_orders.push(coRow({}));
    db.fail["cost_entries:insert"] = [{ message: "insert refused" }];
    db.fail["change_orders:update"] = [null, { message: "revert refused" }];   // claim passes; the revert fails
    await expect(decideChangeOrder({ co: co(), decision: "approved", actorId: "u-owner" }))
      .rejects.toThrow(/insert refused AND the change order could not be put back \(revert refused\) — CO-001 is stuck as approved/);

    db.tables.change_orders = [coRow({ id: "co2", co_number: "CO-002" })];
    db.fail["change_orders:update"] = [null, { message: "link refused" }];     // claim passes; the posted_entry_id write fails
    const out = await decideChangeOrder({ co: co({ id: "co2", coNumber: "CO-002" }), decision: "approved", actorId: "u-owner" });
    expect(out.warning).toMatch(/CO-002 was approved and its money posted, but the link/);
    expect(entries()).toHaveLength(1);
  });

  it("REL-9 / COST-9: the unwind voids EXACTLY posted_entry_id, marks the CO void and records the entry id", async () => {
    db.tables.cost_entries.push(
      { id: "e-co", org_id: "o1", project_id: "p1", status: "posted", amount: 500, entry_type: "commitment" },
      { id: "e-other", org_id: "o1", project_id: "p1", status: "posted", amount: 500, entry_type: "commitment" },
    );
    db.tables.change_orders.push(coRow({ status: "approved", posted_entry_id: "e-co", decided_by: "u-owner" }));
    await unwindChangeOrder({ co: co({ status: "approved", postedEntryId: "e-co" }), note: "wrong contractor", actorId: "u-owner" });
    expect(db.tables.cost_entries.map((e) => e.status)).toEqual(["void", "posted"]);
    expect(db.tables.change_orders[0]).toMatchObject({ status: "void", decision_note: "Reversed: wrong contractor" });
    expect(audited.find((a) => a.action === "CHANGE_ORDER_VOIDED")?.details).toMatchObject({ reversedEntryId: "e-co", coNumber: "CO-001" });
    expect(auditRows("COST_ENTRY_VOIDED")).toHaveLength(1);
  });

  it("an unwind with no linked entry is refused and points at the reconciliation line; a failed void puts the CO back", async () => {
    db.tables.change_orders.push(coRow({ status: "approved", posted_entry_id: null }));
    await expect(unwindChangeOrder({ co: co({ status: "approved" }), actorId: "u-owner" })).rejects.toThrow(/no linked cost entry/);
    db.tables.change_orders = [coRow({ status: "approved", posted_entry_id: "missing" })];
    await expect(unwindChangeOrder({ co: co({ status: "approved", postedEntryId: "missing" }), actorId: "u-owner" }))
      .rejects.toThrow(/Couldn't void the change order's cost entry .* — the change order is still approved/);
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
    await expect(listAccounts("o1", "p1")).rejects.toThrow(/Couldn't load cost accounts: permission denied/);
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
