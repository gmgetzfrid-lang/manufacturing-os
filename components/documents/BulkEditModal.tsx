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
// moved to Issued / Locked is PUT IN FORCE by the write, and the database's
// guard does not see it (isUnguardedEntryIntoForce). The modal names those
// rows before the apply and checks each one's hold itself (lib/holdGate.ts,
// fail closed) — a held row is refused and named; the publisher tier holds
// (the Bulk Edit button is Document Control's only). REV-21 is the database
// limb.
//
// REV-19 (P17): a row the status change ISSUES (isIssueTransition, the rows
// the note above names) is written through lib/revisions.ts
// changeDocumentStatus — the same one checked UPDATE (the status, the
// recomputed uniqueness key, updated_at / updated_by), then, when the
// database admitted it as an issue, the compliance clocks it owes (the
// review clock and the read-&-understood roster, or only the roster where
// the retirement stamp gives no evidence of a new issue) and the
// DOCUMENT_ISSUED record. A refused row is named exactly as before. An issue
// that landed but whose clocks or record did not follow is named after the
// apply — the change stands and is not to be repeated. Every other row
// (a status that issues nothing, a custom field) is written as before.

import React, { useState } from "react";
import {
  X, Pencil, Loader2, AlertTriangle, CheckCircle2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { computeUniquenessKey } from "@/lib/uniqueness";
import { isIssueTransition, isIssueRefusal } from "@/lib/issueStatus";
import { BULK_EDIT_STATUS_OPTIONS, isUnguardedEntryIntoForce, ENTRY_INTO_FORCE_ACTION } from "@/lib/documentStatusOptions";
import { assertNotOnHold } from "@/lib/holdGate";
import type { DocumentRecord, LibraryConfig, MetadataFieldDefinition } from "@/types/schema";
import { changeDocumentStatus, type StatusIssueOutcome } from "@/lib/revisions";

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
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{
    ok: number;
    failed: Array<{ doc: string; reason: string; issue: boolean }>;
    /** REV-19: issued rows whose clocks or issue record did not follow. */
    followUps: Array<{ doc: string; problems: string[] }>;
  } | null>(null);

  if (!isOpen) return null;

  // REV-18: the selected rows this status change would ISSUE.
  const issuingRows = target.kind === "status"
    ? docs.filter((d) => isIssueTransition({ fromStatus: d.status, toStatus: newValue, hasCurrentRevision: !!d.currentVersionId }))
    : [];
  // P15 review fix: the selected rows this status change puts IN FORCE with
  // no database check (an existing IFC row → Issued / Locked).
  const enteringForceRows = target.kind === "status"
    ? docs.filter((d) => isUnguardedEntryIntoForce({ fromStatus: d.status, toStatus: newValue, hasCurrentRevision: !!d.currentVersionId }))
    : [];

  const customCols = (library.customColumns ?? []).filter((c) => !["title", "rev", "status", "documentNumber"].includes(c.key));
  const selectOptions = target.kind === "custom" && target.def.type === "select" ? (target.def.options ?? []) : null;

  const apply = async () => {
    setBusy(true);
    setResults(null);
    const failed: Array<{ doc: string; reason: string; issue: boolean }> = [];
    const followUps: Array<{ doc: string; problems: string[] }> = [];
    const issuingIds = new Set(issuingRows.map((d) => d.id));
    const enteringForceIds = new Set(enteringForceRows.map((d) => d.id));
    let ok = 0;
    const now = new Date().toISOString();
    for (const doc of docs) {
      try {
        // P15 review fix: the hold the database does not check for this row
        // (an unreadable hold state refuses it too); the row is not written.
        if (doc.id && enteringForceIds.has(doc.id)) await assertNotOnHold(doc.id, { action: ENTRY_INTO_FORCE_ACTION });
        const updates: Record<string, unknown> = { updated_at: now, updated_by: actorUserId };
        if (target.kind === "status") {
          updates.status = newValue;
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
        if (target.kind === "status" && doc.id && issuingIds.has(doc.id)) {
          // REV-19: an issuing row — the same checked write, then the clocks
          // and the DOCUMENT_ISSUED record (a refusal throws in the
          // database's words, as the bare write's did).
          // changeDocumentStatus writes the status, updated_at and updated_by
          // itself; the recomputed uniqueness key rides in the same UPDATE.
          const patch: Record<string, unknown> = "uniqueness_key" in updates ? { uniqueness_key: updates.uniqueness_key } : {};
          const outcome: StatusIssueOutcome = await changeDocumentStatus({
            orgId: doc.orgId || library.orgId, documentId: doc.id, toStatus: newValue, door: "bulk",
            actorUserId, patch,
          });
          const problems = [
            ...outcome.complianceClockErrors,
            ...(outcome.recordError ? [`The issue record could not be written (${outcome.recordError}), so this issue is not on the document's history.`] : []),
          ];
          if (problems.length > 0) followUps.push({ doc: doc.documentNumber || doc.title || doc.id, problems });
          ok += 1;
          continue;
        }
        // Checked: an error, or a write the database filtered to no row, is a failure on this row.
        const { data: written, error } = await supabase.from("documents").update(updates).eq("id", doc.id).select("id");
        if (error) throw error;
        if (!written || written.length === 0) throw new Error("refused — the database updated nothing (no edit access to this document)");
        ok += 1;
      } catch (e) {
        const reason = (e as Error).message;
        failed.push({ doc: doc.documentNumber || doc.title || doc.id || "?", reason, issue: issuingIds.has(doc.id) && isIssueRefusal(reason) });
      }
    }
    setResults({ ok, failed, followUps });
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

          {!results && issuingRows.length > 0 && (
            // REV-18: say which rows this ISSUES before the apply.
            <div data-testid="bulk-issue-note" className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
              {issuingRows.length} of the selected row{issuingRows.length === 1 ? "" : "s"} ({issuingRows.slice(0, 5).map((d) => d.documentNumber || d.title || d.id).join(", ")}{issuingRows.length > 5 ? `, +${issuingRows.length - 5} more` : ""}) {issuingRows.length === 1 ? "is" : "are"} not issued yet: setting {newValue} issues {issuingRows.length === 1 ? "its" : "their"} current revision as a controlled copy. The database refuses a row on hold, and — in a library that requires reviewer sign-off — a row whose revision was not reviewed, unless you are Document Control. A refused row is named after the apply; the others keep the change.
            </div>
          )}

          {!results && enteringForceRows.length > 0 && (
            // P15 review fix: say which rows this puts in force with no database check.
            <div data-testid="bulk-entry-into-force-note" className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
              {enteringForceRows.length} of the selected row{enteringForceRows.length === 1 ? "" : "s"} ({enteringForceRows.slice(0, 5).map((d) => d.documentNumber || d.title || d.id).join(", ")}{enteringForceRows.length > 5 ? `, +${enteringForceRows.length - 5} more` : ""}) {enteringForceRows.length === 1 ? "has a status" : "have statuses"} no gate reads as in force ({[...new Set(enteringForceRows.map((d) => d.status?.trim() ? d.status : "empty"))].join(", ")}): setting {newValue} puts {enteringForceRows.length === 1 ? "its" : "their"} current revision in force — the field pack prints it and a scan reads it as current. The database does not check this change, so each row&apos;s hold is checked first and a held row is refused (named after the apply); the revision&apos;s review is not checked.
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
              disabled={busy || !newValue}
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
