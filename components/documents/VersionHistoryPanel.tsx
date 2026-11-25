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
  FileText, Eye, Download as DownloadIcon, Loader2,
  History as HistoryIcon, RotateCcw, GitCompare,
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
import MoreMenu, { type MoreItem } from "@/components/ui/MoreMenu";
import Timeline, { type TimelineItem } from "@/components/ui/Timeline";

import { friendlyError } from "@/lib/friendlyError";
import { FieldError } from "@/components/ui/Field";
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
      <FieldError>{error}</FieldError>
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

  // Each revision as a history entry: newest first, by day, a dot and the
  // rev for what it is, who as an avatar. Its five small actions sit in
  // one menu beside Open (B6, B8).
  const atOf = (t: DocumentVersion["createdAt"]) => (t instanceof Date ? t.getTime() : t ?? 0);
  const items: TimelineItem[] = versions.map((v, n): TimelineItem => {
    const isCurrent = v.id === doc.currentVersionId;
    const label = v.revisionLabel || "-";
    const more: MoreItem[] = [];
    if (!isCurrent && currentVersion && currentVersion.id !== v.id) {
      more.push({ icon: <GitCompare className="w-4 h-4" />, label: "Compare with current", onClick: () => setDiffBaseVersion(v) });
    }
    if (currentUserId && v.id) {
      more.push({
        icon: downloadingId === v.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <DownloadIcon className="w-4 h-4" />,
        label: downloadingId === v.id ? "Downloading…" : "Download (uncontrolled stamp)",
        onClick: () => { if (downloadingId !== v.id) void handleDownload(v); },
      });
    }
    // Correct label: controllers only; drafts' labels belong to the review flow.
    if (canRevert && currentUserId && doc.orgId && doc.libraryId && v.reviewState !== "in_review") {
      more.push({ icon: <Pencil className="w-4 h-4" />, label: "Correct the label", onClick: () => openCorrect(v) });
    }
    // Revert: superseded versions only, admin/DocCtrl only.
    if (canRevert && !isCurrent && onRevertVersion) {
      more.push({ icon: <RotateCcw className="w-4 h-4" />, label: `Revert to Rev ${label}`, onClick: () => onRevertVersion(v) });
    }
    // What the rev is, in words (each with its reason on hover).
    const words: Array<{ text: string; tip?: string; warn?: boolean; bad?: boolean }> = [
      isCurrent ? { text: "Current" }
        : v.isBranch ? { text: "Branch", tip: "Saved as a branch from an old base. Never made current. See the open items for where it stands.", warn: true }
        : { text: "Superseded" },
      ...(v.issueType ? [{ text: v.issueType }] : []),
      ...(v.changeType ? [{ text: v.changeType }] : []),
      ...(v.revertedFromVersionId ? [{ text: "Revert" }] : []),
      ...(v.provenance === "unverified" ? [{ text: "Unverified provenance", tip: "Published with no recorded checkout/download trail and no verified base declaration. Document Control reviews these, like QA receiving inspection.", bad: true }] : []),
      ...(v.provenance === "session" ? [{ text: "From a checkout", tip: "Published from a checkout: full record of where it came from." }] : []),
      ...(v.provenance === "external" ? [{ text: `External${v.createdByName ? `: ${v.createdByName}` : ""}`, tip: "Submitted by an outside company through a project intake link. External work enters through review (or a trusted link's own documents). The submitting company is on the record." }] : []),
      ...(v.sourceFileKey ? [{ text: "CAD source", tip: "The native CAD source file is stored with this revision." }] : []),
    ];
    const signoffs = [
      v.drawnByName ? `Drawn ${v.drawnByName}` : null,
      v.checkedByName ? `Checked ${v.checkedByName}` : null,
      v.approvedByName ? `Approved ${v.approvedByName}` : null,
    ].filter(Boolean).join(" · ");
    return {
      id: v.id ?? `rev-${n}`,
      at: atOf(v.createdAt),
      kind: `Rev ${label}`,
      tone: v.provenance === "unverified" ? "bad" : v.isBranch ? "warn" : isCurrent ? "good" : "muted",
      title: (
        <span className="text-[var(--color-text-muted)]">
          {words.map((w, i) => (
            <React.Fragment key={i}>
              {i > 0 && " · "}
              <span title={w.tip} className={w.bad ? "text-[var(--state-overdue-text)]" : w.warn ? "text-[var(--state-held-text)]" : i === 0 && isCurrent ? "text-[var(--color-text)]" : undefined}>{w.text}</span>
            </React.Fragment>
          ))}
        </span>
      ),
      detail: (
        <div className="mt-0.5 grid gap-1">
          {v.changeLog && <span className="text-body text-[var(--color-text)] whitespace-pre-wrap">{v.changeLog}</span>}
          {signoffs && <span>{signoffs}</span>}
          {(v.mocReference || v.sourceFileName) && (
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {v.mocReference && <span>MOC <b className="ui-id">{v.mocReference}</b></span>}
              {v.sourceFileName && <span className="inline-flex items-center gap-1 min-w-0"><FileText aria-hidden className="w-3 h-3 shrink-0" /> <span className="truncate">{v.sourceFileName}</span></span>}
            </span>
          )}
          {(typeof v.size === "number" || v.fileHash) && (
            <span className="flex items-center gap-3 tabular-nums text-[var(--color-text-faint)]">
              {typeof v.size === "number" && <span>{(v.size / 1024).toFixed(0)} KB</span>}
              {v.fileHash && <span title={`SHA-256: ${v.fileHash}`}>SHA-256 {v.fileHash.slice(0, 10)}…</span>}
            </span>
          )}
          <span className="flex items-center gap-1 -ml-2">
            <button
              type="button"
              onClick={() => onOpenVersion(v)}
              title="Open this revision in the viewer" aria-label={`Open Rev ${v.revisionLabel || ""}`}
              className="ui-hit inline-flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-2 rounded-md text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            >
              <Eye className="w-3.5 h-3.5" /> Open
            </button>
            {more.length > 0 && (
              <MoreMenu items={more} iconOnly label={`More for Rev ${label}`}
                triggerClass="ui-hit inline-flex items-center justify-center w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]" />
            )}
          </span>
        </div>
      ),
      who: v.createdByName ? { uid: v.createdBy || null, name: v.createdByName } : null,
    };
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-display text-reading font-semibold text-[var(--color-heading)] flex items-center gap-2">
          Version history
          <span className="ui-count font-sans" title={`${versions.length} revision${versions.length === 1 ? "" : "s"}`}>{versions.length}</span>
          <HelpTooltip>
            Every revision of this document, newest first, with its file, SHA-256 hash
            and the engineering signoffs (Drawn / Checked / Approved) captured at release.
            Its menu holds the rest:
            <b className="block mt-1">Compare</b> diffs an older rev against the current one.
            <b className="block mt-1">Correct the label</b> fixes a mislabeled rev after the fact (e.g. uploaded as Rev 0 but the stamp reads 38). The old and new label are audited.
            <b className="block mt-1">Revert</b> creates a new revision that copies the older file forward. No history is rewritten.
            <b className="block mt-1">Backfill older</b> adds a historical revision without changing the current, for when you uploaded the current rev first and need to populate older ones.
          </HelpTooltip>
        </div>
        <div className="flex items-center gap-2">
          {canRevert && currentUserId && doc.orgId && (
            <button
              onClick={() => setBackfillOpen(true)}
              className="inline-flex items-center gap-1 h-8 pointer-coarse:h-11 px-2.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              title="Add a historical revision (does not change current)"
            >
              <ArrowUpFromLine className="w-3 h-3" /> Backfill older
            </button>
          )}
        </div>
      </div>

      <Timeline items={items} />

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
            <div className="text-body font-medium text-[var(--color-text)] flex items-center gap-2">
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
                className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-body font-display tabular-nums"
              />
            </label>
            <label className="block mt-2 text-body font-medium text-[var(--color-text-muted)]">
              Why (recommended)
              <input
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                placeholder="e.g. mislabeled at upload, title block reads 38"
                className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-body"
              />
            </label>
            {labelError && (
              <div className="mt-2"><FieldError>{labelError}</FieldError></div>
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
