// public-surfaces Round F — PS-STAMP (PKG-4 STAMP-PIPELINE).
//
//   * PHYS-5 — the viewer's "Download w/ Markup" ALWAYS stamps (watermark,
//     footer, verify QR), names the file _markup_UNCONTROLLED and records an
//     uncontrolled copy, the checkout holder included: markups are never the
//     controlled master.
//
// The rotation fixture (PHYS-12 / DC PKG-13) lives in stampingRotation.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(p, "utf8");

// ─── PHYS-5: the markup export is always an uncontrolled copy ──────────────
describe("PHYS-5 — a marked-up export is always stamped and recorded uncontrolled", () => {
  const v = src("components/viewers/FullScreenViewer.tsx");
  const fn = v.slice(v.indexOf("const downloadWithMarkup = async () => {"), v.indexOf("const requestMarkupDownload = () => {"));

  it("the stamp is unconditional — no checkout-state gate decides whether a redlined sheet is marked", () => {
    expect(fn.length).toBeGreaterThan(500);
    expect(fn).not.toMatch(/stampNow/);
    expect(fn).not.toMatch(/determineControlState/);
    expect(fn).not.toMatch(/if \(\s*liveState/);
    // the stamp call sits directly in the try block, not under a condition
    expect(fn).toMatch(/\n {6}await applyStampToPdfDoc\(pdfDoc, \{\n {8}sourceBytes: pdfBytes \?\? undefined,/);
    expect(fn).toContain('watermarkText: "UNCONTROLLED — FOR REVIEW ONLY",');
    expect(fn).toContain("WITH MARKUPS at time of export — markups are not part of the controlled revision.");
  });

  it("the filename always carries the markup + UNCONTROLLED suffix", () => {
    expect(fn).toContain('const suffix = "_markup_UNCONTROLLED";');
    expect(fn).not.toMatch(/let suffix = "_markup";/);
    expect(fn).toMatch(/const stem = `\$\{docNumber \|\| title \|\| "document"\}\$\{rev \? `_Rev\$\{rev\}` : ""\}\$\{suffix\}`/);
  });

  it("the audit row records an uncontrolled copy with its expiry — never the holder's controlled state", () => {
    expect(fn).toMatch(/await logDownloadAudit\(\{[\s\S]*?state: "uncontrolled",\s*\n\s*expiresAt,\s*\n\s*\}\);/);
    expect(fn).not.toMatch(/state: liveState/);
  });

  it("the checkout holder skips only the modal, not the stamp", () => {
    const req = v.slice(v.indexOf("const requestMarkupDownload = () => {"), v.indexOf("if (!isOpen) return null;"));
    expect(req).toMatch(/if \(live === "controlled"\) \{[\s\S]*?STILL stamped[\s\S]*?void downloadWithMarkup\(\);/);
    expect(req).not.toMatch(/raw bake, no stamp/);
  });
});

// ─── PHYS-12 / PKG-13: one bake, rotation-aware, shared by both viewers ────
describe("PKG-13 — the viewer's markup export bakes through the shared rotation-aware bake", () => {
  it("downloadWithMarkup calls bakeMarkupIntoDoc and keeps no private copy of the unrotated bake", () => {
    const v = src("components/viewers/FullScreenViewer.tsx");
    const fn = v.slice(v.indexOf("const downloadWithMarkup = async () => {"), v.indexOf("const requestMarkupDownload = () => {"));
    expect(v).toContain('import { bakeMarkupIntoPdf, bakeMarkupIntoDoc } from "@/lib/markupExport";');
    expect(fn).toContain("await bakeMarkupIntoDoc(pdfDoc, states);");
    expect(fn).not.toMatch(/page\.drawImage\(img, \{ x: 0, y: 0, width, height \}\)/);
    expect(fn).not.toMatch(/new fabric\.StaticCanvas/);
    // bake first, then stamp the same document
    expect(fn.indexOf("await bakeMarkupIntoDoc(pdfDoc, states);")).toBeLessThan(fn.indexOf("await applyStampToPdfDoc(pdfDoc, {"));
  });
  it("lib/markupExport sizes the raster to the displayed page and lays it back with the page's rotation", () => {
    const m = src("lib/markupExport.ts");
    expect(m).toContain("const rotation = normalizeRotation(page.getRotation().angle);");
    expect(m).toContain("const { width, height } = displaySize(media.width, media.height, rotation);");
    expect(m).toContain("page.drawImage(img, { ...origin, width, height, rotate: degrees(rotation) });");
    expect(m).toMatch(/export async function bakeMarkupIntoPdf\([\s\S]*?await bakeMarkupIntoDoc\(pdfDoc, pageStates\);/);
  });
});
