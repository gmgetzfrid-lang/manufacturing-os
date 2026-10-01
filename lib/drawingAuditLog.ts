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

import { normalizeRef, refSeries, seriesMatch } from "@/lib/drawingText";

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
  /** Connectors whose box could not be paired: the sheet they continue on
   *  has no box numbers read (a text layer, or a sheet read before connector
   *  boxes were transcribed). Absence of evidence — never broken (DWG-4). */
  unpairedConnectors?: Array<{ from: string; to: string; box: string }>;
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
    /** Connectors whose box could not be paired (DWG-4). */
    unpairedConnectors: string[];
    /** Pages never read (an accepted partial index). */
    unreadPages: string[];
  };
  /** The documents this verdict covers, each with the fingerprint of the
   *  index it was computed from (indexFingerprint) — set by the writer when
   *  verdicts sharing one key are merged (DWG-13). */
  coverage?: Readonly<Record<string, string>>;
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
  const unpaired = new Map<string, string[]>();
  for (const c of findings.unpairedConnectors ?? []) {
    push(unpaired, c.from,
      `Connector ${c.box} continues to ${c.to}, whose box numbers were never read — the pairing was not checked; check the box on that sheet`);
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
    const q = unpaired.get(s.name) ?? [];
    const p = unreadPages.get(s.name) ?? [];
    // An unreadable destination, a pairing nobody could check, or a page
    // nobody read, is absence of evidence: it keeps a sheet from "passing",
    // and never makes it "broken".
    const status: AuditStatus = !s.indexed
      ? "skipped"
      : b.length > 0 ? "broken_connectors"
      : (m.length > 0 || w.length > 0 || u.length > 0 || q.length > 0 || p.length > 0) ? "flagged"
      : "passed";
    return {
      documentId: s.documentId,
      controlledDocumentId: s.controlledDocumentId ?? null,
      sheetNumber: s.sheetNumber,
      revision: s.revision,
      status,
      details: {
        brokenConnectors: b, missingReferences: m, oneWay: w, unreadableConnectors: u, unpairedConnectors: q, unreadPages: p,
      },
    };
  });
}

/** The series a reference or identity belongs to, innermost first: its own
 *  series, and — for one sheet of a drawing ("025-PID-0104-SH2") — the
 *  series of that drawing too ("025-PID"). A sheet of a drawing in a series
 *  the library holds is in that set's scope, whatever else it holds of the
 *  drawing's own sheets. */
function seriesChain(ref: string): string[] {
  const own = refSeries(ref);
  const base = normalizeRef(ref).replace(/-SH\d+$/, "");
  const parent = base !== normalizeRef(ref) ? refSeries(base) : "";
  return [own, parent].filter((x, i, all) => x !== "" && all.indexOf(x) === i);
}

/**
 * The drawing series this library HOLDS (DWG-6): those in which it carries
 * at least two distinct numbers, counted across all its documents —
 * identities: each document's numbers (sheetIdentities).
 *
 * A gap is a statement about a SET: "references 025-PID-0107, which isn't
 * in the set" is only true of a library that holds the 025-PID series. A
 * reference library holding one drawing of it — as one PDF, as a combined
 * PDF of that drawing's sheets, or as one PDF per sheet, all of which share
 * the drawing's own number — would file a gap against a set that is
 * complete elsewhere. So a series is held only when two or more DIFFERENT
 * numbers of it exist in the library: a combined PDF declaring
 * 025-PID-0101/0102/0103 holds 025-PID; two sheets of 025-PID-0104 hold
 * 025-PID-0104's sheets, never 025-PID.
 *
 * A sheet in a series the library does not hold IS still recorded: its
 * connectors and boxes are its own, and a connector that names nothing is a
 * defect of the sheet whatever the set. What it cannot do is define the set.
 */
export function seriesHeldBySet(identities: ReadonlyMap<string, readonly string[]>): string[] {
  const numbers = new Set<string>();
  for (const ids of identities.values()) for (const t of ids) if (t) numbers.add(normalizeRef(t));
  const candidates = new Set<string>();
  for (const t of numbers) { const series = refSeries(t); if (series) candidates.add(series); }
  const held: string[] = [];
  for (const series of candidates) {
    let n = 0;
    for (const t of numbers) if (seriesMatch(refSeries(t), series)) n++;
    if (n >= 2) held.push(series);
  }
  return held.sort();
}

/** Is this reference inside a series the library holds — its own, or (for
 *  a sheet of a drawing) its drawing's? */
function inHeldSeries(ref: string, held: readonly string[]): boolean {
  return seriesChain(ref).some((series) => held.some((h) => seriesMatch(h, series)));
}

/** The series the library's numbers belong to without the library holding
 *  them — recorded on the verdict, so a reader can see what was NOT judged.
 *  Root series only ("025-PID", not also "025-PID-0104" from its -SH1). */
export function seriesNotJudged(identities: ReadonlyMap<string, readonly string[]>): string[] {
  const held = seriesHeldBySet(identities);
  const out = new Set<string>();
  for (const ids of identities.values()) {
    for (const t of ids) {
      if (!t || inHeldSeries(t, held)) continue;
      const chain = seriesChain(t);
      if (chain.length > 0) out.add(chain[chain.length - 1]);
    }
  }
  const all = [...out];
  return all.filter((x) => !all.some((r) => r !== x && x.startsWith(`${r}-`))).sort();
}

