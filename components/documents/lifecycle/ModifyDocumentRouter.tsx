"use client";

// ModifyDocumentRouter — single entry-point modal for every
// lifecycle operation on a document. Replaces the old "scattered
// modals across the inspector" UX with one choice-based router.
//
// User picks one of six actions; the router opens the appropriate
// focused workflow underneath. Existing per-action modals still
// work as standalone if other code paths use them — this is the
// curated entry point.

import React, { useState } from "react";
import {
  X, ArrowUpFromLine, Split, Merge, Hash, Archive as ArchiveIcon,
  ChevronRight, History as HistoryIcon, Repeat2, AlertOctagon,
} from "lucide-react";
import type { DocumentRecord } from "@/types/schema";
import RevUpModal from "@/components/documents/RevUpModal";
import SupersedeModal from "@/components/documents/SupersedeModal";
import BackfillVersionModal from "@/components/documents/BackfillVersionModal";
import ArchiveConfirmModal from "@/components/documents/ArchiveConfirmModal";
import SplitWizard from "@/components/documents/lifecycle/SplitWizard";
import MergeWizard from "@/components/documents/lifecycle/MergeWizard";
import RenumberModal from "@/components/documents/lifecycle/RenumberModal";
import SetRevUpModal from "@/components/documents/lifecycle/SetRevUpModal";
import FirstRunHint from "@/components/ui/FirstRunHint";

interface ModifyDocumentRouterProps {
  isOpen: boolean;
  onClose: () => void;
  doc: DocumentRecord;
  libraryId: string;
  folderPath?: string[];
  orgId: string;
  actorUserId: string;
  actorUserName?: string;
  actorEmail?: string;
  actorRole?: string;
  onSuccess?: () => void;
}

type Choice =
  | "revup"
  | "split"
  | "merge"
  | "renumber"
  | "backfill"
  | "archive"
  | "supersede"
  | "set_rev_up";

