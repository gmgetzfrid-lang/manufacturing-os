"use client";

// Sidebar — navigation rail.
//
// Real fixes vs the previous iteration:
//
//   1. Height bug. Old code used `h-screen` (100vh) on the sidebar
//      even though it sits inside a flex container that's already
//      `screen − trialBanner`. The sidebar rendered taller than its
//      slot and the footer clipped. Now `h-full` so the parent flex
//      constrains it, and the footer is shrink-0 below the scroll
//      region. The footer is always visible.
//
//   2. Character restored. Brand color per icon — orange for Inbox,
//      blue for Documents, indigo for Projects, etc. Active state
//      uses a subtle gradient + ring in the row's brand color, not
//      a flat orange. Each section has its own header treatment.
//
//   3. IA kept. Active Checkouts and Holds are sub-items of
//      Document Control. Personal / Work / Admin sections.
//
//   4. Collapse. ⌘B / Ctrl+B. 240px → 64px. Hover flyouts for
//      groups in collapsed mode. State persisted to localStorage.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import {
  LayoutDashboard, Settings, Users, Shield, LogOut, FileText,
  BarChart3, Briefcase, KeyRound, Tag, Factory, AlertOctagon,
  StickyNote, ScrollText, Inbox, Activity, Lock, MailPlus,
  ChevronLeft, ChevronRight, ChevronDown, Database, Library,
} from 'lucide-react';
import { useTicketNotifications } from '@/hooks/useTicketNotifications';

const COLLAPSED_KEY = 'mfg-os.sidebar.collapsed';
const GROUPS_KEY    = 'mfg-os.sidebar.openGroups';

type Tone = 'orange' | 'blue' | 'indigo' | 'amber' | 'emerald' | 'violet' | 'rose' | 'slate' | 'purple' | 'cyan';

interface NavLeaf {
  kind: 'leaf';
  label: string;
  hint?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
  badge?: number;
  badgeTone?: 'orange' | 'red' | 'blue';
}
interface NavGroup {
  kind: 'group';
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
  children: NavLeaf[];
}
type NavNode = NavLeaf | NavGroup;
interface NavSection {
  title: string;
  hint?: string;
  items: NavNode[];
}

