"use client";

// BulkEditModal — apply a single metadata change across many documents
// in one submit. The user picks a target field (status or a custom column)
// and a new value; the modal writes the update to every selected doc,
// recomputes uniqueness_key if relevant, and surfaces per-doc errors so a
// single failure doesn't blank the result.
//
// DRLS-15: Revision is not a bulk field. A document's revision label is its
// current revision's (the database refuses any other), so it is corrected on
// the revision itself, never set across rows.
//
// REV-18: setting an issue status (Issued, Locked, …) on a row that has a
// current revision and is not issued yet (Draft / In Review / Superseded /
// Void / Archived) ISSUES that revision — a guarded write at the database
// (20261144: the publisher tier, never over an active hold, and under a
// policy that requires sign-off a controller's unless the revision's review
// is complete). The modal says how many selected rows that is before the
// apply; each row is still its own write, so a refused row is named with the
// database's reason and every other row keeps its change.
//
// VFY-20 / DEC-77 review fix: a row whose status the database already
// counts as an issue but no gate reads as in force (an existing IFC row)
// moved to Issued / Locked is PUT IN FORCE by the write
// (isUnguardedEntryIntoForce). The modal names those rows before the apply
// and checks each one's hold itself (lib/holdGate.ts, fail closed) — a held
// row is refused and named; the publisher tier holds (the Bulk Edit button
// is Document Control's only). REV-21: since 20261185 the database judges
// the move as an issue too (before that paste it does not see it).
//
// REV-26 (document-control P25; DEC-77's REV-26 line): such a row is an
// issue and is recorded as one — written through changeDocumentStatus like
// an issuing row (the same checked UPDATE), which records DOCUMENT_ISSUED
// and opens the acknowledgment roster, leaving the review clock as it was
// (lib/revisions.ts isEntryIntoForce). A refusal of it by the database's
// issue rule is marked "not issued:" like an issuing row's.
//
// REV-19 (P17): a row the status change ISSUES (isIssueTransition, the rows
// the note above names) is written through lib/revisions.ts
// changeDocumentStatus — the same one checked UPDATE (the status, the
// recomputed uniqueness key, updated_at / updated_by), then, when the
// database admitted it as an issue, the compliance clocks it owes (the
// review clock and the read-&-understood roster, or only the roster where
// the retirement stamp gives no evidence of a new issue) and the
// DOCUMENT_ISSUED record, carrying the signed-in user's email and role
// (useRole) as the creation and un-archive doors' records do. A refused row is
// named exactly as before. An issue that landed but whose clocks or record did
// not follow is named after the apply — the change stands and is not to be
// repeated — and so is a row written as an issue that changeDocumentStatus did
// not record as one because its status before the write could not be read: no
// clock started and no DOCUMENT_ISSUED was written for it, so Document Control
// is told to start its clocks from the document. A row changeDocumentStatus
// found ALREADY issued (issued by another change after this page loaded), or
// with no current revision, was not issued by this write: it is named as such
// and nothing more is owed for it — never the "start its clocks" advice, which
// would restart a review clock the issuing change owns (P17 integrator fix:
// changeDocumentStatus returns the basis, `notRecordedBecause`).
// Every other row (a status that issues nothing, a custom field) is written as
// before.
//
// REV-19 (b) (document-control P23): WHICH rows go through
// changeDocumentStatus is no longer decided from this page's copy. Every row
// a status change writes to a controlled-issue status (isControlledIssueStatus
// — Issued, Locked, a library's own) takes it, and the row it reads first
// decides whether the write issued the document, as the metadata editor's
// save does since identity IS-P1. So a row this page still shows Issued,
// which another change has moved back to Draft, is issued by this change
// WITH its clocks and record (it took the bare write and was issued with
// neither), and is named after the apply ("issued by this change: another
// change after this page loaded had moved it out of issue"). The page's view
// (the rows the notes above list, `pageSawIssue`) only picks the sentence: a
// row it showed issued that is still issued is a plain success, as before,
// and a row whose state before the write could not be read is said as
// unknown ("check its history") rather than given the "start its clocks"
// advice the page owes only the rows it said it would issue. Every row
// changed to a status that issues nothing keeps the bare write.
//
// PROD-17 (document-control P28): a change to a RETIRED status (Superseded /
// Archived — isRetiredStatus) keeps each row's bare checked write, and is a
// retirement: the rows' statuses are read ONCE, fresh, before the apply
// (never this page's copy; a failed read leaves a row's prior unknown, which
// recalls), and after the apply ONE batched recall goes for every row the
// change retired (lib/staleCopies.ts recallRetiredBatch, fired, never
// awaited): each copy holder gets one notice naming every such document they
// hold a copy of — recalled only for a row that took away a controlled issue
// (recallsCopyHolders, DEC-90 R1) — and each document's watchers its FYI. A
// row already Superseded or Archived gets nothing again
// (skipsRetirementRecall). Never one recall chain per row (the per-row burst
// P26's fix pass reverted).
//
// DIST-16 (document-control P28 fix pass): a change to an ISSUE status reads
// the rows' statuses the same way, once, before the apply, and every row it
// writes over a prior that was not a controlled issue (a retired row put
// back; a Draft / In Review row issued; a prior the read could not give) is
// one candidate for ONE batched recall withdrawal after the apply
// (lib/staleCopies.ts withdrawRetirementBatch, fired, never awaited) — each
// person a standing recall named gets one notice for the whole apply. Each
// row's changeDocumentStatus is told withdrawRecall: false, so no row starts
// its own preference-exempt withdrawal.
//
// DIST-16 done-when 2 (document-control P28, the integrator's fix pass at the
// merge, 2026-10-21): each retired row's prior goes to the batched recall as
// `retiredFrom` — a row already retired gets nothing again only when its
// recall record says a retirement notice stands (no longer every Superseded /
// Archived prior, left out here before).
//
// REV-31 (the same fix pass, DEC-90): a change to Archived asks ONE reason for
// the whole apply ("Reason for archiving" — Apply waits for it), writes the
// archive columns the Archive dialog writes (archived_at, archived_by,
// archive_reason) in each row's same checked write, and, for every row it
// archived, does what archiveDocument does around an archive
// (lib/revisions.ts finishBulkArchive: the review draft voided, the live
// share links revoked, the ARCHIVE_DOC record with the reason). A duty that
// did not complete is said after the apply, its row named; a refused row
// does none of it.

