// projects-tab SAF-21 — J15d CLIENT-PARAMETER WRITE SWEEP.
//
// The update / delete sites that write through a client handed in as a
// parameter (`db` / `sb` / `admin` / `client` `.from(…)`) now read their
// matched rows (DEC-90's J15 rulings, unchanged). Driven against the
// in-memory PostgREST stand-in (helpers/fakeSupabase), whose `refuseWrites`
// answers an UPDATE / DELETE with no rows (RLS's silent filter) and whose
// hooks below move a row out from under a write (another writer got there
// first). Each site: the zero-row answer as classed — (a) refused with no
// record claiming it, (b) said and never taken as written, (c) a quiet
// no-op that is not counted — and the ordinary path's writes unchanged.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

vi.mock("@/lib/unitCodeDecode", () => ({ decodeDocumentUnitCodes: async () => ({ results: [], notApplied: false }) }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import {
  computeForDocument, applyForDocument, dismissForDocument, reviewVanished, adoptDrawingRelation,
  LEDGER_ROW_GONE, PROPOSAL_GONE, LINKS_CHANGED,
} from "@/lib/equipmentBridgeServer";
import { rebuildSubtreePaths, rebuildSubtreeAclIndex, type CollectionTree, type CollectionTreeRow } from "@/lib/serverCollections";
import { persistReclaimShortfall } from "@/lib/archiveCatalog";
import { closeSucceededRun, RUN_ROW_UNMATCHED } from "@/lib/exportRunner";
import { reclockRetentionForDocs } from "@/lib/serverRetention";
import { sweepAndReserved } from "@/lib/intakeStaging";
import { markConsentPlanOpened } from "@/lib/consentWindowScan";
import { ATTEMPT_OUTCOME } from "@/lib/intakeRateLimit";

let db: FakeDb;
const fake = () => makeFakeSupabase(db) as unknown as SupabaseClient;

/** The stand-in, with `before(table, method, args)` run as each builder
 *  method is called — a hook moves a row out from under the write that
 *  follows (the fake filters when the statement runs). */
function hooked(before: (table: string, method: string, args: unknown[]) => void): SupabaseClient {
  const base = makeFakeSupabase(db);
  return {
    ...base,
    from: (t: string) => {
      const b = base.from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const wrap = (target: Record<string, (...a: unknown[]) => unknown>): unknown => new Proxy(target, {
        get(tg, prop: string) {
          const v = tg[prop];
          if (prop === "then" || typeof v !== "function") return v;
          return (...args: unknown[]) => { before(t, prop, args); const r = v(...args); return r === tg ? wrap(tg) : r; };
        },
      });
      return wrap(b);
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => { db = newFakeDb(); });

// ─── lib/equipmentBridgeServer.ts (14 sites) ────────────────────────────────

const SEGMENTS = [
  { kind: "unit", digits: 2 }, { kind: "drawing_type", digits: 2 }, { kind: "size", letters: 1 },
  { kind: "iterable" }, { kind: "sheet" },
];
const entry = (kind: string, code: string, label: string, tagPrefixes?: string[]): Row =>
  ({ id: `${kind}-${code}`, org_id: "o1", kind, code, label, meta: tagPrefixes ? { tagPrefixes } : {}, sort: 0, origin: "manual" });

/** The refinery of lib/__tests__/equipmentBridge.test.ts: E-22, V-101 and P-7 on 2002-D-10001. */
function seed() {
  db.tables = {
    codebook_entries: [
      entry("unit", "20", "Crude Unit"),
      entry("equipment_type", "10", "Vessels", ["V", "D"]), entry("equipment_type", "30", "Exchangers", ["E"]), entry("equipment_type", "50", "Pumps", ["P"]),
      entry("drawing_type", "02", "P&ID"),
    ],
    codebook_config: [{ org_id: "o1", drawing_number: { segments: SEGMENTS }, iterable_rule: { mirrorsTag: true, padTo: 0 } }],
    libraries: [{ id: "lib1", org_id: "o1", equipment_bridge: { targetColumnKey: "equipment" } }],
    documents: [{ id: "d1", org_id: "o1", library_id: "lib1", document_number: "2002-D-10001", title: "P&ID", name: "x.pdf", metadata: {}, current_version_id: "v2", status: "Issued" }],
    knowledge_documents: [{ id: "k1", org_id: "o1", library_id: "kl1", name: "x.pdf", source_document_id: "d1", status: "ready", source_version_id: "v2", source_rev: "B", vision_failed_pages: [] }],
    knowledge_page_entities: [
      { id: "e01", document_id: "k1", page: 1, kind: "equipment", tag: "E-22", raw: "E-22" },
      { id: "e02", document_id: "k1", page: 1, kind: "equipment", tag: "V-101", raw: "V-101" },
      { id: "e04", document_id: "k1", page: 2, kind: "equipment", tag: "P-7", raw: "P-7" },
      { id: "e05", document_id: "k1", page: 1, kind: "self", tag: "2002-D-10001", raw: "DWG 2002-D-10001 SH 4 REV B" },
    ],
    knowledge_chunks: [],
    assets: [
      { id: "a-e22", org_id: "o1", tag: "E-22", tag_normalized: "e22", unit_code: "20", code: "2030.22", archived: false, origin: "manual" },
      { id: "a-v101", org_id: "o1", tag: "V-101", tag_normalized: "v101", unit_code: "20", code: null, archived: false, origin: "manual" },
    ],
    asset_types: [],
    document_equipment_suggestions: [],
    document_assets: [],
    audit_logs: [],
  };
  db.unique = { assets: [["org_id", "tag_normalized"]], document_assets: [["document_id", "asset_id"]] };
}
const relations = () => db.tables.document_assets as Row[];
const ledger = () => db.tables.document_equipment_suggestions[0] as Row & { applied: string[] };
const audit = (action: string) => (db.tables.audit_logs ?? []).filter((l) => l.action === action);
async function applied() {
  seed();
  await computeForDocument(fake(), "o1", "d1");
  const r = await applyForDocument(fake(), { orgId: "o1", documentId: "d1", userId: "u1" });
  expect(relations().filter((x) => x.source === "drawing")).toHaveLength(3);
  return r;
}

describe("SAF-21 — the Bridge's apply (a / b / c)", () => {
  it("ordinary path: the column, the ledger, the review mark and the audit row land as before; nothing new is said", async () => {
    const r = await applied();
    expect(r.ledgerError).toBeUndefined();
    expect(r.codesFilled).toBe(1); // V-101 had a unit and no code (BR-7)
    expect(r.relations).toEqual({ written: 3, refreshed: 0, keptHuman: 0, notRecorded: null });
    expect(ledger()).toMatchObject({ status: "applied", applied_by: "u1" });
    expect(ledger().applied.sort()).toEqual(["E-22", "P-7", "V-101"]);
    expect((db.tables.documents[0].metadata as Row).equipment).toEqual(["E-22", "P-7", "V-101"]);
    expect((db.tables.libraries[0].equipment_bridge as Row).reviewedBy).toBe("u1");
    expect(audit("EQUIPMENT_BRIDGE_APPLIED")[0].details).toMatchObject({ ledgerError: null });
  });
  it("(b) the ledger write matched no row (the proposal went meanwhile): ledgerError says so, in the result and the audit row — never taken as written", async () => {
    seed();
    await computeForDocument(fake(), "o1", "d1");
    db.refuseWrites.add("document_equipment_suggestions");
    const r = await applyForDocument(fake(), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(r.ledgerError).toBe(LEDGER_ROW_GONE);
    expect(audit("EQUIPMENT_BRIDGE_APPLIED")[0].details).toMatchObject({ ledgerError: LEDGER_ROW_GONE });
    expect(LEDGER_ROW_GONE).not.toMatch(/nothing was changed/i);
  });
  it("(a) the column write matched no row (the document went meanwhile): the apply fails as a database error does, and the ledger is not marked applied", async () => {
    seed();
    await computeForDocument(fake(), "o1", "d1");
    db.refuseWrites.add("documents");
    await expect(applyForDocument(fake(), { orgId: "o1", documentId: "d1", userId: "u1" }))
      .rejects.toThrow("The tags were not written to the document's equipment column: the document was not found (it may have been removed meanwhile).");
    expect(ledger().applied).toEqual([]);
    expect(audit("EQUIPMENT_BRIDGE_APPLIED")).toHaveLength(0);
  });
  it("(b) the first-review mark that matched no row is logged; the apply still succeeds", async () => {
    seed();
    await computeForDocument(fake(), "o1", "d1");
    db.refuseWrites.add("libraries");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await applyForDocument(fake(), { orgId: "o1", documentId: "d1", userId: "u1" });
      expect(r.appliedTags.sort()).toEqual(["E-22", "P-7", "V-101"]);
      expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toMatch(/library lib1: the first-review mark was not saved — no row matched/);
    } finally { warn.mockRestore(); }
  });
  it("(c) a site code filled by someone else meanwhile (the IS NULL guard matched no row) is not counted filled", async () => {
    seed();
    await computeForDocument(fake(), "o1", "d1");
    const racing = hooked((t, m) => { if (t === "assets" && m === "update") db.tables.assets.find((a) => a.id === "a-v101")!.code = "2010.999"; });
    const r = await applyForDocument(racing, { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(r.codesFilled).toBe(0);
    expect(db.tables.assets.find((a) => a.id === "a-v101")!.code).toBe("2010.999");
  });
  it("(c) a recompute's refresh of a link that is no longer a 'drawing' row is left as it is — counted changedMeanwhile, never refreshed", async () => {
    await applied();
    const r1 = await computeForDocument(fake(), "o1", "d1");
    expect(r1.relations).toEqual({ written: 0, refreshed: 3, keptHuman: 0, notRecorded: null });
    db.refuseWrites.add("document_assets");
    const r2 = await computeForDocument(fake(), "o1", "d1");
    expect(r2.relations).toEqual({ written: 0, refreshed: 0, keptHuman: 0, notRecorded: null, changedMeanwhile: 3 });
  });
  it("(c) a revision-truth mark that matched no row is not counted (a mark counts only when it lands)", async () => {
    await applied();
    db.tables.knowledge_page_entities = db.tables.knowledge_page_entities.filter((e) => e.tag !== "P-7");
    db.refuseWrites.add("document_assets");
    const quiet = await computeForDocument(fake(), "o1", "d1");
    expect(quiet.revision).toMatchObject({ vanished: 0, complete: true });
    expect((quiet.revision as Row).failed).toBeUndefined();
    db.refuseWrites.delete("document_assets");
    const landed = await computeForDocument(fake(), "o1", "d1");
    expect(landed.revision).toMatchObject({ vanished: 1, complete: true });
  });
});

/** A database before 20261171: the ledger has no dismissed / sources /
 *  applied_columns columns (a write naming one is PGRST204), and the n-th
 *  ledger write — the retry without them — finds the proposal gone. */
function preLedgerColumnsAndGoneOn(nth: number): SupabaseClient {
  for (const r of db.tables.document_equipment_suggestions) for (const c of ["dismissed", "sources", "applied_columns"]) delete r[c];
  db.beforeUpdate = { document_equipment_suggestions: (next, old) => {
    if (["dismissed", "sources", "applied_columns"].some((c) => c in next && !(c in old))) throw { code: "PGRST204", message: "Could not find the 'dismissed' column of 'document_equipment_suggestions' in the schema cache" };
    return next;
  } };
  let n = 0;
  return hooked((t, m) => { if (t === "document_equipment_suggestions" && m === "update" && ++n === nth) db.tables.document_equipment_suggestions = []; });
}

describe("SAF-21 — the Bridge's pre-20261171 retries read their matched rows too", () => {
  it("(b) the apply's ledger retry that matched no row says LEDGER_ROW_GONE", async () => {
    seed();
    await computeForDocument(fake(), "o1", "d1");
    const r = await applyForDocument(preLedgerColumnsAndGoneOn(2), { orgId: "o1", documentId: "d1", userId: "u1" });
    expect(r.ledgerError).toBe(LEDGER_ROW_GONE);
  });
  it("(a) the dismissal's retry that matched no row is refused — nothing removed, no audit row", async () => {
    await applied();
    await expect(dismissForDocument(preLedgerColumnsAndGoneOn(2), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["P-7"] }))
      .rejects.toThrow(`The dismissal could not be saved: ${PROPOSAL_GONE}`);
    expect(relations().some((x) => x.tag_text === "P-7")).toBe(true);
    expect(audit("EQUIPMENT_BRIDGE_DISMISSED")).toHaveLength(0);
  });
  it("(c) a person-tagged pair whose drawing row was adopted meanwhile is not converted, counted or recorded; the ordinary conversion is", async () => {
    await applied();
    db.tables.documents[0].asset_tags = [{ tag: "e 22" }, { tag: "V-101" }];
    const racing = hooked((t, m, args) => {
      if (t === "document_assets" && m === "update" && (args[0] as Row).source === "jsonb_sync" && (args[0] as Row).tag_text === "e 22") relations().find((x) => x.asset_id === "a-e22")!.source = "manual";
    });
    const d = await dismissForDocument(racing, { orgId: "o1", documentId: "d1", userId: "u1", tags: ["E-22", "V-101"] });
    expect(d).toMatchObject({ relationsRemoved: 1, keptAsPersonsLink: 1 });
    expect(relations().find((x) => x.asset_id === "a-e22")).toMatchObject({ source: "manual" });
    expect(relations().find((x) => x.asset_id === "a-v101")).toMatchObject({ source: "jsonb_sync", tag_text: "V-101" });
    const details = audit("EQUIPMENT_BRIDGE_RELATION_REMOVED")[0].details as { removed: Array<{ tag: string }>; keptAsPersonsLink: Array<{ tag: string }> };
    expect(details.removed.map((r) => r.tag)).toEqual(["V-101"]);
    expect(details.keptAsPersonsLink.map((r) => r.tag)).toEqual(["V-101"]);
  });
});

describe("SAF-21 — the Bridge's review acts (a: the person's decision)", () => {
  it("Dismiss: a proposal that went meanwhile is refused — nothing removed, no audit row", async () => {
    await applied();
    db.refuseWrites.add("document_equipment_suggestions");
    await expect(dismissForDocument(fake(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["P-7"] }))
      .rejects.toThrow(`The dismissal could not be saved: ${PROPOSAL_GONE}`);
    expect(relations().filter((x) => x.source === "drawing")).toHaveLength(3);
    expect(audit("EQUIPMENT_BRIDGE_DISMISSED")).toHaveLength(0);
    expect(audit("EQUIPMENT_BRIDGE_RELATION_REMOVED")).toHaveLength(0);
  });
  it("Dismiss: a link adopted by a person meanwhile is neither removed nor recorded removed; the rest are", async () => {
    await applied();
    const racing = hooked((t, m) => {
      if (t === "document_assets" && m === "delete") relations().find((x) => x.asset_id === "a-e22")!.source = "manual";
    });
    const d = await dismissForDocument(racing, { orgId: "o1", documentId: "d1", userId: "u1", tags: ["E-22", "V-101"] });
    expect(d.relationsRemoved).toBe(1);
    expect(relations().find((x) => x.asset_id === "a-e22")).toMatchObject({ source: "manual" });
    expect(relations().some((x) => x.asset_id === "a-v101")).toBe(false);
    const removed = audit("EQUIPMENT_BRIDGE_RELATION_REMOVED")[0].details as { removed: Array<{ tag: string }> };
    expect(removed.removed.map((r) => r.tag)).toEqual(["V-101"]);
    expect(audit("EQUIPMENT_BRIDGE_DISMISSED")[0].details).toMatchObject({ relationsRemoved: 1 });
  });
  it("Dismiss: when no link removal matched, no removal audit row is written (the dismissal itself stands and is recorded)", async () => {
    await applied();
    db.refuseWrites.add("document_assets");
    const d = await dismissForDocument(fake(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["P-7"] });
    expect(d).toMatchObject({ dismissed: ["P-7"], relationsRemoved: 0 });
    expect(audit("EQUIPMENT_BRIDGE_RELATION_REMOVED")).toHaveLength(0);
    expect(audit("EQUIPMENT_BRIDGE_DISMISSED")[0].details).toMatchObject({ relationsRemoved: 0 });
  });
  it("Dismiss, ordinary path: every link removed and recorded, as before", async () => {
    await applied();
    const d = await dismissForDocument(fake(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["E-22", "V-101"] });
    expect(d).toEqual({ dismissed: ["E-22", "V-101"], relationsRemoved: 2, remembered: true });
    const removed = audit("EQUIPMENT_BRIDGE_RELATION_REMOVED")[0].details as { removed: Array<{ tag: string }> };
    expect(removed.removed.map((r) => r.tag)).toEqual(["E-22", "V-101"]);
  });
  it("'It left the sheet': a proposal that went meanwhile is refused before anything is removed", async () => {
    await applied();
    relations().find((x) => x.tag_text === "P-7")!.vanished_at = "2026-10-01T00:00:00Z";
    db.refuseWrites.add("document_equipment_suggestions");
    await expect(reviewVanished(fake(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["P-7"], decision: "remove" }))
      .rejects.toThrow(`The review could not be saved: ${PROPOSAL_GONE}`);
    expect(relations().some((x) => x.tag_text === "P-7")).toBe(true);
    expect(audit("EQUIPMENT_BRIDGE_VANISHED_REMOVED")).toHaveLength(0);
  });
  it("'It is still there': refused when no link matched (no audit row); a partial match keeps and records only what matched", async () => {
    await applied();
    for (const x of relations()) x.vanished_at = "2026-10-01T00:00:00Z";
    db.refuseWrites.add("document_assets");
    await expect(reviewVanished(fake(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["E-22", "V-101"], decision: "keep" }))
      .rejects.toThrow(`The review could not be saved: ${LINKS_CHANGED}`);
    expect(audit("EQUIPMENT_BRIDGE_VANISHED_KEPT")).toHaveLength(0);
    db.refuseWrites.delete("document_assets");
    const racing = hooked((t, m) => {
      if (t === "document_assets" && m === "update") relations().find((x) => x.asset_id === "a-e22")!.source = "manual";
    });
    const r = await reviewVanished(racing, { orgId: "o1", documentId: "d1", userId: "u1", tags: ["E-22", "V-101"], decision: "keep" });
    expect(r).toEqual({ changed: 1 });
    expect(audit("EQUIPMENT_BRIDGE_VANISHED_KEPT")[0].details).toMatchObject({ tags: ["V-101"] });
  });
  it("'It is still there', ordinary path: every row kept and recorded, as before", async () => {
    await applied();
    for (const x of relations()) x.vanished_at = "2026-10-01T00:00:00Z";
    expect(await reviewVanished(fake(), { orgId: "o1", documentId: "d1", userId: "u1", tags: ["E-22", "V-101"], decision: "keep" })).toEqual({ changed: 2 });
    expect(audit("EQUIPMENT_BRIDGE_VANISHED_KEPT")[0].details).toMatchObject({ tags: ["E-22", "V-101"], confirmedOn: "v2" });
    expect(relations().filter((x) => x.asset_id !== "a-p7" && x.tag_text !== "P-7").every((x) => x.vanished_at === null)).toBe(true);
  });
  it("Adopt: a link that stopped being the drawing's meanwhile is refused — no audit row; the ordinary path is unchanged", async () => {
    await applied();
    const racing = hooked((t, m) => {
      if (t === "document_assets" && m === "update") relations().find((x) => x.asset_id === "a-e22")!.source = "jsonb_sync";
    });
    await expect(adoptDrawingRelation(racing, { orgId: "o1", documentId: "d1", assetId: "a-e22", userId: "u-drafter" }))
      .rejects.toThrow(`The link could not be saved: ${LINKS_CHANGED}`);
    expect(audit("EQUIPMENT_BRIDGE_RELATION_ADOPTED")).toHaveLength(0);
    expect(await adoptDrawingRelation(fake(), { orgId: "o1", documentId: "d1", assetId: "a-v101", userId: "u-drafter" })).toEqual({ adopted: true, already: null });
    expect(audit("EQUIPMENT_BRIDGE_RELATION_ADOPTED")).toHaveLength(1);
  });
});

// ─── lib/serverCollections.ts (3) — (c) ────────────────────────────────────

function treeOf(rows: CollectionTreeRow[]): CollectionTree {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map<string | null, CollectionTreeRow[]>();
  for (const r of rows) childrenOf.set(r.parent_id, [...(childrenOf.get(r.parent_id) ?? []), r]);
  return { byId, childrenOf };
}

describe("SAF-21 — lib/serverCollections.ts: a folder or document deleted since the tree was read is not counted rewritten; an error still fails loudly", () => {
  const rows: CollectionTreeRow[] = [
    { id: "f1", parent_id: null, name: "Top" }, { id: "f2", parent_id: "f1", name: "Mid" }, { id: "f3", parent_id: "f2", name: "Leaf" },
  ];
  it("paths: every node rewritten on the ordinary path; a gone one is skipped, not counted", async () => {
    db.tables.collections = rows.map((r) => ({ ...r }));
    expect(await rebuildSubtreePaths(fake(), treeOf(rows), ["f1"])).toBe(3);
    expect(db.tables.collections.find((c) => c.id === "f3")).toMatchObject({ path_names: ["Top", "Mid", "Leaf"], path_ids: ["f1", "f2"] });
    db.tables.collections = db.tables.collections.filter((c) => c.id !== "f3");
    expect(await rebuildSubtreePaths(fake(), treeOf(rows), ["f1"])).toBe(2);
    db.beforeUpdate = { collections: () => { throw { code: "57014", message: "statement timeout" }; } };
    await expect(rebuildSubtreePaths(fake(), treeOf(rows), ["f1"])).rejects.toThrow("Couldn't rewrite subtree paths: statement timeout");
  });
  it("acl_index: folders and documents counted only when their row matched", async () => {
    db.tables.collections = rows.map((r) => ({ ...r }));
    db.tables.documents = [{ id: "d1", collection_id: "f2", acl: null }, { id: "d2", collection_id: "f3", acl: null }];
    expect(await rebuildSubtreeAclIndex(fake(), treeOf(rows), null, ["f1"], Date.now())).toEqual({ folders: 3, documents: 2 });
    db.refuseWrites.add("documents");
    expect(await rebuildSubtreeAclIndex(fake(), treeOf(rows), null, ["f1"], Date.now())).toEqual({ folders: 3, documents: 0 });
    db.refuseWrites.add("collections");
    expect(await rebuildSubtreeAclIndex(fake(), treeOf(rows), null, ["f1"], Date.now())).toEqual({ folders: 0, documents: 0 });
    db.refuseWrites.clear();
    db.beforeUpdate = { collections: () => { throw { code: "42501", message: "permission denied" }; } };
    await expect(rebuildSubtreeAclIndex(fake(), treeOf(rows), null, ["f1"], Date.now())).rejects.toThrow("Couldn't rewrite subtree acl_index: permission denied");
  });
});

// ─── lib/archiveCatalog.ts (1) — (b) ───────────────────────────────────────

describe("SAF-21 — persistReclaimShortfall: a catalog row that matched no write is reported, never persisted", () => {
  it("ok on a matched row; a missing row and a pre-migration column each say why", async () => {
    db.tables.archives = [{ id: "c1", org_id: "o1", archive_id: "A1", reclaim_shortfall: 0 }];
    expect(await persistReclaimShortfall(fake(), "o1", "A1", 4)).toEqual({ ok: true });
    expect(db.tables.archives[0].reclaim_shortfall).toBe(4);
    expect(await persistReclaimShortfall(fake(), "o1", "A-gone", 4)).toEqual({
      ok: false, error: "shortfall persist: no catalog row for archive A-gone matched — the catalog cannot show that 4 key(s) failed to delete",
    });
    db.beforeUpdate = { archives: () => { throw { code: "PGRST204", message: "Could not find the 'reclaim_shortfall' column of 'archives' in the schema cache" }; } };
    expect(await persistReclaimShortfall(fake(), "o1", "A1", 4)).toMatchObject({ ok: false, error: expect.stringMatching(/reclaim_shortfall is not applied yet \(migration 20261077 §6\)/) });
  });
});

// ─── lib/exportRunner.ts (3) — (b) ─────────────────────────────────────────

describe("SAF-21 — closeSucceededRun: a run row that matched no write comes back as the error, never as closed", () => {
  const outcome = { deleted: 2, failed: 0 } as Parameters<typeof closeSucceededRun>[3];
  it("no purge: closed on a match; RUN_ROW_UNMATCHED when the row went", async () => {
    db.tables.export_runs = [{ id: "run1", status: "running" }];
    expect(await closeSucceededRun(fake(), "run1", { status: "succeeded" }, undefined)).toEqual({ error: null, retention: "none" });
    expect(db.tables.export_runs[0].status).toBe("succeeded");
    expect(await closeSucceededRun(fake(), "run-gone", { status: "succeeded" }, undefined)).toEqual({ error: { message: RUN_ROW_UNMATCHED }, retention: "none" });
  });
  it("with retention columns: written on a match; close-failed (unmatched) when the row went; the pre-migration retry still classifies the whole error", async () => {
    db.tables.export_runs = [{ id: "run1", status: "running" }];
    expect(await closeSucceededRun(fake(), "run1", { status: "succeeded" }, outcome)).toEqual({ error: null, retention: "written" });
    expect(db.tables.export_runs[0]).toMatchObject({ status: "succeeded", retention_deleted: 2, retention_failed: 0 });
    expect(await closeSucceededRun(fake(), "run-gone", { status: "succeeded" }, outcome)).toEqual({ error: { message: RUN_ROW_UNMATCHED }, retention: "close-failed" });
    db.tables.export_runs = [{ id: "run1", status: "running" }];
    db.beforeUpdate = { export_runs: (next) => { if (Object.keys(next).some((k) => /^retention_/.test(k))) throw { code: "PGRST204", message: "Could not find the 'retention_deleted' column of 'export_runs' in the schema cache" }; return next; } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await closeSucceededRun(fake(), "run1", { status: "succeeded" }, outcome)).toEqual({ error: null, retention: "unrecorded" });
      // …and the retry without them matched no row (the run row went between the two writes)
      db.tables.export_runs = [{ id: "run1", status: "running" }];
      let n = 0;
      const gone = hooked((t, m) => { if (t === "export_runs" && m === "update" && ++n === 2) db.tables.export_runs = []; });
      expect(await closeSucceededRun(gone, "run1", { status: "succeeded" }, outcome)).toEqual({ error: { message: RUN_ROW_UNMATCHED }, retention: "unrecorded" });
    } finally { warn.mockRestore(); }
  });
});

// ─── lib/serverRetention.ts (1) — (c) ──────────────────────────────────────

describe("SAF-21 — reclockRetentionForDocs: a document deleted since it was read is not counted re-clocked", () => {
  it("updated counts matched rows; an error is counted failed with its message, as before", async () => {
    const policy = { enabled: true, years: 7, basis: "created" } as unknown as Parameters<typeof reclockRetentionForDocs>[2];
    const doc = (id: string) => ({ id, retention_policy: null, created_at: "2020-01-01T00:00:00Z", updated_at: null, effective_date: null, retention_until: null, disposition_state: null });
    db.tables.documents = [doc("d1")];
    const docs = [doc("d1"), doc("d-gone")] as unknown as Parameters<typeof reclockRetentionForDocs>[1];
    expect(await reclockRetentionForDocs(fake(), docs, policy, null)).toEqual({ updated: 1, failed: 0, firstError: null });
    expect(db.tables.documents[0]).toMatchObject({ retention_until: "2027-01-01", disposition_state: "active" });
    db.beforeUpdate = { documents: () => { throw { code: "42501", message: "permission denied for table documents" }; } };
    expect(await reclockRetentionForDocs(fake(), [doc("d1")] as unknown as Parameters<typeof reclockRetentionForDocs>[1], { enabled: true, years: 8, basis: "created" } as unknown as Parameters<typeof reclockRetentionForDocs>[2], null))
      .toEqual({ updated: 0, failed: 1, firstError: "permission denied for table documents" });
  });
});

// ─── lib/intakeStaging.ts (1) — (c) ────────────────────────────────────────

describe("SAF-21 — sweepAndReserved: a reservation claimed meanwhile is neither swept nor counted reserved", () => {
  const ID1 = "11111111-1111-4111-8111-111111111111", ID2 = "22222222-2222-4222-8222-222222222222";
  const old = new Date(Date.now() - 7 * 86_400_000).toISOString();
  it("an expired staged row is swept; one whose outcome moved meanwhile is left; an error keeps it counting", async () => {
    db.tables.intake_attempts = [
      { id: ID1, link_id: "L1", outcome: ATTEMPT_OUTCOME.staged, bytes: 100, created_at: old },
      { id: ID2, link_id: "L1", outcome: ATTEMPT_OUTCOME.staged, bytes: 50, created_at: old },
    ];
    const racing = hooked((t, m, args) => {
      if (t === "intake_attempts" && m === "eq" && args[0] === "id" && args[1] === ID2) db.tables.intake_attempts.find((r) => r.id === ID2)!.outcome = "accepted";
    });
    const removed: string[] = [];
    const r = await sweepAndReserved(racing, { linkId: "L1", prefix: "p/", removeObject: async (k) => { removed.push(k); return true; } });
    expect(r).toEqual({ reservedBytes: 0, swept: 1 });
    expect(db.tables.intake_attempts.map((x) => x.id)).toEqual([ID2]);
    db.tables.intake_attempts = [{ id: ID1, link_id: "L1", outcome: ATTEMPT_OUTCOME.staged, bytes: 100, created_at: old }];
    db.deleteErrors = { intake_attempts: { code: "57014", message: "statement timeout" } };
    expect(await sweepAndReserved(fake(), { linkId: "L1", prefix: "p/", removeObject: async () => true })).toEqual({ reservedBytes: 100, swept: 0 });
  });
});

// ─── lib/consentWindowScan.ts markConsentPlanOpened (1) — (c) ──────────────

describe("SAF-21 — markConsentPlanOpened: the compare-and-set reads its matched rows; a race stays quiet (the next run re-marks)", () => {
  const roster = { id: "R1", consentPlan: { kind: "open" } };
  const ticket = () => ({ id: "t1", consent_window_roster: "R1", last_modified: "2026-11-01T00:00:00Z", metadata: { review_roster: { ...roster } } });
  it("marked on a match; a write that raced it leaves the plan open and answers null; an error is answered", async () => {
    db.tables.tickets = [ticket()];
    expect(await markConsentPlanOpened(fake() as never, { ticketId: "t1", rosterId: "R1" })).toBeNull();
    expect((db.tables.tickets[0].metadata as { review_roster: { consentPlan: { kind: string } } }).review_roster.consentPlan.kind).toBe("opened");
    db.tables.tickets = [ticket()];
    // another writer's save lands between the read and the mark (a new row object: the read keeps its own copy)
    const racing = hooked((t, m) => { if (t === "tickets" && m === "update") db.tables.tickets[0] = { ...db.tables.tickets[0], last_modified: "2026-11-02T00:00:00Z" }; });
    expect(await markConsentPlanOpened(racing as never, { ticketId: "t1", rosterId: "R1" })).toBeNull();
    expect((db.tables.tickets[0].metadata as { review_roster: { consentPlan: { kind: string } } }).review_roster.consentPlan.kind).toBe("open");
    db.beforeUpdate = { tickets: () => { throw { code: "40001", message: "could not serialize access" }; } };
    expect(await markConsentPlanOpened(fake() as never, { ticketId: "t1", rosterId: "R1" })).toBe("could not serialize access");
  });
});

afterEach(() => { vi.restoreAllMocks(); });
