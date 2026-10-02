// intelligence Round G (I-10, Phase 0) — GAP-310 / CB-9: one tag grammar.
//
// A taught alias used to be WRITTEN with the codebook's display spelling
// ("THENORTHFURNACE") and READ with the registry key ("thenorthfurnace"), so
// the two surfaces people reach it from — the old-tag URL path
// (getAssetByTag) and search — never matched. These tests drive the real
// data-layer functions against an in-memory PostgREST stand-in, and pin the
// 20261127 migration that rewrites the column in the same commit.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, type FakeDb } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ ref: null as unknown as FakeDb }));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeSupabase, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  db.ref = fresh();
  const proxy = new Proxy({}, {
    get: (_t, p: string) => (makeFakeSupabase(db.ref) as Record<string, unknown>)[p],
  });
  return { supabase: proxy };
});

import { addAssetAlias, resolveAliasToAssetIds, removeAssetAlias } from "@/lib/assetAliases";
import { getAssetByTag } from "@/lib/assets";
import { searchDocuments } from "@/lib/search";

const H3 = { id: "a-h3", org_id: "o1", tag: "H-3", tag_normalized: "h3", archived: false };

beforeEach(() => {
  const next = newFakeDb();
  Object.assign(db.ref, next);
  db.ref.tables = {
    assets: [{ ...H3 }],
    asset_aliases: [],
    document_assets: [{ id: "da1", org_id: "o1", document_id: "d-furnace", asset_id: "a-h3" }],
    documents: [{ id: "d-furnace", org_id: "o1", library_id: "lib1", document_number: "2035-D-0301", title: "Heater H-3 P&ID", updated_at: "2026-09-01" }],
  };
  db.ref.unique = { asset_aliases: [["asset_id", "alias_normalized"]] };
});

describe("CB-9 — a phrase alias round-trips through every reader", () => {
  it("addAssetAlias writes the one-grammar key", async () => {
    await addAssetAlias({ orgId: "o1", assetId: "a-h3", alias: "the north furnace" });
    expect(db.ref.tables.asset_aliases).toHaveLength(1);
    expect(db.ref.tables.asset_aliases[0].alias).toBe("the north furnace");
    expect(db.ref.tables.asset_aliases[0].alias_normalized).toBe("thenorthfurnace");
  });

  it("addAssetAlias → getAssetByTag (the old-tag URL path) lands on the asset, whatever the spelling", async () => {
    await addAssetAlias({ orgId: "o1", assetId: "a-h3", alias: "the north furnace" });
    for (const typed of ["the north furnace", "The North-Furnace", "THE NORTH FURNACE", "thenorthfurnace"]) {
      const hit = await getAssetByTag("o1", typed);
      expect(hit?.id, typed).toBe("a-h3");
    }
    expect(await getAssetByTag("o1", "the south furnace")).toBeNull();
  });

  it("addAssetAlias → search finds the documents linked to the aliased asset", async () => {
    await addAssetAlias({ orgId: "o1", assetId: "a-h3", alias: "the north furnace" });
    const rows = await searchDocuments({ orgId: "o1", query: "the north furnace" });
    expect(rows.map((r) => r.id)).toContain("d-furnace");
  });

  it("a pre-renumber tag alias resolves in every tag format", async () => {
    await addAssetAlias({ orgId: "o1", assetId: "a-h3", alias: "F-101" });
    expect(db.ref.tables.asset_aliases[0].alias_normalized).toBe("f101");
    for (const typed of ["F-101", "f101", "F 101", "f–101"]) {
      expect((await getAssetByTag("o1", typed))?.id, typed).toBe("a-h3");
      expect(await resolveAliasToAssetIds("o1", typed), typed).toEqual(["a-h3"]);
    }
  });

  it("two spellings of one alias are one identity (23505 is 'already taught', not an error)", async () => {
    await addAssetAlias({ orgId: "o1", assetId: "a-h3", alias: "North Furnace" });
    await expect(addAssetAlias({ orgId: "o1", assetId: "a-h3", alias: "north-furnace" })).resolves.toBeUndefined();
    expect(db.ref.tables.asset_aliases).toHaveLength(1);
  });

  it("an alias with no letter or digit is refused — it could never be found", async () => {
    await expect(addAssetAlias({ orgId: "o1", assetId: "a-h3", alias: "—" })).rejects.toThrow(/letter or digit/);
    expect(db.ref.tables.asset_aliases).toHaveLength(0);
  });

  it("IRLS-10: a removal RLS refuses is reported, never a silent success", async () => {
    await addAssetAlias({ orgId: "o1", assetId: "a-h3", alias: "the north furnace" });
    const id = String(db.ref.tables.asset_aliases[0].id);
    db.ref.refuseWrites.add("asset_aliases");
    await expect(removeAssetAlias(id)).rejects.toThrow(/was not removed/);
    expect(db.ref.tables.asset_aliases).toHaveLength(1);
    db.ref.refuseWrites.clear();
    await expect(removeAssetAlias(id)).resolves.toBeUndefined();
    expect(db.ref.tables.asset_aliases).toHaveLength(0);
  });
});

