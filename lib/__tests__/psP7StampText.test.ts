// public-surfaces Round G — PS-P7 STAMP TEXT ENCODING (PHYS-15).
//
// The stamp draws with pdf-lib's standard Helvetica-Bold, whose WinAnsi
// encoding refuses any character outside it ("WinAnsi cannot encode …"). A
// document number or revision label pasted from Word — a Unicode hyphen
// (U+2010), a non-breaking hyphen, a minus sign, a Greek delta — or a
// person's name ("Łukasz") made every stamp path throw: the share download
// left unmarked, the in-app download, the pack, the book and the linked
// drawings failed, and the transmittal portal's issue-time check warned and
// never armed the item.
//
//   * stampText (lib/stamping.ts) — THE helper every drawn text goes
//     through: a character the font prints is drawn as typed (the en and em
//     dash and the curly quotes among them), any other in a form the font
//     prints ("-", "Delta", a straight quote, a space, a compatibility
//     decomposition), else a visible "?" — never dropped.
//   * the copy says what was replaced (stampTextNote, its footer's last
//     line) and applyStampToPdfDoc returns it (the transmittal portal records
//     it on the delivery's trail — transmittalPortalRoute.test.ts).
//   * REGRESSION: a stamp in characters the font prints is drawn exactly as
//     on b154823 — every draw call and the saved bytes
//     (psP7StampPlain.golden.json, recorded on b154823 by
//     psP7StampPlainHarness.ts).
//   * every caller's text stamps: the share route, the in-app download /
//     print, the field pack, the book, the linked drawings, the transmittal
//     portal and its issue-time check (route-level: shareRoutes.test.ts,
//     transmittalPortalRoute.test.ts, dcRoundFP15TransmittalStampCheck.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, PDFPage, StandardFonts } from "pdf-lib";
import {
  applyStampToPdfDoc, stampPdf, stampText, stampTextNote, stampFontPrints, STAMP_PLACEHOLDER, type StampOptions,
} from "@/lib/stamping";
import { stampFooterUnprintable, portalStampText } from "@/lib/transmittals";
import { shareFooterNotice } from "@/lib/shareServe";
import { buildFooterNotice, copyWatermark, holdFooterLine } from "@/lib/downloads";
import type { DocumentRecord } from "@/types/schema";
import { PLAIN_CASES, stampCase } from "./psP7StampPlainHarness";

