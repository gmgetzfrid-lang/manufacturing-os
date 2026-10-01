// intelligence Round G (I-13) — GAP-305 one unit identity: the decode's
// planner (lib/operationalGraph.ts planUnitIdentity), the backfill route
// (POST /api/admin/unit-identity) and the migration's shape
// (supabase/migrations/20261138_intel_roundG_unit_identity.sql).
//
// The route is driven over helpers/graphFakeDb.ts standing in for the
// service-role client (vi.hoisted state + the stand-in, sweepRoundD3's
// pattern). The migration was also applied to a scratch PostgreSQL 16 with
// stubbed auth during the work (every probe true; a person's write refused
// 42501, a person's insert landing NULL, a renumber dropping the decode, anon
// refused EXECUTE on the count) — that run is recorded in GAP-305's
// Resolution block, not repeated here (no database runs in the suite).
// The projection triggers (trg_assets_unit_id_follows_filing,
// trg_units_codebook_code_follow) were run the same way; here they are
// stood in for by assetsFollowFiling / unitsFollowMapping below, transcribed
// rule for rule from the SQL, so the app's own writes (the decode, a refile
// through lib/assets.ts, a remap through setUnitCodebookCode) are exercised
// against what the database does with them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { GraphFakeDb, Row } from "./helpers/graphFakeDb";

const db = vi.hoisted(() => ({
  tables: {}, missingTables: new Set<string>(), missingColumns: {}, readError: {}, hidden: {},
  refuseWrites: new Set<string>(), writeError: {}, rpc: {}, calls: [], seq: 0,
}) as unknown as GraphFakeDb);

