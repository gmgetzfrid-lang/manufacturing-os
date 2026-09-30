// intelligence Round G (I-10) — write authority on the registry and the
// codebook's invariants.
//
//   * AREA-9  — every registry read that feeds a count pages past PostgREST's
//               max-rows (driven against an in-memory stand-in that caps).
//   * AREA-1 / IRLS-5 / CB-4 / IRLS-10 — a write RLS refuses (zero rows, no
//               error) is a loud refusal on every registry and codebook
//               funnel; the writer tier archives, the controller tier deletes.
//   * CB-3 / CB-8 / CB-10 — the codebook refuses a NEW letter code and a
//               claimed prefix before writing (a legacy letter-coded row stays
//               editable); a site-code collision says so, and a DERIVED code
//               is optional — the row still lands, without it.
//   * CB-5 — a codebook entry still referenced cannot be removed: the
//               database's refusal arrives with the counts.
//   * Restores and the Bridge (service role) — the org restore's additive
//               upsert and the Bridge's discovery insert / unit backfill,
//               driven against 20261128's triggers (transcribed below and
//               pinned to the SQL by shape tests): a legacy letter code
//               restores, a taken site code is dropped, never the row.
//   * IRLS-5 — archive is reversible: restoreAsset and the page's Archived
//               list / the drawer's Restore.
//   * 20261128 — the paste contract, the predicates, the two-world DO blocks,
//               and a policy census: the registry's final DELETE overlays and
//               the Bridge ledger's write policy are the ones this file wrote,
//               and nothing in the browser writes the ledger (IRLS-8).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";
import type { SupabaseClient } from "@supabase/supabase-js";

const db = vi.hoisted(() => ({ ref: null as unknown as FakeDb }));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeSupabase, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  db.ref = fresh();
  const proxy = new Proxy({}, { get: (_t, p: string) => (makeFakeSupabase(db.ref) as Record<string, unknown>)[p] });
  return { supabase: proxy };
});

import {
  listAssets, listAssetIdentities, getPhotoCounts, updateAsset, deleteAsset, archiveAsset, deletePhoto,
  createAsset, findAssetsByTagKeys, SITE_CODE_UNIQUE_INDEX, isSiteCodeTaken, restoreAsset,
  type Asset,
} from "@/lib/assets";
import { upsertEntry, deleteEntry, saveUnitLinks, saveConfig, applyImport, unitFlowReferenceCount, EMPTY_CODEBOOK, type Codebook } from "@/lib/codebook";
import { applyForDocument } from "@/lib/equipmentBridgeServer";
import { planCategorization, applyCategorization } from "@/lib/assetCategorize";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const mig = (f: string) => repo(join("supabase", "migrations", f));

beforeEach(() => {
  Object.assign(db.ref, newFakeDb());
});

const assetRow = (i: number, extra: Row = {}): Row => ({
  id: `a${String(i).padStart(5, "0")}`, org_id: "o1", tag: `P-${i}`, tag_normalized: `p${i}`,
  archived: false, unit_code: i % 2 ? "20" : null, code: null, origin: "manual", ...extra,
});

describe("AREA-9 — the registry is read whole, past the PostgREST max-rows cap", () => {
  it("reproduction: one capped response is what the old single select returned", async () => {
    db.ref.maxRows = 1000;
    db.ref.tables.assets = Array.from({ length: 2500 }, (_, i) => assetRow(i));
    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase.from("assets").select("*").eq("org_id", "o1").order("tag", { ascending: true });
    expect((data as Row[]).length).toBe(1000);
  });
  it("listAssets returns all 2,500 rows (unit cards count the whole plant) and filters still apply", async () => {
    db.ref.maxRows = 1000;
    db.ref.tables.assets = Array.from({ length: 2500 }, (_, i) => assetRow(i, i === 7 ? { archived: true } : {}));
    const all = await listAssets({ orgId: "o1", archived: false });
    expect(all.length).toBe(2499);
    expect(new Set(all.map((a) => a.id)).size).toBe(2499);
    expect(all.filter((a) => a.unit_code === "20").length).toBe(1249); // odd ids file to 20; #7 is archived
    const ranges = db.ref.calls.filter((c) => c.table === "assets" && c.method === "range");
    expect(ranges.length).toBe(3); // 1000 + 1000 + 499 — stops on the exact count, no empty trailing read
  });
  it("paging survives a max-rows LOWER than the window (each window starts where the rows ended)", async () => {
    db.ref.maxRows = 400;
    db.ref.tables.assets = Array.from({ length: 1234 }, (_, i) => assetRow(i));
    expect((await listAssets({ orgId: "o1" })).length).toBe(1234);
    expect((await listAssetIdentities("o1")).length).toBe(1234);
  });
  it("getPhotoCounts chunks the ids and pages the photos (no over-long URL, no capped count)", async () => {
    db.ref.maxRows = 1000;
    const ids = Array.from({ length: 400 }, (_, i) => `a${i}`);
    db.ref.tables.asset_photos = ids.flatMap((id, i) => Array.from({ length: 3 }, (_, k) => ({ id: `ph${i}-${k}`, org_id: "o1", asset_id: id })));
    const counts = await getPhotoCounts("o1", ids);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(1200);
    const ins = db.ref.calls.filter((c) => c.table === "asset_photos" && c.method === "in");
    expect(Math.max(...ins.map((c) => (c.args[1] as unknown[]).length))).toBeLessThanOrEqual(150);
  });
});

