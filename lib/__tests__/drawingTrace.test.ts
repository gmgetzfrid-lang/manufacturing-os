import { describe, it, expect } from "vitest";
import { parseTraceResponse, TRACE_MAX_POINTS } from "../drawingTrace";

// A trace gets stroked over a real P&ID and read as "this is the pipe".
// A wrong path sends someone isolating the wrong line, so the parser is
// strict: anything malformed degrades to "no trace", never to a bad one.
describe("parseTraceResponse", () => {
  it("reads the plain form", () => {
    const out = parseTraceResponse(
      '{"found": true, "points": [[0.12, 0.8], [0.12, 0.55], [0.34, 0.55]], "note": ""}',
    );
    expect(out.found).toBe(true);
    expect(out.points).toEqual([
      { nx: 0.12, ny: 0.8 },
      { nx: 0.12, ny: 0.55 },
      { nx: 0.34, ny: 0.55 },
    ]);
    expect(out.note).toBeNull();
  });

  it("digs the object out of prose and code fences", () => {
    const out = parseTraceResponse(
      'Tracing now:\n```json\n{"found": true, "points": [[0.1, 0.1], [0.9, 0.1]]}\n```\nDone.',
    );
    expect(out.found).toBe(true);
    expect(out.points).toHaveLength(2);
  });

  it("rescales percentage and per-mille coordinates", () => {
    const pct = parseTraceResponse('{"found": true, "points": [[12, 80], [34, 55]]}');
    expect(pct.points).toEqual([{ nx: 0.12, ny: 0.8 }, { nx: 0.34, ny: 0.55 }]);
    const mille = parseTraceResponse('{"found": true, "points": [[120, 800], [340, 550]]}');
    expect(mille.points).toEqual([{ nx: 0.12, ny: 0.8 }, { nx: 0.34, ny: 0.55 }]);
  });

  it("accepts {x, y} object waypoints", () => {
    const out = parseTraceResponse(
      '{"found": true, "points": [{"x": 0.1, "y": 0.2}, {"nx": 0.3, "ny": 0.4}]}',
    );
    expect(out.points).toEqual([{ nx: 0.1, ny: 0.2 }, { nx: 0.3, ny: 0.4 }]);
  });

  it("honors the model declining, and keeps its reason", () => {
    const out = parseTraceResponse('{"found": false, "note": "line leaves the sheet at connector 03"}');
    expect(out.found).toBe(false);
    expect(out.points).toEqual([]);
    expect(out.note).toBe("line leaves the sheet at connector 03");
  });

  it("drops malformed waypoints without failing the trace", () => {
    const out = parseTraceResponse(
      '{"found": true, "points": [[0.1, 0.1], ["a", 0.5], [1.5e6, 0.5], null, [0.9, 0.9]]}',
    );
    expect(out.found).toBe(true);
    expect(out.points).toEqual([{ nx: 0.1, ny: 0.1 }, { nx: 0.9, ny: 0.9 }]);
  });

  it("collapses consecutive near-duplicate points", () => {
    const out = parseTraceResponse(
      '{"found": true, "points": [[0.1, 0.1], [0.101, 0.101], [0.5, 0.1]]}',
    );
    expect(out.points).toHaveLength(2);
  });

  it("needs at least two distinct points to be a line", () => {
    expect(parseTraceResponse('{"found": true, "points": [[0.5, 0.5]]}').found).toBe(false);
    expect(parseTraceResponse('{"found": true, "points": []}').found).toBe(false);
  });

  it("truncates a runaway path at the cap", () => {
    const pts = Array.from({ length: 100 }, (_, i) => `[${(i / 100).toFixed(2)}, 0.5]`);
    const out = parseTraceResponse(`{"found": true, "points": [${pts.join(",")}]}`);
    expect(out.points).toHaveLength(TRACE_MAX_POINTS);
  });

  it("returns no trace on garbage", () => {
    expect(parseTraceResponse("I couldn't find that line.").found).toBe(false);
    expect(parseTraceResponse("{broken json").found).toBe(false);
    expect(parseTraceResponse("").found).toBe(false);
  });
});
