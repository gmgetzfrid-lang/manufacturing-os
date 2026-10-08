// public-surfaces Round G, PS-P7 STAMP TEXT ENCODING — review fix (PHYS-15 /
// PHYS-16): the regression harness for the work-package COVER
// (lib/physicalBridge.ts buildPackageCover), the one place a /packages print
// draws a sheet's number and revision outside the stamp.
//
// What the cover DRAWS for text in characters its fonts (WinAnsi Helvetica
// and Helvetica-Bold) print as typed — plain ASCII, Latin-1, and cp1252's
// dashes, curly quotes, bullet, ellipsis, euro and trademark signs — captured
// draw call by draw call (text, position, size, font, colour) and as the
// saved PDF's bytes.
//
// `psP7CoverPlain.golden.json` was recorded by this harness with
// lib/physicalBridge.ts at its b154823 content (the cover before the fix),
// and lib/__tests__/psP7CoverText.test.ts compares the cover of today against
// it: a plain-text cover is byte-identical.
// (Re-record only on purpose: PS_P7_WRITE_COVER_GOLDEN=1 npx vitest run psP7CoverText.)

import { createHash } from "node:crypto";
import { vi } from "vitest";
import { PDFPage } from "pdf-lib";
import { buildPackageCover, type PackageCoverInput } from "@/lib/physicalBridge";

const PKG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** n contents entries in the page-reference shape /packages gives them
 *  (lib/workPackages.ts coverEntryLabels), a null revision every third. */
function entries(n: number, firstPage: number, stem = "P-"): PackageCoverInput["docs"] {
  return Array.from({ length: n }, (_, i) => ({
    label: `${stem}${100 + i} · p. ${firstPage + i}`,
    rev: i % 3 === 2 ? null : `${String.fromCharCode(65 + (i % 26))}${i % 2 ? "1" : ""}`,
  }));
}

const LONG = "PID-UNIT3-WEST-HEADER-TIE-IN-SPOOL-REPLACEMENT-HOT-TAP";

/** Each cover /packages builds, with text the fonts print as typed. */
export const COVER_PLAIN_CASES: Array<{ name: string; input: PackageCoverInput }> = [
  {
    name: "one page, every field, the print snapshot's QR; en dash, curly quotes and Latin-1 in the text",
    input: {
      packageId: PKG, printId: PRINT,
      name: "Unit 3 tie-ins",
      description: "Hot-tap and spool tie-ins — west header, TA “GA” scope",
      ownerName: "José Núñez",
      printedByName: "jane",
      docs: [
        { label: "P-100 · p. 2", rev: "B" },
        { label: "P–101 “GA” · pp. 3–4", rev: "1A" },
        { label: "Rév B datasheet · p. 5", rev: null },
      ],
    },
  },
  {
    name: "30 sheets: a continuation page; no description, owner or printer; the legacy package QR",
    input: { packageId: PKG, printId: null, name: "TA-2026", docs: entries(30, 3) },
  },
  {
    name: "70 sheets (three cover pages), a long name, description and labels cut with an ellipsis",
    input: {
      packageId: PKG, printId: PRINT,
      name: "Turnaround 2026 — crude unit west header tie-ins, hot taps and spool replacements, phase two of three",
      description: `${"Scope covers every tie-in on the west header including the hot taps and the spool replacements; ".repeat(3)}end.`,
      ownerName: "Zoë O’Brien",
      printedByName: "a.very.long.user.name",
      docs: Array.from({ length: 70 }, (_, i) => ({
        label: `${`${LONG}-${i}`.slice(0, 43)}… · p. ${4 + i}`,
        rev: i % 4 === 0 ? "12B-IFC-REISSUE-FOR-CONSTRUCTION-AFTER-HAZOP" : String(i),
      })),
    },
  },
  {
    name: "cp1252 extras and Latin-1 the fonts print: NBSP, €, •, …, ™, ‰, Å, Ø",
    input: {
      packageId: PKG, printId: PRINT,
      name: "Pump P-101\u00a0A/B • € 12,000 ™",
      description: "Scope: 50 ‰ of the strainers … see ‘notes’",
      ownerName: "Ånne Ørsted",
      printedByName: "anne",
      docs: [{ label: "P-1 · p. 2", rev: "Ä" }, { label: "Spec • rev’d · p. 3", rev: "2" }],
    },
  },
];

type Call = { op: string; args: unknown[] };

function plain(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const ctor = (v as { constructor?: { name?: string } }).constructor?.name ?? "";
  if (/Font$/.test(ctor)) return `<font ${(v as { name?: string }).name ?? ""}>`;
  if (/Image$/.test(ctor)) return "<image>";
  if (Array.isArray(v)) return v.map(plain);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = plain((v as Record<string, unknown>)[k]);
  return out;
}

/** Build one cover: every draw call (text, rectangle, image — with its
 *  position, size, font, colour), its page count and the saved bytes'
 *  digest. The document's creation and modification dates are pinned before
 *  saving (pdf-lib stamps "now" into them), so the bytes are comparable. */
export async function coverCase(input: PackageCoverInput): Promise<{ calls: Call[]; pages: number; sha256: string }> {
  const calls: Call[] = [];
  const proto = PDFPage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const spies = (["drawText", "drawRectangle", "drawImage"] as const).map((op) => {
    const orig = proto[op];
    return vi.spyOn(proto, op).mockImplementation(function (this: PDFPage, ...a: unknown[]) {
      calls.push({ op, args: a.map(plain) });
      return orig.apply(this, a);
    });
  });
  try {
    const cover = await buildPackageCover(input);
    cover.setCreationDate(new Date(0));
    cover.setModificationDate(new Date(0));
    const bytes = await cover.save();
    return { calls, pages: cover.getPageCount(), sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}
