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
  Clock, ShieldAlert, FileText, Eye, Download as DownloadIcon,
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

import { friendlyError } from "@/lib/friendlyError";
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
      setError(friendlyError(e));
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
      setLabelError(friendlyError(e));
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
        fileUrl: httpUrl,
        userId: currentUserId,
        userEmail: currentUserEmail ?? null,
        userLabel: currentUserEmail ?? null,
      });
    } catch (e) {
      console.error(e);
      setError(friendlyError(e));
    } finally {
      setDownloadingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-body text-[var(--color-text-muted)] px-3 py-4">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading history…
      </div>
    );
  }

  if (error) {
    return (
      <p role="alert" className="text-body text-[var(--state-overdue)] border-l-2 border-[var(--state-overdue)] pl-3 py-1">{error}</p>
    );
  }

  if (versions.length === 0) {
    return (
      <>
        <div className="text-body text-[var(--color-text-muted)] px-3 py-4 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <HistoryIcon className="w-3.5 h-3.5" /> No revisions recorded yet.
          </span>
          {canRevert && currentUserId && doc.orgId && (
            <button
              onClick={() => setBackfillOpen(true)}
              className="inline-flex items-center gap-1 text-body font-medium text-[var(--color-text)] hover:text-[var(--color-text)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-2)] border border-[var(--color-border)] px-2 py-1 rounded"
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
        <div className="font-display text-reading font-semibold text-[var(--color-heading)] flex items-center gap-2">
          <span className="ui-icon-tile is-sm" aria-hidden><Layers className="w-4 h-4" /></span> Version history
          <span className="ui-count font-sans" title={`${versions.length} revision${versions.length === 1 ? "" : "s"}`}>{versions.length}</span>
          <HelpTooltip>
            Every revision of this document, newest first. Each row links to its file, SHA-256 hash,
            and the engineering signoffs (Drawn / Checked / Approved) captured at release.
            <b className="block mt-1">Compare</b> diffs an older rev against the current one.
            <b className="block mt-1">Pencil</b> corrects a mislabeled rev after the fact (e.g. uploaded as Rev 0 but the stamp reads 38) - the old and new label are audited.
            <b className="block mt-1">Revert</b> creates a new revision that copies the older file forward - no history is rewritten.
            <b className="block mt-1">Backfill older</b> adds a historical revision without changing the current - for when you uploaded the current rev first and need to populate older ones.
          </HelpTooltip>
        </div>
        <div className="flex items-center gap-2">
          {canRevert && currentUserId && doc.orgId && (
            <button
              onClick={() => setBackfillOpen(true)}
              className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              title="Add a historical revision (does not change current)"
            >
              <ArrowUpFromLine className="w-3 h-3" /> Backfill older
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {versions.map((v) => {
          const isCurrent = v.id === doc.currentVersionId;
          return (
            <div
              key={v.id}
              className={`relative rounded-md border p-3 overflow-hidden ${
                isCurrent
                  ? "border-[color-mix(in_srgb,var(--color-main)_30%,transparent)] bg-[var(--color-accent-soft)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)]"
              }`}
            >
              {isCurrent && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--color-main)]" />}
              {/* Top row: rev label + status badges + actions */}
              <div className="flex items-start gap-3">
                <div className={`shrink-0 ui-id text-section leading-6 ${isCurrent ? "!text-[var(--color-main)]" : ""}`}>
                  <span className="font-sans text-body font-normal text-[var(--color-text-muted)] mr-1">Rev</span>{v.revisionLabel || "-"}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isCurrent ? (
                      <span className="ui-pill is-solid">Current</span>
                    ) : v.isBranch ? (
                      <span
                        className="ui-pill is-warn"
                        title="Saved as a branch from an old base. Never made current. See the open items for where it stands."
                      >
                        <ShieldAlert className="w-3 h-3" /> Branch
                      </span>
                    ) : (
                      <span className="ui-pill is-muted">Superseded</span>
                    )}
                    {v.issueType && (
                      <span className="ui-tag !h-6 !font-sans !text-body">{v.issueType}</span>
                    )}
                    {v.changeType && (
                      <span className="ui-tag !h-6 !font-sans !text-body">{v.changeType}</span>
                    )}
                    {v.revertedFromVersionId && (
                      <span className="ui-pill is-muted"><RotateCcw className="w-3 h-3" /> Revert</span>
                    )}
                    {v.provenance === "unverified" && (
                      <span
                        className="ui-pill is-bad"
                        title="Published with no recorded checkout/download trail and no verified base declaration. Document Control reviews these, like QA receiving inspection."
                      >
                        <ShieldAlert className="w-3 h-3" /> Unverified provenance
                      </span>
                    )}
                    {v.provenance === "session" && (
                      <span
                        className="ui-pill is-good"
                        title="Published from a checkout: full record of where it came from."
                      >
                        From a checkout
                      </span>
                    )}
                    {v.provenance === "external" && (
                      <span
                        className="ui-pill"
                        title="Submitted by an outside company through a project intake link. External work enters through review (or a trusted link's own documents). The submitting company is on the record."
                      >
                        External{v.createdByName ? `: ${v.createdByName}` : ""}
                      </span>
                    )}
                    {v.sourceFileKey && (
                      <span
                        className="ui-tag !h-6 !font-sans !text-body"
                        title="The native CAD source file is stored with this revision."
                      >
                        <FileText className="w-3 h-3" /> CAD source
                      </span>
                    )}
                  </div>

                  <div className="mt-1 text-body text-[var(--color-text-muted)] flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                    <span className="inline-flex items-center gap-1 whitespace-nowrap"><Clock className="w-3 h-3" />{formatDate(v.createdAt)}</span>
                    {v.createdByName && <span className="min-w-0 truncate">by <span className="font-medium text-[var(--color-text)]">{v.createdByName}</span></span>}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => onOpenVersion(v)}
                    title="Open this revision in the viewer" aria-label={`Open Rev ${v.revisionLabel || ""}`}
                    className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-main)] hover:bg-[var(--color-surface)]"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                  {!isCurrent && currentVersion && currentVersion.id !== v.id && (
                    <button
                      onClick={() => setDiffBaseVersion(v)}
                      title={`Compare Rev ${v.revisionLabel} with current revision`} aria-label={`Compare Rev ${v.revisionLabel} with current`}
                      className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-main)] hover:bg-[var(--color-surface)]"
                    >
                      <GitCompare className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => void handleDownload(v)}
                    disabled={downloadingId === v.id || !currentUserId}
                    title="Download this revision (uncontrolled stamp)" aria-label={`Download Rev ${v.revisionLabel || ""}`}
                    className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-main)] hover:bg-[var(--color-surface)] disabled:opacity-40"
                  >
                    {downloadingId === v.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <DownloadIcon className="w-3.5 h-3.5" />}
                  </button>
                  {/* Correct label — controllers only; drafts' labels belong to the review flow */}
                  {canRevert && currentUserId && doc.orgId && doc.libraryId && v.reviewState !== "in_review" && (
                    <button
                      onClick={() => openCorrect(v)}
                      title={`Correct the revision label (currently "${v.revisionLabel || "-"}"): audited`} aria-label={`Correct the label of Rev ${v.revisionLabel || ""}`}
                      className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-main)] hover:bg-[var(--color-surface)]"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {/* Revert button — superseded versions only, admin/DocCtrl only */}
                  {canRevert && !isCurrent && onRevertVersion && (
                    <button
                      onClick={() => onRevertVersion(v)}
                      title="Revert document to this revision" aria-label={`Revert to Rev ${v.revisionLabel || ""}`}
                      className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-main)] hover:bg-[var(--color-surface)]"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Narrative */}
              {v.changeLog && (
                <div className="mt-2 pl-1 text-body text-[var(--color-text)] flex items-start gap-1.5">
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
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 pl-1 text-body text-[var(--color-text-muted)]">
                  {v.mocReference && (
                    <span className="inline-flex items-center gap-1">
                      <LinkIcon className="w-3 h-3" /> MOC <b className="ui-id">{v.mocReference}</b>
                    </span>
                  )}
                  {v.sourceFileName && (
                    <span className="inline-flex items-center gap-1">
                      <FileText className="w-3 h-3" /> <b className="text-[var(--color-text)] font-medium">{v.sourceFileName}</b>
                    </span>
                  )}
                </div>
              )}

              {/* Footer: size + hash */}
              <div className="mt-2 pl-1 flex items-center gap-3 text-body text-[var(--color-text-faint)] font-display tabular-nums">
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
          className="fixed inset-0 z-[230] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in flex items-center justify-center p-4"
          onClick={() => { if (!savingLabel) setCorrectTarget(null); }}
        >
          <form
            className="w-full max-w-sm rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl p-4 animate-in fade-in zoom-in-95"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); void saveLabelCorrection(); }}
          >
            <div className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
              <Pencil className="w-4 h-4 text-[var(--color-text-muted)]" /> Correct revision label
            </div>
            <p className="text-body text-[var(--color-text-muted)] mt-1">
              Rev <b className="font-display tabular-nums">{correctTarget.revisionLabel || "-"}</b>
              {correctTarget.id === doc.currentVersionId ? " (current)" : ""} gets a new label.
              The correction is audited: old and new label, who, when, and why.
              {correctTarget.id === doc.currentVersionId && " The document's own rev label is updated to match."}
            </p>
            <label className="block mt-3 text-body font-medium text-[var(--color-text-muted)]">
              New label
              <input
                autoFocus
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                placeholder="e.g. 38"
                className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm font-display tabular-nums"
              />
            </label>
            <label className="block mt-2 text-body font-medium text-[var(--color-text-muted)]">
              Why (recommended)
              <input
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                placeholder="e.g. mislabeled at upload, title block reads 38"
                className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              />
            </label>
            {labelError && (
              <p role="alert" className="mt-2 text-body text-[var(--state-overdue)] border-l-2 border-[var(--state-overdue)] pl-2.5">{labelError}</p>
            )}
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setCorrectTarget(null)}
                disabled={savingLabel}
                className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingLabel || !labelDraft.trim()}
                className="px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] text-body font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
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
    <span className="inline-flex items-center gap-1 text-body text-[var(--color-text-muted)]">
      <span className="text-[var(--color-text-faint)]">{icon}</span>
      <span className="font-medium text-body">{label}</span>
      <span className="text-[var(--color-text)] font-medium">{name}</span>
    </span>
  );
}

function formatDate(ts: unknown): string {
  if (!ts) return "";
  try {
    const d = new Date(ts as string);
    if (Number.isNaN(d.getTime())) return String(ts);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit" });
  } catch { return String(ts); }
}
