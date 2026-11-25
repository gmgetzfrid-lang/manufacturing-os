// lib/bomForm.ts - a bill of materials sheet (a fillable PDF) filled from
// the register, and read back. Runs in the browser and in node (pdf-lib only).
//
// Which field is which: by name when the sheet names them the app's way
// (no_1, qty_1, size_1, desc_1, status_1, used_1 … and wo, equipment,
// project, date, by), else by where they sit: fields in a line across the
// page are a row, the widest is the description, the ones before it are
// No., QTY and SIZE in that order, a text field after it is the status and a
// tick box is "used". So the owner's own sheet works as it is, and the
// merged one fills every column.
//
// More lines than the sheet has rows: the sheet is repeated, numbered on.

import { PDFDocument, PDFName, PDFTextField, PDFCheckBox, StandardFonts } from "pdf-lib";
import type { PDFFont, PDFForm } from "pdf-lib";
import type { BomRow, ReadRow } from "@/lib/bom";

type Col = "no" | "qty" | "size" | "desc" | "status" | "used";
export interface BomLayout {
  /** Field names, top row first. */
  rows: Array<Partial<Record<Col, string>> & { desc: string }>;
  header: Partial<Record<"wo" | "equipment" | "project" | "date" | "by", string>>;
}
export interface BomHeader { wo?: string; equipment?: string; project?: string; date?: string; by?: string }

const NAMED = /^(no|qty|size|desc|status|used)[_ -]?(\d+)$/i;
const HEADER: Array<[keyof BomLayout["header"], RegExp]> = [
  ["wo", /^(wo|w\/?o|work ?orders?\(?s?\)?)$|work ?order/i], ["equipment", /^equip/i], ["project", /^project|^job$/i], ["date", /^date$|date/i], ["by", /prepared|^by$/i],
];

function rectOf(f: PDFTextField | PDFCheckBox) {
  const w = f.acroField.getWidgets()[0];
  return w ? w.getRectangle() : null;
}

/** Which field is which on the sheet's first page; null when it has no rows. */
export function bomLayoutOf(form: PDFForm): BomLayout | null {
  const fields = form.getFields();
  const header: BomLayout["header"] = {};
  const named = new Map<number, Partial<Record<Col, string>>>();
  for (const f of fields) {
    const name = f.getName();
    const m = NAMED.exec(name);
    if (m) { const n = Number(m[2]); named.set(n, { ...(named.get(n) ?? {}), [m[1].toLowerCase() as Col]: name }); continue; }
    if (f instanceof PDFTextField) for (const [k, re] of HEADER) if (!header[k] && re.test(name.trim())) { header[k] = name; break; }
  }
  if ([...named.values()].some((r) => r.desc)) {
    const rows = [...named.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r).filter((r): r is BomLayout["rows"][number] => !!r.desc);
    return { rows, header };
  }
  // By where they sit: a row is the fields whose middles share a line.
  type F = { name: string; x: number; y: number; w: number; box: boolean };
  const placed: F[] = [];
  for (const f of fields) {
    if (!(f instanceof PDFTextField) && !(f instanceof PDFCheckBox)) continue;
    if (Object.values(header).includes(f.getName())) continue;
    const r = rectOf(f);
    if (r) placed.push({ name: f.getName(), x: r.x, y: r.y + r.height / 2, w: r.width, box: f instanceof PDFCheckBox });
  }
  placed.sort((a, b) => b.y - a.y);
  const lines: F[][] = [];
  for (const p of placed) {
    const line = lines.find((l) => Math.abs(l[0].y - p.y) <= 4);
    if (line) line.push(p); else lines.push([p]);
  }
  const rows: BomLayout["rows"] = [];
  for (const line of lines) {
    const text = line.filter((f) => !f.box).sort((a, b) => a.x - b.x);
    if (text.length < 2) continue;
    const di = text.reduce((best, f, i) => (f.w > text[best].w ? i : best), 0);
    const before = text.slice(0, di), after = text.slice(di + 1);
    const lead: Col[] = before.length >= 3 ? ["no", "qty", "size"] : before.length === 2 ? ["qty", "size"] : ["qty"];
    const row: BomLayout["rows"][number] = { desc: text[di].name };
    before.slice(-lead.length).forEach((f, i) => { row[lead[i]] = f.name; });
    if (after[0]) row.status = after[0].name;
    const tick = line.find((f) => f.box);
    if (tick) row.used = tick.name;
    rows.push(row);
  }
  // Rows run down the page; a lone line elsewhere (a header) isn't a row.
  return rows.length >= 3 ? { rows, header } : null;
}

