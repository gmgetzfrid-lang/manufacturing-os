import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/r2", () => ({ r2: {}, R2_BUCKET: "x" }));
import { parseCensus, salvageJson, splitCallout, tileGrid, DrawingReadError } from "@/lib/drawingCensus";

describe("drawing census parsing", () => {
  it("keeps callouts, instruments and off-sheet tags apart, normalised", () => {
    const text = 'Here you go: {"equipment":[{"tag":"V-14","code":"6110.14","name":"35# STEAM DRUM"},{"tag":"x 60","code":"2030.60","name":"STEAM GENERATOR"},{"tag":"P–51","code":"6026.51","name":"B.F.W. RECIRCULATING PUMP"}],' +
      '"instruments":["PIT 130","FE-130","LIC-222","PSV-21","V-14"],' +
      '"offSheet":[{"tag":"X-45","direction":"FROM","drawing":"2002-D 2001","sheet":"12"},{"tag":"LV-222","direction":"to"},{"tag":"V-14","direction":"to"}],' +
      '"title":{"drawingNumber":"2002-D 2001","sheet":"5","rev":"42"}}';
    const s = parseCensus(text);
    expect(s.equipment.map((e) => e.tag)).toEqual(["V-14", "X-60", "P-51"]);
    expect(s.equipment[1]).toEqual({ tag: "X-60", code: "2030.60", name: "STEAM GENERATOR", details: null });
    expect(s.instruments).toEqual(["PIT-130", "FE-130", "LIC-222", "PSV-21"]);
    expect(s.offSheet.map((o) => [o.tag, o.direction])).toEqual([["X-45", "from"], ["LV-222", "to"]]);
    expect(s.title.rev).toBe("42");
  });
  it("keeps the design data printed in a callout", () => {
    const s = parseCensus('{"equipment":[{"tag":"V-14","code":"6110.14","name":"35# STEAM DRUM","details":"4\'-0\\" I.D. x 10\'-0\\" T/T; DESIGN 75 PSIG @ 650 F"}]}');
    expect(s.equipment[0].details).toBe("4'-0\" I.D. x 10'-0\" T/T; DESIGN 75 PSIG @ 650 F");
  });
  it("drops anything that is not shaped like a tag, and survives junk", () => {
    const s = parseCensus('{"equipment":[{"tag":"35# STEAM"},{"tag":""},{"tag":"2002-D 2001"}],"instruments":["130"]}');
    expect(s.equipment).toEqual([]);
    expect(s.instruments).toEqual([]);
    // No answer is a failed read, never "no equipment on this sheet".
    expect(() => parseCensus("no json at all")).toThrow(DrawingReadError);
  });

  it("keeps what was complete when the answer is cut off", () => {
    const cut = '{"equipment":[{"tag":"H-1","name":"CRUDE HEATER"},{"tag":"H-2","name":"CRUDE HEATER"},{"tag":"V-1","na';
    const s = parseCensus(cut);
    // V-1's tag was closed before the cut; its name was not.
    expect(s.equipment.map((e) => e.tag)).toEqual(["H-1", "H-2", "V-1"]);
    expect(parseCensus('{"equipment":[{"tag":"H-1"},{"tag":"V-1').equipment.map((e) => e.tag)).toEqual(["H-1"]);
    expect(salvageJson('{"a":[1,2,3')).toEqual({ a: [1, 2] });
  });

  it("splits one callout for several items", () => {
    expect(splitCallout("P-101A/B")).toEqual(["P-101A", "P-101B"]);
    expect(splitCallout("E-5A,B,C")).toEqual(["E-5A", "E-5B", "E-5C"]);
    expect(splitCallout("H-1 & H-2")).toEqual(["H-1", "H-2"]);
    expect(splitCallout("V-14")).toEqual(["V-14"]);
    const s = parseCensus('{"equipment":[{"tag":"H-1 & H-2","name":"CRUDE HEATERS"}],"instruments":["PSV-1A/B"]}');
    expect(s.equipment.map((e) => e.tag)).toEqual(["H-1", "H-2"]);
    expect(s.instruments).toEqual(["PSV-1A", "PSV-1B"]);
  });

  it("cuts a sheet into tiles about a letter page each", () => {
    expect(tileGrid(44 * 72, 34 * 72)).toEqual({ cols: 4, rows: 4 });   // E-size
    expect(tileGrid(36 * 72, 24 * 72)).toEqual({ cols: 4, rows: 3 });   // ARCH D
    expect(tileGrid(17 * 72, 11 * 72)).toEqual({ cols: 2, rows: 2 });   // B-size
    expect(tileGrid(11 * 72, 8.5 * 72)).toEqual({ cols: 1, rows: 1 });  // letter
  });
});

import { mergeReadings, parseTitleWords, TILE_SYSTEM, sheetEntityRows, CENSUS_READ, CENSUS_PARTIAL, readDrawingSheet } from "@/lib/drawingCensus";