describe("AREA-1 / IRLS-5 — registry writes are checked; delete is the controller tier, the writer tier archives", () => {
  beforeEach(() => { db.ref.tables.assets = [assetRow(1)]; db.ref.tables.asset_photos = [{ id: "ph1", org_id: "o1", asset_id: "a00001" }]; });
  it("an UPDATE RLS refuses (zero rows, no error) throws instead of reporting a save", async () => {
    db.ref.refuseWrites.add("assets");
    await expect(updateAsset("a00001", { description: "x" }, "u1")).rejects.toThrow(/was not saved — only Admin, Document Control, Manager or Supervisor/);
  });
  it("a DELETE RLS refuses (the writer tier since 20261128) says so and points at archive", async () => {
    db.ref.refuseWrites.add("assets");
    await expect(deleteAsset("a00001")).rejects.toThrow(/deleting registry equipment is limited to Admin and Document Control.*Archive it instead/);
    expect(db.ref.tables.assets).toHaveLength(1);
  });
  it("archive is the reversible removal: the row stays, archived — and restoreAsset brings it back as it was", async () => {
    await archiveAsset("a00001", "u1");
    expect(db.ref.tables.assets[0]).toMatchObject({ archived: true, updated_by: "u1" });
    expect(await listAssets({ orgId: "o1", archived: false })).toHaveLength(0);
    await restoreAsset("a00001", "u2");
    expect(db.ref.tables.assets[0]).toMatchObject({ archived: false, updated_by: "u2", tag: "P-1" });
    expect((await listAssets({ orgId: "o1", archived: false })).map((a) => a.id)).toEqual(["a00001"]);
    // A restore RLS refuses is reported, never a silent success.
    await archiveAsset("a00001", "u1");
    db.ref.refuseWrites.add("assets");
    await expect(restoreAsset("a00001", "u2")).rejects.toThrow(/was not saved/);
    expect(db.ref.tables.assets[0].archived).toBe(true);
  });
  it("a permitted delete removes the row; a refused photo delete is reported", async () => {
    await deleteAsset("a00001");
    expect(db.ref.tables.assets).toHaveLength(0);
    db.ref.refuseWrites.add("asset_photos");
    await expect(deletePhoto("ph1")).rejects.toThrow(/only Admin or Document Control can delete registry photos/);
  });
  it("CB-10: a site-code collision on assets_org_code_unique names the CODE, not the tag", async () => {
    db.ref.unique.assets = [{ cols: ["org_id", "code"], name: SITE_CODE_UNIQUE_INDEX, where: (r) => !!r.code }];
    db.ref.tables.assets = [assetRow(1, { code: "2010.1", tag: "V-1", tag_normalized: "v1" })];
    await expect(createAsset({ orgId: "o1", tag: "D-1", unitCode: "20", code: "2010.1", createdBy: "u1" }))
      .rejects.toThrow(/Site code 2010\.1 is already carried by another asset in this org/);
    db.ref.tables.assets.push(assetRow(2, { id: "a2", code: null }));
    await expect(updateAsset("a2", { code: "2010.1" }, "u1")).rejects.toThrow(/one site code is one asset/);
    await updateAsset("a2", { code: "2010.1" }, "u1").catch((e) => expect(isSiteCodeTaken(e)).toBe(true));
  });
  it("CB-10 / AREA-7: a DERIVED code is optional — the asset is still created / filed, without it, and the caller is told", async () => {
    db.ref.unique.assets = [{ cols: ["org_id", "code"], name: SITE_CODE_UNIQUE_INDEX, where: (r) => !!r.code }];
    db.ref.tables.assets = [assetRow(1, { code: "2010.1", tag: "V-1", tag_normalized: "v1" })];
    // Import / Bridge-style create: D-1 derives V-1's code (Vessels [V, D]).
    const made = await createAsset({ orgId: "o1", tag: "D-1", unitCode: "20", code: "2010.1", codeOptional: true, createdBy: "u1" });
    expect(made).toMatchObject({ tag: "D-1", unit_code: "20", code: null });
    expect(db.ref.tables.assets).toHaveLength(2);
    // Bulk filing: {unit_code, derived code} — the filing lands, the code is named as dropped.
    db.ref.tables.assets.push(assetRow(3, { id: "a3", tag: "D-2", tag_normalized: "d2", unit_code: null, code: "2010.2" }));
    db.ref.tables.assets.push(assetRow(4, { id: "a4", tag: "V-2", tag_normalized: "v2", unit_code: null, code: null }));
    await expect(updateAsset("a4", { unit_code: "20", code: "2010.2" }, "u1", { codeOptional: true })).resolves.toEqual({ codeDropped: "2010.2" });
    expect(db.ref.tables.assets.find((a) => a.id === "a4")).toMatchObject({ unit_code: "20", code: null });
    // A free code is written as asked.
    await expect(updateAsset("a4", { code: "2010.9" }, "u1", { codeOptional: true })).resolves.toEqual({ codeDropped: null });
    // A patch that is ONLY the code has nothing else to land — it still throws.
    await expect(updateAsset("a4", { code: "2010.1" }, "u1", { codeOptional: true })).rejects.toThrow(/Site code 2010\.1 is already carried/);
    // A tag collision is not a site-code collision: never retried without the code.
    db.ref.unique.assets.push(["org_id", "tag_normalized"]);
    await expect(createAsset({ orgId: "o1", tag: "D-1", unitCode: "20", code: "2010.77", codeOptional: true, createdBy: "u1" })).rejects.toThrow();
  });
  it("BR-6: findAssetsByTagKeys finds existing tags by the one grammar, in chunks, archived included", async () => {
    db.ref.tables.assets = Array.from({ length: 250 }, (_, i) => assetRow(i, i === 3 ? { archived: true } : {}));
    const found = await findAssetsByTagKeys("o1", ["p3", "p249", "nope", ...Array.from({ length: 240 }, (_, i) => `p${i}`)]);
    expect(found.get("p3")?.archived).toBe(true);
    expect(found.get("p249")?.id).toBe("a00249");
    expect(found.has("nope")).toBe(false);
    const ins = db.ref.calls.filter((c) => c.table === "assets" && c.method === "in");
    expect(Math.max(...ins.map((c) => (c.args[1] as unknown[]).length))).toBeLessThanOrEqual(100);
  });
});

