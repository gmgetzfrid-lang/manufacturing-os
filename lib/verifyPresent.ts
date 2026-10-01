// lib/verifyPresent.ts
//
// How the three public scan-landing pages (app/verify/[docId],
// app/verify-package/[packageId], app/verify-hold/[holdId]) turn a verify
// endpoint's answer into ONE full-screen verdict. Pure functions — no React,
// no client — so the rules that decide the colour a field worker sees are
// unit-tested (lib/__tests__/verifyPresent.test.ts) rather than read off JSX.
//
// The rule every surface keeps: GREEN only when the endpoint KNOWS the paper
// is good. A verdict this module does not recognise (an older or newer API
// build) never falls through to green.

import { isRecognisedStatus } from "@/lib/verifyVerdict";

// ─── /verify/[docId] — one printed sheet ─────────────────────────────────

export type DocVerdict =
  | "current" | "not_yet_effective" | "held"
  | "superseded" | "void" | "archived" | "retired" | "draft" | "not_issued"
  | "superseded_version" | "unverifiable" | "no_current_revision";

export interface DocVerifyResult {
  docNumber: string | null;
  title: string | null;
  printedRev: string | null;
  printedAt: string | null;
  currentRev: string | null;
  currentIssuedAt: string | null;
  effectiveDate: string | null;
  notYetEffective: boolean;
  onHold?: boolean;
  activeHolds?: number | null;
  holdReasons?: string[];
  docStatus: string | null;
  verdict?: DocVerdict;
  isCurrent: boolean;
  checkedAt: string;
}

export interface VerdictView {
  bg: string;
  icon: "ok" | "stop" | "x" | "q";
  headline: string;
  blurb: string;
  ok: boolean;
  advice: string | null;
}

/** An effective date is a calendar DAY (YYYY-MM-DD) — format it as that day,
 *  never through the phone's zone (new Date("2026-03-02") is UTC midnight,
 *  which reads as 1 March anywhere west of UTC). */
export function formatEffectiveDay(day: string | null): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}/.test(day)) return null;
  const t = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}

const STOP_ADVICE = "Get the current revision from Document Control before performing any work from this drawing. Mark this print “SUPERSEDED” or destroy it.";
const NOT_ISSUED_ADVICE = "This is not an approved revision. Get the issued revision from Document Control before performing any work.";
const UNCONFIRMED_ADVICE = "Check the revision with Document Control before performing any work from this print.";

/** Map /api/verify's verdict to its full-screen presentation. Falls back to
 *  the legacy isCurrent / notYetEffective booleans when an older API build
 *  omits `verdict` — and even then green needs a printed revision (VFY-3). */