export default function ModifyDocumentRouter(props: ModifyDocumentRouterProps) {
  const { isOpen, onClose, doc } = props;
  const [choice, setChoice] = useState<Choice | null>(null);

  if (!isOpen) return null;

  // When a sub-workflow is picked, render it directly. Each
  // sub-workflow's onClose either bounces back to the router (so
  // user can pick again) or closes the whole thing — we close the
  // whole thing on success, bounce back on cancel.
  const closeAll = () => { setChoice(null); onClose(); };
  const success = () => { props.onSuccess?.(); closeAll(); };

  if (choice === "revup") {
    return (
      <RevUpModal
        isOpen
        onClose={() => setChoice(null)}
        doc={doc}
        libraryId={props.libraryId}
        folderPath={props.folderPath}
        orgId={props.orgId}
        actorUserId={props.actorUserId}
        actorEmail={props.actorEmail}
        actorRole={props.actorRole}
        onSuccess={() => success()}
      />
    );
  }
  if (choice === "backfill") {
    return (
      <BackfillVersionModal
        isOpen
        onClose={() => setChoice(null)}
        doc={doc}
        libraryId={props.libraryId}
        folderPath={props.folderPath}
        orgId={props.orgId}
        actorUserId={props.actorUserId}
        actorEmail={props.actorEmail}
        actorRole={props.actorRole}
        onSuccess={() => success()}
      />
    );
  }
  if (choice === "supersede") {
    return (
      <SupersedeModal
        isOpen
        onClose={() => setChoice(null)}
        doc={doc}
        libraryId={props.libraryId}
        orgId={props.orgId}
        actorUserId={props.actorUserId}
        actorEmail={props.actorEmail}
        actorRole={props.actorRole}
        onSuccess={() => success()}
      />
    );
  }
  if (choice === "archive") {
    return (
      <ArchiveConfirmModal
        isOpen
        onClose={() => setChoice(null)}
        doc={doc}
        mode="archive"
        orgId={props.orgId}
        actorUserId={props.actorUserId}
        actorEmail={props.actorEmail}
        actorRole={props.actorRole}
        onSuccess={() => success()}
      />
    );
  }
  if (choice === "split") {
    return (
      <SplitWizard
        onCancel={() => setChoice(null)}
        onSuccess={() => success()}
        doc={doc}
        libraryId={props.libraryId}
        folderPath={props.folderPath}
        orgId={props.orgId}
        actorUserId={props.actorUserId}
        actorUserName={props.actorUserName}
        actorEmail={props.actorEmail}
        actorRole={props.actorRole}
      />
    );
  }
  if (choice === "merge") {
    return (
      <MergeWizard
        onCancel={() => setChoice(null)}
        onSuccess={() => success()}
        sourceDoc={doc}
        libraryId={props.libraryId}
        folderPath={props.folderPath}
        orgId={props.orgId}
        actorUserId={props.actorUserId}
        actorUserName={props.actorUserName}
        actorEmail={props.actorEmail}
        actorRole={props.actorRole}
      />
    );
  }
  if (choice === "renumber") {
    return (
      <RenumberModal
        onCancel={() => setChoice(null)}
        onSuccess={() => success()}
        doc={doc}
        orgId={props.orgId}
        actorUserId={props.actorUserId}
        actorEmail={props.actorEmail}
        actorRole={props.actorRole}
      />
    );
  }
  if (choice === "set_rev_up") {
    return (
      <SetRevUpModal
        onCancel={() => setChoice(null)}
        onSuccess={() => success()}
        setId={doc.setId!}
        libraryId={props.libraryId}
        folderPath={props.folderPath}
        orgId={props.orgId}
        actorUserId={props.actorUserId}
        actorEmail={props.actorEmail}
        actorRole={props.actorRole}
      />
    );
  }

  // Router landing page
  const hasSet = !!doc.setId;
  return (
    <div className="fixed inset-0 z-[180] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div>
            <h2 className="font-black text-slate-900">Modify Document</h2>
            <div className="text-[11px] font-mono text-slate-500 mt-0.5">
              {doc.documentNumber || doc.title || doc.id} · Rev {doc.rev || "—"} · {doc.status || "—"}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-200 text-slate-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-2">
          <div className="px-2 pb-2">
            <FirstRunHint storageKey="lifecycle.router.intro">
              Pick the action that best matches what you&apos;re doing.
              <b className="block mt-1">Every transformative action (Split, Merge, Renumber) is reversible</b>
              from the document&apos;s Timeline tab — so it&apos;s safe to try things.
            </FirstRunHint>
          </div>
          <RouterChoice
            icon={ArrowUpFromLine} color="emerald"
            label="Update this sheet to a new revision"
            sub="Rev-Up — keep the same document, push a new PDF forward."
            onClick={() => setChoice("revup")}
          />
          <RouterChoice
            icon={Split} color="amber"
            label="Split this sheet into multiple sheets"
            sub="Source becomes Superseded. New docs inherit scope, holds, and project membership."
            onClick={() => setChoice("split")}
          />
          <RouterChoice
            icon={Merge} color="amber"
            label="Combine with other sheets into one"
            sub="Multiple sources → one target. Asset tags union; sources go Superseded."
            onClick={() => setChoice("merge")}
          />
          <RouterChoice
            icon={Hash} color="slate"
            label="Renumber or rename this sheet"
            sub="Change document_number. Existing revisions and history are preserved."
            onClick={() => setChoice("renumber")}
          />
          <RouterChoice
            icon={HistoryIcon} color="slate"
            label="Backfill an older revision"
            sub="Add a historical revision row. Current revision stays current."
            onClick={() => setChoice("backfill")}
          />
          <RouterChoice
            icon={ArchiveIcon} color="slate"
            label="Retire this sheet (no replacement)"
            sub="Mark as Archived with a reason. Audit-trail preserved."
            onClick={() => setChoice("archive")}
          />
          <RouterChoice
            icon={AlertOctagon} color="amber"
            label="Retire and point to existing replacement(s)"
            sub="Supersede — link to other documents already in the library."
            onClick={() => setChoice("supersede")}
          />

          {hasSet && (
            <>
              <div className="mt-2 mb-1 px-3 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                For all sheets in this set
              </div>
              <RouterChoice
                icon={Repeat2} color="emerald"
                label="Bump every sheet to a new revision"
                sub="Batch rev-up across the set. One MOC, one narrative, one date."
                onClick={() => setChoice("set_rev_up")}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RouterChoice({
  icon: Icon, color, label, sub, onClick,
}: {
  icon: React.ElementType;
  color: "emerald" | "amber" | "slate";
  label: string;
  sub: string;
  onClick: () => void;
}) {
  const colorClass =
    color === "emerald" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
    color === "amber"   ? "bg-amber-50   text-amber-700   border-amber-200" :
                          "bg-slate-100  text-slate-600   border-slate-200";
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-100/60 text-left"
    >
      <div className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${colorClass}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-slate-900">{label}</div>
        <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>
      </div>
      <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
    </button>
  );
}
