"use client";

// SourcesPanel — the strip at the top of a knowledge library that says WHERE
// its documents come from: linked document-control libraries and folders.
// A source is a live subscription (new docs appear, rev-ups re-index, removed
// docs drop out), so the strip is the library's provenance at a glance.
//
// The picker lists only containers the caller's ACL lets them read — and the
// server re-verifies on add, so the filter here is convenience, not the
// enforcement.

import React, { useCallback, useEffect, useState } from "react";
import {
  X, Loader2, Plus, Link2, FolderOpen, Library, RefreshCw, Trash2, Search,
} from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { appConfirm } from "@/components/providers/DialogProvider";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import {
  listKnowledgeSources, browseKnowledgeContainers, addKnowledgeSources,
  removeKnowledgeSource, syncKnowledgeSources,
  type KnowledgeSource, type SourceBrowseResult,
} from "@/lib/knowledge";

function AddSourcesModal({ orgId, libraryId, existing, onClose, onAdded }: {
  orgId: string;
  libraryId: string;
  existing: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { showToast } = useToast();
  const [browse, setBrowse] = useState<SourceBrowseResult | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Map<string, "library" | "folder">>(new Map());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    browseKnowledgeContainers(orgId)
      .then((b) => { if (!cancelled) setBrowse(b); })
      .catch((e) => { if (!cancelled) setBrowseError((e as Error).message); });
    return () => { cancelled = true; };
  }, [orgId]);

  const toggle = (id: string, type: "library" | "folder") => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id); else next.set(id, type);
      return next;
    });
  };

  const save = async () => {
    if (selected.size === 0) return;
    setSaving(true);
    try {
      const res = await addKnowledgeSources(
        orgId, libraryId,
        [...selected].map(([id, type]) => ({ type, id })),
      );
      showToast({
        type: "success",
        title: `Linked ${res.linked} source${res.linked === 1 ? "" : "s"} — ${res.added} document${res.added === 1 ? "" : "s"} queued for indexing.`,
      });
      onAdded();
      onClose();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setSaving(false); }
  };

  const q = filter.trim().toLowerCase();
  const libraries = (browse?.libraries ?? [])
    .filter((l) => !q || l.name.toLowerCase().includes(q));
  const folders = (browse?.folders ?? [])
    .filter((f) => !q ||
      f.name.toLowerCase().includes(q) ||
      f.pathNames.join("/").toLowerCase().includes(q) ||
      f.libraryName.toLowerCase().includes(q));

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-xl mt-10"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <div>
            <h2 className="text-base font-black text-[var(--color-text)] flex items-center gap-2">
              <Link2 className="w-4 h-4 text-orange-600" /> Add sources from Document Control
            </h2>
            <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
              Linked containers feed this library LIVE — new documents index automatically, rev-ups
              re-index, archived ones drop out. No files are copied.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-3">
          {browseError && (
            <div className="rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs font-bold text-rose-700 dark:text-rose-300">{browseError}</div>
          )}
          {!browse && !browseError && (
            <div className="py-8 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-[var(--color-text-muted)]" /></div>
          )}
          {browse && (
            <>
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                <Input value={filter} onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter libraries and folders…" className="pl-8 text-xs" />
              </div>
              <div className="max-h-80 overflow-y-auto rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                {libraries.map((l) => {
                  const already = existing.has(l.id);
                  return (
                    <label key={l.id}
                      className={`flex items-center gap-2.5 px-3 py-2 text-xs ${already ? "opacity-50" : "cursor-pointer hover:bg-[var(--color-surface-2)]"}`}>
                      <input type="checkbox" disabled={already}
                        checked={already || selected.has(l.id)}
                        onChange={() => toggle(l.id, "library")}
                        className="accent-orange-600 w-4 h-4" />
                      <Library className="w-3.5 h-3.5 text-orange-600 shrink-0" />
                      <span className="font-bold text-[var(--color-text)] flex-1 truncate">{l.name}</span>
                      <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                        {already ? "LINKED" : "WHOLE LIBRARY"}
                      </span>
                    </label>
                  );
                })}
                {folders.map((f) => {
                  const already = existing.has(f.id);
                  const path = [f.libraryName, ...(f.pathNames.length ? f.pathNames : [f.name])].join(" / ");
                  return (
                    <label key={f.id}
                      className={`flex items-center gap-2.5 px-3 py-2 text-xs ${already ? "opacity-50" : "cursor-pointer hover:bg-[var(--color-surface-2)]"}`}>
                      <input type="checkbox" disabled={already}
                        checked={already || selected.has(f.id)}
                        onChange={() => toggle(f.id, "folder")}
                        className="accent-orange-600 w-4 h-4" />
                      <FolderOpen className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                      <span className="font-bold text-[var(--color-text)] flex-1 truncate" title={path}>{path}</span>
                      <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                        {already ? "LINKED" : "FOLDER + SUBFOLDERS"}
                      </span>
                    </label>
                  );
                })}
                {libraries.length === 0 && folders.length === 0 && (
                  <div className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
                    Nothing matches — or your permissions don&apos;t include any document-control containers.
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button onClick={() => void save()} disabled={saving || selected.size === 0}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Link {selected.size > 0 ? selected.size : ""} source{selected.size === 1 ? "" : "s"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SourcesPanel({ orgId, libraryId, isController, onChanged }: {
  orgId: string;
  libraryId: string;
  isController: boolean;
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const [sources, setSources] = useState<KnowledgeSource[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // sourceId or "sync"
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    listKnowledgeSources(orgId, libraryId)
      .then((r) => { if (!cancelled) { setSources(r.sources); setUnavailable(false); } })
      .catch(() => { if (!cancelled) setUnavailable(true); }); // pre-migration DB
    return () => { cancelled = true; };
  }, [orgId, libraryId, tick]);

  if (unavailable) return null;

  const sync = async () => {
    setBusy("sync");
    try {
      const res = await syncKnowledgeSources(orgId, libraryId);
      showToast({
        type: "success",
        title: `Synced — ${res.added} added, ${res.refreshed} re-indexing after rev-up, ${res.removed} removed.`,
      });
      bump();
      onChanged();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const remove = async (s: KnowledgeSource) => {
    const ok = await appConfirm({
      title: "Unlink this source?",
      message: `"${s.sourceName}" and its ${s.documentCount} mirrored document${s.documentCount === 1 ? "" : "s"} (and their search index) will be removed from this knowledge library. The controlled documents themselves are untouched.`,
      confirmLabel: "Unlink",
    });
    if (!ok) return;
    setBusy(s.id);
    try {
      await removeKnowledgeSource(orgId, s.id);
      bump();
      onChanged();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  return (
    <div className="mb-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5" /> Sources
        </span>
        {sources === null ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-text-muted)]" />
        ) : sources.length === 0 ? (
          <span className="text-[11px] text-[var(--color-text-muted)] italic">
            None linked — this library only has direct uploads.
          </span>
        ) : (
          sources.map((s) => (
            <span key={s.id}
              className="inline-flex items-center gap-1.5 text-[10px] font-black px-2 py-1 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text)]">
              {s.sourceType === "library"
                ? <Library className="w-3 h-3 text-orange-600" />
                : <FolderOpen className="w-3 h-3 text-orange-600" />}
              <span className="max-w-56 truncate" title={s.sourceName}>{s.sourceName}</span>
              <span className="text-[var(--color-text-muted)]">· {s.documentCount}</span>
              {isController && (
                <button onClick={() => void remove(s)} disabled={busy !== null} title="Unlink source"
                  className="ml-0.5 text-[var(--color-text-muted)] hover:text-rose-600">
                  {busy === s.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                </button>
              )}
            </span>
          ))
        )}
        {isController && (
          <span className="ml-auto flex items-center gap-1.5">
            {(sources?.length ?? 0) > 0 && (
              <Button size="sm" variant="secondary" onClick={() => void sync()} disabled={busy !== null}>
                {busy === "sync" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Sync now
              </Button>
            )}
            <Button size="sm" onClick={() => setShowAdd(true)} disabled={busy !== null}>
              <Plus className="w-3.5 h-3.5" /> Add sources
            </Button>
          </span>
        )}
      </div>
      {(sources?.length ?? 0) > 0 && (
        <p className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">
          Live from Document Control: new documents index automatically, published revisions re-index,
          archived ones drop out. Answers always cite the current revision. Restricted documents are
          excluded from answers for people who can&apos;t read them.
        </p>
      )}
      {showAdd && (
        <AddSourcesModal
          orgId={orgId}
          libraryId={libraryId}
          existing={new Set((sources ?? []).map((s) => s.sourceId))}
          onClose={() => setShowAdd(false)}
          onAdded={() => { bump(); onChanged(); }}
        />
      )}
    </div>
  );
}