export function presentDocVerdict(r: DocVerifyResult): VerdictView {
  const v: DocVerdict =
    r.verdict ?? (r.notYetEffective ? "not_yet_effective" : r.isCurrent && r.printedRev ? "current" : r.isCurrent ? "unverifiable" : "superseded_version");
  const status = r.docStatus ? ` (${r.docStatus})` : "";
  switch (v) {
    case "current":
      return { bg: "bg-emerald-600", icon: "ok", ok: true, headline: "CURRENT", advice: null,
        blurb: "This print matches the current revision." };
    case "not_yet_effective":
      return { bg: "bg-amber-500", icon: "q", ok: false, headline: "NOT YET IN EFFECT",
        advice: "Keep working to the prior in-force revision until the effective date.",
        blurb: `This is the latest revision, but it comes into force ${formatEffectiveDay(r.effectiveDate) ?? "later"} — until then, keep working to the prior in-force revision.` };
    case "held": {
      const reasons = (r.holdReasons ?? []).filter(Boolean);
      const n = r.activeHolds ?? null;
      const what = n && n > 1 ? `${n} active holds` : "an active hold";
      return { bg: "bg-red-700", icon: "stop", ok: false, headline: "ON HOLD — STOP WORK",
        advice: "Do not perform any work from this drawing until Document Control releases every hold on it.",
        blurb: `This document is under ${what}${reasons.length ? ` (${reasons.join(", ")})` : ""}. Do not perform any work from it. Contact Document Control.` };
    }
    case "void":
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "VOID — DO NOT USE", advice: STOP_ADVICE,
        blurb: "This document has been voided. It is not a valid drawing. Destroy this print." };
    case "archived":
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "ARCHIVED — DO NOT USE", advice: STOP_ADVICE,
        blurb: "This document has been archived and is no longer maintained." };
    case "superseded":
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "SUPERSEDED — DO NOT USE", advice: STOP_ADVICE,
        blurb: "This document has been superseded. Get the current revision from Document Control." };
    case "retired":
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "WITHDRAWN — DO NOT USE", advice: STOP_ADVICE,
        blurb: `This document is no longer in force${status}.` };
    case "draft":
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "DRAFT — NOT ISSUED", advice: NOT_ISSUED_ADVICE,
        blurb: "This is an unissued draft, not a controlled revision. Do not use for construction." };
    case "not_issued":
      // A status the vocabulary does not know ("IFC", a free value — VFY-20)
      // is not in force, but the scan cannot say it is "not approved": it
      // says it does not recognise the status. Still red, still no work.
      if (!isRecognisedStatus(r.docStatus)) {
        return { bg: "bg-red-600", icon: "q", ok: false, headline: "STATUS NOT RECOGNISED",
          advice: "Do not perform any work from this print until Document Control confirms it is an issued, current revision.",
          blurb: `This document's status${status} is not one the system recognises as issued, so this scan cannot confirm the print. Check with Document Control.` };
      }
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "NOT ISSUED — DO NOT USE", advice: NOT_ISSUED_ADVICE,
        blurb: `This document is not an issued, controlled revision${status}.` };
    case "unverifiable":
      return { bg: "bg-slate-700", icon: "q", ok: false, headline: "CAN'T CONFIRM THIS REVISION", advice: UNCONFIRMED_ADVICE,
        blurb: "This code does not say which revision was printed, so it cannot confirm the paper is current. Do not assume it is." };
    case "no_current_revision":
      // The code DID name the printed revision; the document has no current
      // one on record to compare it with.
      return { bg: "bg-slate-700", icon: "q", ok: false, headline: "CAN'T CONFIRM THIS REVISION", advice: UNCONFIRMED_ADVICE,
        blurb: "This document has no current revision on record, so the system cannot confirm this print is current. Do not assume it is — check with Document Control." };
    case "superseded_version":
    default:
      return { bg: "bg-red-600", icon: "x", ok: false, headline: "DO NOT USE", advice: STOP_ADVICE,
        blurb: `${r.printedRev ? `This print is Rev ${r.printedRev}` : "This print is not the current revision"}${r.currentRev ? ` — the current revision is Rev ${r.currentRev}` : ""}.` };
  }
}

// ─── /verify-package/[packageId] — a printed work pack ───────────────────

export type PackVerdict =
  | "current" | "not_yet_effective" | "incomplete" | "stale" | "held" | "closed" | "empty" | "unconfirmed_print" | "unverifiable";

export type SheetState =
  | "fresh" | "not_yet_effective" | "stale" | "held"
  | "void" | "archived" | "superseded" | "retired" | "draft" | "not_issued"
  | "missing" | "removed" | "unconfirmed";

export interface PackSheetRow {
  label: string;
  printedRev: string | null;
  currentRev: string | null;
  fresh: boolean;
  retired: boolean;
  state?: SheetState;
  held?: boolean;
  holdReasons?: string[];
}

/** Why a sheet of the package that is not in this pack cannot be printed
 *  NOW — the same refusals the print gate applies (document-control PKG-4,
 *  lib/docPack.ts filterPackDocs, then buildAndDownloadDocPack): not issued,
 *  withdrawn, under a hold (or a hold state that could not be read), no
 *  longer readable, a current revision with no file on record, a file that
 *  is not a PDF (a DWG, a spreadsheet, an image — the builder can only stamp
 *  a PDF). Present tense on purpose: the route knows what is true of the
 *  sheet now, not what the print gate saw — a re-print would leave it out too. */
