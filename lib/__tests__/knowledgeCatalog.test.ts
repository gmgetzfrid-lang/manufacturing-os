// Tests for the library catalog (profiles, forms, catalog entries), goal
// detection in answers, and putting values onto real PDF forms.

import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  normalizeProfile, parseProfile, buildCatalogBlock, formsForGoal, matchCatalogName,
  findClassMentions, entryFacts, parseModelJson, type CatalogEntry, type DocProfile,
} from "../knowledgeCatalog";
import { extractAnswerMeta } from "../knowledgeText";
import { fillAcroForm, buildCompletedForm, toWinAnsi } from "../formFill";
import { readPdfFormFields } from "../knowledgeCatalogServer";

const entry = (name: string, profile: Partial<DocProfile>): CatalogEntry => ({
  documentId: name, libraryId: "lib", libraryName: "E2G", name, fileKey: `k/${name}`,
  profile: { v: 1, type: "other", designation: null, title: name, purpose: "", covers: [], references: [], profiledAt: "t", ...profile } as DocProfile,
});

describe("normalizeProfile", () => {
  it("cleans model output and keeps a form's fields in order", () => {
    const p = normalizeProfile(parseModelJson('```json\n{"type":"form","designation":"F-12","title":"Deviation Request","purpose":"Request an exception to an EP.","form":{"purpose":"deviation","fields":[{"name":"Requirement","label":"Requirement deviated from","kind":"long"},{"name":"Requirement","label":"Duplicate name","kind":"bogus"}]}}\n```'), { name: "dev.pdf" });
    expect(p.type).toBe("form");
    expect(p.form?.purpose).toBe("deviation");
    expect(p.form?.fillable).toBe(false);
    expect(p.form?.fields.map((f) => f.kind)).toEqual(["long", "text"]);
    expect(new Set(p.form?.fields.map((f) => f.name)).size).toBe(2);
  });

  it("lets the PDF's own field names win over model-listed ones", () => {
    const p = normalizeProfile({ type: "form", form: { purpose: "ncr", fields: [{ name: "txtJust", label: "Justification", kind: "long" }] } },
      { name: "ncr.pdf", pdfFields: [{ name: "txtJust", kind: "text" }, { name: "chkApproved", kind: "check" }] });
    expect(p.form?.fillable).toBe(true);
    expect(p.form?.fields).toEqual([
      { name: "txtJust", label: "Justification", kind: "long" },
      { name: "chkApproved", label: "chkApproved", kind: "check" },
    ]);
  });

  it("degrades a garbage reply to a safe 'other' profile named after the file", () => {
    const p = normalizeProfile(parseModelJson("sorry, I can't"), { name: "EP-5-2-1.pdf" });
    expect(p.type).toBe("other");
    expect(p.title).toBe("EP-5-2-1");
    expect(parseProfile(JSON.stringify(p))?.title).toBe("EP-5-2-1");
    expect(parseProfile("{not json")).toBeNull();
  });
});

describe("catalog entries", () => {
  it("a profile guessed as a piping spec by an older version is an ordinary document again", () => {
    const old = JSON.stringify({ v: 1, type: "pipe_spec", designation: null, title: "Specs", purpose: "", covers: [], references: [], profiledAt: "x", pipeSpec: { classes: 3 } });
    const p = parseProfile(old)!;
    expect(p.type).toBe("other");
    expect((p as unknown as { pipeSpec?: unknown }).pipeSpec).toBeUndefined();
  });

  it("spots class codes in conversation, guarding short codes", () => {
    expect(findClassMentions("is welded ok in line class 1s4?", ["1S4", "A1A"])).toEqual(["1S4"]);
    expect(findClassMentions("the B2 report", ["B2"])).toEqual([]);
    expect(findClassMentions("class B2 piping", ["B2"])).toEqual(["B2"]);
    expect(findClassMentions("21S45 pump", ["1S4"])).toEqual([]);
  });

  it("renders trusted facts with the catalog's name, document and page", () => {
    const facts = entryFacts([{ code: "1S4", catalog: "Valve sheets", service: "Sour water", rating: "Class 150", attrs: { Body: "WCB" }, documentName: "PS-100", page: 12 }]);
    expect(facts).toContain("VALVE SHEETS ENTRY 1S4 - PS-100 p.12; for: Sour water; rating: Class 150; Body: WCB");
  });
});