// ── the restore round trip (the org restore's per-table upsert, ON CONFLICT
//    (id) DO NOTHING) against 20261127's trigger, transcribed below and pinned
//    to the SQL by the shape test further down ────────────────────────────────
const normalizeTagSql = (t: string) => (t ?? "").replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
// "rekey"      — a trigger that only re-derives the key (the first version);
// "keyed-only" — the drop, but not for the empty key (the review-fix version);
// "drop"       — 20261127 as it stands: any key another row of the asset holds.
const oneGrammarTrigger = (mode: boolean | "rekey" | "keyed-only" | "drop") => (row: Record<string, unknown>, table: Array<Record<string, unknown>>) => {
  const m = mode === true ? "drop" : mode === false ? "rekey" : mode;
  const next: Record<string, unknown> = { ...row, alias_normalized: normalizeTagSql(String(row.alias)) }; // NEW.alias_normalized := normalize_tag(NEW.alias);
  if (m === "rekey") return next;
  if (m === "keyed-only" && next.alias_normalized === "") return next;
  if (table.some((o) =>
    o.asset_id === next.asset_id && o.alias_normalized === next.alias_normalized && o.id !== next.id)) return null; // RETURN NULL;
  return next;
};

describe("20261127 — an org restore carries on past two spellings of one alias", () => {
  // What an export holds after 20261127: the keyed row and the inert second
  // spelling (old key kept for the record) — a pre-20261127 backup holds both
  // rows in the old display grammar, which the trigger re-keys the same way.
  const exported = [
    { id: "al-1", org_id: "o1", asset_id: "a-h3", alias: "North Furnace", alias_normalized: "northfurnace" },
    { id: "al-2", org_id: "o1", asset_id: "a-h3", alias: "north-furnace", alias_normalized: "NORTH-FURNACE" },
  ];
  const restore = async () => {
    const { supabase } = await import("@/lib/supabase");
    // The restore write as the single-shot app/api/admin/restore/apply/route.ts sent it (deleted, intelligence ILIFE-4):
    // upsert(chunk, { onConflict, ignoreDuplicates }), then insert as the fallback.
    const up = await supabase.from("asset_aliases").upsert(exported.map((r) => ({ ...r })), { onConflict: "id", ignoreDuplicates: true });
    if (!up.error) return up;
    return supabase.from("asset_aliases").insert(exported.map((r) => ({ ...r })));
  };
  it("reproduction: a trigger that only re-derives the key turns the second spelling into a 23505, and the restore stops there", async () => {
    db.ref.beforeInsert = { asset_aliases: oneGrammarTrigger(false) };
    const res = await restore();
    expect((res.error as { code?: string } | null)?.code).toBe("23505");
  });
  it("with the drop: one row per (asset, key) lands with no error and resolves; a re-run is a no-op", async () => {
    db.ref.beforeInsert = { asset_aliases: oneGrammarTrigger(true) };
    expect((await restore()).error).toBeNull();
    expect(db.ref.tables.asset_aliases).toHaveLength(1);
    expect(db.ref.tables.asset_aliases[0]).toMatchObject({ asset_id: "a-h3", alias_normalized: "northfurnace" });
    expect((await getAssetByTag("o1", "North-Furnace"))?.id).toBe("a-h3");
    expect((await restore()).error).toBeNull();
    expect(db.ref.tables.asset_aliases).toHaveLength(1);
  });
  it("two aliases with no letter or digit on one asset (? and #, distinct under the old grammar) both re-key to '' — the second is dropped, the restore carries on", async () => {
    const keyless = [
      { id: "al-3", org_id: "o1", asset_id: "a-h3", alias: "?", alias_normalized: "?" },
      { id: "al-4", org_id: "o1", asset_id: "a-h3", alias: "#", alias_normalized: "#" },
    ];
    const { supabase } = await import("@/lib/supabase");
    const up = () => supabase.from("asset_aliases").upsert(keyless.map((r) => ({ ...r })), { onConflict: "id", ignoreDuplicates: true });
    // Reproduction: the drop that exempts the empty key raises 23505 on the second — the restore stops at asset_aliases.
    db.ref.beforeInsert = { asset_aliases: oneGrammarTrigger("keyed-only") };
    expect(((await up()).error as { code?: string } | null)?.code).toBe("23505");
    db.ref.tables.asset_aliases = [];
    db.ref.beforeInsert = { asset_aliases: oneGrammarTrigger("drop") };
    expect((await up()).error).toBeNull();
    expect(db.ref.tables.asset_aliases).toHaveLength(1);
    expect(db.ref.tables.asset_aliases[0]).toMatchObject({ id: "al-3", alias_normalized: "" });
    expect((await up()).error).toBeNull(); // a re-run is a no-op
    expect(db.ref.tables.asset_aliases).toHaveLength(1);
    // …and a keyed alias beside them still lands and resolves.
    expect((await restore()).error).toBeNull();
    expect((await getAssetByTag("o1", "north furnace"))?.id).toBe("a-h3");
  });
  it("the app teaching a third spelling reads as 'already taught' (no error, nothing added)", async () => {
    db.ref.beforeInsert = { asset_aliases: oneGrammarTrigger(true) };
    await restore();
    await expect(addAssetAlias({ orgId: "o1", assetId: "a-h3", alias: "NORTH  FURNACE" })).resolves.toBeUndefined();
    expect(db.ref.tables.asset_aliases).toHaveLength(1);
  });
});

