import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import {
  PDFDocument, PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream, degrees,
} from "pdf-lib";
import {
  assemblePackage, pageCount, suggestFileName, type PackMeta, type PackPart,
} from "@/lib/packagePdf";

// ─── Fixtures, built here so the test needs no files ────────────────────

async function makePdf(sizes: Array<[number, number]>, rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  sizes.forEach(([w, h], i) => {
    const page = doc.addPage([w, h]);
    page.drawText(`Sheet ${i + 1}`, { x: 40, y: h - 60, size: 20, font });
    if (rotate) page.setRotation(degrees(rotate));
  });
  return doc.save();
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A plain gray RGB PNG, w x h. */
function makePng(w: number, h: number): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 3)).fill(0x80);
  for (let r = 0; r < h; r += 1) raw[r * (1 + w * 3)] = 0; // filter: none
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...Buffer.from(type, "latin1"), ...data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.set(body, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Just enough JPEG for pdf-lib (SOI, EXIF orientation, SOF0, EOI). */
function makeJpeg(w: number, h: number, orientation: number): Uint8Array {
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8,
    0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const app1 = [0xff, 0xe1, 0, exif.length + 2, ...exif];
  const sof = [0xff, 0xc0, 0, 17, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}

const meta: PackMeta = {
  workspace: "Kern Energy",
  project: "Crude Unit Turnaround 2027",
  wos: ["400101", "400102"],
  equipment: "X-1 Overhead Cooler",
  description: "Open channel heads, hydroblast tubes, hydro test, close with new gaskets.",
  printedAt: new Date("2026-11-25T22:30:00Z"),
  timeZone: "America/Los_Angeles",
  landingUrl: "https://example.com/p/abc123",
  status: "Draft",
};

const pdfPart = (id: string, title: string, bytes: Uint8Array, kind: PackPart["kind"] = "drawing", extra: Partial<PackPart> = {}): PackPart =>
  ({ id, title, kind, bytes, mime: "application/pdf", ...extra });

// ─── Reading the result back ────────────────────────────────────────────

const hex = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();

function streamText(doc: PDFDocument, obj: unknown): string {
  const s = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  if (!(s instanceof PDFRawStream)) return "";
  try {
    return Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  } catch {
    return "";
  }
}

/** Everything drawn on a page (its content streams), hex text uppercased. */
function pageText(doc: PDFDocument, index: number): string {
  const contents = doc.getPage(index).node.Contents();
  const parts = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return parts.map((p) => streamText(doc, p)).join("\n").toUpperCase();
}

function size(doc: PDFDocument, index: number): [number, number] {
  const { width, height } = doc.getPage(index).getSize();
  return [Math.round(width), Math.round(height)];
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("packagePdf", () => {
  it("puts cover, contents and parts in order with the right start pages and footers", async () => {
    const one = await makePdf([[612, 792]]);
    const three = await makePdf([[612, 792], [612, 792], [612, 792]]);
    const big = await makePdf([[1224, 792]]);
    const parts: PackPart[] = [
      pdfPart("it_1", "Exchanger closure", one, "form", { qr: "pkgform:400101:it_1" }),
      pdfPart("it_2", "P&ID 5602-D 1000 rev 11", three),
      pdfPart("it_3", "General arrangement 11x17", big),
      { id: "it_4", title: "Photo: channel head", kind: "photo", bytes: makePng(40, 20), mime: "image/png" },
      { id: "it_5", title: "Photo: tube sheet", kind: "photo", bytes: makeJpeg(40, 20, 6), mime: "image/jpeg" },
      pdfPart("it_6", "Hydro test sheet", one, "form", { signed: true }),
    ];
    const res = await assemblePackage(meta, parts);
    const doc = await PDFDocument.load(res.pdf);

    // 1 cover + 1 contents + 1 + 3 + 1 + 1 + 1 + 1
    expect(res.pages).toBe(10);
    expect(doc.getPageCount()).toBe(10);
    expect(res.toc.map((t) => [t.id, t.page, t.pages])).toEqual([
      ["it_1", 3, 1], ["it_2", 4, 3], ["it_3", 7, 1], ["it_4", 8, 1], ["it_5", 9, 1], ["it_6", 10, 1],
    ]);

    expect(size(doc, 0)).toEqual([612, 792]);           // generated cover
    expect(size(doc, 6)).toEqual([1224, 792]);          // the 11x17 sheet, where the contents says
    expect(size(doc, 7)).toEqual([792, 612]);           // wide PNG: landscape letter
    expect(size(doc, 8)).toEqual([612, 792]);           // JPEG stored wide, EXIF says turn it: portrait

    const cover = pageText(doc, 0);
    expect(cover).toContain(hex("Work package"));
    expect(cover).toContain(hex("WO 400101, 400102"));
    expect(cover).toContain(hex("Nov 25, 2026 2:30 PM"));
    expect(cover).toContain(hex("6 items, 10 pages"));
    expect(cover).toContain(hex("Scan for this package"));

    const contents = pageText(doc, 1);
    expect(contents).toContain(hex("Contents"));
    expect(contents).toContain(hex("(signed)"));
    expect(contents).toContain(hex("Page 2 of 10"));

    const p5 = pageText(doc, 4);
    expect(p5).toContain(hex("Page 5 of 10"));
    expect(p5).toContain(hex("P&ID 5602-D 1000 rev 11"));
    expect(p5).toContain(hex("WO 400101, 400102 · X-1 Overhead Cooler"));
    expect(pageText(doc, 6)).toContain(hex("Page 7 of 10"));
    expect(pageText(doc, 0)).not.toContain(hex("Page 1 of 10"));   // no footer on the cover
  });

  it("puts the footer on the seen bottom of a rotated page", async () => {
    const rotated = await makePdf([[612, 792]], 90);
    const res = await assemblePackage(meta, [pdfPart("r", "Rotated sheet", rotated)]);
    const doc = await PDFDocument.load(res.pdf);
    const text = pageText(doc, 2);
    expect(text).toContain(hex("Page 3 of 3"));
    expect(text).toMatch(/0 1 -1 0 612 0 CM/);
  });

  it("counts pages", async () => {
    expect(await pageCount(await makePdf([[612, 792], [612, 792], [612, 792]]), "application/pdf")).toBe(3);
    expect(await pageCount(makePng(2, 2), "image/png")).toBe(1);
    expect(await pageCount(new Uint8Array([1, 2, 3, 4, 5]), "application/pdf")).toBe(1);
  });

  it("suggests a safe file name", () => {
    expect(suggestFileName({ wos: ["400101", "400102"], equipment: "X-1 Overhead Cooler" }))
      .toBe("WO 400101, 400102 - X-1 Overhead Cooler.pdf");
    expect(suggestFileName({ wos: ["400101"], equipment: "P-101A/B  \"Feed\" pumps: east?" }))
      .toBe("WO 400101 - P-101A B Feed pumps east.pdf");
    expect(suggestFileName({ wos: [], equipment: "" })).toBe("Work package.pdf");
    const long = suggestFileName({ wos: Array.from({ length: 40 }, (_, i) => String(400100 + i)), equipment: "X-1" });
    expect(long.length).toBeLessThanOrEqual(150);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("swaps an unreadable or locked file for one placeholder page and keeps going", async () => {
    const junk = new Uint8Array(4096).map((_, i) => (i * 7919 + 13) % 251);
    const lockedDoc = await PDFDocument.create();
    lockedDoc.addPage([612, 792]);
    lockedDoc.context.trailerInfo.Encrypt = lockedDoc.context.obj({ Filter: "Standard", V: 1, R: 2 });
    const locked = await lockedDoc.save({ useObjectStreams: false });
    const good = await makePdf([[612, 792], [612, 792]]);
    const res = await assemblePackage(meta, [
      pdfPart("bad", "Flange log", junk, "form", { qr: "pkgform:400101:bad" }),
      pdfPart("lock", "Vendor datasheet", locked, "file"),
      pdfPart("ok", "Drawing", good),
    ]);
    const doc = await PDFDocument.load(res.pdf);
    expect(res.pages).toBe(1 + 1 + 1 + 1 + 2);
    expect(res.toc.map((t) => [t.page, t.pages])).toEqual([[3, 1], [4, 1], [5, 2]]);
    expect(pageText(doc, 2)).toContain(hex("This file couldn't be added: Flange log."));
    expect(pageText(doc, 2)).toContain(hex("Add it again."));
    expect(pageText(doc, 3)).toContain(hex("It has a password."));
    expect(pageText(doc, 1)).toContain(hex("(couldn't be added)"));
  });

  it("fills a cover template's fields by name and flattens them", async () => {
    const tpl = await PDFDocument.create();
    const page = tpl.addPage([600, 800]);
    const form = tpl.getForm();
    form.createTextField("Work Order No").addToPage(page, { x: 60, y: 700, width: 200, height: 24 });
    form.createTextField("Equipment Tag").addToPage(page, { x: 60, y: 660, width: 300, height: 24 });
    form.createTextField("Inspector").addToPage(page, { x: 60, y: 620, width: 200, height: 24 });
    const scope = form.createTextField("Scope of work");
    scope.enableMultiline();
    scope.addToPage(page, { x: 60, y: 480, width: 420, height: 120 });
    const bytes = await tpl.save();

    const res = await assemblePackage(meta, [pdfPart("a", "Exchanger closure", await makePdf([[612, 792]]), "form")], {
      cover: { bytes },
    });
    const doc = await PDFDocument.load(res.pdf);
    expect(res.pages).toBe(3);
    expect(size(doc, 0)).toEqual([600, 800]);   // the workspace's own cover, not the generated one

    const cover = doc.getPage(0);
    const annots = cover.node.Annots();
    const subtypes = (annots?.asArray() ?? []).map((r) => String((doc.context.lookup(r) as PDFDict).get(PDFName.of("Subtype"))));
    expect(subtypes.filter((t) => t === "/Widget")).toHaveLength(0); // flattened: no fields left
    // The package's QR opens its page when the file is read on a computer.
    if (meta.landingUrl) expect(subtypes).toContain("/Link");
    expect(doc.catalog.get(PDFName.of("AcroForm"))).toBeUndefined();

    // The filled values are now drawn on the page (flattened field art).
    const xobjects = cover.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    const drawn = (xobjects?.entries() ?? [])
      .filter(([name]) => name.asString().startsWith("/FlatWidget"))
      .map(([, ref]) => streamText(doc, ref).toUpperCase())
      .join("\n");
    expect(drawn).toContain(hex("400101, 400102"));
    expect(drawn).toContain(hex("X-1 Overhead Cooler"));
    // The multi-line scope box gets a readable size, not pdf-lib's auto size.
    expect(drawn).toContain(hex("Open channel heads"));
    expect(drawn).toMatch(/ 10 TF/);
  });

  it("prints names with characters the standard font lacks", async () => {
    const res = await assemblePackage(
      { ...meta, equipment: "X-1 Cooler \u2192 East \u{1F4F7} \u03A9", wos: ["WO 400101"] },
      [pdfPart("a", "Photo: Caf\u00e9 \u{1F527} \u0151 \u65E5", await makePdf([[612, 792]]))],
    );
    const doc = await PDFDocument.load(res.pdf);
    const text = pageText(doc, 2);
    expect(text).toContain(hex("WO 400101 \u00b7 X-1 Cooler -> East Ohm"));
    expect(text).toContain(hex("Photo: Caf\u00e9 o ?"));
  });

  it("uses a contents template and repeats it when rows don't fit", async () => {
    const tocTpl = await makePdf([[612, 792]]);
    const one = await makePdf([[612, 792]]);
    const parts = Array.from({ length: 30 }, (_, i) => pdfPart(`p${i}`, `Item ${i + 1}`, one, "form"));
    const res = await assemblePackage(meta, parts, { toc: { bytes: tocTpl } });
    // Default region on letter is 550 pt tall: 22 header + 24 rows of 22.
    expect(res.toc[0].page).toBe(4);
    expect(res.pages).toBe(1 + 2 + 30);
    const doc = await PDFDocument.load(res.pdf);
    expect(pageText(doc, 1)).toContain(hex("Sheet 1"));        // template is the background
    expect(pageText(doc, 2)).toContain(hex("Sheet 1"));        // and repeats
    expect(pageText(doc, 2)).toContain(hex("Item 30"));
    // Copies of one template page don't share what's drawn on them.
    expect(pageText(doc, 1)).not.toContain(hex("Item 30"));
    expect(pageText(doc, 1)).not.toContain(hex("Page 3 of 33"));
  });

  it("runs a long list onto a second contents page and the numbers still line up", async () => {
    const one = await makePdf([[612, 792]]);
    const two = await makePdf([[612, 792], [612, 792]]);
    const parts = Array.from({ length: 40 }, (_, i) =>
      pdfPart(`p${i}`, i === 5 ? `Very long drawing title ${"with many words ".repeat(12)}end` : `Item ${i + 1}`, i % 3 === 0 ? two : one));
    const res = await assemblePackage(meta, parts);
    const doc = await PDFDocument.load(res.pdf);
    const partPages = parts.reduce((n, _, i) => n + (i % 3 === 0 ? 2 : 1), 0);
    expect(res.pages).toBe(1 + 2 + partPages);
    expect(doc.getPageCount()).toBe(res.pages);
    expect(res.toc[0].page).toBe(4);
    for (let i = 1; i < res.toc.length; i += 1) {
      expect(res.toc[i].page).toBe(res.toc[i - 1].page + res.toc[i - 1].pages);
    }
    const last = res.toc[res.toc.length - 1];
    expect(last.page + last.pages - 1).toBe(res.pages);
    expect(pageText(doc, 2)).toContain(hex("Contents (continued)"));
    // Each part's first page says it is that part, on that page.
    for (const t of [res.toc[0], res.toc[20], last]) {
      const text = pageText(doc, t.page - 1);
      expect(text).toContain(hex(`Page ${t.page} of ${res.pages}`));
      expect(text).toContain(hex(t.title));
    }
  });

  it("writes a form's fills where the kit says: on the smaller form with its code, as is without one, never on a signed copy", async () => {
    const fields = [
      { key: "wo" as const, x: 120, y: 700, size: 10 },
      { key: "equipment" as const, x: 120, y: 680, size: 10 },
      { key: "date" as const, x: 400, y: 700, size: 10, page: 1 },
      { key: "by" as const, x: 400, y: 660, size: 10 },
    ];
    const res = await assemblePackage({ ...meta, preparedBy: "planner@kern.test" }, [
      pdfPart("a", "Flange log", await makePdf([[612, 792], [612, 792]]), "form", { fields, qr: "pkgform:400101:it_a" }),
      pdfPart("b", "Hydro test", await makePdf([[612, 792]]), "form", { fields }),
      pdfPart("c", "Closure, signed", await makePdf([[612, 792]]), "form", { fields, signed: true }),
    ]);
    const doc = await PDFDocument.load(res.pdf);
    const start = (id: string) => res.toc.find((t) => t.id === id)!.page - 1;
    // (The footer on every page already says the WO and equipment, so the
    // fills are told apart by "printed by", the date and where they sit.)
    const a1 = pageText(doc, start("a"));
    expect(a1).toContain(hex("planner@kern.test"));
    expect(a1).not.toContain(hex("Nov 25, 2026"));       // the date was set for page 2
    const a2 = pageText(doc, start("a") + 1);
    expect(a2).toContain(hex("Nov 25, 2026"));
    expect(a2).not.toContain(hex("planner@kern.test"));
    // Without a code the form is as it is: the WO sits exactly where it was set.
    const b1 = pageText(doc, start("b"));
    expect(b1).toContain(hex("planner@kern.test"));
    expect(b1).toMatch(/1 0 0 1 120 700 TM/);
    expect(pageText(doc, start("c"))).not.toContain(hex("planner@kern.test"));
  });

  it("writes the contents under a page's own column headings, without adding its own", async () => {
    const tpl = await makePdf([[612, 792]]);
    const parts = [pdfPart("a", "Flange log", await makePdf([[612, 792]]), "form"), pdfPart("b", "P&ID 3102-D", await makePdf([[612, 792]]))];
    const own = await assemblePackage(meta, parts, { toc: { bytes: tpl, region: { x: 52, y: 54, w: 524, h: 600, cols: { no: 54, item: 110, pageR: 540 } } } });
    const t = pageText(await PDFDocument.load(own.pdf), 1);
    expect(t).toContain(hex("Flange log"));
    expect(t).not.toContain(hex("Kind"));     // no heading row of the app's
    expect(t).toMatch(/1 0 0 1 110 \d+(\.\d+)? TM/);   // titles under "Description"
    const plainToc = await assemblePackage(meta, parts, { toc: { bytes: tpl, region: { x: 52, y: 54, w: 524, h: 600 } } });
    expect(pageText(await PDFDocument.load(plainToc.pdf), 1)).toContain(hex("Kind"));
  });
});