const GOLDEN = join(process.cwd(), "lib/__tests__/psP7StampPlain.golden.json");
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ─── REGRESSION FIRST ─────────────────────────────────────────────────────
describe("PHYS-15 REGRESSION — a stamp in characters the font prints as typed is drawn exactly as on b154823", () => {
  beforeEach(() => {
    // the footer's "Downloaded:" date is the runtime's locale string — fixed
    // here so the record is the same on every machine
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("10/7/2026, 9:15:00 AM");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("every caller's plain-text stamp: the same draw calls and the same saved bytes", async () => {
    const now: Record<string, Awaited<ReturnType<typeof stampCase>>> = {};
    for (const c of PLAIN_CASES) now[c.name] = await stampCase(c);
    if (process.env.PS_P7_WRITE_GOLDEN === "1") writeFileSync(GOLDEN, `${JSON.stringify(now, null, 1)}\n`);
    const before = JSON.parse(readFileSync(GOLDEN, "utf8")) as typeof now;
    expect(Object.keys(now)).toEqual(Object.keys(before));
    for (const name of Object.keys(before)) {
      expect({ name, calls: now[name].calls }).toEqual({ name, calls: before[name].calls });
      expect({ name, sha256: now[name].sha256 }).toEqual({ name, sha256: before[name].sha256 });
    }
  }, 60_000);

  it("the golden covers every caller and the characters the font prints beyond ASCII (en / em dash, curly quotes, Latin-1, NBSP, €, …, •)", () => {
    const names = PLAIN_CASES.map((c) => c.name).join("\n");
    for (const caller of ["share/file", "downloads", "docPack", "MultiDocViewer", "FileReferenceModal", "portalStampText"]) expect(names).toContain(caller);
    const all = JSON.stringify(PLAIN_CASES.map((c) => c.opts));
    for (const ch of ["–", "—", "“", "”", "‘", "’", "é", "ë", " ", "€", "…", "•"]) expect(all).toContain(ch);
  });

  it("stampText hands back the SAME string for text the font prints — the identity, not a copy", () => {
    for (const t of ["", "P-101 Rev B", "UNCONTROLLED COPY — REVIEW ONLY", "P–101 Rev “A” ‘B’", "Rév B • € … ™ ‰", "A B"]) {
      const out = stampText(t);
      expect(out.text).toBe(t);
      expect(out.mapped).toEqual([]);
    }
  });
});

// ─── the helper ───────────────────────────────────────────────────────────
describe("PHYS-15 — stampText: what the font cannot print is drawn in a form it prints, never dropped", () => {
  it("the dashes and the minus a pasted number carries → '-' (the en and em dash, which the font prints, are kept)", () => {
    expect(stampText("P‐101")).toEqual({ text: "P-101", mapped: [{ char: "‐", codePoint: "U+2010", printedAs: "-" }] });
    expect(stampText("P‑101 ‒ − 5").text).toBe("P-101 - - 5");
    expect(stampText("A–B—C")).toEqual({ text: "A–B—C", mapped: [] });
  });

  it("a Greek delta (and the increment sign of a symbol font) → 'Delta'", () => {
    expect(stampText("Δ1")).toEqual({ text: "Delta1", mapped: [{ char: "Δ", codePoint: "U+0394", printedAs: "Delta" }] });
    expect(stampText("Rev ∆2").text).toBe("Rev Delta2");
  });

  it("primes and reversed quotes → straight quotes; the curly quotes the font prints are kept", () => {
    expect(stampText("6′ 2″").text).toBe("6' 2\"");
    expect(stampText("‛x‟").text).toBe("'x\"");
    expect(stampText("“GA” ‘B’").mapped).toEqual([]);
  });

  it("whitespace the font cannot print (a tab, a narrow no-break space in a date) → a space, as the footer's wrap already drew it — not noted", () => {
    expect(stampText("10/7/2026, 9:15:00 AM")).toEqual({ text: "10/7/2026, 9:15:00 AM", mapped: [] });
    expect(stampText("A\tB\nC")).toEqual({ text: "A B C", mapped: [] });
  });

  it("anything else → a visible '?', once per character in `mapped`, in the order met — a letter's accent composed first, a compatibility form decomposed", () => {
    expect(stampText("Łukasz ЖЖ")).toEqual({
      text: "?ukasz ??",
      mapped: [{ char: "Ł", codePoint: "U+0141", printedAs: "?" }, { char: "Ж", codePoint: "U+0416", printedAs: "?" }],
    });
    expect(stampText("Rév B")).toEqual({ text: "Rév B", mapped: [] }); // e + combining acute = é, which the font prints
    expect(stampText("１２-ﬁ").text).toBe("12-fi"); // fullwidth digits, the fi ligature
    expect(stampText("A\u{1F600}B")).toEqual({ text: "A?B", mapped: [{ char: "\u{1F600}", codePoint: "U+1F600", printedAs: "?" }] });
    expect(STAMP_PLACEHOLDER).toBe("?");
  });

  it("every code point (the BMP and three astral ones) comes out in characters pdf-lib's Helvetica-Bold encodes, and none is dropped", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const encodes = (s: string) => { try { font.encodeText(s); return true; } catch { return false; } };
    const failures: string[] = [];
    const codePoints = [...Array.from({ length: 0x10000 }, (_, i) => i).filter((cp) => cp < 0xd800 || cp > 0xdfff), 0x1f600, 0x1d400, 0x20000];
    for (const cp of codePoints) {
      const ch = String.fromCodePoint(cp);
      const { text } = stampText(`A${ch}B`);
      // drawable, A and B kept, and the character took up at least one place
      // (a combining mark composes onto the A — "A" + U+030A is "Å")
      if (!encodes(text) || !text.endsWith("B") || text.length < 2 || (text.length === 2 && `A${ch}`.normalize("NFC").length !== 1)) {
        failures.push(cp.toString(16));
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it("stampFontPrints is exactly pdf-lib's WinAnsi, and lib/transmittals.ts stampFooterUnprintable names exactly the characters the stamp replaces (whitespace aside)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const encodes = (s: string) => { try { font.encodeText(s); return true; } catch { return false; } };
    const mismatches: string[] = [];
    for (let cp = 0; cp < 0x10000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (stampFontPrints(cp) !== encodes(ch)) mismatches.push(`font ${cp.toString(16)}`);
      const replaced = !stampFontPrints(cp) && !/\s/.test(ch);
      if ((stampFooterUnprintable(ch) !== "") !== replaced) mismatches.push(`transmittals ${cp.toString(16)}`);
    }
    expect(mismatches).toEqual([]);
  }, 60_000);

  it("the note names what was replaced, in characters the font prints; nothing replaced → no note; past twelve it counts the rest", () => {
    expect(stampTextNote([])).toBeNull();
    const note = stampTextNote(stampText("P‐101 Δ1").mapped)!;
    expect(note).toBe('Printed in plain characters: U+2010 as "-", U+0394 as "Delta".');
    expect(stampText(note)).toEqual({ text: note, mapped: [] });
    const many = stampText("АБВГДЕЖЗИЙКЛМН").mapped;
    expect(many).toHaveLength(14);
    expect(stampTextNote(many)).toMatch(/U\+041B as "\?" and 2 more\.$/);
  });
});

// ─── the stamp ────────────────────────────────────────────────────────────
async function stampDrawn(opts: StampOptions, pages = 1) {
  const texts: Array<{ t: string; o: Record<string, unknown> }> = [];
  const proto = PDFPage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = proto.drawText;
  const spy = vi.spyOn(proto, "drawText").mockImplementation(function (this: PDFPage, ...a: unknown[]) {
    texts.push({ t: a[0] as string, o: a[1] as Record<string, unknown> });
    return orig.apply(this, a);
  });
  try {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < pages; i++) pdf.addPage([1224, 792]);
    const result = await applyStampToPdfDoc(pdf, opts);
    await pdf.save();
    return { result, texts, all: texts.map((x) => x.t).join(" ") };
  } finally {
    spy.mockRestore();
  }
}

describe("PHYS-15 — applyStampToPdfDoc draws every text through stampText, notes the replacement on the copy and returns it", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("the failure scenario: \"P‐101\" (U+2010) at \"Δ1\" stamps — watermark, footer and note — and the result lists the replacements once, in order", async () => {
    const { result, texts, all } = await stampDrawn({
      userLabel: "Łukasz", timestamp: new Date(0), watermarkText: "UNCONTROLLED — P‐101 Rev Δ1",
      footerNotice: "P‐101 Rev Δ1 at time of issue — verify current revision before use.",
      verifyUrl: "https://app.example.com/verify/d?v=v",
    }, 2);
    expect(result.mapped).toEqual([
      { char: "‐", codePoint: "U+2010", printedAs: "-" },
      { char: "Δ", codePoint: "U+0394", printedAs: "Delta" },
      { char: "Ł", codePoint: "U+0141", printedAs: "?" },
    ]);
    const watermark = texts.find((x) => x.o.opacity === 0.15)!.t;
    expect(watermark.startsWith("UNCONTROLLED — P-101 Rev Delta1 • ?ukasz")).toBe(true);
    expect(all).toContain("P-101 Rev Delta1 at time of issue — verify current revision before use.");
    expect(all).toContain('Printed in plain characters: U+2010 as "-", U+0394 as "Delta", U+0141 as "?".');
    expect(all).not.toMatch(/[‐ΔŁ]/);
    // the note is the footer's LAST line, on every page, in the notice's style
    const footer = texts.filter((x) => x.o.opacity === 0.85);
    const perPage = footer.length / 2;
    expect(footer[perPage - 1].t).toMatch(/U\+0141 as "\?"\.$/);
    expect(footer[2 * perPage - 1].t).toBe(footer[perPage - 1].t);
    expect(footer[perPage - 1].o.size).toBe(footer[perPage - 2].o.size);
  });

  it("a footer that loses its scan instruction (no QR) is mapped after the instruction is removed; a date with a narrow no-break space stamps with no note", async () => {
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("10/7/2026, 9:15:00 AM");
    const { result, all } = await stampDrawn({ timestamp: new Date(0), footerNotice: "VDS‑7 Rev 2 as issued. Scan the QR to confirm it is still current." });
    expect(result.mapped).toEqual([{ char: "‑", codePoint: "U+2011", printedAs: "-" }]);
    expect(all).toContain("VDS-7 Rev 2 as issued. Confirm the current revision before use.");
    expect(all).toContain("Downloaded: 10/7/2026, 9:15:00 AM");
    expect(all).not.toMatch(/Scan the QR/);
  });

  it("stampPdf (the browser paths) stamps the same text: fetch → stamp → a PDF blob", async () => {
    const d = await PDFDocument.create();
    d.addPage([612, 792]);
    const bytes = await d.save();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes as BlobPart)));
    try {
      const blob = await stampPdf("https://bucket.example.com/x.pdf", { footerNotice: "P‐101 Rev Δ1", watermarkText: "UNCONTROLLED — P‐101" });
      expect(blob.type).toBe("application/pdf");
      expect(blob.size).toBeGreaterThan(bytes.length);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─── every caller's text ──────────────────────────────────────────────────
describe("PHYS-15 — every caller's stamp, with a number or label carrying U+2010, U+2013, Δ and curly quotes, stamps", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });
  const NUMBER = "P‐101 “GA”";
  const REV = "Δ1–B";
  const VERIFY = "https://app.example.com/verify/d1?v=v1";
  const doc = { id: "d1", orgId: "o1", libraryId: "l1", documentNumber: NUMBER, rev: REV, currentVersionId: "v1" } as DocumentRecord;
  const held = { blocked: true, holds: [{ reason: "Safety" }] };
  const expectStamped = (result: { mapped: Array<{ codePoint: string; printedAs: string }> }, all: string) => {
    expect(result.mapped.map((m) => `${m.codePoint}=${m.printedAs}`)).toEqual(["U+2010=-", "U+0394=Delta"]);
    expect(all).toContain("P-101 “GA”");      // the curly quotes the font prints, kept
    expect(all).toContain("Delta1–B");               // the en dash the font prints, kept
    expect(all).toContain('Printed in plain characters: U+2010 as "-", U+0394 as "Delta".');
  };

  it("the share link (app/api/share/file/route.ts shareFooterNotice)", async () => {
    const { result, all } = await stampDrawn({
      userLabel: "shared-link", timestamp: new Date(), watermarkText: "UNCONTROLLED — SHARED COPY",
      footerNotice: shareFooterNotice({ label: NUMBER, rev: REV, status: "Issued", verifyUrl: VERIFY }), verifyUrl: VERIFY,
    });
    expectStamped(result, all);
  });

  it("the in-app download and print (lib/downloads.ts buildFooterNotice / copyWatermark), an older revision of a held document included", async () => {
    for (const ctx of [
      { doc, fileUrl: "x", userId: "u1", versionIsCurrent: true },
      { doc, fileUrl: "x", userId: "u1", versionIsCurrent: false, versionRev: REV },
    ]) {
      const { result, all } = await stampDrawn({
        userLabel: "Jane", email: "jane@example.com", timestamp: new Date(), expiresAt: new Date(),
        watermarkText: copyWatermark(ctx, held), footerNotice: buildFooterNotice(ctx, held), verifyUrl: VERIFY,
      });
      expect(result.mapped.map((m) => m.codePoint)).toEqual(["U+0394"]);
      expect(all).toContain("Rev Delta1–B");
    }
  });

  it("the field pack (lib/docPack.ts), the book (MultiDocViewer) and the linked drawings (FileReferenceModal) — their text as each builds it", async () => {
    const pack = await stampDrawn({
      userLabel: "jane", email: "jane@example.com", timestamp: new Date(), watermarkText: "UNCONTROLLED — FIELD PACK",
      footerNotice: `${NUMBER} Rev ${REV} at time of issue — verify current revision before use.`, verifyUrl: VERIFY,
    });
    expectStamped(pack.result, pack.all);
    const book = await stampDrawn({
      userLabel: "jane@example.com", email: "jane@example.com", timestamp: new Date(), expiresAt: new Date(),
      watermarkText: `UNCONTROLLED — ${NUMBER} Rev ${REV}`,
      footerNotice: `${holdFooterLine(held)} ${NUMBER} Rev ${REV} at time of issue — verify current revision before use.`, verifyUrl: VERIFY,
    });
    expectStamped(book.result, book.all);
    const linked = await stampDrawn({
      userLabel: "jane@example.com", email: "jane@example.com", timestamp: new Date(), expiresAt: new Date(),
      watermarkText: `UNCONTROLLED — ${NUMBER} Rev ${REV}`,
      footerNotice: `${NUMBER} Rev ${REV} at time of issue — verify current revision before use.`,
    });
    expectStamped(linked.result, linked.all);
  });

  it("the transmittal portal and its issue-time check (lib/transmittals.ts portalStampText)", async () => {
    const { result, all } = await stampDrawn({ ...portalStampText({ docNumber: NUMBER, rev: REV, transmittalNumber: "TR‐0042", issuedOn: "2026-10-07", verifyUrl: VERIFY }), timestamp: new Date() });
    expectStamped(result, all);
    expect(all).toContain("transmittal TR-0042");
  });

  it("each caller draws through lib/stamping — no caller embeds a font or draws stamp text of its own", () => {
    const callers: Record<string, RegExp> = {
      "app/api/share/file/route.ts": /await applyStampToPdfDoc\(pdfDoc, \{/,
      "lib/downloads.ts": /await downloadStampedPdf\(\{[\s\S]*?footerNotice: buildFooterNotice\(ctx, hold\),/,
      "lib/docPack.ts": /await applyStampToPdfDoc\(single, \{/,
      "components/viewers/MultiDocViewer.tsx": /const stamped = await stampPdf\(entry\.resolvedUrl!, \{/,
      "components/assets/FileReferenceModal.tsx": /const stamped = await stampPdf\(url, \{/,
      "app/api/transmittal/route.ts": /await applyStampToPdfDoc\(pdfDoc, \{\n\s+\.\.\.portalStampText\(\{/,
      "lib/transmittalStampCheck.ts": /await applyStampToPdfDoc\(pdfDoc, \{ \.\.\.text, timestamp: new Date\(\) \}\);/,
    };
    for (const [file, call] of Object.entries(callers)) {
      const s = src(file);
      expect(s, file).toMatch(call);
      expect(s, file).not.toMatch(/StandardFonts|embedFont\(|\.drawText\(/);
    }
    // the stamper itself: the watermark and the footer draw only stampText's output
    const st = src("lib/stamping.ts");
    expect(st).toContain("drawWatermark(frame, font, drawnWatermark.text);");
    expect(st).toContain("mainText: drawnMain.text, notice: drawnNotice?.text ?? null, note,");
    expect(st).toContain("const drawnNotice = footerOpts.footerNotice ? stampText(footerOpts.footerNotice) : null;");
  });
});