// ── 20261127 — the column rewrite ships with the reader flip ────────────────
const m27 = readFileSync(join(process.cwd(), "supabase", "migrations", "20261127_intel_roundG_one_tag_grammar.sql"), "utf8");

describe("20261127 — asset_aliases.alias_normalized in the one grammar", () => {
  it("paste contract: inventory TEMP TABLE before BEGIN, one COMMIT, ONE final SELECT with (check, ok, n)", () => {
    const iTemp = m27.indexOf("CREATE TEMP TABLE IF NOT EXISTS _intel_g27_before");
    const iBegin = m27.indexOf("\nBEGIN;");
    const iCommit = m27.indexOf("\nCOMMIT;");
    expect(iTemp).toBeGreaterThan(0);
    expect(iBegin).toBeGreaterThan(iTemp);
    expect(iCommit).toBeGreaterThan(iBegin);
    expect(m27.split("\nBEGIN;").length).toBe(2);
    const tail = m27.slice(iCommit);
    expect((tail.match(/^SELECT /gm) ?? []).length).toBe(1 + (tail.match(/^UNION ALL\nSELECT /gm) ?? []).length);
    expect(tail).toMatch(/AS check,\n[\s\S]*?AS ok,\n\s+NULL::text AS n/);
    expect(tail).toContain("SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g27_before");
  });
  it("the rewrite targets the database grammar and is collision-safe (one row per (asset, key); the rest stay inert)", () => {
    const body = m27.slice(m27.indexOf("\nBEGIN;"), m27.indexOf("\nCOMMIT;"));
    expect(body).toContain("SET alias_normalized = c.k");
    expect(body).toContain("normalize_tag(a.alias) AS k");
    expect(body).toContain("AND NOT c.key_taken");
    expect(body).toContain("AND c.rn = 1;");
    expect(body).toMatch(/row_number\(\) OVER \(PARTITION BY a\.asset_id, normalize_tag\(a\.alias\)\s+ORDER BY a\.created_at, a\.id\)/);
    expect(body).not.toMatch(/DELETE FROM asset_aliases/);
  });
  it("every future writer lands in the grammar: a BEFORE trigger derives the key; search_path pinned", () => {
    expect(m27).toContain("CREATE OR REPLACE FUNCTION asset_aliases_one_grammar()");
    expect(m27).toContain("RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$");
    expect(m27).toContain("NEW.alias_normalized := normalize_tag(NEW.alias);");
    expect(m27).toMatch(/CREATE TRIGGER trg_asset_aliases_one_grammar\n\s+BEFORE INSERT OR UPDATE OF alias, alias_normalized ON asset_aliases\n\s+FOR EACH ROW EXECUTE FUNCTION asset_aliases_one_grammar\(\);/);
  });
  it("a second spelling of an alias the asset already carries — the empty key included — is DROPPED on insert (RETURN NULL), never raised; a re-run by id still reaches ON CONFLICT", () => {
    const fn = m27.slice(m27.indexOf("CREATE OR REPLACE FUNCTION asset_aliases_one_grammar()"), m27.indexOf("DROP TRIGGER IF EXISTS trg_asset_aliases_one_grammar"));
    expect(fn).toMatch(/IF TG_OP = 'INSERT'\s+AND EXISTS \(SELECT 1 FROM asset_aliases o\s+WHERE o\.asset_id = NEW\.asset_id\s+AND o\.alias_normalized = NEW\.alias_normalized\s+AND o\.id IS DISTINCT FROM NEW\.id\) THEN\s+RETURN NULL;\s+END IF;\s+RETURN NEW;/);
    // The transcription above ("drop") is this body: no exemption for the empty key.
    expect(fn).not.toMatch(/alias_normalized <> ''/);
    expect(m27).toContain("prosrc LIKE '%IF TG_OP = ''INSERT''%'");
    expect(m27).toContain("AND prosrc NOT LIKE '%NEW.alias_normalized <> ''''%'");
  });
  it("probes read prosrc verbatim and never touch customer rows", () => {
    expect(m27).toContain("p.prosrc LIKE '%lower(regexp_replace(%'");
    expect(m27).toContain("prosrc LIKE '%NEW.alias_normalized := normalize_tag(NEW.alias);%'");
    const tail = m27.slice(m27.indexOf("\nCOMMIT;"));
    expect(tail).not.toMatch(/SELECT \*|SELECT alias\b|SELECT a\.alias\b/);
  });
});