describe("CB-4 / IRLS-10 — every codebook write is checked", () => {
  const unit = { kind: "unit" as const, code: "20", label: "Crude", meta: {}, sort: 0, origin: "manual" as const };
  beforeEach(() => {
    db.ref.tables.codebook_entries = [{ id: "e20", org_id: "o1", kind: "unit", code: "20", label: "Crude", meta: {} }];
    db.ref.tables.codebook_config = [];
  });
  it("reproduction shape: a refused UPDATE used to resolve cleanly (zero rows, no error)", async () => {
    db.ref.refuseWrites.add("codebook_entries");
    const { supabase } = await import("@/lib/supabase");
    const res = await supabase.from("codebook_entries").update({ label: "x" }).eq("id", "e20");
    expect(res.error).toBeNull();
  });
  it("upsertEntry (edit), deleteEntry, saveUnitLinks, saveConfig all throw on a refusal", async () => {
    db.ref.refuseWrites.add("codebook_entries");
    db.ref.refuseWrites.add("codebook_config");
    await expect(upsertEntry("o1", { ...unit, id: "e20", label: "Crude Unit" }, "u1")).rejects.toThrow(/Not saved — only Admin or Document Control/);
    await expect(deleteEntry("e20")).rejects.toThrow(/Not removed — only Admin or Document Control/);
    await expect(saveUnitLinks("o1", "20", [])).rejects.toThrow(/Not saved/);
    await expect(saveConfig("o1", { legendDocIds: [] }, "u1")).rejects.toThrow(/Not saved/);
    expect(db.ref.tables.codebook_entries[0].label).toBe("Crude");
  });
  it("a permitted edit lands", async () => {
    await upsertEntry("o1", { ...unit, id: "e20", label: "Crude Unit" }, "u1");
    expect(db.ref.tables.codebook_entries[0].label).toBe("Crude Unit");
  });
  it("CB-3: a letter code is refused BEFORE any write; the database's CHECK refusal is translated", async () => {
    await expect(upsertEntry("o1", { ...unit, code: "CU" }, "u1")).rejects.toThrow(/not numeric/);
    expect(db.ref.calls.some((c) => c.table === "codebook_entries" && (c.method === "upsert" || c.method === "update"))).toBe(false);
  });
  it("CB-3: a LEGACY letter-coded unit stays editable — relabel and links land; only a new or changed code is checked", async () => {
    db.ref.tables.codebook_entries.push({ id: "eCU", org_id: "o1", kind: "unit", code: "CU", label: "Crude (legacy)", meta: {} });
    await upsertEntry("o1", { ...unit, id: "eCU", code: "CU", label: "Crude — old numbering", meta: { links: [] } }, "u1");
    expect(db.ref.tables.codebook_entries.find((e) => e.id === "eCU")).toMatchObject({ code: "CU", label: "Crude — old numbering" });
    await saveUnitLinks("o1", "CU", [{ libraryId: "lib1", label: "P&IDs" }] as never);
    expect((db.ref.tables.codebook_entries.find((e) => e.id === "eCU")!.meta as { links: unknown[] }).links).toHaveLength(1);
    // Changing the code to another letter code is a NEW code: refused before any write.
    const before = db.ref.calls.length;
    await expect(upsertEntry("o1", { ...unit, id: "eCU", code: "CX", label: "x" }, "u1")).rejects.toThrow(/not numeric/);
    expect(db.ref.calls.slice(before).some((c) => c.method === "update" || c.method === "upsert")).toBe(false);
    // Re-adding it as a new row (no id) is also a new code.
    await expect(upsertEntry("o1", { ...unit, code: "CU", label: "again" }, "u1")).rejects.toThrow(/not numeric/);
  });
  it("CB-5: a removal the database refuses (entry still referenced) arrives with its counts, not as a raw constraint", async () => {
    db.ref.deleteErrors = { codebook_entries: { code: "23503", message: "codebook_entries_in_use: unit 20 is still referenced by 312 asset(s) and 2 process flow(s)" } };
    await expect(deleteEntry("e20")).rejects.toThrow(/^Refused — unit 20 is still referenced by 312 asset\(s\) and 2 process flow\(s\)\. A code still in use cannot be removed or changed/);
    expect(db.ref.tables.codebook_entries).toHaveLength(1);
  });
  it("CB-8: a prefix another equipment type claims is refused, with the claimant named", async () => {
    db.ref.tables.codebook_entries.push({ id: "t30", org_id: "o1", kind: "equipment_type", code: "30", label: "Exchangers", meta: { tagPrefixes: ["E"] } });
    await expect(upsertEntry("o1", { kind: "equipment_type", code: "45", label: "Ejectors", meta: { tagPrefixes: ["E"] }, sort: 0, origin: "manual" }, "u1"))
      .rejects.toThrow(/Prefix E- is already claimed by 30 Exchangers/);
    await expect(upsertEntry("o1", { kind: "equipment_type", code: "30", label: "Heat exchangers", meta: { tagPrefixes: ["E"] }, sort: 0, origin: "manual" }, "u1"))
      .resolves.toBeUndefined();
  });
  it("applyImport attempts every row and reports what did not land with the count that did", async () => {
    await expect(applyImport("o1", [
      { kind: "unit", code: "25", label: "DHT" },
      { kind: "unit", code: "CU", label: "Crude" },
    ], "u1")).rejects.toThrow(/Applied 1 of 2\. Not applied — CU Crude: .*not numeric/);
    expect(db.ref.tables.codebook_entries.map((e) => e.code)).toContain("25");
  });
  it("CB-5: unitFlowReferenceCount counts both ends of a unit endpoint", async () => {
    db.ref.tables.process_flows = [
      { id: "f1", org_id: "o1", from_kind: "unit", from_ref: "20", to_kind: "asset", to_ref: "a1" },
      { id: "f2", org_id: "o1", from_kind: "asset", from_ref: "a1", to_kind: "unit", to_ref: "20" },
      { id: "f3", org_id: "o1", from_kind: "unit", from_ref: "25", to_kind: "unit", to_ref: "30" },
    ];
    expect(await unitFlowReferenceCount("o1", "20")).toBe(2);
    expect(await unitFlowReferenceCount("o1", "99")).toBe(0);
  });
});

// ── 20261128 — the migration ────────────────────────────────────────────────
const m28 = mig("20261128_intel_roundG_registry_authority.sql");
const m45 = mig("20261045_rp_phase6_admin_gates_team_fk_reviewer_independence.sql");
const m0928 = mig("20260928_site_codebook.sql");
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");

