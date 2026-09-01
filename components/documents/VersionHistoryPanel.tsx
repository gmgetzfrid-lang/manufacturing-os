"use client";

// VersionHistoryPanel — chronological audit-ready list of every revision
// of a single document. Newest first. Each row exposes the full engineering
// signoff, the change narrative, the MOC reference, the source CAD file,
// and a SHA-256 hash for tamper detection. Lets the user open a previous
// version in the viewer (always rendered as an uncontrolled copy since it
// is, by definition, no longer the current revision).

import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Clock, ShieldCheck, ShieldAlert, FileText, Eye, Download as DownloadIcon,
  Hash, Loader2, Layers, MessageSquare, User, CheckSquare, Stamp,
  Link as LinkIcon, History as HistoryIcon, RotateCcw, GitCompare,
  ArrowUpFromLine, Pencil,
} from "lucide-react";
import { listVersions, correctRevisionLabel } from "@/lib/revisions";
import { downloadDocumentPdf } from "@/lib/downloads";
import { supabase } from "@/lib/supabase";
import { useArchiveAwareOpen } from "@/components/archive/ArchiveAwareOpen";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";
import CompareRevisionsModal from "@/components/documents/CompareRevisionsModal";
import BackfillVersionModal from "@/components/documents/BackfillVersionModal";
import HelpTooltip from "@/components/ui/HelpTooltip";

interface VersionHistoryPanelProps {
  doc: DocumentRecord;
  currentUserId?: string;
  currentUserEmail?: string;
  /** Actor's org role — passed through to authority checks (label correction). */
  userRole?: string | null;
  onOpenVersion: (version: DocumentVersion) => void;
  /** Admin-only: opens the Revert confirm modal for the given old version. */
  onRevertVersion?: (version: DocumentVersion) => void;
  /** True when the caller is an Admin / DocCtrl who can revert. */
  canRevert?: boolean;
  refreshKey?: number;
}

