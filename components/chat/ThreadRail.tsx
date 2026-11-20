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
import LoadingBlock from "@/components/ui/LoadingBlock";
import { bandSeg, bandSegItem } from "@/components/admin/band";

export interface RailProps {
  threads: ChatThread[];
  activeId: string | null;
  libraryNames: Map<string, string>;
  uid: string | null;
  /** Rail is filtered to one library (shell opened from a library page). */
  libraryFilter: { id: string; name: string } | null;
  onClearLibraryFilter: () => void;
  /** Show only one library's conversations (its tag on a row). */
  onFilterLibrary?: (libraryId: string) => void;
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
    <div className="h-full flex flex-col bg-[var(--color-surface)]">
      <div className="px-3 pt-3 pb-2 space-y-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
            <input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="w-full h-9 pl-8 pr-2 text-[14px] rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40"
            />
          </div>
          <button onClick={p.onNew} title="New conversation" aria-label="New conversation"
            className="shrink-0 h-9 w-9 inline-flex items-center justify-center rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
            <Plus className="w-4 h-4" />
          </button>
          {p.onClose && (
            <button onClick={p.onClose} title="Hide conversations" aria-label="Hide conversations"
              className="shrink-0 h-9 w-9 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
              <PanelLeftClose className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <div className={`${bandSeg} shrink-0`} role="group" aria-label="Whose conversations">
            <button onClick={() => setMine(false)} aria-pressed={!mine} className={`${bandSegItem(!mine)} !h-7 !text-[13px]`}>Everyone</button>
            <button onClick={() => setMine(true)} aria-pressed={mine} className={`${bandSegItem(mine)} !h-7 !text-[13px]`}>Mine</button>
          </div>
          {p.libraryFilter && (
            // The filter as a solid tag: its x shows every conversation again.
            <button onClick={p.onClearLibraryFilter} title="Show every conversation" aria-label={`Stop showing only ${p.libraryFilter.name}`}
              className="ui-tag ml-auto min-w-0 !bg-[var(--color-main)] !text-white !border-[var(--color-main)]">
              <span className="truncate">{p.libraryFilter.name}</span> <X className="w-3.5 h-3.5 shrink-0" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-3">
        {p.error ? (
          <p role="alert" className="px-3 py-3 text-[13px] font-semibold text-[var(--state-overdue)]">Couldn&apos;t load the conversations: {p.error}</p>
        ) : p.loading && p.threads.length === 0 ? (
          <LoadingBlock what="conversations" rows={4} className="mx-3 mt-1" />
        ) : filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-[14px] text-[var(--color-text-muted)]">
            {p.threads.length === 0
              ? "No conversations yet. Ask the first question."
              : "Nothing matches."}
          </p>
        ) : (
          <>
            {pinned.length > 0 && (
              <Section label="Pinned" count={pinned.length}>
                {pinned.map((t) => <Row key={t.id} t={t} p={p} />)}
              </Section>
            )}
            {active.length > 0 && (
              <Section label="Active" count={active.length}>
                {active.map((t) => <Row key={t.id} t={t} p={p} />)}
              </Section>
            )}
            {settled.length > 0 && (
              <div className="mt-3">
                <button onClick={() => setSettledOpen((v) => !v)}
                  aria-expanded={settledOpen}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                  {settledOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  Settled <span className="ui-count !h-5 !min-w-5 !px-1.5 !text-[12px]">{settled.length}</span>
                </button>
                {settledOpen && <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">{settled.map((t) => <Row key={t.id} t={t} p={p} />)}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="px-3 pb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-heading)]">
        {label} <span className="ui-count !h-5 !min-w-5 !px-1.5 !text-[12px]">{count}</span>
      </div>
      <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">{children}</div>
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
    // Where you are: the soft tint of the signal color with a bar on its
    // edge, the same mark as the side menu.
    <div ref={ref} style={active ? { backgroundColor: "var(--color-accent-soft)" } : undefined}
      className={`group relative transition-colors ${active ? "" : "hover:bg-[var(--color-surface-2)]"}`}>
      {active && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--color-main)]" />}
      {renaming ? (
        <div className="px-3 py-2">
          <input
            autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setTitle(t.title); setRenaming(false); } }}
            aria-label="Conversation name"
            className="w-full h-9 px-2 text-[14px] rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40"
          />
        </div>
      ) : (
        // The whole row opens the conversation (the title button stretches
        // over it); the library tag on the second line filters by library.
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 pl-3 pr-9 py-2.5">
          <span aria-hidden className={`ui-icon-tile is-sm row-span-2 ${active ? "is-solid" : ""}`}><Icon className="w-4 h-4" /></span>
          <button onClick={() => p.onOpen(t)} aria-current={active ? "page" : undefined}
            className="min-w-0 text-left after:absolute after:inset-0 after:content-['']">
            <span className={`block text-[14px] truncate ${active ? "font-semibold text-[var(--color-accent-text)]" : "font-medium text-[var(--color-text)]"}`}>
              {t.title || "Untitled"}
            </span>
          </button>
          <div className="mt-1 flex items-center gap-2 min-w-0 text-[13px] text-[var(--color-text-muted)]">
            <span className="shrink-0">{who}</span>
            {libName && (p.onFilterLibrary && t.libraryId && p.libraryFilter?.id !== t.libraryId ? (
              <button type="button" onClick={() => p.onFilterLibrary?.(t.libraryId!)}
                title={`Show only ${libName}`} aria-label={`Show only ${libName} conversations`}
                className="ui-tag relative z-[1] min-w-0 !h-[22px] !px-1.5 !text-[12.5px]">
                <span className="truncate">{libName}</span>
              </button>
            ) : (
              <span className="ui-tag min-w-0 !h-[22px] !px-1.5 !text-[12.5px]"><span className="truncate">{libName}</span></span>
            ))}
            <span className="ml-auto shrink-0 tabular-nums">{relativeTime(t.lastMessageAt)}</span>
          </div>
        </div>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={menu}
        className={`absolute z-[1] right-1.5 top-2 w-7 h-7 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-opacity ${menu ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"}`}>
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {menu && (
        <div role="menu" className="absolute right-1.5 top-10 z-20 w-44 rounded-lg bg-[var(--color-surface)] shadow-2xl ring-1 ring-[var(--color-border-strong)] p-1 animate-pop">
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
    <button onClick={onClick} role="menuitem"
      className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[14px] font-medium transition-colors ${danger
        ? "text-[var(--state-overdue)] hover:bg-[var(--color-surface-2)]"
        : "text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );
}
