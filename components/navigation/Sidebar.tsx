"use client";

// Sidebar — navigation rail.
//
// Design contract (matches the code — keep it that way):
//
//   * FLAT nav: two sections, Work and (for controllers) Admin. No nested
//     groups — every item is a single-click leaf. Alternate views of a tool
//     (Board / Locks / Packages / …) live behind the in-page ViewTabs
//     switcher, never as extra nav items. That consolidation is what keeps
//     this rail short; guard it.
//
//   * Tool highlighting is DERIVED from the same ViewTabs arrays the pages
//     use (TOOL_ALIASES below) — one source of truth, so adding a view tab
//     automatically keeps the sidebar highlight correct.
//
//   * Sections are collapsible (state persisted); the section holding the
//     current route always renders open so you can see where you are.
//     Admin starts closed.
//
//   * Rows are one line (icon + label). Hints are title tooltips.
//     Badges: red = action required, blue = unread FYI, absent = clear.
//     The header bell owns the org-wide total; rows badge only their own
//     section's count.
//
//   * Collapsible to a 64px icon rail via ⌘B / Ctrl+B (persisted). On
//     mobile the rail is an off-canvas drawer that closes on navigation
//     and Escape.
//
//   * The footer avatar is the USER (photo, or initials from their display
//     name — see components/ui/UserAvatar), never a role letter.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase, setPreferMicrosoft } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { useOrgBranding } from '@/components/providers/OrgBrandingProvider';
import {
  LayoutDashboard, Settings, Users, LogOut, FileText,
  BarChart3, Briefcase, KeyRound, Tag, Factory, Gauge,
  StickyNote, ScrollText, Activity, MailPlus, BookOpen,
  ChevronLeft, ChevronRight, ChevronDown,
  FolderKanban, ShieldCheck, UsersRound, FileStack, Palette,
  Plus, Pencil, X,
} from 'lucide-react';
import { useTicketNotifications } from '@/hooks/useTicketNotifications';
import { useNotificationCenter } from '@/components/notifications/NotificationCenter';
import { useIsMobile } from '@/hooks/useIsMobile';
import LogoUploadModal from '@/components/branding/LogoUploadModal';
import UserAvatar from '@/components/ui/UserAvatar';
import {
  DOCUMENT_VIEWS, EQUIPMENT_VIEWS, HOME_VIEWS, ACTIVITY_VIEWS,
} from '@/components/navigation/ViewTabs';

// A consolidated tool stays highlighted on any of its views. DERIVED from
// the ViewTabs arrays so the two surfaces can never drift again (a new view
// tab automatically highlights its tool here).
const viewHrefs = (views: Array<{ href: string }>, exclude: string) =>
  views.map((v) => v.href).filter((h) => h !== exclude);
const TOOL_ALIASES: Record<string, string[]> = {
  '/dashboard':    viewHrefs(HOME_VIEWS, '/dashboard'),
  '/documents':    viewHrefs(DOCUMENT_VIEWS, '/documents'),
  '/admin/assets': viewHrefs(EQUIPMENT_VIEWS, '/admin/assets'),
  '/activity':     viewHrefs(ACTIVITY_VIEWS, '/activity'),
};

const COLLAPSED_KEY  = 'mfg-os.sidebar.collapsed';
const SECTIONS_KEY   = 'mfg-os.sidebar.closedSections';

type Tone = 'orange' | 'blue' | 'indigo' | 'amber' | 'emerald' | 'violet' | 'rose' | 'slate' | 'purple' | 'cyan';
type IconType = React.ComponentType<{ className?: string; style?: React.CSSProperties }>;

interface NavLeaf {
  label: string;
  hint?: string;
  href: string;
  icon: IconType;
  tone: Tone;
  badge?: number;
  badgeTone?: 'orange' | 'red' | 'blue';
}
interface NavSection {
  id: string;
  title: string;
  hint?: string;
  icon: IconType;
  /** Section's dominant tone — used for the header accent + active dot. */
  tone: Tone;
  items: NavLeaf[];
}

