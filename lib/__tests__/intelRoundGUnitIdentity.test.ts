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

import {
  planUnitIdentity, setUnitCodebookCode, getScopeTree, runUnitIdentityBackfill,
  UNIT_IDENTITY_WRITE_BUDGET, type UnitIdentityReport,
} from "@/lib/operationalGraph";
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
  db.refuseWrites = new Set(); db.writeError = {}; db.rpc = {}; db.calls = []; db.seq = 0; db.triggers = {};
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
    const assetUpdates = db.calls.filter((c) => c.table === "assets" && c.method === "update");
    expect(assetUpdates.every((c) => (c.args[0] as { unit_id: unknown }).unit_id !== null)).toBe(true);
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

describe("runUnitIdentityBackfill — the panel works through the bounded calls", () => {
  const report = (over: Partial<UnitIdentityReport> & { dw?: number; aw?: number; dr?: number }): UnitIdentityReport => ({
    dryRun: false,
    documents: {
      scanned: 10, decoded: 10, toWrite: 10, toClear: 0, written: over.dw ?? 0, refused: over.dr ?? 0, noNumber: 0,
      notDecoding: { count: 0, samples: [], unlisted: 0 }, noUnitSegment: 0, unknownUnit: { count: 0, codes: [], unlisted: 0 },
      disagreeWithUnitId: 0, unitIdUnmapped: 0,
    },
    assets: { scanned: 1, toSet: 1, disagreeWithFiling: 0, keptWithoutFiling: 0, written: over.aw ?? 0, refused: 0 },
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
    expect(header).toMatch(/lists a document's number in its report only to\s*\n--\s*a caller who may read it/);
    expect(header).toMatch(/FILLS an empty assets\.unit_id but never rewrites one already set/);
  });

  it("pg_proc probes double the apostrophes of the body's literals; no bare cast inside a LIKE pattern", () => {
    expect(code).toContain("prosrc LIKE '%IF TG_OP = ''INSERT'' THEN%NEW.unit_code := NULL;%'");
    expect(code).toContain("prosrc LIKE '%USING ERRCODE = ''42501''%'");
    expect(code).not.toMatch(/LIKE '[^']*::[a-z]+[^']*'/);
  });
});