// Centralized tone classes so every row is consistent.
const TONE_ICON: Record<Tone, string> = {
  orange:  'text-orange-400',
  blue:    'text-blue-400',
  indigo:  'text-indigo-400',
  amber:   'text-amber-400',
  emerald: 'text-emerald-400',
  violet:  'text-violet-400',
  rose:    'text-rose-400',
  slate:   'text-slate-400',
  purple:  'text-purple-400',
  cyan:    'text-cyan-400',
};
const TONE_ACTIVE_BG: Record<Tone, string> = {
  orange:  'bg-gradient-to-r from-orange-500/20 via-orange-500/10 to-transparent ring-orange-500/40',
  blue:    'bg-gradient-to-r from-blue-500/20 via-blue-500/10 to-transparent ring-blue-500/40',
  indigo:  'bg-gradient-to-r from-indigo-500/20 via-indigo-500/10 to-transparent ring-indigo-500/40',
  amber:   'bg-gradient-to-r from-amber-500/20 via-amber-500/10 to-transparent ring-amber-500/40',
  emerald: 'bg-gradient-to-r from-emerald-500/20 via-emerald-500/10 to-transparent ring-emerald-500/40',
  violet:  'bg-gradient-to-r from-violet-500/20 via-violet-500/10 to-transparent ring-violet-500/40',
  rose:    'bg-gradient-to-r from-rose-500/20 via-rose-500/10 to-transparent ring-rose-500/40',
  slate:   'bg-gradient-to-r from-slate-600/30 via-slate-700/20 to-transparent ring-slate-500/40',
  purple:  'bg-gradient-to-r from-purple-500/20 via-purple-500/10 to-transparent ring-purple-500/40',
  cyan:    'bg-gradient-to-r from-cyan-500/20 via-cyan-500/10 to-transparent ring-cyan-500/40',
};
const TONE_BAR: Record<Tone, string> = {
  orange:  'bg-orange-500',
  blue:    'bg-blue-500',
  indigo:  'bg-indigo-500',
  amber:   'bg-amber-500',
  emerald: 'bg-emerald-500',
  violet:  'bg-violet-500',
  rose:    'bg-rose-500',
  slate:   'bg-slate-500',
  purple:  'bg-purple-500',
  cyan:    'bg-cyan-500',
};

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

  // Persist + ⌘B / Ctrl+B toggle (ignored while typing).
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
  }, [collapsed]);
  useEffect(() => {
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify([...openGroups])); } catch {}
  }, [openGroups]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B') && !e.shiftKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        setCollapsed((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  // IA — Personal / Work / Admin.
  const sections: NavSection[] = useMemo(() => {
    const personal: NavNode[] = [
      { kind: 'leaf', label: 'Inbox',      hint: 'Everything that needs you',      href: '/inbox',      icon: Inbox,      tone: 'orange' },
      { kind: 'leaf', label: 'Scratchpad', hint: 'Personal notes + open tasks',    href: '/scratchpad', icon: StickyNote, tone: 'amber'  },
    ];

    const work: NavNode[] = [
      {
        kind: 'group', id: 'documents', label: 'Document Control', icon: Shield, tone: 'blue',
        hint: 'Libraries · checkouts · holds',
        children: [
          { kind: 'leaf', label: 'Libraries', hint: 'All controlled libraries',     href: '/documents',   icon: Library,       tone: 'blue'  },
          { kind: 'leaf', label: 'Checkouts', hint: 'Every active lock org-wide',   href: '/checkouts',   icon: Lock,          tone: 'amber' },
          { kind: 'leaf', label: 'Holds',     hint: 'Open hold queue',              href: '/admin/holds', icon: AlertOctagon,  tone: 'rose'  },
        ],
      },
      { kind: 'leaf', label: 'Projects', hint: 'Multi-doc work packages',         href: '/projects',     icon: Briefcase, tone: 'indigo' },
      {
        kind: 'leaf', label: 'Requests', hint: 'Drafting + work requests',        href: '/requests',     icon: MailPlus,  tone: 'orange',
        badge: actionRequiredCount > 0 ? actionRequiredCount : unreadCount,
        badgeTone: actionRequiredCount > 0 ? 'red' : (unreadCount > 0 ? 'blue' : undefined),
      },
      { kind: 'leaf', label: 'Assets',   hint: 'Tagged equipment registry',       href: '/admin/assets', icon: Tag,        tone: 'purple' },
      { kind: 'leaf', label: 'Activity', hint: "What's changing across the org",  href: '/activity',     icon: Activity,   tone: 'emerald' },
    ];

    const admin: NavNode[] = isAdmin ? [
      { kind: 'leaf', label: 'Users',             href: '/admin/users',       icon: Users,      tone: 'slate' },
      { kind: 'leaf', label: 'Library config',    href: '/admin/libraries',   icon: Settings,   tone: 'slate' },
      { kind: 'leaf', label: 'Request forms',     href: '/admin/requests',    icon: FileText,   tone: 'slate' },
      { kind: 'leaf', label: 'Permissions',       href: '/admin/permissions', icon: KeyRound,   tone: 'slate' },
      { kind: 'leaf', label: 'Operational scope', href: '/admin/scope',       icon: Factory,    tone: 'slate' },
      { kind: 'leaf', label: 'Analytics',         href: '/admin/analytics',   icon: BarChart3,  tone: 'slate' },
      { kind: 'leaf', label: 'Audit log',         href: '/admin/audit',       icon: ScrollText, tone: 'slate' },
      { kind: 'leaf', label: 'Data export',       href: '/admin/data-export', icon: Database,   tone: 'slate' },
      { kind: 'leaf', label: 'Workspace',         href: '/admin/settings',    icon: Settings,   tone: 'slate' },
    ] : [];

    return [
      { title: 'Personal', hint: 'Just for you',          items: personal },
      { title: 'Work',     hint: 'Day-to-day modules',    items: work     },
      ...(admin.length > 0 ? [{ title: 'Admin', hint: 'Org configuration', items: admin }] : []),
    ];
  }, [actionRequiredCount, unreadCount, isAdmin]);

  // Auto-expand a group when one of its children is the active route.
  useEffect(() => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      for (const s of sections) {
        for (const n of s.items) {
          if (n.kind === 'group' && n.children.some((c) => isPathActive(c.href))) next.add(n.id);
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

  // CRITICAL: h-full, not h-screen. Parent flex constrains us.
  return (
    <aside
      className={`${collapsed ? 'w-16' : 'w-64'} bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 h-full flex flex-col border-r border-slate-800 text-slate-300 transition-[width] duration-200 ease-out shrink-0 relative`}
    >
      {/* subtle highlight on the right edge so the sidebar feels embedded */}
      <div className="absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-orange-500/20 to-transparent pointer-events-none" />

      {/* BRAND */}
      <div className="h-16 flex items-center px-4 border-b border-slate-800 shrink-0 gap-3">
        <div className="w-9 h-9 bg-gradient-to-br from-orange-500 to-orange-700 rounded-xl flex items-center justify-center shadow-lg shadow-orange-900/40 ring-1 ring-orange-400/30 shrink-0">
          <LayoutDashboard className="w-5 h-5 text-white" />
        </div>
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <div className="font-black text-white tracking-tight text-base leading-none truncate">Manufacturing<span className="text-orange-500">OS</span></div>
            <div className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mt-1">Enterprise Platform</div>
          </div>
        )}
        <button
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Expand sidebar (⌘B)' : 'Collapse sidebar (⌘B)'}
          className="p-1 rounded-md text-slate-500 hover:text-white hover:bg-slate-800 shrink-0 transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* WORKSPACE SWITCHER */}
      {orgOptions.length > 0 && !collapsed && (
        <div className="px-3 pt-3 shrink-0">
          {orgOptions.length > 1 ? (
            <div className="bg-slate-800/40 rounded-lg border border-slate-800 px-3 py-2">
              <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1">Workspace</div>
              <select
                value={activeOrgId ?? ''}
                onChange={(e) => setActiveOrgId(e.target.value || null)}
                disabled={orgLoading}
                className="w-full bg-transparent text-sm font-bold text-white outline-none cursor-pointer truncate"
              >
                {orgOptions.map((org) => <option key={org.id} value={org.id} className="bg-slate-900">{org.name}</option>)}
              </select>
            </div>
          ) : (
            <div className="bg-slate-800/40 rounded-lg border border-slate-800 px-3 py-2">
              <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-0.5">Workspace</div>
              <div className="text-sm font-bold text-white truncate">{orgOptions[0].name}</div>
            </div>
          )}
        </div>
      )}

      {/* NAV — scrolls inside its own region. */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 custom-scrollbar min-h-0">
        {sections.map((section, sIdx) => (
          <div key={section.title} className={sIdx > 0 ? 'mt-4' : ''}>
            {!collapsed && (
              <div className="px-4 pb-1 flex items-baseline justify-between">
                <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.15em]">{section.title}</div>
                {section.hint && <div className="text-[9px] text-slate-600 italic truncate ml-2">{section.hint}</div>}
              </div>
            )}
            {collapsed && sIdx > 0 && (
              <div className="mx-3 mb-1 h-px bg-slate-800" aria-hidden />
            )}
            <div className="px-2 space-y-0.5">
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

      {/* USER FOOTER — pinned, shrink-0, always visible. */}
      <div className="shrink-0 border-t border-slate-800 bg-slate-950/80 backdrop-blur p-2">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5">
            <Link href="/profile" title={`${userEmail ?? 'Profile'} · ${activeRole ?? ''}`}
              className="w-10 h-10 rounded-xl bg-gradient-to-tr from-slate-700 to-slate-600 flex items-center justify-center text-sm font-bold text-white border border-slate-500 hover:border-orange-400 shadow-md transition-colors">
              {activeRole?.charAt(0) ?? 'U'}
            </Link>
            <button onClick={handleLogout} title="Sign out"
              className="w-10 h-10 inline-flex items-center justify-center text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-xl transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="bg-gradient-to-br from-slate-800/60 to-slate-900/60 hover:from-slate-800 hover:to-slate-900 rounded-xl border border-slate-800 hover:border-slate-700 p-2 transition-colors flex items-center gap-2">
            <Link href="/profile" className="flex items-center min-w-0 flex-1 group" title="Open profile">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-slate-700 to-slate-500 flex items-center justify-center text-sm font-black text-white border border-slate-500/50 shadow-md shrink-0 group-hover:border-orange-400/60 transition-colors">
                {activeRole?.charAt(0) ?? 'U'}
              </div>
              <div className="ml-2.5 overflow-hidden">
                <div className="text-xs font-bold text-white truncate group-hover:text-orange-200 transition-colors">{userEmail?.split('@')[0] ?? '—'}</div>
                <div className="text-[10px] text-orange-400/80 truncate font-mono uppercase tracking-widest font-bold">{activeOrgId ? (activeRole ?? '…') : 'No workspace'}</div>
              </div>
            </Link>
            <button
              onClick={handleLogout}
              className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors shrink-0"
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
    leaf.badgeTone === 'red'  ? 'bg-red-600 animate-pulse shadow-red-900/50' :
    leaf.badgeTone === 'blue' ? 'bg-blue-500 shadow-blue-900/50' :
                                'bg-orange-500 shadow-orange-900/50';
  return (
    <Link href={leaf.href}
      title={collapsed ? `${leaf.label}${leaf.hint ? ` — ${leaf.hint}` : ''}` : undefined}
      className={`relative flex items-center gap-2.5 rounded-lg transition-all ${
        collapsed ? 'h-11 justify-center' : `h-10 px-2.5 ${indent ? 'pl-8' : ''}`
      } ${
        active
          ? `${TONE_ACTIVE_BG[leaf.tone]} ring-1 text-white shadow-sm`
          : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
      }`}
    >
      {active && !collapsed && (
        <span className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-r ${TONE_BAR[leaf.tone]}`} aria-hidden />
      )}
      <Icon className={`w-[18px] h-[18px] shrink-0 ${active ? TONE_ICON[leaf.tone].replace('400', '300') : TONE_ICON[leaf.tone]}`} />
      {!collapsed && (
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold truncate leading-tight">{leaf.label}</div>
          {leaf.hint && (
            <div className={`text-[10px] truncate leading-tight mt-0.5 ${active ? 'text-white/60' : 'text-slate-500'}`}>{leaf.hint}</div>
          )}
        </div>
      )}
      {leaf.badge && leaf.badge > 0 && (
        <span className={`${collapsed ? 'absolute top-1 right-1' : ''} inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-white text-[10px] font-black shadow ${badgeTone}`}>
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
    return (
      <div className="relative group">
        <button
          title={group.label}
          className={`relative flex items-center justify-center w-full h-11 rounded-lg transition-all ${
            anyChildActive
              ? `${TONE_ACTIVE_BG[group.tone]} ring-1 text-white`
              : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
          }`}
        >
          <Icon className={`w-[18px] h-[18px] ${anyChildActive ? TONE_ICON[group.tone].replace('400', '300') : TONE_ICON[group.tone]}`} />
        </button>
        <div className="absolute left-full ml-2 top-0 hidden group-hover:block z-50 w-60 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl py-2">
          <div className="px-3 py-1.5 border-b border-slate-800 mb-1">
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{group.label}</div>
            {group.hint && <div className="text-[10px] text-slate-500 mt-0.5">{group.hint}</div>}
          </div>
          <div className="px-1.5 space-y-0.5">
            {group.children.map((c) => (
              <SidebarLeaf key={c.href} leaf={c} active={isPathActive(c.href)} collapsed={false} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onToggle}
        className={`w-full flex items-center gap-2.5 h-10 px-2.5 rounded-lg transition-colors ${
          anyChildActive ? 'text-white' : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
        }`}
      >
        <Icon className={`w-[18px] h-[18px] shrink-0 ${anyChildActive ? TONE_ICON[group.tone].replace('400', '300') : TONE_ICON[group.tone]}`} />
        <div className="flex-1 min-w-0 text-left">
          <div className="text-[13px] font-bold truncate leading-tight">{group.label}</div>
          {group.hint && (
            <div className={`text-[10px] truncate leading-tight mt-0.5 ${anyChildActive ? 'text-white/60' : 'text-slate-500'}`}>{group.hint}</div>
          )}
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? '' : '-rotate-90'}`} />
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
