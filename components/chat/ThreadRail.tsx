"use client";

// ThreadRail — the conversations, on the left, the way every chat product
// keeps them: search at the top, pinned first, then active, then settled
// (collapsed). Settled = answered and shelved; the team's answered-questions
// shelf, not a graveyard. Every row shows who asked, because this record is
// org-wide by design.

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search, Plus, Pin, PinOff, Archive, ArchiveRestore, Pencil, Trash2, MoreHorizontal,
  ChevronDown, ChevronRight, X, PanelLeftClose,
} from "lucide-react";
import type { ChatThread } from "@/lib/chatClient";
import { SCOPE_META, relativeTime } from "./shared";

export interface RailProps {
  threads: ChatThread[];
  activeId: string | null;
  libraryNames: Map<string, string>;
  uid: string | null;
  /** Rail is filtered to one library (shell opened from a library page). */
  libraryFilter: { id: string; name: string } | null;
  onClearLibraryFilter: () => void;
  onOpen: (t: ChatThread) => void;
  onNew: () => void;
  onPin: (t: ChatThread, pinned: boolean) => void;
  onSettle: (t: ChatThread, settled: boolean) => void;
  onRename: (t: ChatThread, title: string) => void;
  onDelete: (t: ChatThread) => void;
  onClose?: () => void;
  loading: boolean;
  error: string | null;
}

