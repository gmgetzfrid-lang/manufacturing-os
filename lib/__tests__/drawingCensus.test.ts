import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/r2", () => ({ r2: {}, R2_BUCKET: "x" }));
import { parseCensus } from "@/lib/drawingCensus";

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
    expect(parseCensus("no json at all").equipment).toEqual([]);
  });
});