describe("reading a sheet tile by tile", () => {
  it("the tile instructions really replaced the whole-sheet ones", () => {
    expect(TILE_SYSTEM).toContain("ONE zoomed TILE");
    expect(TILE_SYSTEM).not.toContain("Work tile by tile and do not stop early");
    expect(TILE_SYSTEM).toContain("Return STRICT JSON");
  });
  it("merges overlapping tiles: one entry per tag, the fullest callout wins", () => {
    const a = parseCensus('{"equipment":[{"tag":"X-31"}],"instruments":["PI-445","TI-355"],"offSheet":[{"tag":"X-51","direction":"from"}]}');
    const b = parseCensus('{"equipment":[{"tag":"X-31","code":"2030.31","name":"FRACT. OVERHEAD/CRUDE EXCHANGER"}],"instruments":["TI-355","PIT-450"],"title":{"drawingNumber":"2002-D 2001","sheet":"1","rev":"39"}}');
    const m = mergeReadings([a, b]);
    expect(m.equipment).toEqual([{ tag: "X-31", code: "2030.31", name: "FRACT. OVERHEAD/CRUDE EXCHANGER", details: null }]);
    expect(m.instruments.sort()).toEqual(["PI-445", "PIT-450", "TI-355"]);
    expect(m.offSheet.map((o) => o.tag)).toEqual(["X-51"]);
    expect(m.title).toEqual({ drawingNumber: "2002-D 2001", sheet: "1", rev: "39" });
  });
  it("reads shared-number bubbles and short ranges as separate instruments", () => {
    expect(splitCallout("TE/TW 64")).toEqual(["TE-64", "TW-64"]);
    expect(splitCallout("SOV 501-508")).toHaveLength(8);
    expect(splitCallout("SOV 501-508")[7]).toBe("SOV-508");
    expect(splitCallout("PIT-130")).toEqual(["PIT-130"]);
  });
  it("takes sheet and revision from the PDF's own title block text", () => {
    expect(parseTitleWords(["NTS", "2002-D 2001", "1 of 16", "39"])).toEqual({ sheet: "1", rev: "39" });
    expect(parseTitleWords(["NOTES:", "1. WARM-UP BYPASS"])).toBeNull();
  });
  it("a page with a tile that failed is stored, but marked to be read again", () => {
    const sheet = { ...mergeReadings([]), complete: false };
    const rows = sheetEntityRows({ org_id: "o", library_id: "l", document_id: "d", page: 1 }, sheet);
    expect(rows.find((r) => r.kind === "census")?.tag).toBe(CENSUS_PARTIAL);
    expect(sheetEntityRows({ org_id: "o", library_id: "l", document_id: "d", page: 1 }, { ...sheet, complete: true }).find((r) => r.kind === "census")?.tag).toBe(CENSUS_READ);
  });
});

describe("readDrawingSheet", () => {
  const img = { mediaType: "image/jpeg" as const, base64: "x" };
  const pdf = {
    numPages: 3,
    getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "2002-D 2001" }, { str: "1 of 16" }, { str: "39" }] }) }),
  } as unknown as Parameters<typeof readDrawingSheet>[0];
  const render = async () => ({ images: [img, img, img, img, img], quadrants: [img], small: img, grid: { cols: 2, rows: 2 }, pageCount: 3 });

  it("reads each tile in its own call and merges them; a failed tile leaves the page partial", async () => {
    const users: string[] = [];
    const call = async (a: { system: string; user: string }) => {
      if (a.system === TILE_SYSTEM) users.push(a.user);
      if (a.system !== TILE_SYSTEM) return "";
      if (a.user.includes("row 2 of 2, column 2 of 2")) throw new Error("timeout");
      const n = a.user.match(/row (\d) of 2, column (\d)/)!;
      return `{"instruments":["PI-${n[1]}${n[2]}","TI-355"]}`;
    };
    const out = await readDrawingSheet(pdf, 1, "2002-D 2001", call, { render, transcript: false });
    expect(users).toHaveLength(4);
    expect(out!.sheet.instruments.sort()).toEqual(["PI-11", "PI-12", "PI-21", "TI-355"]);
    expect(out!.sheet.complete).toBe(false);
    // Sheet and revision from the PDF's own title block text.
    expect(out!.sheet.title).toMatchObject({ sheet: "1", rev: "39" });
  });

  it("every tile failing is a failed read — nothing is changed", async () => {
    const call = async (a: { system: string }) => { if (a.system === TILE_SYSTEM) throw new Error("down"); return ""; };
    await expect(readDrawingSheet(pdf, 1, "x", call, { render, transcript: false })).rejects.toThrow(DrawingReadError);
  });
});

describe("one item labelled twice", () => {
  it("callout and symbol label with the same site code merge into one", () => {
    const a = parseCensus('{"equipment":[{"tag":"P-04","code":"3524.04","name":"CHLORIDE CHEMICAL INJECTION PUMP (WEST)"},{"tag":"X-31","code":"3530.31","name":"CHARGE/EFFLUENT EXCHANGER"}]}');
    const b = parseCensus('{"equipment":[{"tag":"P-4","code":"3524.04"},{"tag":"X-31"}]}');
    const m = mergeReadings([a, b]);
    expect(m.equipment.map((e) => e.tag).sort()).toEqual(["P-04", "X-31"]);
    expect(m.equipment.find((e) => e.tag === "P-04")?.name).toBe("CHLORIDE CHEMICAL INJECTION PUMP (WEST)");
  });
  it("different site codes stay different items", () => {
    const m = mergeReadings([parseCensus('{"equipment":[{"tag":"P-04","code":"3524.04"},{"tag":"P-4","code":"2026.04"}]}')]);
    expect(m.equipment).toHaveLength(2);
  });
});
