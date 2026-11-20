"use client";

// DocInPlace - a document opened right where you are: from the map, from a
// search result, from anywhere that is not its own folder. The full-size
// viewer is laid over the page; closing it leaves the page exactly as it
// was (the search, the folder, the map all still there). Nothing navigates:
// opening it takes one step in the browser's history on the same address,
// so Back closes it instead of leaving the page.

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { docForViewing } from "@/lib/docOpen";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";

const FullScreenViewer = dynamic(() => import("@/components/viewers/FullScreenViewer"), { ssr: false });

type Got = { id: string; doc: DocumentRecord | null; version: DocumentVersion | null };

export default function DocInPlace({ docId, onClose }: { docId: string; onClose: () => void }) {
  const { uid, userEmail, activeRole, activeOrgId } = useRole();
  const [got, setGot] = useState<Got | null>(null);

  // Back closes it: a step on the same address (the router is not told, so
  // nothing under it re-renders), popped by Back or by closing it here.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  const step = useRef<{ pushed: boolean; leaving: number | null }>({ pushed: false, leaving: null });
  useEffect(() => {
    const st = step.current;
    // Mounted again straight away (React checking effects in development):
    // the step taken is still the one.
    if (st.leaving != null) { window.clearTimeout(st.leaving); st.leaving = null; }
    else if (!st.pushed) { window.history.pushState(window.history.state, "", window.location.href); st.pushed = true; }
    const onPop = () => { if (!st.pushed) return; st.pushed = false; closeRef.current(); };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Closed here (not by Back): take the step back off.
      if (st.pushed) st.leaving = window.setTimeout(() => { st.leaving = null; if (st.pushed) { st.pushed = false; window.history.back(); } }, 0);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void docForViewing(docId)
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
      <div className="fixed inset-0 z-[100] grid place-items-center bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] p-4" role="dialog" aria-modal="true" onClick={onClose} data-doc-in-place={docId}>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text)] flex items-center gap-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
          {!cur ? <><Loader2 className="w-4 h-4 animate-spin" /> Opening…</>
            : <>
              <span>{cur.doc ? "This document has no file to show yet." : "This document can't be opened: it was removed, or it isn't yours to see."}</span>
              <button type="button" onClick={onClose} className="h-8 px-3 rounded-lg border border-[var(--color-border-strong)] text-[13px] font-bold hover:bg-[var(--color-surface-2)]">Close</button>
            </>}
        </div>
      </div>
    ),
    document.body,
  );
}
