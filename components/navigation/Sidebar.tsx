"use client";

// Sidebar — navigation rail.
//
// Design contract:
//
//   * Three top-level sections (Personal / Work / Admin) are each
//     COLLAPSIBLE. They start closed. The section containing the
//     current route auto-opens so the user never has to dig blind.
//     Open state is persisted to localStorage.
//
//   * Inside Work, Document Control is its own nested group with
//     its own caret. Two-level hierarchy max.
//
//   * Brand color per leaf icon. Active row uses a tinted gradient
//     background in the row's tone with a left bar.
//
//   * Rows are a single line (icon + label, ~36px). Hints live as
//     title tooltips, not as a subtitle that takes up real estate.
//     This is what kept things tall before.
//
//   * Section headers are cards with their own icon, name, count
//     pill, and chevron. Active section gets a dot indicator.
//
//   * Pinned footer that physically cannot clip — the sidebar
//     itself is h-full inside its flex parent so it never exceeds
//     its slot.
//
//   * Collapsible to 64px icon-rail via ⌘B / Ctrl+B. In icon mode
//     sections don't collapse — every icon stays visible — and
//     groups become hover-flyouts.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { useOrgBranding } from '@/components/providers/OrgBrandingProvider';
import {
  LayoutDashboard, Settings, Users, LogOut, FileText,
  BarChart3, Briefcase, KeyRound, Tag, Factory,
  StickyNote, ScrollText, Activity, MailPlus,
  ChevronLeft, ChevronRight, ChevronDown, Database,
  FolderKanban, ShieldCheck, UsersRound, FileStack, Palette,
  Inbox as InboxIcon,
} from 'lucide-react';
import { useTicketNotifications } from '@/hooks/useTicketNotifications';
import { useIsMobile } from '@/hooks/useIsMobile';
import { X } from 'lucide-react';

// A consolidated tool stays highlighted on any of its views/modes. Map each
// tool's nav href to the extra routes that belong to the same tool.
const TOOL_ALIASES: Record<string, string[]> = {
  '/inbox':        ['/coordination'],                                // Home: My Inbox / Coordination
  '/documents':    ['/control-tower', '/checkouts', '/admin/holds', '/transmittals'], // Documents: Table / Board / Locks / Blocked / Issued
  '/admin/assets': ['/plot-plans'],                                  // Equipment: Table / Map
  '/activity':     ['/admin/audit'],                                 // Activity: Activity / Audit
};

const COLLAPSED_KEY  = 'mfg-os.sidebar.collapsed';
const GROUPS_KEY     = 'mfg-os.sidebar.openGroups';
const SECTIONS_KEY   = 'mfg-os.sidebar.closedSections';

type Tone = 'orange' | 'blue' | 'indigo' | 'amber' | 'emerald' | 'violet' | 'rose' | 'slate' | 'purple' | 'cyan';
type IconType = React.ComponentType<{ className?: string; style?: React.CSSProperties }>;

interface NavLeaf {
  kind: 'leaf';
  label: string;
  hint?: string;
  href: string;
  icon: IconType;
  tone: Tone;
  badge?: number;
  badgeTone?: 'orange' | 'red' | 'blue';
}
interface NavGroup {
  kind: 'group';
  id: string;
  label: string;
  hint?: string;
  icon: IconType;
  tone: Tone;
  children: NavLeaf[];
}
type NavNode = NavLeaf | NavGroup;
interface NavSection {
  id: string;
  title: string;
  hint?: string;
  icon: IconType;
  /** Section's dominant tone — used for the header card accent + the
   *  active-section dot. */
  tone: Tone;
  items: NavNode[];
}

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
// Modern, cohesive accent-driven active state (follows the workspace
// palette via --color-accent). Light-mixed so it reads on the dark rail
// regardless of how dark the chosen accent is.
const ACCENT_ICON_STYLE: React.CSSProperties = { color: 'color-mix(in srgb, var(--color-accent) 62%, white)' };
const ACTIVE_BG_STYLE: React.CSSProperties = { backgroundColor: 'color-mix(in srgb, var(--color-accent) 20%, transparent)' };
const ACTIVE_BAR_STYLE: React.CSSProperties = { backgroundColor: 'color-mix(in srgb, var(--color-accent) 65%, white)' };