vi.mock("@/lib/supabaseAdmin", async () => {
  const { makeGraphFake } = await import("./helpers/graphFakeDb");
  const fake = makeGraphFake(db);
  return {
    supabaseAdmin: {
      ...fake,
      auth: {
        getUser: async (t: string) => t === "good"
          ? { data: { user: { id: "uid-1", email: "a@x.test" } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
      },
    },
  };
});
vi.mock("@/lib/supabase", async () => {
  const { makeGraphFake } = await import("./helpers/graphFakeDb");
  return { supabase: makeGraphFake(db) };
});

import {
  planUnitIdentity, setUnitCodebookCode, getScopeTree, runUnitIdentityBackfill, listCodebookMappings, listCodebookUnits,
  UNIT_IDENTITY_WRITE_BUDGET, type UnitIdentityReport,
} from "@/lib/operationalGraph";
import { createAsset, updateAsset } from "@/lib/assets";
import { searchAssets } from "@/lib/search";
import { EMPTY_CODEBOOK, type Codebook, type CodebookEntry } from "@/lib/codebook";
import { adminSurface } from "@/lib/adminSurfaces";
import { POST } from "@/app/api/admin/unit-identity/route";

const ORG = "org-1";
const o = <T extends Row>(r: T): T & { org_id: string } => ({ org_id: ORG, ...r });

const SEGMENTS = [{ kind: "unit", digits: 2 }, { kind: "drawing_type", digits: 2 }, { kind: "size", letters: 1 }, { kind: "iterable" }, { kind: "sheet" }];
const entry = (kind: CodebookEntry["kind"], code: string, label: string): CodebookEntry =>
  ({ id: `${kind}-${code}`, kind, code, label, meta: {}, sort: 0, origin: "manual" });
const BOOK: Codebook = {
  ...EMPTY_CODEBOOK,
  units: [entry("unit", "20", "Crude Unit"), entry("unit", "30", "Coker")],
  drawingTypes: [entry("drawing_type", "02", "P&ID")],
  drawingNumber: { segments: SEGMENTS as Codebook["drawingNumber"] extends infer T ? T extends { segments: infer S } ? S : never : never },
};

describe("planUnitIdentity — the decode is written, never guessed", () => {
  const units = [{ id: "u20", codebook_code: "20" }, { id: "u30", codebook_code: "30" }, { id: "u99", codebook_code: null }];

  it("documents.unit_code = the decoded unit the codebook holds; everything else is reported and left empty", () => {
    const plan = planUnitIdentity({
      book: BOOK, units, assets: [], dryRun: true,
      docs: [
        { id: "d1", document_number: "2002-D-10001 SHT 4", unit_code: null, unit_id: "u20" },  // decodes → 20, agrees
        { id: "d2", document_number: "3002-D-1", unit_code: null, unit_id: "u20" },            // decodes → 30, disagrees with u20
        { id: "d3", document_number: "4402-D-7", unit_code: null, unit_id: null },             // decodes → 44: not in the codebook
        { id: "d4", document_number: "CU-PID-7", unit_code: "20", unit_id: null },             // does not decode: cleared
        { id: "d5", document_number: "", unit_code: null, unit_id: null },                     // no number
        { id: "d6", document_number: "2002-D-2", unit_code: "20", unit_id: "u99" },            // already right; unit_id unmapped
      ],
    });
    const r = plan.report.documents;
    expect(r).toMatchObject({ scanned: 6, decoded: 3, toWrite: 3, toClear: 1, noNumber: 1, disagreeWithUnitId: 1, unitIdUnmapped: 1 });
    expect(r.unknownUnit).toEqual({ count: 1, codes: [{ code: "44", count: 1 }], unlisted: 0 });
    expect(r.notDecoding.count).toBe(1);
    expect(r.notDecoding.samples[0].number).toBe("CU-PID-7");
    expect(r.notDecoding.samples[0].reason).toMatch(/expects 2 digits but found "CU"/);
    expect(plan.docWrites.get("20")).toEqual(["d1"]);
    expect(plan.docWrites.get("30")).toEqual(["d2"]);
    expect(plan.docWrites.get(null)).toEqual(["d4"]);
    expect(plan.docWrites.has("44")).toBe(false); // never written: not a codebook unit
  });

  it("an empty or format-less codebook writes NOTHING to documents (a failed codebook load must never clear the decodes)", () => {
    for (const book of [EMPTY_CODEBOOK, { ...BOOK, drawingNumber: null }, { ...BOOK, units: [] }]) {
      const plan = planUnitIdentity({ book, units, assets: [], dryRun: true, docs: [{ id: "d1", document_number: "2002-D-1", unit_code: "20", unit_id: null }] });
      expect(plan.docWrites.size).toBe(0);
      expect(plan.report.documents.toWrite).toBe(0);
      expect(plan.report.notes.join("\n")).toMatch(/nothing was written to documents/);
    }
  });

  it("assets.unit_id is FILLED from the mapping where it is empty — a value already there is never re-pointed or cleared, only counted", () => {
    const plan = planUnitIdentity({
      book: BOOK, units, docs: [], dryRun: true,
      assets: [
        { id: "a1", unit_code: "20", unit_id: null },    // empty: filled
        { id: "a2", unit_code: "30", unit_id: "u20" },   // held, filing maps elsewhere: kept, counted
        { id: "a3", unit_code: null, unit_id: "u30" },   // held (a mapped unit), unfiled: kept — never cleared
        { id: "a4", unit_code: null, unit_id: "u99" },   // held (an unmapped unit), unfiled: kept
        { id: "a5", unit_code: "20", unit_id: "u20" },   // already right
        { id: "a6", unit_code: "77", unit_id: null },    // unmapped code: nothing to project
        { id: "a7", unit_code: "77", unit_id: "u20" },   // held, filing maps to none: kept
      ],
    });
    expect(plan.report.assets).toMatchObject({ scanned: 7, toSet: 1, disagreeWithFiling: 1, keptWithoutFiling: 3 });
    expect([...plan.assetWrites.entries()]).toEqual([["u20", ["a1"]]]);
    for (const ids of plan.assetWrites.values()) {
      for (const id of ids) expect(["a1"]).toContain(id); // only an empty unit_id is ever written
    }
    expect(plan.report.mapping).toEqual({ operationalUnits: 3, mapped: 2, codebookUnitsUnmapped: [] });
    expect(plan.report.remaining).toBe(0);
  });

  it("a restricted document's number (and the unknown unit it names) is listed only to a caller who sees every document", () => {
    const docs = [
      { id: "d1", document_number: "HR-INV-2026-004", unit_code: null, unit_id: null, visibility: "private" },
      { id: "d2", document_number: "CU-PID-7", unit_code: null, unit_id: null, visibility: "normal" },
      { id: "d3", document_number: "OPS-1", unit_code: null, unit_id: null, visibility: null },
      { id: "d4", document_number: "5502-D-1", unit_code: null, unit_id: null, visibility: "hidden" },
      { id: "d5", document_number: "4402-D-1", unit_code: null, unit_id: null, visibility: "normal" },
    ];
    const member = planUnitIdentity({ book: BOOK, units, assets: [], dryRun: true, docs }).report.documents;
    expect(member.notDecoding.count).toBe(3);
    expect(member.notDecoding.unlisted).toBe(1);
    expect(member.notDecoding.samples.map((x) => x.number)).toEqual(["CU-PID-7", "OPS-1"]);
    expect(JSON.stringify(member)).not.toContain("HR-INV");
    expect(member.unknownUnit).toEqual({ count: 2, codes: [{ code: "44", count: 1 }], unlisted: 1 });
    expect(JSON.stringify(member)).not.toContain('"55"');

    const controller = planUnitIdentity({ book: BOOK, units, assets: [], dryRun: true, docs, seesRestricted: true }).report.documents;
    expect(controller.notDecoding).toMatchObject({ count: 3, unlisted: 0 });
    expect(controller.notDecoding.samples.map((x) => x.number)).toContain("HR-INV-2026-004");
    expect(controller.unknownUnit.unlisted).toBe(0);
    expect(controller.unknownUnit.codes.map((c) => c.code).sort()).toEqual(["44", "55"]);
  });
});

// ── 20261138's projection triggers, stood in for ─────────────────────────

/** The non-archived unit holding a codebook code (UNIQUE per org), as the
 *  triggers' subqueries read it. */
const holderOf = (org: unknown, code: unknown, except?: unknown): string | null => {
  if (code === null || code === undefined) return null;
  const u = (db.tables.units ?? []).find((x) => x.org_id === org && x.codebook_code === code && !x.archived && x.id !== except);
  return u ? String(u.id) : null;
};
/** trg_assets_unit_id_follows_filing (BEFORE INSERT OR UPDATE OF unit_code
 *  ON assets): `old` null is an INSERT. Returns what lands. */
function assetsFollowFiling(old: Row | null, row: Row): Row {
  if (old === null) {
    if (row.unit_id != null) return row;                                 // an insert that names its unit keeps it
    return { ...row, unit_id: holderOf(row.org_id, row.unit_code) };
  }
  if (!("unit_code" in row)) return row;                                 // UPDATE OF unit_code only
  const next = { ...old, ...row };
  if ((next.unit_id ?? null) !== (old.unit_id ?? null)) return row;       // the write sets unit_id: as written
  if (old.unit_id != null) {
    if ((next.unit_code ?? null) === (old.unit_code ?? null)) return row; // not refiled: stays
    if (holderOf(old.org_id, old.unit_code) !== old.unit_id) return row;  // set by hand: kept
  }
  return { ...row, unit_id: holderOf(next.org_id, next.unit_code) };
}
/** units_codebook_code_guard's archive release, then trg_units_codebook_code_follow
 *  (AFTER): projected equipment follows the old code to its holder (none),
 *  and equipment under the new code with no unit takes this one. */
function unitsFollowMapping(old: Row, patch: Row): Row {
  const landed = { ...patch, ...((patch.archived ?? old.archived) ? { codebook_code: null } : {}) };
  const was = old.codebook_code ?? null, now = ({ ...old, ...landed }).codebook_code ?? null;
  if (was === now) return landed;
  for (const a of db.tables.assets ?? []) {
    if (a.org_id !== old.org_id) continue;
    if (was !== null && a.unit_id === old.id && a.unit_code === was) a.unit_id = holderOf(old.org_id, was, old.id);
    if (now !== null && a.unit_code === now && (a.unit_id ?? null) === null) a.unit_id = old.id;
  }
  return landed;
}
const installProjection = () => {
  db.triggers = { assets: (r, p) => assetsFollowFiling(r, p), units: unitsFollowMapping };
  db.insertTriggers = { assets: (r) => assetsFollowFiling(null, r) };
};

// ── The route ────────────────────────────────────────────────────────────

function seed(over: Partial<Record<string, Row[]>> = {}) {
  db.tables = {
    org_members: [
      o({ uid: "uid-1", role: "Viewer", roles: ["Viewer", "DocCtrl"], status: "active", email: "a@x.test" }),
      o({ uid: "uid-2", role: "Viewer", roles: ["Viewer"], status: "active", email: "v@x.test" }),
    ],
    codebook_entries: [
      o({ id: "e20", kind: "unit", code: "20", label: "Crude Unit", meta: {}, sort: 0, origin: "manual" }),
      o({ id: "e30", kind: "unit", code: "30", label: "Coker", meta: {}, sort: 1, origin: "manual" }),
    ],
    codebook_config: [o({ drawing_number: { segments: SEGMENTS }, iterable_rule: { mirrorsTag: true, padTo: 0 }, legend_doc_ids: [] })],
    units: [o({ id: "u20", codebook_code: "20", archived: false }), o({ id: "u30", codebook_code: null, archived: false })],
    documents: [
      o({ id: "d1", document_number: "2002-D-10001", unit_code: null, unit_id: null }),
      o({ id: "d2", document_number: "PID-OLD-7", unit_code: "20", unit_id: null }),
      o({ id: "d3", document_number: "9902-D-1", unit_code: null, unit_id: null }),
    ],
    assets: [o({ id: "a1", unit_code: "20", unit_id: null }), o({ id: "a2", unit_code: null, unit_id: "u30" })],
    audit_logs: [],
    ...over,
  } as Record<string, Row[]>;
  db.missingTables = new Set(); db.missingColumns = {}; db.readError = {}; db.hidden = {};
  db.refuseWrites = new Set(); db.writeError = {}; db.rpc = {}; db.calls = []; db.seq = 0;
  installProjection();
  db.maxRows = 1000; db.beforeWrite = null;
}

const call = (body: unknown, token: string | null = "good") => POST(new NextRequest("http://x/api/admin/unit-identity", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}));
const row = (t: string, id: string) => db.tables[t].find((r) => r.id === id)!;

beforeEach(() => seed());

describe("POST /api/admin/unit-identity", () => {
  it("refuses an anonymous caller and a member outside the scope page's writer tier", async () => {
    expect((await call({ orgId: ORG }, null)).status).toBe(401);
    expect((await call({ orgId: ORG }, "nope")).status).toBe(401);
    db.tables.org_members = db.tables.org_members.map((m) => ({ ...m, roles: ["Viewer"] }));
    const r = await call({ orgId: ORG, dryRun: false });
    expect(r.status).toBe(403);
    expect(row("documents", "d1").unit_code).toBeNull();
  });

  it("authority is the role COLLECTION from ADMIN_SURFACES 'scope' (an additive DocCtrl under a Viewer headline is admitted)", async () => {
    expect((await call({ orgId: ORG })).status).toBe(200);
    const src = readFileSync("app/api/admin/unit-identity/route.ts", "utf8");
    expect(src).toContain('adminSurface("scope")?.writes');
    expect(src).toContain("memberHoldsAny(member, writers)");
    expect(src).not.toMatch(/"Admin"|"DocCtrl"|"Manager"|"Supervisor"/);
  });

  it("before 20261138 it refuses with the migration named (409), writing nothing", async () => {
    db.missingColumns = { units: ["codebook_code"], documents: ["unit_code"] };
    const r = await call({ orgId: ORG, dryRun: false });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/20261138/);
  });

  it("a preview (the default) reports and writes nothing", async () => {
    const r = await call({ orgId: ORG });
    const body = await r.json();
    expect(body.dryRun).toBe(true);
    expect(body.documents).toMatchObject({ scanned: 3, decoded: 1, toWrite: 2, toClear: 1, written: 0 });
    expect(body.documents.unknownUnit.codes).toEqual([{ code: "99", count: 1 }]);
    expect(body.documents.notDecoding.samples[0].number).toBe("PID-OLD-7");
    expect(body.assets).toMatchObject({ toSet: 1, keptWithoutFiling: 1, disagreeWithFiling: 0, written: 0 });
    expect(body.remaining).toBe(0);
    expect(row("documents", "d1").unit_code).toBeNull();
    expect(db.calls.some((c) => c.method === "update")).toBe(false);
    expect(db.tables.audit_logs).toHaveLength(0);
  });

  it("apply writes the decode and the projection, audits the pass, and a second run writes nothing (idempotent)", async () => {
    const body = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(body.documents).toMatchObject({ written: 2, refused: 0 });
    expect(body.assets).toMatchObject({ written: 1, refused: 0 });
    expect(row("documents", "d1").unit_code).toBe("20");
    expect(row("documents", "d2").unit_code).toBeNull();     // no longer decodes → cleared
    expect(row("documents", "d3").unit_code).toBeNull();     // unit 99 is not in the codebook → never written
    expect(row("documents", "d1").unit_id).toBeNull();       // documents.unit_id is never written
    expect(row("assets", "a1").unit_id).toBe("u20");
    expect(row("assets", "a2").unit_id).toBe("u30");         // held while unfiled: kept
    // audited before the writes (what it set out to do) and after (what landed)
    expect(db.tables.audit_logs).toHaveLength(2);
    expect(db.tables.audit_logs[0]).toMatchObject({ action: "UNIT_IDENTITY_BACKFILL", org_id: ORG, user_id: "uid-1", details: { phase: "started", remaining: 0 } });
    expect(db.tables.audit_logs[1]).toMatchObject({ action: "UNIT_IDENTITY_BACKFILL", details: { phase: "finished", documents: { written: 2, refused: 0 }, assets: { written: 1, refused: 0 } } });
    const firstAudit = db.calls.findIndex((c) => c.table === "audit_logs" && c.method === "insert");
    const firstUpdate = db.calls.findIndex((c) => c.method === "update");
    expect(firstAudit).toBeGreaterThan(-1);
    expect(firstAudit).toBeLessThan(firstUpdate);
    // counts only — never a number, a title or an id in the audit row
    expect(JSON.stringify(db.tables.audit_logs)).not.toMatch(/2002-D|PID-OLD|"d1"|"a1"/);
    const again = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(again.documents.toWrite).toBe(0);
    expect(again.assets.written).toBe(0);
  });

  it("a hand-set or imported assets.unit_id is never overwritten: a first run on a mapped unit keeps every value and counts the disagreements", async () => {
    seed({
      units: [o({ id: "u20", codebook_code: "20", archived: false }), o({ id: "u30", codebook_code: "30", archived: false })],
      assets: [
        o({ id: "a1", unit_code: null, unit_id: "u20" }),   // imported scope, not filed yet
        o({ id: "a2", unit_code: "30", unit_id: "u20" }),   // filed elsewhere
        o({ id: "a3", unit_code: "20", unit_id: null }),    // empty: filled
      ],
    });
    const body = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(body.assets).toMatchObject({ toSet: 1, disagreeWithFiling: 1, keptWithoutFiling: 1, written: 1 });
    expect(row("assets", "a1").unit_id).toBe("u20");
    expect(row("assets", "a2").unit_id).toBe("u20");
    expect(row("assets", "a3").unit_id).toBe("u20");
    // the decode never names a unit in its write: it re-sends the filing and
    // the database fills the EMPTY unit from the mapping at the write
    const assetUpdates = db.calls.filter((c) => c.table === "assets" && c.method === "update");
    expect(assetUpdates.length).toBeGreaterThan(0);
    expect(assetUpdates.every((c) => Object.keys(c.args[0] as Row).join(",") === "unit_code")).toBe(true);
  });

  it("a Supervisor (a scope writer outside the controller tier) never sees a private document's number; a DocCtrl does", async () => {
    seed({
      documents: [
        o({ id: "d1", document_number: "HR-INV-2026-004", unit_code: null, unit_id: null, visibility: "private" }),
        o({ id: "d2", document_number: "PID-OLD-7", unit_code: null, unit_id: null, visibility: "normal" }),
        o({ id: "d3", document_number: "9902-D-1", unit_code: null, unit_id: null, visibility: "hidden" }),
      ],
    });
    db.tables.org_members = db.tables.org_members.map((m) => (m.uid === "uid-1" ? { ...m, role: "Supervisor", roles: ["Supervisor"] } : m));
    const sup = await (await call({ orgId: ORG })).json();
    expect(sup.documents.notDecoding).toMatchObject({ count: 2, unlisted: 1 });
    expect(sup.documents.notDecoding.samples.map((x: { number: string }) => x.number)).toEqual(["PID-OLD-7"]);
    expect(sup.documents.unknownUnit).toEqual({ count: 1, codes: [], unlisted: 1 });
    expect(JSON.stringify(sup)).not.toMatch(/HR-INV|"99"/);

    db.tables.org_members = db.tables.org_members.map((m) => (m.uid === "uid-1" ? { ...m, role: "Viewer", roles: ["Viewer", "DocCtrl"] } : m));
    const dc = await (await call({ orgId: ORG })).json();
    expect(dc.documents.notDecoding).toMatchObject({ count: 2, unlisted: 0 });
    expect(dc.documents.notDecoding.samples.map((x: { number: string }) => x.number)).toContain("HR-INV-2026-004");
    expect(dc.documents.unknownUnit.codes).toEqual([{ code: "99", count: 1 }]);
    // the controller test reads the held collection, never a role literal
    const src = readFileSync("app/api/admin/unit-identity/route.ts", "utf8");
    expect(src).toContain("heldRoles(member).some((r) => isControllerRole(r as Role))");
    expect(src).toContain('"id, document_number, unit_code, unit_id, visibility"');
  });

  it("an apply is bounded per call and continues: the rest is `remaining`, and the next call writes only what is still missing", async () => {
    const n = UNIT_IDENTITY_WRITE_BUDGET + 150;
    const documents = Array.from({ length: n }, (_, i) => o({ id: `d${String(i).padStart(5, "0")}`, document_number: "2002-D-1", unit_code: null, unit_id: null }));
    seed({ documents });
    const first = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(first.documents).toMatchObject({ toWrite: n, written: UNIT_IDENTITY_WRITE_BUDGET, refused: 0 });
    expect(first.assets.written).toBe(0);              // the budget went to documents first
    expect(first.remaining).toBe(150 + 1);             // 150 documents + 1 asset
    expect(db.tables.documents.filter((d) => d.unit_code === "20")).toHaveLength(UNIT_IDENTITY_WRITE_BUDGET);
    const second = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(second.documents).toMatchObject({ toWrite: 150, written: 150 });
    expect(second.assets.written).toBe(1);
    expect(second.remaining).toBe(0);
    expect(db.tables.documents.every((d) => d.unit_code === "20")).toBe(true);
    // each call audited before and after its writes
    expect(db.tables.audit_logs.map((r) => (r.details as { phase: string }).phase)).toEqual(["started", "finished", "started", "finished"]);
  });

  it("if the opening audit row cannot be written, nothing is written", async () => {
    db.writeError = { audit_logs: { message: "audit_logs is read-only" } };
    const r = await call({ orgId: ORG, dryRun: false });
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/did not run: its audit record could not be written/);
    expect(db.calls.some((c) => c.method === "update")).toBe(false);
  });

  it("a refused write is counted and said; a row that no longer matches is counted `changed` — never a silent partial success", async () => {
    db.refuseWrites = new Set(["documents"]);
    const body = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(body.documents).toMatchObject({ written: 0, changed: 2, refused: 0 });
    expect(body.notes.join("\n")).toMatch(/2 document\(s\) changed since they were read .* left as they are/);
    seed();
    db.writeError = { documents: { code: "42501", message: "documents_unit_code_guard: refused" } };
    const b1 = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(b1.documents).toMatchObject({ written: 0, changed: 0, refused: 2 });
    expect(b1.notes.join("\n")).toMatch(/2 document write\(s\) were refused: documents_unit_code_guard: refused/);
    seed();
    db.writeError = { assets: { message: "assets_guard_registry: refused" } };
    const b2 = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(b2.assets.refused).toBe(1);
    expect(b2.notes.join("\n")).toMatch(/equipment write\(s\) were refused: assets_guard_registry: refused/);
  });
});