/** Missing-sheet findings limited to the series the library holds. A
 *  reference into a series the library has only one number of is out of
 *  the set's scope — exactly like a reference into another unit — never a
 *  gap. */
export function missingWithinHeldSeries<T extends { ref: string }>(missing: readonly T[], held: readonly string[]): T[] {
  return missing.filter((m) => inHeldSeries(m.ref, held));
}

/** A short, stable digest of a string (FNV-1a, 32-bit, hex): enough to tell
 *  one index state, or one sheet list, from another. Never a security hash. */
export function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** What one document's index held when a verdict was computed from it
 *  (DWG-13): every roll-up row (kind, tag, occurrences), every connector
 *  line, and the pages AI vision never read — in a fixed order, digested. A
 *  rebuild that changes what was extracted (a vision re-read that now
 *  transcribes connector boxes) changes it; one that extracts the same rows
 *  does not. */
export function indexFingerprint(index: {
  rows: ReadonlyArray<{ kind: string; tag: string; occurrences: number }>;
  opc: ReadonlyArray<{ tag: string; page: number; raw?: string | null }>;
  unreadPages?: readonly number[];
}): string {
  const rows = index.rows.map((r) => `${r.kind}\u0001${r.tag}\u0001${r.occurrences}`).sort();
  const opc = index.opc.map((o) => `${o.tag}\u0001${o.page}\u0001${o.raw ?? ""}`).sort();
  const unread = [...(index.unreadPages ?? [])].sort((a, b) => a - b).join(",");
  return digest(`${rows.join("\n")}\u0002${opc.join("\n")}\u0002${unread}`);
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
 * verdict (mayReplaceStored).
 *
 * And a row counts as done only for what it COVERED (DWG-13): every
 * document filed under its key must be in the row's `coverage`, with the
 * fingerprint of the index it is indexed from now (`fingerprints`, by
 * knowledge document id — indexFingerprint). Two per-sheet documents of one
 * drawing share its number, so a sibling's verdict never stands for a sheet
 * that was skipped or added since; and a rebuild that changed what a sheet's
 * index holds (connector boxes transcribed at last) re-audits it, under the
 * same revision. A row with no coverage (written before this rule, or by
 * another writer) is not done: it is audited once more, never lowered.
 */
export function sheetsNeedingAudit(
  sheets: readonly AuditSheet[],
  priorAudits: ReadonlyArray<{
    sheet_number: string; revision_code: string; status: string;
    coverage?: Readonly<Record<string, string>> | null;
  }>,
  fingerprints: ReadonlyMap<string, string>,
): AuditSheet[] {
  const done = new Map<string, Readonly<Record<string, string>>>();
  for (const a of priorAudits) {
    if (a.status === "skipped" || a.revision_code === "" || !a.coverage) continue;
    done.set(`${a.sheet_number}@${a.revision_code}`, a.coverage);
  }
  const byKey = new Map<string, AuditSheet[]>();
  for (const s of sheets) {
    const key = `${s.sheetNumber}@${s.revision}`;
    byKey.set(key, [...(byKey.get(key) ?? []), s]);
  }
  const out: AuditSheet[] = [];
  for (const [key, group] of byKey) {
    const covered = done.get(key);
    const whole = !!covered && group.every((s) =>
      s.revision !== "" && fingerprints.has(s.documentId) && covered[s.documentId] === fingerprints.get(s.documentId));
    if (!whole) out.push(...group);
  }
  // Input order, whatever the grouping.
  const need = new Set(out);
  return sheets.filter((s) => need.has(s));
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

/** At most this many sheet numbers are stored on the one row of a run that
 *  carries the list; the count is always stored, and `truncated` says when
 *  the list was cut. */
export const AUDIT_SET_LIST_MAX = 500;

/** Rows ready for upsert into drawing_audit_logs, keyed (org, library,
 *  sheet, revision) — 20261124. `audited_at` is written every time: a
 *  re-recorded row (a `skipped` sheet now read) carries when it was decided,
 *  not when it was first skipped.
 *
 *  The set is stored ONCE per run: every row carries its count and digest
 *  (`set.digest`, of the sorted list), and the first row alone carries the
 *  list itself — a 600-sheet library no longer writes 600 copies of a
 *  500-entry list in one request. A reader finds a row's list on the row of
 *  the same run (`audited_at`) with the same digest. */
export function verdictRows(
  orgId: string, verdicts: readonly SheetVerdict[], byUserId: string,
  scope: AuditScope, auditedAt: string = new Date().toISOString(),
) {
  const sheets = [...new Set(scope.sheets)].sort();
  const set = {
    count: sheets.length,
    digest: digest(sheets.join("\n")),
    truncated: sheets.length > AUDIT_SET_LIST_MAX,
    ...(scope.seriesNotJudged && scope.seriesNotJudged.length > 0
      ? { seriesNotJudged: [...scope.seriesNotJudged] } : {}),
  };
  return verdicts.map((v, i) => ({
    org_id: orgId,
    library_id: scope.libraryId,
    document_id: v.controlledDocumentId,
    sheet_number: v.sheetNumber,
    revision_code: v.revision,
    status: v.status,
    audited_at: auditedAt,
    audit_details: {
      ...v.details, by: byUserId, knowledgeDocumentId: v.documentId,
      libraryId: scope.libraryId,
      set: i === 0 ? { ...set, sheets: sheets.slice(0, AUDIT_SET_LIST_MAX) } : set,
      ...(v.coverage ? { coverage: { ...v.coverage } } : {}),
    },
  }));
}
