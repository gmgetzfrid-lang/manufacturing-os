// lib/documentStatusOptions.ts — the statuses the document editors OFFER for
// a new choice (public-surfaces VFY-20; DEC-77, ratified by the integrator
// under the user's delegation, 2026-10-07 — DEC-90).
//
// "IFC" is not a document status: DocumentStatus does not list it, the field
// pack's print gate (lib/docPack.ts filterPackDocs) and the verify
// allow-list (lib/verifyVerdict.ts IN_FORCE_STATUSES) both read it as not in
// force. The editors offered it anyway, so a controller who picked it meant
// "issued" while every gate said "not issued". Under the fail-safe protocol
// the reversible default is taken: no editor offers it for a new choice; an
// existing IFC row is NOT migrated and is shown as what it is (see
// statusSelectOptions); the gates and what the database calls an issue
// (20261144 is_controlled_issue_status, lib/issueStatus.ts) are unchanged.
//
// P15 review fix: the database counts IFC as an issue already, so moving an
// existing IFC row to Issued (or Locked) is NOT an issue transition there —
// 20261144's guard never sees it (no publisher tier, hold or review limb),
// yet it is the change that puts the document in force at the gates. The
// editors treat it as one (isUnguardedEntryIntoForce): they say so before
// the save and check the hold themselves. The database limb is REV-21.
//
// Each editor keeps its own list otherwise (DEC-31: fix the finding). One
// test (lib/__tests__/dcRoundFP15StatusVocabulary.test.ts) pins every list:
// each offered status is either in force at both the print gate and the
// verify allow-list, or refused by both.
//
// The spreadsheet import (components/documents/CsvImportModal.tsx) writes
// each row's status cell. It is a carrier of a register's own data, not an
// editor offering a choice, so (third review fix) it imports every row it
// imported before: a case or spacing variant of a recognised status is
// imported in the register's spelling, and any other value — "IFC", a
// library's own status — is imported as written with a per-row warning that
// it reads STATUS NOT RECOGNISED and is not printed (importStatusFor). The
// second review fix refused such rows, which broke imports that work today.
//
// Pure: it imports only the shared status predicates (lib/issueStatus,
// lib/verifyVerdict, lib/aiBoundary's status set — all I/O-free); the client
// editors import it.

import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { isControlledIssueStatus } from "@/lib/issueStatus";
import { IN_FORCE_STATUSES, isRecognisedStatus } from "@/lib/verifyVerdict";

/** Retired from the editors (DEC-77): never offered for a new choice.
 *  The other option — adding it to DocumentStatus, filterPackDocs and
 *  IN_FORCE_STATUSES together — is the user's to ratify instead. */
export const RETIRED_STATUS_OPTIONS: ReadonlySet<string> = new Set(["IFC"]);

/** components/documents/BulkEditModal.tsx — "set status on every selected row". */
export const BULK_EDIT_STATUS_OPTIONS: readonly string[] = ["Draft", "In Review", "Issued", "Superseded", "Archived"];

/** components/documents/MetadataEditor.tsx — one document's status. */
export const METADATA_EDITOR_STATUS_OPTIONS: readonly string[] = ["Draft", "Issued", "Superseded", "Void", "Archived", "Locked"];

/** components/documents/MetadataStagingModal.tsx — a new upload's status
 *  (its `statusOptions` default). */
export const STAGING_STATUS_OPTIONS: readonly string[] = ["Draft", "In Review", "Issued", "Superseded"];

/** components/documents/CsvImportModal.tsx — the register's own spelling of
 *  every status the verify page recognises (isRecognisedStatus): the
 *  work-in-progress pair, the in-force pair and the shared not-current set.
 *  A row in one of these (or blank — Draft) imports with no note; a case or
 *  spacing variant of one is imported in this spelling (importStatusFor). */
export const IMPORT_STATUSES: readonly string[] = ["Draft", "In Review", ...IN_FORCE_STATUSES, ...NOT_CURRENT_STATUSES];

/** How one imported row's status cell is written, and what the import's
 *  report says about it (null: nothing to say). */
export interface ImportStatusReading { status: string; note: string | null }

const spellingKey = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/** VFY-20 / DEC-77 §1 (third review fix): the status an imported row
 *  is written with. Every row that imported before still imports:
 *   * blank → Draft; a recognised status → as written (no note);
 *   * a case or spacing variant of a recognised status ("issued", "DRAFT",
 *     "In  Review") → the register's spelling, and the report says so — the
 *     gates compare exactly, so the variant would scan STATUS NOT RECOGNISED;
 *   * anything else ("IFC", a library's own "Approved" / "IFA") → as
 *     written (trimmed, as before), with a warning that the verify page
 *     reads it STATUS NOT RECOGNISED and the field pack does not print it;
 *     IFC's warning names DEC-77 — refusing it instead is the user's
 *     to ratify. Never canonicalised to an in-force status it was not. */
