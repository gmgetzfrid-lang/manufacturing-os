"use client";

// useEquipmentFilesSync - keeps the Equipment Files library in step with the
// registry and the site codebook without anyone pressing a button: each time
// `trigger` changes (the equipment list or the codebook just loaded or
// changed), it works out what's different and makes, numbers, renames or
// moves folders to match. Only for Admin and Document Control (the database
// makes and moves folders for them alone); one run at a time.

import { useCallback, useEffect, useRef, useState } from "react";
import { syncTree, type SyncResult } from "@/lib/equipmentLibraryPush";
import type { EquipmentTree } from "@/lib/equipmentLibrary";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** What a run did, in words ("41 folders made, 27 renamed or numbered"). Null: nothing. */
export function syncWords(r: SyncResult | null): string | null {
  if (!r) return null;
  const parts = [r.made && `${plural(r.made, "folder")} made`, r.renamed && `${plural(r.renamed, "folder")} numbered or renamed`, r.moved && `${plural(r.moved, "equipment folder")} moved to its type`].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function useEquipmentFilesSync(opts: { orgId: string | null; uid: string | null; email?: string | null; can: boolean; trigger: unknown; onSynced?: (tree: EquipmentTree) => void }) {
  const { orgId, uid, email, can, trigger, onSynced } = opts;
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const again = useRef(false);
  const done = useRef(onSynced);
  useEffect(() => { done.current = onSynced; }, [onSynced]);

  const run = useCallback(async () => {
    if (!orgId || !uid || !can) return;
    if (running.current) { again.current = true; return; }
    running.current = true;
    setError(null);
    try {
      const r = await syncTree(orgId, uid, email ?? undefined, (w) => setBusy(w));
      if (r) {
        if (r.made || r.renamed || r.moved) setLast(r);
        done.current?.(r.tree);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
      running.current = false;
      if (again.current) { again.current = false; void run(); }
    }
  }, [orgId, uid, email, can]);

  useEffect(() => {
    if (trigger === undefined || trigger === null) return;
    void run();
  }, [trigger, run]);

  return { busy, last, error, run, words: syncWords(last) };
}
