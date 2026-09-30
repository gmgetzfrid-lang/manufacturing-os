// intelligence Round G (I-10) — GAP-311: tag lookup in ⌘K.
//
// "FV-2201 is leaking": typing a tag — in any format, as a site code, or by
// a taught alias — returns the asset, its operating area and the drawings it
// appears on, ranked first, from indexed identity reads only (no AI call),
// and an asset hit lands on the asset hub, not the admin registry table.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, type FakeDb } from "./helpers/fakeSupabase";

const db = vi.hoisted(() => ({ ref: null as unknown as FakeDb }));
vi.mock("@/lib/supabase", async () => {
  const { makeFakeSupabase, newFakeDb: fresh } = await import("./helpers/fakeSupabase");
  db.ref = fresh();
  const proxy = new Proxy({}, { get: (_t, p: string) => (makeFakeSupabase(db.ref) as Record<string, unknown>)[p] });
  return { supabase: proxy };
});

import { lookupTag } from "@/lib/search";
import { globalSearch, assetHubHref } from "@/lib/globalSearch";

beforeEach(() => {
  Object.assign(db.ref, newFakeDb());
  db.ref.tables = {
    assets: [
      { id: "a-fv", org_id: "o1", tag: "FV-2201", tag_normalized: "fv2201", description: "Feed control valve", unit_code: "20", code: "2045.2201", archived: false },
      { id: "a-h3", org_id: "o1", tag: "H-3", tag_normalized: "h3", description: "Charge heater", unit_code: "25", code: "2535.3", archived: false },
      { id: "a-old", org_id: "o1", tag: "P-9", tag_normalized: "p9", description: "Retired pump", unit_code: "20", code: null, archived: true },
      { id: "a-other-org", org_id: "o2", tag: "FV-2201", tag_normalized: "fv2201", description: "Not ours", unit_code: null, code: null, archived: false },
    ],
    asset_aliases: [{ id: "al1", org_id: "o1", asset_id: "a-h3", alias: "the north furnace", alias_normalized: "thenorthfurnace" }],
    codebook_entries: [
      { id: "u20", org_id: "o1", kind: "unit", code: "20", label: "Crude Unit" },
      { id: "u25", org_id: "o1", kind: "unit", code: "25", label: "DHT" },
    ],
    document_assets: [
      { id: "da1", org_id: "o1", document_id: "d1", asset_id: "a-fv" },
      { id: "da2", org_id: "o1", document_id: "d2", asset_id: "a-fv" },
      { id: "da3", org_id: "o1", document_id: "d3", asset_id: "a-h3" },
    ],
    documents: [
      { id: "d1", org_id: "o1", library_id: "lib", document_number: "2002-D-10001", title: "P&ID crude feed", status: "Released", updated_at: "2026-09-01" },
      { id: "d2", org_id: "o1", library_id: "lib", document_number: "2002-D-10002", title: "P&ID crude feed sht 2", status: "Released", updated_at: "2026-09-02" },
      { id: "d3", org_id: "o1", library_id: "lib", document_number: "2502-D-00300", title: "P&ID DHT heater", status: "Released", updated_at: "2026-09-03" },
    ],
    tickets: [], projects: [], notes: [], transmittals: [],
  };
});