import React, { useState } from "react";
import {
  X, Pencil, Loader2, AlertTriangle, CheckCircle2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { computeUniquenessKey } from "@/lib/uniqueness";
import { isIssueTransition, isIssueRefusal, isControlledIssueStatus, isRetiredStatus } from "@/lib/issueStatus";
import { BULK_EDIT_STATUS_OPTIONS, isUnguardedEntryIntoForce, ENTRY_INTO_FORCE_ACTION } from "@/lib/documentStatusOptions";
import { assertNotOnHold } from "@/lib/holdGate";
import type { DocumentRecord, LibraryConfig, MetadataFieldDefinition } from "@/types/schema";
import { changeDocumentStatus, recallsCopyHolders, finishBulkArchive, type StatusIssueOutcome } from "@/lib/revisions";
import { useRole } from "@/components/providers/RoleContext";

interface BulkEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  docs: DocumentRecord[];
  library: LibraryConfig;
  actorUserId: string;
  /** Refresh the parent's document list after a successful apply. */
  onApplied?: () => void;
}

type TargetField =
  | { kind: "status" }
  | { kind: "custom"; def: MetadataFieldDefinition };

// VFY-20 / DEC-77: the offered statuses live in lib/documentStatusOptions
// (no "IFC" — not a status the print gate or the verify page treat as issued).
const STATUS_OPTIONS = BULK_EDIT_STATUS_OPTIONS;

