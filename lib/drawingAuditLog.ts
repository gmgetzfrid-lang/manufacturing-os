// lib/drawingAuditLog.ts — turning a drawing audit into a RECORD.
//
// The audit itself already exists and is careful (lib/drawingText.ts). What
// was missing is memory. Without it every question about a drawing set is
// answered by re-reading the whole set, and nobody can say "we checked that
// sheet at Rev C and it was clean" — which is the only form the answer is
// useful in. An audit you can't cite is an opinion.
//
// The verdict rules are pure and live here, so what gets written to the
// permanent record is unit-tested rather than emergent from a route handler.
//
// One deliberate omission: a reference pointing into a unit you were never
// given is NOT a finding. The audit already separates those, and treating
// them as defects manufactures alarm about drawings that are probably
// perfect. Only what's actionable becomes a verdict.
//
// The record's key is (org, library, sheet, revision) — 20261124 (DWG-6):
// the same controlled sheet mirrored into two libraries is audited against
// two different sets, and one library's verdict must never overwrite the
// other's. Rows with no library (written before the key, or by the
// orchestrator's log_audit_completion) are org-wide: library_id NULL, unique
// among themselves (NULLS NOT DISTINCT).

import { refSeries, seriesMatch } from "@/lib/drawingText";

export type AuditStatus = "passed" | "broken_connectors" | "flagged" | "skipped";

/** Severity order. A stored verdict is never replaced by a LESS severe one
 *  at the same key (DWG-6): a re-index in progress (`skipped`) must not
 *  erase a recorded `broken_connectors`. Exported for every writer of
 *  drawing_audit_logs — the drawing route here, and the orchestrator's
 *  log_audit_completion. */
export const RANK: Readonly<Record<AuditStatus, number>> = {
  skipped: 0, passed: 1, flagged: 2, broken_connectors: 3,
};

/** True when writing `next` over `stored` would lower the recorded
 *  severity. An unknown stored status is treated as the most severe —
 *  never overwritten on a guess. */
export function wouldLowerSeverity(stored: string | null | undefined, next: AuditStatus): boolean {
  if (!stored) return false;
  const was = (RANK as Record<string, number>)[stored];
  return was === undefined ? true : RANK[next] < was;
}

/** One sheet as the auditor sees it. `name` must be the same string the
 *  findings refer to it by — the audit reports by display name. */
export interface AuditSheet {
  documentId: string;
  controlledDocumentId?: string | null;
  name: string;
  /** Declared drawing number where the title block gave one, else the name.
   *  This is the audit's key, so it has to be the sheet's real identity. */
  sheetNumber: string;
  /** "" when the revision isn't known — recorded honestly rather than
   *  guessed, because a verdict filed under the wrong revision is worse
   *  than no verdict at all. */
  revision: string;
  /** False when nothing was extracted from it: a scan, or not yet indexed.
   *  Those are SKIPPED, never passed — silence is not a clean bill. */
  indexed: boolean;
}

/** What the reference audit found, by sheet display name. */
export interface AuditFindings {
  /** Off-page connectors that name no destination drawing at all. */
  connectorsWithNoTarget: Array<{ sheet: string; box: string }>;
  /** Connector leaves a sheet; the named sheet has no matching box. */
  unreturnedConnectors: Array<{ from: string; to: string; box: string }>;
  /** Referenced sheets from a loaded series that aren't in the set. */
  missingInSeries: Array<{ ref: string; referencedBy: string[] }>;
  /** Both sheets loaded, target never references back. */
  oneWay: Array<{ from: string; to: string }>;
  /** Connectors whose destination could not be read — the stored line may
   *  have been cut before it (DWG-8), or it is not shaped like a drawing
   *  number: unknown, so worth a look — never broken. */
  unreadableConnectors?: Array<{ sheet: string; box: string }>;
  /** Pages AI vision never read on a sheet whose partial index was
   *  accepted: nothing on them — connectors included — was audited. */
  unreadPages?: Array<{ sheet: string; pages: readonly number[] }>;
}

export interface SheetVerdict {
  documentId: string;
  controlledDocumentId: string | null;
  sheetNumber: string;
  revision: string;
  status: AuditStatus;
  details: {
    brokenConnectors: string[];
    missingReferences: string[];
    oneWay: string[];
    /** Connectors whose destination could not be read (DWG-8). */
    unreadableConnectors: string[];
    /** Pages never read (an accepted partial index). */
    unreadPages: string[];
  };
}

/**
 * A verdict per sheet.
 *
 * Severity is ordered, not summed: a sheet with a connector going nowhere is
 * `broken_connectors` even if it also has missing references, because that's
 * the finding somebody has to act on first.
 */
