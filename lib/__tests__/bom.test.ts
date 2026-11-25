import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { bomLinesFor, bomRows, changedSince, describe as describeLine, planImport, splitDescription, woNumbers } from "@/lib/bom";
import { bomLayoutOf, fillBom, readBom } from "@/lib/bomForm";
import { blankMaterial, type Material } from "@/lib/materials";

const line = (id: string, extra: Partial<Material>): Material => ({
  ...blankMaterial(null), id, orgId: "o", projectId: "p", createdByName: null, createdAt: Number(id.replace(/\D/g, "")) || 1, updatedByName: null, updatedAt: 1, ...extra,
} as Material);

describe("the BOM from the materials register", () => {
  const reg = [
    line("1", { item: "Gasket", spec: "Spiral wound 316/FG, CL300", size: "6\"", qty: "2", workOrder: "301470", status: "ordered" }),
    line("2", { item: "Stud bolts", spec: "B7, 7/8 x 5", qty: "16", workOrder: "WO 301470 / 301471", status: "used", lineNo: 1 }),
    line("3", { item: "Tube plugs", spec: "", qty: "20", workOrder: "301471", status: "cancelled" }),
    line("4", { item: "Bundle", kind: "offsite", workOrder: "301470" }),
    line("5", { item: "Paint", workOrder: "300100" }),
  ];
  it("takes the package's work orders' materials, numbered lines first", () => {
    expect(woNumbers("WO 301470 / 301471")).toEqual(["301470", "301471"]);
    const got = bomLinesFor(reg, ["301470"]);
    expect(got.map((m) => m.id)).toEqual(["2", "1"]);        // no. 1 first; the off-site repair and other WOs left out
    expect(bomLinesFor(reg, ["301471"]).map((m) => m.id)).toEqual(["2"]); // cancelled left out
    const rows = bomRows(got);
    expect(rows[0]).toEqual({ no: "1", qty: "16", size: "", desc: "Stud bolts, B7, 7/8 x 5", status: "Used on the job", used: true });
    expect(rows[1]).toMatchObject({ no: "2", size: "6\"", desc: "Gasket, Spiral wound 316/FG, CL300", status: "Ordered", used: false });
  });
  it("says each line once in the description", () => {
    expect(describeLine({ item: "Gasket", spec: "Gasket, spiral wound" })).toBe("Gasket, spiral wound");
    expect(describeLine({ item: "Gasket", spec: "" })).toBe("Gasket");
  });
  it("knows when the register changed after the package was printed", () => {
    const after = [line("9", { updatedAt: Date.parse("2026-11-25T12:00:00Z") }), line("8", { updatedAt: Date.parse("2026-11-20T12:00:00Z") })];
    expect(changedSince(after, "2026-11-22T00:00:00Z").map((m) => m.id)).toEqual(["9"]);
    expect(changedSince(after, null)).toEqual([]);
  });
  it("reads a filled BOM's rows back as register lines: new ones added, matching ones updated", () => {
    expect(splitDescription("Gasket, spiral wound 316")).toEqual({ item: "Gasket", spec: "spiral wound 316" });
    const plan = planImport([
      { no: "1", qty: "16", size: "", desc: "Stud bolts, B7, 7/8 x 5" },          // there already, same
      { no: "2", qty: "3", size: "6\"", desc: "Gasket, Spiral wound 316/FG, CL300" }, // there, qty and no. changed
      { no: "3", qty: "1", size: "", desc: "Pass partition gasket" },              // new
    ], bomLinesFor(reg, ["301470"]));
    expect(plan.same).toBe(1);
    expect(plan.change).toHaveLength(1);
    expect(plan.change[0]).toMatchObject({ qty: "3", lineNo: 2 });
    expect(plan.add.map((a) => a.item)).toEqual(["Pass partition gasket"]);
  });
});

/** A sheet like the owner's: rows of No., QTY, SIZE, DESCRIPTION boxes with
 *  made-up names, or the app's own names; `n` rows. */
async function sheet(n: number, named: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  const cols: Array<[string, number, number]> = [["no", 89, 25], ["qty", 117, 33], ["size", 153, 42], ["desc", 198, 321]];
  if (named) for (const h of ["wo", "equipment"]) form.createTextField(h).addToPage(page, { x: h === "wo" ? 60 : 300, y: 700, width: 200, height: 14, font });
  for (let r = 0; r < n; r++) {
    cols.forEach(([c, x, w], i) => form.createTextField(named ? `${c}_${r + 1}` : `Text${r * 4 + i}`).addToPage(page, { x, y: 616 - r * 20, width: w, height: 17, font }));
    if (named) form.createCheckBox(`used_${r + 1}`).addToPage(page, { x: 530, y: 619 - r * 20, width: 11, height: 11 });
  }
  return doc.save();
}

describe("the BOM sheet, filled and read", () => {
  it("finds the rows on the owner's own sheet by where the boxes sit", async () => {
    const l = bomLayoutOf((await PDFDocument.load(await sheet(30, false))).getForm());
    expect(l?.rows).toHaveLength(30);
    expect(l?.rows[0]).toEqual({ no: "Text0", qty: "Text1", size: "Text2", desc: "Text3" });
  });
  it("fills as many copies as the lines need, flattened, and reads a typed one back", async () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({ no: String(i + 1), qty: "2", size: "1\"", desc: `Line ${i + 1}`, status: "Ordered", used: i === 0 }));
    const out = await fillBom(await sheet(26, true), { wo: "301470", equipment: "X-2" }, rows);
    expect(out?.pages).toBe(2);
    const filled = await PDFDocument.load(out!.bytes);
    expect(filled.getPageCount()).toBe(2);
    expect(filled.getForm().getFields()).toHaveLength(0);        // nothing left to type into
    expect(await fillBom(await sheet(2, false), {}, [])).toBeNull(); // two unnamed rows aren't a table

    const typed = await PDFDocument.load(await sheet(26, true));
    const f = typed.getForm();
    f.getTextField("wo").setText("WO 301470");
    f.getTextField("desc_1").setText("Gasket, spiral wound");
    f.getTextField("qty_1").setText("2");
    f.getTextField("size_1").setText("6\"");
    const back = await readBom(await typed.save());
    expect(back?.header.wo).toBe("WO 301470");
    expect(back?.rows).toEqual([{ no: "", qty: "2", size: "6\"", desc: "Gasket, spiral wound" }]);
  });
});
