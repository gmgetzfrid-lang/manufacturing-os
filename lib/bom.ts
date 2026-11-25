// lib/bom.ts - the bill of materials on a work package, from the materials
// register (the one list of what the job needs). Pure: which lines belong
// to a package, what each prints as in the BOM's columns, and turning a
// filled BOM's rows back into register lines.
//
// The register is the source. A package's BOM is filled from it each time
// the package is printed, so a change to the register is on the next print;
// the builder says when the register changed after the package was printed.

import { STATUS_WORD, type Material, type MaterialFields, type MaterialStatus } from "@/lib/materials";

/** One printed row: the BOM's columns. */
export interface BomRow { no: string; qty: string; size: string; desc: string; status: string; used: boolean }

/** Work order numbers a line's "work order" names ("301470", "301470 / 301471", "WO 301470"). */
export function woNumbers(raw: string | null | undefined): string[] {
  return [...new Set(String(raw ?? "").match(/\d{4,}/g) ?? [])];
}

/** The register's lines for a package: materials (not off-site repairs) on
 *  any of its work orders, not cancelled; by line number, then as added. */
export function bomLinesFor(lines: Material[], wos: string[]): Material[] {
  const want = new Set(wos.flatMap((w) => woNumbers(w)));
  if (!want.size) return [];
  return lines
    .filter((m) => m.kind === "material" && m.status !== "cancelled" && woNumbers(m.workOrder).some((n) => want.has(n)))
    .sort((a, b) => (a.lineNo ?? Number.MAX_SAFE_INTEGER) - (b.lineNo ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** What a line says in the BOM's DESCRIPTION: its item and specification,
 *  once each ("Gasket" + "Spiral wound 316/FG, CL300"). */
export function describe(m: Pick<MaterialFields, "item" | "spec">): string {
  const item = m.item.trim(), spec = m.spec.trim();
  if (!spec) return item;
  if (!item || spec.toLowerCase().startsWith(item.toLowerCase())) return spec;
  return `${item}, ${spec}`;
}

/** Short status words that fit the column. */
const SHORT: Partial<Record<MaterialStatus, string>> = { to_specify: "Spec needed", ready: "To order", checked: "Rec'd, checked", short: "Short/wrong" };
export const statusShort = (s: MaterialStatus) => SHORT[s] ?? STATUS_WORD[s];

/** The printed rows, numbered by line number (or in order when a line has none). */
export function bomRows(lines: Material[]): BomRow[] {
  return lines.map((m, i) => ({
    no: String(m.lineNo ?? i + 1), qty: m.qty.trim(), size: m.size.trim(), desc: describe(m), status: statusShort(m.status), used: m.status === "used",
  }));
}

/** Lines changed since a time (ISO): what makes a printed BOM out of date. */
export function changedSince(lines: Material[], iso: string | null | undefined): Material[] {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return [];
  return lines.filter((m) => m.updatedAt > t || m.createdAt > t);
}

// ── A filled BOM read back ──────────────────────────────────────────────

/** A row read off a filled BOM (a PDF typed into, not a scan). */
export interface ReadRow { no: string; qty: string; size: string; desc: string }

/** Split a DESCRIPTION into the register's item and specification: the
 *  item is what comes before the first comma ("Gasket, spiral wound 316" →
 *  "Gasket" / "spiral wound 316"); without a comma it is the whole line. */
export function splitDescription(desc: string): { item: string; spec: string } {
  const d = desc.replace(/\s+/g, " ").trim();
  const at = d.indexOf(",");
  if (at > 0 && at < 60) return { item: d.slice(0, at).trim(), spec: d.slice(at + 1).trim() };
  return { item: d, spec: "" };
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** What a read BOM adds or changes in the register, line by line: a row
 *  matching a line on the same work order (same description and size) is
 *  that line (its quantity or number may change); anything else is new. */
export interface ImportPlan {
  add: Array<{ row: ReadRow; item: string; spec: string }>;
  change: Array<{ row: ReadRow; line: Material; qty?: string; lineNo?: number }>;
  same: number;
}
export function planImport(rows: ReadRow[], existing: Material[]): ImportPlan {
  const out: ImportPlan = { add: [], change: [], same: 0 };
  const used = new Set<string>();
  for (const row of rows) {
    if (!row.desc.trim() && !row.qty.trim()) continue;
    const hit = existing.find((m) => !used.has(m.id) && key(describe(m)) === key(row.desc) && key(m.size) === key(row.size));
    const no = Number.parseInt(row.no, 10);
    if (hit) {
      used.add(hit.id);
      const qty = row.qty.trim() && row.qty.trim() !== hit.qty.trim() ? row.qty.trim() : undefined;
      const lineNo = Number.isFinite(no) && no !== hit.lineNo ? no : undefined;
      if (qty !== undefined || lineNo !== undefined) out.change.push({ row, line: hit, qty, lineNo });
      else out.same++;
      continue;
    }
    out.add.push({ row, ...splitDescription(row.desc) });
  }
  return out;
}
