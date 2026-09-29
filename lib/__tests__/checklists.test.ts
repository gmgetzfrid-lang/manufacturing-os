// projects Round G — J2 QUALITY, the checklist data layer.
//
//   SAF-1 / QUAL-13  the evidence register admits Issued/Locked documents
//                    with a current version only; an unreviewed Draft (a
//                    contractor's self-typed filename) never satisfies; an
//                    external submission counts once approved; documents on
//                    ACCEPTED turnover items are preferred.
//   QUAL-1           the sweep retracts an auto-only green whose proof is
//                    gone, writes documentId chips, replaces stale chips.
//   SAF-2 / QUAL-5   the assessment writes only ticked ids (a count-only
//                    call writes nothing) and never downgrades a satisfied
//                    or evidence-bearing item; the audit row carries ids.
//   SAF-3 / GAP-402  a zero-row (RLS-refused) write returns an error and
//                    writes NO audit row, on every decision path.
//   SAF-4 / GAP-405  a blank or canned reason is refused server-side.
//   QUAL-6           the machine paths stamp updated_by NULL + a sentinel.
//   QUAL-8 / UX-10   a failed item read blocks completion; zero items block
//                    completion; list reads throw instead of returning [].
//   QUAL-2           completion records its basis; only 'human' MI
//                    completions feed miChecklistComplete.
//   QUAL-12          item rows take org_id from the header row.
//   PERF-7           writes are batched (parallel, WRITE_BATCH per batch)
//                    and guarded on updated_at (a concurrent change refuses).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { freshState, resetState, type MemoryState } from "./helpers/memoryDb";

const state = vi.hoisted<MemoryState>(() => ({
  tables: {}, calls: [], writes: [], refuse: false, writeError: null, readError: {}, nextId: 1,
}));
vi.mock("@/lib/supabase", async () => {
  const { makeSupabase } = await import("./helpers/memoryDb");
  return { supabase: makeSupabase(state) };
});

import {
  applyAssessment, createChecklist, gatherProjectEvidenceState, listChecklistItems, listChecklists,
  readChecklistItems, runAutoEvidence, setChecklistStatus, updateChecklistItem, WRITE_BATCH,
  type Checklist, type ChecklistItem,
} from "@/lib/checklists";
import { MACHINE_ACTOR_ASSESSMENT, MACHINE_ACTOR_SWEEP } from "@/lib/checklistEngine";

const actor = { uid: "u1", email: "mreyes@plant.io" };
const audits = () => state.writes.filter((w) => w.table === "audit_logs").map((w) => w.payload as Record<string, unknown>);
const itemWrites = () => state.writes.filter((w) => w.table === "checklist_items" && w.method === "update");

const checklist = (over: Partial<Checklist> = {}): Checklist => ({
  id: "cl1", orgId: "o1", projectId: "p1", title: "PSSR", kind: "pssr", sourceDocumentId: null,
  status: "open", completedBasis: null, createdAt: null, createdByName: null, ...over,
});
const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "i1", org_id: "o1", checklist_id: "cl1", seq: 1, section: null, text: "Hydrotest complete with records",
  applicability: "applies", status: "open", evidence: [], ai_rationale: null, manual_note: null,
  updated_at: "2026-09-01T00:00:00Z", updated_by: null, updated_by_name: null, ...over,
});
const mapped = (over: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id: "i1", checklistId: "cl1", seq: 1, section: null, text: "Hydrotest complete with records",
  applicability: "applies", status: "open", evidence: [], aiRationale: null, manualNote: null,
  updatedAt: "2026-09-01T00:00:00Z", updatedBy: null, updatedByName: null, ...over,
});
const doc = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "d1", title: "E-301 Hydrotest Report", name: null, document_number: null, status: "Issued", rev: "0",
  current_version_id: "v1", collection_id: "intake", ...over,
});

beforeEach(() => resetState(state));
void freshState;