export type NotPrintableReason = "not_issued" | "withdrawn" | "on_hold" | "hold_unknown" | "unavailable" | "no_file" | "not_pdf";

const NOT_PRINTABLE_TEXT: Record<NotPrintableReason, string> = {
  not_issued: "not issued",
  withdrawn: "withdrawn",
  on_hold: "on hold",
  hold_unknown: "hold status unknown",
  unavailable: "no longer available",
  no_file: "no current file",
  not_pdf: "not a printable PDF",
};

/** The words for one not-printable reason (an unknown one reads "cannot be printed"). */
export function notPrintableText(reason: string | null | undefined): string {
  return NOT_PRINTABLE_TEXT[reason as NotPrintableReason] ?? "cannot be printed";
}

export interface PackVerifyResult {
  name: string;
  packageStatus: string | null;
  closed: boolean;
  printedAt?: string | null;
  snapshotMissing?: boolean;
  printConfirmed?: boolean;
  sheetCount: number;
  /** Every printed sheet that is not good — changed, withdrawn, removed,
   *  missing, or not an issued revision at all (back-compat total). */
  staleCount: number;
  /** Of those, the sheets that are not an issued, controlled revision
   *  (draft / not issued) — which says nothing about "since printing". */
  notIssuedCount?: number;
  heldCount?: number;
  /** Sheets in the package that are NOT in this pack and could be printed
   *  now — added since printing, or left out of it for a reason that no
   *  longer holds (a file that failed to fetch, a sheet issued since). The
   *  route cannot tell which (VFY-19), so it never says "added since". */
  notInPack?: Array<{ label: string }>;
  /** Sheets in the package that are NOT in this pack and cannot be printed
   *  now (NotPrintableReason) — a re-print would leave them out too, so they
   *  never make the pack stale; on their own they make it "incomplete". */
  notPrintable?: Array<{ label: string; reason: NotPrintableReason }>;
  allFresh: boolean;
  verdict?: PackVerdict;
  sheets: PackSheetRow[];
  checkedAt: string;
}

