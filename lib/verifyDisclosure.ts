// lib/verifyDisclosure.ts — what a PUBLIC verify answer may name about a
// document (public-surfaces VFY-16; intelligence DACL-8 / DACL-3).
//
// The verify endpoints are unauthenticated by design (PHYS-4): whoever holds
// the paper scans it. For a private or hidden document the verdict is still
// answered — current, stale, held — but without its number or title: the
// fail-safe default DEC-90 recorded (less disclosure). A visibility the
// route could not read is treated as hidden.

/** The label a verify answer shows in place of a restricted document's. */
export const RESTRICTED_DOCUMENT_LABEL = "Restricted document";

/** May a public verify answer name this document (number, title, name)?
 *  Only when its row was read WITH `visibility` and that is "normal" or
 *  unset (NULL — the database's "normal", node_visible's first branch).
 *  Private, hidden, any other value, or a row read without the column
 *  (undefined) — not named. */
export function verifyMayNameDocument(row: { visibility?: unknown } | null | undefined): boolean {
  if (!row || !("visibility" in row)) return false;
  return row.visibility === null || row.visibility === "normal";
}

/** DACL-8 criterion 3 (intelligence I-12, the DEC-90 less-disclosing
 *  default): a work-pack cover QR WITHOUT a print id cannot say which
 *  printing it is — its sheet list would be the package's LIVE membership,
 *  which is not what the paper carries (it is never green, DEC-65 §2), and
 *  is read in no order, so no position in it is a position on the paper.
 *  Its verdict is still answered, but NO row names or numbers a sheet:
 *  the sheets are COUNTED by state, one row per state — "2 of 6 sheets ·
 *  SUPERSEDED", "1 of 6 sheets · ON HOLD" — in a fixed order (stop-work
 *  first). Review fix: the first build named each sheet "Sheet N" by its
 *  index in that unordered list, which matched no sheet in the folder. A
 *  cover QR that names its print (`?print=`) answers exactly the printed
 *  sheets, named as before. */
export interface LegacyCoverSheet {
  state: string;
  held: boolean;
  holdReasons: string[];
  retired: boolean;
}

/** One counted row of a legacy cover's answer (the pack page renders it as
 *  a sheet row: the count on the left, the state on the right). */
export interface LegacyCoverStateRow {
  label: string;
  printedRev: null;
  currentRev: null;
  state: string;
  fresh: false;
  retired: boolean;
  held: boolean;
  holdReasons: string[];
}

/** The order the counted rows are listed in: stop-work first, then
 *  withdrawn, then gone, then not issued, then "printing unknown". */
const LEGACY_STATE_ORDER = [
  "held", "superseded", "void", "archived", "retired", "missing",
  "status_unrecognised", "not_issued", "draft", "unconfirmed",
];

/** "2 of 6 sheets" — a count, never a position. */
export function legacyCoverCountLabel(count: number, total: number): string {
  return `${count} of ${total} sheet${total === 1 ? "" : "s"}`;
}

/** DACL-8 criterion 3: a legacy cover's per-sheet answer, counted by state
 *  (see above). Pure: the route computes each sheet's state as before and
 *  hands the list here; the verdict and the counts are computed from the
 *  per-sheet list, not from these rows. */
export function legacyCoverStateRows(sheets: readonly LegacyCoverSheet[]): LegacyCoverStateRow[] {
  const total = sheets.length;
  const groups = new Map<string, { count: number; held: boolean; retired: boolean; reasons: Set<string> }>();
  for (const s of sheets) {
    const g = groups.get(s.state) ?? { count: 0, held: false, retired: false, reasons: new Set<string>() };
    g.count += 1;
    g.held = g.held || s.held;
    g.retired = g.retired || s.retired;
    for (const r of s.holdReasons) g.reasons.add(r);
    groups.set(s.state, g);
  }
  const rank = (state: string) => {
    const i = LEGACY_STATE_ORDER.indexOf(state);
    return i === -1 ? LEGACY_STATE_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([state, g]) => ({
      label: legacyCoverCountLabel(g.count, total),
      printedRev: null,
      currentRev: null,
      state,
      fresh: false,
      retired: g.retired,
      held: g.held,
      holdReasons: [...g.reasons],
    }));
}