describe("lookupTag — tag → asset → unit → drawings, no AI", () => {
  it("every tag-format variant resolves by the one grammar", async () => {
    for (const typed of ["FV-2201", "fv2201", "FV 2201", "fv–2201", " FV-2201 "]) {
      const hits = await lookupTag("o1", typed);
      expect(hits.map((h) => h.asset.id), typed).toEqual(["a-fv"]);
      expect(hits[0].via).toBe("tag");
      expect(hits[0].unit).toEqual({ code: "20", label: "Crude Unit" });
      expect(hits[0].documents.map((d) => d.document_number)).toEqual(["2002-D-10001", "2002-D-10002"]);
    }
  });
  it("a site code and a taught alias resolve too (GAP-310 acceptance 2, the ⌘K half)", async () => {
    const byCode = await lookupTag("o1", "2045.2201");
    expect(byCode.map((h) => [h.asset.id, h.via])).toEqual([["a-fv", "code"]]);
    const byAlias = await lookupTag("o1", "The North-Furnace");
    expect(byAlias.map((h) => [h.asset.id, h.via])).toEqual([["a-h3", "alias"]]);
    expect(byAlias[0].unit).toEqual({ code: "25", label: "DHT" });
  });
  it("never another org's asset, never an archived one, never a paragraph", async () => {
    expect((await lookupTag("o2", "FV-2201")).map((h) => h.asset.id)).toEqual(["a-other-org"]);
    expect(await lookupTag("o1", "P-9")).toEqual([]);
    expect(await lookupTag("o1", "x")).toEqual([]);
    expect(await lookupTag("o1", "a".repeat(120))).toEqual([]);
  });
  it("reads only by indexed equality (tag_normalized / code / alias key) — no text search, no ilike, no AI route", async () => {
    await lookupTag("o1", "FV-2201");
    const assetCalls = db.ref.calls.filter((c) => c.table === "assets");
    expect(assetCalls.some((c) => c.method === "ilike" || c.method === "textSearch" || c.method === "or")).toBe(false);
    expect(assetCalls.some((c) => c.method === "eq" && c.args[0] === "tag_normalized" && c.args[1] === "fv2201")).toBe(true);
    const src = readFileSync(join(process.cwd(), "lib", "search.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function lookupTag("), src.indexOf("/** Apply full-text search"));
    expect(body).not.toMatch(/fetch\(|\/api\/|callAiModel|knowledge/);
  });
});

describe("globalSearch — the exact answer ranks first and lands on the asset hub", () => {
  it("asset, then its operating area, then the drawings it is on — all flagged exact, before anything fuzzy", async () => {
    const hits = await globalSearch({ orgId: "o1", query: "fv2201" });
    const exact = hits.filter((h) => h.exact);
    expect(hits.slice(0, exact.length)).toEqual(exact);
    expect(exact[0]).toMatchObject({ kind: "asset", title: "FV-2201", href: "/assets/FV-2201", badge: "Tag" });
    expect(exact[0].subtitle).toMatch(/^20 — Crude Unit · 2045\.2201 · Feed control valve$/);
    expect(exact[1]).toMatchObject({ kind: "asset", facet: "unit", title: "20 — Crude Unit", href: "/admin/assets?unit=20" });
    expect(exact.slice(2).map((h) => [h.kind, h.title])).toEqual([["document", "2002-D-10001"], ["document", "2002-D-10002"]]);
    // the fuzzy asset search does not repeat the exact hit
    expect(hits.filter((h) => h.kind === "asset" && h.id === "a-fv")).toHaveLength(1);
  });
  it("every asset hit (exact or fuzzy) goes to /assets/<tag>, never /admin/assets?tag=", async () => {
    const hits = await globalSearch({ orgId: "o1", query: "heater" });
    for (const h of hits.filter((x) => x.kind === "asset" && !x.facet)) {
      expect(h.href).toBe(assetHubHref(h.title));
      expect(h.href).not.toMatch(/\/admin\/assets\?tag=/);
    }
    expect(assetHubHref("FV 2201/A")).toBe("/assets/FV%202201%2FA");
  });
  it("the palette puts exact hits above actions and places", () => {
    const pal = readFileSync(join(process.cwd(), "components", "navigation", "GlobalCommandPalette.tsx"), "utf8");
    const iExact = pal.indexOf("if (!h.exact) continue;");
    const iActions = pal.indexOf("for (const a of ACTIONS) {");
    const iPlaces = pal.indexOf("for (const p of searchAtlas(trimmed, 4))");
    expect(iExact).toBeGreaterThan(0);
    expect(iExact).toBeLessThan(iActions);
    expect(iExact).toBeLessThan(iPlaces);
    expect(pal).toContain("if (h.exact) continue;");
  });
});