export default function Sidebar({
  mobileOpen = false,
  onMobileClose,
}: {
  /** Whether the off-canvas drawer is open (mobile only). */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
} = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const { activeRole, userEmail, activeOrgId, setActiveOrgId, uid } = useRole();
  const { count, actionRequiredCount } = useTicketNotifications();
  const { logoUrl, branding } = useOrgBranding();
  const isMobile = useIsMobile();

  // `railCollapsed` is the persisted DESKTOP icon-rail preference. The
  // effective `collapsed` used throughout render is forced off on mobile so
  // the off-canvas drawer always shows the full-label nav.
  const [railCollapsed, setRailCollapsed] = useState(false);
  const collapsed = railCollapsed && !isMobile;
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  // Sections are collapsible. We track which are CLOSED (so the default —
  // empty set — leaves them open, except Admin which we close by default).
  const [closedSections, setClosedSections] = useState<Set<string>>(new Set(['admin']));
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
  const [orgLoading, setOrgLoading] = useState(false);

  // Hydrate persisted prefs.
  useEffect(() => {
    try {
      const c = localStorage.getItem(COLLAPSED_KEY);
      if (c === '1') setRailCollapsed(true);
      const g = localStorage.getItem(GROUPS_KEY);
      // Document Control is expanded by default on first visit so its
      // contents are discoverable; respects the user's choice afterward.
      if (g) setOpenGroups(new Set(JSON.parse(g) as string[]));
      else setOpenGroups(new Set(['docctrl']));
      const s = localStorage.getItem(SECTIONS_KEY);
      if (s) setClosedSections(new Set(JSON.parse(s) as string[]));
    } catch {}
  }, []);

  useEffect(() => { try { localStorage.setItem(COLLAPSED_KEY, railCollapsed ? '1' : '0'); } catch {} }, [railCollapsed]);
  useEffect(() => { try { localStorage.setItem(GROUPS_KEY, JSON.stringify([...openGroups])); } catch {} }, [openGroups]);
  useEffect(() => { try { localStorage.setItem(SECTIONS_KEY, JSON.stringify([...closedSections])); } catch {} }, [closedSections]);

  // ⌘B toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B') && !e.shiftKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        setRailCollapsed((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close the off-canvas drawer whenever the route changes (so tapping a nav
  // link on mobile dismisses it) and on Escape. onMobileClose is memoized by
  // the layout, so listing it as a dep is safe.
  useEffect(() => { onMobileClose?.(); }, [pathname, onMobileClose]);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onMobileClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onMobileClose]);

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
            .filter((m) => m.orgs).map((m) => ({ id: m.orgs!.id, name: m.orgs!.name }));
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
    const hit = (p: string) =>
      p === '/documents'
        ? (pathname === '/documents' || pathname.startsWith('/documents/'))
        : (pathname === p || pathname.startsWith(p + '/'));
    if (hit(path)) return true;
    const aliases = TOOL_ALIASES[path];
    return aliases ? aliases.some(hit) : false;
  }, [pathname]);

  const sections: NavSection[] = useMemo(() => {
    // Scratchpad sectioned off on its own at the bottom; Inbox moved to
    // the top bar next to the notification bell.
    const tools: NavNode[] = [
      { kind: 'leaf', label: 'Scratchpad', hint: 'Personal notes + open tasks',   href: '/scratchpad', icon: StickyNote, tone: 'amber'  },
    ];

    // Work — Document Control is a nested group again: the controlled-
    // document surfaces (Libraries, Checkouts, Holds) live under it.
    // Consolidated tools: each entry is ONE tool whose alternate views/modes
    // live behind an in-page view switcher (ViewTabs), not separate nav items.
    //   Home      → My Inbox / Coordination
    //   Documents → Table (Libraries) / Board (Control Tower) / Locks (Checkouts) / Blocked (Holds)
    //   Equipment → Table (Asset registry) / Map (Plot plans)
    //   Activity  → Activity / Audit log
    const work: NavNode[] = [
      {
        kind: 'leaf', label: 'Home', hint: 'Your inbox + live coordination', href: '/inbox', icon: InboxIcon, tone: 'orange',
      },
      { kind: 'leaf', label: 'Documents',   hint: 'Libraries · board · locks · blocked', href: '/documents',    icon: FileStack, tone: 'blue'   },
      { kind: 'leaf', label: 'Equipment',   hint: 'Asset registry · plot-plan map',       href: '/admin/assets', icon: Tag,       tone: 'purple' },
      { kind: 'leaf', label: 'Projects',    hint: 'Multi-doc work packages',              href: '/projects',     icon: Briefcase, tone: 'indigo' },
      {
        kind: 'leaf', label: 'Drafting Requests', hint: 'Drafting & design request portal', href: '/requests', icon: MailPlus, tone: 'orange',
        badge: count,
        badgeTone: actionRequiredCount > 0 ? 'red' : (count > 0 ? 'blue' : undefined),
      },
      { kind: 'leaf', label: 'Activity',     hint: 'History + audit log',                    href: '/activity',     icon: Activity, tone: 'emerald' },
    ];

    const admin: NavNode[] = isAdmin ? [
      { kind: 'leaf', label: 'Users',             href: '/admin/users',       icon: Users,      tone: 'blue'    },
      { kind: 'leaf', label: 'Teams',             href: '/admin/teams',       icon: UsersRound, tone: 'cyan'    },
      { kind: 'leaf', label: 'Library config',    href: '/admin/libraries',   icon: Settings,   tone: 'indigo'  },
      { kind: 'leaf', label: 'Request forms',     href: '/admin/requests',    icon: FileText,   tone: 'orange'  },
      { kind: 'leaf', label: 'Permissions',       href: '/admin/permissions', icon: KeyRound,   tone: 'amber'   },
      { kind: 'leaf', label: 'Operational scope', href: '/admin/scope',       icon: Factory,    tone: 'emerald' },
      { kind: 'leaf', label: 'Analytics',         href: '/admin/analytics',   icon: BarChart3,  tone: 'violet'  },
      { kind: 'leaf', label: 'Audit log',         href: '/admin/audit',       icon: ScrollText, tone: 'rose'    },
      { kind: 'leaf', label: 'Data export',       href: '/admin/data-export', icon: Database,   tone: 'cyan'    },
      { kind: 'leaf', label: 'Branding',          href: '/admin/branding',    icon: Palette,    tone: 'violet'  },
      { kind: 'leaf', label: 'Workspace settings', href: '/admin/settings',   icon: Settings,   tone: 'slate'   },
    ] : [];

    // Order: Work (day-to-day) → Tools (personal) → Admin (config, last).
    return [
      { id: 'work',  title: 'Work',  hint: 'Day-to-day modules', icon: FolderKanban, tone: 'blue',  items: work  },
      { id: 'tools', title: 'Tools', hint: 'Personal',           icon: StickyNote,   tone: 'amber', items: tools },
      ...(admin.length > 0 ? [{ id: 'admin', title: 'Admin', hint: 'Org configuration', icon: ShieldCheck as IconType, tone: 'slate' as Tone, items: admin }] : []),
    ];
  }, [count, actionRequiredCount, isAdmin]);

  // Per-section "does any descendant match the current route?"
  const sectionIsActive = useCallback((s: NavSection): boolean => {
    for (const n of s.items) {
      if (n.kind === 'leaf' && isPathActive(n.href)) return true;
      if (n.kind === 'group' && n.children.some((c) => isPathActive(c.href))) return true;
    }
    return false;
  }, [isPathActive]);

  // Auto-open any nested group containing the current route. (Sections
  // themselves no longer collapse — they're always-visible labels.)
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
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSection = (id: string) => {
    setClosedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/');
  };

  return (
    <>
      {/* Off-canvas backdrop (mobile only). */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-[60] bg-slate-950/60 backdrop-blur-sm md:hidden"
          onClick={onMobileClose}
          aria-hidden
        />
      )}
      <aside
        aria-hidden={isMobile && !mobileOpen}
        className={`${collapsed ? 'w-16' : 'w-64'} bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 h-full flex flex-col border-r border-slate-800 text-slate-300 shrink-0
          fixed inset-y-0 left-0 z-[70] md:relative md:inset-auto md:z-auto
          transition-[transform,width] duration-200 ease-out
          ${mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'} md:translate-x-0`}
      >
        <div className="absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-orange-500/20 to-transparent pointer-events-none" />

      {/* BRAND */}
      <div className={`h-16 flex items-center border-b border-slate-800 shrink-0 ${collapsed ? 'justify-center px-2' : 'px-4 gap-3'}`}>
        {collapsed ? (
          <button
            onClick={() => setRailCollapsed(false)}
            title="Expand sidebar (⌘B)"
            aria-label="Expand sidebar"
            className="group relative w-10 h-10 bg-gradient-to-br from-orange-500 to-orange-700 rounded-xl flex items-center justify-center shadow-lg shadow-orange-900/40 ring-1 ring-orange-400/30"
          >
            <LayoutDashboard className="w-5 h-5 text-white transition-opacity group-hover:opacity-0" />
            <ChevronRight className="w-5 h-5 text-white absolute opacity-0 transition-opacity group-hover:opacity-100" />
            {/* always-visible expand affordance */}
            <span className="absolute -right-1 -bottom-1 w-4 h-4 rounded-full bg-orange-500 ring-2 ring-slate-950 flex items-center justify-center">
              <ChevronRight className="w-2.5 h-2.5 text-white" />
            </span>
          </button>
        ) : (
          <>
            <div className="w-9 h-9 bg-gradient-to-br from-orange-500 to-orange-700 rounded-xl flex items-center justify-center shadow-lg shadow-orange-900/40 ring-1 ring-orange-400/30 shrink-0">
              <LayoutDashboard className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-black text-white tracking-tight text-base leading-none truncate">Manufacturing<span className="text-orange-500">OS</span></div>
              <div className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mt-1">Enterprise Platform</div>
            </div>
            <button
              onClick={() => (isMobile ? onMobileClose?.() : setRailCollapsed((v) => !v))}
              title={isMobile ? 'Close menu' : 'Collapse (⌘B)'}
              aria-label={isMobile ? 'Close menu' : 'Collapse sidebar'}
              className="p-1.5 rounded-md text-slate-300 hover:text-white bg-slate-800/60 hover:bg-slate-700 shrink-0 transition-colors"
            >
              {isMobile ? <X className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </button>
          </>
        )}
      </div>

      {/* WORKSPACE SWITCHER */}
      {orgOptions.length > 0 && !collapsed && (
        <div className="px-3 pt-3 shrink-0">
          {logoUrl && (
            <div className="mb-2 rounded-lg bg-white/[0.04] border border-slate-800 p-2.5 flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- org logo is a signed storage URL */}
              <img src={logoUrl} alt="Organization logo" className={`${branding?.logoShape === 'full' ? 'max-h-9 w-full' : 'max-h-10'} object-contain`} draggable={false} />
            </div>
          )}
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

      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 custom-scrollbar min-h-0">
        {sections.map((section) => {
          const isHot = sectionIsActive(section);
          // Open when not explicitly closed, or when it holds the active
          // route (so you always see where you are).
          const open = isHot || !closedSections.has(section.id);
          return (
            <div key={section.id} className={collapsed ? 'mb-1' : 'mb-3 px-2'}>
              {collapsed ? (
                <SectionDivider tone={section.tone} active={isHot} />
              ) : (
                <SectionHeader section={section} open={open} active={isHot} onToggle={() => toggleSection(section.id)} />
              )}
              {(collapsed || open) && (
                <div className={collapsed ? 'px-2 space-y-0.5' : 'mt-1 space-y-0.5'}>
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
              )}
            </div>
          );
        })}
      </nav>

      {/* USER FOOTER */}
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
    </>
  );
}

// ─── Section header — the dominant chrome between leaves ─────

function SectionHeader({
  section, open, active, onToggle,
}: {
  section: NavSection;
  open: boolean;
  active: boolean;
  onToggle: () => void;
}) {
  const Icon = section.icon;
  return (
    <button
      onClick={onToggle}
      title={section.hint ?? section.title}
      className="group/sec w-full flex items-center gap-2 px-1.5 h-7 rounded-md hover:bg-white/[0.04] transition-colors select-none"
    >
      <Icon className={`w-3.5 h-3.5 shrink-0 ${TONE_ICON[section.tone]}`} />
      <span className={`text-[10px] font-black uppercase tracking-[0.16em] truncate ${active ? 'text-slate-200' : 'text-slate-400'}`}>
        {section.title}
      </span>
      <span className="flex-1 h-px bg-slate-800/80 group-hover/sec:bg-slate-700/80 transition-colors" aria-hidden />
      <ChevronDown className={`w-3.5 h-3.5 text-slate-500 group-hover/sec:text-slate-300 transition-all ${open ? '' : '-rotate-90'}`} />
    </button>
  );
}

function SectionDivider({ tone, active }: { tone: Tone; active: boolean }) {
  return (
    <div className="px-3 my-1.5 flex items-center" aria-hidden>
      <div className={`h-px flex-1 ${active ? `bg-gradient-to-r from-transparent via-current to-transparent ${TONE_ICON[tone]}/40` : 'bg-slate-800'}`} />
    </div>
  );
}

// ─── Leaf row ────────────────────────────────────────────────

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
      title={collapsed ? `${leaf.label}${leaf.hint ? ` — ${leaf.hint}` : ''}` : (leaf.hint ?? leaf.label)}
      style={active ? ACTIVE_BG_STYLE : undefined}
      className={`relative flex items-center gap-2.5 rounded-lg transition-colors ${
        collapsed ? 'h-10 justify-center' : `h-9 px-2.5 ${indent ? 'pl-3' : ''}`
      } ${
        active
          ? 'text-white font-semibold'
          : 'text-slate-300 hover:bg-white/[0.05] hover:text-white'
      }`}
    >
      {active && !collapsed && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r" style={ACTIVE_BAR_STYLE} aria-hidden />
      )}
      <Icon className={`w-[17px] h-[17px] shrink-0 ${active ? '' : TONE_ICON[leaf.tone]}`} style={active ? ACCENT_ICON_STYLE : undefined} />
      {!collapsed && (
        <span className="text-[13px] truncate flex-1 leading-none">{leaf.label}</span>
      )}
      {leaf.badge && leaf.badge > 0 && (
        <span className={`${collapsed ? 'absolute top-1 right-1' : ''} inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-white text-[10px] font-black shadow ${badgeTone}`}>
          {leaf.badge > 99 ? '99+' : leaf.badge}
        </span>
      )}
    </Link>
  );
}

