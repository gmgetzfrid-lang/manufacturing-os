import { describe, it, expect } from "vitest";
import { parseLocateResponse } from "../drawingLocate";

// A marker in the wrong place on an E-size drawing is worse than no marker:
// it sends someone to the wrong corner with confidence. Everything this
// parser lets through gets drawn on a real sheet, so it stays strict.
describe("parseLocateResponse", () => {
  const asked = ["V-3", "P-101A"];

  it("reads the plain [x, y] form", () => {
    const out = parseLocateResponse('{"V-3": [0.42, 0.18], "P-101A": [0.77, 0.63]}', asked);
    expect(out).toEqual([
      { tag: "V-3", nx: 0.42, ny: 0.18 },
      { tag: "P-101A", nx: 0.77, ny: 0.63 },
    ]);
  });

  it("digs the object out of prose and code fences", () => {
    const out = parseLocateResponse(
      'Here are the positions:\n```json\n{"V-3": [0.5, 0.5]}\n```\nHope that helps!',
      asked,
    );
    expect(out).toEqual([{ tag: "V-3", nx: 0.5, ny: 0.5 }]);
  });

  it("rescales percentage and per-mille answers", () => {
    expect(parseLocateResponse('{"V-3": [42, 18]}', asked))
      .toEqual([{ tag: "V-3", nx: 0.42, ny: 0.18 }]);
    expect(parseLocateResponse('{"V-3": [420, 180]}', asked))
      .toEqual([{ tag: "V-3", nx: 0.42, ny: 0.18 }]);
  });

  it("accepts the {x, y} object form", () => {
    expect(parseLocateResponse('{"V-3": {"x": 0.2, "y": 0.9}}', asked))
      .toEqual([{ tag: "V-3", nx: 0.2, ny: 0.9 }]);
  });

  it("matches tags loosely but reports them as asked", () => {
    expect(parseLocateResponse('{"v–3": [0.1, 0.2]}', asked))
      .toEqual([{ tag: "V-3", nx: 0.1, ny: 0.2 }]);
  });

  it("drops tags nobody asked about", () => {
    expect(parseLocateResponse('{"E-99": [0.1, 0.2], "V-3": [0.3, 0.4]}', asked))
      .toEqual([{ tag: "V-3", nx: 0.3, ny: 0.4 }]);
  });

  it("drops unusable coordinates instead of guessing", () => {
    expect(parseLocateResponse('{"V-3": [-0.2, 0.4]}', asked)).toEqual([]);
    expect(parseLocateResponse('{"V-3": [5000, 10]}', asked)).toEqual([]);
    expect(parseLocateResponse('{"V-3": ["left", "top"]}', asked)).toEqual([]);
    expect(parseLocateResponse('{"V-3": [0.5]}', asked)).toEqual([]);
  });

  it("survives a non-answer", () => {
    expect(parseLocateResponse("I can't see those tags on this sheet.", asked)).toEqual([]);
    expect(parseLocateResponse("{not json", asked)).toEqual([]);
    expect(parseLocateResponse("", asked)).toEqual([]);
  });

  it("keeps the first position when a tag repeats", () => {
    const out = parseLocateResponse('{"V-3": [0.1, 0.1], "v-3": [0.9, 0.9]}', asked);
    expect(out).toEqual([{ tag: "V-3", nx: 0.1, ny: 0.1 }]);
  });
});
