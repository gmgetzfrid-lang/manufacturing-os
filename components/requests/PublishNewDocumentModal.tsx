"use client";

// PublishNewDocumentModal — drafting-flow DCW-4's page half (DF-P15
// DELIVERABLE PAGE WIRING; also DCW-7's last limb): "Publish as a new
// document in <library>" for a request that names a target library and no
// source document. The page offers it only to someone who may put a new
// document's first revision into that library (lib/revisions.ts
// canPutFirstRevisionInContainer — the authority createDocumentWithFile
// itself checks first, so the offer and the creation cannot disagree).
//
// Nothing is published here by a second path (DEC-22): the new-document path
// IS createDocumentWithFile, with `relatedTicketId` — the ticket is recorded
// on the new document's first version (document_versions.related_ticket_id,
// provenance only, DEC-23) and on its DOCUMENT_CREATED row. Draft or Issued
// is the publisher's choice, as on every creation door (REV-11); Issued
// runs the library's review policy. The page then records the outcome on the
// request through /api/tickets/handback, which checks the version carries
// the ticket and its document is in the request's library.

import React, { useState } from "react";
import { FilePlus2, Loader2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { createDocumentWithFile, type CreationStatus } from "@/lib/revisions";

export interface PublishNewDocumentModalProps {
  orgId: string;
  libraryId: string;
  libraryName: string;
  ticketRowId: string;
  ticketNumber: string;
  defaultTitle: string;
  file: File;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  onClose: () => void;
  /** The document was created: its first version (the one carrying the
   *  ticket), its number, and a creation-record refusal to say, if any. */
  onCreated: (result: { versionId: string | null; documentId: string; documentNumber: string; status: CreationStatus; creationAuditError: string | null }) => void | Promise<void>;
}

export default function PublishNewDocumentModal(props: PublishNewDocumentModalProps) {
  const [documentNumber, setDocumentNumber] = useState("");
  const [title, setTitle] = useState(props.defaultTitle);
  const [status, setStatus] = useState<CreationStatus>("Draft");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const num = documentNumber.trim();
    if (!num) { setError("A document number is required."); return; }
    setBusy(true);
    setError(null);
    try {
      const created = await createDocumentWithFile({
        orgId: props.orgId,
        libraryId: props.libraryId,
        collectionId: null,
        documentNumber: num,
        title: title.trim() || undefined,
        file: props.file,
        status,
        actorUserId: props.actorUserId,
        actorEmail: props.actorEmail,
        actorRole: props.actorRole,
        relatedTicketId: props.ticketRowId,
      });
      // The first version is the document's current one right after creation.
      const { data: docRow } = await supabase
        .from("documents").select("current_version_id").eq("id", created.documentId).maybeSingle();
      const versionId = ((docRow as { current_version_id?: string | null } | null)?.current_version_id) ?? null;
      await props.onCreated({ versionId, documentId: created.documentId, documentNumber: num, status: created.status, creationAuditError: created.creationAuditError });
    } catch (e) {
      setError((e as Error)?.message || "The document could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const fieldCls = "w-full text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] px-2.5 py-1.5 outline-none focus:border-[var(--color-accent)]";

  return (
    <div className="fixed inset-0 z-[520] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm p-4" onClick={props.onClose}>
      <div role="dialog" aria-label={`Publish as a new document in ${props.libraryName}`} className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-3">
          <FilePlus2 className="w-5 h-5 text-emerald-600" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-[var(--color-text)]">Publish as a new document in {props.libraryName}</div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">The Final deliverable of request {props.ticketNumber}: {props.file.name}</div>
          </div>
          <button type="button" onClick={props.onClose} aria-label="Close" className="p-1 rounded hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <label className="block text-[11px] font-bold text-[var(--color-text-muted)]">
            Document number
            <input value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} className={`${fieldCls} mt-1`} placeholder="e.g. P-101-ISO-001" />
          </label>
          <label className="block text-[11px] font-bold text-[var(--color-text-muted)]">
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${fieldCls} mt-1`} />
          </label>
          <fieldset className="text-[11px] text-[var(--color-text-muted)]">
            <legend className="font-bold mb-1">File it as</legend>
            <label className="flex items-start gap-2 mb-1">
              <input type="radio" name="new-doc-status" checked={status === "Draft"} onChange={() => setStatus("Draft")} />
              <span><strong>Draft</strong> — in the register for reference, not a controlled copy (no compliance clocks).</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="new-doc-status" checked={status === "Issued"} onChange={() => setStatus("Issued")} />
              <span><strong>Issued</strong> — a controlled first revision; the library&apos;s review policy applies.</span>
            </label>
          </fieldset>
          {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        </div>
        <div className="px-5 py-3 border-t border-[var(--color-border)] flex justify-end gap-2">
          <button type="button" onClick={props.onClose} className="px-3 py-1.5 text-xs font-bold rounded-lg border border-[var(--color-border)]">Cancel</button>
          <button type="button" onClick={() => { void submit(); }} disabled={busy} className="px-3 py-1.5 text-xs font-bold rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white inline-flex items-center gap-1.5">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Create the document
          </button>
        </div>
      </div>
    </div>
  );
}