export function verdictsForSheets(
  sheets: readonly AuditSheet[],
  findings: AuditFindings,
): SheetVerdict[] {
  const broken = new Map<string, string[]>();
  const missing = new Map<string, string[]>();
  const oneWay = new Map<string, string[]>();

  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key) ?? [];
    if (!list.includes(value)) list.push(value);
    map.set(key, list);
  };

  for (const c of findings.connectorsWithNoTarget) {
    push(broken, c.sheet, `Connector ${c.box} names no destination drawing`);
  }
  for (const c of findings.unreturnedConnectors) {
    push(broken, c.from, `Connector ${c.box} continues to ${c.to}, which has no matching box`);
  }
  for (const m of findings.missingInSeries) {
    // A missing sheet is a finding against every sheet that pointed at it —
    // that's who has to chase it.
    for (const by of m.referencedBy) push(missing, by, `References ${m.ref}, which isn't in the set`);
  }
  for (const o of findings.oneWay) {
    push(oneWay, o.from, `References ${o.to}, which never references back`);
  }
  const unreadable = new Map<string, string[]>();
  for (const c of findings.unreadableConnectors ?? []) {
    push(unreadable, c.sheet,
      `Connector ${c.box}: its destination could not be read — check it on the sheet`);
  }
  const unreadPages = new Map<string, string[]>();
  for (const u of findings.unreadPages ?? []) {
    if (u.pages.length === 0) continue;
    push(unreadPages, u.sheet,
      `Page(s) ${u.pages.join(", ")} were never read by AI vision (partial index accepted) — nothing on them was audited`);
  }

  return sheets.map((s) => {
    const b = broken.get(s.name) ?? [];
    const m = missing.get(s.name) ?? [];
    const w = oneWay.get(s.name) ?? [];
    const u = unreadable.get(s.name) ?? [];
    const p = unreadPages.get(s.name) ?? [];
    // An unreadable destination, or a page nobody read, is absence of
    // evidence: it keeps a sheet from "passing", and never makes it
    // "broken".
    const status: AuditStatus = !s.indexed
      ? "skipped"
      : b.length > 0 ? "broken_connectors"
      : (m.length > 0 || w.length > 0 || u.length > 0 || p.length > 0) ? "flagged"
      : "passed";
    return {
      documentId: s.documentId,
      controlledDocumentId: s.controlledDocumentId ?? null,
      sheetNumber: s.sheetNumber,
      revision: s.revision,
      status,
      details: { brokenConnectors: b, missingReferences: m, oneWay: w, unreadableConnectors: u, unreadPages: p },
    };
  });
}

/**
 * Sheets that are the only sheet of their drawing series in this library
 * (DWG-6). `identities`: each document's numbers (sheetIdentities).
 *
 * A gap is a statement about a SET: "references 025-PID-0107, which isn't
 * in the set" is only true of a library that holds the 025-PID series. A
 * reference library holding one mirrored sheet of it would file a gap
 * against a set that is complete elsewhere. A document holds a series of
 * its own when it declares several numbers of one series itself — a
 * combined PDF declaring 025-PID-0101/0102/0103, or a drawing's sheets
 * (-SH1, -SH2) — and otherwise shares one when another document's series
 * matches.
 *
 * Such a sheet IS still recorded: its connectors and boxes are its own, and
 * a connector that names no drawing is a defect of the sheet whatever the
 * set. What it cannot do is define the set — see seriesHeldBySet.
 */
export function sheetsAloneInTheirSeries(identities: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seriesOf = new Map<string, string[]>();
  for (const [doc, ids] of identities) {
    seriesOf.set(doc, [...new Set(ids.map((t) => refSeries(t)).filter(Boolean))]);
  }
  const alone = new Set<string>();
  for (const [doc, ids] of identities) {
    // Several numbers of one series declared by the document itself.
    const perSeries = new Map<string, Set<string>>();
    for (const t of new Set(ids)) {
      const series = refSeries(t);
      if (!series) continue;
      perSeries.set(series, (perSeries.get(series) ?? new Set<string>()).add(t));
    }
    if ([...perSeries.values()].some((set) => set.size > 1)) continue;
    const mine = seriesOf.get(doc) ?? [];
    const shared = [...seriesOf].some(([other, theirs]) =>
      other !== doc && theirs.some((t) => mine.some((m) => seriesMatch(m, t))));
    if (!shared) alone.add(doc);
  }
  return alone;
}

/** The drawing series this library HOLDS: those of every document that is
 *  not alone in its series. "Isn't in the set" is a finding only inside
 *  one of these. */
export function seriesHeldBySet(
  identities: ReadonlyMap<string, readonly string[]>, alone: ReadonlySet<string>,
): string[] {
  const held = new Set<string>();
  for (const [doc, ids] of identities) {
    if (alone.has(doc)) continue;
    for (const t of ids) { const series = refSeries(t); if (series) held.add(series); }
  }
  return [...held].sort();
}

/** The series a sheet alone in its series brings into the library without
 *  the library holding them — recorded on the verdict, so a reader can see
 *  what was NOT judged. */