describe("the writes re-check what they were planned on (a concurrent writer between the read and the write)", () => {
  it("an equipment unit set by hand after the read is NEVER overwritten, and a renumbered document is never stamped with its old number's decode", async () => {
    seed({
      documents: [
        o({ id: "d1", document_number: "2002-D-10001", unit_code: null, unit_id: null }),
        o({ id: "d4", document_number: "2002-D-10002", unit_code: null, unit_id: null }),
        o({ id: "d5", document_number: '2002-D-7"A', unit_code: null, unit_id: null }),
      ],
      assets: [o({ id: "a1", unit_code: "20", unit_id: null }), o({ id: "a3", unit_code: "20", unit_id: null })],
    });
    let once = false;
    db.beforeWrite = (table) => {
      if (once) return;
      once = true;
      // between the decode's read and its first write: a Supervisor sets a1's
      // unit by hand, and d1 is renumbered (20261138's trigger drops a decode
      // on a person's renumber — here there was none yet)
      expect(table).toBe("documents");
      row("assets", "a1").unit_id = "u30";
      row("documents", "d1").document_number = "3002-D-10001";
    };
    const body = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(row("assets", "a1").unit_id).toBe("u30");                  // kept — DEC-44 §3
    expect(row("assets", "a3").unit_id).toBe("u20");                  // still empty: filled
    expect(row("documents", "d1").unit_code).toBeNull();              // 30 is not 20 — left as it is
    expect(row("documents", "d4").unit_code).toBe("20");
    expect(row("documents", "d5").unit_code).toBe("20");              // a quoted number is matched one by one
    expect(body.documents).toMatchObject({ written: 2, changed: 1, refused: 0 });
    expect(body.assets).toMatchObject({ written: 1, changed: 1, refused: 0 });
    const n = body.notes.join("\n");
    expect(n).toMatch(/1 document\(s\) changed since they were read/);
    expect(n).toMatch(/1 equipment item\(s\) changed since they were read .* a unit already set is never overwritten/);
    // every asset UPDATE requires an empty unit_id and the planned filing
    const assetIs = db.calls.filter((c) => c.table === "assets" && c.method === "is").map((c) => c.args);
    expect(assetIs.length).toBeGreaterThan(0);
    expect(assetIs.every(([col, v]) => col === "unit_id" && v === null)).toBe(true);
    // the closing audit says what changed, as counts
    expect(db.tables.audit_logs[1]).toMatchObject({ details: { phase: "finished", documents: { written: 2, changed: 1 }, assets: { written: 1, changed: 1 } } });
    // the next run plans afresh: d1 is now unit 30 — and a1 is a disagreement, kept
    const again = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(row("documents", "d1").unit_code).toBe("30");
    expect(again.assets).toMatchObject({ toSet: 0, disagreeWithFiling: 1 });
  });
});

