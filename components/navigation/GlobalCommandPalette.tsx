"use client";

// GlobalCommandPalette — Cmd+K from anywhere in the app.
//
// What it does:
//  - Fuzzy/typesense search across documents, tickets, projects,
//    assets, notes (lib/globalSearch.ts). 200ms debounced.
//  - "g+letter" quick navigation when query starts with `g `:
//        g d  → /documents
//        g p  → /projects
//        g i  → /inbox
//        g t  → /requests
//        g s  → /scratchpad
//        g a  → /admin/audit
//  - Up/Down arrow + Enter to select. Esc to close.
//  - ? typed alone opens the shortcut help.
//
// Mounted once at the protected-layout level. Lives in a single
// useEffect-bound keydown listener so we don't fight component-
// scoped CommandPalette instances (they still work for in-library
// quick nav).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Search, FileText, Briefcase, KeyRound, StickyNote, Hash,
  CornerDownLeft, Loader2, X, Command, ArrowUp, ArrowDown,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { globalSearch, type GlobalHit, type GlobalHitKind } from "@/lib/globalSearch";
import { openEvidencePack, openProjectEvidencePack } from "@/lib/evidencePack";

const KIND_ICON: Record<GlobalHitKind, React.ComponentType<{ className?: string }>> = {
  document: FileText,
  ticket: Hash,
  project: Briefcase,
  asset: KeyRound,
  note: StickyNote,
};
const KIND_TONE: Record<GlobalHitKind, string> = {
  document: "text-blue-700 bg-blue-50 border-blue-200",
  ticket: "text-orange-700 bg-orange-50 border-orange-200",
  project: "text-indigo-700 bg-indigo-50 border-indigo-200",
  asset: "text-purple-700 bg-purple-50 border-purple-200",
  note: "text-slate-700 bg-slate-50 border-slate-200",
};

interface QuickNav { keys: string; label: string; href: string }
const QUICK_NAV: QuickNav[] = [
  { keys: "g i", label: "Go to Inbox", href: "/inbox" },
  { keys: "g d", label: "Go to Documents", href: "/documents" },
  { keys: "g p", label: "Go to Projects", href: "/projects" },
  { keys: "g t", label: "Go to Drafting Requests", href: "/requests" },
  { keys: "g s", label: "Go to Scratchpad", href: "/scratchpad" },
  { keys: "g a", label: "Go to Audit Log", href: "/admin/audit" },
  { keys: "g h", label: "Go to Hold Queue", href: "/admin/holds" },
  { keys: "g f", label: "Go to Activity Feed", href: "/activity" },
  { keys: "g n", label: "Notification settings", href: "/settings/notifications" },
  { keys: "g u", label: "My Profile", href: "/profile" },
  { keys: "g m", label: "Permissions Matrix", href: "/admin/permissions" },
];

// Action commands — ⌘K does, not just goes. Each routes to the flow that
// performs it; matched by label + keywords when the user types.
interface PaletteAction { label: string; href: string; keywords: string }
const ACTIONS: PaletteAction[] = [
  { label: "New drafting request", href: "/requests/new", keywords: "create new request drafting ticket markup" },
  { label: "New project", href: "/projects", keywords: "create new project work package" },
  { label: "New transmittal", href: "/transmittals", keywords: "transmittal issue send documents cover sheet recipient" },
  { label: "Open hold queue", href: "/admin/holds", keywords: "hold place block roadblock" },
  { label: "Export workspace data", href: "/admin/data-export", keywords: "export download backup portability data" },
  { label: "Library configuration", href: "/admin/libraries", keywords: "create library new document control config" },
  { label: "Manage users", href: "/admin/users", keywords: "add user invite member seat admin people" },
  { label: "Permissions matrix", href: "/admin/permissions", keywords: "permission access acl role grant" },
  { label: "Audit log", href: "/admin/audit", keywords: "audit history log compliance evidence" },
  { label: "Billing & plan", href: "/admin/billing", keywords: "billing plan upgrade subscription pay invoice" },
];

