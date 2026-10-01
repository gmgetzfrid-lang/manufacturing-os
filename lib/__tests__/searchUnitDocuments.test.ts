// intelligence Round G (I-09) — WIRE-3's lib/search.ts limb: an operational
// unit's documents are the ones filed to it (documents.unit_id) AND the ones
// whose drawing number decodes to the Site Codebook unit it is mapped to
// (documents.unit_code, 20261138 / DEC-67). Before, the unitId filter read
// documents.unit_id only — a column no UI writes — so it returned nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  units: [] as Row[],
  unitsError: null as null | { code?: string; message: string },
  documents: [] as Row[],
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));
vi.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const filters: Array<(r: Row) => boolean> = [];
    const h: ProxyHandler<object> = {
      get(_t, prop: string) {
        if (prop === "then") {
          const src = table === "documents" ? db.documents : table === "units" ? db.units : [];
          const rows = src.filter((r) => filters.every((f) => f(r)));
          return (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
        }
        return (...args: unknown[]) => {
          db.calls.push({ table, method: prop, args });
          if (prop === "eq") filters.push((r) => r[String(args[0])] === args[1]);
          if (prop === "not") filters.push((r) => r[String(args[0])] !== null && r[String(args[0])] !== undefined);
          if (prop === "or" && table === "documents") {
            // "unit_id.eq.<id>,unit_code.eq.\"<code>\"" or "plant_id.eq.<id>,unit_code.in.(\"20\",\"25\")"
            const raw = String(args[0]);
            const inMatch = raw.match(/,(\w+)\.in\.\((.*)\)$/);
            const head = inMatch ? raw.slice(0, inMatch.index) : raw;
            const eqs = head.split(",").map((p) => p.match(/^(\w+)\.eq\."?([^"]*)"?$/)!);
            const inCol = inMatch?.[1];
            const inVals = inMatch ? inMatch[2].split(",").map((v) => v.replace(/"/g, "")) : [];
            filters.push((r) => eqs.some((m) => r[m[1]] === m[2]) || (!!inCol && inVals.includes(String(r[inCol]))));
          }
          if (prop === "maybeSingle") {
            if (db.unitsError) return Promise.resolve({ data: null, error: db.unitsError });
            const id = db.calls.filter((c) => c.table === table && c.method === "eq").pop()?.args[1];
            return Promise.resolve({ data: db.units.find((u) => u.id === id) ?? null, error: null });
          }
          return new Proxy({}, h);
        };
      },
    };
    return new Proxy({}, h);
  };
  return { supabase: { from: (t: string) => chain(t) } };
});

import { searchDocuments, unitDocumentFilter } from "@/lib/search";

beforeEach(() => {
  db.calls = []; db.unitsError = null;
  db.units = [
    { id: "u-crude", plant_id: "p1", archived: false, codebook_code: "20" },
    { id: "u-unmapped", plant_id: "p2", archived: false, codebook_code: null },
  ];
  db.documents = [
    { id: "d-filed", org_id: "o1", unit_id: "u-crude", unit_code: null },
    { id: "d-decoded", org_id: "o1", unit_id: null, unit_code: "20" },
    { id: "d-other", org_id: "o1", unit_id: null, unit_code: "25" },
    { id: "d-plant", org_id: "o1", plant_id: "p1", unit_id: null, unit_code: null },
  ];
});

describe("WIRE-3 — searchDocuments({ unitId }) finds the unit's documents", () => {
  it("a mapped unit: the documents filed to it AND the ones whose number decodes to its codebook code", async () => {
    const rows = await searchDocuments({ orgId: "o1", unitId: "u-crude" });
    expect(rows.map((r) => r.id).sort()).toEqual(["d-decoded", "d-filed"]);
    expect(db.calls.find((c) => c.table === "documents" && c.method === "or")?.args[0]).toBe('unit_id.eq.u-crude,unit_code.eq."20"');
  });

  it("an unmapped unit, or a database before 20261138: unit_id alone, as before", async () => {
    expect(await unitDocumentFilter("u-unmapped")).toBeNull();
    expect((await searchDocuments({ orgId: "o1", unitId: "u-unmapped" })).map((r) => r.id)).toEqual([]);
    db.unitsError = { code: "42703", message: "column units.codebook_code does not exist" };
    expect(await unitDocumentFilter("u-crude")).toBeNull();
    expect((await searchDocuments({ orgId: "o1", unitId: "u-crude" })).map((r) => r.id)).toEqual(["d-filed"]);
  });

  it("a plant: its filed documents AND the ones decoded to a codebook unit one of its units is mapped to", async () => {
    const rows = await searchDocuments({ orgId: "o1", plantId: "p1" });
    expect(rows.map((r) => r.id).sort()).toEqual(["d-decoded", "d-plant"]);
    expect(db.calls.find((c) => c.table === "documents" && c.method === "or")?.args[0]).toBe('plant_id.eq.p1,unit_code.in.("20")');
    // a plant none of whose units is mapped: plant_id alone
    db.calls = [];
    await searchDocuments({ orgId: "o1", plantId: "p2" });
    expect(db.calls.some((c) => c.table === "documents" && c.method === "or")).toBe(false);
  });

  it("there is no systemId filter on documents any more (a system has no decoded identity; nothing files to one)", async () => {
    const src = (await import("node:fs")).readFileSync(`${process.cwd()}/lib/search.ts`, "utf8");
    const docs = src.slice(src.indexOf("export interface DocumentSearchParams"), src.indexOf("export interface AssetSearchParams"));
    expect(docs).not.toMatch(/systemId\?:/);
    expect(docs).not.toMatch(/\bsystemId,/);
    expect(docs).not.toMatch(/system_id", systemId/);
  });

  it("no unitId: no units read, no unit filter", async () => {
    await searchDocuments({ orgId: "o1" });
    expect(db.calls.some((c) => c.table === "units")).toBe(false);
    expect(db.calls.some((c) => c.table === "documents" && c.method === "or")).toBe(false);
  });
});
