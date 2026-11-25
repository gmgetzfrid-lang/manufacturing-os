import { describe, it, expect } from "vitest";
import { findLabels, findListArea, fillsFrom, labelKey, type PageText, type TextBit } from "@/lib/formLabels";

const bit = (str: string, x: number, y: number, h = 10): TextBit => ({ str, x, y, w: str.length * h * 0.5, h });

describe("reading a blank sheet's labels", () => {
  it("knows the labels it can fill, however they're written", () => {
    expect(labelKey("W/O No.:")).toBe("wo");
    expect(labelKey("Work Order #")).toBe("wo");
    expect(labelKey("WO#:")).toBe("wo");
    expect(labelKey("Equipment Tag:")).toBe("equipment");
    expect(labelKey("Equip. No.")).toBe("equipment");
    expect(labelKey("Scope of Work:")).toBe("description");
    expect(labelKey("Turnaround:")).toBe("project");
    expect(labelKey("Date Issued:")).toBe("date");
    expect(labelKey("Prepared By:")).toBe("by");
    expect(labelKey("Company:")).toBe("workspace");
    // Not labels it fills: a signature line, a sentence.
    expect(labelKey("Inspector Signature:")).toBeNull();
    expect(labelKey("Work order closed out after the hydro test passed")).toBeNull();
  });

  it("finds each label, puts the value on its blank line, and turns on only the heading's", () => {
    const page: PageText = { width: 612, height: 792, bits: [
      bit("FLANGE LOG", 230, 750, 16),
      // "Work Order No.:" split into three bits, then a blank line.
      bit("Work", 40, 710), bit("Order", 66, 710), bit("No.:", 96, 710), bit("______________", 120, 710),
      // A label and its blank line in one bit.
      bit("Equipment: ____________", 330, 710),
      bit("Date:", 40, 690), bit("__________", 70, 690),
      // A table's column headings: no colon, so not filled by default.
      bit("Flange", 40, 600), bit("Bolt size", 120, 600), bit("Date", 220, 600), bit("Torque", 300, 600),
      // A date by a signature, low on the page.
      bit("Inspector Signature:", 40, 120), bit("Date:", 300, 120), bit("________", 330, 120),
    ] };
    const found = findLabels([page]);
    const wo = found.find((f) => f.key === "wo")!;
    expect(wo.text).toBe("Work Order No.:");
    expect(wo.at.x).toBe(122);                 // on the blank line
    expect(wo.at.maxWidth).toBeGreaterThan(100);
    expect(wo.at.maxWidth).toBeLessThan(330 - 122);   // stops before "Equipment:"
    expect(wo.on).toBe(true);
    const eq = found.find((f) => f.key === "equipment")!;
    expect(eq.text).toBe("Equipment:");
    expect(eq.at.x).toBeGreaterThan(330 + 9 * 5 - 2); // after "Equipment:" inside the same bit
    expect(eq.on).toBe(true);
    const dates = found.filter((f) => f.key === "date");
    expect(dates).toHaveLength(3);
    expect(dates.map((d) => d.on)).toEqual([true, false, false]); // the heading's; not the column, not the signature's
    expect(fillsFrom(found).map((f) => f.key).sort()).toEqual(["date", "equipment", "wo"]);
    expect(fillsFrom(found).find((f) => f.key === "wo")).toMatchObject({ page: 0, label: "Work Order No.:" });
  });

  it("finds nothing on a scan with no words, and a contents page's list area under its headings", () => {
    expect(findLabels([{ width: 612, height: 792, bits: [] }])).toEqual([]);
    const toc: PageText = { width: 612, height: 792, bits: [bit("TABLE OF CONTENTS", 200, 740, 16), bit("Item", 54, 690), bit("Description", 110, 690), bit("Page", 520, 690)] };
    const a = findListArea(toc)!;
    expect(a.x).toBe(52);
    expect(a.y).toBe(54);
    expect(a.y + a.h).toBeLessThan(690);
    expect(a.y + a.h).toBeGreaterThan(670);
    // Its own headings: the rows go under Item, Description and Page.
    expect(a.cols).toEqual({ no: 54, item: 110, pageR: 540 });
    expect(findListArea({ width: 612, height: 792, bits: [bit("Hello", 40, 700)] })).toBeNull();
  });
});
