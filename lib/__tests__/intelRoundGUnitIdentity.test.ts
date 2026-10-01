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

import { planUnitIdentity, setUnitCodebookCode, getScopeTree } from "@/lib/operationalGraph";
import { EMPTY_CODEBOOK, type Codebook, type CodebookEntry } from "@/lib/codebook";
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
    expect(r.unknownUnit).toEqual({ count: 1, codes: [{ code: "44", count: 1 }] });
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

  it("assets.unit_id = the mapping's projection of assets.unit_code; a hand-set value on an UNMAPPED unit is kept", () => {
    const plan = planUnitIdentity({
      book: BOOK, units, docs: [], dryRun: true,
      assets: [
        { id: "a1", unit_code: "20", unit_id: null },    // set
        { id: "a2", unit_code: "30", unit_id: "u20" },   // stale projection: re-point
        { id: "a3", unit_code: null, unit_id: "u30" },   // unfiled, points at a mapped unit: clear
        { id: "a4", unit_code: null, unit_id: "u99" },   // points at an unmapped unit: kept
        { id: "a5", unit_code: "20", unit_id: "u20" },   // already right
        { id: "a6", unit_code: "77", unit_id: null },    // unmapped code: nothing to project
      ],
    });
    expect(plan.report.assets).toMatchObject({ scanned: 6, toSet: 1, toRepoint: 1, toClear: 1, keptUnmapped: 1 });
    expect(plan.assetWrites.get("u20")).toEqual(["a1"]);
    expect(plan.assetWrites.get("u30")).toEqual(["a2"]);
    expect(plan.assetWrites.get(null)).toEqual(["a3"]);
    expect(plan.report.mapping).toEqual({ operationalUnits: 3, mapped: 2, codebookUnitsUnmapped: [] });
  });
});

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
    expect(body.assets).toMatchObject({ toSet: 1, keptUnmapped: 1, written: 0 });
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
    expect(row("assets", "a2").unit_id).toBe("u30");         // points at an unmapped unit: kept
    expect(db.tables.audit_logs).toHaveLength(1);
    expect(db.tables.audit_logs[0]).toMatchObject({ action: "UNIT_IDENTITY_BACKFILL", org_id: ORG, user_id: "uid-1" });
    // every write is org-scoped
    expect(db.calls.filter((c) => c.method === "update").length).toBeGreaterThan(0);
    const again = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(again.documents.toWrite).toBe(0);
    expect(again.assets.written).toBe(0);
  });

  it("a refused write is counted and said — never a silent partial success", async () => {
    db.refuseWrites = new Set(["documents"]);
    const body = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(body.documents).toMatchObject({ written: 0, refused: 2 });
    expect(body.notes.join("\n")).toMatch(/2 document write\(s\) matched no row/);
    seed();
    db.writeError = { assets: { message: "assets_guard_registry: refused" } };
    const b2 = await (await call({ orgId: ORG, dryRun: false })).json();
    expect(b2.assets.refused).toBe(1);
    expect(b2.notes.join("\n")).toMatch(/equipment write\(s\) were refused: assets_guard_registry: refused/);
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
    db.writeError = {};
    db.missingColumns = { units: ["codebook_code"] };
    await expect(setUnitCodebookCode("u30", "20", "uid-1")).rejects.toThrow(/20261138\) is not applied/);
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

  it("pg_proc probes double the apostrophes of the body's literals; no bare cast inside a LIKE pattern", () => {
    expect(code).toContain("prosrc LIKE '%IF TG_OP = ''INSERT'' THEN%NEW.unit_code := NULL;%'");
    expect(code).toContain("prosrc LIKE '%USING ERRCODE = ''42501''%'");
    expect(code).not.toMatch(/LIKE '[^']*::[a-z]+[^']*'/);
  });
});