const TONE_ICON: Record<Tone, string> = {
  orange:  'text-orange-500',
  blue:    'text-blue-500',
  indigo:  'text-indigo-500',
  amber:   'text-amber-500',
  emerald: 'text-emerald-500',
  violet:  'text-violet-500',
  rose:    'text-rose-500',
  slate:   'text-slate-500',
  purple:  'text-purple-500',
  cyan:    'text-cyan-500',
};
// Accent-driven active state, theme-aware: the accent token reads on both the
// light and dark sidebar surfaces, and the bg tint is a soft accent wash.
const ACCENT_ICON_STYLE: React.CSSProperties = { color: 'var(--color-accent)' };
const ACTIVE_BG_STYLE: React.CSSProperties = { backgroundColor: 'color-mix(in srgb, var(--color-accent) 14%, transparent)' };
const ACTIVE_BAR_STYLE: React.CSSProperties = { backgroundColor: 'var(--color-accent)' };

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
  const { sectionCounts } = useTicketNotifications();
  // A nav item badges ONLY its own section's items — red when something there
  // needs action, blue for unread FYI, nothing when clear. (The header bell
  // owns the org-wide total; the rail doesn't duplicate it.)
  const badgeOf = useCallback((s: { total: number; actionRequired: number }): { badge?: number; badgeTone?: 'red' | 'blue' } => {
    if (s.total <= 0) return {};
    return { badge: s.total, badgeTone: s.actionRequired > 0 ? 'red' : 'blue' };
  }, []);
  const { logoUrl, branding, canEdit: canEditBranding } = useOrgBranding();
  const [logoModalOpen, setLogoModalOpen] = useState(false);
  const isMobile = useIsMobile();

  // `railCollapsed` is the persisted DESKTOP icon-rail preference. The
  // effective `collapsed` used throughout render is forced off on mobile so
  // the off-canvas drawer always shows the full-label nav.
  const [railCollapsed, setRailCollapsed] = useState(false);
  const collapsed = railCollapsed && !isMobile;
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
      const s = localStorage.getItem(SECTIONS_KEY);
      if (s) setClosedSections(new Set(JSON.parse(s) as string[]));
    } catch {}
  }, []);

  useEffect(() => { try { localStorage.setItem(COLLAPSED_KEY, railCollapsed ? '1' : '0'); } catch {} }, [railCollapsed]);
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
    // Consolidated tools: each entry is ONE tool whose alternate views live
    // behind the in-page ViewTabs switcher (see TOOL_ALIASES above).
    const workAll: NavLeaf[] = [
      {
        label: 'Home', hint: 'Your dashboard + live coordination', href: '/dashboard', icon: LayoutDashboard, tone: 'orange',
      },
      { label: 'Documents',   hint: 'Libraries · board · locks · packages · blocked', href: '/documents',    icon: FileStack, tone: 'blue', ...badgeOf(sectionCounts.documents)   },
      { label: 'Equipment',   hint: 'Asset registry · plot-plan map',                  href: '/admin/assets', icon: Tag,       tone: 'purple' },
      { label: 'Projects',    hint: 'Project workspaces & milestones',                         href: '/projects',     icon: Briefcase, tone: 'indigo', ...badgeOf(sectionCounts.projects) },
      {
        label: 'Drafting Requests', hint: 'Drafting & design request portal', href: '/requests', icon: MailPlus, tone: 'orange',
        ...badgeOf(sectionCounts.requests),
      },
      { label: 'Knowledge',   hint: 'AI-searchable standards & reference libraries',   href: '/knowledge',    icon: BookOpen, tone: 'cyan' },
      { label: 'Activity',    hint: 'History + audit log',                             href: '/activity',     icon: Activity, tone: 'emerald' },
      // Personal scratchpad lives with the day-to-day items — a whole
      // section for one link was more chrome than content.
      { label: 'Scratchpad',  hint: 'Personal notes + open tasks',                     href: '/scratchpad',   icon: StickyNote, tone: 'amber', ...badgeOf(sectionCounts.scratchpad) },
    ];
    // Viewers/Contractors hold few or no capabilities — showing them the
    // full workbench (Projects, Equipment admin, Activity) invites clicks
    // that end in "no actions available". Same gating pattern the Admin
    // section already uses.
    // Projects stays in the reduced set: contracted engineers submit
    // revisions and check review status through a project's Intake tab.
    const work: NavLeaf[] =
      activeRole === 'Viewer' || activeRole === 'Contractor'
        ? workAll.filter((item) => ['Home', 'Documents', 'Drafting Requests', 'Projects', 'Scratchpad'].includes(item.label))
        : workAll;

    const admin: NavLeaf[] = isAdmin ? [
      { label: 'Users',             href: '/admin/users',       icon: Users,      tone: 'blue'    },
      { label: 'Teams',             href: '/admin/teams',       icon: UsersRound, tone: 'cyan'    },
      { label: 'Library config',    href: '/admin/libraries',   icon: Settings,   tone: 'indigo'  },
      { label: 'Request forms',     href: '/admin/requests',    icon: FileText,   tone: 'orange'  },
      { label: 'Permissions',       href: '/admin/permissions', icon: KeyRound,   tone: 'amber'   },
      { label: 'Operational scope', href: '/admin/scope',       icon: Factory,    tone: 'emerald' },
      { label: 'Analytics',         href: '/admin/analytics',   icon: BarChart3,  tone: 'violet'  },
      { label: 'Audit log',         href: '/admin/audit',       icon: ScrollText, tone: 'rose'    },
      { label: 'Storage & Backup',  href: '/admin/storage',     icon: Gauge,      tone: 'amber'   },
      { label: 'Branding',          href: '/admin/branding',    icon: Palette,    tone: 'violet'  },
      { label: 'Workspace settings', href: '/admin/settings',   icon: Settings,   tone: 'slate'   },
    ] : [];

    return [
      { id: 'work', title: 'Work', hint: 'Day-to-day modules', icon: FolderKanban, tone: 'blue', items: work },
      ...(admin.length > 0 ? [{ id: 'admin', title: 'Admin', hint: 'Org configuration', icon: ShieldCheck as IconType, tone: 'slate' as Tone, items: admin }] : []),
    ];
  }, [sectionCounts, badgeOf, isAdmin, activeRole]);

  // Per-section "does any item match the current route?"
  const sectionIsActive = useCallback(
    (s: NavSection): boolean => s.items.some((n) => isPathActive(n.href)),
    [isPathActive],
  );

  const toggleSection = (id: string) => {
    setClosedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleLogout = async () => {
    setPreferMicrosoft(false);
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
        className={`${collapsed ? 'w-16' : 'w-64'} bg-gradient-to-b from-[var(--color-surface)] to-[var(--color-surface-2)] h-full flex flex-col border-r border-[var(--color-border)] text-[var(--color-text-muted)] shrink-0 md:shadow-[10px_0_30px_-22px_rgba(2,6,23,0.35)]
          fixed inset-y-0 left-0 z-[70] md:relative md:inset-auto md:z-auto
          transition-[transform,width] duration-200 ease-out
          ${mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'} md:translate-x-0`}
      >
        {/* Warm brand seam down the trailing edge — a quiet accent that ties
            the rail to the brand in either theme. */}
        <div className="absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-[var(--color-accent)]/20 to-transparent pointer-events-none" />

      {/* BRAND */}
      <div className={`h-16 flex items-center border-b border-[var(--color-border)] shrink-0 ${collapsed ? 'justify-center px-2' : 'px-4 gap-3'}`}>
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
            <span className="absolute -right-1 -bottom-1 w-4 h-4 rounded-full bg-orange-500 ring-2 ring-[var(--color-surface)] flex items-center justify-center">
              <ChevronRight className="w-2.5 h-2.5 text-white" />
            </span>
          </button>
        ) : (
          <>
            <div className="w-9 h-9 bg-gradient-to-br from-orange-500 to-orange-700 rounded-xl flex items-center justify-center shadow-lg shadow-orange-900/40 ring-1 ring-orange-400/30 shrink-0">
              <LayoutDashboard className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-black text-[var(--color-text)] tracking-tight text-base leading-none truncate">Manufacturing<span className="text-orange-500">OS</span></div>
              <div className="text-[9px] text-[var(--color-text-faint)] font-bold uppercase tracking-widest mt-1">Enterprise Platform</div>
            </div>
            <button
              onClick={() => (isMobile ? onMobileClose?.() : setRailCollapsed((v) => !v))}
              title={isMobile ? 'Close menu' : 'Collapse (⌘B)'}
              aria-label={isMobile ? 'Close menu' : 'Collapse sidebar'}
              className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] bg-[var(--color-surface-2)] hover:bg-[var(--color-border)] shrink-0 transition-colors"
            >
              {isMobile ? <X className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </button>
          </>
        )}
      </div>

      {/* WORKSPACE SWITCHER — the logo stands in for the org name once set. */}
      {orgOptions.length > 0 && !collapsed && (
        <div className="px-3 pt-3 shrink-0">
          <div className="relative bg-[var(--color-surface-2)] rounded-lg border border-[var(--color-border)] px-3 py-2">
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="text-[9px] font-bold text-[var(--color-text-faint)] uppercase tracking-widest">Workspace</div>
              {canEditBranding && (
                <button
                  onClick={() => setLogoModalOpen(true)}
                  title={logoUrl ? 'Change workspace logo' : 'Add a workspace logo'}
                  className="shrink-0 w-5 h-5 grid place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)] transition-colors"
                >
                  {logoUrl ? <Pencil className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                </button>
              )}
            </div>

            {logoUrl ? (
              <div className="py-1.5 flex items-center justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element -- org logo is a signed storage URL */}
                <img src={logoUrl} alt="Organization logo" className={`${branding?.logoShape === 'full' ? 'max-h-12' : 'max-h-14'} w-auto max-w-full object-contain`} draggable={false} />
              </div>
            ) : orgOptions.length === 1 ? (
              <div className="text-sm font-bold text-[var(--color-text)] truncate">{orgOptions[0].name}</div>
            ) : null}

            {orgOptions.length > 1 && (
              <select
                value={activeOrgId ?? ''}
                onChange={(e) => setActiveOrgId(e.target.value || null)}
                disabled={orgLoading}
                className={`w-full bg-transparent text-[var(--color-text)] outline-none cursor-pointer truncate ${logoUrl ? 'mt-1.5 text-[11px] font-semibold text-[var(--color-text-muted)]' : 'text-sm font-bold'}`}
              >
                {orgOptions.map((org) => <option key={org.id} value={org.id} className="bg-[var(--color-surface)] text-[var(--color-text)]">{org.name}</option>)}
              </select>
            )}
          </div>
        </div>
      )}

      {logoModalOpen && <LogoUploadModal onClose={() => setLogoModalOpen(false)} />}

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
                  {section.items.map((leaf) => (
                    <SidebarLeaf
                      key={leaf.href}
                      leaf={leaf}
                      active={isPathActive(leaf.href)}
                      collapsed={collapsed}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* USER FOOTER — the person, not the role. */}
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] p-2">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5">
            <Link href="/profile" title={`${userEmail ?? 'Profile'} · ${activeRole ?? ''}`} className="hover:opacity-90 transition-opacity">
              <UserAvatar uid={uid} email={userEmail} size={40} rounded="xl" />
            </Link>
            <button onClick={handleLogout} title="Sign out"
              className="w-10 h-10 inline-flex items-center justify-center text-[var(--color-text-muted)] hover:text-red-500 hover:bg-[var(--color-surface-2)] rounded-xl transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="bg-[var(--color-surface-2)] hover:bg-[var(--color-border)] rounded-xl border border-[var(--color-border)] hover:border-[var(--color-border-strong)] p-2 transition-colors flex items-center gap-2">
            <Link href="/profile" className="flex items-center min-w-0 flex-1 group" title="Open profile">
              <UserAvatar uid={uid} email={userEmail} size={36} rounded="lg" />
              <div className="ml-2.5 overflow-hidden">
                <div className="text-xs font-bold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">{userEmail?.split('@')[0] ?? '—'}</div>
                <div className="text-[10px] text-[var(--color-accent)] truncate font-mono uppercase tracking-widest font-bold">{activeOrgId ? (activeRole ?? '…') : 'No workspace'}</div>
              </div>
            </Link>
            <button
              onClick={handleLogout}
              className="p-2 text-[var(--color-text-muted)] hover:text-red-500 hover:bg-[var(--color-surface-2)] rounded-lg transition-colors shrink-0"
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
      className="group/sec w-full flex items-center gap-2 px-1.5 h-7 rounded-md hover:bg-[var(--color-surface-2)] transition-colors select-none"
    >
      <Icon className={`w-3.5 h-3.5 shrink-0 ${TONE_ICON[section.tone]}`} />
      <span className={`text-[10px] font-black uppercase tracking-[0.16em] truncate ${active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>
        {section.title}
      </span>
      <span className="flex-1 h-px bg-[var(--color-border)] group-hover/sec:bg-[var(--color-border-strong)] transition-colors" aria-hidden />
      <ChevronDown className={`w-3.5 h-3.5 text-[var(--color-text-faint)] group-hover/sec:text-[var(--color-text-muted)] transition-all ${open ? '' : '-rotate-90'}`} />
    </button>
  );
}

function SectionDivider({ tone, active }: { tone: Tone; active: boolean }) {
  return (
    <div className="px-3 my-1.5 flex items-center" aria-hidden>
      <div className={`h-px flex-1 ${active ? `bg-gradient-to-r from-transparent via-current to-transparent ${TONE_ICON[tone]}/40` : 'bg-[var(--color-border)]'}`} />
    </div>
  );
}

// ─── Leaf row ────────────────────────────────────────────────

function SidebarLeaf({
  leaf, active, collapsed,
}: {
  leaf: NavLeaf;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = leaf.icon;
  const { open: openCenter } = useNotificationCenter();
  const badgeTone =
    leaf.badgeTone === 'red'  ? 'bg-red-600 animate-pulse shadow-red-900/50' :
    leaf.badgeTone === 'blue' ? 'bg-blue-500 shadow-blue-900/50' :
                                'bg-orange-500 shadow-orange-900/50';
  return (
    <Link href={leaf.href}
      title={collapsed ? `${leaf.label}${leaf.hint ? ` — ${leaf.hint}` : ''}` : (leaf.hint ?? leaf.label)}
      style={active ? ACTIVE_BG_STYLE : undefined}
      className={`relative flex items-center gap-2.5 rounded-lg transition-colors ${
        collapsed ? 'h-10 justify-center' : 'h-9 px-2.5'
      } ${
        active
          ? 'text-[var(--color-accent)] font-semibold'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'
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
        // The count is a DOORWAY, not a scoreboard: clicking it opens the
        // Notification Center showing exactly the items it counts (a red
        // badge opens pre-filtered to action-required). The row itself
        // still navigates to its tool.
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); openCenter(leaf.badgeTone === 'red' ? 'action' : 'all'); }}
          title="See these notifications"
          className={`${collapsed ? 'absolute top-1 right-1' : ''} inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-white text-[10px] font-black shadow cursor-pointer hover:scale-110 hover:ring-2 hover:ring-white/40 transition-transform ${badgeTone}`}
        >
          {leaf.badge > 99 ? '99+' : leaf.badge}
        </button>
      )}
    </Link>
  );
}
