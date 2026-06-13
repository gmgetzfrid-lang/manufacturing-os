"use client";

// LibraryHomeBoard — optional SharePoint-style "web part" home for a
// library root. Default behavior is unchanged: if a library has no
// enabled home config, this renders nothing (controllers see a small
// "set up a home" prompt). When enabled, the configured parts render in
// a responsive grid above the folders/documents browser.
//
// View + edit live together: controllers get a Customize button that
// flips an in-place editor (drag to reorder, resize, retitle, add/remove
// parts) and a Save that persists via the parent's onSave.

import React, { useMemo, useState } from "react";
import { Plus, Pencil, Check, X, Trash2, GripVertical, FileText, FolderOpen, Clock, Info, Type, BarChart3, Loader2, Zap, Maximize2 } from "lucide-react";
import type {
  LibraryCollection, DocumentRecord, LibraryHomeConfig, WebPart, WebPartType,
} from "@/types/schema";
import { NodeIcon } from "@/lib/nodeIcons";

const PART_META: Record<WebPartType, { label: string; icon: React.ComponentType<{ className?: string }>; defaultTitle: string; defaultWidth: WebPart["width"] }> = {
  about:        { label: "About",            icon: Info,      defaultTitle: "About this library", defaultWidth: "full" },
  quickFolders: { label: "Quick folders",    icon: FolderOpen, defaultTitle: "Folders",            defaultWidth: "half" },
  recentDocs:   { label: "Recent documents", icon: Clock,     defaultTitle: "Recent documents",   defaultWidth: "half" },
  stats:        { label: "Stats",            icon: BarChart3, defaultTitle: "At a glance",         defaultWidth: "third" },
  text:         { label: "Text / notice",    icon: Type,      defaultTitle: "Notice",             defaultWidth: "full" },
};

const WIDTH_SPAN: Record<NonNullable<WebPart["width"]>, string> = {
  full: "col-span-6",
  half: "col-span-6 md:col-span-3",
  third: "col-span-6 md:col-span-2",
};

let __seq = 0;
const newId = () => `wp_${Date.now().toString(36)}_${(__seq++).toString(36)}`;

function defaultParts(): WebPart[] {
  return [
    { id: newId(), type: "about", width: "full" },
    { id: newId(), type: "quickFolders", title: "Folders", width: "half" },
    { id: newId(), type: "recentDocs", title: "Recent documents", width: "half", settings: { count: 6 } },
  ];
}

function tsToMillis(v: unknown): number {
  if (!v) return 0;
  const o = v as { toMillis?: () => number; seconds?: number };
  if (typeof o.toMillis === "function") return o.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string") { const p = Date.parse(v); return Number.isNaN(p) ? 0 : p; }
  if (typeof o.seconds === "number") return o.seconds * 1000;
  return 0;
}

export interface HomeNode {
  name: string;
  description?: string;
  icon?: string;
  homeConfig?: LibraryHomeConfig;
}

