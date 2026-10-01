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
// Each editor keeps its own list otherwise (DEC-31: fix the finding). One
// test (lib/__tests__/dcRoundFP15StatusVocabulary.test.ts) pins every list:
// each offered status is either in force at both the print gate and the
// verify allow-list, or refused by both.
//
// Pure and dependency-free: the client editors import it.

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
    return `"${cur}" is no longer offered: the field pack does not print it and the verify page reads it as STATUS NOT RECOGNISED, because it is not an issued status. Choose a listed status to replace it — Issued is the in-force one.`;
  }
  return `"${cur}" is not one of this editor's statuses; it is kept unless you choose another.`;
}