export default function GlobalCommandPalette() {
  const { activeOrgId } = useRole();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [hits, setHits] = useState<GlobalHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Open on Cmd+K / Ctrl+K — or just `/` when no input is focused — from
  // anywhere. The `/` shortcut matches Linear / GitHub / Vercel patterns
  // and is fast to reach for power users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdK = (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      const isSlash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey;
      // Don't hijack `/` when the user's typing into a field
      const target = e.target as HTMLElement | null;
      const inField = !!target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      );
      if (isCmdK || (isSlash && !inField && !open)) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Autofocus on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setHits([]);
      setShowShortcuts(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced search. Skip when query starts with "g " or "?" — those
  // are nav/help intents handled below.
  useEffect(() => {
    if (!open || !activeOrgId) return;
    if (query.trim() === "?") { setShowShortcuts(true); setHits([]); return; }
    setShowShortcuts(false);
    if (query.startsWith("g ") || query.trim().length < 2) { setHits([]); return; }
    const handle = setTimeout(async () => {
      setBusy(true);
      try {
        const found = await globalSearch({ orgId: activeOrgId, query, perKindLimit: 5 });
        setHits(found);
        setActiveIdx(0);
      } catch (e) {
        console.warn("[GlobalCommandPalette] search failed", e);
      } finally { setBusy(false); }
    }, 200);
    return () => clearTimeout(handle);
  }, [query, activeOrgId, open]);

  // Actions that depend on WHERE you are — e.g. an evidence pack for the
  // document/project you're currently looking at. Recomputed when the palette
  // opens so it reads the live ?doc= param.
  const contextActions = useMemo(() => {
    const acts: Array<{ key: string; label: string; run: () => void | Promise<void> }> = [];
    if (!open || typeof window === "undefined") return acts;
    const path = pathname ?? "";
    const sp = new URLSearchParams(window.location.search);
    const docMatch = path.match(/^\/documents\/([^/?]+)/);
    const docId = sp.get("doc");
    if (docMatch && docId) {
      acts.push({ key: "ctx-doc-evidence", label: "Evidence pack for this document", run: () => openEvidencePack(docId, activeOrgId ?? undefined) });
      acts.push({ key: "ctx-doc-transmit", label: "Issue this document via transmittal", run: () => { setOpen(false); router.push(`/transmittals?compose=1&doc=${docId}`); } });
    }
    const projMatch = path.match(/^\/projects\/([0-9a-fA-F-]{8,})/);
    if (projMatch) {
      acts.push({ key: "ctx-proj-evidence", label: "Evidence pack for this project", run: () => openProjectEvidencePack(projMatch[1]) });
    }
    return acts;
  }, [open, pathname, activeOrgId, router]);

  // Compose the visible items: context + actions + quick-nav, then resource hits.
  const visible = useMemo(() => {
    const items: Array<{ key: string; label: string; subtitle?: string; href?: string; kind?: GlobalHitKind; badge?: string; isAction?: boolean; run?: () => void | Promise<void> }> = [];
    const trimmed = query.trim();
    // Contextual actions always lead (when empty or matching).
    for (const c of contextActions) {
      if (trimmed.length === 0 || c.label.toLowerCase().includes(trimmed.toLowerCase())) {
        items.push({ key: c.key, label: c.label, subtitle: "Here", isAction: true, run: c.run });
      }
    }
    if (trimmed.startsWith("g ") || trimmed.length === 0) {
      // Empty query → a few common actions up top, then quick-nav.
      if (trimmed.length === 0) {
        for (const a of ACTIONS.slice(0, 4)) {
          items.push({ key: `action-${a.href}-${a.label}`, label: a.label, subtitle: "Action", href: a.href, isAction: true });
        }
      }
      const after = trimmed.startsWith("g ") ? trimmed.slice(2).toLowerCase() : "";
      for (const n of QUICK_NAV) {
        if (after.length === 0 || n.keys.includes(after) || n.label.toLowerCase().includes(after)) {
          items.push({ key: n.href, label: n.label, subtitle: n.keys, href: n.href });
        }
      }
    } else {
      // Typed query → matching actions first, then search results.
      const q = trimmed.toLowerCase();
      for (const a of ACTIONS) {
        if (a.label.toLowerCase().includes(q) || a.keywords.includes(q)) {
          items.push({ key: `action-${a.href}-${a.label}`, label: a.label, subtitle: "Action", href: a.href, isAction: true });
        }
      }
      for (const h of hits) {
        items.push({
          key: `${h.kind}-${h.id}`, label: h.title, subtitle: h.subtitle, href: h.href,
          kind: h.kind, badge: h.badge,
        });
      }
    }
    return items;
  }, [query, hits, contextActions]);

  const onSelect = useCallback((item: { href?: string; run?: () => void | Promise<void> }) => {
    setOpen(false);
    if (item.run) { void Promise.resolve(item.run()).catch((e) => console.warn("[palette] action failed", e)); return; }
    if (item.href) router.push(item.href);
  }, [router]);

  // Key handling inside the input
  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(visible.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const target = visible[activeIdx];
      if (target) onSelect(target);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[600] bg-slate-900/60 backdrop-blur-sm flex items-start justify-center pt-[12vh] p-4" onClick={() => setOpen(false)}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search or run an action — docs, tickets, 'new request', 'export data'… · 'g i' to go · '?' shortcuts"
            className="flex-1 outline-none text-sm placeholder:text-slate-400"
          />
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
          <button onClick={() => setOpen(false)} className="p-1 text-slate-400 hover:text-slate-700 rounded">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {showShortcuts ? (
          <Shortcuts />
        ) : (
          <ul className="max-h-[60vh] overflow-y-auto py-1">
            {visible.length === 0 ? (
              <li className="px-4 py-6 text-center text-xs italic text-slate-400">
                {query.trim().length < 2 ? "Start typing to search" : busy ? "Searching…" : "No matches"}
              </li>
            ) : (
              visible.map((it, i) => {
                const Icon = it.kind ? KIND_ICON[it.kind] : Command;
                const tone = it.kind ? KIND_TONE[it.kind] : "text-slate-600 bg-slate-50 border-slate-200";
                const isActive = i === activeIdx;
                return (
                  <li key={it.key}>
                    <button
                      onClick={() => onSelect(it)}
                      onMouseEnter={() => setActiveIdx(i)}
                      className={`w-full px-3 py-2 flex items-center gap-3 text-left ${isActive ? "bg-slate-100" : "hover:bg-slate-50"}`}
                    >
                      <div className={`shrink-0 w-7 h-7 rounded-md border flex items-center justify-center ${tone}`}>
                        <Icon className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-slate-900 truncate">{it.label}</div>
                        {it.subtitle && <div className="text-[11px] text-slate-500 truncate">{it.subtitle}</div>}
                      </div>
                      {it.badge && <span className="text-[10px] font-bold uppercase text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded shrink-0">{it.badge}</span>}
                      {isActive && <CornerDownLeft className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}

        <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-[10px] text-slate-500">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><ArrowUp className="w-2.5 h-2.5" /><ArrowDown className="w-2.5 h-2.5" /> navigate</span>
            <span className="inline-flex items-center gap-1"><CornerDownLeft className="w-2.5 h-2.5" /> open</span>
            <span>esc close</span>
          </div>
          <div className="flex items-center gap-3">
            {query.trim().length >= 2 && !showShortcuts && (
              <button
                onClick={() => { setOpen(false); router.push(`/search?q=${encodeURIComponent(query)}`); }}
                className="font-bold text-blue-700 hover:text-blue-900"
              >
                See all results →
              </button>
            )}
            <button onClick={() => setShowShortcuts((v) => !v)} className="font-bold text-slate-600 hover:text-slate-900">
              {showShortcuts ? "Search" : "Shortcuts (?)"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Shortcuts() {
  return (
    <div className="p-4 max-h-[60vh] overflow-y-auto">
      <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Quick Navigation</div>
      <ul className="space-y-1 text-xs mb-4">
        {QUICK_NAV.map((n) => (
          <li key={n.href} className="flex items-center gap-2">
            <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-[10px]">{n.keys}</kbd>
            <span className="text-slate-700">{n.label}</span>
          </li>
        ))}
      </ul>
      <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Global</div>
      <ul className="space-y-1 text-xs">
        <li className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-[10px]">⌘ K</kbd><span>Open this palette</span></li>
        <li className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-[10px]">/</kbd><span>Open this palette (when not typing)</span></li>
        <li className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-[10px]">esc</kbd><span>Close any modal</span></li>
        <li className="flex items-center gap-2"><kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-[10px]">?</kbd><span>Show shortcuts</span></li>
      </ul>
    </div>
  );
}
