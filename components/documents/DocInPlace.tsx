"use client";

// DocInPlace - a document opened right where you are: from the map, from a
// search result, from anywhere that is not its own folder. The full-size
// viewer is laid over the page; closing it leaves the page exactly as it
// was (the search, the folder, the map all still there). Nothing navigates.

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { loadDocForViewing } from "@/lib/docRecord";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";

const FullScreenViewer = dynamic(() => import("@/components/viewers/FullScreenViewer"), { ssr: false });

type Got = { id: string; doc: DocumentRecord | null; version: DocumentVersion | null };

export default function DocInPlace({ docId, onClose }: { docId: string; onClose: () => void }) {
  const { uid, userEmail, activeRole, activeOrgId } = useRole();
  const [got, setGot] = useState<Got | null>(null);

  useEffect(() => {
    let alive = true;
    void loadDocForViewing(docId)
      .then((r) => { if (alive) setGot({ id: docId, doc: r?.doc ?? null, version: r?.version ?? null }); })
      .catch(() => { if (alive) setGot({ id: docId, doc: null, version: null }); });
    return () => { alive = false; };
  }, [docId]);

  // Esc closes the small waiting box (the viewer handles its own keys).
  const cur = got && got.id === docId ? got : null;
  const viewing = !!cur?.doc && !!cur.version;
  useEffect(() => {
    if (viewing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing, onClose]);

  if (typeof document === "undefined") return null;

  // Over the whole page, whatever box it was opened from (a widget, a panel).
  return createPortal(
    cur?.doc && cur.version ? (
      <div data-doc-in-place={docId}>
        <FullScreenViewer isOpen onClose={onClose} url={cur.version.fileUrl}
          title={cur.doc.title || "Document"} docNumber={cur.doc.documentNumber || ""} rev={cur.version.revisionLabel || ""}
          document={cur.doc} userRole={activeRole} currentUserId={uid || undefined} currentUserEmail={userEmail || undefined}
          orgId={activeOrgId ?? undefined} />
      </div>
    ) : (
      <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-900/60 p-4" role="dialog" aria-modal="true" onClick={onClose} data-doc-in-place={docId}>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text)] flex items-center gap-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
          {!cur ? <><Loader2 className="w-4 h-4 animate-spin" /> Opening…</>
            : <>
              <span>{cur.doc ? "This document has no file to show yet." : "This document can't be opened: it was removed, or it isn't yours to see."}</span>
              <button type="button" onClick={onClose} className="h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-xs font-bold hover:bg-[var(--color-surface-2)]">Close</button>
            </>}
        </div>
      </div>
    ),
    document.body,
  );
}