export default function ThreadRail(p: RailProps) {
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  const [settledOpen, setSettledOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return p.threads.filter((t) => {
      if (mine && p.uid && t.createdBy !== p.uid) return false;
      if (!needle) return true;
      return t.title.toLowerCase().includes(needle)
        || (t.createdByName ?? "").toLowerCase().includes(needle)
        || (p.libraryNames.get(t.libraryId ?? "") ?? "").toLowerCase().includes(needle);
    });
  }, [p.threads, q, mine, p.uid, p.libraryNames]);

  const pinned = filtered.filter((t) => t.pinned && !t.settledAt);
  const active = filtered.filter((t) => !t.pinned && !t.settledAt);
  const settled = filtered.filter((t) => !!t.settledAt);

  return (
    <div className="h-full flex flex-col bg-[var(--color-surface)] border-r border-[var(--color-border)]">
      <div className="px-3 pt-3 pb-2 space-y-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
            <input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search conversations"
              className="w-full h-8 pl-8 pr-2 text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]"
            />
          </div>
          <button onClick={p.onNew} title="New conversation"
            className="shrink-0 h-8 w-8 inline-flex items-center justify-center rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] transition-colors">
            <Plus className="w-4 h-4" />
          </button>
          {p.onClose && (
            <button onClick={p.onClose} title="Hide conversations"
              className="shrink-0 h-8 w-8 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors">
              <PanelLeftClose className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => setMine(false)}
            className={`text-[10px] font-black px-2 py-1 rounded-md border transition-colors ${!mine
              ? "border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-soft)]"
              : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}>
            Everyone
          </button>
          <button onClick={() => setMine(true)}
            className={`text-[10px] font-black px-2 py-1 rounded-md border transition-colors ${mine
              ? "border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-soft)]"
              : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}>
            Mine
          </button>
          {p.libraryFilter && (
            <button onClick={p.onClearLibraryFilter} title="Show every conversation"
              className="ml-auto inline-flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded-md border border-orange-300 dark:border-orange-800 text-orange-700 dark:text-orange-300 bg-orange-50 dark:bg-orange-950/30 max-w-[55%]">
              <span className="truncate">{p.libraryFilter.name}</span> <X className="w-3 h-3 shrink-0" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {p.error ? (
          <p className="px-2 py-3 text-[11px] font-bold text-amber-700 dark:text-amber-400">{p.error}</p>
        ) : p.loading && p.threads.length === 0 ? (
          <div className="space-y-2 px-1 pt-1 animate-pulse">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-11 rounded-lg bg-[var(--color-surface-2)]" />)}
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-[var(--color-text-muted)]">
            {p.threads.length === 0
              ? "No conversations yet. Ask the first question."
              : "Nothing matches."}
          </p>
        ) : (
          <>
            {pinned.length > 0 && (
              <Section label="Pinned">
                {pinned.map((t) => <Row key={t.id} t={t} p={p} />)}
              </Section>
            )}
            {active.length > 0 && (
              <Section label="Active">
                {active.map((t) => <Row key={t.id} t={t} p={p} />)}
              </Section>
            )}
            {settled.length > 0 && (
              <div className="mt-2">
                <button onClick={() => setSettledOpen((v) => !v)}
                  className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]">
                  {settledOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Settled <span className="font-bold normal-case tracking-normal">({settled.length})</span>
                </button>
                {settledOpen && settled.map((t) => <Row key={t.id} t={t} p={p} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-2">
      <div className="px-2 py-1 text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">{label}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ t, p }: { t: ChatThread; p: RailProps }) {
  const Icon = SCOPE_META[t.scope].icon;
  const active = t.id === p.activeId;
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(t.title);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menu]);
  const libName = t.libraryId ? p.libraryNames.get(t.libraryId) : null;
  const who = p.uid && t.createdBy === p.uid ? "you" : (t.createdByName ?? "someone").split("@")[0];

  const commitRename = () => {
    setRenaming(false);
    const next = title.trim();
    if (next && next !== t.title) p.onRename(t, next);
    else setTitle(t.title);
  };

  return (
    <div ref={ref} className={`group relative rounded-lg transition-colors ${active
      ? "bg-[var(--color-accent-soft)]"
      : "hover:bg-[var(--color-surface-2)]"}`}>
      {renaming ? (
        <div className="px-2 py-1.5">
          <input
            autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setTitle(t.title); setRenaming(false); } }}
            className="w-full h-7 px-2 text-xs rounded-md border border-[var(--color-accent-ring)] bg-[var(--color-surface)] text-[var(--color-text)] focus:outline-none"
          />
        </div>
      ) : (
        <button onClick={() => p.onOpen(t)} className="w-full text-left px-2 py-1.5 pr-8">
          <div className="flex items-center gap-1.5 min-w-0">
            <Icon className={`w-3.5 h-3.5 shrink-0 ${t.scope === "internet" ? "text-sky-600" : t.scope === "tools" ? "text-violet-600" : "text-orange-600"}`} />
            <span className={`text-xs truncate ${active ? "font-black text-[var(--color-text)]" : "font-bold text-[var(--color-text)]"}`}>
              {t.title || "Untitled"}
            </span>
          </div>
          <div className="pl-5 text-[10px] text-[var(--color-text-muted)] truncate">
            {libName ? `${libName} · ` : ""}{who} · {relativeTime(t.lastMessageAt)}
          </div>
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}
        title="More"
        className={`absolute right-1 top-1.5 p-1 rounded-md text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-opacity ${menu ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}>
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>
      {menu && (
        <div className="absolute right-1 top-8 z-20 w-44 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl p-1 animate-pop">
          <MenuItem icon={t.pinned ? PinOff : Pin} label={t.pinned ? "Unpin" : "Pin"}
            onClick={() => { setMenu(false); p.onPin(t, !t.pinned); }} />
          <MenuItem icon={t.settledAt ? ArchiveRestore : Archive} label={t.settledAt ? "Reopen" : "Settle"}
            onClick={() => { setMenu(false); p.onSettle(t, !t.settledAt); }} />
          <MenuItem icon={Pencil} label="Rename" onClick={() => { setMenu(false); setRenaming(true); }} />
          <MenuItem icon={Trash2} label="Delete" danger onClick={() => { setMenu(false); p.onDelete(t); }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: {
  icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${danger
        ? "text-rose-600 hover:bg-rose-500/10"
        : "text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );
}
