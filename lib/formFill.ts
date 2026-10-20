// lib/formFill.ts — SERVER-ONLY. Put drafted answers onto a library form.
//
// Two kinds of form PDF exist in the wild:
//   • FILLABLE (AcroForm): the fields live in the file. They are filled in
//     place and left editable, so the user can still change them in any PDF
//     reader before signing.
//   • FLAT (scanned or printed-to-PDF): there is nothing to fill. Guessing
//     coordinates to overprint would misplace text, so instead the output is
//     a clean "completed form" — every field label with its value, in the
//     form's own order — followed by the original form pages for reference.
//
// Text goes through the PDF standard font (WinAnsi), so characters it can't
// encode are mapped to ASCII stand-ins first instead of throwing.

import {
  PDFDocument, StandardFonts, rgb, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup,
  type PDFFont,
} from "pdf-lib";
import type { FormField } from "@/lib/knowledgeCatalog";

const WINANSI_MAP: Record<string, string> = {
  "→": "->", "←": "<-", "↔": "<->", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "×": "x", "−": "-",
  "–": "-", "—": "-", "•": "-", "…": "...", "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "µ": "u", "Ω": "ohm", "✓": "x", "✔": "x", "☐": "[ ]", "☑": "[x]",
  " ": " ", " ": " ", " ": " ",
};

/** Make text drawable in the standard Helvetica (WinAnsi) encoding. */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    if (WINANSI_MAP[ch] !== undefined) { out += WINANSI_MAP[ch]; continue; }
    const code = ch.codePointAt(0) ?? 0;
    // Latin-1 and the WinAnsi extras (smart quotes, dashes, €, ™) are safe.
    if (code === 10 || (code >= 32 && code <= 255) || "‘’“”€™ŠšŽžŒœŸƒˆ˜‰‹›".includes(ch)) out += ch;
    else out += "?";
  }
  return out;
}

const truthy = (v: string) => /^(y|yes|true|x|checked|on|1)$/i.test(v.trim());

/** Fill a fillable PDF's fields in place. Fields the values don't mention
 *  keep whatever the blank form had. Returns the bytes and which fields
 *  could not take their value (a choice not among the options, say). */
export async function fillAcroForm(
  bytes: Uint8Array, values: Record<string, string>,
): Promise<{ bytes: Uint8Array; skipped: string[] }> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = pdf.getForm();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const skipped: string[] = [];
  for (const field of form.getFields()) {
    const name = field.getName();
    if (!(name in values)) continue;
    const value = toWinAnsi(String(values[name] ?? ""));
    try {
      if (field instanceof PDFTextField) {
        if (value.includes("\n") && !field.isMultiline()) field.enableMultiline();
        field.setText(value);
      } else if (field instanceof PDFCheckBox) {
        if (truthy(value)) field.check(); else field.uncheck();
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) {
        const opt = field.getOptions().find((o) => o.toLowerCase() === value.toLowerCase());
        if (opt) field.select(opt); else if (value) skipped.push(name);
      }
    } catch {
      skipped.push(name);
    }
  }
  try { form.updateFieldAppearances(font); } catch { /* readers regenerate appearances */ }
  return { bytes: await pdf.save(), skipped };
}

/** Wrap text to a width in the given font, keeping explicit line breaks. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      // A single word wider than the line gets hard-cut.
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A flat form: completed pages (label → value, in the form's order), then
 *  the original form pages appended for reference and signatures. */
export async function buildCompletedForm(opts: {
  original: Uint8Array | null;
  title: string;
  sourceName: string;
  fields: FormField[];
  values: Record<string, string>;
  preparedBy: string;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 54, CW = W - M * 2;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.39, 0.45, 0.55);
  const rule = rgb(0.85, 0.87, 0.9);
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  const ensure = (h: number) => { if (y - h < M) newPage(); };

  page.drawText(toWinAnsi(opts.title).slice(0, 90), { x: M, y: y - 18, size: 18, font: bold, color: ink });
  y -= 30;
  page.drawText(toWinAnsi(`Completed from: ${opts.sourceName}`).slice(0, 110), { x: M, y: y - 10, size: 9, font, color: muted });
  y -= 14;
  page.drawText(toWinAnsi(`Prepared ${new Date().toISOString().slice(0, 10)} by ${opts.preparedBy} with Manufacturing OS - review before submitting.`).slice(0, 120),
    { x: M, y: y - 10, size: 9, font, color: muted });
  y -= 26;

  for (const f of opts.fields) {
    const raw = (opts.values[f.name] ?? "").trim();
    const value = toWinAnsi(f.kind === "check" ? (truthy(raw) ? "[x] Yes" : "[ ] No") : raw || "(to be completed)");
    const lines = wrap(value, font, 10.5, CW - 16);
    const boxH = Math.max(22, lines.length * 14 + 10);
    const color = raw ? ink : muted;
    if (boxH <= H - M * 2 - 40) {
      // Fits on a page: label, then the value in a box.
      ensure(16 + boxH + 10);
      page.drawText(toWinAnsi(f.label).slice(0, 100), { x: M, y: y - 10, size: 9, font: bold, color: muted });
      y -= 16;
      page.drawRectangle({ x: M, y: y - boxH, width: CW, height: boxH, borderColor: rule, borderWidth: 1 });
      let ly = y - 16;
      for (const l of lines) { page.drawText(l, { x: M + 8, y: ly, size: 10.5, font, color }); ly -= 14; }
      y -= boxH + 12;
    } else {
      // Longer than a page: label, then the lines flowing across pages.
      ensure(40);
      page.drawText(toWinAnsi(f.label).slice(0, 100), { x: M, y: y - 10, size: 9, font: bold, color: muted });
      y -= 26;
      for (const l of lines) {
        ensure(14);
        page.drawText(l, { x: M + 8, y, size: 10.5, font, color });
        y -= 14;
      }
      y -= 12;
    }
  }

  if (opts.original) {
    try {
      const src = await PDFDocument.load(opts.original, { ignoreEncryption: true });
      const copied = await pdf.copyPages(src, src.getPageIndices());
      for (const p of copied) pdf.addPage(p);
    } catch { /* the completed pages stand alone */ }
  }
  return pdf.save();
}