export function seriesNotJudged(
  identities: ReadonlyMap<string, readonly string[]>, alone: ReadonlySet<string>,
): string[] {
  const held = seriesHeldBySet(identities, alone);
  const out = new Set<string>();
  for (const doc of alone) {
    for (const t of identities.get(doc) ?? []) {
      const series = refSeries(t);
      if (series && !held.some((h) => seriesMatch(h, series))) out.add(series);
    }
  }
  // Root series only — "025-PID", not also "025-PID-0104" from its -SH1.
  const all = [...out];
  return all.filter((x) => !all.some((r) => r !== x && x.startsWith(`${r}-`))).sort();
}

/** Missing-sheet findings limited to the series the library holds. A
 *  reference into a series the library has only one sheet of is out of the
 *  set's scope — exactly like a reference into another unit — never a gap. */
export function missingWithinHeldSeries<T extends { ref: string }>(missing: readonly T[], held: readonly string[]): T[] {
  return missing.filter((m) => {
    const series = refSeries(m.ref);
    return held.some((h) => seriesMatch(h, series));
  });
}

/**
 * Which sheets actually need auditing.
 *
 * The whole point of the record: a sheet already audited at the revision in
 * front of you is done. A sheet audited at a DIFFERENT revision is not — it
 * has been redrawn since, and the old verdict says nothing about the new
 * drawing. `skipped` never counts as done, because it means we couldn't read
 * the sheet, not that we cleared it.
 *
 * Nor does a verdict filed under an UNKNOWN revision (""): "unrevised" can't
 * be established for a sheet whose revision nobody knows — a library-only
 * PDF replaced by a corrected drawing, or a set widened since, still reads
 * "". Such a sheet is audited every time, and its row takes the latest
 * verdict (unknownRevisionReplaceable).
 */
export function sheetsNeedingAudit(
  sheets: readonly AuditSheet[],
  priorAudits: ReadonlyArray<{ sheet_number: string; revision_code: string; status: string }>,
): AuditSheet[] {
  const done = new Set(
    priorAudits
      .filter((a) => a.status !== "skipped" && a.revision_code !== "")
      .map((a) => `${a.sheet_number}@${a.revision_code}`),
  );
  return sheets.filter((s) => s.revision === "" || !done.has(`${s.sheetNumber}@${s.revision}`));
}

/** May `next` be written over the row stored at this key? Never lower a
 *  known revision's verdict (RANK). A row under an unknown revision ("")
 *  takes the latest computation — it can't be told apart from the drawing
 *  that replaced it — except `skipped`, which only says the sheet could not
 *  be read right now and never erases a verdict. */
export function mayReplaceStored(
  stored: { revision_code: string; status: string } | null | undefined, next: AuditStatus,
): boolean {
  if (!stored) return true;
  if (stored.revision_code === "") return next !== "skipped" || stored.status === "skipped";
  return !wouldLowerSeverity(stored.status, next);
}

/** The set a verdict was computed against (DWG-6): which library, and
 *  which sheets "the set" meant — so a reader can tell what "isn't in the
 *  set" referred to. */
export interface AuditScope {
  libraryId: string;
  /** Every sheet number in the library when the verdict was computed. */
  sheets: readonly string[];
  /** Series present only as a lone sheet (seriesNotJudged): gaps in them
   *  were not judged. */
  seriesNotJudged?: readonly string[];
}

/** At most this many sheet numbers are stored per row; the count is
 *  always stored, and `truncated` says when the list was cut. */
export const AUDIT_SET_LIST_MAX = 500;

/** Rows ready for upsert into drawing_audit_logs, keyed (org, library,
 *  sheet, revision) — 20261124. `audited_at` is written every time: a
 *  re-recorded row (a `skipped` sheet now read) carries when it was decided,
 *  not when it was first skipped. */
export function verdictRows(
  orgId: string, verdicts: readonly SheetVerdict[], byUserId: string,
  scope: AuditScope, auditedAt: string = new Date().toISOString(),
) {
  const sheets = [...new Set(scope.sheets)].sort();
  const set = {
    count: sheets.length,
    sheets: sheets.slice(0, AUDIT_SET_LIST_MAX),
    truncated: sheets.length > AUDIT_SET_LIST_MAX,
    ...(scope.seriesNotJudged && scope.seriesNotJudged.length > 0
      ? { seriesNotJudged: [...scope.seriesNotJudged] } : {}),
  };
  return verdicts.map((v) => ({
    org_id: orgId,
    library_id: scope.libraryId,
    document_id: v.controlledDocumentId,
    sheet_number: v.sheetNumber,
    revision_code: v.revision,
    status: v.status,
    audited_at: auditedAt,
    audit_details: {
      ...v.details, by: byUserId, knowledgeDocumentId: v.documentId,
      libraryId: scope.libraryId, set,
    },
  }));
}
