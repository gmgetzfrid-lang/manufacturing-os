// public-surfaces Round F — PS-STAMP: the stamp on a rotated sheet
// (PHYS-12 = document-control PKG-13), end to end through pdf-lib.
//
// A page with /Rotate is DISPLAYED (and printed) turned clockwise. pdf.js
// measures the ink on the page as displayed; pdf-lib draws in the page's
// unrotated user space. The stamper must lay every mark out in the display
// space the analysis measured and map it into user space, so the verify QR
// lands in the corner the analysis chose, on-page and upright; the footer
// reads left-to-right on the printed sheet; the watermark is centred on and
// fitted to the displayed page; and baked markups land where they were drawn.
//
// Every geometric check below maps user space back to display space with a
// rotation MATRIX written here, independently of lib/stampLayout's mapping.
//
// The ink analysis runs for real (analyzePageInk), against a fake pdf.js
// whose viewport — like the real one — has the display dimensions, and a fake
// canvas whose pixels are dark everywhere except one display-space corner.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFPage, PDFFont, degrees } from "pdf-lib";
import { applyStampToPdfDoc } from "@/lib/stamping";
import { pickQrCorner, fallbackInk, type Corner } from "@/lib/stampLayout";

type Pg = { w: number; h: number; empty: Corner };
const fake = vi.hoisted(() => ({
  pages: [] as Array<{ w: number; h: number; empty: "tl" | "tr" | "bl" | "br" }>,
  current: null as null | { w: number; h: number; empty: "tl" | "tr" | "bl" | "br" },
  dims: [] as Array<{ width: number; height: number }>,
}));

vi.mock("react-pdf", () => ({
  pdfjs: {
    GlobalWorkerOptions: {} as Record<string, unknown>,
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: fake.pages.length,
        getPage: async (n: number) => {
          const pg = fake.pages[n - 1];
          fake.current = pg;
          return {
            // pdf.js applies /Rotate: the viewport is the DISPLAYED page.
            getViewport: ({ scale }: { scale: number }) => ({ width: pg.w * scale, height: pg.h * scale }),
            render: () => ({ promise: Promise.resolve() }),
          };
        },
        destroy: async () => {},
      }),
    }),
  },
}));
vi.mock("@/lib/pdfjsConfig", () => ({ PDFJS_VERBOSITY: 0 }));

// fabric is only needed by the markup bake; a stand-in canvas that records
// the size it was given and returns a 1×1 PNG.
const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
vi.mock("fabric", () => ({
  StaticCanvas: class {
    async loadFromJSON() { /* objects are irrelevant to placement */ }
    setDimensions(d: { width: number; height: number }) { fake.dims.push(d); }
    renderAll() {}
    toDataURL() { return PNG_1PX; }
    dispose() {}
  },
}));

// ─── Independent geometry: user space → display space ─────────────────────
const quarter = (rot: number) => rot % 180 !== 0;
function displayDims(W: number, H: number, rot: number) {
  return quarter(rot) ? { DW: H, DH: W } : { DW: W, DH: H };
}
/** /Rotate turns the page CLOCKWISE for display: rotate about the MediaBox
 *  centre by −rot (clockwise in y-up space), then re-centre on the display. */
function toDisplay(ux: number, uy: number, W: number, H: number, rot: number) {
  const r = (rot * Math.PI) / 180;
  const vx = ux - W / 2, vy = uy - H / 2;
  const dx = vx * Math.cos(r) + vy * Math.sin(r);
  const dy = -vx * Math.sin(r) + vy * Math.cos(r);
  const { DW, DH } = displayDims(W, H, rot);
  return { x: dx + DW / 2, y: dy + DH / 2 };
}
type Box = { minX: number; maxX: number; minY: number; maxY: number };
/** The display-space bounding box of a w×h mark drawn at (x, y) rotated θ. */
function markBox(x: number, y: number, w: number, h: number, thetaDeg: number, W: number, H: number, rot: number): Box {
  const t = (thetaDeg * Math.PI) / 180;
  const u = { x: Math.cos(t) * w, y: Math.sin(t) * w };
  const v = { x: -Math.sin(t) * h, y: Math.cos(t) * h };
  const pts = [
    [x, y], [x + u.x, y + u.y], [x + v.x, y + v.y], [x + u.x + v.x, y + u.y + v.y],
  ].map(([px, py]) => toDisplay(px, py, W, H, rot));
  return {
    minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
  };
}
const displayAngle = (thetaDeg: number, rot: number) => (((thetaDeg - rot) % 360) + 360) % 360;
const inQuadrant = (b: Box, c: Corner, DW: number, DH: number) => {
  const left = c === "tl" || c === "bl";
  const top = c === "tl" || c === "tr";
  return (left ? b.maxX <= DW / 2 : b.minX >= DW / 2) && (top ? b.minY >= DH / 2 : b.maxY <= DH / 2);
};
const onPage = (b: Box, DW: number, DH: number) =>
  b.minX >= -0.01 && b.minY >= -0.01 && b.maxX <= DW + 0.01 && b.maxY <= DH + 0.01;

