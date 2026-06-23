"use client";

// useArchiveAwareOpen — drop-in archive awareness for any "open this file" action.
//
//   const { open, modal, busyPath } = useArchiveAwareOpen();
//   <button onClick={() => open(version.file_url, name)} />
//   {modal}
//
// It asks /api/storage/resolve what's behind the key: if the binary is present
// it opens it; if it was shed for space it pops the in-memory viewer with the
// exact archive to fetch — so a missing file becomes "provide root/data/<id>.zip"
// instead of a broken link, for any user.

import React, { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import BackupViewer, { type ArchiveTarget } from "@/components/archive/BackupViewer";

export function useArchiveAwareOpen() {
  const [target, setTarget] = useState<ArchiveTarget | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const open = useCallback(async (path: string, fileName?: string) => {
    if (!path) return;
    setBusyPath(path);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token ?? "";
      const res = await fetch(`/api/storage/resolve?path=${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body && body.archived === false && body.url) {
        window.open(body.url as string, "_blank", "noopener");
        return;
      }
      // Archived (or missing): show the in-memory viewer prompt.
      setTarget({
        storageKey: path,
        fileName: fileName || body?.fileName,
        archiveId: body?.archiveId ?? null,
        root: body?.root ?? null,
        kind: "space",
      });
    } catch {
      setTarget({ storageKey: path, fileName });
    } finally {
      setBusyPath(null);
    }
  }, []);

  const modal = target && typeof document !== "undefined"
    ? createPortal(
        <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-4xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden my-8 max-h-[90vh] flex flex-col">
            <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between shrink-0">
              <div className="text-sm font-black text-[var(--color-text)]">Archived file</div>
              <button onClick={() => setTarget(null)} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] transition-colors"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 overflow-y-auto"><BackupViewer target={target} /></div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return { open, modal, busyPath };
}