export default function BulkEditModal({
  isOpen, onClose, docs, library, actorUserId, onApplied,
}: BulkEditModalProps) {
  const [target, setTarget] = useState<TargetField>({ kind: "status" });
  const [newValue, setNewValue] = useState<string>(STATUS_OPTIONS[0]);
  // REV-31 (P28 integrator fix pass): one reason for a change to Archived.
  const [archiveReason, setArchiveReason] = useState("");
  const [busy, setBusy] = useState(false);
  // REV-19 (P17 review fix): the issue record names who issued it — email and role, not a bare uid.
  const { userEmail, activeRole } = useRole();
  const [results, setResults] = useState<{
    ok: number;
    failed: Array<{ doc: string; reason: string; issue: boolean }>;
    /** REV-19: issued rows whose clocks or issue record did not follow. */
    followUps: Array<{ doc: string; problems: string[] }>;
    /** REV-19 (P17 integrator fix): rows this change wrote but did not issue
     *  (already issued, or no current revision) — nothing is owed for them. */
    notIssued: Array<{ doc: string; note: string }>;
    /** REV-19 (b) (P23): rows this page showed issued (or with no revision)
     *  whose database row this change found otherwise — issued by it. */
    unseen: Array<{ doc: string; note: string }>;
    /** REV-19 (b) (P23 review 3): rows this page showed issued (or with no
     *  revision) whose state just before the write could not be read —
     *  nobody is known to have changed them; whether this change issued
     *  them is unknown. Kept apart from `unseen` so neither heading says
     *  more than the code knows (DEC-29). */
    unchecked: Array<{ doc: string; note: string }>;
    /** REV-31 (P28 integrator fix pass): archived rows whose archive duties
     *  (draft void, share revoke, ARCHIVE_DOC record) did not complete. */
    archiveFollowUps?: Array<{ doc: string; problems: string[] }>;
  } | null>(null);

  if (!isOpen) return null;

  // REV-31: a change to Archived is an archive — it takes a reason.
  const archiving = target.kind === "status" && newValue === "Archived";

  // REV-18: the selected rows this status change would ISSUE.
  const issuingRows = target.kind === "status"
    ? docs.filter((d) => isIssueTransition({ fromStatus: d.status, toStatus: newValue, hasCurrentRevision: !!d.currentVersionId }))
    : [];
  // P15 review fix: the selected rows this status change puts IN FORCE (an
  // existing IFC row → Issued / Locked) — no database check before 20261185;
  // since it, judged as an issue there too. REV-26 (P25): recorded as one.
  const enteringForceRows = target.kind === "status"
    ? docs.filter((d) => isUnguardedEntryIntoForce({ fromStatus: d.status, toStatus: newValue, hasCurrentRevision: !!d.currentVersionId }))
    : [];

  const customCols = (library.customColumns ?? []).filter((c) => !["title", "rev", "status", "documentNumber"].includes(c.key));
  const selectOptions = target.kind === "custom" && target.def.type === "select" ? (target.def.options ?? []) : null;

  const apply = async () => {
    if (archiving && !archiveReason.trim()) return;
    setBusy(true);
    setResults(null);
    const failed: Array<{ doc: string; reason: string; issue: boolean }> = [];
    const followUps: Array<{ doc: string; problems: string[] }> = [];
    const notIssued: Array<{ doc: string; note: string }> = [];
    const unseen: Array<{ doc: string; note: string }> = [];
    const unchecked: Array<{ doc: string; note: string }> = [];
    const issuingIds = new Set(issuingRows.map((d) => d.id));
    const enteringForceIds = new Set(enteringForceRows.map((d) => d.id));
    let ok = 0;
    const now = new Date().toISOString();
    // PROD-17 (P28): a retiring change reads every row's status once, before the apply.
    const retiring = target.kind === "status" && isRetiredStatus(newValue);
    // DIST-16 (P28 fix pass): so does a change to an issue status (the put-back candidates).
    const issuing = target.kind === "status" && isControlledIssueStatus(newValue);
    const priorStatusOf = new Map<string, string | null>();
    const retired: Array<{ documentId: string; libraryId: string | null; docLabel: string; recallCopyHolders: boolean; retiredFrom: string | null }> = [];
    // REV-31: the rows this change archived, for their archive duties.
    const archivedRows: Array<{ documentId: string; label: string; versionId: string | null }> = [];
    const putBack: Array<{ documentId: string; libraryId: string | null; docLabel: string; restoredStatus: string }> = [];
    if (retiring || issuing) {
      const ids = docs.map((d) => d.id).filter((id): id is string => !!id);
      // A read that fails (or throws) leaves the priors unknown — which
      // recalls — and never stops the apply.
      for (let i = 0; i < ids.length; i += 100) {
        try {
          const { data: rows, error: readErr } = await supabase.from("documents").select("id, status").in("id", ids.slice(i, i + 100));
          if (!readErr) for (const r of (rows ?? []) as Array<{ id: string; status: string | null }>) priorStatusOf.set(r.id, r.status ?? null);
        } catch { /* unknown: recalls */ }
      }
    }
    for (const doc of docs) {
      try {
        // P15 review fix: the hold the database does not check for this row
        // (an unreadable hold state refuses it too); the row is not written.
        if (doc.id && enteringForceIds.has(doc.id)) await assertNotOnHold(doc.id, { action: ENTRY_INTO_FORCE_ACTION });
        const updates: Record<string, unknown> = { updated_at: now, updated_by: actorUserId };
        if (target.kind === "status") {
          updates.status = newValue;
          // REV-31: the Archive dialog's archive columns, in the same write.
          if (archiving) {
            updates.archived_at = now;
            updates.archived_by = actorUserId;
            updates.archive_reason = archiveReason.trim();
          }
        } else if (target.kind === "custom") {
          // Custom field lives in metadata jsonb
          const meta = { ...(doc.metadata ?? {}) };
          (meta as Record<string, unknown>)[target.def.key] = newValue;
          updates.metadata = meta;
        }
        // If this change affects a uniqueness-key contributing field,
        // recompute and write the new key so the constraint stays valid.
        const fieldKey = target.kind === "status" ? "status" : target.def.key;
        const keys = library.uniquenessKeys?.length ? library.uniquenessKeys : ["documentNumber"];
        if (keys.includes(fieldKey)) {
          updates.uniqueness_key = computeUniquenessKey({
            documentNumber: doc.documentNumber,
            title: doc.title,
            rev: doc.rev,
            status: target.kind === "status" ? newValue : doc.status,
            customFields: target.kind === "custom"
              ? { ...(doc.metadata as Record<string, unknown> ?? {}), [target.def.key]: newValue }
              : (doc.metadata as Record<string, unknown> ?? {}),
          }, library.uniquenessKeys);
        }
        // REV-19 (b) (P23): every write TO an issue status goes through
        // changeDocumentStatus — the database row decides whether it issues;
        // the page's view only picks the sentence.
        const pageSawIssue = !!doc.id && (issuingIds.has(doc.id) || enteringForceIds.has(doc.id));
        if (target.kind === "status" && doc.id && (pageSawIssue || isControlledIssueStatus(newValue))) {
          // REV-19: an issuing row — the same checked write, then the clocks
          // and the DOCUMENT_ISSUED record (a refusal throws in the
          // database's words, as the bare write's did). REV-26 (P25): a row
          // put in force out of IFC too (recorded; the roster opened, the
          // review clock left as it was).
          // changeDocumentStatus writes the status, updated_at and updated_by
          // itself; the recomputed uniqueness key rides in the same UPDATE.
          const patch: Record<string, unknown> = "uniqueness_key" in updates ? { uniqueness_key: updates.uniqueness_key } : {};
          const outcome: StatusIssueOutcome = await changeDocumentStatus({
            orgId: doc.orgId || library.orgId, documentId: doc.id, toStatus: newValue, door: "bulk",
            actorUserId, actorEmail: userEmail ?? null, actorRole: activeRole ?? null, patch,
            // notifications N17 (R2, DEC-90): one bulk edit, many documents —
            // the rosters it opens keep their bell rows and emails, no push
            notifyPush: false,
            // DIST-16 (P28 fix pass): the recalls are withdrawn ONCE for the apply, below
            withdrawRecall: false,
          });
          // Written: a row whose prior was not a controlled issue — or unknown
          // (the pre-apply read did not give it: absent from priorStatusOf,
          // never read as null, which isControlledIssueStatus counts as an
          // issue) — is a put-back candidate; withdrawRetirementBatch's read
          // of the row's own record decides whether a recall stands.
          if (issuing && (!priorStatusOf.has(doc.id) || !isControlledIssueStatus(priorStatusOf.get(doc.id)))) {
            putBack.push({ documentId: doc.id, libraryId: library.id ?? null, docLabel: doc.documentNumber || doc.title || doc.name || "A document", restoredStatus: newValue });
          }
          const label = doc.documentNumber || doc.title || doc.id;
          // Written, but not issued by THIS write (P17 integrator fix): the row
          // was already issued — by another change, after this page loaded —
          // or has no current revision. Nothing is owed for this write, and
          // starting its clocks again would restart a review clock the issuing
          // change owns.
          // REV-19 (b) (P23): a row this page showed issued (or with no
          // revision) that is still so — a plain success, as the bare write was.
          if (!pageSawIssue && !outcome.issued && (outcome.notRecordedBecause === "already_issued" || outcome.notRecordedBecause === "no_current_revision")) {
            ok += 1;
            continue;
          }
          // REV-19 (b) (P23): the row before the write could not be read, and
          // this page saw nothing to issue — whether this change issued it is
          // unknown: said so, never guessed.
          if (!pageSawIssue && !outcome.issued) {
            unchecked.push({ doc: label, note: "it was changed, but its state just before the change could not be read, so whether this change issued it is unknown: if another change after this page loaded had moved it out of issue (or given it its first revision), it is now issued and may carry no review clock or acknowledgment roster — check its history." });
            // P23 fix pass: the follow-up row saying no clock was started could not be written.
            if (outcome.recordError) followUps.push({ doc: label, problems: [`The record that no clock was started could not be written (${outcome.recordError}), so the document's history does not say so.`] });
            ok += 1;
            continue;
          }
          // REV-19 (b) (P23): the database row was issuable although this page
          // showed nothing to issue — this change issued it (recorded, clocks
          // handled) and Document Control is told.
          if (!pageSawIssue && outcome.issued) {
            unseen.push({
              doc: label,
              note: outcome.entryIntoForce
                ? `it was put in force by this change: another change after this page loaded had moved it to a status no gate reads as in force (or given it its first revision), and this change sets ${newValue} — the entry into force is recorded on its history, the acknowledgment roster opened and the review clock left as it was.`
                : `it was issued by this change: another change after this page loaded had moved it out of issue (or given it its first revision), and this change sets ${newValue} — the issue is recorded on its history like any other.`,
            });
          }
          if (!outcome.issued && outcome.notRecordedBecause === "already_issued") {
            notIssued.push({ doc: label, note: "it was already issued when this change reached it (issued by another change after this page loaded), so this change issued nothing: no clock was started and no issue record written for it, and nothing more is owed for this change. Do not start its clocks again from here — they belong to the change that issued it (see its history)." });
            ok += 1;
            continue;
          }
          if (!outcome.issued && outcome.notRecordedBecause === "no_current_revision") {
            notIssued.push({ doc: label, note: "it has no current revision, so there was nothing to issue: no clock or issue record is owed for it." });
            ok += 1;
            continue;
          }
          const problems = outcome.issued
            ? [
                ...outcome.complianceClockErrors,
                ...(outcome.recordError ? [`The issue record could not be written (${outcome.recordError}), so this issue is not on the document's history.`] : []),
              ]
            // Written, but not recorded as an issue: changeDocumentStatus could not
            // read the row's status before the write (notRecordedBecause
            // 'read_failed'), so it started no clock and wrote no DOCUMENT_ISSUED
            // (P17 review fix) — whether this write issued it is unknown.
            // REV-19 (a) (P23): since 20261205 the database records an issue
            // itself (it reads the row as it was), so "no issue record" is
            // said of this editor only.
            : [
                "The status was changed, but it was not recorded as an issue — its status before the change could not be read, so no review clock or acknowledgment roster was started and this editor wrote no issue record (since database update 20261205 the database records the issue itself, if it was one). Check its history and start its clocks from the document.",
                // P23 fix pass: the follow-up row saying so could not be written.
                ...(outcome.recordError ? [`The record that no clock was started could not be written (${outcome.recordError}), so the document's history does not say so.`] : []),
              ];
          if (problems.length > 0) followUps.push({ doc: label, problems });
          ok += 1;
          continue;
        }
        // Checked: an error, or a write the database filtered to no row, is a failure on this row.
        const { data: written, error } = await supabase.from("documents").update(updates).eq("id", doc.id).select("id");
        if (error) throw error;
        if (!written || written.length === 0) throw new Error("refused — the database updated nothing (no edit access to this document)");
        ok += 1;
        if (retiring && doc.id) {
          retired.push({ documentId: doc.id, libraryId: library.id ?? null, docLabel: doc.documentNumber || doc.title || doc.name || "A document", recallCopyHolders: recallsCopyHolders(priorStatusOf.get(doc.id) ?? null), retiredFrom: priorStatusOf.get(doc.id) ?? null });
        }
        if (archiving && doc.id) archivedRows.push({ documentId: doc.id, label: String(doc.documentNumber || doc.title || doc.id), versionId: doc.currentVersionId ?? null });
      } catch (e) {
        const reason = (e as Error).message;
        // REV-19 (b) (P23): a write TO an issue status refused in the issue
        // rule's words is "not issued:" whatever this page showed.
        failed.push({ doc: doc.documentNumber || doc.title || doc.id || "?", reason, issue: (issuingIds.has(doc.id) || enteringForceIds.has(doc.id) || (target.kind === "status" && isControlledIssueStatus(newValue))) && isIssueRefusal(reason) });
      }
    }
    if (retired.length > 0) {
      const orgId = library.orgId || docs.find((d) => d.orgId)?.orgId || null;
      if (orgId) {
        void import("@/lib/staleCopies").then(({ recallRetiredBatch }) => recallRetiredBatch({
          orgId, newStatus: newValue, actorUserId, actorName: userEmail || actorUserId, docs: retired,
        })).catch((e) => console.error("[bulk-edit] PROD-17: the bulk retirement recall did not run", e));
      } else {
        console.error(`[bulk-edit] PROD-17: ${retired.length} document(s) were set to ${newValue} with no workspace known, so no retirement recall was sent`);
      }
    }
    if (putBack.length > 0) {
      const orgId = library.orgId || docs.find((d) => d.orgId)?.orgId || null;
      if (orgId) {
        void import("@/lib/staleCopies").then(({ withdrawRetirementBatch }) => withdrawRetirementBatch({
          orgId, door: "put_back", actorUserId, actorName: userEmail || actorUserId, docs: putBack,
        })).catch((e) => console.error("[bulk-edit] DIST-16: the bulk recall withdrawal did not run", e));
      } else {
        console.error(`[bulk-edit] DIST-16: ${putBack.length} document(s) were set to ${newValue} with no workspace known, so no recall withdrawal was sent`);
      }
    }
    // REV-31: the archive duties of every row this change archived — after
    // the recall is on its way; each duty checked, a row whose duties did not
    // complete named below (its archive stands).
    let archiveFollowUps: Array<{ doc: string; problems: string[] }> = [];
    if (archivedRows.length > 0) {
      const orgId = library.orgId || docs.find((d) => d.orgId)?.orgId || null;
      if (orgId) {
        const { problems } = await finishBulkArchive({
          orgId, actorUserId, actorEmail: userEmail ?? null, actorRole: activeRole ?? null,
          reason: archiveReason, via: "bulk_edit", docs: archivedRows,
        });
        archiveFollowUps = problems.map((p) => ({ doc: p.label, problems: p.problems }));
      } else {
        archiveFollowUps = archivedRows.map((r) => ({ doc: r.label, problems: ["its review draft, share links and ARCHIVE_DOC record were not handled: the workspace is not known"] }));
      }
    }
    setResults({ ok, failed, followUps, notIssued, unseen, unchecked, archiveFollowUps });
    setBusy(false);
    if (ok > 0) onApplied?.();
  };

  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 rounded-lg bg-violet-100 text-violet-700"><Pencil className="w-5 h-5" /></div>
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">Bulk edit · {docs.length} document{docs.length === 1 ? "" : "s"}</div>
            <div className="text-xs text-[var(--color-text-muted)]">Apply one change to every selected row. Each insert is independent — a single failure doesn&apos;t roll back the rest.</div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-1.5 block">Field to change</label>
            <select
              value={target.kind === "custom" ? `custom:${target.def.key}` : target.kind}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "status") {
                  setTarget({ kind: "status" }); setNewValue(STATUS_OPTIONS[0]);
                } else {
                  const key = v.replace(/^custom:/, "");
                  const def = customCols.find((c) => c.key === key);
                  if (def) {
                    setTarget({ kind: "custom", def });
                    setNewValue("");
                  }
                }
              }}
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
              disabled={busy}
            >
              <option value="status">Status</option>
              {customCols.map((c) => (
                <option key={c.key} value={`custom:${c.key}`}>{c.label} (custom)</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-1.5 block">New value</label>
            {target.kind === "status" ? (
              <select
                value={newValue} onChange={(e) => setNewValue(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
                disabled={busy}
              >
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : selectOptions ? (
              <select
                value={newValue} onChange={(e) => setNewValue(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
                disabled={busy}
              >
                <option value="">— pick one —</option>
                {selectOptions.map((o, i) => <option key={i} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                value={newValue} onChange={(e) => setNewValue(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
                placeholder="Value to set on every selected doc"
                disabled={busy}
              />
            )}
          </div>

          {!results && archiving && (
            // REV-31 (P28 integrator fix pass): one reason for the whole apply.
            <div>
              <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-1.5 block">Reason for archiving</label>
              <input
                value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
                placeholder="Recorded on each archived document's history"
                disabled={busy}
              />
              <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">Archiving retires each row: its review draft is voided, its live share links revoked, its copy holders recalled and its watchers told.</div>
            </div>
          )}

          {!results && issuingRows.length > 0 && (
            // REV-18: say which rows this ISSUES before the apply.
            <div data-testid="bulk-issue-note" className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
              {issuingRows.length} of the selected row{issuingRows.length === 1 ? "" : "s"} ({issuingRows.slice(0, 5).map((d) => d.documentNumber || d.title || d.id).join(", ")}{issuingRows.length > 5 ? `, +${issuingRows.length - 5} more` : ""}) {issuingRows.length === 1 ? "is" : "are"} not issued yet: setting {newValue} issues {issuingRows.length === 1 ? "its" : "their"} current revision as a controlled copy. The database refuses a row on hold, and — in a library that requires reviewer sign-off — a row whose revision was not reviewed, unless you are Document Control. A refused row is named after the apply; the others keep the change.
            </div>
          )}

          {!results && enteringForceRows.length > 0 && (
            // P15 review fix: say which rows this puts in force. REV-26 (P25):
            // what the database does, true before and after 20261185, and the record.
            <div data-testid="bulk-entry-into-force-note" className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
              {enteringForceRows.length} of the selected row{enteringForceRows.length === 1 ? "" : "s"} ({enteringForceRows.slice(0, 5).map((d) => d.documentNumber || d.title || d.id).join(", ")}{enteringForceRows.length > 5 ? `, +${enteringForceRows.length - 5} more` : ""}) {enteringForceRows.length === 1 ? "has a status" : "have statuses"} no gate reads as in force ({[...new Set(enteringForceRows.map((d) => d.status?.trim() ? d.status : "empty"))].join(", ")}): setting {newValue} puts {enteringForceRows.length === 1 ? "its" : "their"} current revision in force — the field pack prints it and a scan reads it as current. Each is an issue and is recorded as one (its acknowledgment roster opens; its review clock is left as it is). Each row&apos;s hold is checked first and a held row is refused (named after the apply); since database update 20261185 the database refuses a held row too (before that update it does not check this change). The revision&apos;s review is not checked.
            </div>
          )}

          {results && (
            <div className="space-y-2">
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-800 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                Applied to <b>{results.ok}</b> document{results.ok === 1 ? "" : "s"}.
              </div>
              {results.failed.length > 0 && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-800">
                  <div className="font-bold flex items-center gap-1.5 mb-1"><AlertTriangle className="w-4 h-4" /> {results.failed.length} failed</div>
                  {/* REV-18: every refused row is named (none hidden behind "+N more"),
                      and the issue rule's refusals say so; the other rows were applied. */}
                  <ul data-testid="bulk-refused-rows" className="ml-5 list-disc space-y-0.5 max-h-48 overflow-y-auto">
                    {results.failed.map((f, i) => (
                      <li key={i}><span className="font-mono">{f.doc}</span> — {f.issue ? "not issued: " : ""}{f.reason}</li>
                    ))}
                  </ul>
                  {results.ok > 0 && (
                    <div className="mt-1">The other {results.ok} row{results.ok === 1 ? " was" : "s were"} applied — each row is its own write, so nothing was rolled back.</div>
                  )}
                </div>
              )}
              {results.followUps.length > 0 && (
                // REV-19: an issue that landed without everything it owes.
                <div data-testid="bulk-issue-follow-ups" className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
                  <div className="font-bold flex items-center gap-1.5 mb-1">
                    <AlertTriangle className="w-4 h-4" /> {results.followUps.length} issued row{results.followUps.length === 1 ? "" : "s"} — follow-up steps did not complete
                  </div>
                  <div className="mb-1">The status change stands and is not rolled back — do not apply it again. Document Control can set what did not complete from the document.</div>
                  <ul className="ml-5 list-disc space-y-0.5 max-h-48 overflow-y-auto">
                    {results.followUps.map((f, i) => (
                      <li key={i}><span className="font-mono">{f.doc}</span> — {f.problems.join("; ")}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(results.archiveFollowUps?.length ?? 0) > 0 && (
                // REV-31 (P28 integrator fix pass): an archive that landed without its duties.
                <div data-testid="bulk-archive-follow-ups" className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
                  <div className="font-bold flex items-center gap-1.5 mb-1">
                    <AlertTriangle className="w-4 h-4" /> {results.archiveFollowUps!.length} archived row{results.archiveFollowUps!.length === 1 ? "" : "s"} — follow-up steps did not complete
                  </div>
                  <div className="mb-1">The archive stands and is not rolled back — do not apply it again. Document Control can finish what did not complete from the document.</div>
                  <ul className="ml-5 list-disc space-y-0.5 max-h-48 overflow-y-auto">
                    {results.archiveFollowUps!.map((f, i) => (
                      <li key={i}><span className="font-mono">{f.doc}</span> — {f.problems.join("; ")}</li>
                    ))}
                  </ul>
                </div>
              )}
              {results.unseen.length > 0 && (
                // REV-19 (b) (P23): rows this page showed issued whose database row said otherwise.
                <div data-testid="bulk-unseen-issue-rows" className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
                  <div className="font-bold mb-1">
                    {results.unseen.length} row{results.unseen.length === 1 ? " was" : "s were"} changed by someone else after this page loaded
                  </div>
                  <ul className="ml-5 list-disc space-y-0.5 max-h-48 overflow-y-auto">
                    {results.unseen.map((f, i) => (
                      <li key={i}><span className="font-mono">{f.doc}</span> — {f.note}</li>
                    ))}
                  </ul>
                </div>
              )}
              {results.unchecked.length > 0 && (
                // REV-19 (b) (P23 review 3): the row's state just before the write could not be read.
                <div data-testid="bulk-unchecked-issue-rows" className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
                  <div className="font-bold mb-1">
                    {results.unchecked.length} row{results.unchecked.length === 1 ? "" : "s"}: whether this change issued {results.unchecked.length === 1 ? "it" : "them"} could not be told
                  </div>
                  <ul className="ml-5 list-disc space-y-0.5 max-h-48 overflow-y-auto">
                    {results.unchecked.map((f, i) => (
                      <li key={i}><span className="font-mono">{f.doc}</span> — {f.note}</li>
                    ))}
                  </ul>
                </div>
              )}
              {results.notIssued.length > 0 && (
                // REV-19 (P17 integrator fix): written, but not issued by this change — nothing owed.
                <div data-testid="bulk-not-issued-rows" className="rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] p-3 text-xs text-[var(--color-text)]">
                  <div className="font-bold mb-1">
                    {results.notIssued.length} row{results.notIssued.length === 1 ? " was" : "s were"} not issued by this change — nothing more is owed
                  </div>
                  <ul className="ml-5 list-disc space-y-0.5 max-h-48 overflow-y-auto">
                    {results.notIssued.map((f, i) => (
                      <li key={i}><span className="font-mono">{f.doc}</span> — {f.note}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
            {results ? "Close" : "Cancel"}
          </button>
          {!results && (
            <button
              onClick={apply}
              disabled={busy || !newValue || (archiving && !archiveReason.trim())}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5" />}
              {busy ? "Applying…" : `Apply to ${docs.length}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
