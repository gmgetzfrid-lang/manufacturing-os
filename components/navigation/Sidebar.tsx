"use client";

// Sidebar — navigation rail. Rebuilt with:
//
//   1. Proper IA. Three sections — Personal / Work / Admin.
//      "Active Checkouts" and "Hold Queue" are sub-items of
//      Document Control, not top-level peers.
//
//   2. Density. One line per item, ~28px row height, no per-row
//      subtitle. Subtitles surfaced via tooltip on hover (and on
//      the bottom hint strip when collapsed).
//
//   3. Single accent color. Orange = active. Slate everything else.
//      No per-item brand colors — they fight the visual hierarchy.
//
//   4. Collapsible. 240px ↔ 64px. Cmd/Ctrl+B toggles. Persisted in
//      localStorage. Icon-only mode shows label tooltips.
//
//   5. Pinned footer. Nav scrolls inside its own region; footer
//      never moves and never clips. The previous layout could push
//      the user card off-screen on tall menus / short windows.
//
// Groups (Documents → sub-items) expand on hover when collapsed
// and inline when expanded. Auto-expand if a descendant route is
// active so the user always sees where they are.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import {
  LayoutDashboard, Settings, Users, Shield, LogOut, FileText,
  BarChart3, Briefcase, KeyRound, Tag, Factory, AlertOctagon,
  StickyNote, ScrollText, Inbox, Activity, Lock, MailPlus,
  ChevronLeft, ChevronRight, ChevronDown, Database,
} from 'lucide-react';
import { useTicketNotifications } from '@/hooks/useTicketNotifications';

const COLLAPSED_KEY = 'mfg-os.sidebar.collapsed';
const GROUPS_KEY    = 'mfg-os.sidebar.openGroups';

interface NavLeaf {
  kind: 'leaf';
  label: string;
  hint?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
  badgeTone?: 'orange' | 'red' | 'blue';
}
interface NavGroup {
  kind: 'group';
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: NavLeaf[];
}
type NavNode = NavLeaf | NavGroup;
interface NavSection {
  title: string;
  items: NavNode[];
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { activeRole, userEmail, activeOrgId, setActiveOrgId, uid } = useRole();
  const { actionRequiredCount, unreadCount } = useTicketNotifications();

