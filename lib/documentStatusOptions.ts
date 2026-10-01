// lib/documentStatusOptions.ts — the statuses the document editors OFFER for
// a new choice (public-surfaces VFY-20; DEC-44 (P15), awaiting the user's
// ratification).
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
// Second review fix: the spreadsheet import (components/documents/
// CsvImportModal.tsx) writes each row's status cell, so it was a door the
// editors' lists did not close — "IFC" (or any string) still landed. It now
// imports only a status the gates recognise (importStatusRefusal).
//
// Pure: it imports only the shared status predicates (lib/issueStatus,
// lib/verifyVerdict, lib/aiBoundary's status set — all I/O-free); the client
// editors import it.

import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { isControlledIssueStatus } from "@/lib/issueStatus";
import { IN_FORCE_STATUSES, isRecognisedStatus } from "@/lib/verifyVerdict";

/** Retired from the editors (DEC-44 (P15)): never offered for a new choice.
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

/** components/documents/CsvImportModal.tsx — the statuses a row may be
 *  IMPORTED with (second review fix): exactly the statuses the verify page
 *  recognises (isRecognisedStatus) — the work-in-progress pair, the in-force
 *  pair and the shared not-current set. A blank cell imports as Draft. */
export const IMPORT_STATUSES: readonly string[] = ["Draft", "In Review", ...IN_FORCE_STATUSES, ...NOT_CURRENT_STATUSES];

/** Why one imported row's status is refused — null when it may be imported
 *  (a recognised status, or blank, which imports as Draft). "IFC" (a status
 *  no editor offers — DEC-44 (P15)) and any other value no gate recognises
 *  would scan STATUS NOT RECOGNISED and never print into a pack, so the row
 *  is not imported and the import's report says why; a case or spacing
 *  variant of a recognised status is named. Compared as the gates compare
 *  (exactly, after the import's own trim). */
export function importStatusRefusal(status: string | null | undefined): string | null {
  const s = (status ?? "").trim();
  if (!s || isRecognisedStatus(s)) return null;
  const use = `Use one of: ${IMPORT_STATUSES.join(", ")} (a blank status imports as Draft).`;
  if (RETIRED_STATUS_OPTIONS.has(s)) {
    return `Status "${s}" is not imported: it is not an issued status — the field pack does not print it and the verify page reads it as STATUS NOT RECOGNISED. ${use}`;
  }
  const near = IMPORT_STATUSES.find((x) => x.toLowerCase() === s.toLowerCase().replace(/\s+/g, " "));
  return `Status "${s}" is not one the register recognises${near ? ` — did you mean "${near}"?` : ""}. ${use}`;
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

/** P15 review fix (VFY-20 / DEC-44 (P15) §4): does this status change put a
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