export default function LibraryHomeBoard({
  node, folders, documents, canEdit, onOpenFolder, onOpenDoc, onSave,
}: {
  /** The library or folder this home belongs to. */
  node: HomeNode;
  folders: LibraryCollection[];
  documents: DocumentRecord[];
  canEdit: boolean;
  onOpenFolder: (id: string) => void;
  onOpenDoc: (doc: DocumentRecord) => void;
  onSave: (config: LibraryHomeConfig) => Promise<void> | void;
}) {
  const config = node.homeConfig;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LibraryHomeConfig>({ enabled: true, parts: [] });
  const [saving, setSaving] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  const startEditing = () => {
    setDraft(config?.parts?.length ? { enabled: true, parts: config.parts } : { enabled: true, parts: defaultParts() });
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try { await onSave({ ...draft, enabled: true }); setEditing(false); }
    finally { setSaving(false); }
  };

  const disableHome = async () => {
    setSaving(true);
    try { await onSave({ enabled: false, parts: draft.parts }); setEditing(false); }
    finally { setSaving(false); }
  };

  // ── Not editing ──────────────────────────────────────────────────
  if (!editing) {
    if (!config?.enabled || !config.parts?.length) {
      if (!canEdit) return null;
      return (
        <button
          onClick={startEditing}
          className="w-full mb-4 flex items-center gap-3 px-4 py-3 rounded-2xl border border-dashed border-[var(--color-border-strong)] text-left hover:bg-[var(--color-surface-2)] transition-colors group"
        >
          <span className="w-9 h-9 rounded-xl grid place-items-center text-white shrink-0" style={{ background: "var(--brand-gradient)" }}>
            <Zap className="w-4 h-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-[var(--color-text)]">Set up a custom home</span>
            <span className="block text-xs text-[var(--color-text-muted)]">Add an about panel, quick folders, recent documents and notices — optional, your library works without it.</span>
          </span>
        </button>
      );
    }
    return (
      <div className="mb-5">
        {canEdit && (
          <div className="flex justify-end mb-2">
            <button onClick={startEditing} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-[var(--color-text-muted)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
              <Pencil className="w-3.5 h-3.5" /> Customize home
            </button>
          </div>
        )}
        <PartGrid parts={config.parts} node={node} folders={folders} documents={documents} onOpenFolder={onOpenFolder} onOpenDoc={onOpenDoc} />
      </div>
    );
  }

  // ── Editing ──────────────────────────────────────────────────────
  const update = (id: string, patch: Partial<WebPart>) =>
    setDraft((d) => ({ ...d, parts: d.parts.map((p) => p.id === id ? { ...p, ...patch } : p) }));
  const remove = (id: string) => setDraft((d) => ({ ...d, parts: d.parts.filter((p) => p.id !== id) }));
  const add = (type: WebPartType) => {
    const m = PART_META[type];
    setDraft((d) => ({ ...d, parts: [...d.parts, { id: newId(), type, title: m.defaultTitle, width: m.defaultWidth, settings: type === "recentDocs" ? { count: 6 } : {} }] }));
  };
  const cycleWidth = (id: string, cur: WebPart["width"]) => {
    const order: NonNullable<WebPart["width"]>[] = ["third", "half", "full"];
    const next = order[(order.indexOf((cur ?? "half") as NonNullable<WebPart["width"]>) + 1) % order.length];
    update(id, { width: next });
  };
  const reorder = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    setDraft((d) => {
      const parts = [...d.parts];
      const from = parts.findIndex((p) => p.id === dragId);
      const to = parts.findIndex((p) => p.id === targetId);
      if (from < 0 || to < 0) return d;
      const [moved] = parts.splice(from, 1);
      parts.splice(to, 0, moved);
      return { ...d, parts };
    });
  };

  return (
    <div className="mb-5 rounded-2xl border-2 border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-black uppercase tracking-widest text-[var(--color-text-muted)]">Customizing home</div>
        <div className="flex items-center gap-2">
          <button onClick={disableHome} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">Turn off home</button>
          <button onClick={() => setEditing(false)} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><X className="w-3.5 h-3.5 inline -mt-0.5" /> Cancel</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] disabled:opacity-50" style={{ background: "var(--color-accent)" }}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
          </button>
        </div>
      </div>

      {/* add-part palette */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {(Object.keys(PART_META) as WebPartType[]).map((t) => {
          const M = PART_META[t];
          return (
            <button key={t} onClick={() => add(t)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-accent)]">
              <Plus className="w-3 h-3" /> <M.icon className="w-3.5 h-3.5" /> {M.label}
            </button>
          );
        })}
      </div>

      {draft.parts.length === 0 ? (
        <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">Add a part above to begin.</div>
      ) : (
        <div className="grid grid-cols-6 gap-3">
          {draft.parts.map((p) => {
            const M = PART_META[p.type];
            return (
              <div
                key={p.id}
                draggable
                onDragStart={() => setDragId(p.id)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => { e.preventDefault(); reorder(p.id); }}
                className={`${WIDTH_SPAN[p.width ?? "half"]} rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 ${dragId === p.id ? "opacity-50" : ""}`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <GripVertical className="w-4 h-4 text-[var(--color-text-faint)] cursor-grab shrink-0" />
                  <M.icon className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                  <input
                    value={p.title ?? ""}
                    onChange={(e) => update(p.id, { title: e.target.value })}
                    placeholder={M.defaultTitle}
                    className="flex-1 min-w-0 bg-transparent text-sm font-bold text-[var(--color-text)] outline-none border-b border-transparent focus:border-[var(--color-border)]"
                  />
                  <button onClick={() => cycleWidth(p.id, p.width)} title="Resize" className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><Maximize2 className="w-3.5 h-3.5" /></button>
                  <button onClick={() => remove(p.id)} title="Remove" className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
                <div className="text-[11px] text-[var(--color-text-faint)] font-semibold uppercase tracking-wider mb-1">{M.label} · {(p.width ?? "half")}</div>
                {p.type === "recentDocs" && (
                  <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    Show
                    <input type="number" min={1} max={20} value={p.settings?.count ?? 6}
                      onChange={(e) => update(p.id, { settings: { ...p.settings, count: Math.max(1, Math.min(20, Number(e.target.value) || 6)) } })}
                      className="w-16 px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]" />
                    documents
                  </label>
                )}
                {p.type === "text" && (
                  <textarea rows={3} value={p.settings?.body ?? ""}
                    onChange={(e) => update(p.id, { settings: { ...p.settings, body: e.target.value } })}
                    placeholder="Write a notice for everyone who opens this library…"
                    className="w-full px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] text-xs text-[var(--color-text)] resize-none" />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Read-only render of the configured parts ────────────────────────
function PartGrid({
  parts, node, folders, documents, onOpenFolder, onOpenDoc,
}: {
  parts: WebPart[];
  node: HomeNode;
  folders: LibraryCollection[];   // already scoped by the caller
  documents: DocumentRecord[];
  onOpenFolder: (id: string) => void;
  onOpenDoc: (doc: DocumentRecord) => void;
}) {
  const rootFolders = folders;
  const recent = useMemo(
    () => [...documents].sort((a, b) => tsToMillis(b.updatedAt) - tsToMillis(a.updatedAt)),
    [documents],
  );

  return (
    <div className="grid grid-cols-6 gap-4">
      {parts.map((p) => (
        <section key={p.id} className={`${WIDTH_SPAN[p.width ?? "half"]} rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden`}>
          {p.type === "about" ? (
            <div className="p-5">
              <h3 className="text-sm font-black text-[var(--color-text)] flex items-center gap-2 mb-2">
                {node.icon ? <NodeIcon name={node.icon} className="w-4 h-4 text-[var(--color-accent)]" /> : <Info className="w-4 h-4 text-[var(--color-accent)]" />}
                {p.title || `About ${node.name}`}
              </h3>
              <p className="text-sm text-[var(--color-text-muted)] whitespace-pre-line">{node.description || "No description provided."}</p>
            </div>
          ) : p.type === "stats" ? (
            <div className="p-5">
              <h3 className="text-sm font-black text-[var(--color-text)] mb-3">{p.title || "At a glance"}</h3>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Folders" value={folders.length} />
                <Stat label="Documents" value={documents.length} />
              </div>
            </div>
          ) : p.type === "text" ? (
            <div className="p-5">
              {p.title && <h3 className="text-sm font-black text-[var(--color-text)] mb-2">{p.title}</h3>}
              <p className="text-sm text-[var(--color-text-muted)] whitespace-pre-line">{p.settings?.body || ""}</p>
            </div>
          ) : p.type === "quickFolders" ? (
            <div className="p-5">
              <h3 className="text-sm font-black text-[var(--color-text)] flex items-center gap-2 mb-3"><FolderOpen className="w-4 h-4 text-[var(--color-accent)]" /> {p.title || "Folders"}</h3>
              {rootFolders.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">No folders yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {pickFolders(rootFolders, p.settings?.folderIds).map((f) => (
                    <button key={f.id} onClick={() => onOpenFolder(f.id!)}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-2xl border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-2)] text-sm font-semibold text-[var(--color-text)] transition-colors hover-lift">
                      <span className="w-5 h-5 rounded grid place-items-center text-white shrink-0" style={{ background: f.color || "var(--brand-gradient)" }}>
                        <NodeIcon name={f.icon} className="w-3 h-3" />
                      </span>
                      <span className="truncate max-w-[12rem]">{f.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            // recentDocs
            <div className="p-5">
              <h3 className="text-sm font-black text-[var(--color-text)] flex items-center gap-2 mb-3"><Clock className="w-4 h-4 text-[var(--color-accent)]" /> {p.title || "Recent documents"}</h3>
              {recent.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">No documents yet.</p>
              ) : (
                <ul className="divide-y divide-[var(--color-border)] -my-1">
                  {recent.slice(0, p.settings?.count ?? 6).map((d) => (
                    <li key={d.id}>
                      <button onClick={() => onOpenDoc(d)} className="w-full flex items-center gap-3 py-2 text-left hover:bg-[var(--color-surface-2)] rounded-lg px-1 -mx-1">
                        <FileText className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-[var(--color-text)] truncate">{d.title || d.name || d.documentNumber || "Untitled"}</span>
                          <span className="block text-[11px] text-[var(--color-text-muted)] truncate">{d.documentNumber}{d.rev ? ` · Rev ${d.rev}` : ""}{d.status ? ` · ${d.status}` : ""}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-[var(--color-surface-2)] p-3">
      <div className="text-2xl font-black text-[var(--color-text)]">{value}</div>
      <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
    </div>
  );
}

function pickFolders(rootFolders: LibraryCollection[], ids?: string[]): LibraryCollection[] {
  if (ids && ids.length) {
    const map = new Map(rootFolders.map((f) => [f.id, f]));
    return ids.map((id) => map.get(id)).filter(Boolean) as LibraryCollection[];
  }
  return rootFolders.slice(0, 8);
}
