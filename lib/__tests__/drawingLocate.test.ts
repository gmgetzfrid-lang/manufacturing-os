import { describe, it, expect } from "vitest";
import { parseLocateResponse, buildRelocateUser, textMarkPosition } from "../drawingLocate";

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

describe("buildRelocateUser — the relocate round says what was actually observed (PR-10 / DWG-13)", () => {
  it("names the wrong spot, says the close-up did not show it, and asks for an omission over a guess", () => {
    const u = buildRelocateUser(["V-3"], "025-PID-0104.pdf", 1, { "V-3": [0.5, 0.05] });
    expect(u).toContain("V-3 at [0.50, 0.05]");
    expect(u).toMatch(/close-up of that spot does NOT show/);
    expect(u).toMatch(/If you cannot see it, omit it/);
  });
});

describe("textMarkPosition — text-layer marks on the page as drawn (DWG-3)", () => {
  const plain = { rotate: 0, view: [0, 0, 612, 792], userUnit: 1 };
  it("a plain page maps every stored mark to itself — edges included", () => {
    for (const [x, y] of [[0.1, 0.2], [0, 1], [1, 0], [0.5, 0.5]]) {
      expect(textMarkPosition(x, y, plain)).toEqual({ nx: x, ny: y });
    }
  });
  it("/Rotate 180 puts an upper-left store in the lower-right — the PID-Legend fixture's arithmetic", () => {
    // fixtures/PID-Legend.pdf: rotate 180, view [0,0,1224,792], a glyph at (72, 767).
    const stored = { nx: 72 / 1224, ny: 1 - 767 / 792 };
    const at = textMarkPosition(stored.nx, stored.ny, { rotate: 180, view: [0, 0, 1224, 792] })!;
    expect(at.nx).toBeCloseTo(0.941, 3);
    expect(at.ny).toBeCloseTo(0.968, 3);
  });
  it("refuses a value the ingest clamp pinned to an edge on a page that is not plain", () => {
    expect(textMarkPosition(0, 0.4, { rotate: 90, view: [0, 0, 612, 792] })).toBeNull();
    expect(textMarkPosition(0.4, 1, { rotate: 0, view: [20, 30, 632, 822] })).toBeNull();
    expect(textMarkPosition(Number.NaN, 0.4, plain)).toBeNull();
  });
});
