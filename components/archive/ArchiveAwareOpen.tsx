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
import { supabase } from "@/lib/supabase";
import BackupViewer, { type ArchiveTarget } from "@/components/archive/BackupViewer";
import { Modal, ModalHeader, ModalBody } from "@/components/ui/Modal";

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
        note: body?.namingNote ?? null,
        kind: "space",
      });
    } catch {
      setTarget({ storageKey: path, fileName });
    } finally {
      setBusyPath(null);
    }
  }, []);

  const close = useCallback(() => setTarget(null), []);
  const modal = target ? (
    <Modal onClose={close} size="xl" zIndex={200}>
      <ModalHeader title="Archived file" subtitle={target.fileName} onClose={close} />
      <ModalBody><BackupViewer target={target} /></ModalBody>
    </Modal>
  ) : null;

  return { open, modal, busyPath };
}
