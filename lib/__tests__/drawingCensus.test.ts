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