describe("assets.unit_id stays current between runs — refile, remap, new equipment (20261138's projection triggers)", () => {
  beforeEach(() => seed({
    units: [o({ id: "u20", codebook_code: "20", archived: false }), o({ id: "u30", codebook_code: "30", archived: false })],
    assets: [
      o({ id: "a1", tag: "E-22", unit_code: "20", unit_id: null, archived: false }),
      o({ id: "a2", tag: "E-23", unit_code: "30", unit_id: "u20", archived: false }),  // set by hand, disagrees
    ],
  }));

  it("a refile after a decode moves the projected unit with the filing; a unit set by hand is kept", async () => {
    await call({ orgId: ORG, dryRun: false });
    expect(row("assets", "a1").unit_id).toBe("u20");
    // an engineer refiles E-22 to unit 30 on /admin/assets (lib/assets.ts updateAsset)
    await updateAsset("a1", { unit_code: "30" }, "uid-1");
    expect(row("assets", "a1")).toMatchObject({ unit_code: "30", unit_id: "u30" });
    expect((await searchAssets({ orgId: ORG, unitId: "u20" })).map((a) => a.id)).not.toContain("a1");
    expect((await searchAssets({ orgId: ORG, unitId: "u30" })).map((a) => a.id)).toContain("a1");
    // the hand-set disagreement is refiled too: it was never the projection, so it is kept
    await updateAsset("a2", { unit_code: null }, "uid-1");
    expect(row("assets", "a2").unit_id).toBe("u20");
    // the next decode finds nothing stale — no "kept" disagreement for E-22
    const again = await (await call({ orgId: ORG })).json();
    expect(again.assets).toMatchObject({ toSet: 0, disagreeWithFiling: 0 });
  });

  it("a remap after a decode moves the projected equipment to the code's new holder — never left on the old unit", async () => {
    await call({ orgId: ORG, dryRun: false });
    expect(row("assets", "a1").unit_id).toBe("u20");
    db.tables.units.push(o({ id: "u40", codebook_code: null, archived: false }));
    await setUnitCodebookCode("u20", null, "uid-1");          // released
    expect(row("assets", "a1").unit_id).toBeNull();
    await setUnitCodebookCode("u40", "20", "uid-1");          // taken by the replacement
    expect(row("assets", "a1").unit_id).toBe("u40");
    expect(row("assets", "a2").unit_id).toBe("u20");          // a hand-set unit is never touched by a remap of another code
    // archiving the holder releases the code and its projection with it
    Object.assign(row("units", "u40"), unitsFollowMapping({ ...row("units", "u40") }, { archived: true }), { archived: true });
    expect(row("units", "u40").codebook_code).toBeNull();
    expect(row("assets", "a1").unit_id).toBeNull();
    const again = await (await call({ orgId: ORG })).json();
    // E-22 is not stale anywhere; the one disagreement is E-23's hand-set unit, kept
    expect(again.assets).toMatchObject({ toSet: 0, disagreeWithFiling: 1 });
  });

  it("equipment created after a decode carries its unit at once — no re-run needed", async () => {
    await call({ orgId: ORG, dryRun: false });
    const created = await createAsset({ orgId: ORG, tag: "P-101", unitCode: "30", createdBy: "uid-1" });
    expect(created.unit_id).toBe("u30");
    expect((await searchAssets({ orgId: ORG, unitId: "u30" })).map((a) => a.tag)).toContain("P-101");
  });

  it("a remap between the decode's read and its write is never written as it was: the fill lands by the mapping AT the write", async () => {
    seed({
      units: [o({ id: "u20", codebook_code: "20", archived: false }), o({ id: "u30", codebook_code: null, archived: false })],
      assets: [o({ id: "a1", tag: "E-22", unit_code: "20", unit_id: null, archived: false })],
      documents: [],
    });
    let once = false;
    db.beforeWrite = (table) => {
      if (once || table !== "assets") return;
      once = true;
      // the plan said u20; before the write, 20 is released (a1 is still empty)
      Object.assign(row("units", "u20"), unitsFollowMapping({ ...row("units", "u20") }, { codebook_code: null }));
    };
    const body = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(once).toBe(true);
    expect(row("assets", "a1").unit_id).toBeNull();           // never the stale u20
    expect(body.assets).toMatchObject({ toSet: 1, written: 0, changed: 1, refused: 0 });
    expect(body.notes.join("\n")).toMatch(/1 equipment item\(s\) changed since they were read .*remapped/);
    // mapping the code to its new holder places it
    await setUnitCodebookCode("u30", "20", "uid-1");
    expect(row("assets", "a1").unit_id).toBe("u30");
  });
});