export default function VersionHistoryPanel({
  doc, currentUserId, currentUserEmail, userRole, onOpenVersion,
  onRevertVersion, canRevert, refreshKey,
}: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // Compare modal: when set, opens CompareRevisionsModal preselecting the
  // chosen older revision as base and the current revision as compare.
  const [diffBaseVersion, setDiffBaseVersion] = useState<DocumentVersion | null>(null);
  // Backfill modal — for retroactively adding a historical revision so
  // the diff overlay has older versions to compare against.
  const [backfillOpen, setBackfillOpen] = useState(false);
  // Label-correction mini-modal: fix a mislabeled revision after the fact
  // ("uploaded as Rev 0, the stamp reads Rev 38"). Audited old → new.
  const [correctTarget, setCorrectTarget] = useState<DocumentVersion | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [reasonDraft, setReasonDraft] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [savingLabel, setSavingLabel] = useState(false);
  const currentVersion = versions.find((v) => v.id === doc.currentVersionId) ?? null;
  // Archive awareness: if a revision's binary was shed for space, opening it
  // prompts for the offline archive instead of failing.
  const { open: openArchived, modal: archivedModal } = useArchiveAwareOpen();

  const refresh = useCallback(async () => {
    if (!doc.id) return;
    setLoading(true);
    setError(null);
    try {
      const list = await listVersions(doc.id);
      setVersions(list);
    } catch (e) {
      setError((e as Error).message || "Could not load history");
    } finally {
      setLoading(false);
    }
  }, [doc.id]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  // Escape closes the label dialog only — capture + stopPropagation so the
  // Inspector drawer (which also listens for Escape on window) stays open.
  useEffect(() => {
    if (!correctTarget) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setCorrectTarget(null); }
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => window.removeEventListener("keydown", h, { capture: true });
  }, [correctTarget]);

  const openCorrect = (v: DocumentVersion) => {
    setLabelDraft(v.revisionLabel ?? "");
    setReasonDraft("");
    setLabelError(null);
    setCorrectTarget(v);
  };

  const saveLabelCorrection = async () => {
    if (!correctTarget?.id || !currentUserId || !doc.orgId || !doc.libraryId) return;
    setSavingLabel(true);
    setLabelError(null);
    try {
      await correctRevisionLabel({
        doc,
        versionId: correctTarget.id,
        newLabel: labelDraft,
        reason: reasonDraft,
        libraryId: doc.libraryId,
        orgId: doc.orgId,
        actorUserId: currentUserId,
        actorEmail: currentUserEmail,
        actorRole: userRole ?? undefined,
      });
      setCorrectTarget(null);
      void refresh();
    } catch (e) {
      setLabelError((e as Error).message);
    } finally {
      setSavingLabel(false);
    }
  };

  // For non-current versions we always force the uncontrolled stamp — even
  // if the user holds checkout on the document. The previous revisions are
  // never the authoritative drawing, so any copy of them must be marked.
  const handleDownload = async (v: DocumentVersion) => {
    if (!currentUserId || !v.id) return;
    setDownloadingId(v.id);
    try {
      // Resolve the storage path before downloading. If the binary was shed to
      // a cold archive, open the in-memory viewer with the exact archive to
      // provide instead of failing the download.
      let httpUrl = v.fileUrl;
      if (!httpUrl.startsWith("http") && !httpUrl.startsWith("blob:")) {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(
          `/api/storage/resolve?path=${encodeURIComponent(httpUrl)}`,
          { headers: { authorization: `Bearer ${session?.access_token ?? ""}` } }
        );
        const body = await res.json().catch(() => null);
        if (res.ok && body?.archived) {
          void openArchived(v.fileUrl, `Rev ${v.revisionLabel}`);
          return;
        }
        if (res.ok && body?.url) httpUrl = body.url as string;
      }
      // We pass a doc clone with checkedOutBy cleared, forcing the gate to
      // resolve "uncontrolled" regardless of the real checkout state.
      const docForDownload: DocumentRecord = { ...doc, checkedOutBy: undefined } as DocumentRecord;
      await downloadDocumentPdf({
        doc: docForDownload,
        versionId: v.id,
        // Stamp/filename/QR must name THIS revision, not the document's
        // current one (REV-1) — the panel downloads a specific historical
        // version's bytes.
        versionRev: v.revisionLabel ?? null,
        versionIsCurrent: v.id === doc.currentVersionId,
        fileUrl: httpUrl,
        userId: currentUserId,
        userEmail: currentUserEmail ?? null,
        userLabel: currentUserEmail ?? null,
      });
    } catch (e) {
      console.error(e);
      setError((e as Error).message || "Download failed");
    } finally {
      setDownloadingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] px-3 py-4">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading history…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-red-600 px-3 py-3 bg-red-50 border border-red-200 rounded-lg">{error}</div>
    );
  }

  if (versions.length === 0) {
    return (
      <>
        <div className="text-xs text-[var(--color-text-muted)] px-3 py-4 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <HistoryIcon className="w-3.5 h-3.5" /> No revisions recorded yet.
          </span>
          {canRevert && currentUserId && doc.orgId && (
            <button
              onClick={() => setBackfillOpen(true)}
              className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-700 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-200 px-2 py-1 rounded"
              title="Add a historical revision (does not change current)"
            >
              <ArrowUpFromLine className="w-3 h-3" /> Backfill older
            </button>
          )}
        </div>
        {backfillOpen && currentUserId && doc.orgId && doc.libraryId && (
          <BackfillVersionModal
            isOpen
            onClose={() => setBackfillOpen(false)}
            doc={doc}
            libraryId={doc.libraryId}
            orgId={doc.orgId}
            actorUserId={currentUserId}
            actorEmail={currentUserEmail}
            onSuccess={() => { setBackfillOpen(false); void refresh(); }}
          />
        )}
      </>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <div className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest flex items-center gap-1.5">
          <Layers className="w-3 h-3" /> Version History
          <HelpTooltip>
            Every revision of this document, newest first. Each row links to its file, SHA-256 hash,
            and the engineering signoffs (Drawn / Checked / Approved) captured at release.
            <b className="block mt-1">Compare</b> diffs an older rev against the current one.
            <b className="block mt-1">Pencil</b> corrects a mislabeled rev after the fact (e.g. uploaded as Rev 0 but the stamp reads 38) — the old and new label are audited.
            <b className="block mt-1">Revert</b> creates a new revision that copies the older file forward — no history is rewritten.
            <b className="block mt-1">Backfill older</b> adds a historical revision without changing the current — for when you uploaded the current rev first and need to populate older ones.
          </HelpTooltip>
        </div>
        <div className="flex items-center gap-2">
          {canRevert && currentUserId && doc.orgId && (
            <button
              onClick={() => setBackfillOpen(true)}
              className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-700 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-200 px-1.5 py-0.5 rounded"
              title="Add a historical revision (does not change current)"
            >
              <ArrowUpFromLine className="w-3 h-3" /> Backfill older
            </button>
          )}
          <div className="text-[10px] text-[var(--color-text-muted)] font-mono">{versions.length} rev{versions.length === 1 ? "" : "s"}</div>
        </div>
      </div>

      <div className="space-y-2">
        {versions.map((v) => {
          const isCurrent = v.id === doc.currentVersionId;
          return (
            <div
              key={v.id}
              className={`rounded-xl border p-3 ${
                isCurrent
                  ? "border-emerald-300 bg-emerald-50/40"
                  : "border-[var(--color-border)] bg-[var(--color-surface)]"
              }`}
            >
              {/* Top row: rev label + status badges + actions */}
              <div className="flex items-start gap-3">
                <div className={`shrink-0 px-2 py-1 rounded-md font-black text-xs font-mono ${
                  isCurrent
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-200 text-[var(--color-text)]"
                }`}>
                  Rev {v.revisionLabel || "—"}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isCurrent ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                        <ShieldCheck className="w-3 h-3" /> Current
                      </span>
                    ) : v.isBranch ? (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded"
                        title="Published as a branch from a stale base — never promoted to current. See the open-items queue for its reconciliation status."
                      >
                        <ShieldAlert className="w-3 h-3" /> Branch
                      </span>
                    ) : v.reviewState != null && v.reviewState !== "approved" ? (
                      // REV-2: a draft that was never issued is NOT "Superseded" —
                      // that badge is a false document-control statement.
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded"
                        title="An unreviewed draft — it has never been the controlled copy and cannot be reverted to."
                      >
                        <ShieldAlert className="w-3 h-3" /> {v.reviewState === "in_review" ? "In review" : "Draft (not issued)"}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                        <ShieldAlert className="w-3 h-3" /> Superseded
                      </span>
                    )}
                    {v.issueType && (
                      <span className="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">{v.issueType}</span>
                    )}
                    {v.changeType && (
                      <span className="text-[10px] font-bold text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{v.changeType}</span>
                    )}
                    {v.revertedFromVersionId && (
                      <span className="text-[10px] font-bold text-purple-700 bg-purple-50 border border-purple-200 px-1.5 py-0.5 rounded">Revert</span>
                    )}
                    {v.provenance === "unverified" && (
                      <span
                        className="text-[10px] font-bold text-red-700 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded"
                        title="Published with no recorded checkout/download trail and no verified base declaration. Document Control reviews these — like QA receiving inspection."
                      >
                        ⚑ Unverified provenance
                      </span>
                    )}
                    {v.provenance === "session" && (
                      <span
                        className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded"
                        title="Published from an active checkout session — full provenance."
                      >
                        Session
                      </span>
                    )}
                    {v.provenance === "external" && (
                      <span
                        className="text-[10px] font-bold text-orange-700 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded"
                        title="Submitted by an outside company through a project intake link. External work enters through review (or a trusted link's own documents) — the submitting company is on the record."
                      >
                        External{v.createdByName ? ` · ${v.createdByName}` : ""}
                      </span>
                    )}
                    {v.sourceFileKey && (
                      <span
                        className="text-[10px] font-bold text-sky-700 bg-sky-50 border border-sky-200 px-1.5 py-0.5 rounded"
                        title="The native CAD source file is stored with this revision."
                      >
                        CAD source
                      </span>
                    )}
                  </div>

                  <div className="mt-1 text-[11px] text-[var(--color-text-muted)] flex items-center gap-2">
                    <Clock className="w-3 h-3" />
                    {formatDate(v.createdAt)}
                    {v.createdByName && <> • by <b className="text-[var(--color-text)]">{v.createdByName}</b></>}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => onOpenVersion(v)}
                    title="Open this revision in the viewer"
                    className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-orange-600 hover:bg-orange-50"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                  {!isCurrent && currentVersion && currentVersion.id !== v.id && (
                    <button
                      onClick={() => setDiffBaseVersion(v)}
                      title={`Compare Rev ${v.revisionLabel} with current revision`}
                      className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-blue-600 hover:bg-blue-50"
                    >
                      <GitCompare className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => void handleDownload(v)}
                    disabled={downloadingId === v.id || !currentUserId}
                    title="Download this revision (uncontrolled stamp)"
                    className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-orange-600 hover:bg-orange-50 disabled:opacity-40"
                  >
                    {downloadingId === v.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <DownloadIcon className="w-3.5 h-3.5" />}
                  </button>
                  {/* Correct label — controllers only; drafts' labels belong to the review flow */}
                  {canRevert && currentUserId && doc.orgId && doc.libraryId && v.reviewState !== "in_review" && (
                    <button
                      onClick={() => openCorrect(v)}
                      title={`Correct the revision label (currently "${v.revisionLabel || "—"}") — audited`}
                      className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-blue-700 hover:bg-blue-50"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {/* Revert button — previously-ISSUED revisions only (REV-2):
                      an in-review/rejected draft or an unreconciled branch has
                      never passed the gate; revertToVersion and the RPC refuse
                      them too, this just doesn't offer the dead end. Shown to
                      any authorized publisher (canRevert = canPublishEff). */}
                  {canRevert && !isCurrent && onRevertVersion && !v.isBranch
                    && (v.reviewState == null || v.reviewState === "approved") && (
                    <button
                      onClick={() => onRevertVersion(v)}
                      title="Revert document to this revision"
                      className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-purple-700 hover:bg-purple-50"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Narrative */}
              {v.changeLog && (
                <div className="mt-2 pl-1 text-[11px] text-[var(--color-text)] flex items-start gap-1.5">
                  <MessageSquare className="w-3 h-3 mt-0.5 shrink-0 text-[var(--color-text-faint)]" />
                  <span className="whitespace-pre-wrap">{v.changeLog}</span>
                </div>
              )}

              {/* Signoff chain */}
              {(v.drawnByName || v.checkedByName || v.approvedByName) && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 pl-1">
                  {v.drawnByName && <SignoffBit icon={<User className="w-3 h-3" />} label="Drawn" name={v.drawnByName} />}
                  {v.checkedByName && <SignoffBit icon={<CheckSquare className="w-3 h-3" />} label="Checked" name={v.checkedByName} />}
                  {v.approvedByName && <SignoffBit icon={<Stamp className="w-3 h-3" />} label="Approved" name={v.approvedByName} />}
                </div>
              )}

              {/* Cross-references */}
              {(v.mocReference || v.sourceFileName) && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 pl-1 text-[10px] text-[var(--color-text-muted)]">
                  {v.mocReference && (
                    <span className="inline-flex items-center gap-1">
                      <LinkIcon className="w-3 h-3" /> MOC <b className="text-[var(--color-text)] font-mono">{v.mocReference}</b>
                    </span>
                  )}
                  {v.sourceFileName && (
                    <span className="inline-flex items-center gap-1">
                      <FileText className="w-3 h-3" /> <b className="text-[var(--color-text)] font-mono">{v.sourceFileName}</b>
                    </span>
                  )}
                </div>
              )}

              {/* Footer: size + hash */}
              <div className="mt-2 pl-1 flex items-center gap-3 text-[10px] text-[var(--color-text-faint)] font-mono">
                {typeof v.size === "number" && <span>{(v.size / 1024).toFixed(0)} KB</span>}
                {v.fileHash && (
                  <span title={`SHA-256: ${v.fileHash}`} className="inline-flex items-center gap-1">
                    <Hash className="w-3 h-3" /> {v.fileHash.slice(0, 10)}…
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {diffBaseVersion && currentVersion && (
        <CompareRevisionsModal
          isOpen
          onClose={() => setDiffBaseVersion(null)}
          doc={doc}
          initialBaseVersionId={diffBaseVersion.id}
          initialCompareVersionId={currentVersion.id}
        />
      )}
      {backfillOpen && currentUserId && doc.orgId && doc.libraryId && (
        <BackfillVersionModal
          isOpen
          onClose={() => setBackfillOpen(false)}
          doc={doc}
          libraryId={doc.libraryId}
          orgId={doc.orgId}
          actorUserId={currentUserId}
          actorEmail={currentUserEmail}
          onSuccess={() => { setBackfillOpen(false); void refresh(); }}
        />
      )}

      {/* Label-correction dialog — PORTALED to <body>: the Inspector drawer's
          slide-in transform would otherwise trap this fixed overlay inside it. */}
      {correctTarget && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[230] bg-slate-900/50 backdrop-blur-[2px] animate-in fade-in flex items-center justify-center p-4"
          onClick={() => { if (!savingLabel) setCorrectTarget(null); }}
        >
          <form
            className="w-full max-w-sm rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl p-4 animate-in fade-in zoom-in-95"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); void saveLabelCorrection(); }}
          >
            <div className="text-sm font-black text-[var(--color-text)] flex items-center gap-2">
              <Pencil className="w-4 h-4 text-blue-600" /> Correct revision label
            </div>
            <p className="text-xs text-[var(--color-text-muted)] mt-1">
              Rev <b className="font-mono">{correctTarget.revisionLabel || "—"}</b>
              {correctTarget.id === doc.currentVersionId ? " (current)" : ""} gets a new label.
              The correction is audited — old and new label, who, when, and why.
              {correctTarget.id === doc.currentVersionId && " The document's own rev label is updated to match."}
            </p>
            <label className="block mt-3 text-xs font-bold text-[var(--color-text-muted)]">
              New label
              <input
                autoFocus
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                placeholder="e.g. 38"
                className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            <label className="block mt-2 text-xs font-bold text-[var(--color-text-muted)]">
              Why (recommended)
              <input
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                placeholder="e.g. mislabeled at upload — title block reads 38"
                className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            {labelError && (
              <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">{labelError}</div>
            )}
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setCorrectTarget(null)}
                disabled={savingLabel}
                className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingLabel || !labelDraft.trim()}
                className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {savingLabel ? <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</> : "Save correction"}
              </button>
            </div>
          </form>
        </div>,
        document.body
      )}
      {archivedModal}
    </div>
  );
}

function SignoffBit({ icon, label, name }: { icon: React.ReactNode; label: string; name: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
      <span className="text-[var(--color-text-faint)]">{icon}</span>
      <span className="font-bold uppercase tracking-wider text-[9px]">{label}</span>
      <span className="text-[var(--color-text)] font-medium">{name}</span>
    </span>
  );
}

function formatDate(ts: unknown): string {
  if (!ts) return "";
  try {
    const d = new Date(ts as string);
    return d.toLocaleString();
  } catch { return String(ts); }
}