export function presentPackVerdict(r: PackVerifyResult): VerdictView {
  const v: PackVerdict = r.verdict ?? (r.snapshotMissing ? "unverifiable" : r.allFresh ? "current" : "stale");
  const n = r.sheetCount;
  const sheets = (k: number) => `${k} sheet${k === 1 ? "" : "s"}`;
  switch (v) {
    case "current":
      return { bg: "bg-emerald-600", icon: "ok", ok: true, headline: "PACK IS CURRENT", advice: null,
        blurb: "Every sheet in this pack is still the current revision." };
    case "not_yet_effective":
      return { bg: "bg-amber-500", icon: "q", ok: false, headline: "NOT YET IN EFFECT",
        advice: "Keep working to the prior in-force revisions until the effective dates.",
        blurb: "Every sheet is the latest revision, but at least one does not come into force yet — the sheets marked below." };
    case "held":
      return { bg: "bg-red-700", icon: "stop", ok: false, headline: "PACK ON HOLD — STOP WORK",
        advice: "Do not work from the held sheets until Document Control releases every hold on them.",
        blurb: `${sheets(r.heldCount ?? 0)} in this pack ${(r.heldCount ?? 0) === 1 ? "is" : "are"} under an active hold — the sheets marked below.` };
    case "stale": {
      // A sheet of the package that is not in this pack but could be printed
      // now. The print snapshot does not record what the print gate left out
      // (VFY-19), so nothing here says it was "added since printing" — only
      // that the package holds it and this pack does not.
      const missing = r.notInPack?.length ?? 0;
      // A sheet that is not an issued revision (a draft, or a legacy row with
      // no status) is not evidence that anything CHANGED since printing — it
      // may have been printed that way — so it is counted on its own.
      const notIssued = Math.min(Math.max(r.notIssuedCount ?? 0, 0), r.staleCount);
      const changed = r.staleCount - notIssued;
      const parts: string[] = [];
      if (changed > 0) parts.push(`${changed} of ${sheets(n)} changed or withdrawn since this pack was printed`);
      if (notIssued > 0) parts.push(`${notIssued} of ${sheets(n)} ${notIssued === 1 ? "is" : "are"} not an issued, controlled revision`);
      if (missing > 0) parts.push(`${sheets(missing)} in the package ${missing === 1 ? "is" : "are"} not in this pack`);
      const onlyNotIssued = changed === 0 && missing === 0 && notIssued > 0;
      const missingNotChanged = changed === 0 && missing > 0;
      return { bg: "bg-red-600", icon: "x", ok: false,
        headline: changed > 0 ? "PACK IS STALE" : missing > 0 ? "PACK IS MISSING SHEETS" : notIssued > 0 ? "PACK HAS UNISSUED SHEETS" : "PACK IS STALE",
        advice: onlyNotIssued
          ? "Do not work from the sheets marked below — they are not issued revisions. Get the issued revisions from Document Control before starting work."
          : missingNotChanged
            ? "Do not work from any sheet marked below, and ask the package owner or Document Control for a re-printed pack — the package's sheets that are not in this pack are listed below."
            : "Do not work from the outdated sheets. Ask the package owner or Document Control for a re-printed pack — the stale sheets are marked below.",
        blurb: `${parts.join("; ") || "This pack no longer matches its package"} — get the ${onlyNotIssued ? "issued" : missingNotChanged && notIssued === 0 ? "missing" : "new"} sheets before starting work.` };
    }
    case "incomplete": {
      // Every printed sheet is current; the package also holds sheets that
      // cannot be printed now (not issued, withdrawn, held, no file, not a
      // PDF …). A re-print would leave them out too, so this is not "stale"
      // — but it is not green either: part of the package's scope is not in
      // the crew's hands.
      const left = r.notPrintable ?? [];
      const k = left.length;
      const why = [...new Set(left.map((s) => notPrintableText(s.reason)))];
      return { bg: "bg-amber-500", icon: "q", ok: false, headline: "PACK INCOMPLETE",
        advice: "Work only from the sheets in this pack. Do not do any work the sheets listed as not in it cover until Document Control supplies them — they cannot be printed into a pack now; a re-printed pack includes them once they can be.",
        blurb: `Every sheet in this pack is current, but ${k > 0 ? sheets(k) : "a sheet"} in the package ${k === 1 || k === 0 ? "is" : "are"} not in it and cannot be printed now${why.length ? ` (${why.join(", ")})` : ""} — listed below.` };
    }
    case "closed":
      return { bg: "bg-slate-700", icon: "x", ok: false, headline: "PACKAGE CLOSED — DO NOT WORK FROM IT",
        advice: "A closed package is retired: its drawings are no longer watched, so its sheet list is not evidence that anything is current. Get a current pack from the package owner or Document Control.",
        blurb: "This work package has been closed. Its pins stopped being monitored when it closed, so freshness here proves nothing." };
    case "empty":
      return { bg: "bg-slate-700", icon: "q", ok: false, headline: "NO SHEETS IN THIS PACK",
        advice: "Contact Document Control before working from this folder.",
        blurb: "This package records no sheets, so there is nothing to verify." };
    case "unconfirmed_print":
      return { bg: "bg-slate-700", icon: "q", ok: false, headline: "CAN'T CONFIRM WHICH PRINTING",
        advice: "Ask the package owner or Document Control for a re-printed pack — a current cover sheet carries a code that can be checked.",
        blurb: "This cover sheet's code predates print records, so it cannot say which revisions were printed. Do not assume this pack is current." };
    case "unverifiable":
    default:
      return { bg: "bg-slate-700", icon: "q", ok: false, headline: "CAN'T VERIFY THIS PACK",
        advice: "Contact Document Control before working from this pack.",
        blurb: "The print record for this pack could not be read — do not assume it is current." };
  }
}