describe("catalog", () => {
  const entries = [
    entry("EP-5-2-1.pdf", { type: "standard", designation: "EP 5-2-1", title: "Selection of Piping Components" }),
    entry("Deviation Request Form.pdf", { type: "form", title: "Engineering Deviation Request", form: { purpose: "deviation", fillable: true, fields: [] } }),
    entry("Hydrotest Checklist.pdf", { type: "checklist", title: "Hydrostatic Test Checklist", checklistFor: "hydrotest of piping", form: { purpose: "test", fillable: false, fields: [] } }),
  ];

  it("lists forms and checklists first", () => {
    const block = buildCatalogBlock(entries);
    expect(block.indexOf("Forms (1)")).toBeLessThan(block.indexOf("Engineering standards (1)"));
    expect(block).toContain('"Deviation Request Form": Engineering Deviation Request - Deviation / waiver request, fillable PDF');
    expect(block).toContain("for hydrotest of piping");
  });

  it("finds the form for a goal and resolves names the model wrote", () => {
    expect(formsForGoal(entries, "deviation")[0].name).toBe("Deviation Request Form.pdf");
    expect(formsForGoal(entries, "moc")).toEqual([]);
    expect(matchCatalogName(entries, "the Hydrotest Checklist")?.name).toBe("Hydrotest Checklist.pdf");
    expect(matchCatalogName(entries, "Engineering Deviation Request")?.name).toBe("Deviation Request Form.pdf");
    expect(matchCatalogName(entries, "Made-up Form")).toBeNull();
  });
});

describe("goal detection in answers", () => {
  it("reads Heading toward and Use this lines and strips them", () => {
    const m = extractAnswerMeta([
      "**Mode:** deviation",
      "**Heading toward:** deviation - wants slip-on flanges on elbows despite EP 5-2-2 §4.3",
      "**Use this:** \"Deviation Request Form\" - to request the exception formally",
      "**Answer:** NOT SETTLED - the reason for the rule depends on cyclic service [2].",
    ].join("\n"));
    expect(m.mode).toBe("deviation");
    expect(m.goal).toEqual({ kind: "deviation", why: "wants slip-on flanges on elbows despite EP 5-2-2 §4.3" });
    expect(m.useThis).toEqual([{ name: "Deviation Request Form", why: "to request the exception formally" }]);
    expect(m.answer.startsWith("**Answer:**")).toBe(true);
  });

  it("ignores a goal it doesn't know", () => {
    expect(extractAnswerMeta("**Heading toward:** vacation - sure\n**Answer:** YES - ok [1].").goal).toBeNull();
  });
});

describe("filling PDFs", () => {
  async function fillablePdf(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const form = pdf.getForm();
    const t = form.createTextField("Justification");
    t.addToPage(page, { x: 50, y: 600, width: 500, height: 100 });
    const c = form.createCheckBox("SafetyReview");
    c.addToPage(page, { x: 50, y: 560, width: 12, height: 12 });
    const d = form.createDropdown("Discipline");
    d.addOptions(["Piping", "Mechanical"]);
    d.addToPage(page, { x: 50, y: 520, width: 150, height: 20 });
    return pdf.save();
  }

  it("reads a fillable form's fields", async () => {
    const fields = await readPdfFormFields(await fillablePdf());
    expect(fields).toEqual([
      { name: "Justification", kind: "text" },
      { name: "SafetyReview", kind: "check" },
      { name: "Discipline", kind: "choice", options: ["Piping", "Mechanical"] },
    ]);
  });

  it("fills fields in place, keeps them editable, and reports a bad choice", async () => {
    const { bytes, skipped } = await fillAcroForm(await fillablePdf(), {
      Justification: "Slip-on → elbow fit-up ≥ ok per EP 5-2-2 §4.3",
      SafetyReview: "Yes",
      Discipline: "Electrical",
    });
    expect(skipped).toEqual(["Discipline"]);
    const form = (await PDFDocument.load(bytes)).getForm();
    expect(form.getTextField("Justification").getText()).toBe("Slip-on -> elbow fit-up >= ok per EP 5-2-2 §4.3");
    expect(form.getCheckBox("SafetyReview").isChecked()).toBe(true);
  });

  it("builds completed pages for a flat form, then appends the original", async () => {
    const original = await PDFDocument.create();
    const font = await original.embedFont(StandardFonts.Helvetica);
    original.addPage([612, 792]).drawText("DEVIATION REQUEST", { x: 50, y: 700, font, size: 14 });
    const bytes = await buildCompletedForm({
      original: await original.save(), title: "Deviation Request", sourceName: "dev.pdf", preparedBy: "GG",
      fields: [{ name: "just", label: "Justification", kind: "long" }, { name: "ok", label: "Reviewed", kind: "check" }],
      values: { just: "Long reason. ".repeat(600), ok: "" },
    });
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBeGreaterThanOrEqual(3); // completed pages flow + original
  });

  it("maps characters the standard font can't draw", () => {
    expect(toWinAnsi("H₂S ≤ 50 ppm → ok “quoted” 200°F")).toBe("H2S <= 50 ppm -> ok “quoted” 200°F");
    expect(toWinAnsi("中")).toBe("?");
  });
});