// ─── Nested group (Document Control) ────────────────────────

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
          style={anyChildActive ? ACTIVE_BG_STYLE : undefined}
          className={`relative flex items-center justify-center w-full h-10 rounded-lg transition-colors ${
            anyChildActive ? 'text-white' : 'text-slate-300 hover:bg-white/[0.05] hover:text-white'
          }`}
        >
          <Icon className={`w-[17px] h-[17px] ${anyChildActive ? '' : TONE_ICON[group.tone]}`} style={anyChildActive ? ACCENT_ICON_STYLE : undefined} />
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
        className={`w-full flex items-center gap-2.5 h-9 px-2.5 rounded-lg transition-colors ${
          anyChildActive ? 'text-white' : 'text-slate-300 hover:bg-white/[0.05] hover:text-white'
        }`}
      >
        <Icon className={`w-[17px] h-[17px] shrink-0 ${anyChildActive ? '' : TONE_ICON[group.tone]}`} style={anyChildActive ? ACCENT_ICON_STYLE : undefined} />
        <span className="text-[13px] font-semibold truncate flex-1 text-left leading-none">{group.label}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="mt-0.5 ml-[19px] pl-2 border-l border-slate-800 space-y-0.5">
          {group.children.map((c) => (
            <SidebarLeaf key={c.href} leaf={c} active={isPathActive(c.href)} collapsed={false} indent />
          ))}
        </div>
      )}
    </div>
  );
}