/** The right-hand label of one sheet row on the pack page. */
export function sheetLabel(s: PackSheetRow): { text: string; ok: boolean } {
  const state: SheetState = s.state ?? (s.retired ? "retired" : s.fresh ? "fresh" : "stale");
  const printed = s.printedRev ? `Rev ${s.printedRev}` : "Rev —";
  switch (state) {
    case "fresh": return { text: `${printed} ✓`, ok: true };
    case "not_yet_effective": return { text: `${printed} · not yet in effect`, ok: false };
    case "held": return { text: `ON HOLD${s.holdReasons?.length ? ` · ${s.holdReasons.join(", ")}` : ""}`, ok: false };
    case "void": return { text: "VOID", ok: false };
    case "archived": return { text: "ARCHIVED", ok: false };
    case "superseded": return { text: "SUPERSEDED", ok: false };
    case "retired": return { text: "RETIRED", ok: false };
    case "draft": return { text: "DRAFT — NOT ISSUED", ok: false };
    case "not_issued": return { text: "NOT ISSUED", ok: false };
    case "missing": return { text: "NO LONGER AVAILABLE", ok: false };
    case "removed": return { text: "REMOVED FROM PACKAGE", ok: false };
    case "unconfirmed": return { text: `now Rev ${s.currentRev ?? "—"} · printing unknown`, ok: false };
    case "stale":
    default: return { text: `${printed} → ${s.currentRev ?? "—"}`, ok: false };
  }
}

// ─── /verify-hold/[holdId] — a printed hold card ─────────────────────────

export type HoldVerdict = "active" | "released_others_active" | "released_others_unknown" | "released";

export interface HoldVerifyResult {
  active: boolean;
  verdict?: HoldVerdict;
  reason: string | null;
  reasonWithheld?: boolean;
  openedAt: string | null;
  releasedAt: string | null;
  docLabel: string | null;
  docRev: string | null;
  heldRev?: string | null;
  otherActiveHolds?: number | null;
  otherHoldReasons?: string[];
  checkedAt: string;
}

/** GREEN only when this hold is released AND no other hold is active on the
 *  document (VFY-10 / PHYS-10) — another document_holds row or the document's
 *  legal hold, which the route counts among the others — so "this tag can
 *  come down" is reachable only there. A released hold whose document is
 *  still held, or whose other holds could not be read, is AMBER: leave the
 *  equipment tagged. */
export function presentHoldVerdict(r: HoldVerifyResult): VerdictView {
  const v: HoldVerdict = r.verdict ?? (r.active ? "active" : "released_others_unknown");
  switch (v) {
    case "active":
      return { bg: "bg-red-600", icon: "stop", ok: false, headline: "HOLD ACTIVE", advice: null,
        blurb: "Do not advance this document or the work it covers." };
    case "released_others_active": {
      const k = r.otherActiveHolds ?? 0;
      const reasons = (r.otherHoldReasons ?? []).filter(Boolean);
      const what = k > 1 ? `${k} other holds are` : k === 1 ? "1 other hold is" : "another hold is";
      return { bg: "bg-amber-500", icon: "q", ok: false, headline: "RELEASED — DOCUMENT STILL ON HOLD", advice: null,
        blurb: `This hold is released, but ${what} still active on this document${reasons.length ? ` (${reasons.join(", ")})` : ""}. Do not advance it, and leave the equipment tagged until every hold is released.` };
    }
    case "released":
      return { bg: "bg-emerald-600", icon: "ok", ok: true, headline: "RELEASED", advice: null,
        blurb: "This hold has been released and no other hold is active on this document — this tag can come down." };
    case "released_others_unknown":
    default:
      return { bg: "bg-amber-500", icon: "q", ok: false, headline: "RELEASED — CHECK OTHER HOLDS", advice: null,
        blurb: "This hold is released, but whether other holds remain on this document could not be confirmed. Leave the equipment tagged until Document Control confirms." };
  }
}
