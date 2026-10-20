"use client";

// DuplicateUploadsModal — "did I just upload this three times?"
//
// A batch that was sent more than once lands as extra documents: same file
// name, same size, same folder, the later ones with auto-suffixed numbers
// (-2, -3). This scans the whole library for exactly that, says how many
// extra copies exist, and removes them in one action — keeping the FIRST
// upload of each file, so links and history made since stay on the original.

import React, { useEffect, useState } from "react";
import { Copy, Loader2, Trash2, X, CheckCircle2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { deleteDocuments } from "@/lib/libraryCollections";

interface Row { id: string; name: string | null; collection_id: string | null; created_at: string; size: string | null; document_number: string | null; current_version_id: string | null; original: string | null }
interface Group { key: string; name: string; folderId: string | null; keep: Row; extras: Row[] }

export default function DuplicateUploadsModal({
  orgId, libraryId, folderName, onClose, onDeleted,
}: {
  orgId: string;
  libraryId: string;
  folderName: (id: string | null) => string;
  onClose: () => void;
  onDeleted: (ids: string[]) => void;
}) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [empty, setEmpty] = useState<Row[]>([]);
  const [scanned, setScanned] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const rows: Row[] = [];
      for (let from = 0; from < 50000; from += 1000) {
        const { data, error } = await supabase.from("documents")
          .select("id, name, collection_id, created_at, document_number, current_version_id, size:metadata->>size_bytes, original:metadata->>original_name")
          .eq("org_id", orgId).eq("library_id", libraryId)
          .order("created_at", { ascending: true }).order("id")
          .range(from, from + 999);
        if (!live) return;
        if (error) { setLoadError(error.message); return; }
        rows.push(...((data ?? []) as unknown as Row[]));
        setScanned(rows.length);
        if ((data ?? []).length < 1000) break;
      }
      // Same folder + same file name + same byte size = the same file sent
      // again. Oldest first, so the first upload is the one kept.
      // Uploads whose file never attached (the revision save failed) — an
      // entry with nothing to open. Handled separately from duplicates.
      const empty = rows.filter((r) => !r.current_version_id && r.original);
      const emptyIds = new Set(empty.map((r) => r.id));
      const byKey = new Map<string, Row[]>();
      for (const r of rows) {
        if (!r.name || emptyIds.has(r.id)) continue;
        const key = `${r.collection_id ?? "root"}|${r.name.toLowerCase()}|${r.size ?? "?"}`;
        const list = byKey.get(key);
        if (list) list.push(r); else byKey.set(key, [r]);
      }
      const out: Group[] = [];
      for (const [key, list] of byKey) {
        if (list.length < 2) continue;
        out.push({ key, name: list[0].name!, folderId: list[0].collection_id, keep: list[0], extras: list.slice(1) });
      }
      out.sort((a, b) => b.extras.length - a.extras.length || a.name.localeCompare(b.name));
      if (live) { setGroups(out); setEmpty(empty); }
    })().catch((e) => { if (live) setLoadError((e as Error).message); });
    return () => { live = false; };
  }, [orgId, libraryId]);

  const dupIds = (groups ?? []).flatMap((g) => g.extras.map((r) => r.id));
  const extras = [...dupIds, ...empty.map((r) => r.id)];
  const files = groups?.length ?? 0;
  const nothing = files === 0 && empty.length === 0;

  const removeExtras = async () => {
    setRunning({ done: 0, total: extras.length });
    try {
      const r = await deleteDocuments(orgId, extras, (done) => setRunning({ done, total: extras.length }));
      onDeleted(r.deleted);
      setResult(`Removed ${r.deleted.length.toLocaleString()} entr${r.deleted.length === 1 ? "y" : "ies"} (extra copies and entries with no file). The first good upload of each file is kept.`
        + (r.held.length ? ` ${r.held.length} under a legal hold were left alone.` : ""));
      setGroups([]);
      setEmpty([]);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div className="w-full max-w-xl bg-[var(--color-surface)] rounded-t-2xl sm:rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col max-h-[90dvh]">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-start gap-3">
          <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-950/40"><Copy className="w-5 h-5 text-amber-700 dark:text-amber-400" /></div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">Clean up uploads</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
              Files uploaded more than once into the same folder, and entries whose file never attached.
            </div>
          </div>
          <button onClick={onClose} disabled={!!running} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-auto">
          {loadError ? (
            <p className="text-sm text-rose-600">{loadError}</p>
          ) : result ? (
            <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400 flex items-start gap-2"><CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> {result}</p>
          ) : groups === null ? (
            <p className="text-sm text-[var(--color-text-muted)] flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking {scanned.toLocaleString()} documents…
            </p>
          ) : nothing ? (
            <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> All clean — no duplicate uploads and no entries missing their file.
            </p>
          ) : (
            <>
              {empty.length > 0 && (
                <p className="text-sm text-[var(--color-text)] mb-2">
                  <b className="text-rose-700 dark:text-rose-400">{empty.length.toLocaleString()} entr{empty.length === 1 ? "y has" : "ies have"} no file</b> — an
                  upload created the entry but its file never attached. There&apos;s nothing to open in them.
                </p>
              )}
              {files > 0 && (
              <p className="text-sm text-[var(--color-text)]">
                <b>{files.toLocaleString()} file{files === 1 ? " was" : "s were"}</b> uploaded more than once, making{" "}
                <b className="text-amber-700 dark:text-amber-400">{dupIds.length.toLocaleString()} extra cop{dupIds.length === 1 ? "y" : "ies"}</b>.
              </p>
              )}
              {files > 0 && <ul className="mt-3 rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] text-xs max-h-72 overflow-auto">
                {groups.slice(0, 200).map((g) => (
                  <li key={g.key} className="px-3 py-2 flex items-center gap-2 min-w-0">
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono truncate text-[var(--color-text)]" title={g.name}>{g.name}</span>
                      <span className="block text-[10px] text-[var(--color-text-faint)] truncate">{folderName(g.folderId)}</span>
                    </span>
                    <span className="shrink-0 font-black text-amber-700 dark:text-amber-400">×{g.extras.length + 1}</span>
                  </li>
                ))}
                {groups.length > 200 && <li className="px-3 py-2 text-[var(--color-text-faint)]">+{groups.length - 200} more files</li>}
              </ul>}
              <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">
                The first good upload of each file is kept; the later copies (numbered -2, -3…) and the entries with no file are permanently deleted.
              </p>
            </>
          )}
        </div>

        <div className="px-5 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          {running && (
            <span className="mr-auto text-[11px] font-bold text-[var(--color-text)] inline-flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> {running.done.toLocaleString()} of {running.total.toLocaleString()} removed…
            </span>
          )}
          <button onClick={onClose} disabled={!!running}
            className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-40">
            {result || nothing ? "Close" : "Cancel"}
          </button>
          {!result && !nothing && (
            <button onClick={() => void removeExtras()} disabled={!!running}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-black text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50">
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Clean up {extras.length.toLocaleString()} entr{extras.length === 1 ? "y" : "ies"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
