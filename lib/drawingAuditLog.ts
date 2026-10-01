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
 *  log_audit_completion. A row whose audit_details carries `provisional`
 *  settled only its `provisional.settledStatus`: that, not its status, is
 *  what is never lowered (replaceDecision — review fix pass 5). */
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
  /** Referenced sheets from a loaded series that aren't in the set. A gap
   *  that a document parked on AI vision may yet hold on a page it has not
   *  read is filed, and waits on it (`waitsOn` — review fix pass 8). */
  missingInSeries: Array<{ ref: string; referencedBy: string[]; waitsOn?: readonly string[] }>;
  /** Both sheets loaded, target never references back. */
  oneWay: Array<{ from: string; to: string }>;
  /** Connectors whose destination could not be read — the stored line may
   *  have been cut before it (DWG-8), or it is not shaped like a drawing
   *  number: unknown, so worth a look — never broken. */
  unreadableConnectors?: Array<{ sheet: string; box: string }>;
  /** Connectors whose box could not be paired: the sheet they continue on
   *  has no box numbers read (a text layer, or a sheet read before connector
   *  boxes were transcribed), or was not read whole and the box is not on
   *  what was read of it (`unread` says why — review fix pass 4), or is a
   *  page of a document read whole on which no box numbers were read (`why`
   *  says which — review fix pass 5), or may be a page of it whose drawing
   *  number and box numbers were both never read, or is declared by no
   *  document while one not read whole for now may hold it (`why` says
   *  which — review fix passes 6 and 7), or is a sheet no page of its
   *  drawing declares (review fix pass 7). Absence of evidence — never
   *  broken (DWG-4). */
  unpairedConnectors?: Array<{ from: string; to: string; box: string; unread?: string; why?: string; waitsOn?: readonly string[] }>;
  /** References whose check needed a sheet that was not read whole: the
   *  target was not found to reference back on what was read of it
   *  (`to`), or a sheet in scope was not found and may be in such a
   *  document (`ref`, `maybeIn`). Unchecked — never one-way, never a gap
   *  (review fix pass 4). */
  oneWayUnread?: Array<{ from: string; to: string; unread: string; waitsOn?: readonly string[] }>;
  missingUnread?: Array<{ ref: string; referencedBy: string[]; maybeIn: readonly string[]; waitsOn?: readonly string[] }>;
  /** Pages AI vision never read: nothing on them — connectors included —
   *  was audited. `why` says whose decision left them unread: "partial index
   *  accepted" (the default) only for a controller's accepted partial index;
   *  a sheet still waiting on AI vision, or whose indexing failed, says so
   *  (review fix pass 4). */
  unreadPages?: Array<{ sheet: string; pages: readonly number[]; why?: string }>;
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
    /** References not checked because a sheet they need was not read whole
     *  (review fix pass 4). */
    uncheckedReferences: string[];
    /** Pages never read by AI vision, and why. */
    unreadPages: string[];
  };
  /** The documents this verdict covers, each with the basis it was computed
   *  from (verdictBasis: its own index, its neighbours', the set) — set by
   *  the writer when verdicts sharing one key are merged (DWG-13). */
  coverage?: Readonly<Record<string, string>>;
  /** Set when a finding of this verdict waits on a document that is only
   *  for now not read whole — parked on AI vision, failed, or still being
   *  indexed (an accepted partial index never changes, so it is never
   *  "for now") — or when a document filed under the same key is, and its
   *  findings are not in the verdict yet (awaitingFiled — review fix pass
   *  7). `waitingOn` names those documents, with why;
   *  `settledStatus` is the verdict without those findings: what the sheet
   *  is known to be whatever they turn out to be. A provisional verdict
   *  never overwrites a settled one for what is unsettled in it, and the
   *  next computation may replace it down to its settled status
   *  (replaceDecision — review fix pass 5). */
  provisional?: { waitingOn: readonly string[]; settledStatus: AuditStatus };
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

  // Which findings are settled (true whatever a document not read whole
  // turns out to hold), and which documents the others wait on.
  const settled = new Map<string, Set<string>>();
  const waiting = new Map<string, Set<string>>();
  const push = (map: Map<string, string[]>, key: string, value: string, waitsOn?: readonly string[]) => {
    const list = map.get(key) ?? [];
    if (!list.includes(value)) list.push(value);
    map.set(key, list);
    const into = waitsOn && waitsOn.length > 0 ? waiting : settled;
    const set = into.get(key) ?? new Set<string>();
    for (const x of into === waiting ? waitsOn! : [value]) set.add(x);
    into.set(key, set);
  };

  for (const c of findings.connectorsWithNoTarget) {
    push(broken, c.sheet, `Connector ${c.box} names no destination drawing`);
  }
  for (const c of findings.unreturnedConnectors) {
    push(broken, c.from, `Connector ${c.box} continues to ${c.to}, which has no matching box`);
  }
  for (const m of findings.missingInSeries) {
    // A missing sheet is a finding against every sheet that pointed at it —
    // that's who has to chase it. The caller passes EVERY referencer, never
    // a display cut (review fix pass 5).
    for (const by of m.referencedBy) push(missing, by, `References ${m.ref}, which isn't in the set`, m.waitsOn);
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
    push(unpaired, c.from, c.unread
      ? `Connector ${c.box} continues to ${c.to}, which was not read whole (${c.unread}) — the box is not on what was read of it, so the pairing was not checked; check the box on that sheet`
      : c.why
        ? `Connector ${c.box} continues to ${c.to}: ${c.why} — the pairing was not checked; check the box on that sheet`
        : `Connector ${c.box} continues to ${c.to}, whose box numbers were never read — the pairing was not checked; check the box on that sheet`,
    c.waitsOn);
  }
  const unchecked = new Map<string, string[]>();
  for (const o of findings.oneWayUnread ?? []) {
    push(unchecked, o.from,
      `References ${o.to}, which was not read whole (${o.unread}) — whether it references back was not checked`, o.waitsOn);
  }
  for (const m of findings.missingUnread ?? []) {
    for (const by of m.referencedBy) {
      push(unchecked, by,
        `References ${m.ref}, which was not found in what was read of the set — it may be in ${m.maybeIn.join("; ")}, not read whole`,
        m.waitsOn);
    }
  }
  const unreadPages = new Map<string, string[]>();
  for (const u of findings.unreadPages ?? []) {
    if (u.pages.length === 0) continue;
    push(unreadPages, u.sheet,
      `Page(s) ${u.pages.join(", ")} were never read by AI vision (${u.why ?? "partial index accepted"}) — nothing on them was audited`);
  }

  return sheets.map((s) => {
    const b = broken.get(s.name) ?? [];
    const m = missing.get(s.name) ?? [];
    const w = oneWay.get(s.name) ?? [];
    const u = unreadable.get(s.name) ?? [];
    const q = unpaired.get(s.name) ?? [];
    const c = unchecked.get(s.name) ?? [];
    const p = unreadPages.get(s.name) ?? [];
    // An unreadable destination, a pairing nobody could check, a reference
    // whose check needed a sheet nobody read whole, or a page nobody read, is
    // absence of evidence: it keeps a sheet from "passing", and never makes
    // it "broken".
    const statusOf = (keep: (x: string) => boolean): AuditStatus => !s.indexed
      ? "skipped"
      : b.some(keep) ? "broken_connectors"
      : [m, w, u, q, c, p].some((list) => list.some(keep)) ? "flagged"
      : "passed";
    const status = statusOf(() => true);
    // What is known whatever the documents it waits on turn out to hold.
    const known = settled.get(s.name) ?? new Set<string>();
    const waitsOn = s.indexed ? [...(waiting.get(s.name) ?? [])].sort() : [];
    return {
      documentId: s.documentId,
      controlledDocumentId: s.controlledDocumentId ?? null,
      sheetNumber: s.sheetNumber,
      revision: s.revision,
      status,
      details: {
        brokenConnectors: b, missingReferences: m, oneWay: w, unreadableConnectors: u, unpairedConnectors: q,
        uncheckedReferences: c, unreadPages: p,
      },
      ...(waitsOn.length > 0 ? { provisional: { waitingOn: waitsOn, settledStatus: statusOf((x) => known.has(x)) } } : {}),
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
 * identities: each document's REAL drawing numbers (sheetDrawingNumbers —
 * never sheetIdentities' filename fallback: "Pump Manual.pdf" is no number
 * of a series "PUMP", and a prose document never makes one held or "not
 * judged", review fix pass 9). seriesNotJudged takes the same.
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

/** Unchecked missing sheets (auditDrawingRefs `missingUnread`) the set
 *  judges: those in a held series, as missingWithinHeldSeries — and, while
 *  a document that may hold one is still being read (`stillReading`), that
 *  one whatever the held series now. The held series are counted from what
 *  is declared NOW, and the document being read may be what made the series
 *  held: reset by a rebuild, it declares nothing yet, and dropping its
 *  sheets let a recorded gap under an unknown revision be overwritten with a
 *  settled `passed` (review fix pass 7). Kept, the finding waits on that
 *  document and is judged again once it is read. */
export function missingUnreadInScope<T extends { ref: string; maybeInIds: readonly string[] }>(
  missing: readonly T[], held: readonly string[], stillReading: ReadonlySet<string>,
): T[] {
  return missing.filter((m) => inHeldSeries(m.ref, held) || m.maybeInIds.some((id) => stillReading.has(id)));
}

/** At most this many documents are named where a verdict says what it waits
 *  on — on the stored row and in the response; the rest are counted. Mid-
 *  rebuild every document still being read may hold a missing sheet, so an
 *  uncut list grew with the library on every row (review fix pass 7). */
export const WAITING_NAMES_MAX = 6;

/** A waiting list cut for storage and display: the first WAITING_NAMES_MAX
 *  names, then "N more document(s) not read whole". */
export function capWaitingOn(names: readonly string[], max: number = WAITING_NAMES_MAX): string[] {
  return names.length <= max ? [...names] : [...names.slice(0, max), `${names.length - max} more document(s) not read whole`];
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
 *  (DWG-13): every roll-up row (kind, tag, occurrences — and, for a title
 *  block's own number, the pages it is declared on: box pairing reads the
 *  sheet by its page, review fix pass 5), every connector line, and the
 *  pages AI vision never read — in a fixed order, digested. A rebuild that
 *  changes what was extracted (a vision re-read that now transcribes
 *  connector boxes) changes it; one that extracts the same rows does not. */
export function indexFingerprint(index: {
  rows: ReadonlyArray<{ kind: string; tag: string; occurrences: number; pages?: readonly number[] }>;
  opc: ReadonlyArray<{ tag: string; page: number; raw?: string | null }>;
  unreadPages?: readonly number[];
}): string {
  const rows = index.rows.map((r) => `${r.kind}\u0001${r.tag}\u0001${r.occurrences}` +
    (r.kind === "self" && r.pages ? `\u0001${[...r.pages].sort((a, b) => a - b).join(",")}` : "")).sort();
  const opc = index.opc.map((o) => `${o.tag}\u0001${o.page}\u0001${o.raw ?? ""}`).sort();
  const unread = [...(index.unreadPages ?? [])].sort((a, b) => a - b).join(",");
  return digest(`${rows.join("\n")}\u0002${opc.join("\n")}\u0002${unread}`);
}

/** What a verdict on one document was computed FROM (DWG-13, review fix
 *  pass 3): its own index (`own`, indexFingerprint), the index of every
 *  document its connectors and references resolve to (`neighbours`, each
 *  "<id>:<indexFingerprint>") — whether a box comes back, or a reference is
 *  returned, is read off THAT sheet — and the set it was judged against
 *  (`set`, a digest of every number the library's sheets answer to, and of
 *  which documents are not read whole: what is missing, which series are
 *  held). Written as "<own>+<neighbourhood digest>"; compared whole. A
 *  verdict taken from a neighbour that is only for now not read whole is
 *  provisional (SheetVerdict.provisional), and its basis changes once that
 *  neighbour is read whole, so it is judged again then (review fix pass 5). */
export function verdictBasis(own: string, neighbours: readonly string[], set: string): string {
  return `${own}+${digest(`${[...neighbours].sort().join("\n")}\u0002${set}`)}`;
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
 * verdict (mayReplaceStored / replaceDecision).
 *
 * And a row counts as done only for what it COVERED (DWG-13): every
 * document filed under its key must be in the row's `coverage`, with the
 * basis its verdict would be computed from now (`fingerprints`, by
 * knowledge document id — verdictBasis). Two per-sheet documents of one
 * drawing share its number, so a sibling's verdict never stands for a sheet
 * that was skipped or added since; a rebuild that changed what a sheet's
 * index holds (connector boxes transcribed at last) re-audits it, under the
 * same revision; and so does a change in a sheet it points at (review fix
 * pass 3) — the sheet its box continues on re-read with different box
 * numbers, a referenced sheet that now references back or no longer does —
 * or in the set (a sheet added that makes a gap judgeable, or fills one).
 * A row with no coverage (written before this rule, or by another writer)
 * is not done: it is audited once more, never lowered.
 *
 * A sheet whose verdict waits on a document that is only for now not read
 * whole (parked, failed, still being indexed) is judged like any other, and
 * its verdict is provisional: it never overwrites a settled row for what is
 * unsettled in it (replaceDecision) (review fix pass 5 — fix pass 4 refused
 * to record at all while a sheet was being indexed, and let a parked or
 * failed neighbour raise a settled `passed` for good).
 *
 * And a row written PROVISIONAL (its `provisional` marker,
 * storedProvisional) is never done, whatever its basis: it is judged again
 * on every record until a settled verdict replaces it (review fix pass 9).
 * Its basis changes when the document it waits on is read whole — but not
 * when that document stops being "for now" WITHOUT being read: a
 * controller accepts its partial index, or a parked document's indexing
 * fails. Its unread pages, and so its label and its index, are the same;
 * fix pass 8 then answered the row "already recorded" for good, a `flagged`
 * at a known revision still waiting on a document that no longer waits,
 * where the computation was `passed`. replaceDecision keeps a re-judgement
 * from lowering what the row settled.
 */
export function sheetsNeedingAudit(
  sheets: readonly AuditSheet[],
  priorAudits: ReadonlyArray<{
    sheet_number: string; revision_code: string; status: string;
    coverage?: Readonly<Record<string, string>> | null;
    provisional?: { settledStatus: string } | null;
  }>,
  fingerprints: ReadonlyMap<string, string>,
): AuditSheet[] {
  const done = new Map<string, Readonly<Record<string, string>>>();
  for (const a of priorAudits) {
    if (a.status === "skipped" || a.revision_code === "" || !a.coverage || a.provisional) continue;
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
 *  be read right now and never erases a verdict. For a settled verdict over
 *  a settled row; replaceDecision is the whole rule. */
export function mayReplaceStored(
  stored: { revision_code: string; status: string } | null | undefined, next: AuditStatus,
): boolean {
  return replaceDecision(stored, { status: next }) === "write";
}

/** The provisional marker a stored row carries (audit_details.provisional),
 *  read defensively: anything else is no marker. */
export function storedProvisional(details: unknown): { settledStatus: string } | null {
  const p = (details as { provisional?: unknown } | null)?.provisional as { settledStatus?: unknown } | undefined;
  return p && typeof p === "object" && typeof p.settledStatus === "string" ? { settledStatus: p.settledStatus } : null;
}

/**
 * What to do with the row stored at a verdict's key (review fix pass 5):
 *   "write" — replace it;
 *   "keep"  — leave it: `next` would lower what it settled (RANK);
 *   "wait"  — leave it, and its coverage, untouched: `next` differs from it
 *             only in findings that wait on a document that is for now not
 *             read whole. Once that document is read whole the sheet's basis
 *             changes and it is judged again.
 *
 * A stored row's floor is what it SETTLED: its status, or — for a row
 * written provisional — its settled status. A known revision's floor is
 * never lowered. A provisional `next` changes a settled row only when what
 * it settled is more severe than the row (a real finding); otherwise it
 * waits — a parked neighbour never turns a verified `passed` into `flagged`
 * (the reviewer's probe, fix pass 4: and never-lower then kept it). It
 * replaces a provisional row whenever it settles no less. A settled `next`
 * replaces a provisional row down to that row's settled status: what was
 * filed while a neighbour was unread heals once it is read.
 *
 * The provisional rules hold under any revision, unknown included: a
 * provisional `next` never lowers what a row settled, provisional row or
 * settled (review fix pass 6 for a settled row — fix pass 5 wrote any
 * computation under "", so a verdict waiting on a parked neighbour
 * overwrote a verified `broken_connectors` with `flagged`; review fix pass 7
 * for a provisional row — fix pass 6 still wrote the latest over a
 * provisional "" row, so a row that SETTLED `broken_connectors` was lowered
 * to `flagged` while its destination was reset by a rebuild).
 *
 * Under an unknown revision ("") a SETTLED computation is written — the
 * latest verdict is the only one that can be about the drawing in front of
 * us — except `skipped`, which never erases a verdict, and except while a
 * document of the library is still being READ (`stillReading`: in flight —
 * queued, mid-read, reset by a rebuild — or parked on AI vision with pages
 * left unread): then a computation that would LOWER what the row settled
 * waits, and is judged again once the document is read (the set digest
 * names it). What such a document has yet to declare can drop a finding out
 * of the set's scope altogether — a series only it held, a connector's
 * destination only it declared — so a lower settled verdict then is not yet
 * the latest verdict about the drawing (review fix pass 7 for a document in
 * flight; review fix pass 8 for a parked one, whose unread page could hold
 * a destination outside the set's scope, and the guard was not applied to
 * it). `neverLower` applies the known-revision rule whatever the revision
 * (a row another library filed on the org-wide key, before 20261124).
 */
export function replaceDecision(
  stored: { revision_code: string; status: string; provisional?: { settledStatus: string } | null } | null | undefined,
  next: { status: AuditStatus; provisional?: { settledStatus: AuditStatus } | null },
  opts: { neverLower?: boolean; stillReading?: boolean } = {},
): "write" | "keep" | "wait" {
  if (!stored) return "write";
  const latestWins = stored.revision_code === "" && !opts.neverLower;
  const floor = stored.provisional ? stored.provisional.settledStatus : stored.status;
  if (next.provisional) {
    const settledNow = next.provisional.settledStatus;
    if (stored.provisional) return wouldLowerSeverity(floor, settledNow) ? "wait" : "write";
    return !wouldLowerSeverity(floor, settledNow) && floor !== settledNow ? "write" : "wait";
  }
  if (latestWins) {
    if (next.status === "skipped") return stored.status === "skipped" ? "write" : "keep";
    return opts.stillReading && wouldLowerSeverity(floor, next.status) ? "wait" : "write";
  }
  return wouldLowerSeverity(floor, next.status) ? "keep" : "write";
}

/**
 * A verdict filed under a key that other documents are filed under too —
 * per-sheet PDFs of one drawing share its number — made provisional for
 * each of them that is not read whole only FOR NOW (`pendingOf` names it,
 * with why; null for one that is read whole, or never changes) and that
 * this verdict does not cover. Such a document's own findings are not in
 * the verdict: skipped while it is parked or in flight, or not filed at all
 * while a rebuild has cleared its title block. Without this, a sibling's
 * settled `passed` overwrote the shared row's `broken_connectors` under an
 * unknown revision while the sheet that carried the broken box was parked,
 * or reset (review fix pass 7). The verdict waits on it, settled at what
 * the documents it does cover settled; a `skipped` verdict covers nothing
 * and is left as it is (it never erases a verdict).
 */
export function awaitingFiled(
  verdict: SheetVerdict, filed: Iterable<string>, pendingOf: (documentId: string) => string | null | undefined,
): SheetVerdict {
  if (verdict.status === "skipped") return verdict;
  const covered = verdict.coverage ?? { [verdict.documentId]: "" };
  const labels = [...new Set([...filed])]
    .filter((id) => !(id in covered))
    .map((id) => pendingOf(id))
    .filter((x): x is string => !!x);
  if (labels.length === 0) return verdict;
  return {
    ...verdict,
    provisional: {
      waitingOn: [...new Set([...(verdict.provisional?.waitingOn ?? []), ...labels])].sort(),
      settledStatus: verdict.provisional?.settledStatus ?? verdict.status,
    },
  };
}

/**
 * One row per key (sheet number @ revision): two documents of one set can
 * declare the same number, and the unique index would reject the batch
 * outright. The more severe verdict is kept — a clean sheet must never mask
 * a broken one filed under the same number — with every document it covers
 * (each that was read, with the basis it was computed from: `basisOf`; a
 * `skipped` sheet covers nothing). Provisional when any member is: waiting
 * on every document a member waits on, settled at the most severe settled
 * status among them (a settled member's status is settled) — and when a
 * `skipped` member is a document not read whole only for now (`pendingOf`,
 * awaitingFiled): its findings are not in the verdict yet (review fix pass
 * 7).
 */
export function mergeVerdictsByKey(
  verdicts: readonly SheetVerdict[], basisOf: (documentId: string) => string,
  pendingOf?: (documentId: string) => string | null | undefined,
): SheetVerdict[] {
  const groups = new Map<string, SheetVerdict[]>();
  for (const v of verdicts) {
    const key = `${v.sheetNumber}@${v.revision}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return [...groups.values()].map((group) => {
    let best = group[0];
    for (const v of group) if (RANK[v.status] > RANK[best.status]) best = v;
    const coverage: Record<string, string> = {};
    for (const v of group) if (v.status !== "skipped") coverage[v.documentId] = basisOf(v.documentId);
    const waitingOn = [...new Set(group.flatMap((v) => v.provisional?.waitingOn ?? []))].sort();
    let settled: AuditStatus = "skipped";
    for (const v of group) {
      const s = v.provisional?.settledStatus ?? v.status;
      if (RANK[s] > RANK[settled]) settled = s;
    }
    const { provisional: _p, ...rest } = best;
    const merged: SheetVerdict = {
      ...rest, coverage, ...(waitingOn.length > 0 ? { provisional: { waitingOn, settledStatus: settled } } : {}),
    };
    return pendingOf
      ? awaitingFiled(merged, group.filter((v) => v.status === "skipped").map((v) => v.documentId), pendingOf)
      : merged;
  });
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
      // A verdict with findings that wait on a document not read whole yet:
      // which (named to WAITING_NAMES_MAX, the rest counted — review fix
      // pass 7), and what is settled without them (replaceDecision).
      ...(v.provisional
        ? { provisional: { waitingOn: capWaitingOn(v.provisional.waitingOn), settledStatus: v.provisional.settledStatus } } : {}),
    },
  }));
}
