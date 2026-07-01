"use client";

import React, { useEffect, useState } from "react";
import { Search, Pencil, History, ArrowRight, Lock, Trash2, Maximize2, Activity, Shield, Layers, LogIn, LogOut, FileText, User, Calendar, ArrowUpFromLine, Archive, ArchiveRestore, Send } from "lucide-react";
import NextLink from "next/link";
import SecureDocViewer from "@/components/viewers/SecureDocViewer";
import CheckoutStatusCell from "@/components/documents/CheckoutStatusCell";
import VersionHistoryPanel from "@/components/documents/VersionHistoryPanel";
import HoldStrip from "@/components/documents/HoldStrip";
import WatchButton from "@/components/ui/WatchButton";
import QuickNoteComposer from "@/components/notes/QuickNoteComposer";
import PresenceIndicator from "@/components/ui/PresenceIndicator";
import ShareLinkModal from "@/components/documents/ShareLinkModal";
import { Link as LinkIcon } from "lucide-react";
import ModifyDocumentRouter from "@/components/documents/lifecycle/ModifyDocumentRouter";
import HelpTooltip from "@/components/ui/HelpTooltip";
import EquipmentTagsStrip from "@/components/assets/EquipmentTagsStrip";
import ReviewSection from "@/components/documents/ReviewSection";
import AckSection from "@/components/documents/AckSection";
import ReviewGateSection from "@/components/documents/ReviewGateSection";
import { effectiveOwnerForDocument, requestDeletion } from "@/lib/ownership";
import { appAlert, appPrompt } from "@/components/providers/DialogProvider";
import { supabase } from "@/lib/supabase";
import { openEvidencePack } from "@/lib/evidencePack";
import { isDocumentCheckedOut } from "@/lib/documentGuards";
import type { DocumentRecord, DocumentVersion, LibraryCustomColumn } from "@/types/schema";
import { AuditEntry } from "@/lib/audit";

interface InspectorPanelProps {
  selectedDoc: DocumentRecord | null;
  selectedVersion: DocumentVersion | null;
  activeRole: string;
  uid: string | null;
  userEmail: string | null;
  onClose: () => void;
  onMetadata: () => void;
  onHistory: () => void;
  onMove: () => void;
  onPermissions: () => void;
  onDelete: () => void;
  onCheckout: (doc: DocumentRecord) => void;
  onForceUnlock?: (doc: DocumentRecord) => void;
  onFullScreen: () => void;
  onToggleStage?: (doc: DocumentRecord) => void;
  isStaged?: boolean;
  folderPath?: string;
  /** Open the Rev-Up modal. Inspector hides the button when not provided. */
  onRevUp?: () => void;
  /** Per-library publish authority (Admin/DocCtrl, or a role/user granted "publish"
   *  on THIS library). Gates the Publish-New-Revision button and Revert — these are
   *  no longer broad-controller-only. Defaults to false. */
  canPublish?: boolean;
  /** Open the Supersede modal — admin/DocCtrl only. */
  onSupersede?: () => void;
  /** Open the Archive (or Unarchive) confirm modal — admin/DocCtrl only. */
  onArchive?: () => void;
  /** Open the Revert confirm modal for a specific previous version. */
  onRevertVersion?: (v: DocumentVersion) => void;
  /** Force a re-fetch of the version history list (bump after rev-up commits). */
  versionHistoryRefreshKey?: number;
  /** Open a specific historical version in the full-screen viewer. */
  onOpenVersion?: (v: DocumentVersion) => void;
  // Asset-tag chip integration — when provided, the inspector renders a
  // tag-photo strip directly so users don't have to open Metadata Editor.
  orgId?: string;
  customColumns?: LibraryCustomColumn[];
}

