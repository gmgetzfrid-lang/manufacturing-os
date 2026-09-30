// intelligence Round G (I-10) — write authority on the registry and the
// codebook's invariants.
//
//   * AREA-9  — every registry read that feeds a count pages past PostgREST's
//               max-rows (driven against an in-memory stand-in that caps).
//   * AREA-1 / IRLS-5 / CB-4 / IRLS-10 — a write RLS refuses (zero rows, no
//               error) is a loud refusal on every registry and codebook
//               funnel; the writer tier archives, the controller tier deletes.
//   * CB-3 / CB-8 / CB-10 — the codebook refuses a letter code and a claimed
//               prefix before writing; a site-code collision says so.
//   * 20261128 — the paste contract, the predicates, the two-world DO blocks,
//               and a policy census: the registry's final DELETE overlays and
//               the Bridge ledger's write policy are the ones this file wrote,
//               and nothing in the browser writes the ledger (IRLS-8).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, type FakeDb, type Row } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ ref: null as unknown as FakeDb }));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeSupabase, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  db.ref = fresh();
  const proxy = new Proxy({}, { get: (_t, p: string) => (makeFakeSupabase(db.ref) as Record<string, unknown>)[p] });
  return { supabase: proxy };
});

import {
  listAssets, listAssetIdentities, getPhotoCounts, updateAsset, deleteAsset, archiveAsset, deletePhoto,
  createAsset, findAssetsByTagKeys, SITE_CODE_UNIQUE_INDEX,
} from "@/lib/assets";
import { upsertEntry, deleteEntry, saveUnitLinks, saveConfig, applyImport, unitFlowReferenceCount } from "@/lib/codebook";

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
  it("archive is the reversible removal: the row stays, archived", async () => {
    await archiveAsset("a00001", "u1");
    expect(db.ref.tables.assets[0]).toMatchObject({ archived: true, updated_by: "u1" });
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
  it("the CHECK binds new rows NOT VALID and validates only when no legacy row violates it", () => {
    expect(body).toContain("CHECK (kind NOT IN ('unit', 'equipment_type') OR code ~ '^[0-9]{1,6}$') NOT VALID;");
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM codebook_entries\s+WHERE kind IN \('unit', 'equipment_type'\) AND code !~ '\^\[0-9\]\{1,6\}\$'\) THEN\s+ALTER TABLE codebook_entries VALIDATE CONSTRAINT codebook_entries_code_digits;/);
  });
  it("the unique partial index is created only when no org carries a duplicate — nothing is rewritten", () => {
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM assets\s+WHERE code IS NOT NULL AND btrim\(code\) <> ''\s+GROUP BY org_id, code HAVING COUNT\(\*\) > 1\) THEN\s+CREATE UNIQUE INDEX IF NOT EXISTS assets_org_code_unique\s+ON assets \(org_id, code\) WHERE code IS NOT NULL AND btrim\(code\) <> '';/);
    expect(body).not.toMatch(/UPDATE assets|DELETE FROM assets/);
    const { SITE_CODE_UNIQUE_INDEX: name } = { SITE_CODE_UNIQUE_INDEX };
    expect(m28).toContain(name);
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

describe("the page and the codebook screen say what the database enforces", () => {
  const page = repo("app/(protected)/admin/assets/page.tsx");
  it("AREA-1: the printed restriction matches RLS — edit by the writer tier, delete by controllers", () => {
    expect(page).toContain("Only Admin / Doc Control / Manager / Supervisor can create, edit or archive equipment; deleting it is Admin / Doc Control only.");
    expect(page).toContain("const isController = roles.some((r) => isControllerRole(r as Role));");
    expect(page).toContain("canDelete={isController}");
    expect(page).toMatch(/!isCreate && canDelete \? \([\s\S]*?Delete asset[\s\S]*?\) : !isCreate && canEdit \? \([\s\S]*?Archive asset/);
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