// ─── Capture what the stamper draws ───────────────────────────────────────
type Call = { kind: "image" | "rect" | "text"; page: PDFPage; text?: string; o: Record<string, unknown> };
let calls: Call[] = [];
function capture() {
  calls = [];
  const proto = PDFPage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const [name, kind] of [["drawImage", "image"], ["drawRectangle", "rect"], ["drawText", "text"]] as const) {
    const orig = proto[name];
    vi.spyOn(proto, name).mockImplementation(function (this: PDFPage, ...args: unknown[]) {
      if (kind === "image") calls.push({ kind, page: this, o: args[1] as Record<string, unknown> });
      else if (kind === "rect") calls.push({ kind, page: this, o: args[0] as Record<string, unknown> });
      else calls.push({ kind, page: this, text: args[0] as string, o: args[1] as Record<string, unknown> });
      return orig.apply(this, args);
    });
  }
}
const angleOf = (o: Record<string, unknown>) => ((o.rotate as { angle?: number } | undefined)?.angle ?? 0);

async function makePdf(pages: Array<{ w: number; h: number; rotate: number }>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const pg = doc.addPage([p.w, p.h]);
    if (p.rotate) pg.setRotation(degrees(p.rotate));
  }
  return doc.save();
}

// A fake DOM canvas whose pixels are dark except the requested display corner.
function stubCanvas() {
  const ctx = {
    fillStyle: "",
    fillRect: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const empty = fake.current!.empty;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const left = x < w * 0.4, right = x >= w * 0.6, top = y < h * 0.35, bottom = y >= h * 0.65;
          const blank =
            (empty === "tl" && left && top) || (empty === "tr" && right && top) ||
            (empty === "bl" && left && bottom) || (empty === "br" && right && bottom);
          const i = (y * w + x) * 4;
          const v = blank ? 255 : 0;
          data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
        }
      }
      return { data };
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  vi.stubGlobal("document", { createElement: () => canvas });
}

const MEDIA = { w: 612, h: 792 }; // a portrait MediaBox — /Rotate 90 / 270 display it landscape
const ROTATIONS = [0, 90, 180, 270] as const;