describe("20261128 — paste contract", () => {
  it("inventory TEMP TABLE before BEGIN, one transaction, ONE final SELECT with (check, ok, n)", () => {
    const iTemp = m28.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g28_before");
    const iBegin = m28.indexOf("\nBEGIN;");
    const iCommit = m28.indexOf("\nCOMMIT;");
    expect(iTemp).toBeGreaterThan(0);
    expect(iBegin).toBeGreaterThan(iTemp);
    expect(iCommit).toBeGreaterThan(iBegin);
    expect(m28.split("\nBEGIN;").length).toBe(2);
    const tail = m28.slice(iCommit);
    expect((tail.match(/^SELECT /gm) ?? []).length).toBe(1 + (tail.match(/^UNION ALL\nSELECT /gm) ?? []).length);
    expect(tail).toMatch(/AS check,\n[\s\S]*?AS ok,\n\s+NULL::text AS n/);
    expect(tail).toContain("SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g28_before");
  });
  it("inventory is aggregate counts only — never a customer row", () => {
    const inv = m28.slice(m28.indexOf("CREATE TEMP TABLE"), m28.indexOf("\nBEGIN;"));
    expect(inv).not.toMatch(/SELECT \*/);
    for (const line of inv.split("\n").filter((l) => /^SELECT '/.test(l))) expect(line).toMatch(/COUNT\(\*\)/);
  });
  it("deparsed-qual probes carry no bare cast; prosrc probes quote apostrophes verbatim", () => {
    const tail = m28.slice(m28.indexOf("\nCOMMIT;"));
    for (const m of tail.matchAll(/(?:qual|with_check) (?:NOT )?LIKE '([^']*(?:''[^']*)*)'/g)) expect(m[1]).not.toMatch(/::/);
    expect(tail).toContain("prosrc LIKE '%''ASSET_DELETED''%'");
    expect(tail).toContain("prosrc LIKE '%roles && ARRAY[''Admin'', ''DocCtrl'']%'");
  });
});

describe("20261128 §1 — DELETE on the registry is the controller tier (photos follow the asset)", () => {
  const body = strip(m28.slice(m28.indexOf("\nBEGIN;"), m28.indexOf("\nCOMMIT;")));
  it("re-creates ONLY the DELETE overlay, from 20261045's own format, with is_org_controller", () => {
    expect(m45).toContain("EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE USING (%s)', t || '_write_roles_delete', t, page_roles);");
    expect(body).toContain("EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE USING (%s)', t || '_write_roles_delete', t, 'is_org_controller(org_id)');");
    expect(body).toContain("FOREACH t IN ARRAY ARRAY['assets','asset_types','asset_photos'] LOOP");
    expect(body).not.toMatch(/_write_roles_insert|_write_roles_update/);
    expect(body).not.toMatch(/asset_files/);
  });
  it("person-initiated asset deletion is audited in the same transaction; the service role's cascades are not", () => {
    const fn = m28.slice(m28.indexOf("CREATE OR REPLACE FUNCTION assets_audit_delete()"), m28.indexOf("DROP TRIGGER IF EXISTS trg_assets_audit_delete"));
    expect(fn).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(fn).toContain("IF auth.uid() IS NULL THEN RETURN OLD; END IF;");
    expect(fn).toContain("IF NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN RETURN OLD; END IF;");
    expect(fn).toContain("VALUES ('ASSET_DELETED', 'asset', OLD.id::text, OLD.org_id, auth.uid(), v_email, v_role,");
    expect(fn).toContain("SELECT email, array_to_string(COALESCE(roles, ARRAY[role]), ', ') INTO v_email, v_role FROM org_members");
    expect(m28).toMatch(/CREATE TRIGGER trg_assets_audit_delete\n\s+AFTER DELETE ON assets\n\s+FOR EACH ROW EXECUTE FUNCTION assets_audit_delete\(\);/);
  });
});

describe("20261128 §3 — CB-2 / IRLS-8: the Bridge ledger is service role + controllers", () => {
  it("same policy name and shape as 20260928; only the predicate changes (line diff)", () => {
    const live = m0928.slice(m0928.indexOf("CREATE POLICY doc_equip_sugg_write"), m0928.indexOf("-- Per-library bridge settings"));
    const next = m28.slice(m28.indexOf("CREATE POLICY doc_equip_sugg_write"), m28.indexOf("-- ── 4. CB-3"));
    const A = live.trim().split("\n"), B = next.trim().split("\n");
    expect(A[0]).toBe(B[0]);
    expect(A.filter((l) => !B.includes(l))).toEqual([
      "  USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'))",
      "  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'));",
    ]);
    expect(B.filter((l) => !A.includes(l))).toEqual([
      "  USING (is_org_controller(org_id))",
      "  WITH CHECK (is_org_controller(org_id));",
    ]);
  });
  it("IRLS-8 done-when 2: no browser-client code writes document_equipment_suggestions (every writer is service-role)", () => {
    const roots = ["app", "components", "lib", "hooks"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const p = join(dir, f.name);
        if (f.isDirectory()) { if (f.name !== "__tests__" && f.name !== "node_modules") walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(f.name)) continue;
        const src = repo(p);
        if (!src.includes("document_equipment_suggestions")) continue;
        const writes = /from\("document_equipment_suggestions"\)[^;]*?\.(insert|update|upsert|delete)\(/.test(src);
        const service = /supabaseAdmin|admin: SupabaseClient|admin\.from\("document_equipment_suggestions"\)/.test(src);
        if (writes && !service) offenders.push(p);
      }
    };
    for (const r of roots) walk(r);
    expect(offenders).toEqual([]);
  });
});

describe("20261128 §4/§5 — CB-3 CHECK and CB-10 unique index choose their own world", () => {
  const body = strip(m28.slice(m28.indexOf("\nBEGIN;"), m28.indexOf("\nCOMMIT;")));
  it("CB-3 binds a NEW code only: a trigger on INSERT and on a code / kind change — a meta-only UPDATE of a legacy letter-coded unit passes", () => {
    const fn = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION codebook_entries_code_digits_guard()"), body.indexOf("DROP TRIGGER IF EXISTS trg_codebook_entries_code_digits"));
    expect(fn).toContain("RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$");
    expect(fn).toContain("IF NEW.kind IN ('unit', 'equipment_type') AND NEW.code !~ '^[0-9]{1,6}$'");
    expect(fn).toContain("AND (TG_OP = 'INSERT' OR NEW.code IS DISTINCT FROM OLD.code OR NEW.kind IS DISTINCT FROM OLD.kind) THEN");
    expect(fn).toContain("USING ERRCODE = '23514',");
    expect(body).toMatch(/CREATE TRIGGER trg_codebook_entries_code_digits\n\s+BEFORE INSERT OR UPDATE OF code, kind ON codebook_entries\n\s+FOR EACH ROW EXECUTE FUNCTION codebook_entries_code_digits_guard\(\);/);
  });
  it("CB-3: the service role passes the digit rule first thing (the org restore re-inserts legacy rows ahead of ON CONFLICT) — the rule of §2 and §6", () => {
    const fn = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION codebook_entries_code_digits_guard()"), body.indexOf("DROP TRIGGER IF EXISTS trg_codebook_entries_code_digits"));
    expect(fn).toMatch(/AS \$\$\nBEGIN\n\s+IF auth\.uid\(\) IS NULL THEN RETURN NEW; END IF;\n\s+IF NEW\.kind IN \('unit', 'equipment_type'\)/);
    const tail = m28.slice(m28.indexOf("\nCOMMIT;"));
    expect(tail).toContain("AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'");
  });
  it("CB-3: there is NO CHECK (it binds the service role, so a pre-cleanup backup could never be restored) — one an earlier paste added is dropped", () => {
    expect(body).not.toMatch(/NOT VALID/);
    expect(body).not.toMatch(/ADD CONSTRAINT codebook_entries_code_digits|VALIDATE CONSTRAINT/);
    expect(body).toContain("ALTER TABLE codebook_entries DROP CONSTRAINT IF EXISTS codebook_entries_code_digits;");
    const tail = m28.slice(m28.indexOf("\nCOMMIT;"));
    expect(tail).toContain("NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codebook_entries_code_digits'),");
    expect(tail).not.toContain("convalidated");
  });
  it("CB-10: a code the service role writes yields to the asset already carrying it — INSERT lands without it, UPDATE keeps its own; NEW.id excluded", () => {
    const fn = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION assets_code_one_holder()"), body.indexOf("DROP TRIGGER IF EXISTS trg_assets_code_one_holder"));
    expect(fn).toContain("RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$");
    expect(fn).toMatch(/BEGIN\n\s+IF auth\.uid\(\) IS NOT NULL THEN RETURN NEW; END IF;\n\s+IF NEW\.code IS NULL OR btrim\(NEW\.code\) = '' THEN RETURN NEW; END IF;\n\s+IF TG_OP = 'UPDATE' AND NEW\.code IS NOT DISTINCT FROM OLD\.code THEN RETURN NEW; END IF;\n\s+IF EXISTS \(SELECT 1 FROM assets o\n\s+WHERE o\.org_id = NEW\.org_id AND o\.code = NEW\.code\n\s+AND o\.id IS DISTINCT FROM NEW\.id\) THEN/);
    expect(fn).toContain("IF TG_OP = 'INSERT' THEN NEW.code := NULL; ELSE NEW.code := OLD.code; END IF;");
    expect(body).toMatch(/CREATE TRIGGER trg_assets_code_one_holder\n\s+BEFORE INSERT OR UPDATE OF code ON assets\n\s+FOR EACH ROW EXECUTE FUNCTION assets_code_one_holder\(\);/);
    const tail = m28.slice(m28.indexOf("\nCOMMIT;"));
    expect(tail).toContain("prosrc LIKE '%IF TG_OP = ''INSERT'' THEN NEW.code := NULL; ELSE NEW.code := OLD.code; END IF;%'");
  });
  it("the unique partial index is created only when no org carries a duplicate — nothing is rewritten", () => {
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM assets\s+WHERE code IS NOT NULL AND btrim\(code\) <> ''\s+GROUP BY org_id, code HAVING COUNT\(\*\) > 1\) THEN\s+CREATE UNIQUE INDEX IF NOT EXISTS assets_org_code_unique\s+ON assets \(org_id, code\) WHERE code IS NOT NULL AND btrim\(code\) <> '';/);
    expect(body).not.toMatch(/UPDATE assets|DELETE FROM assets/);
    const { SITE_CODE_UNIQUE_INDEX: name } = { SITE_CODE_UNIQUE_INDEX };
    expect(m28).toContain(name);
  });
  it("the index is the backstop for PERSON writes; the service role's writes (Bridge, restore) yield at the trigger — no dependency on another package's retry", () => {
    expect(m28).not.toContain("HANDED TO I-11");
    expect(m28).toContain("A code the SERVICE ROLE writes");
    expect(m28).toContain("the Bridge's discovery insert and unit backfill, the org restore, a");
    // The trigger runs before the index is created, in the same transaction.
    expect(body.indexOf("CREATE TRIGGER trg_assets_code_one_holder")).toBeLessThan(body.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS assets_org_code_unique"));
  });
});

describe("20261128 §6 — CB-5: a code still in use cannot be removed or re-coded, by any caller", () => {
  const body = strip(m28.slice(m28.indexOf("\nBEGIN;"), m28.indexOf("\nCOMMIT;")));
  const fn = body.slice(body.indexOf("CREATE OR REPLACE FUNCTION codebook_entries_guard_in_use()"), body.indexOf("DROP TRIGGER IF EXISTS trg_codebook_entries_guard_in_use"));
  it("a SECURITY DEFINER trigger with search_path pinned, BEFORE DELETE and before a code / kind change", () => {
    expect(fn).toContain("RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$");
    expect(body).toMatch(/CREATE TRIGGER trg_codebook_entries_guard_in_use\n\s+BEFORE DELETE OR UPDATE OF code, kind ON codebook_entries\n\s+FOR EACH ROW EXECUTE FUNCTION codebook_entries_guard_in_use\(\);/);
    expect(fn).toMatch(/IF TG_OP = 'UPDATE' THEN\s+IF NEW\.code IS NOT DISTINCT FROM OLD\.code AND NEW\.kind IS NOT DISTINCT FROM OLD\.kind THEN RETURN NEW; END IF;/);
  });
  it("counts the STORED references: the unit filing, the <unit><type> head of a site code, and process flows ending at the unit", () => {
    expect(fn).toContain("AND (a.unit_code = OLD.code");
    expect(fn).toContain("AND split_part(a.code, '.', 1) = OLD.code || t.code));");
    expect(fn).toContain("AND split_part(a.code, '.', 1) = u.code || OLD.code);");
    expect(fn).toContain("IF to_regclass('public.process_flows') IS NOT NULL THEN");
    expect(fn).toContain("((from_kind = ''unit'' AND from_ref = $2) OR (to_kind = ''unit'' AND to_ref = $2))");
    expect(fn).toContain("RAISE EXCEPTION 'codebook_entries_in_use: % % is still referenced by % asset(s) and % process flow(s)'");
  });
  it("the service role's cascades (org purge, restore) and an org already gone pass — the same rule as the delete audit", () => {
    expect(fn).toContain("IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN");
  });
  it("the page counts first (friendlier, includes prefix-typed tags); lib/codebook.ts translates the database's refusal for every other caller", () => {
    const cb = repo("lib/codebook.ts");
    expect(cb).toContain("if (/codebook_entries_in_use/.test(err.message)) {");
    const del = cb.slice(cb.indexOf("export async function deleteEntry"), cb.indexOf("export async function saveUnitLinks"));
    expect(del).toContain("if (error) throw codebookWriteError(error);");
  });
});

// ── the registry policy census (AREA-1 done-when 3, by replay) ──────────────
describe("registry policy census — the FINAL definitions after replaying every numbered migration", () => {
  const files = readdirSync(join(process.cwd(), "supabase", "migrations")).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
  it("the last definer of each registry DELETE overlay and of doc_equip_sugg_write is 20261128; nothing later re-opens them", () => {
    const lastTouch = (re: RegExp) => files.filter((f) => re.test(strip(mig(f)))).pop();
    expect(lastTouch(/_write_roles_delete/)).toBe("20261128_intel_roundG_registry_authority.sql");
    expect(lastTouch(/doc_equip_sugg_write/)).toBe("20261128_intel_roundG_registry_authority.sql");
    expect(lastTouch(/\b(assets|asset_types|asset_photos)_member_all\b/)).toBe("20260605_rls_policies_new_tables.sql");
  });
  it("a Viewer / Requester / Manager cannot DELETE: every DELETE overlay reads is_org_controller (Admin/DocCtrl by collection)", () => {
    const loop = strip(m28).match(/FOREACH t IN ARRAY ARRAY\[([^\]]+)\] LOOP[\s\S]*?END LOOP;/)!;
    expect(loop[1].split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual(["assets", "asset_types", "asset_photos"]);
    expect(loop[0]).toContain("'is_org_controller(org_id)'");
    const ctl = mig("20260814_documents_delete_controllers.sql");
    expect(ctl).toContain("AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])");
  });
  it("a Viewer cannot INSERT or UPDATE registry columns (20261045 overlays + guard, untouched here)", () => {
    expect(m45).toContain("page_roles text := 'caller_holds_any_role(org_id, ARRAY[''Admin'',''DocCtrl'',''Manager'',''Supervisor'']::text[])';");
    expect(m45).toContain("flip_roles text := '(caller_is_active_member(org_id) AND NOT caller_holds_any_role(org_id, ARRAY[''Viewer'',''Auditor'']::text[]))';");
    expect(m45).toContain("AND NOT caller_holds_any_role(OLD.org_id, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[]) THEN");
  });
  it("CB-4 / IRLS-10 roles[] half is live from 20261046: the codebook and playbook writes read the collection", () => {
    const m46 = mig("20261046_rp_phase6_sweep_authority_by_collection.sql");
    expect(m46).toContain("('codebook_entries',           'codebook_entries_write',           ARRAY['Admin','DocCtrl']),");
    expect(m46).toContain("('codebook_config',            'codebook_config_write',            ARRAY['Admin','DocCtrl']),");
    expect(m46).toContain("('org_ai_instructions',        'org_ai_instructions_write',        ARRAY['Admin','DocCtrl']),");
    expect(m46).toContain("pred := format('caller_holds_any_role(org_id, %L::text[])', spec.roles);");
    const redefines = /CREATE POLICY\s+"?(codebook_entries_write|codebook_config_write|org_ai_instructions_write)\b|'(codebook_entries_write|codebook_config_write|org_ai_instructions_write)',\s+ARRAY/;
    const later = files.filter((f) => f > "20261046_rp_phase6_sweep_authority_by_collection.sql" && redefines.test(strip(mig(f))));
    expect(later).toEqual([]);
    expect(mig("20261020_pin_search_path.sql")).toContain("'is_org_controller(uuid)',");
  });
});

describe("AREA-7 / CB-10 — the bulk filer and the importer never lose a row to a derived code", () => {
  const page = repo("app/(protected)/admin/assets/page.tsx");
  const modal = repo("components/assets/AssetCsvImportModal.tsx");
  it("bulk assign: one try per row, the derived code optional, failures reported, the page refreshed in finally", () => {
    const assign = page.slice(page.indexOf("const assign = async (rows: Array<{ asset: Asset; unitCode: string }>) => {"), page.indexOf("const chosen = assets.filter"));
    expect(assign).toMatch(/for \(const r of rows\) \{[\s\S]*?try \{[\s\S]*?await updateAsset\(r\.asset\.id, \{[\s\S]*?\}, userId, \{ codeOptional: true \}\);[\s\S]*?\} catch \(e\) \{ failed\.push/);
    expect(assign).toMatch(/\} finally \{\s+setBusy\(false\);\s+onAssigned\(\);\s+\}/);
    expect(assign).toContain("const derived = r.asset.code ? null : tagToCode(r.asset.tag, r.unitCode, book);");
    expect(assign).toContain("filed WITHOUT a site code");
  });
  it("the identity review and the shared-code list read every asset (archived included); an archived holder opens from the registry", () => {
    expect(page).toContain("listAssetIdentities(activeOrgId),");
    expect(page).toContain("const identityReview = useMemo(() => planIdentityReview(assets, book, identities), [assets, book, identities]);");
    expect(page).toContain("const sharedCodes = useMemo(() => sharedSiteCodes(identities), [identities]);");
    expect(page).toContain("void getAsset(id).then((hit) => { if (hit) setSelectedAsset(hit); })");
    expect(page).toContain('r.kind === "derived_code_taken"');
  });
  it("import: preview knows the carried codes; commit writes with the code optional and lists the rows that landed without it", () => {
    expect(modal).toContain("listAssetIdentities(orgId),");
    expect(modal).toContain("planAssetImport(inputs, { book, types, existing, mode, codeHolders })");
    expect(modal).toContain("codeOptional: true,");
    expect(modal).toContain("await updateAsset(p.existingId, p.patch, actorUserId, { codeOptional: true });");
    expect(modal).toContain("landed without a site code");
  });
  it("import row numbers are the sheet's own (title block and blank rows counted) when the workbook route reports them", () => {
    expect(modal).toContain("row: rowNumbers?.[rIdx] ?? rIdx + 2,");
    expect(modal).toContain("applyTable(hdr, data, Array.isArray(json.rowNumbers) ? json.rowNumbers : null);");
  });
});

describe("the page and the codebook screen say what the database enforces", () => {
  const page = repo("app/(protected)/admin/assets/page.tsx");
  it("AREA-1: the printed restriction matches RLS — edit by the writer tier, delete by controllers", () => {
    expect(page).toContain("Only Admin / Doc Control / Manager / Supervisor can create, edit or archive equipment; deleting it is Admin / Doc Control only.");
    expect(page).toContain("const isController = roles.some((r) => isControllerRole(r as Role));");
    expect(page).toContain("canDelete={isController}");
    expect(page).toMatch(/!isCreate && canDelete \? \([\s\S]*?Delete asset[\s\S]*?\) : !isCreate && canEdit && !asset\?\.archived \? \([\s\S]*?Archive asset/);
  });
  it("IRLS-5: archive is reversible in the product — an Archived list with Restore, the drawer's Restore, and the confirms say where", () => {
    expect(page).toContain("const archivedIdentities = useMemo(() => identities.filter((a) => a.archived), [identities]);");
    expect(page).toContain("Archived ({archivedIdentities.length})");
    expect(page).toMatch(/<ArchivedAssetsPanel archived=\{archivedIdentities\} canRestore=\{isAdmin\}/);
    expect(page).toContain("await restoreAsset(a.id, userId);");
    expect(page).toMatch(/\{!isCreate && asset\?\.archived && canEdit && \([\s\S]*?onClick=\{onRestore\}[\s\S]*?Restore asset/);
    expect(page).toContain("await restoreAsset(asset.id, userId);");
    expect((page.match(/can be restored from the Archived list/g) ?? []).length).toBe(2); // the drawer's confirm and the bulk one
    expect(page).toContain("each can be restored from the Archived list.");
    expect(page).not.toMatch(/They leave the registry views and can be restored\./);
  });
  it("CB-10: the drawer's auto-derived code is optional (the asset saves without it, and says so); a typed code is not", () => {
    expect(page).toContain("const derivedHere = !asset?.code && unitCode ? tagToCode(tag, unitCode, book) : null;");
    expect(page).toContain("const codeIsDerived = !!derivedHere && siteCode.trim() === derivedHere;");
    expect(page).toContain("codeOptional: codeIsDerived,");
    expect(page).toContain("}, userId, { codeOptional: codeIsDerived });");
    expect(page).toContain("if (codeDropped) await appAlert({ title: \"Saved without a site code\", message: codeDroppedMessage(codeDropped) });");
  });
  it("BR-4: blank codes of filed equipment are filled from the page (the categorize banner hides when only codes are missing), against every identity, reporting what landed", () => {
    expect(page).toContain("const codeFill = useMemo(() => planCategorization(assets, types, book, identities).codeAssignments, [assets, types, book, identities]);");
    expect(page).toMatch(/<SiteCodeFillBanner orgId=\{activeOrgId\} userId=\{uid\} fill=\{codeFill\}/);
    expect(page).toContain("if (fill.length === 0 && !result) return null;");
    expect(page).toContain("result.codesDerived} site code");
    expect(page).toContain("result.codesTaken > 0");
  });
  it("DEC-35: no new literal role list — the controller tier comes from lib/permissions", () => {
    expect(page).not.toContain('hasAnyRole(["Admin", "DocCtrl"])');
    expect((page.match(/\["Admin", "DocCtrl", "Manager", "Supervisor"\]/g) ?? []).length).toBe(1); // the ADMIN_SURFACES-pinned constant, unchanged
  });
  it("CB-7: the numbering tab saves the org's mirrorsTag, never a literal", () => {
    const cb = repo("app/(protected)/admin/codebook/page.tsx");
    expect(cb).not.toMatch(/mirrorsTag: true/);
    expect(cb).toContain("const [mirrorsTag, setMirrorsTag] = useState(book.iterableRule.mirrorsTag);");
    expect(cb).toContain("const nextRule = { mirrorsTag, padTo: Math.max(0, Math.min(6, padTo)) };");
  });
});

// ── Restores and the Bridge against 20261128's triggers ─────────────────────
// Transcriptions of the two service-role paths, pinned to the SQL above.
const LETTER_OR_DIGITS = /^[0-9]{1,6}$/;
/** codebook_entries_code_digits_guard, BEFORE INSERT (TG_OP = 'INSERT'). */
const codeDigitsGuard = (withServiceRoleBypass: boolean, authUid: string | null) => (row: Row): Row => {
  if (withServiceRoleBypass && authUid === null) return row;                   // IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  if (["unit", "equipment_type"].includes(String(row.kind)) && !LETTER_OR_DIGITS.test(String(row.code))) {
    throw { code: "23514", message: `codebook_entries_code_digits: ${String(row.kind)} code "${String(row.code)}" is not 1-6 digits` };
  }
  return row;
};
/** assets_code_one_holder, BEFORE INSERT OR UPDATE OF code. */
const codeOneHolder = (authUid: string | null) => {
  const heldElsewhere = (row: Row, table: Row[]) =>
    table.some((o) => o.org_id === row.org_id && o.code === row.code && o.id !== row.id);
  return {
    insert: (row: Row, table: Row[]): Row => {
      if (authUid !== null) return row;                                         // IF auth.uid() IS NOT NULL THEN RETURN NEW; END IF;
      if (row.code == null || String(row.code).trim() === "") return row;
      return heldElsewhere(row, table) ? { ...row, code: null } : row;          // NEW.code := NULL
    },
    update: (next: Row, old: Row, table: Row[]): Row => {
      if (authUid !== null) return next;
      if (next.code == null || String(next.code).trim() === "") return next;
      if (next.code === old.code) return next;
      return heldElsewhere(next, table) ? { ...next, code: old.code } : next;   // NEW.code := OLD.code
    },
  };
};
const SITE_CODE_INDEX = { cols: ["org_id", "code"], name: SITE_CODE_UNIQUE_INDEX, where: (r: Row) => r.code != null && String(r.code).trim() !== "" };

/** app/api/admin/restore/apply/route.ts: upsert(chunk, { onConflict: "id", ignoreDuplicates: true }), then insert as the fallback. */
async function restoreChunk(table: string, rows: Row[]) {
  const { supabase: sb } = await import("@/lib/supabase");
  const up = await sb.from(table).upsert(rows.map((r) => ({ ...r })), { onConflict: "id", ignoreDuplicates: true });
  if (!up.error) return up;
  return sb.from(table).insert(rows.map((r) => ({ ...r })));
}

describe("CB-3 — an org restore holding a legacy letter-coded unit carries on (the service role passes the digit guard)", () => {
  const CU = { id: "eCU", org_id: "o1", kind: "unit", code: "CU", label: "Crude (legacy)", meta: {} };
  const D20 = { id: "e20", org_id: "o1", kind: "unit", code: "20", label: "Crude", meta: {} };
  it("reproduction: a guard with no service-role bypass fires ahead of ON CONFLICT (id) — the live CU row's own restore raises 23514 and the restore stops", async () => {
    db.ref.tables.codebook_entries = [{ ...CU }];
    db.ref.beforeInsert = { codebook_entries: codeDigitsGuard(false, null) };
    const res = await restoreChunk("codebook_entries", [CU, D20]);
    expect((res.error as { code?: string } | null)?.code).toBe("23514");
  });
  it("with the bypass: the live row is skipped, the rest lands; into a fresh org the legacy row restores whole", async () => {
    db.ref.tables.codebook_entries = [{ ...CU, label: "live label" }];
    db.ref.beforeInsert = { codebook_entries: codeDigitsGuard(true, null) };
    expect((await restoreChunk("codebook_entries", [CU, D20])).error).toBeNull();
    expect(db.ref.tables.codebook_entries.map((e) => e.code).sort()).toEqual(["20", "CU"]);
    expect(db.ref.tables.codebook_entries.find((e) => e.id === "eCU")!.label).toBe("live label"); // DO NOTHING
    db.ref.tables.codebook_entries = [];
    expect((await restoreChunk("codebook_entries", [CU, D20])).error).toBeNull();
    expect(db.ref.tables.codebook_entries).toHaveLength(2);
  });
  it("a PERSON's new letter code is still refused at the database (and by upsertEntry before any write)", async () => {
    db.ref.tables.codebook_entries = [];
    db.ref.beforeInsert = { codebook_entries: codeDigitsGuard(true, "u1") };
    const { supabase } = await import("@/lib/supabase");
    const res = await supabase.from("codebook_entries").insert({ ...CU });
    expect((res.error as { code?: string } | null)?.code).toBe("23514");
  });
});

describe("CB-10 — the service role's writes (Bridge, restore) never lose a row to a taken site code", () => {
  const book = (): Row[] => [
    { id: "u20", org_id: "o1", kind: "unit", code: "20", label: "Crude", meta: {}, sort: 0 },
    { id: "t10", org_id: "o1", kind: "equipment_type", code: "10", label: "Vessels", meta: { tagPrefixes: ["V", "D"] }, sort: 0 },
    { id: "t30", org_id: "o1", kind: "equipment_type", code: "30", label: "Exchangers", meta: { tagPrefixes: ["E"] }, sort: 1 },
  ];
  const V1 = { id: "a-v1", org_id: "o1", tag: "V-1", tag_normalized: "v1", unit_code: "20", code: "2010.1", archived: false };
  const E22 = { id: "a-e22", org_id: "o1", tag: "E-22", tag_normalized: "e22", unit_code: "20", code: "2030.22", archived: false };
  const E022 = { id: "a-e022", org_id: "o1", tag: "E-022", tag_normalized: "e022", unit_code: null, code: null, archived: false };
  const seedBridge = () => {
    db.ref.tables = {
      codebook_entries: book(),
      assets: [{ ...V1 }, { ...E22 }, { ...E022 }],
      asset_types: [],
      documents: [{ id: "d1", org_id: "o1", library_id: "lib1", metadata: {} }],
      libraries: [{ id: "lib1", equipment_bridge: { targetColumnKey: "equipment" } }],
      document_equipment_suggestions: [{
        id: "s1", org_id: "o1", document_id: "d1", applied: [],
        suggested: [
          // D-1 is new: its derived code is V-1's (Vessels [V, D] share a number space).
          { tag: "D-1", code: "2010.1", pages: [1], assetId: null, assetStatus: "new", unitCode: "20" },
          // E-022 is matched, unfiled; its derived code is E-22's.
          { tag: "E-022", code: "2030.22", pages: [1], assetId: "a-e022", assetStatus: "existing", unitCode: "20" },
        ],
      }],
      audit_logs: [],
    };
    db.ref.unique = { assets: [SITE_CODE_INDEX, ["org_id", "tag_normalized"]] };
  };
  const bridge = () => applyForDocument(makeFakeSupabase(db.ref) as unknown as SupabaseClient, { orgId: "o1", documentId: "d1", userId: null });

  it("reproduction (index, no trigger): the discovered D-1 is never created and E-022's filing is swallowed", async () => {
    seedBridge();
    const res = await bridge();
    expect(res.createdAssets).toBe(0);
    expect(db.ref.tables.assets.find((a) => a.tag === "D-1")).toBeUndefined();
    expect(db.ref.tables.assets.find((a) => a.id === "a-e022")).toMatchObject({ unit_code: null, code: null });
  });
  it("with 20261128's trigger (service role): D-1 lands filed, without the code; E-022 is filed, its code left blank; the index is never hit", async () => {
    seedBridge();
    const t = codeOneHolder(null);
    db.ref.beforeInsert = { assets: t.insert };
    db.ref.beforeUpdate = { assets: t.update };
    const res = await bridge();
    expect(res.createdAssets).toBe(1);
    expect(db.ref.tables.assets.find((a) => a.tag === "D-1")).toMatchObject({ unit_code: "20", code: null, origin: "drawing" });
    expect(db.ref.tables.assets.find((a) => a.id === "a-e022")).toMatchObject({ unit_code: "20", code: null });
    expect(db.ref.tables.assets.find((a) => a.id === "a-v1")!.code).toBe("2010.1");
  });
  it("the org restore: a live id is skipped as before; a deleted asset whose code was reused lands without it; a pre-index backup's duplicate pair both land", async () => {
    db.ref.tables = { assets: [{ ...V1 }] };
    db.ref.unique = { assets: [SITE_CODE_INDEX] };
    const backup: Row[] = [
      { ...V1, description: "from the backup" },                                                  // live id
      { id: "a-old", org_id: "o1", tag: "V-1-OLD", tag_normalized: "v1old", unit_code: "20", code: "2010.1", archived: false }, // code since reused
      { id: "a-p1", org_id: "o1", tag: "P-1", tag_normalized: "p1", unit_code: "20", code: "2040.1", archived: false },
      { id: "a-p1b", org_id: "o1", tag: "P-01", tag_normalized: "p01", unit_code: "20", code: "2040.1", archived: false },  // pre-index duplicate
    ];
    // Reproduction: without the trigger the restore raises on the index and stops at assets.
    const bare = await restoreChunk("assets", backup);
    expect((bare.error as { message?: string } | null)?.message).toContain(SITE_CODE_UNIQUE_INDEX);
    db.ref.tables = { assets: [{ ...V1 }] };
    db.ref.beforeInsert = { assets: codeOneHolder(null).insert };
    expect((await restoreChunk("assets", backup)).error).toBeNull();
    const by = (id: string) => db.ref.tables.assets.find((a) => a.id === id);
    expect(by("a-v1")).not.toHaveProperty("description");                 // DO NOTHING
    expect(by("a-old")).toMatchObject({ code: null, unit_code: "20" });
    expect(by("a-p1")!.code).toBe("2040.1");
    expect(by("a-p1b")).toMatchObject({ code: null, tag: "P-01" });
    expect((await restoreChunk("assets", backup)).error).toBeNull();      // idempotent
    expect(db.ref.tables.assets).toHaveLength(4);
  });
  it("a PERSON's write passes through to the index: a typed code is refused and named; a derived one (codeOptional) lands without it", async () => {
    db.ref.tables = { assets: [{ ...V1 }] };
    db.ref.unique = { assets: [SITE_CODE_INDEX] };
    const t = codeOneHolder("u1");
    db.ref.beforeInsert = { assets: t.insert };
    db.ref.beforeUpdate = { assets: t.update };
    await expect(createAsset({ orgId: "o1", tag: "D-1", unitCode: "20", code: "2010.1", createdBy: "u1" })).rejects.toThrow(/Site code 2010\.1 is already carried/);
    const made = await createAsset({ orgId: "o1", tag: "D-1", unitCode: "20", code: "2010.1", codeOptional: true, createdBy: "u1" });
    expect(made.code).toBeNull();
  });
});

describe("BR-4 / CB-10 — filling blank codes never proposes a taken code, and a code taken at apply is not a failure", () => {
  const book: Codebook = {
    ...EMPTY_CODEBOOK,
    units: [{ id: "u20", kind: "unit", code: "20", label: "Crude", meta: {}, sort: 0, origin: "manual" }],
    equipmentTypes: [{ id: "t30", kind: "equipment_type", code: "30", label: "Exchangers", meta: { tagPrefixes: ["E"] }, sort: 0, origin: "manual" }],
  };
  const archivedHolder = { id: "a-old", org_id: "o1", tag: "E-22-OLD", tag_normalized: "e22old", unit_code: "20", code: "2030.22", archived: true, type_id: null };
  const filed = { id: "a-e22", org_id: "o1", tag: "E-22", tag_normalized: "e22", unit_code: "20", code: null, archived: false, type_id: "t" };
  const filed2 = { id: "a-e23", org_id: "o1", tag: "E-23", tag_normalized: "e23", unit_code: "20", code: null, archived: false, type_id: "t" };
  beforeEach(() => {
    db.ref.tables = { assets: [{ ...archivedHolder }, { ...filed }, { ...filed2 }] };
    db.ref.unique = { assets: [SITE_CODE_INDEX] };
  });
  it("given every identity (archived included), the plan skips the code the archived asset holds", async () => {
    const active = (await listAssets({ orgId: "o1", archived: false })) as Asset[];
    const identities = await listAssetIdentities("o1");
    const plan = planCategorization(active, [], book, identities);
    expect(plan.codeAssignments).toEqual([{ assetId: "a-e23", tag: "E-23", code: "2030.23" }]);
  });
  it("a caller that passes only the active list: the taken code is reported as codesTaken, not as a failure; the free one is written", async () => {
    const active = (await listAssets({ orgId: "o1", archived: false })) as Asset[];
    const plan = planCategorization(active, [], book);
    expect(plan.codeAssignments.map((c) => c.code)).toEqual(["2030.22", "2030.23"]);
    const res = await applyCategorization("o1", "u1", plan, []);
    expect(res).toMatchObject({ codesDerived: 1, codesTaken: 1, failed: 0 });
    expect(db.ref.tables.assets.find((a) => a.id === "a-e23")!.code).toBe("2030.23");
    expect(db.ref.tables.assets.find((a) => a.id === "a-e22")!.code).toBeNull();
  });
});
