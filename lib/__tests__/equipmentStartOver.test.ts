import { describe, it, expect } from "vitest";
import { planStartOver, removable, journalAdditions, withoutReaderEntries, columnList, planKey, type StartOverAsset } from "@/lib/equipmentStartOver";

const a = (x: Partial<StartOverAsset> & { id: string; tag: string }): StartOverAsset => ({ code: null, unitCode: "20", origin: "drawing", photos: 0, files: 0, refs: 0, edited: false, createdAt: "2026-10-01", ...x });

// The live registry in small: the X-31 a person added, with its ID and
// photos, and the reader's copy; the reader's own X-39 with its ID; a C-02
// with nothing; a reader record a person hung a note on; two V-5s in unit
// 55 with different IDs; and a reader V-5 copy with no ID.
const reg: StartOverAsset[] = [
  a({ id: "x31-mine", tag: "X-31", code: "2030.31", origin: "manual", photos: 3, createdAt: "2026-05-28" }),
  a({ id: "x31-copy", tag: "X-31", createdAt: "2026-10-22" }),
  a({ id: "x39", tag: "X-39", code: "2030.39" }),
  a({ id: "c02", tag: "C-02" }),
  a({ id: "noted", tag: "P-9", refs: 1 }),
  a({ id: "v5-09", tag: "V-5", code: "5510.09", unitCode: "55", files: 1 }),
  a({ id: "v5-19", tag: "V-5", code: "5510.19", unitCode: "55", photos: 1 }),
  a({ id: "v5-copy", tag: "V-5", unitCode: "55", photos: 2 }),
  a({ id: "x32-mine", tag: "X-32", code: "2030.32", origin: "manual" }),
];

describe("what Start over removes", () => {
  it("only reader records nothing holds on to", () => {
    expect(removable(a({ id: "r", tag: "X-1" }))).toBe(true);
    expect(removable(a({ id: "m", tag: "X-1", origin: "manual" }))).toBe(false);
    expect(removable(a({ id: "f", tag: "X-1", origin: "folder" }))).toBe(false);
    expect(removable(a({ id: "p", tag: "X-1", photos: 1 }))).toBe(false);
    expect(removable(a({ id: "l", tag: "X-1", files: 1 }))).toBe(false);
    expect(removable(a({ id: "n", tag: "X-1", refs: 2 }))).toBe(false);
    expect(removable(a({ id: "e", tag: "X-1", edited: true }))).toBe(true);
    expect(removable(a({ id: "e", tag: "X-1", edited: true }), { keepEdited: true })).toBe(false);
  });
  it("the reader's X-31 copy, X-39 and C-02 go; what a person added or hung something on stays", () => {
    const plan = planStartOver(reg);
    expect(plan.remove.map((r) => r.id).sort()).toEqual(["c02", "x31-copy", "x39"]);
    expect(plan.remove.find((r) => r.id === "x39")).toMatchObject({ tag: "X-39", code: "2030.39", unitCode: "20" });
    expect(plan.kept).toMatchObject({ manual: 2, reader: 4 });
  });
  it("never removes a person's record or anything with photos or files, whatever the option", () => {
    for (const keepEdited of [false, true]) {
      const gone = new Set(planStartOver(reg, { keepEdited }).remove.map((r) => r.id));
      for (const r of reg) if (r.origin !== "drawing" || r.photos || r.files || r.refs) expect(gone.has(r.id)).toBe(false);
    }
  });
});

