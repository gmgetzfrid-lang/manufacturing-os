"use client";

// SourcesPanel — the strip at the top of a knowledge library that says WHERE
// its documents come from: linked document-control libraries and folders.
// A source is a live subscription (new docs appear, rev-ups re-index, removed
// docs drop out), so the strip is the library's provenance at a glance.
//
// The picker lists only containers the caller's ACL lets them read — and the
// server re-verifies on add, so the filter here is convenience, not the
// enforcement.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import {
  Loader2, Plus, Link2, FolderOpen, Library, RefreshCw, Trash2, Search, ChevronRight,
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Tree wiring: folders grouped by library, children by parent. A node is
  // COVERED when the whole library or an ancestor folder is already picked
  // (or already linked) — covered rows show as included, not re-selectable.
  const tree = useMemo(() => {
    const byLibrary = new Map<string, string[]>();      // libId -> root folder ids
    const children = new Map<string, string[]>();       // folderId -> child ids
    const folderById = new Map<string, NonNullable<SourceBrowseResult["folders"]>[number]>();
    for (const f of browse?.folders ?? []) {
      folderById.set(f.id, f);
      if (f.parentId && (browse?.folders ?? []).some((p) => p.id === f.parentId)) {
        const list = children.get(f.parentId) ?? [];
        list.push(f.id);
        children.set(f.parentId, list);
      } else {
        const list = byLibrary.get(f.libraryId) ?? [];
        list.push(f.id);
        byLibrary.set(f.libraryId, list);
      }
    }
    return { byLibrary, children, folderById };
  }, [browse]);

  const isCovered = (folderId: string): boolean => {
    const f = tree.folderById.get(folderId);
    if (!f) return false;
    if (existing.has(f.libraryId) || selected.has(f.libraryId)) return true;
    let cur = f.parentId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (existing.has(cur) || selected.has(cur)) return true;
      cur = tree.folderById.get(cur)?.parentId ?? null;
    }
    return false;
  };

  const save = async () => {
    if (selected.size === 0) return;
    setSaving(true);
    try {
      // Prune redundant picks: a folder covered by a selected library or
      // ancestor folder rides along automatically — don't link it twice.
      const picks = [...selected]
        .filter(([id, type]) => type === "library" || !isCovered(id))
        .map(([id, type]) => ({ type, id }));
      const res = await addKnowledgeSources(orgId, libraryId, picks);
      showToast({
        type: "success",
        title: `Linked ${res.linked} source${res.linked === 1 ? "" : "s"}. ${res.added} document${res.added === 1 ? "" : "s"} queued for indexing.`,
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
  // Filtering flattens: a search means you know the name — show matches with
  // full paths instead of making you dig the tree.
  const filteredFolders = (browse?.folders ?? [])
    .filter((f) => q && (
      f.name.toLowerCase().includes(q) ||
      f.pathNames.join("/").toLowerCase().includes(q) ||
      f.libraryName.toLowerCase().includes(q)));

  // One folder row (recursive): chevron when it has children, checkbox,
  // "covered" state when a parent already includes it.
  const renderFolder = (folderId: string, depth: number): React.ReactNode => {
    const f = tree.folderById.get(folderId);
    if (!f) return null;
    const kids = tree.children.get(folderId) ?? [];
    const covered = isCovered(folderId);
    const already = existing.has(folderId);
    const open = expanded.has(folderId);
    return (
      <React.Fragment key={folderId}>
        <div className={`flex items-center gap-1.5 px-3 py-1.5 text-[13px] ${already || covered ? "opacity-55" : "hover:bg-[var(--color-surface-2)]"}`}
          style={{ paddingLeft: `${12 + depth * 18}px` }}>
          {kids.length > 0 ? (
            <button type="button" onClick={() => toggleExpand(folderId)}
              aria-label={open ? `Fold ${f.name}` : `Open ${f.name}`} aria-expanded={open}
              className="p-0.5 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
              <ChevronRight className={`w-3.5 h-3.5 ui-chevron${(open) ? " rotate-90" : ""}`} />
            </button>
          ) : <span className="w-[18px]" />}
          <label className={`flex items-center gap-2 flex-1 min-w-0 ${already || covered ? "" : "cursor-pointer"}`}>
            <input type="checkbox" disabled={already || covered}
              checked={already || covered || selected.has(folderId)}
              onChange={() => toggle(folderId, "folder")}
              className="accent-[var(--color-main)] w-4 h-4" />
            <FolderOpen className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
            <span className="font-bold text-[var(--color-text)] truncate">{f.name}</span>
          </label>
          {already ? (
            <span className="shrink-0 text-[13px] font-semibold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]">Linked</span>
          ) : covered ? (
            <span className="shrink-0 text-[13px] font-semibold px-1.5 py-0.5 rounded bg-[var(--state-released)]/10 border border-[color-mix(in_srgb,var(--state-released)_35%,transparent)] text-[var(--state-released)]">Included</span>
          ) : selected.has(folderId) ? (
            <span className="shrink-0 text-[13px] font-semibold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text)]">With subfolders</span>
          ) : null}
        </div>
        {open && kids.map((kid) => renderFolder(kid, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <Modal onClose={onClose} size="md" dismissable={!saving}>
        <ModalHeader icon={Link2} title="Add sources from Document Control"
          subtitle="Linked libraries and folders stay live: new documents index, rev-ups re-index, archived ones drop out. No files are copied."
          onClose={saving ? undefined : onClose} />

        <ModalBody className="space-y-3">
          {browseError && (
            <p role="alert" className="border-l-2 border-[var(--state-overdue)] pl-2 text-[13px] font-bold text-[var(--state-overdue)]">Couldn&apos;t list what you can link: {browseError}</p>
          )}
          {!browse && !browseError && (
            <div className="py-8 text-center text-sm text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading Document Control…</div>
          )}
          {browse && (
            <>
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                <Input value={filter} onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter libraries and folders…" className="pl-8 text-[13px]" />
              </div>
              <div className="max-h-80 overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                {q ? (
                  // Search mode: flat matches with full paths — you searched
                  // because you know the name.
                  <>
                    {libraries.map((l) => {
                      const already = existing.has(l.id);
                      return (
                        <label key={l.id}
                          className={`flex items-center gap-2.5 px-3 py-2 text-[13px] ${already ? "opacity-50" : "cursor-pointer hover:bg-[var(--color-surface-2)]"}`}>
                          <input type="checkbox" disabled={already}
                            checked={already || selected.has(l.id)}
                            onChange={() => toggle(l.id, "library")}
                            className="accent-[var(--color-main)] w-4 h-4" />
                          <Library className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                          <span className="font-bold text-[var(--color-text)] flex-1 truncate">{l.name}</span>
                          <span className="text-[13px] font-semibold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                            {already ? "LINKED" : "WHOLE LIBRARY"}
                          </span>
                        </label>
                      );
                    })}
                    {filteredFolders.map((f) => {
                      const already = existing.has(f.id);
                      const covered = isCovered(f.id);
                      const path = [f.libraryName, ...(f.pathNames.length ? f.pathNames : [f.name])].join(" / ");
                      return (
                        <label key={f.id}
                          className={`flex items-center gap-2.5 px-3 py-2 text-[13px] ${already || covered ? "opacity-50" : "cursor-pointer hover:bg-[var(--color-surface-2)]"}`}>
                          <input type="checkbox" disabled={already || covered}
                            checked={already || covered || selected.has(f.id)}
                            onChange={() => toggle(f.id, "folder")}
                            className="accent-[var(--color-main)] w-4 h-4" />
                          <FolderOpen className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                          <span className="font-bold text-[var(--color-text)] flex-1 truncate" title={path}>{path}</span>
                          <span className="text-[13px] font-semibold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                            {already ? "LINKED" : covered ? "INCLUDED" : "FOLDER + SUBFOLDERS"}
                          </span>
                        </label>
                      );
                    })}
                    {libraries.length === 0 && filteredFolders.length === 0 && (
                      <div className="px-3 py-6 text-center text-[13px] text-[var(--color-text-muted)]">
                        Nothing matches your search.
                      </div>
                    )}
                  </>
                ) : (
                  // Tree mode: libraries at the top level — take the whole
                  // thing, or expand and pick folders (subtrees implied).
                  <>
                    {(browse?.libraries ?? []).map((l) => {
                      const already = existing.has(l.id);
                      const rootFolders = tree.byLibrary.get(l.id) ?? [];
                      const open = expanded.has(l.id);
                      return (
                        <React.Fragment key={l.id}>
                          <div className={`flex items-center gap-1.5 px-3 py-2 text-[13px] ${already ? "opacity-55" : "hover:bg-[var(--color-surface-2)]"}`}>
                            {rootFolders.length > 0 ? (
                              <button type="button" onClick={() => toggleExpand(l.id)}
                                className="p-0.5 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
                                <ChevronRight className={`w-3.5 h-3.5 ui-chevron${(open) ? " rotate-90" : ""}`} />
                              </button>
                            ) : <span className="w-[18px]" />}
                            <label className={`flex items-center gap-2 flex-1 min-w-0 ${already ? "" : "cursor-pointer"}`}>
                              <input type="checkbox" disabled={already}
                                checked={already || selected.has(l.id)}
                                onChange={() => toggle(l.id, "library")}
                                className="accent-[var(--color-main)] w-4 h-4" />
                              <Library className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                              <span className="font-semibold text-[var(--color-text)] truncate">{l.name}</span>
                            </label>
                            <span className={`shrink-0 text-[13px] font-semibold px-1.5 py-0.5 rounded ${
                              already
                                ? "bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]"
                                : selected.has(l.id)
                                  ? "bg-[var(--color-surface-2)] text-[var(--color-text)]"
                                  : "bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]"}`}>
                              {already ? "LINKED" : selected.has(l.id) ? "WHOLE LIBRARY" : "ALL"}
                            </span>
                          </div>
                          {open && rootFolders.map((fid) => renderFolder(fid, 1))}
                        </React.Fragment>
                      );
                    })}
                    {(browse?.libraries ?? []).length === 0 && (
                      <div className="px-3 py-6 text-center text-[13px] text-[var(--color-text-muted)]">
                        Your permissions don&apos;t include any document-control libraries.
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </ModalBody>
        <ModalFooter>
                <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
                <Button onClick={() => void save()} disabled={saving || selected.size === 0}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Link {selected.size > 0 ? selected.size : ""} source{selected.size === 1 ? "" : "s"}
                </Button>
        </ModalFooter>
    </Modal>
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
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // sourceId or "sync"
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    listKnowledgeSources(orgId, libraryId)
      .then((r) => { if (!cancelled) { setSources(r.sources); setUnavailable(null); } })
      .catch((e: unknown) => { if (!cancelled) setUnavailable(e instanceof Error ? e.message : String(e)); }); // pre-migration DB, or a failed read
    return () => { cancelled = true; };
  }, [orgId, libraryId, tick]);

  // A failed read says so in one quiet line, instead of the strip vanishing.
  if (unavailable) return <p className="mb-3 text-[13px] text-[var(--color-text-muted)]">Couldn&apos;t load the linked sources: {unavailable}</p>;

  const sync = async () => {
    setBusy("sync");
    try {
      const res = await syncKnowledgeSources(orgId, libraryId);
      showToast({
        type: "success",
        title: `Synced: ${res.added} added, ${res.refreshed} re-indexing after rev-up, ${res.removed} removed.`,
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
    <div className="mb-3 rounded-lg bg-[var(--color-surface-2)] px-3.5 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[13px] font-semibold text-[var(--color-text-muted)] flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5" /> Sources
        </span>
        {sources === null ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading sources…</span>
        ) : sources.length === 0 ? (
          <span className="text-[13px] text-[var(--color-text-muted)] italic">
            None linked. This library only has direct uploads.
          </span>
        ) : (
          sources.map((s) => (
            <span key={s.id}
              className="inline-flex items-center gap-1.5 text-[13px] font-semibold px-2 py-1 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text)]">
              {s.sourceType === "library"
                ? <Library className="w-3 h-3 text-[var(--color-text-muted)]" />
                : <FolderOpen className="w-3 h-3 text-[var(--color-text-muted)]" />}
              <span className="max-w-56 truncate" title={s.sourceName}>{s.sourceName}</span>
              <span className="text-[var(--color-text-muted)]">· {s.documentCount}</span>
              {isController && (
                <button onClick={() => void remove(s)} disabled={busy !== null} title="Unlink source" aria-label={`Unlink ${s.sourceName}`}
                  className="ml-0.5 text-[var(--color-text-muted)] hover:text-[var(--state-overdue)]">
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
            <Button size="sm" variant="secondary" onClick={() => setShowAdd(true)} disabled={busy !== null}>
              <Plus className="w-3.5 h-3.5" /> Add sources
            </Button>
          </span>
        )}
      </div>
      {(sources?.length ?? 0) > 0 && (
        <p className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">
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