beforeEach(() => { capture(); fake.pages = []; fake.current = null; fake.dims = []; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PHYS-12 / PKG-13 — the analysis and the drawing share one space on a rotated sheet", () => {
  for (const rot of ROTATIONS) {
    for (const empty of ["tl", "br"] as const) {
      it(`/Rotate ${rot}: the QR lands in the display corner the analysis chose (${empty}), on-page and upright; footer and watermark read on the printed sheet`, async () => {
        stubCanvas();
        const { DW, DH } = displayDims(MEDIA.w, MEDIA.h, rot);
        fake.pages = [{ w: DW, h: DH, empty } satisfies Pg];
        const bytes = await makePdf([{ ...MEDIA, rotate: rot }]);
        const pdfDoc = await PDFDocument.load(bytes);
        await applyStampToPdfDoc(pdfDoc, {
          sourceBytes: bytes,
          userLabel: "qa@example.com",
          timestamp: new Date("2026-10-01T10:00:00Z"),
          watermarkText: "UNCONTROLLED — FOR REVIEW ONLY",
          footerNotice: "2002-D-10001 Rev 4 at time of issue — verify current revision before use.",
          verifyUrl: "https://app.example.com/verify/doc?v=ver",
        });

        // The QR image and its white plate.
        const qr = calls.find((c) => c.kind === "image")!;
        expect(qr).toBeTruthy();
        const qs = qr.o.width as number;
        const qrBox = markBox(qr.o.x as number, qr.o.y as number, qs, qr.o.height as number, angleOf(qr.o), MEDIA.w, MEDIA.h, rot);
        expect(displayAngle(angleOf(qr.o), rot)).toBe(0);
        expect(onPage(qrBox, DW, DH)).toBe(true);
        expect(inQuadrant(qrBox, empty, DW, DH)).toBe(true);
        const plate = calls.find((c) => c.kind === "rect" && c.o.opacity === 0.92)!;
        const plateBox = markBox(plate.o.x as number, plate.o.y as number, plate.o.width as number, plate.o.height as number, angleOf(plate.o), MEDIA.w, MEDIA.h, rot);
        expect(displayAngle(angleOf(plate.o), rot)).toBe(0);
        expect(onPage(plateBox, DW, DH)).toBe(true);
        expect(plateBox.minX).toBeLessThanOrEqual(qrBox.minX + 0.01);
        expect(plateBox.maxX).toBeGreaterThanOrEqual(qrBox.maxX - 0.01);
        expect(plateBox.minY).toBeLessThanOrEqual(qrBox.minY + 0.01);
        expect(plateBox.maxY).toBeGreaterThanOrEqual(qrBox.maxY - 0.01);
        // "SCAN TO VERIFY" sits in the plate, upright.
        const caption = calls.find((c) => c.kind === "text" && c.text === "SCAN TO VERIFY")!;
        expect(displayAngle(angleOf(caption.o), rot)).toBe(0);
        const cap = toDisplay(caption.o.x as number, caption.o.y as number, MEDIA.w, MEDIA.h, rot);
        expect(cap.x).toBeGreaterThanOrEqual(plateBox.minX - 0.01);
        expect(cap.x).toBeLessThanOrEqual(plateBox.maxX + 0.01);
        expect(cap.y).toBeGreaterThanOrEqual(plateBox.minY - 0.01);
        expect(cap.y).toBeLessThanOrEqual(plateBox.maxY + 0.01);

        // Footer lines: upright on the printed sheet, inside it, on the band
        // the analysis left free (a free top corner → the top band is the
        // quieter one), and clear of the QR plate.
        const footer = calls.filter((c) => c.kind === "text" && c.o.opacity === 0.85);
        expect(footer.length).toBeGreaterThan(0);
        for (const f of footer) {
          expect(displayAngle(angleOf(f.o), rot)).toBe(0);
          const w = (f.o.font as PDFFont).widthOfTextAtSize(f.text!, f.o.size as number);
          const b = markBox(f.o.x as number, f.o.y as number, w, f.o.size as number, angleOf(f.o), MEDIA.w, MEDIA.h, rot);
          expect(onPage(b, DW, DH)).toBe(true);
          if (empty === "tl") expect(b.minY).toBeGreaterThan(DH / 2); else expect(b.maxY).toBeLessThan(DH / 2);
          const overlaps = b.minX < plateBox.maxX && b.maxX > plateBox.minX && b.minY < plateBox.maxY && b.maxY > plateBox.minY;
          expect(overlaps).toBe(false);
        }

        // Watermark: −30° on the printed sheet, centred on it, fitted to it.
        const wm = calls.find((c) => c.kind === "text" && c.o.opacity === 0.15)!;
        expect(displayAngle(angleOf(wm.o), rot)).toBe(330);
        const ww = (wm.o.font as PDFFont).widthOfTextAtSize(wm.text!, wm.o.size as number);
        const wb = markBox(wm.o.x as number, wm.o.y as number, ww, wm.o.size as number, angleOf(wm.o), MEDIA.w, MEDIA.h, rot);
        expect((wb.minX + wb.maxX) / 2).toBeCloseTo(DW / 2, 0);
        expect((wb.minY + wb.maxY) / 2).toBeCloseTo(DH / 2, 0);
        expect(wb.maxX - wb.minX).toBeLessThanOrEqual(DW * 0.88 + 0.5);
        expect(onPage(wb, DW, DH)).toBe(true);
      });
    }
  }

  it("a multi-page set with mixed rotations places each page in its own display space", async () => {
    stubCanvas();
    const set = [
      { ...MEDIA, rotate: 90, empty: "tl" as const },
      { ...MEDIA, rotate: 0, empty: "br" as const },
      { ...MEDIA, rotate: 270, empty: "bl" as const },
    ];
    fake.pages = set.map((p) => { const d = displayDims(p.w, p.h, p.rotate); return { w: d.DW, h: d.DH, empty: p.empty }; });
    const bytes = await makePdf(set);
    const pdfDoc = await PDFDocument.load(bytes);
    await applyStampToPdfDoc(pdfDoc, { sourceBytes: bytes, verifyUrl: "https://app.example.com/verify/d?v=v", timestamp: new Date() });
    const pages = pdfDoc.getPages();
    set.forEach((p, i) => {
      const img = calls.find((c) => c.kind === "image" && c.page === pages[i])!;
      const { DW, DH } = displayDims(p.w, p.h, p.rotate);
      const b = markBox(img.o.x as number, img.o.y as number, img.o.width as number, img.o.height as number, angleOf(img.o), p.w, p.h, p.rotate);
      expect(displayAngle(angleOf(img.o), p.rotate)).toBe(0);
      expect(onPage(b, DW, DH)).toBe(true);
      expect(inQuadrant(b, p.empty, DW, DH)).toBe(true);
    });
  });

  it("with no ink analysis (no DOM — every server route) the fallback corner is still a DISPLAY corner, upright and on-page", async () => {
    // no stubCanvas(): `document` is undefined, analyzePageInk returns null
    for (const rot of ROTATIONS) {
      calls = [];
      const { DW, DH } = displayDims(MEDIA.w, MEDIA.h, rot);
      const bytes = await makePdf([{ ...MEDIA, rotate: rot }]);
      const pdfDoc = await PDFDocument.load(bytes);
      await applyStampToPdfDoc(pdfDoc, { verifyUrl: "https://app.example.com/verify/d?v=v", timestamp: new Date() });
      const img = calls.find((c) => c.kind === "image")!;
      const b = markBox(img.o.x as number, img.o.y as number, img.o.width as number, img.o.height as number, angleOf(img.o), MEDIA.w, MEDIA.h, rot);
      expect(displayAngle(angleOf(img.o), rot)).toBe(0);
      expect(onPage(b, DW, DH)).toBe(true);
      expect(inQuadrant(b, pickQrCorner(fallbackInk(DW, DH).corners), DW, DH)).toBe(true);
    }
  });
});