// ── reads ────────────────────────────────────────────────────────────────
describe("reads fail loudly (UX-10 / QUAL-8)", () => {
  it("listChecklists / listChecklistItems throw on a read error instead of returning []", async () => {
    state.readError.project_checklists = { message: 'relation "public.project_checklists" does not exist', code: "42P01" };
    await expect(listChecklists("o1", "p1")).rejects.toThrow(/latest database migration/);
    state.readError.checklist_items = { message: "permission denied", code: "42501" };
    await expect(listChecklistItems("cl1")).rejects.toThrow(/permission/);
    const r = await readChecklistItems("cl1");
    expect(r.error).toMatch(/permission/);
    expect(r.rows).toEqual([]);
  });
});

// ── createChecklist (QUAL-12) ────────────────────────────────────────────
describe("createChecklist", () => {
  it("stamps item rows with the HEADER row's org_id, not the caller's argument", async () => {
    state.tables.project_checklists = [];
    const res = await createChecklist({
      orgId: "caller-org", projectId: "p1", title: "PSSR", kind: "pssr",
      items: [{ seq: 1, section: null, text: "Hydrotest complete with records" }], actor,
    });
    expect(res.ok).toBe(true);
    const header = state.tables.project_checklists[0];
    const items = state.tables.checklist_items;
    expect(items).toHaveLength(1);
    expect(items[0].org_id).toBe(header.org_id);
    expect(items[0].checklist_id).toBe(header.id);
  });

  it("a refused item insert rolls the header back and writes no audit row", async () => {
    state.refuse = ["checklist_items"]; // the header insert lands, the items are refused
    const res = await createChecklist({ orgId: "o1", projectId: "p1", title: "PSSR", kind: "pssr", items: [{ seq: 1, section: null, text: "abcd efgh" }], actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Couldn't save the items/);
    expect(audits()).toHaveLength(0);
    expect(state.writes.some((w) => w.table === "project_checklists" && w.method === "delete")).toBe(true);
  });
});

// ── applyAssessment (SAF-2 / QUAL-5 / QUAL-6 / PERF-7) ───────────────────
describe("applyAssessment", () => {
  beforeEach(() => {
    state.tables.checklist_items = [
      row({ id: "a", text: "Weld log reviewed" }),
      row({ id: "b", text: "NDE reports on file", status: "satisfied", evidence: [{ label: 'Document on file: "NDE Report"', source: "auto" }] }),
      row({ id: "c", text: "Operators trained", manual_note: "trained 8/12 — sign-in sheet on file" }),
      row({ id: "d", text: "P&ID redlines", status: "open", evidence: [{ label: "walked down", source: "manual" }] }),
    ];
  });
  const proposals = [
    { itemId: "a", applicability: "na" as const, rationale: "no welding in scope" },
    { itemId: "b", applicability: "na" as const, rationale: "no NDE in scope" },
    { itemId: "c", applicability: "na" as const, rationale: "no training" },
    { itemId: "d", applicability: "na" as const, rationale: "no P&ID change" },
  ];

  it("a count-only call (no confirmed ids) writes NOTHING and audits nothing", async () => {
    const out = await applyAssessment({ orgId: "o1", projectId: "p1", checklistId: "cl1", proposals, confirmedItemIds: [], actor });
    expect(out.applied).toBe(0);
    expect(out.skippedUnconfirmed).toBe(4);
    expect(itemWrites()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
    expect(state.tables.checklist_items.find((r) => r.id === "a")!.status).toBe("open");
  });

  it("writes only the ticked ids; a satisfied or evidence-bearing item is never flipped to N/A, and a human-decided one is left alone", async () => {
    const out = await applyAssessment({ orgId: "o1", projectId: "p1", checklistId: "cl1", proposals, confirmedItemIds: ["a", "b", "c", "d"], actor });
    expect(out).toMatchObject({ applied: 1, skippedHuman: 1, skippedProtected: 2, skippedUnconfirmed: 0, refused: 0, failed: 0 });
    const byId = Object.fromEntries(state.tables.checklist_items.map((r) => [r.id as string, r]));
    expect(byId.a.status).toBe("na");
    expect(byId.a.applicability).toBe("na");
    expect(byId.b.status).toBe("satisfied");         // QUAL-5: not silently flipped
    expect(byId.b.applicability).toBe("applies");    // …and not excluded through applicability either
    expect(byId.b.evidence).toHaveLength(1);
    expect(byId.c.status).toBe("open");
    expect(byId.d.status).toBe("open");
    // QUAL-6: the machine actor, not the calling human
    expect(byId.a.updated_by).toBeNull();
    expect(byId.a.updated_by_name).toBe(MACHINE_ACTOR_ASSESSMENT);
    // the audit row names the item and its prior / new state
    const a = audits();
    expect(a).toHaveLength(1);
    expect(a[0].action).toBe("CHECKLIST_ASSESSED");
    expect((a[0].details as { items: unknown[] }).items).toEqual([
      { itemId: "a", from: { applicability: "applies", status: "open" }, to: { applicability: "na", status: "na" } },
    ]);
  });

  it("a refused write (RLS zero rows) reports an error and writes no audit row (SAF-3)", async () => {
    state.refuse = true;
    const out = await applyAssessment({ orgId: "o1", projectId: "p1", checklistId: "cl1", proposals: [proposals[0]], confirmedItemIds: ["a"], actor });
    expect(out.applied).toBe(0);
    expect(out.refused).toBe(1);
    expect(out.error).toMatch(/no permission, or changed by someone else/);
    expect(audits()).toHaveLength(0);
    expect(state.tables.checklist_items.find((r) => r.id === "a")!.status).toBe("open");
  });

  it("a failed item read returns an error and touches nothing (QUAL-8 shape)", async () => {
    state.readError.checklist_items = { message: "network" };
    const out = await applyAssessment({ orgId: "o1", projectId: "p1", checklistId: "cl1", proposals, confirmedItemIds: ["a"], actor });
    expect(out.error).toBe("network");
    expect(itemWrites()).toHaveLength(0);
  });

  it("writes are guarded on updated_at as read (a concurrent change refuses) and run in parallel batches (PERF-7)", async () => {
    state.tables.checklist_items = Array.from({ length: 120 }, (_, i) => row({ id: `x${i}`, text: `Line ${i}`, updated_at: i === 0 ? null : "2026-09-01T00:00:00Z" }));
    const many = state.tables.checklist_items.map((r) => ({ itemId: r.id as string, applicability: "applies" as const, rationale: "in scope" }));
    const out = await applyAssessment({ orgId: "o1", projectId: "p1", checklistId: "cl1", proposals: many, confirmedItemIds: many.map((p) => p.itemId), actor });
    expect(out.applied).toBe(120);
    const writes = itemWrites();
    expect(writes).toHaveLength(120);
    // every write carries the optimistic guard: eq updated_at, or IS NULL for a never-touched row
    for (const w of writes) {
      const guard = w.filters.find(([k]) => k === "updated_at");
      expect(guard, `guard on ${JSON.stringify(w.filters)}`).toBeDefined();
    }
    expect(WRITE_BATCH).toBe(50);
    // the audit row is one row for the run, with every landed id
    const a = audits();
    expect(a).toHaveLength(1);
    expect((a[0].details as { items: unknown[] }).items).toHaveLength(120);
  });
});

// ── updateChecklistItem (SAF-3 / SAF-4) ──────────────────────────────────
describe("updateChecklistItem", () => {
  beforeEach(() => { state.tables.checklist_items = [row({})]; });

  it("refuses a blank, short or canned reason on N/A, satisfied and reopen — nothing written, nothing audited", async () => {
    for (const patch of [
      { applicability: "na" as const, status: "na" as const },
      { status: "satisfied" as const },
      { applicability: "applies" as const, status: "open" as const },
    ]) {
      for (const manualNote of ["", "   ", "ok", "decided by reviewer", undefined]) {
        const res = await updateChecklistItem({ orgId: "o1", projectId: "p1", item: mapped(), patch: { ...patch, manualNote }, actor });
        expect(res.ok, `${JSON.stringify(patch)} / ${JSON.stringify(manualNote)}`).toBe(false);
        expect(res.error).toMatch(/reason|Say why|isn't a reason/);
      }
    }
    expect(itemWrites()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
    expect(JSON.stringify(state.writes)).not.toContain("decided by reviewer");
  });

  it("a real reason lands, stamps the human actor, and audits after the confirmed match", async () => {
    const res = await updateChecklistItem({ orgId: "o1", projectId: "p1", item: mapped(), patch: { applicability: "na", status: "na", manualNote: "No hydrotest — this is an electrical-only scope" }, actor });
    expect(res.ok).toBe(true);
    const r = state.tables.checklist_items[0];
    expect(r.status).toBe("na");
    expect(r.updated_by).toBe("u1");
    expect(r.updated_by_name).toBe("mreyes");
    expect(audits().map((a) => a.action)).toEqual(["CHECKLIST_ITEM_UPDATED"]);
  });

  it("an RLS-refused override returns the refusal and writes NO audit row (SAF-3)", async () => {
    state.refuse = true;
    const res = await updateChecklistItem({ orgId: "o1", projectId: "p1", item: mapped(), patch: { status: "satisfied", manualNote: "Verified in the field 9/14 with the inspector" }, actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/don't have permission|someone else changed/);
    expect(audits()).toHaveLength(0);
    expect(state.tables.checklist_items[0].status).toBe("open");
  });

  it("attaching evidence alone needs no reason", async () => {
    const res = await updateChecklistItem({ orgId: "o1", projectId: "p1", item: mapped(), patch: { addEvidence: { label: "Hydro chart", documentId: "d9" } }, actor });
    expect(res.ok).toBe(true);
    expect((state.tables.checklist_items[0].evidence as unknown[])).toEqual([{ label: "Hydro chart", documentId: "d9", source: "manual" }]);
  });
});

// ── setChecklistStatus (QUAL-8 / QUAL-2 / SAF-3) ─────────────────────────
describe("setChecklistStatus('complete')", () => {
  beforeEach(() => { state.tables.project_checklists = [{ id: "cl1", org_id: "o1", project_id: "p1", status: "open" }]; });

  it("item read error ⇒ ok:false, nothing written", async () => {
    state.tables.checklist_items = [];
    state.readError.checklist_items = { message: "network" };
    const res = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Couldn't verify the items/);
    expect(state.tables.project_checklists[0].status).toBe("open");
    expect(audits()).toHaveLength(0);
  });

  it("zero items ⇒ ok:false (no vacuous completion)", async () => {
    state.tables.checklist_items = [];
    const res = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no items/);
    expect(state.tables.project_checklists[0].status).toBe("open");
  });

  it("the gate itself is unchanged: an unsatisfied applicable item still blocks", async () => {
    state.tables.checklist_items = [row({ status: "needs_evidence" })];
    const res = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not satisfied yet/);
  });

  it("records completed_basis: auto when a green rests on the sweep alone, human when every counted item carries a person", async () => {
    state.tables.checklist_items = [
      row({ id: "a", status: "satisfied", evidence: [{ label: "x", source: "auto" }] }),
      row({ id: "b", status: "na", applicability: "na", manual_note: "not in scope for this repipe" }),
    ];
    const r1 = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor });
    expect(r1).toEqual({ ok: true, basis: "auto" });
    expect(state.tables.project_checklists[0].completed_basis).toBe("auto");
    expect((audits()[0].details as { completedBasis: string }).completedBasis).toBe("auto");

    state.tables.project_checklists[0].status = "open";
    state.tables.checklist_items[0].manual_note = "Reviewed the hydro chart myself — 150 psig, 30 min";
    const r2 = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor });
    expect(r2).toEqual({ ok: true, basis: "human" });
    expect(state.tables.project_checklists[0].completed_basis).toBe("human");
  });

  it("a refused status write reports the refusal and audits nothing (SAF-3)", async () => {
    state.tables.checklist_items = [row({ status: "satisfied", manual_note: "verified on the walkdown 9/14" })];
    state.refuse = true;
    const res = await setChecklistStatus({ orgId: "o1", projectId: "p1", checklist: checklist(), status: "complete", actor });
    expect(res.ok).toBe(false);
    expect(audits()).toHaveLength(0);
  });
});

// ── gatherProjectEvidenceState (SAF-1 / QUAL-13 / QUAL-2) ────────────────
describe("gatherProjectEvidenceState — the evidence contract", () => {
  beforeEach(() => {
    state.tables.projects = [{ id: "p1", intake_collection_id: "intake", sow_document_id: null }];
    state.tables.turnover_items = [];
    state.tables.project_checklists = [];
    state.tables.assets = [];
    state.tables.document_versions = [];
  });

  it("an unreviewed Draft with a matching title does NOT enter the register; Void / Superseded / no-current-version are out too", async () => {
    state.tables.documents = [
      doc({ id: "draft", title: "Hydrotest Report", status: "Draft" }),
      doc({ id: "void", title: "Hydrotest Report Void", status: "Void" }),
      doc({ id: "sup", title: "Hydrotest Report Old", status: "Superseded" }),
      doc({ id: "nofile", title: "Hydrotest Report Nofile", current_version_id: null }),
      doc({ id: "issued", title: "E-301 Hydrotest Report", status: "Issued" }),
      doc({ id: "locked", title: "E-302 Hydrotest Report", status: "Locked" }),
    ];
    const s = await gatherProjectEvidenceState("o1", "p1");
    expect(s.documentTitles).toEqual(["E-301 Hydrotest Report", "E-302 Hydrotest Report"]);
    expect(s.documents!.map((d) => d.id)).toEqual(["issued", "locked"]);
  });

  it("an external (intake) submission counts only once its version is approved", async () => {
    state.tables.documents = [
      doc({ id: "ext-pending", title: "NDE Report A", status: "Issued" }),
      doc({ id: "ext-ok", title: "NDE Report B", status: "Issued" }),
    ];
    state.tables.document_versions = [
      { id: "v1", record_id: "ext-pending", provenance: "external", review_state: "in_review" },
      { id: "v2", record_id: "ext-ok", provenance: "external", review_state: "approved" },
    ];
    const s = await gatherProjectEvidenceState("o1", "p1");
    expect(s.documentTitles).toEqual(["NDE Report B"]);
  });

  it("documents on ACCEPTED turnover items come first, carry viaTurnover, and a rejected item's document does not count", async () => {
    state.tables.turnover_items = [
      { project_id: "p1", name: "NDE reports", status: "accepted", document_id: "nde-accepted" },
      { project_id: "p1", name: "MTRs", status: "rejected", document_id: "mtr-rejected" },
    ];
    state.tables.documents = [
      doc({ id: "intake-1", title: "Weld Log", collection_id: "intake" }),
      doc({ id: "nde-accepted", title: "NDE Report Pkg 4", collection_id: "other" }),
      doc({ id: "mtr-rejected", title: "MTR Package", collection_id: "other" }),
    ];
    const s = await gatherProjectEvidenceState("o1", "p1");
    expect(s.documents!.map((d) => [d.id, d.viaTurnover])).toEqual([["nde-accepted", true], ["intake-1", false]]);
    expect(s.turnoverAcceptedNames).toEqual(["NDE reports"]);
  });

  it("miChecklistComplete requires completed_basis = 'human' (QUAL-2) and fails closed when the column is missing", async () => {
    state.tables.documents = [];
    state.tables.project_checklists = [{ project_id: "p1", kind: "mi", status: "complete", completed_basis: "auto" }];
    expect((await gatherProjectEvidenceState("o1", "p1")).miChecklistComplete).toBe(false);
    state.tables.project_checklists = [{ project_id: "p1", kind: "mi", status: "complete", completed_basis: "human" }];
    expect((await gatherProjectEvidenceState("o1", "p1")).miChecklistComplete).toBe(true);
    state.tables.project_checklists = [{ project_id: "p1", kind: "mi", status: "complete" }]; // pre-migration row shape
    expect((await gatherProjectEvidenceState("o1", "p1")).miChecklistComplete).toBe(false);
  });
});

// ── runAutoEvidence (QUAL-1 / QUAL-6 / SAF-3 / PERF-7) ───────────────────
describe("runAutoEvidence", () => {
  beforeEach(() => {
    state.tables.projects = [{ id: "p1", intake_collection_id: "intake", sow_document_id: null }];
    state.tables.turnover_items = [];
    state.tables.project_checklists = [];
    state.tables.assets = [];
    state.tables.document_versions = [];
  });

  it("satisfies on an Issued document with the documentId attached and the machine actor stamped; the audit row names the item and citation", async () => {
    state.tables.documents = [doc({ id: "d1", title: "E-301 Hydrotest Report" })];
    state.tables.checklist_items = [row({ id: "a" })];
    const out = await runAutoEvidence({ orgId: "o1", projectId: "p1", checklistId: "cl1", actor });
    expect(out).toMatchObject({ satisfied: 1, needsEvidence: 0, retracted: 0, refused: 0, failed: 0 });
    const r = state.tables.checklist_items[0];
    expect(r.status).toBe("satisfied");
    expect(r.evidence).toEqual([{ label: 'Document on file: "E-301 Hydrotest Report"', documentId: "d1", source: "auto" }]);
    expect(r.updated_by).toBeNull();
    expect(r.updated_by_name).toBe(MACHINE_ACTOR_SWEEP);
    const a = audits();
    expect(a[0].action).toBe("CHECKLIST_AUTO_EVIDENCE");
    expect((a[0].details as { items: unknown[] }).items).toEqual([
      { itemId: "a", from: "open", to: "satisfied", citation: 'Document on file: "E-301 Hydrotest Report"', documentId: "d1" },
    ]);
  });

  it("RETRACTS: satisfy on a matching title, void the document, re-run — the item is no longer satisfied and the stale chip is gone (QUAL-1)", async () => {
    state.tables.documents = [doc({ id: "d1", title: "E-301 Hydrotest Report" })];
    state.tables.checklist_items = [row({ id: "a" })];
    await runAutoEvidence({ orgId: "o1", projectId: "p1", checklistId: "cl1", actor });
    expect(state.tables.checklist_items[0].status).toBe("satisfied");

    state.tables.documents[0].status = "Void";
    const out = await runAutoEvidence({ orgId: "o1", projectId: "p1", checklistId: "cl1", actor });
    expect(out).toMatchObject({ satisfied: 0, needsEvidence: 0, retracted: 1 });
    const r = state.tables.checklist_items[0];
    expect(r.status).toBe("needs_evidence");
    expect(r.evidence).toEqual([]);
    const last = audits().at(-1)!;
    expect((last.details as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ itemId: "a", from: "satisfied", to: "needs_evidence", retracted: true });
  });

  it("never touches a human chip: a satisfied item with a manual chip keeps it when the auto proof vanishes", async () => {
    state.tables.documents = [];
    state.tables.checklist_items = [row({ id: "a", status: "satisfied", evidence: [
      { label: 'Document on file: "gone"', source: "auto" }, { label: "walked down with ops", source: "manual" },
    ] })];
    const out = await runAutoEvidence({ orgId: "o1", projectId: "p1", checklistId: "cl1", actor });
    expect(out.retracted).toBe(0);
    expect(state.tables.checklist_items[0].status).toBe("satisfied");
    expect(state.tables.checklist_items[0].evidence).toHaveLength(2);
    expect(itemWrites()).toHaveLength(0);
  });

  it("a concurrent change between read and write is a refusal, not a lost chip (PERF-7)", async () => {
    state.tables.documents = [doc({ id: "d1", title: "E-301 Hydrotest Report" })];
    state.tables.checklist_items = [row({ id: "a", updated_at: "2026-09-01T00:00:00Z" })];
    // Someone else moves the row after our read: the updated_at guard misses.
    state.onRead = (table) => { if (table === "checklist_items") state.tables.checklist_items[0].updated_at = "2026-09-02T00:00:00Z"; };
    const out = await runAutoEvidence({ orgId: "o1", projectId: "p1", checklistId: "cl1", actor });
    expect(out.refused).toBe(1);
    expect(out.error).toMatch(/changed while the sweep ran/);
    expect(audits()).toHaveLength(0);
  });

  it("an RLS-refused sweep writes no audit row (SAF-3)", async () => {
    state.tables.documents = [doc({ id: "d1", title: "E-301 Hydrotest Report" })];
    state.tables.checklist_items = [row({ id: "a" })];
    state.refuse = true;
    const out = await runAutoEvidence({ orgId: "o1", projectId: "p1", checklistId: "cl1", actor });
    expect(out.satisfied).toBe(0);
    expect(audits()).toHaveLength(0);
  });
});
