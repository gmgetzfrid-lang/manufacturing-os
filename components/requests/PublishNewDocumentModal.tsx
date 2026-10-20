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
//
// DF-P15 fix (on review): the first version is found by what it IS — the
// version of THIS new document that carries the ticket, in the request's
// library (lib/ticketNewDocumentHandback.ts) — with the read checked; a read
// that fails hands back no version and its reason, and the page then offers
// to record the existing document, never to create a second one.
//
// DCW-4 remainder (ruled by the integrator at the DF-P15 merge, 2026-10-20,
// DEC-90; DEC-107 stands — a request never requires a library at filing): for
// a request with neither a source document nor a library, the page passes
// `libraryChoices` — the libraries where this publisher may put a first
// revision (canPutFirstRevisionInContainer, evaluated per library) — and the
// publisher chooses one here. Only a listed library can be submitted; the
// request's own library field is never written; /api/tickets/handback checks
// the publisher's authority on the chosen library again, server-side.

import React, { useState } from "react";
import { FilePlus2, Loader2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { createDocumentWithFile, type CreationStatus } from "@/lib/revisions";
import { findTicketNewDocumentVersion } from "@/lib/ticketNewDocumentHandback";

export interface PublishNewDocumentModalProps {
  orgId: string;
  /** The request's library — null when the publisher chooses one from `libraryChoices`. */
  libraryId: string | null;
  libraryName: string;
  /** DCW-4 remainder: a request with neither a source document nor a library
   *  — the libraries this publisher may put a first revision into. */
  libraryChoices?: ReadonlyArray<{ id: string; name: string }> | null;
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
  onCreated: (result: { versionId: string | null; revisionLabel: string; versionReadError: string | null; documentId: string; documentNumber: string; status: CreationStatus; creationAuditError: string | null; libraryId: string }) => void | Promise<void>;
}

export default function PublishNewDocumentModal(props: PublishNewDocumentModalProps) {
  const [documentNumber, setDocumentNumber] = useState("");
  const [title, setTitle] = useState(props.defaultTitle);
  const [status, setStatus] = useState<CreationStatus>("Draft");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = !props.libraryId ? (props.libraryChoices ?? []) : [];
  const [chosenLibraryId, setChosenLibraryId] = useState<string>(choices.length === 1 ? choices[0].id : "");
  const targetLibraryId = props.libraryId ?? (choices.some((c) => c.id === chosenLibraryId) ? chosenLibraryId : null);
  const targetName = props.libraryId ? props.libraryName : (choices.find((c) => c.id === chosenLibraryId)?.name ?? null);

  const submit = async () => {
    const num = documentNumber.trim();
    if (!targetLibraryId) { setError("Choose the library to publish it into."); return; }
    if (!num) { setError("A document number is required."); return; }
    setBusy(true);
    setError(null);
    try {
      const created = await createDocumentWithFile({
        orgId: props.orgId,
        libraryId: targetLibraryId,
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
      // The first version: this document's, carrying the ticket, read checked.
      const found = await findTicketNewDocumentVersion(supabase, {
        orgId: props.orgId, ticketRowId: props.ticketRowId, libraryId: targetLibraryId, documentId: created.documentId,
      });
      await props.onCreated({
        versionId: found.kind === "found" ? found.version.versionId : null,
        revisionLabel: found.kind === "found" ? found.version.revisionLabel : "0",
        versionReadError: found.kind === "found" ? null : found.kind === "unknown" ? found.error : "no version carrying this request was found",
        documentId: created.documentId, documentNumber: num, status: created.status, creationAuditError: created.creationAuditError,
        libraryId: targetLibraryId,
      });
    } catch (e) {
      setError((e as Error)?.message || "The document could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const fieldCls = "w-full text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] px-2.5 py-1.5 outline-none focus:border-[var(--color-accent)]";

  return (
    <div className="fixed inset-0 z-[520] flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-sm p-4" onClick={props.onClose}>
      <div role="dialog" aria-label={props.libraryId ? `Publish as a new document in ${props.libraryName}` : "Publish as a new document"} className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-3">
          <FilePlus2 className="w-5 h-5 text-emerald-600" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-[var(--color-text)]">{props.libraryId ? `Publish as a new document in ${props.libraryName}` : `Publish as a new document${targetName ? ` in ${targetName}` : ""}`}</div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">The Final deliverable of request {props.ticketNumber}: {props.file.name}</div>
          </div>
          <button type="button" onClick={props.onClose} aria-label="Close" className="p-1 rounded hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          {!props.libraryId && (
            <label className="block text-[11px] font-bold text-[var(--color-text-muted)]">
              Library
              <select value={chosenLibraryId} onChange={(e) => setChosenLibraryId(e.target.value)} className={`${fieldCls} mt-1`} aria-label="Library">
                <option value="">Choose a library…</option>
                {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <span className="block mt-1 font-normal">This request names no library, so choose where the new document goes — one where you may add a document. The request itself is not changed.</span>
            </label>
          )}
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