describe("PKG-13 — baked markups land where they were drawn on a rotated sheet", () => {
  for (const rot of ROTATIONS) {
    it(`/Rotate ${rot}: the markup raster is sized to the displayed page and covers it exactly, upright`, async () => {
      vi.stubGlobal("window", { document: { createElement: () => ({}) } });
      const { bakeMarkupIntoPdf } = await import("@/lib/markupExport");
      const { DW, DH } = displayDims(MEDIA.w, MEDIA.h, rot);
      const bytes = await makePdf([{ ...MEDIA, rotate: rot }]);
      await bakeMarkupIntoPdf(bytes, { 1: { objects: [{ type: "path" }] } });
      // The fabric canvas the viewer drew on was the DISPLAYED page.
      expect(fake.dims.at(-1)).toEqual({ width: DW, height: DH });
      const img = calls.find((c) => c.kind === "image")!;
      expect(displayAngle(angleOf(img.o), rot)).toBe(0);
      const b = markBox(img.o.x as number, img.o.y as number, img.o.width as number, img.o.height as number, angleOf(img.o), MEDIA.w, MEDIA.h, rot);
      expect(b.minX).toBeCloseTo(0, 6); expect(b.minY).toBeCloseTo(0, 6);
      expect(b.maxX).toBeCloseTo(DW, 6); expect(b.maxY).toBeCloseTo(DH, 6);
    });
  }

  it("a page with no objects is left untouched", async () => {
    vi.stubGlobal("window", { document: { createElement: () => ({}) } });
    const { bakeMarkupIntoPdf } = await import("@/lib/markupExport");
    const bytes = await makePdf([{ ...MEDIA, rotate: 90 }]);
    await bakeMarkupIntoPdf(bytes, { 1: { objects: [] } });
    expect(calls.filter((c) => c.kind === "image")).toHaveLength(0);
  });
});