describe("the codebook is read whole — a unit past PostgREST's max-rows never clears a decode", () => {
  /** 1,100 entries: units 20 and 30 first, 1,097 equipment types, then unit 70 — past row 1,000 of loadCodebookAdmin's one request. */
  const bigBook = () => [
    o({ id: "e20", kind: "unit", code: "20", label: "Crude Unit", meta: {}, sort: 0, origin: "manual" }),
    o({ id: "e30", kind: "unit", code: "30", label: "Coker", meta: {}, sort: 1, origin: "manual" }),
    ...Array.from({ length: 1097 }, (_, i) => o({ id: `t${i}`, kind: "equipment_type", code: `T${String(i).padStart(4, "0")}`, label: `Type ${i}`, meta: {}, sort: 2, origin: "import" })),
    o({ id: "e70", kind: "unit", code: "70", label: "Sulfur", meta: {}, sort: 3, origin: "import" }),
  ];

  it("documents decoded to unit 70 keep their decode; nothing reads as 'unknown unit'", async () => {
    seed({
      codebook_entries: bigBook(),
      documents: [
        o({ id: "d7", document_number: "7002-D-1", unit_code: "70", unit_id: null }),
        o({ id: "d8", document_number: "7002-D-2", unit_code: null, unit_id: null }),
      ],
    });
    const preview = await (await call({ orgId: ORG })).json();
    expect(preview.documents).toMatchObject({ decoded: 2, toWrite: 1, toClear: 0 });
    expect(preview.documents.unknownUnit.count).toBe(0);
    expect(preview.mapping.codebookUnitsUnmapped).toContain("70");
    const body = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(body.documents).toMatchObject({ written: 1, toClear: 0 });
    expect(row("documents", "d7").unit_code).toBe("70");
    expect(row("documents", "d8").unit_code).toBe("70");
    // the unit entries were read in keyset pages, none above max-rows
    const cbLimits = db.calls.filter((c) => c.table === "codebook_entries" && c.method === "limit").map((c) => Number(c.args[0]));
    expect(cbLimits.length).toBeGreaterThan(0);
    expect(Math.max(...cbLimits)).toBeLessThanOrEqual(1000);
  });

  it("if the unit entries cannot be read, nothing is planned or written", async () => {
    db.readError = { codebook_entries: { message: "statement timeout" } };
    const r = await call({ orgId: ORG, dryRun: false });
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/Site Codebook's units could not be read: statement timeout — nothing was planned/);
    expect(db.calls.some((c) => c.method === "update")).toBe(false);
    expect(row("documents", "d2").unit_code).toBe("20");
  });

  it("the scope page's unit list is read whole too (listCodebookUnits): unit 70 past row 1,000 is offered, labelled and counted", async () => {
    seed({ codebook_entries: bigBook() });
    const units = await listCodebookUnits(ORG);
    expect(units!.map((u) => [u.code, u.label])).toEqual([["20", "Crude Unit"], ["30", "Coker"], ["70", "Sulfur"]]);
    expect(units!.every((u) => u.kind === "unit")).toBe(true);
    const limits = db.calls.filter((c) => c.table === "codebook_entries" && c.method === "limit").map((c) => Number(c.args[0]));
    expect(Math.max(...limits)).toBeLessThanOrEqual(1000);
    db.missingTables = new Set(["codebook_entries"]);
    expect(await listCodebookUnits(ORG)).toBeNull();
    db.missingTables = new Set();
    db.readError = { codebook_entries: { message: "statement timeout" } };
    await expect(listCodebookUnits(ORG)).rejects.toThrow(/statement timeout/);
    // the page takes its picker, labels and "X of Y mapped" from that list, and says when it is short
    const src = readFileSync("app/(protected)/admin/scope/page.tsx", "utf8");
    expect(src).toContain("listCodebookUnits(activeOrgId)");
    expect(src).toContain("setBook(u.units ? { ...b, units: u.units } : b)");
    expect(src).toMatch(/Site Codebook&apos;s units could not be read in full/);
  });
});