describe("what Start over merges", () => {
  it("a reader copy with photos merges into the record a person added; its photos move", () => {
    const plan = planStartOver([
      a({ id: "mine", tag: "X-31", code: "2030.31", origin: "manual" }),
      a({ id: "copy", tag: "X-31", photos: 2, files: 1 }),
    ]);
    expect(plan.remove).toEqual([]);
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0]).toMatchObject({ keep: { id: "mine", origin: "manual" }, drop: [{ id: "copy", photos: 2, files: 1 }], by: "id" });
  });
  it("no person's record: the one with the ID stays, else the one with photos", () => {
    const byId = planStartOver([a({ id: "p", tag: "E-3", photos: 1 }), a({ id: "i", tag: "E-3", code: "2030.03", files: 1 })]);
    expect(byId.merges[0]).toMatchObject({ keep: { id: "i" }, drop: [{ id: "p" }] });
    const byPhotos = planStartOver([a({ id: "f", tag: "E-3", files: 1 }), a({ id: "p", tag: "E-3", photos: 1 })]);
    expect(byPhotos.merges[0]).toMatchObject({ keep: { id: "p" }, drop: [{ id: "f" }], by: "tag" });
  });
  it("the same ID on two records is one piece", () => {
    const plan = planStartOver([a({ id: "x", tag: "V-7", code: "2010.07", photos: 1 }), a({ id: "y", tag: "V-07", code: "2010.7", unitCode: "55", files: 1 })]);
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0].drop).toHaveLength(1);
  });
  it("two records a person added are never merged away: left for them", () => {
    const plan = planStartOver([a({ id: "m1", tag: "X-31", code: "2030.31", origin: "manual", createdAt: "2026-01-01" }), a({ id: "m2", tag: "X-31", origin: "manual", createdAt: "2026-02-01" })]);
    expect(plan.merges).toEqual([]);
    expect(plan.unsure).toEqual([{ tag: "X-31", unitCode: "20", ids: ["2030.31", "no ID"], why: "typed" }]);
  });
  it("a copy with no ID where the unit has two IDs for the tag is left, and said", () => {
    const plan = planStartOver(reg);
    expect(plan.merges.flatMap((m) => m.drop.map((d) => d.id))).not.toContain("v5-copy");
    expect(plan.unsure).toContainEqual({ tag: "V-5", unitCode: "55", ids: ["5510.09", "5510.19"], why: "ids" });
  });
  it("records that are different pieces are never merged", () => {
    const plan = planStartOver([a({ id: "u20", tag: "V-21", code: "2010.21", photos: 1 }), a({ id: "u56", tag: "V-21", code: "5610.02", unitCode: "56", photos: 1 })]);
    expect(plan.merges).toEqual([]);
  });
  it("running it again finds nothing more to do", () => {
    const first = planStartOver([a({ id: "mine", tag: "X-31", code: "2030.31", origin: "manual" }), a({ id: "copy", tag: "X-31", photos: 2 }), a({ id: "c02", tag: "C-02" })]);
    const gone = new Set([...first.remove.map((r) => r.id), ...first.merges.flatMap((m) => m.drop.map((d) => d.id))]);
    const after = [a({ id: "mine", tag: "X-31", code: "2030.31", origin: "manual", photos: 2 }), a({ id: "copy", tag: "X-31", photos: 2 }), a({ id: "c02", tag: "C-02" })].filter((r) => !gone.has(r.id));
    const second = planStartOver(after);
    expect(second.remove).toEqual([]);
    expect(second.merges).toEqual([]);
  });
});

describe("what comes off the drawings", () => {
  it("what runs added: each run's after minus its before", () => {
    expect(journalAdditions([
      { before: ["X-31 (2030.31)"], after: ["X-31 (2030.31)", "X-31", "P-2"] },
      { before: "P-2", after: "P-2, V-7" },
      { before: null, after: ["X-31"] },
    ])).toEqual(["X-31", "P-2", "V-7"]);
  });
  it("only the reader's own entries come off; what a person typed stays", () => {
    const column = columnList(["X-31 (2030.31)", "X-32 (2030.32)", "P-2", "X-31", "X-32"]);
    expect(withoutReaderEntries(column, ["X-31", "x32", "Z-1"])).toEqual({ keep: ["X-31 (2030.31)", "X-32 (2030.32)", "P-2"], removed: ["X-31", "X-32"] });
    expect(withoutReaderEntries(column, [])).toEqual({ keep: column, removed: [] });
  });
  it("a column kept as text reads as a list", () => {
    expect(columnList("X-31, P-2 ,")).toEqual(["X-31", "P-2"]);
    expect(columnList(undefined)).toEqual([]);
  });
});

describe("the preview's fingerprint", () => {
  it("is the same for the same plan and changes when the plan does", () => {
    const plan = planStartOver(reg);
    const docs = [{ documentId: "d1", removed: ["X-31"], links: 2 }];
    expect(planKey(plan, docs)).toBe(planKey(planStartOver([...reg].reverse()), docs));
    expect(planKey(plan, docs)).not.toBe(planKey(plan, [{ documentId: "d1", removed: ["X-31", "P-2"], links: 2 }]));
    expect(planKey(plan, docs)).not.toBe(planKey(planStartOver(reg.filter((r) => r.id !== "c02")), docs));
  });
});