describe("PKG-13 dw3 — an encrypted source is refused by the stamper, never merged as unreadable pages", () => {
  it("a document pdf-lib loaded with ignoreEncryption is refused with a reason (docPack records it as skipped)", async () => {
    const d = await PDFDocument.create();
    d.addPage([200, 200]);
    d.context.trailerInfo.Encrypt = d.context.obj({ Filter: "Standard" });
    const enc = await d.save({ useObjectStreams: false });
    await expect(PDFDocument.load(enc)).rejects.toThrow(); // stampPdf's load: fails loudly
    const loaded = await PDFDocument.load(enc, { ignoreEncryption: true }); // docPack's load
    expect(loaded.isEncrypted).toBe(true);
    await expect(applyStampToPdfDoc(loaded, { timestamp: new Date() })).rejects.toThrow(/encrypted/i);
    expect(calls).toHaveLength(0);
  });
  it("docPack turns the refusal into a skipped sheet with the reason (its per-document try/catch)", () => {
    const pack = readFileSyncSafe("lib/docPack.ts");
    expect(pack).toMatch(/await applyStampToPdfDoc\(single, \{/);
    // document-control P8 (VFY-19): the skip also carries the document, a
    // code and the revision tried — the reason unchanged. The encrypted
    // refusal is "unreadable_pdf" (the parsed file says isEncrypted); a
    // failure after a clean load is "build_failed" (fix pass).
    expect(pack).toMatch(/\} catch \(e\) \{\s*\n\s*if \(e instanceof PackTooLargeError\) throw e;[\s\S]{0,800}?const unreadablePdf = !single \|\| single\.isEncrypted;\s*\n\s*skipped\.push\(\{ documentId, label, reason: \(e as Error\)\.message, code: unreadablePdf \? "unreadable_pdf" : "build_failed", versionId \}\);/);
  });
});

function readFileSyncSafe(p: string) { return readFileSync(p, "utf8"); }

// ─── SHR-8: a server-stamped (blind) copy of a title-blocked drawing ───────
// The share download and the transmittal portal stamp on the server, where
// no ink analysis is possible. Representative sheets carry a title block at
// the bottom-right (ISO 7200 / ASME Y14.1) and, on ASME sheets, a revision
// block at the top-right — both inside a 0.5 in (36 pt) border, or ISO's
// 10 mm (28 pt). Nothing the stamp draws (except the translucent diagonal
// watermark, which covers the whole sheet by design) may land on either.
describe("SHR-8 — the blind stamp keeps the QR and the footer off the title block", () => {
  type Rect = { x0: number; y0: number; x1: number; y1: number };
  const sheets: Array<{ name: string; w: number; h: number; rotate: number; blocks: (DW: number, DH: number) => Rect[] }> = [
    {
      name: "ASME B landscape (11×17), title block bottom-right + revision block top-right",
      w: 1224, h: 792, rotate: 0,
      blocks: (DW, DH) => [
        { x0: DW - 36 - 450, y0: 36, x1: DW - 36, y1: 36 + 180 },
        { x0: DW - 36 - 504, y0: DH - 36 - 100, x1: DW - 36, y1: DH - 36 },
      ],
    },
    {
      name: "ANSI D stored portrait with /Rotate 90 (displayed 34×22)",
      w: 1584, h: 2448, rotate: 90,
      blocks: (DW, DH) => [
        { x0: DW - 36 - 504, y0: 36, x1: DW - 36, y1: 36 + 180 },
        { x0: DW - 36 - 504, y0: DH - 36 - 100, x1: DW - 36, y1: DH - 36 },
      ],
    },
    {
      name: "ISO A4 landscape, a 180 mm title block spanning most of the bottom",
      w: 842, h: 595, rotate: 0,
      blocks: (DW) => [{ x0: DW - 28 - 510, y0: 28, x1: DW - 28, y1: 28 + 156 }],
    },
    {
      name: "ISO A3 stored portrait with /Rotate 270",
      w: 842, h: 1191, rotate: 270,
      blocks: (DW) => [{ x0: DW - 28 - 510, y0: 28, x1: DW - 28, y1: 28 + 156 }],
    },
    // Portrait sheets DISPLAYED portrait — the most common small-drawing
    // format. Their title block takes most of the bottom width, so no bottom
    // footer can clear it; the blind footer runs along the top instead.
    {
      name: "ASME A portrait (8½×11), 450 pt title block bottom-right + a 4 in revision block top-right",
      w: 612, h: 792, rotate: 0,
      blocks: (DW, DH) => [
        { x0: DW - 36 - 450, y0: 36, x1: DW - 36, y1: 36 + 180 },
        // The top-right reserve on a portrait sheet is half its width, so on
        // Letter a revision block up to 4 in (288 pt) inside the border clears
        // the footer by construction (see titleBlockReserve).
        { x0: DW - 36 - 288, y0: DH - 36 - 100, x1: DW - 36, y1: DH - 36 },
      ],
    },
    {
      name: "ISO A4 portrait, a 180 mm title block spanning nearly the whole bottom",
      w: 595, h: 842, rotate: 0,
      blocks: (DW) => [{ x0: DW - 28 - 510, y0: 28, x1: DW - 28, y1: 28 + 156 }],
    },
    {
      name: "ASME A stored landscape with /Rotate 90 (displayed portrait)",
      w: 792, h: 612, rotate: 90,
      blocks: (DW) => [{ x0: DW - 36 - 450, y0: 36, x1: DW - 36, y1: 36 + 180 }],
    },
  ];
  const hits = (b: Box, r: Rect) => b.minX < r.x1 && b.maxX > r.x0 && b.minY < r.y1 && b.maxY > r.y0;

  // The two server routes' footers: the share download's and the transmittal
  // portal's (app/api/share/file/route.ts, app/api/transmittal/route.ts).
  const SERVER_STAMPS = [
    { userLabel: "shared-link", watermarkText: "UNCONTROLLED — SHARED COPY", footerNotice: "2002-D-10001 Rev 4 (Issued) at time of download — a share always serves the current revision. Scan the QR to confirm it is still current." },
    { userLabel: "transmittal TR-0042", watermarkText: "UNCONTROLLED — TRANSMITTAL COPY", footerNotice: "2002-D-10001 Rev 4 as issued on transmittal TR-0042 (2026-10-01). Scan the QR to confirm it is still current." },
  ];

  for (const sh of sheets) {
    for (const stamp of SERVER_STAMPS) it(`${sh.name} — ${stamp.userLabel}`, async () => {
      // no stubCanvas(): `document` is undefined, exactly as in a route handler
      const { DW, DH } = displayDims(sh.w, sh.h, sh.rotate);
      const blocks = sh.blocks(DW, DH);
      const bytes = await makePdf([{ w: sh.w, h: sh.h, rotate: sh.rotate }]);
      const pdfDoc = await PDFDocument.load(bytes);
      await applyStampToPdfDoc(pdfDoc, {
        ...stamp,
        timestamp: new Date("2026-10-01T10:00:00Z"),
        verifyUrl: "https://app.example.com/verify/doc?v=ver",
      });
      const marks: Array<{ what: string; box: Box }> = [];
      for (const c of calls) {
        if (c.kind === "text" && c.o.opacity === 0.15) continue; // the diagonal watermark
        const theta = angleOf(c.o);
        if (c.kind === "text") {
          const w = (c.o.font as PDFFont).widthOfTextAtSize(c.text!, c.o.size as number);
          marks.push({ what: `text "${c.text}"`, box: markBox(c.o.x as number, c.o.y as number, w, c.o.size as number, theta, sh.w, sh.h, sh.rotate) });
        } else {
          marks.push({ what: c.kind, box: markBox(c.o.x as number, c.o.y as number, c.o.width as number, c.o.height as number, theta, sh.w, sh.h, sh.rotate) });
        }
      }
      expect(marks.some((m) => m.what === "image")).toBe(true); // the QR is there
      expect(marks.filter((m) => m.what.startsWith("text")).length).toBeGreaterThan(1); // footer lines + caption
      for (const m of marks) {
        expect(onPage(m.box, DW, DH), m.what).toBe(true);
        for (const r of blocks) expect(hits(m.box, r), `${m.what} over a title/revision block`).toBe(false);
      }
      // and specifically: the QR is top-left, never on the bottom-right title
      // block, and blind nothing is drawn in the bottom half — the title
      // block's — on a landscape or a portrait sheet
      const qr = marks.find((m) => m.what === "image")!;
      expect(inQuadrant(qr.box, "tl", DW, DH)).toBe(true);
      for (const m of marks) expect(m.box.minY, `${m.what} in the bottom half`).toBeGreaterThan(DH / 2);
    });
  }

  it("a measured page (the browser paths) is unaffected — the analysis still decides, with no title-block reserve", async () => {
    stubCanvas();
    fake.pages = [{ w: 1224, h: 792, empty: "br" }];
    const bytes = await makePdf([{ w: 1224, h: 792, rotate: 0 }]);
    const pdfDoc = await PDFDocument.load(bytes);
    await applyStampToPdfDoc(pdfDoc, { sourceBytes: bytes, verifyUrl: "https://app.example.com/verify/d?v=v", timestamp: new Date() });
    const img = calls.find((c) => c.kind === "image")!;
    const b = markBox(img.o.x as number, img.o.y as number, img.o.width as number, img.o.height as number, 0, 1224, 792, 0);
    expect(inQuadrant(b, "br", 1224, 792)).toBe(true);
  });
});
