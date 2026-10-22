// drafting-flow Round G, DF-P25 — the DF-P23 follow-ups (b) and (c) on the
// deliverable stamp (DEC-90 ruling (4) for DF-P25):
//   (b) the declaration's diacritic fold is no longer silent: each letter it
//       printed in a plain form rides the plan (plainCharacters) into the
//       stamper (StampOptions.plainCharacters), so the copy's "Printed in
//       plain characters" note (PHYS-15) names it;
//   (c) the Latin letters canonical decomposition leaves whole (ı ħ Ħ ŧ Ŧ ŀ
//       Ŀ ĸ) are folded, so such a name prints folded rather than as the
//       "not printable" note.
// Encodable text is byte-identical: no mapping, the same footer, the same
// stamp note (pinned).

import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { ticketCopyPlan, declarationFooterClause, foldForStamp, foldForStampMapped, type TicketCopyDeclaration } from "@/lib/ticketDeliverableCopy";
import { applyStampToPdfDoc, stampTextNote } from "@/lib/stamping";

const at = "2026-10-01T09:00:00Z";
const decl = (by: string | null, statement: string | null): TicketCopyDeclaration => ({ by, declaredAt: at, statement });
const planOf = (d: TicketCopyDeclaration, type = "Final") => ticketCopyPlan({
  file: { type, rev: "1", id: "f1" }, ticketNumber: "KE-1", ticketRowId: "t1", origin: "https://plant.test", channel: "print",
  live: { status: "CLOSED", deliverableRev: "1", history: [], declaration: d },
});

async function stampNote(footerNotice: string, plainCharacters?: ReadonlyArray<{ char: string; codePoint: string; printedAs: string }>) {
  const doc = await PDFDocument.create();
  doc.addPage([600, 400]);
  const r = await applyStampToPdfDoc(doc, { controlState: "uncontrolled", footerNotice, verifyUrl: undefined, ...(plainCharacters ? { plainCharacters } : {}) });
  return { mapped: r.mapped, note: stampTextNote(r.mapped) };
}

describe("DF-P25 (b) — a folded declaration says it was simplified", () => {
  it("the plan names each folded letter once; the stamp's note names it", async () => {
    const plan = planOf(decl("Łukasz Dvořák", "Identical gasket — same rating, Łódź spec"));
    expect(plan.footerNotice).toContain("Lukasz Dvorák");
    expect(plan.footerNotice).toContain('"Identical gasket - same rating, Lódz spec"');
    expect(plan.plainCharacters).toEqual([
      { char: "Ł", codePoint: "U+0141", printedAs: "L" },
      { char: "ř", codePoint: "U+0159", printedAs: "r" },
      { char: "ź", codePoint: "U+017A", printedAs: "z" },
    ]);
    const { note } = await stampNote(plan.footerNotice, plan.plainCharacters);
    expect(note).toBe('Printed in plain characters: U+0141 as "L", U+0159 as "r", U+017A as "z".');
  });

  it("the stamper's own replacements come first; a character named by both is named once", async () => {
    const r = await stampNote("This file is KE-1‐A — Łukasz", [{ char: "Ł", codePoint: "U+0141", printedAs: "L" }]);
    expect(r.note).toBe('Printed in plain characters: U+2010 as "-", U+0141 as "?".');
  });

  it("a Draft carries no declaration and no mapping", () => {
    expect(planOf(decl("Łukasz", "x"), "Draft").plainCharacters).toEqual([]);
  });
});

describe("DF-P25 (c) — the Latin letters NFD does not decompose are folded", () => {
  it.each([
    ["Yıldız", "Yildiz", [["ı", "U+0131", "i"]]],
    ["Ħamrun ħ", "Hamrun h", [["Ħ", "U+0126", "H"], ["ħ", "U+0127", "h"]]],
    ["Ŧomas ŧ", "Tomas t", [["Ŧ", "U+0166", "T"], ["ŧ", "U+0167", "t"]]],
    ["ĸalaallisut", "kalaallisut", [["ĸ", "U+0138", "k"]]],
  ])("%s → %s, named", (input, out, maps) => {
    expect(foldForStamp(input)).toBe(out);
    expect(foldForStampMapped(input).mapped.map((m) => [m.char, m.codePoint, m.printedAs])).toEqual(maps);
    const clause = declarationFooterClause(decl(input, "Identical gasket"), "KE-1");
    expect(clause).toBe(` (declared like-in-kind by ${out} on 2026-10-01: "Identical gasket")`);
    expect(clause).not.toContain("not printable");
  });

  it("ŀ / Ŀ fold to l / L, but the stamper already prints them by their compatibility form (L·), so the clause keeps them as typed and the stamper's own note names them", async () => {
    expect(foldForStampMapped("Ŀluís paŀla").mapped.map((m) => [m.char, m.codePoint, m.printedAs])).toEqual([["Ŀ", "U+013F", "L"], ["ŀ", "U+0140", "l"]]);
    const plan = planOf(decl("Ŀluís paŀla", "Identical gasket"));
    expect(plan.footerNotice).toContain("by Ŀluís paŀla on");
    expect(plan.plainCharacters).toEqual([]);
    const { note } = await stampNote(plan.footerNotice, plan.plainCharacters);
    expect(note).toBe('Printed in plain characters: U+013F as "L\u00B7", U+0140 as "l\u00B7".');
  });

  it("a non-Latin part still takes the note (Cyrillic, CJK) and maps nothing", () => {
    const plan = planOf(decl("王伟", "Замена прокладки"));
    expect(plan.footerNotice).toContain("[name not printable in this stamp - see request KE-1]");
    expect(plan.footerNotice).toContain("[statement not printable in this stamp - see request KE-1]");
    expect(plan.plainCharacters).toEqual([]);
  });
});

describe("REGRESSION — encodable text is byte-identical", () => {
  it("a declaration the font prints as typed: same clause, no mapping, the stamp's note unchanged", async () => {
    const plan = planOf(decl("Pat O'Neil", "Identical gasket, same rating — Øystein Straße é"));
    expect(plan.plainCharacters).toEqual([]);
    expect(plan.footerNotice).toBe(
      "This file is KE-1 (declared like-in-kind by Pat O'Neil on 2026-10-01: \"Identical gasket, same rating - Øystein Straße é\") deliverable Rev 1 — not a controlled document revision — scan the QR to confirm it is still the latest.",
    );
    const without = await stampNote(plan.footerNotice);
    const withEmpty = await stampNote(plan.footerNotice, plan.plainCharacters);
    expect(withEmpty).toEqual(without);
  });
  it("no declaration: the plan is as before, with an empty mapping", () => {
    const plan = ticketCopyPlan({ file: { type: "Final", rev: "2", id: "f" }, ticketNumber: "KE-9", ticketRowId: "t9", origin: "https://plant.test", channel: "download" });
    expect(plan.plainCharacters).toEqual([]);
    expect(plan.footerNotice).toBe("This file is KE-9 deliverable Rev 2 — not a controlled document revision — scan the QR to confirm it is still the latest.");
  });
});