describe("runUnitIdentityBackfill — the panel works through the bounded calls", () => {
  const report = (over: Partial<UnitIdentityReport> & { dw?: number; aw?: number; dr?: number }): UnitIdentityReport => ({
    dryRun: false,
    documents: {
      scanned: 10, decoded: 10, toWrite: 10, toClear: 0, written: over.dw ?? 0, changed: 0, refused: over.dr ?? 0, noNumber: 0,
      notDecoding: { count: 0, samples: [], unlisted: 0 }, noUnitSegment: 0, unknownUnit: { count: 0, codes: [], unlisted: 0 },
      disagreeWithUnitId: 0, unitIdUnmapped: 0,
    },
    assets: { scanned: 1, toSet: 1, disagreeWithFiling: 0, keptWithoutFiling: 0, written: over.aw ?? 0, changed: 0, refused: 0 },
    mapping: { operationalUnits: 1, mapped: 1, codebookUnitsUnmapped: [] },
    remaining: over.remaining ?? 0,
    notes: over.notes ?? [],
  });
  const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  it("loops while writes remain and a round landed something; sums what was written, keeps the first round's plan", async () => {
    const replies = [respond(200, report({ dw: 6, remaining: 5 })), respond(200, report({ dw: 4, aw: 1, remaining: 0 }))];
    const fetchMock = vi.fn(async () => replies.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    try {
      const r = await runUnitIdentityBackfill(ORG, { dryRun: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(r.documents).toMatchObject({ toWrite: 10, written: 10 });
      expect(r.assets.written).toBe(1);
      expect(r.remaining).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it("stops when a round lands nothing (the rest is refused) — never loops on refusals", async () => {
    const fetchMock = vi.fn(async () => respond(200, report({ dr: 3, remaining: 2 })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const r = await runUnitIdentityBackfill(ORG, { dryRun: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(r.documents.refused).toBe(3);
    } finally { vi.unstubAllGlobals(); }
  });

  it("a call the platform stops (no JSON body) is 'interrupted', not 'did not run', and says what earlier rounds landed", async () => {
    const replies = [respond(200, report({ dw: 4000, remaining: 900 })), { ok: false, status: 504, json: async () => { throw new Error("not json"); } }];
    vi.stubGlobal("fetch", vi.fn(async () => replies.shift()!));
    try {
      await expect(runUnitIdentityBackfill(ORG, { dryRun: false })).rejects.toThrow(/interrupted \(504\) — writes that landed are kept.*4000 write\(s\) landed in the earlier round/);
    } finally { vi.unstubAllGlobals(); }
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 504, json: async () => { throw new Error("not json"); } })));
    try {
      await expect(runUnitIdentityBackfill(ORG, { dryRun: false })).rejects.toThrow(/interrupted \(504\)/);
      await expect(runUnitIdentityBackfill(ORG, { dryRun: false })).rejects.not.toThrow(/did not run/);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("the mapping on /admin/scope — data, and every write checked", () => {
  beforeEach(() => seed({
    plants: [o({ id: "p1", name: "Refinery", code: null, archived: false })],
    units: [
      o({ id: "u20", plant_id: "p1", name: "Crude", code: "U100", codebook_code: "20", archived: false }),
      o({ id: "u30", plant_id: "p1", name: "Coker", code: "U200", codebook_code: null, archived: false }),
    ],
    systems: [],
  }));

  it("getScopeTree carries each unit's codebook mapping", async () => {
    const tree = await getScopeTree(ORG);
    expect(tree[0].units.map((u) => [u.unit.id, u.codebookCode])).toEqual([["u30", null], ["u20", "20"]]);
  });

  it("listCodebookMappings names every code held — a unit under an ARCHIVED plant included (the default tree does not show it)", async () => {
    db.tables.plants.push(o({ id: "p2", name: "Old Refinery", code: null, archived: true }));
    db.tables.units.push(
      o({ id: "u70", plant_id: "p2", name: "Sulfur (old)", code: null, codebook_code: "70", archived: false }),
      o({ id: "u80", plant_id: "p1", name: "Retired", code: null, codebook_code: null, archived: true }),
    );
    const tree = await getScopeTree(ORG);
    expect(tree.flatMap((t) => t.units).some((u) => u.unit.id === "u70")).toBe(false);
    const holders = await listCodebookMappings(ORG);
    expect(holders.map((h) => [h.code, h.unitId, h.plantName, h.plantArchived]).sort()).toEqual([
      ["20", "u20", "Refinery", false],
      ["70", "u70", "Old Refinery", true],
    ]);
    db.missingColumns = { units: ["codebook_code"] };
    expect(await listCodebookMappings(ORG)).toEqual([]);
    db.missingColumns = {};
    db.readError = { units: { message: "boom" } };
    await expect(listCodebookMappings(ORG)).rejects.toThrow(/boom/);
  });

  it("the scope page offers no code a unit under an archived plant holds, and names the holder", () => {
    const src = readFileSync("app/(protected)/admin/scope/page.tsx", "utf8");
    expect(src).toContain("listCodebookMappings(activeOrgId)");
    expect(src).toContain("takenBy: Map<string, CodebookMappingHolder>");
    expect(src).toMatch(/mapped to \$\{holder\.unitName\}/);
    expect(src).not.toMatch(/so the units on screen are every unit that can hold one/);
  });

  it("setUnitCodebookCode writes the mapping and reads it back; a refusal and a taken code are errors", async () => {
    await setUnitCodebookCode("u30", "30", "uid-1");
    expect(row("units", "u30").codebook_code).toBe("30");
    await setUnitCodebookCode("u30", "", "uid-1");
    expect(row("units", "u30").codebook_code).toBeNull();
    db.refuseWrites = new Set(["units"]);
    await expect(setUnitCodebookCode("u30", "30", "uid-1")).rejects.toThrow(/Not saved — the mapping was refused/);
    db.refuseWrites = new Set();
    db.writeError = { units: { code: "23505", message: 'duplicate key value violates unique constraint "units_org_codebook_code_uniq"' } };
    await expect(setUnitCodebookCode("u30", "20", "uid-1")).rejects.toThrow(/Site Codebook unit 20 is already mapped to another operational unit/);
    db.writeError = { units: { code: "42501", message: "units_codebook_code_scope_writers: only the Operational scope writer roles map a unit to the Site Codebook" } };
    await expect(setUnitCodebookCode("u30", "30", "uid-1")).rejects.toThrow(/only the roles that edit the operational scope can map a unit/);
    db.writeError = {};
    db.missingColumns = { units: ["codebook_code"] };
    await expect(setUnitCodebookCode("u30", "20", "uid-1")).rejects.toThrow(/20261138\) is not applied/);
  });

  it("the value is read back: an archived unit (whose code the database releases) is not a green save", async () => {
    // stand-in for 20261138's units_codebook_code_guard: an archived row holds no code
    db.triggers = { units: (r, patch) => ({ ...patch, ...((patch.archived ?? r.archived) ? { codebook_code: null } : {}) }) };
    row("units", "u30").archived = true;
    await expect(setUnitCodebookCode("u30", "30", "uid-1")).rejects.toThrow(/an archived unit holds no Site Codebook unit/);
    expect(row("units", "u30").codebook_code).toBeNull();
    row("units", "u30").archived = false;
    await setUnitCodebookCode("u30", "30", "uid-1");
    expect(row("units", "u30").codebook_code).toBe("30");
  });
});

// ── The migration ─────────────────────────────────────────────────────────

const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const FILE = "20261138_intel_roundG_unit_identity.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const code = sql.replace(/--[^\n]*/g, "");

describe("20261138 — one paste, counts only, every object new", () => {
  it("is the package's reserved number and the repo's naming", () => {
    expect(FILE).toMatch(/^20261138_intel_roundG_[a-z_]+\.sql$/);
  });

  it("captures the inventory in a TEMP table BEFORE the transaction, aggregate counts only", () => {
    const temp = code.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g38_before AS");
    const begin = code.indexOf("BEGIN;");
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    const inventory = code.slice(temp, begin);
    const selects = inventory.match(/SELECT\s+'[^']*(?:''[^']*)*'[^;]*?FROM/g) ?? [];
    expect(selects.length).toBe(8);
    for (const s of selects) expect(s).toMatch(/COUNT\(\*\)/);
    // never a customer row: no number, title, tag or name leaves the database
    expect(inventory).not.toMatch(/SELECT\s+(?:d\.|u\.)?(?:document_number|title|tag|name)\b/);
  });

  it("writes in one transaction and ends with ONE result set of (check, ok, n)", () => {
    expect(code.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;/gm)).toHaveLength(1);
    const tail = code.slice(code.indexOf("COMMIT;") + "COMMIT;".length);
    // one statement: split on the semicolons OUTSIDE string literals
    expect(tail.replace(/'(?:[^']|'')*'/g, "''").split(";").filter((s) => s.trim()).length).toBe(1);
    expect(tail).toMatch(/AS "check",\s*\n\s*EXISTS[\s\S]*?AS ok,\s*\n\s*NULL::text AS n/);
    // probes carry ok with n NULL; inventory rows carry ok NULL with n the count as text
    expect(tail).toMatch(/SELECT 'inventory \(before\): ' \|\| what, NULL, n::text FROM _intel_g38_before/);
  });

  it("every object it creates is new — no earlier migration defines it, so nothing is re-created (no lineDiff owed)", () => {
    const others = readdirSync(MIG_DIR).filter((f) => /^\d{8}.*\.sql$/.test(f) && f !== FILE)
      .map((f) => readFileSync(join(MIG_DIR, f), "utf8").replace(/--[^\n]*/g, ""));
    for (const name of [
      "documents_total_for_org", "documents_unit_code_guard", "trg_documents_unit_code_guard",
      "units_org_codebook_code_uniq", "documents_org_unit_code_idx", "codebook_code",
      "units_codebook_code_guard", "trg_units_codebook_code_guard",
      "assets_unit_id_follows_filing", "trg_assets_unit_id_follows_filing",
      "units_codebook_code_follow", "trg_units_codebook_code_follow",
    ]) {
      expect(others.some((s) => s.includes(name)), name).toBe(false);
    }
    expect(others.some((s) => /ALTER TABLE documents ADD COLUMN IF NOT EXISTS unit_code/.test(s))).toBe(false);
  });

  it("the SECURITY DEFINER count pins search_path, is revoked from PUBLIC and anon, granted to authenticated, and trusts no NULL uid", () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION documents_total_for_org\(p_org_id uuid\)\s*RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS \$\$/);
    expect(code).toContain("REVOKE ALL ON FUNCTION documents_total_for_org(uuid) FROM PUBLIC, anon;");
    expect(code).toContain("GRANT EXECUTE ON FUNCTION documents_total_for_org(uuid) TO authenticated;");
    // a member test, not a NULL test: auth.uid() IS NULL matches no member and returns 0
    const body = code.slice(code.indexOf("FUNCTION documents_total_for_org"), code.indexOf("REVOKE ALL ON FUNCTION documents_total_for_org"));
    expect(body).toMatch(/uid = auth\.uid\(\) AND status = 'active'/);
    expect(body).not.toMatch(/auth\.uid\(\)\s+IS\s+NULL/i);
    expect(body).toMatch(/ELSE 0/);
  });

  it("the guard is not SECURITY DEFINER, pins search_path, and is the decode's rail", () => {
    const g = code.slice(code.indexOf("FUNCTION documents_unit_code_guard"), code.indexOf("DROP TRIGGER IF EXISTS trg_documents_unit_code_guard"));
    expect(g).not.toMatch(/SECURITY DEFINER/);
    expect(g).toMatch(/SET search_path = public/);
    expect(g).toMatch(/IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;/);
    expect(g).toMatch(/IF TG_OP = 'INSERT' THEN\s*NEW\.unit_code := NULL;/);
    expect(g).toMatch(/USING ERRCODE = '42501'/);
    expect(code).toMatch(/BEFORE INSERT OR UPDATE OF unit_code, document_number ON documents/);
  });

  it("units.codebook_code is the Operational scope writer tier's in the database — the same roles as ADMIN_SURFACES 'scope'.writes — and an archived unit holds none", () => {
    const g = code.slice(code.indexOf("FUNCTION units_codebook_code_guard"), code.indexOf("DROP TRIGGER IF EXISTS trg_units_codebook_code_guard"));
    expect(g).not.toMatch(/SECURITY DEFINER/);
    expect(g).toMatch(/SET search_path = public/);
    // the release on archive comes FIRST, so releasing a code is a mapping change too
    expect(g.indexOf("IF NEW.archived THEN")).toBeLessThan(g.indexOf("v_changed := NEW.codebook_code"));
    expect(g).toMatch(/IF NEW\.archived THEN\s*NEW\.codebook_code := NULL;/);
    expect(g).toMatch(/v_changed := NEW\.codebook_code IS DISTINCT FROM OLD\.codebook_code;/);
    // deleting a mapped row removes the mapping too
    expect(g).toMatch(/IF TG_OP = 'DELETE' THEN\s*v_changed := OLD\.codebook_code IS NOT NULL;\s*v_org := OLD\.org_id;/);
    expect(g).toMatch(/IF TG_OP = 'DELETE' THEN\s*RETURN OLD;\s*END IF;\s*RETURN NEW;/);
    expect(g).toMatch(/IF v_changed AND auth\.uid\(\) IS NOT NULL/);
    expect(g).toMatch(/USING ERRCODE = '42501'/);
    const roles = g.match(/caller_holds_any_role\(v_org, ARRAY\[([^\]]*)\]::text\[\]\)/);
    expect(roles).not.toBeNull();
    const sqlRoles = roles![1].split(",").map((r) => r.trim().replace(/^'|'$/g, "")).sort();
    expect(sqlRoles).toEqual([...(adminSurface("scope")?.writes ?? [])].sort());
    expect(code).toMatch(/CREATE TRIGGER trg_units_codebook_code_guard\s*BEFORE INSERT OR UPDATE OF codebook_code, archived OR DELETE ON units/);
    // probed in the final SELECT (tgtype bit 8 = DELETE)
    expect(code).toContain("tgname = 'trg_units_codebook_code_guard'");
    expect(code).toContain("AND (tgtype & 8) <> 0)");
    expect(code).toContain("prosrc LIKE '%caller_holds_any_role(v_org, ARRAY[''Admin'',''Manager'',''Supervisor'',''DocCtrl'']::text[])%'");
  });

  it("the header no longer claims nothing else is widened without naming the route's disclosure rule and the fill-only projection", () => {
    const header = sql.slice(0, sql.indexOf("CREATE TEMP TABLE"));
    expect(header).not.toMatch(/Nothing else is widened;/);
    expect(header).toMatch(/lists a document's\s*\n--\s*number in its report only to a caller who may read it/);
    expect(header).toMatch(/FILLS an empty assets\.unit_id\s*\n--\s*\(through 6\.\) but never rewrites one already set/);
    // the projection's one widening is said: 7. moves it for a caller the assets overlay would refuse
    expect(header).toMatch(/7\. moves it for a\s*\n--\s*mapping change 5\. admitted even when the assets UPDATE overlay would/);
  });

  it("assets.unit_id follows the filing (6.): BEFORE INSERT OR UPDATE OF unit_code, not SECURITY DEFINER, and a hand-set unit is kept", () => {
    const f = code.slice(code.indexOf("FUNCTION assets_unit_id_follows_filing"), code.indexOf("DROP TRIGGER IF EXISTS trg_assets_unit_id_follows_filing"));
    expect(f).not.toMatch(/SECURITY DEFINER/);
    expect(f).toMatch(/RETURNS trigger LANGUAGE plpgsql SET search_path = public AS \$\$/);
    // the order of the rules is the rule: a write that sets unit_id wins; an unmoved filing keeps its unit;
    // a refiled unit that was not the old filing's projection is kept; only then is the filing projected
    const order = [
      "IF TG_OP = 'UPDATE' THEN",
      "IF NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN RETURN NEW; END IF;",
      "IF OLD.unit_id IS NOT NULL THEN",
      "IF NEW.unit_code IS NOT DISTINCT FROM OLD.unit_code THEN RETURN NEW; END IF;",
      "IF OLD.unit_id IS DISTINCT FROM (SELECT u.id FROM units u",
      "WHERE u.org_id = OLD.org_id AND u.codebook_code = OLD.unit_code AND NOT u.archived) THEN",
      "ELSIF NEW.unit_id IS NOT NULL THEN",
      "NEW.unit_id := (SELECT u.id FROM units u",
      "WHERE u.org_id = NEW.org_id AND u.codebook_code = NEW.unit_code AND NOT u.archived);",
      "RETURN NEW;\nEND;",
    ];
    let at = -1;
    for (const step of order) {
      const i = f.indexOf(step, at + 1);
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
    // no auth branch: every writer (a person, the Bridge, an import, the decode) gets the same projection
    expect(f).not.toMatch(/auth\.uid\(\)/);
    expect(code).toMatch(/CREATE TRIGGER trg_assets_unit_id_follows_filing\s*BEFORE INSERT OR UPDATE OF unit_code ON assets\s*FOR EACH ROW EXECUTE FUNCTION assets_unit_id_follows_filing\(\);/);
    // probed in the final SELECT: BEFORE (2), INSERT (4), UPDATE (16)
    expect(code).toContain("tgname = 'trg_assets_unit_id_follows_filing'");
    expect(code).toContain("AND (tgtype & 2) <> 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0)");
    expect(code).toContain("prosrc LIKE '%IF NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN RETURN NEW; END IF;%'");
    expect(code).toContain("FROM pg_proc WHERE proname = 'assets_unit_id_follows_filing'");
  });

  it("the projection follows the mapping (7.): AFTER, SECURITY DEFINER with search_path pinned, the scope writer tier re-checked, release then fill-only take", () => {
    const f = code.slice(code.indexOf("FUNCTION units_codebook_code_follow"), code.indexOf("DROP TRIGGER IF EXISTS trg_units_codebook_code_follow"));
    expect(f).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$/);
    // nothing to do unless the code moved (an archive arrives here with 5.'s release already applied)
    expect(f).toMatch(/IF TG_OP = 'UPDATE' AND NEW\.codebook_code IS NOT DISTINCT FROM OLD\.codebook_code THEN\s*RETURN NULL;/);
    expect(f).toMatch(/IF TG_OP = 'INSERT' AND NEW\.codebook_code IS NULL THEN\s*RETURN NULL;/);
    // the definer's rights are never lent to a caller 5. refuses — the same roles, the same refusal
    const guard = f.indexOf("caller_holds_any_role(NEW.org_id");
    const firstWrite = f.indexOf("UPDATE assets");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstWrite);
    expect(f).toMatch(/IF auth\.uid\(\) IS NOT NULL\s*AND NOT caller_holds_any_role\(NEW\.org_id, ARRAY\[[^\]]*\]::text\[\]\) THEN\s*RAISE EXCEPTION 'units_codebook_code_scope_writers:/);
    const roles = f.match(/caller_holds_any_role\(NEW\.org_id, ARRAY\[([^\]]*)\]::text\[\]\)/)!;
    expect(roles[1].split(",").map((r) => r.trim().replace(/^'|'$/g, "")).sort()).toEqual([...(adminSurface("scope")?.writes ?? [])].sort());
    // release: only the equipment projected from THIS unit under the OLD code, to the old code's holder now
    expect(f).toMatch(/IF TG_OP = 'UPDATE' AND OLD\.codebook_code IS NOT NULL THEN\s*UPDATE assets SET unit_id = \(SELECT u\.id FROM units u\s*WHERE u\.org_id = OLD\.org_id AND u\.codebook_code = OLD\.codebook_code AND NOT u\.archived\)\s*WHERE org_id = OLD\.org_id AND unit_id = OLD\.id AND unit_code = OLD\.codebook_code;/);
    // take: fill only — a unit already there is kept
    expect(f).toMatch(/IF NEW\.codebook_code IS NOT NULL THEN\s*UPDATE assets SET unit_id = NEW\.id\s*WHERE org_id = NEW\.org_id AND unit_code = NEW\.codebook_code AND unit_id IS NULL;/);
    expect(f.indexOf("unit_id = OLD.id")).toBeLessThan(f.indexOf("unit_id = NEW.id"));
    // it writes nothing but assets.unit_id
    expect(f.match(/UPDATE \w+ SET (\w+)/g)).toEqual(["UPDATE assets SET unit_id", "UPDATE assets SET unit_id"]);
    expect(code).toMatch(/CREATE TRIGGER trg_units_codebook_code_follow\s*AFTER INSERT OR UPDATE OF codebook_code, archived ON units\s*FOR EACH ROW EXECUTE FUNCTION units_codebook_code_follow\(\);/);
    // probed: AFTER row trigger (bit 1 set, bit 2 clear), SECURITY DEFINER, search_path pinned
    expect(code).toContain("tgname = 'trg_units_codebook_code_follow'");
    expect(code).toContain("AND (tgtype & 1) <> 0 AND (tgtype & 2) = 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0)");
    expect(code).toContain("prosrc LIKE '%caller_holds_any_role(NEW.org_id, ARRAY[''Admin'',''Manager'',''Supervisor'',''DocCtrl'']::text[])%'");
    expect(code).toMatch(/AND prosecdef\s*\n\s*AND array_to_string\(proconfig, ','\) LIKE '%search_path=public%'\s*\n\s*FROM pg_proc WHERE proname = 'units_codebook_code_follow'/);
  });

  it("pg_proc probes double the apostrophes of the body's literals; no bare cast inside a LIKE pattern", () => {
    expect(code).toContain("prosrc LIKE '%IF TG_OP = ''INSERT'' THEN%NEW.unit_code := NULL;%'");
    expect(code).toContain("prosrc LIKE '%USING ERRCODE = ''42501''%'");
    expect(code).not.toMatch(/LIKE '[^']*::[a-z]+[^']*'/);
  });
});