  const [collapsed, setCollapsed] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['documents']));
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
  const [orgLoading, setOrgLoading] = useState(false);

  // Hydrate persisted prefs.
  useEffect(() => {
    try {
      const c = localStorage.getItem(COLLAPSED_KEY);
      if (c === '1') setCollapsed(true);
      const g = localStorage.getItem(GROUPS_KEY);
      if (g) setOpenGroups(new Set(JSON.parse(g) as string[]));
    } catch {}
  }, []);

  // Persist + Cmd/Ctrl+B toggle.
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
  }, [collapsed]);
  useEffect(() => {
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify([...openGroups])); } catch {}
  }, [openGroups]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B') && !e.shiftKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
        e.preventDefault();
        setCollapsed((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Org list — same pattern as before.
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    const load = async () => {
      setOrgLoading(true);
      try {
        const { data } = await supabase
          .from('org_members')
          .select('org_id, orgs(id, name)')
          .eq('uid', uid)
          .eq('status', 'active');
        if (alive && data) {
          const rows = (data as unknown as Array<{ org_id: string; orgs: { id: string; name: string } | null }>)
            .filter((m) => m.orgs)
            .map((m) => ({ id: m.orgs!.id, name: m.orgs!.name }));
          setOrgs(rows);
        }
      } catch { if (alive) setOrgs([]); }
      finally { if (alive) setOrgLoading(false); }
    };
    void load();
    return () => { alive = false; };
  }, [uid]);

  const orgOptions = useMemo(() => orgs.slice().sort((a, b) => a.name.localeCompare(b.name)), [orgs]);

  const isAdmin = activeRole === 'Admin' || activeRole === 'DocCtrl';
  const isPathActive = useCallback((path: string) => {
    if (!pathname) return false;
    if (path === '/documents') return pathname === '/documents' || pathname.startsWith('/documents/');
    return pathname === path || pathname.startsWith(path + '/');
  }, [pathname]);

  // Build the IA. Groups with badges sum from children.
  const sections: NavSection[] = useMemo(() => {
    const personal: NavNode[] = [
      { kind: 'leaf', label: 'Inbox',      hint: 'Everything that needs you',  href: '/inbox',      icon: Inbox },
      { kind: 'leaf', label: 'Scratchpad', hint: 'Personal notes + tasks',     href: '/scratchpad', icon: StickyNote },
    ];

    const work: NavNode[] = [
      {
        kind: 'group', id: 'documents', label: 'Document Control', icon: Shield,
        children: [
          { kind: 'leaf', label: 'Libraries', hint: 'All controlled libraries',   href: '/documents',    icon: Database },
          { kind: 'leaf', label: 'Checkouts', hint: 'Every active lock org-wide', href: '/checkouts',    icon: Lock },
          { kind: 'leaf', label: 'Holds',     hint: 'Open hold queue',            href: '/admin/holds',  icon: AlertOctagon },
        ],
      },
      { kind: 'leaf', label: 'Projects', hint: 'Multi-doc work packages', href: '/projects', icon: Briefcase },
      {
        kind: 'leaf', label: 'Requests', hint: 'Drafting + work requests', href: '/requests', icon: MailPlus,
        badge: actionRequiredCount > 0 ? actionRequiredCount : unreadCount,
        badgeTone: actionRequiredCount > 0 ? 'red' : (unreadCount > 0 ? 'blue' : undefined),
      },
      { kind: 'leaf', label: 'Assets',   hint: 'Tagged equipment registry', href: '/admin/assets', icon: Tag },
      { kind: 'leaf', label: 'Activity', hint: 'What changed across the org', href: '/activity', icon: Activity },
    ];

    const admin: NavNode[] = isAdmin ? [
      { kind: 'leaf', label: 'Users',         href: '/admin/users',       icon: Users },
      { kind: 'leaf', label: 'Library config',href: '/admin/libraries',   icon: Settings },
      { kind: 'leaf', label: 'Request forms', href: '/admin/requests',    icon: FileText },
      { kind: 'leaf', label: 'Permissions',   href: '/admin/permissions', icon: Shield },
      { kind: 'leaf', label: 'Operational scope', href: '/admin/scope',   icon: Factory },
      { kind: 'leaf', label: 'Analytics',     href: '/admin/analytics',   icon: BarChart3 },
      { kind: 'leaf', label: 'Audit log',     href: '/admin/audit',       icon: ScrollText },
      { kind: 'leaf', label: 'Data export',   href: '/admin/data-export', icon: Database },
      { kind: 'leaf', label: 'Workspace',     href: '/admin/settings',    icon: Settings },
    ] : [];

    return [
      { title: 'Personal', items: personal },
      { title: 'Work',     items: work },
      ...(admin.length > 0 ? [{ title: 'Admin', items: admin }] : []),
    ];
  }, [actionRequiredCount, unreadCount, isAdmin]);

  // Auto-expand a group when one of its children is the active route.
  useEffect(() => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      for (const s of sections) {
        for (const n of s.items) {
          if (n.kind === 'group') {
            if (n.children.some((c) => isPathActive(c.href))) next.add(n.id);
          }
        }
      }
      return next;
    });
  }, [pathname, sections, isPathActive]);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/');
  };

  const width = collapsed ? 'w-16' : 'w-60';

  return (
    <aside className={`${width} bg-slate-900 h-screen flex flex-col border-r border-slate-800 text-slate-300 transition-[width] duration-200 ease-out shrink-0`}>
      {/* BRAND */}
      <div className="h-14 flex items-center px-3 border-b border-slate-800 shrink-0 gap-2">
        <div className="w-8 h-8 bg-orange-600 rounded-lg flex items-center justify-center shadow-lg shadow-orange-900/20 shrink-0">
          <LayoutDashboard className="w-4 h-4 text-white" />
        </div>
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <div className="font-bold text-white tracking-tight text-sm leading-none truncate">Manufacturing<span className="text-orange-500">OS</span></div>
            <div className="text-[9px] text-slate-500 font-medium uppercase tracking-wider mt-0.5">Enterprise Platform</div>
          </div>
        )}
        <button
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Expand (⌘B)' : 'Collapse (⌘B)'}
          className="p-1 rounded text-slate-500 hover:text-white hover:bg-slate-800 shrink-0"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* WORKSPACE SWITCHER (compact) */}
      {orgOptions.length > 0 && !collapsed && (
        <div className="px-3 pt-3 pb-1">
          {orgOptions.length > 1 ? (
            <select
              value={activeOrgId ?? ''}
              onChange={(e) => setActiveOrgId(e.target.value || null)}
              disabled={orgLoading}
              className="w-full bg-slate-950 border border-slate-800 text-xs font-bold text-slate-300 rounded-md px-2 py-1.5 focus:ring-1 focus:ring-orange-500/50 focus:border-orange-500/50 outline-none cursor-pointer hover:border-slate-700"
            >
              {orgOptions.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
            </select>
          ) : (
            <div className="text-[10px] font-bold text-slate-400 truncate uppercase tracking-wider px-1">{orgOptions[0].name}</div>
          )}
        </div>
      )}

      {/* NAV — scrolls in its own region. */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 custom-scrollbar">
        {sections.map((section) => (
          <div key={section.title} className="mb-3">
            {!collapsed && (
              <div className="px-4 pt-2 pb-1 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                {section.title}
              </div>
            )}
            <div className={collapsed ? 'px-2 space-y-0.5' : 'px-2 space-y-0.5'}>
              {section.items.map((node) => (
                node.kind === 'leaf' ? (
                  <SidebarLeaf
                    key={node.href}
                    leaf={node}
                    active={isPathActive(node.href)}
                    collapsed={collapsed}
                  />
                ) : (
                  <SidebarGroup
                    key={node.id}
                    group={node}
                    open={openGroups.has(node.id)}
                    onToggle={() => toggleGroup(node.id)}
                    collapsed={collapsed}
                    isPathActive={isPathActive}
                  />
                )
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* USER FOOTER — pinned, never clips. */}
      <div className="shrink-0 border-t border-slate-800 bg-slate-950/60 p-2">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <Link href="/profile" title={`${userEmail ?? 'Profile'} · ${activeRole ?? ''}`}
              className="w-10 h-10 rounded-lg bg-gradient-to-tr from-slate-700 to-slate-600 flex items-center justify-center text-sm font-bold text-white border border-slate-500 hover:border-slate-400 shadow-sm">
              {activeRole?.charAt(0) ?? 'U'}
            </Link>
            <button onClick={handleLogout} title="Sign out"
              className="w-10 h-10 inline-flex items-center justify-center text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 bg-slate-800/40 hover:bg-slate-800/60 rounded-lg px-2 py-1.5 border border-slate-800 transition-colors">
            <Link href="/profile" className="flex items-center min-w-0 flex-1 group" title="Open profile">
              <div className="w-8 h-8 rounded-md bg-gradient-to-tr from-slate-700 to-slate-600 flex items-center justify-center text-xs font-bold text-white border border-slate-500 shadow-sm shrink-0">
                {activeRole?.charAt(0) ?? 'U'}
              </div>
              <div className="ml-2 overflow-hidden">
                <div className="text-xs font-bold text-white truncate group-hover:text-orange-200">{userEmail?.split('@')[0] ?? '—'}</div>
                <div className="text-[10px] text-slate-400 truncate font-mono uppercase tracking-wider">{activeOrgId ? (activeRole ?? '…') : 'No workspace'}</div>
              </div>
            </Link>
            <button
              onClick={handleLogout}
              className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-md transition-colors shrink-0"
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function SidebarLeaf({
  leaf, active, collapsed, indent,
}: {
  leaf: NavLeaf;
  active: boolean;
  collapsed: boolean;
  indent?: boolean;
}) {
  const Icon = leaf.icon;
  const badgeTone =
    leaf.badgeTone === 'red'  ? 'bg-red-600 animate-pulse' :
    leaf.badgeTone === 'blue' ? 'bg-blue-500' :
                                'bg-orange-500';
  return (
    <Link href={leaf.href}
      title={collapsed ? `${leaf.label}${leaf.hint ? ` — ${leaf.hint}` : ''}` : (leaf.hint ?? leaf.label)}
      className={`relative flex items-center gap-2.5 rounded-md transition-colors ${
        collapsed ? 'h-10 justify-center' : `h-8 px-2 ${indent ? 'pl-7' : ''}`
      } ${
        active
          ? 'bg-orange-600/15 text-orange-200 ring-1 ring-orange-500/30'
          : 'text-slate-300 hover:bg-slate-800 hover:text-white'
      }`}
    >
      {active && !collapsed && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-orange-500" aria-hidden />
      )}
      <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-orange-300' : 'text-slate-400'}`} />
      {!collapsed && <span className="text-[13px] font-semibold truncate flex-1">{leaf.label}</span>}
      {leaf.badge && leaf.badge > 0 && (
        <span className={`${collapsed ? 'absolute top-1 right-1' : ''} inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-white text-[9px] font-black ${badgeTone}`}>
          {leaf.badge > 99 ? '99+' : leaf.badge}
        </span>
      )}
    </Link>
  );
}

function SidebarGroup({
  group, open, onToggle, collapsed, isPathActive,
}: {
  group: NavGroup;
  open: boolean;
  onToggle: () => void;
  collapsed: boolean;
  isPathActive: (href: string) => boolean;
}) {
  const Icon = group.icon;
  const anyChildActive = group.children.some((c) => isPathActive(c.href));

  if (collapsed) {
    // Collapsed: flyout on hover. CSS-only via :hover on the group.
    return (
      <div className="relative group">
        <button
          title={group.label}
          className={`relative flex items-center justify-center w-full h-10 rounded-md transition-colors ${
            anyChildActive
              ? 'bg-orange-600/15 text-orange-200 ring-1 ring-orange-500/30'
              : 'text-slate-300 hover:bg-slate-800 hover:text-white'
          }`}
        >
          <Icon className={`w-4 h-4 ${anyChildActive ? 'text-orange-300' : 'text-slate-400'}`} />
        </button>
        <div className="absolute left-full ml-2 top-0 hidden group-hover:block z-50 w-56 bg-slate-900 border border-slate-800 rounded-lg shadow-2xl py-1.5">
          <div className="px-3 py-1 text-[10px] font-black text-slate-500 uppercase tracking-widest">{group.label}</div>
          {group.children.map((c) => (
            <SidebarLeaf key={c.href} leaf={c} active={isPathActive(c.href)} collapsed={false} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onToggle}
        className={`w-full flex items-center gap-2.5 h-8 px-2 rounded-md transition-colors ${
          anyChildActive ? 'text-orange-200' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
        }`}
      >
        <Icon className={`w-4 h-4 shrink-0 ${anyChildActive ? 'text-orange-300' : 'text-slate-400'}`} />
        <span className="text-[13px] font-semibold truncate flex-1 text-left">{group.label}</span>
        <ChevronDown className={`w-3 h-3 text-slate-500 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5">
          {group.children.map((c) => (
            <SidebarLeaf key={c.href} leaf={c} active={isPathActive(c.href)} collapsed={false} indent />
          ))}
        </div>
      )}
    </div>
  );
}