/** Fit text to a field: smaller down to 6 pt, then cut with "…". */
function fit(font: PDFFont, s: string, width: number, size: number): { text: string; size: number } {
  const room = Math.max(4, width - 4);
  let sz = size;
  while (sz > 6 && font.widthOfTextAtSize(s, sz) > room) sz -= 0.5;
  if (font.widthOfTextAtSize(s, sz) <= room) return { text: s, size: sz };
  let t = s;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, sz) > room) t = t.slice(0, -1);
  return { text: `${t.trimEnd()}…`, size: sz };
}

/** Only what the standard font can print. */
const printable = (font: PDFFont, s: string) => {
  const set = new Set(font.getCharacterSet());
  return Array.from(String(s ?? "").replace(/\s+/g, " ").trim()).map((c) => (set.has(c.codePointAt(0) ?? -1) ? c : c === "″" ? "\"" : c === "′" ? "'" : "?")).join("");
};

/** The sheet filled: as many copies as the lines need, each flattened.
 *  Null when the sheet has no rows the app can find. */
export async function fillBom(template: Uint8Array, header: BomHeader, rows: BomRow[]): Promise<{ bytes: Uint8Array; pages: number } | null> {
  const probe = await PDFDocument.load(template, { ignoreEncryption: true });
  const layout = bomLayoutOf(probe.getForm());
  if (!layout) return null;
  const per = layout.rows.length;
  const chunks = Math.max(1, Math.ceil(rows.length / per));
  const out = await PDFDocument.create();
  for (let c = 0; c < chunks; c++) {
    const doc = await PDFDocument.load(template, { ignoreEncryption: true });
    const form = doc.getForm();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const put = (name: string | undefined, value: string, size = 9) => {
      if (!name || !value) return;
      try {
        const f = form.getTextField(name);
        const r = rectOf(f);
        const v = fit(font, printable(font, value), r?.width ?? 200, size);
        f.setText(v.text);
        f.setFontSize(v.size);
      } catch { /* not a text field: left blank */ }
    };
    const more = chunks > 1 ? ` (page ${c + 1} of ${chunks})` : "";
    put(layout.header.wo, `${header.wo ?? ""}${more}`, 9.5);
    put(layout.header.equipment, header.equipment ?? "", 9.5);
    put(layout.header.project, header.project ?? "", 9.5);
    put(layout.header.date, header.date ?? "", 9.5);
    put(layout.header.by, header.by ?? "", 9.5);
    rows.slice(c * per, (c + 1) * per).forEach((r, i) => {
      const at = layout.rows[i];
      put(at.no, r.no); put(at.qty, r.qty); put(at.size, r.size); put(at.desc, r.desc, 8.5); put(at.status, r.status, 8);
      if (at.used && r.used) { try { form.getCheckBox(at.used).check(); } catch { /* not a tick box */ } }
    });
    try { form.updateFieldAppearances(font); form.flatten(); } catch { /* printed as it is */ }
    // Flattening can leave the widgets listed on the page: taken off, so nothing stays fillable.
    for (const p of doc.getPages()) p.node.delete(PDFName.of("Annots"));
    const [page] = await out.copyPages(doc, [0]);
    out.addPage(page);
  }
  return { bytes: await out.save(), pages: chunks };
}

/** What a filled BOM says: its header and every row with something in it.
 *  Null when it isn't a sheet with rows, or nothing is typed in it (a scan
 *  of a hand-filled sheet has no fields to read). */
export async function readBom(bytes: Uint8Array): Promise<{ header: BomHeader; rows: ReadRow[] } | null> {
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(bytes, { ignoreEncryption: true }); } catch { return null; }
  const form = doc.getForm();
  const layout = bomLayoutOf(form);
  if (!layout) return null;
  const val = (name: string | undefined) => { if (!name) return ""; try { return (form.getTextField(name).getText() ?? "").trim(); } catch { return ""; } };
  const header: BomHeader = { wo: val(layout.header.wo), equipment: val(layout.header.equipment), project: val(layout.header.project), date: val(layout.header.date), by: val(layout.header.by) };
  const rows = layout.rows.map((r) => ({ no: val(r.no), qty: val(r.qty), size: val(r.size), desc: val(r.desc) })).filter((r) => r.desc || r.qty || r.size);
  return { header, rows };
}