function formatBytes(bytes?: number): string {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTs(value: unknown): string {
  if (!value) return "—";
  try {
    const d = typeof value === "string" ? new Date(value) : value instanceof Date ? value : null;
    if (!d) return "—";
    return d.toLocaleString();
  } catch {
    return "—";
  }
}

export default function InspectorPanel({
  selectedDoc,
  selectedVersion,
  activeRole,
  uid,
  userEmail,
  onMetadata,
  onHistory,
  onMove,
  onPermissions,
  onDelete,
  onCheckout,
  onForceUnlock,
  onFullScreen,
  onToggleStage,
  isStaged,
  folderPath,
  onRevUp,
  canPublish = false,
  onSupersede,
  onArchive,
  onRevertVersion,
  versionHistoryRefreshKey,
  onOpenVersion,
  orgId,
  customColumns,
}: InspectorPanelProps) {
  const canManageAssets = activeRole === 'Admin' || activeRole === 'Manager' || activeRole === 'Supervisor'
    || (activeRole?.includes('Engineer') ?? false) || activeRole === 'Drafter' || activeRole === 'DocCtrl';
  const [recentAudits, setRecentAudits] = useState<AuditEntry[]>([]);
  const [modifyOpen, setModifyOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const isController = activeRole === 'Admin' || activeRole === 'DocCtrl';

  // Ownership grant (Phase 2): the document's effective owner may manage it —
  // publish/supersede/archive/edit — even without a controller role or library
  // publish authority. Hard-delete and force-unlock stay controller-only.
  const [isOwner, setIsOwner] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!selectedDoc?.id || !uid) { if (alive) setIsOwner(false); return; }
      try {
        const o = await effectiveOwnerForDocument({ ownerUserId: selectedDoc.ownerUserId, ownerName: selectedDoc.ownerName, collectionId: selectedDoc.collectionId, libraryId: selectedDoc.libraryId });
        if (alive) setIsOwner(!!o.userId && o.userId === uid);
      } catch { if (alive) setIsOwner(false); }
    })();
    return () => { alive = false; };
  }, [selectedDoc?.id, selectedDoc?.ownerUserId, selectedDoc?.ownerName, selectedDoc?.collectionId, selectedDoc?.libraryId, uid]);
  const canManage = isController || isOwner;
  const canPublishEff = canPublish || isOwner;
  // Authoritative lock only — a stale collaborator list with no lock holder is
  // NOT a checkout (see isDocumentCheckedOut).
  const isCheckedOut = isDocumentCheckedOut(selectedDoc);
  const checkedOutByMe = selectedDoc?.checkedOutBy === uid;

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!selectedDoc?.id || !selectedDoc.orgId) {
        if (alive) setRecentAudits([]);
        return;
      }
      const { data } = await supabase
        .from("audit_logs")
        .select("*")
        .eq("org_id", selectedDoc.orgId)
        .eq("resource_id", selectedDoc.id)
        .order("timestamp", { ascending: false })
        .limit(3);
      if (alive && data) {
        setRecentAudits(data.map((r) => ({
          action: r.action,
          resourceId: r.resource_id,
          resourceType: r.resource_type,
          orgId: r.org_id,
          userId: r.user_id,
          userEmail: r.user_email,
          userRole: r.user_role,
          details: r.details,
          timestamp: r.timestamp,
        } as AuditEntry)));
      }
    })();
    return () => { alive = false; };
  }, [selectedDoc?.id, selectedDoc?.orgId]);

  if (!selectedDoc) {
    return (
      <div className="text-center py-12 text-[var(--color-text-faint)] bg-[var(--color-surface-2)] rounded-xl border border-[var(--color-border)] border-dashed">
        <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p className="text-xs">Select a document to view details.</p>
      </div>
    );
  }

  const title = selectedDoc.title || selectedDoc.name || "Untitled";
  const meta = (selectedDoc.metadata ?? {}) as Record<string, unknown>;
  const sizeBytes = selectedVersion?.size ?? (typeof meta.size_bytes === "string" ? Number(meta.size_bytes) : undefined);
  const fileType = selectedVersion?.fileType || (typeof meta.mime_type === "string" ? meta.mime_type : undefined) || "—";
  const ext = (typeof meta.extension === "string" ? meta.extension : "") || (selectedDoc.name?.split(".").pop() ?? "");

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300">

      {/* HEADER ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-[var(--color-border)] bg-gradient-to-br from-slate-50 to-white p-4">
        <div className="text-lg font-black text-[var(--color-text)] leading-tight break-words">{title}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {selectedDoc.documentNumber && (
            <span className="font-mono font-bold text-[var(--color-text)]">{selectedDoc.documentNumber}</span>
          )}
          <span className="text-slate-300">•</span>
          <span className="text-[var(--color-text-muted)] inline-flex items-center gap-0.5">
            Rev <span className="font-bold text-[var(--color-text)]">{selectedDoc.rev || "—"}</span>
            <HelpTooltip>
              The current revision label — what authorized copies of this document say at the bottom right.
              Every Rev-Up creates a new revision and immutable version row with file hash + signoffs.
            </HelpTooltip>
          </span>
          <span className="text-slate-300">•</span>
          <span className="inline-flex items-center text-[10px] font-bold border px-1.5 py-0.5 rounded-md bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)] gap-0.5">
            {selectedDoc.status || "—"}
            <HelpTooltip>
              <b>Draft</b> — not yet released.
              <b className="block mt-1">Issued</b> — current authoritative revision.
              <b className="block mt-1">Superseded</b> — replaced by a newer doc (split / merge / supersede). Audit history is preserved.
              <b className="block mt-1">Archived</b> — retired with no replacement.
              <b className="block mt-1">Void</b> — explicitly nullified.
            </HelpTooltip>
          </span>
        </div>
        {folderPath && (
          <div className="mt-2 text-[11px] text-[var(--color-text-muted)] truncate" title={folderPath}>{folderPath}</div>
        )}
        {/* Watch / follow + share + live presence */}
        {selectedDoc.id && selectedDoc.orgId && uid && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <WatchButton
              orgId={selectedDoc.orgId}
              userId={uid}
              resourceType="document"
              resourceId={selectedDoc.id}
            />
            <button
              onClick={() => setShareOpen(true)}
              title="Generate a public share link for someone outside the org"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
            >
              <LinkIcon className="w-3 h-3" /> Share
            </button>
            <NextLink
              href={`/transmittals?compose=1&doc=${selectedDoc.id}`}
              title="Issue this document on a transmittal — a tracked cover sheet to a recipient"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
            >
              <Send className="w-3 h-3" /> Transmit
            </NextLink>
            <PresenceIndicator
              resourceType="document"
              resourceId={selectedDoc.id}
              userId={uid}
              userName={userEmail?.split("@")[0]}
              role={activeRole || undefined}
            />
          </div>
        )}
      </div>

      {/* HOLDS (Phase 5) ─────────────────────────────────────────────── */}
      {selectedDoc.id && selectedDoc.orgId && uid && (
        <HoldStrip
          documentId={selectedDoc.id}
          orgId={selectedDoc.orgId}
          userId={uid}
          userName={userEmail || undefined}
          userEmail={userEmail || undefined}
          userRole={activeRole || undefined}
          canEdit={canManageAssets || isOwner}
        />
      )}

      {/* QUICK NOTES — drop ad-hoc context anywhere */}
      {selectedDoc.id && selectedDoc.orgId && uid && (
        <QuickNoteComposer
          orgId={selectedDoc.orgId}
          userId={uid}
          userEmail={userEmail || undefined}
          userName={userEmail?.split("@")[0]}
          scope={{ documentId: selectedDoc.id }}
        />
      )}

      {/* PREVIEW ────────────────────────────────────────────────────── */}
      {selectedVersion?.fileUrl ? (
        <div className="relative group rounded-xl border border-[var(--color-border)] overflow-hidden h-96 bg-[var(--color-surface-2)]">
          <SecureDocViewer
            url={selectedVersion.fileUrl}
            title={title}
            docNumber={selectedDoc.documentNumber || selectedDoc.id || ""}
            rev={selectedDoc.rev || "—"}
            zoomLevel={75}
            watermarkText="PREVIEW"
          />
          {/* Click-catcher overlay — iframe absorbs pointer events otherwise */}
          <button
            type="button"
            onClick={onFullScreen}
            className="absolute inset-0 z-10 bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center cursor-pointer"
            title="Open in full screen"
          >
            <span className="opacity-0 group-hover:opacity-100 transition-all flex items-center gap-1.5 px-3 py-1.5 bg-white/95 text-[var(--color-text)] rounded-lg text-xs font-bold shadow-lg">
              <Maximize2 className="w-3.5 h-3.5" /> Open Full View
            </span>
          </button>
        </div>
      ) : (
        <div className="h-40 rounded-xl border border-[var(--color-border)] border-dashed bg-[var(--color-surface-2)] flex items-center justify-center text-xs text-[var(--color-text-faint)]">
          No preview available
        </div>
      )}

      {/* PRIMARY ACTIONS ────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={onFullScreen}
          disabled={!selectedVersion?.fileUrl}
          className="flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
        >
          <Maximize2 className="w-3.5 h-3.5" /> Open
        </button>
        {onToggleStage && (
          <button
            onClick={() => onToggleStage(selectedDoc)}
            className={`flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-xl text-xs font-bold transition-all shadow-sm border ${
              isStaged
                ? "bg-orange-500 text-white border-orange-500 hover:bg-orange-600"
                : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:bg-orange-50 hover:border-orange-300 hover:text-orange-700"
            }`}
            title={isStaged ? "Remove from staging" : "Add to staging"}
          >
            <Layers className="w-3.5 h-3.5" /> {isStaged ? "Staged" : "Stage"}
          </button>
        )}
        <button
          onClick={() => onCheckout(selectedDoc)}
          className={`flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-xl text-xs font-bold transition-all shadow-sm border ${
            checkedOutByMe
              ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
              : isCheckedOut
              ? "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"
              : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
          }`}
          title={checkedOutByMe ? "You have it checked out" : isCheckedOut ? "Currently checked out" : "Check out"}
        >
          {checkedOutByMe ? <LogOut className="w-3.5 h-3.5" /> : <LogIn className="w-3.5 h-3.5" />}
          {checkedOutByMe ? "Check in" : "Checkout"}
        </button>
      </div>

      {/* EQUIPMENT TAGS ─────────────────────────────────────────────
          Quick-glance asset chips. Click any to open the photo popover
          without going through Metadata. Auto-hides if the doc has
          no tag-typed metadata fields. */}
      {selectedDoc?.metadata && orgId && (
        <EquipmentTagsStrip
          metadata={selectedDoc.metadata as Record<string, unknown>}
          customColumns={customColumns}
          orgId={orgId}
          userId={uid || undefined}
          canManage={canManageAssets || isOwner}
          variant="stacked"
        />
      )}

      {/* REVIEW CYCLE ──────────────────────────────────────────────── */}
      {selectedDoc?.id && orgId && (
        <ReviewSection
          doc={selectedDoc}
          orgId={orgId}
          canManage={canPublishEff}
          uid={uid}
          userName={userEmail}
        />
      )}

      {/* READ & UNDERSTOOD ─────────────────────────────────────────── */}
      {selectedDoc?.id && orgId && (
        <AckSection
          doc={selectedDoc}
          orgId={orgId}
          canManage={canPublishEff}
        />
      )}

      {/* PRE-PUBLISH REVIEW GATE ────────────────────────────────────── */}
      {selectedDoc?.id && orgId && (
        <ReviewGateSection
          doc={selectedDoc}
          orgId={orgId}
          canManage={canPublishEff}
        />
      )}

      {/* SECONDARY ACTIONS ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        <button onClick={onMetadata} className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] transition-all">
          <Pencil className="w-3.5 h-3.5" /> Metadata
        </button>
        <button onClick={onHistory} className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] transition-all">
          <History className="w-3.5 h-3.5" /> History
        </button>
      </div>

      {/* PUBLISH — rev-up. Gated on per-library publish authority (Admin/DocCtrl,
          or a role/user granted "publish" on this library), NOT broad controller. */}
      {canPublishEff && onRevUp && (
        <button
          onClick={onRevUp}
          disabled={selectedDoc.status === "Archived"}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-xs font-black shadow transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ArrowUpFromLine className="w-3.5 h-3.5" /> Publish New Revision
        </button>
      )}

      {/* ADMIN ACTIONS ──────────────────────────────────────────────── */}
      {canManage && (
        <>
          {/* Unified lifecycle entry-point (Rev-Up, Split, Merge, Renumber, etc.) */}
          {selectedDoc.id && selectedDoc.orgId && selectedDoc.libraryId && uid && (
            <button
              onClick={() => setModifyOpen(true)}
              disabled={selectedDoc.status === "Archived"}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-black shadow transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Pencil className="w-3.5 h-3.5" /> Modify Document…
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button onClick={onMove} className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] transition-all">
              <ArrowRight className="w-3.5 h-3.5" /> Move
            </button>
            <button onClick={onPermissions} className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)] transition-all">
              <Lock className="w-3.5 h-3.5" /> Permissions
            </button>
          </div>
          {/* Lifecycle actions */}
          <div className="grid grid-cols-2 gap-2">
            {onSupersede && (
              <button
                onClick={onSupersede}
                disabled={selectedDoc.status === "Archived" || selectedDoc.status === "Superseded"}
                className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-amber-200 bg-amber-50 text-xs font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                <Layers className="w-3.5 h-3.5" /> Supersede
              </button>
            )}
            {onArchive && (
              <button
                onClick={onArchive}
                className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-xs font-bold transition-all ${
                  selectedDoc.status === "Archived"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                    : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                }`}
              >
                {selectedDoc.status === "Archived"
                  ? <><ArchiveRestore className="w-3.5 h-3.5" /> Restore</>
                  : <><Archive className="w-3.5 h-3.5" /> Archive</>}
              </button>
            )}
          </div>
          {/* Compliance evidence pack — chain-of-custody, one click. */}
          {selectedDoc.id && (
            <button
              onClick={async () => {
                try { await openEvidencePack(selectedDoc.id!, selectedDoc.orgId); }
                catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
              }}
              title="Assemble the full chain-of-custody — revision lineage, holds, and audit trail — into a print-to-PDF report"
              className="mt-2 w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-indigo-200 bg-indigo-50 text-xs font-bold text-indigo-800 hover:bg-indigo-100 transition-all"
            >
              <Shield className="w-3.5 h-3.5" /> Evidence pack
            </button>
          )}
        </>
      )}

      {/* CHECKOUT STATUS ────────────────────────────────────────────── */}
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
        <div className="text-xs font-bold text-[var(--color-text-faint)] uppercase tracking-wider mb-3">Checkout Status</div>
        <CheckoutStatusCell
          docRecord={selectedDoc}
          currentUserId={uid ?? undefined}
          currentUserEmail={userEmail ?? undefined}
          userRole={activeRole}
          onCheckout={onCheckout}
        />
        {isController && isCheckedOut && onForceUnlock && (
          <button
            onClick={() => onForceUnlock(selectedDoc)}
            className="w-full mt-3 py-2 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded-lg text-xs font-bold flex items-center justify-center transition-colors"
          >
            <Shield className="w-3.5 h-3.5 mr-1.5" />
            Force Release Lock
          </button>
        )}
      </div>

      {/* FILE DETAILS ───────────────────────────────────────────────── */}
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4 space-y-2.5">
        <div className="text-xs font-bold text-[var(--color-text-faint)] uppercase tracking-wider mb-2 flex items-center">
          <FileText className="w-3 h-3 mr-1.5" /> File Details
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
          <div className="text-[var(--color-text-muted)]">Type</div>
          <div className="text-[var(--color-text)] font-mono truncate" title={fileType}>{ext ? `.${ext}` : fileType}</div>

          <div className="text-[var(--color-text-muted)]">Size</div>
          <div className="text-[var(--color-text)] font-mono">{formatBytes(sizeBytes)}</div>

          <div className="text-[var(--color-text-muted)] flex items-center gap-1"><Calendar className="w-3 h-3" /> Created</div>
          <div className="text-[var(--color-text)]">{formatTs(selectedDoc.createdAt)}</div>

          <div className="text-[var(--color-text-muted)] flex items-center gap-1"><Calendar className="w-3 h-3" /> Modified</div>
          <div className="text-[var(--color-text)]">{formatTs(selectedDoc.updatedAt)}</div>

          {selectedVersion?.createdByName && (
            <>
              <div className="text-[var(--color-text-muted)] flex items-center gap-1"><User className="w-3 h-3" /> By</div>
              <div className="text-[var(--color-text)] truncate">{selectedVersion.createdByName}</div>
            </>
          )}
        </div>
      </div>

      {/* VERSION HISTORY ────────────────────────────────────────────── */}
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
        <VersionHistoryPanel
          doc={selectedDoc}
          currentUserId={uid ?? undefined}
          currentUserEmail={userEmail ?? undefined}
          refreshKey={versionHistoryRefreshKey}
          onOpenVersion={(v) => onOpenVersion?.(v)}
          canRevert={canPublishEff}
          onRevertVersion={onRevertVersion}
        />
      </div>

      {/* RECENT ACTIVITY ────────────────────────────────────────────── */}
      <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4">
        <div className="text-xs font-bold text-[var(--color-text-faint)] uppercase tracking-wider mb-3 flex items-center">
          <Activity className="w-3 h-3 mr-1.5" /> Recent Activity
        </div>
        {recentAudits.length === 0 ? (
          <div className="text-xs text-[var(--color-text-faint)] italic">No recent activity.</div>
        ) : (
          <div className="space-y-3">
            {recentAudits.map((log, i) => (
              <div key={i} className="flex flex-col gap-0.5 border-l-2 border-[var(--color-border)] pl-3">
                <span className="text-[10px] font-bold text-[var(--color-text)] uppercase">{log.action.replace(/_/g, ' ')}</span>
                <span className="text-[10px] text-[var(--color-text-muted)]">by {log.userEmail?.split('@')[0]}</span>
                <span className="text-[9px] text-[var(--color-text-faint)] font-mono">{formatTs(log.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* DESTRUCTIVE ────────────────────────────────────────────────── */}
      {isController && (
        <button
          onClick={onDelete}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-red-200 bg-red-50 text-xs font-bold text-red-700 hover:bg-red-100 transition-all"
        >
          <Trash2 className="w-3.5 h-3.5" /> Delete Document
        </button>
      )}
      {/* Owners can't hard-delete (that would break the audit trail) — they
          request it, and Admin/DocCtrl approve by deleting. */}
      {!isController && isOwner && selectedDoc.id && selectedDoc.orgId && (
        <button
          onClick={async () => {
            const reason = await appPrompt({ title: "Request deletion", message: "Admin / Doc Control will review. Why should this document be deleted?", placeholder: "Reason" });
            if (!reason?.trim() || !uid) return;
            try {
              await requestDeletion({
                orgId: selectedDoc.orgId!, documentId: selectedDoc.id!,
                docLabel: selectedDoc.documentNumber || selectedDoc.title || selectedDoc.name || "Document",
                libraryId: selectedDoc.libraryId, requesterId: uid, requesterName: userEmail, reason: reason.trim(),
              });
              await appAlert({ message: "Deletion request sent to Admin / Doc Control." });
            } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
          }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-red-200 bg-red-50/60 text-xs font-bold text-red-700 hover:bg-red-100 transition-all"
        >
          <Trash2 className="w-3.5 h-3.5" /> Request deletion
        </button>
      )}

      {modifyOpen && selectedDoc.id && selectedDoc.orgId && selectedDoc.libraryId && uid && (
        <ModifyDocumentRouter
          isOpen
          onClose={() => setModifyOpen(false)}
          doc={selectedDoc}
          libraryId={selectedDoc.libraryId}
          orgId={selectedDoc.orgId}
          actorUserId={uid}
          actorUserName={userEmail ?? undefined}
          actorEmail={userEmail ?? undefined}
          actorRole={activeRole ?? undefined}
          onSuccess={() => { setModifyOpen(false); /* parent refreshes via realtime channel */ }}
        />
      )}

      {shareOpen && selectedDoc.id && selectedDoc.orgId && uid && (
        <ShareLinkModal
          isOpen={shareOpen}
          onClose={() => setShareOpen(false)}
          orgId={selectedDoc.orgId}
          documentId={selectedDoc.id}
          documentLabel={selectedDoc.documentNumber || selectedDoc.title || selectedDoc.name}
          createdBy={uid}
          createdByName={userEmail?.split("@")[0]}
        />
      )}
    </div>
  );
}