export function importStatusFor(cell: string | null | undefined): ImportStatusReading {
  const s = (cell ?? "").trim();
  if (!s) return { status: "Draft", note: null };
  if (isRecognisedStatus(s)) return { status: s, note: null };
  const key = spellingKey(s);
  const canonical = IMPORT_STATUSES.find((x) => spellingKey(x) === key);
  if (canonical) return { status: canonical, note: `Status "${s}" was imported as "${canonical}", the register's spelling.` };
  const use = `To change that, set one of: ${IMPORT_STATUSES.join(", ")}.`;
  if ([...RETIRED_STATUS_OPTIONS].some((r) => spellingKey(r) === key)) {
    return { status: s, note: `Status "${s}" was imported as written, but it is not an issued status (DEC-77 — no editor offers it): the verify page reads it as STATUS NOT RECOGNISED and the field pack does not print it. To put the document in force, set it to Issued in the metadata editor once its revision is reviewed.` };
  }
  return { status: s, note: `Status "${s}" was imported as written, but it is not one the register recognises: the verify page reads it as STATUS NOT RECOGNISED and the field pack does not print it. ${use}` };
}

/** One option of a status <select>. `current` marks the record's own value
 *  when the editor does not offer it (an existing IFC row): shown as what it
 *  is so the select never displays another value than the one stored, and
 *  saving without touching it leaves it as it is. */
export interface StatusOption { value: string; label: string; current?: true }

/** The options a status <select> renders: the offered list, plus the
 *  record's CURRENT value when it is outside it. */
export function statusSelectOptions(offered: readonly string[], current: string | null | undefined): StatusOption[] {
  const opts: StatusOption[] = offered.map((s) => ({ value: s, label: s }));
  const cur = current ?? "";
  if (cur.trim() && !offered.includes(cur)) {
    opts.push({ value: cur, label: `${cur} (current — not offered)`, current: true });
  }
  return opts;
}

/** What the editor says under the select when the record carries a status
 *  no editor offers — null otherwise. IFC is named for what the gates do
 *  with it; anything else is an unrecognised status. */
export function notOfferedStatusNote(offered: readonly string[], current: string | null | undefined): string | null {
  const cur = (current ?? "").trim();
  if (!cur || offered.includes(current ?? "")) return null;
  if (RETIRED_STATUS_OPTIONS.has(cur)) {
    return `"${cur}" is no longer offered: the field pack does not print it and the verify page reads it as STATUS NOT RECOGNISED, because it is not an issued status. It is kept unless you choose another; choosing Issued puts the revision in force, so do it only for a revision that was reviewed — the save checks the hold first.`;
  }
  return `"${cur}" is not one of this editor's statuses; it is kept unless you choose another.`;
}

/** P15 review fix (VFY-20 / DEC-77 §4): does this status change put a
 *  document's current revision IN FORCE (IN_FORCE_STATUSES — the field pack
 *  prints it, a scan reads it green) out of a status the database ALREADY
 *  counts as an issue but no gate reads as in force — an existing IFC row,
 *  or any other status outside the vocabulary? The database's issue guard
 *  (20261144 v_issuing — isIssueTransition) does not see such a change:
 *  IFC → Issued is issue-to-issue there, so no publisher-tier, hold or
 *  review limb runs. The editors that can make it (the metadata editor and
 *  the bulk editor — Document Control only, so the publisher tier holds)
 *  treat it as an issue: they say so before the save and refuse it over an
 *  active hold (lib/holdGate.ts, fail closed), as the database does for a
 *  controller's issue. A document with no current revision has nothing to
 *  put in force. Compared as the gates compare (exactly): " Issued" is not
 *  in force there. */
export function isUnguardedEntryIntoForce(input: {
  fromStatus: string | null | undefined; toStatus: string | null | undefined; hasCurrentRevision: boolean;
}): boolean {
  const from = input.fromStatus ?? "";
  return input.hasCurrentRevision
    && isControlledIssueStatus(from)
    && !IN_FORCE_STATUSES.has(from)
    && IN_FORCE_STATUSES.has(input.toStatus ?? "");
}

/** The action the hold refusal names (lib/holdGate.ts holdRefusalMessage). */
export const ENTRY_INTO_FORCE_ACTION = "putting it in force";
