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
//     Badges: red = waiting on your decision, a quiet count = unread news,
//     absent = clear.
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
  BarChart3, Briefcase, KeyRound, Factory, Gauge,
  ScrollText, Activity, MailPlus, BookMarked, FileOutput,
  ChevronLeft, ChevronRight, ChevronDown,
  FolderKanban, ShieldCheck, UsersRound, FileStack, Palette,
  Plus, Pencil, X, Bot, CreditCard, DatabaseBackup, ArchiveRestore, Compass,
  HardHat,
} from 'lucide-react';
import { useTicketNotifications } from '@/hooks/useTicketNotifications';
import { useNotificationCenter } from '@/components/notifications/NotificationCenter';
import { useIsMobile } from '@/hooks/useIsMobile';
import LogoUploadModal from '@/components/branding/LogoUploadModal';
import UserAvatar from '@/components/ui/UserAvatar';
import { badgeText } from '@/lib/badge';
import { onTransitionClick } from '@/lib/viewTransition';
import {
  DOCUMENT_VIEWS, EQUIPMENT_VIEWS, HOME_VIEWS, ACTIVITY_VIEWS, INTELLIGENCE_VIEWS,
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
  '/assistant':    viewHrefs(INTELLIGENCE_VIEWS, '/assistant'),
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
  orange:  'text-[var(--color-text-muted)]',
  blue:    'text-[var(--color-text-muted)]',
  indigo:  'text-[var(--color-text-muted)]',
  amber:   'text-[var(--color-text-muted)]',
  emerald: 'text-[var(--color-text-muted)]',
  violet:  'text-[var(--color-text-muted)]',
  rose:    'text-[var(--color-text-muted)]',
  slate:   'text-[var(--color-text-muted)]',
  purple:  'text-[var(--color-text-muted)]',
  cyan:    'text-[var(--color-text-muted)]',
};

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
  // A nav item badges ONLY its own section's items: a red count of what
  // waits on a decision, else a quiet count of unread news, nothing when
  // clear. (The header bell owns the org-wide total; the rail doesn't
  // duplicate it.)
  const badgeOf = useCallback((s: { total: number; actionRequired: number }): { badge?: number; badgeTone?: 'red' | 'blue' } => {
    if (s.total <= 0) return {};
    return s.actionRequired > 0
      ? { badge: s.actionRequired, badgeTone: 'red' }
      : { badge: s.total, badgeTone: 'blue' };
  }, []);
  const { logoUrl, canEdit: canEditBranding } = useOrgBranding();
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
      { label: 'Operating areas', hint: 'Equipment registry by unit · plot-plan map',  href: '/admin/assets', icon: Factory,   tone: 'purple' },
      { label: 'Projects',    hint: 'Project workspaces & milestones',                         href: '/projects',     icon: Briefcase, tone: 'indigo', ...badgeOf(sectionCounts.projects) },
      { label: 'Companies',   hint: 'Known contractors & vendors - scored on evidence',        href: '/companies',    icon: HardHat,   tone: 'amber' },
      {
        label: 'Drafting Requests', hint: 'Drafting & design request portal', href: '/requests', icon: MailPlus, tone: 'orange',
        ...badgeOf(sectionCounts.requests),
      },
      { label: 'Intelligence', hint: 'Ask the AI: your documents, the system, the web', href: '/assistant', icon: Bot, tone: 'violet' },
      { label: 'Output Docs', hint: 'Generate scopes & letters from templates + data', href: '/output-templates', icon: FileOutput, tone: 'orange' },
      { label: 'Activity',    hint: 'History + audit log',                             href: '/activity',     icon: Activity, tone: 'emerald' },
    ];
    // Viewers/Contractors hold few or no capabilities — showing them the
    // full workbench (Projects, Equipment admin, Activity) invites clicks
    // that end in "no actions available". Same gating pattern the Admin
    // section already uses.
    // Projects stays in the reduced set: contracted engineers submit
    // revisions and check review status through a project's Intake tab.
    const work: NavLeaf[] =
      activeRole === 'Viewer' || activeRole === 'Contractor'
        ? workAll.filter((item) => ['Home', 'Documents', 'Drafting Requests', 'Projects'].includes(item.label))
        : workAll;

    const admin: NavLeaf[] = isAdmin ? [
      { label: 'Facility setup',    href: '/setup',             icon: Compass,    tone: 'violet'  },
      { label: 'Users',             href: '/admin/users',       icon: Users,      tone: 'blue'    },
      { label: 'Teams',             href: '/admin/teams',       icon: UsersRound, tone: 'cyan'    },
      { label: 'Library config',    href: '/admin/libraries',   icon: Settings,   tone: 'indigo'  },
      { label: 'Request forms',     href: '/admin/requests',    icon: FileText,   tone: 'orange'  },
      { label: 'Permissions',       href: '/admin/permissions', icon: KeyRound,   tone: 'amber'   },
      { label: 'Operational scope', href: '/admin/scope',       icon: Factory,    tone: 'emerald' },
      { label: 'Site codebook',     href: '/admin/codebook',    icon: BookMarked, tone: 'violet'  },
      { label: 'Analytics',         href: '/admin/analytics',   icon: BarChart3,  tone: 'violet'  },
      { label: 'Audit log',         href: '/admin/audit',       icon: ScrollText, tone: 'rose'    },
      { label: 'Storage & Backup',  href: '/admin/storage',     icon: Gauge,      tone: 'amber'   },
      { label: 'Data export',       href: '/admin/data-export', icon: DatabaseBackup, tone: 'cyan' },
      { label: 'Restore',           href: '/admin/restore',     icon: ArchiveRestore, tone: 'rose' },
      { label: 'Billing',           href: '/admin/billing',     icon: CreditCard, tone: 'emerald' },
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
          className="fixed inset-0 z-[60] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] md:hidden"
          onClick={onMobileClose}
          aria-hidden
        />
      )}
      <aside
        aria-hidden={isMobile && !mobileOpen}
        className={`${collapsed ? 'w-16' : 'w-64'} vt-side surface-side h-full flex flex-col text-[var(--color-text-muted)] shrink-0 fixed inset-y-0 left-0 z-[70] md:relative md:inset-auto md:z-auto transition-[transform,width] duration-200 ease-out bg-[var(--color-canvas)] shadow-[inset_-1px_0_0_var(--color-border)] ${mobileOpen ? 'translate-x-0 ui-float' : '-translate-x-full'} md:translate-x-0`}
      >

      {/* BRAND */}
      <div className={`h-16 flex items-center border-b border-[var(--color-border)] shrink-0 ${collapsed ? 'justify-center px-2' : 'px-4 gap-3'}`}>
        {collapsed ? (
          <button
            onClick={() => setRailCollapsed(false)}
            title="Expand sidebar (⌘B)"
            aria-label="Expand sidebar"
            className="group relative w-10 h-10 rounded-lg flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
          >
            <ChevronRight className="ui-chevron w-5 h-5 group-hover:translate-x-0.5" />
          </button>
        ) : (
          <>
            {logoUrl ? (
              // The workspace's own logo is the header. On the graphite menu
              // it sits on a white plate so a dark logo still reads.
              <div className="flex-1 min-w-0 h-11 flex items-center">
                <span className="max-w-full h-full inline-flex items-center rounded-md px-2 -ml-2" style={{ background: 'var(--side-logo-plate, transparent)' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- org logo is a signed storage URL */}
                  <img src={logoUrl} alt="Workspace logo" className="max-h-10 w-auto max-w-full object-contain" draggable={false} />
                </span>
              </div>
            ) : (
              // No logo uploaded yet: the product's name (it has no mark).
              <div className="flex-1 min-w-0 font-display text-[18px] font-semibold text-[var(--color-text)] leading-none truncate">Manufacturing OS</div>
            )}
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

      {/* WORKSPACE: switch between workspaces; an admin can set the logo. */}
      {orgOptions.length > 0 && !collapsed && (orgOptions.length > 1 || !logoUrl || canEditBranding) && (
        <div className="px-3 pt-3 shrink-0">
          <div className="flex items-center gap-2 h-9 px-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
            {orgOptions.length > 1 ? (
              <select
                value={activeOrgId ?? ''}
                onChange={(e) => setActiveOrgId(e.target.value || null)}
                disabled={orgLoading}
                aria-label="Workspace"
                className="flex-1 min-w-0 bg-transparent text-[14px] font-semibold text-[var(--color-text)] outline-none cursor-pointer truncate"
              >
                {orgOptions.map((org) => <option key={org.id} value={org.id} className="bg-[var(--color-surface)] text-[var(--color-text)]">{org.name}</option>)}
              </select>
            ) : (
              <span className="flex-1 min-w-0 text-[14px] font-semibold text-[var(--color-text)] truncate">{orgOptions[0].name}</span>
            )}
            {canEditBranding && (
              <button
                onClick={() => setLogoModalOpen(true)}
                title={logoUrl ? 'Change workspace logo' : 'Add a workspace logo'}
                aria-label={logoUrl ? 'Change workspace logo' : 'Add a workspace logo'}
                className="shrink-0 w-6 h-6 grid place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
              >
                {logoUrl ? <Pencil className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
              </button>
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
                <SectionDivider />
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
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-canvas)] p-2">
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
          <div className="rounded-md hover:bg-[var(--color-surface)] p-1.5 transition-colors flex items-center gap-2">
            <Link href="/profile" className="flex items-center min-w-0 flex-1 group" title="Open profile">
              <UserAvatar uid={uid} email={userEmail} size={36} rounded="lg" />
              <div className="ml-2.5 overflow-hidden">
                <div className="text-[14px] font-semibold text-[var(--color-text)] truncate">{userEmail?.split('@')[0] ?? '-'}</div>
                <div className="text-[13px] text-[var(--color-text-muted)] truncate">{activeOrgId ? (activeRole ?? '…') : 'No workspace'}</div>
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

// ─── Section header: a small label with a chevron that turns ─────

function SectionHeader({
  section, open, active, onToggle,
}: {
  section: NavSection;
  open: boolean;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={section.hint ?? section.title}
      aria-expanded={open}
      className="group/sec w-full flex items-center gap-1.5 px-2.5 h-7 rounded-md hover:bg-[var(--color-surface-2)] transition-colors select-none"
    >
      <span className={`text-[12px] font-semibold truncate ${active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-faint)]'}`}>
        {section.title}
      </span>
      <ChevronDown aria-hidden className={`ui-chevron w-3.5 h-3.5 text-[var(--color-text-faint)] group-hover/sec:text-[var(--color-text-muted)] ${open ? '' : '-rotate-90'}`} />
    </button>
  );
}

function SectionDivider() {
  return (
    <div className="px-3 my-2 flex items-center" aria-hidden>
      <div className="h-px flex-1 bg-[var(--color-border)]" />
    </div>
  );
}

// ─── Leaf row ────────────────────────────────────────────────
// The current item takes the page's color and runs into the content edge
// (nav-joined in globals.css), with a short brand marker on its left: the
// menu points at the page. A red count is something waiting on you; in
// the narrow rail it becomes a dot on the icon's corner.

function SidebarLeaf({
  leaf, active, collapsed,
}: {
  leaf: NavLeaf;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = leaf.icon;
  const router = useRouter();
  const { open: openCenter } = useNotificationCenter();
  const urgent = leaf.badgeTone === 'red';
  const hasBadge = !!leaf.badge && leaf.badge > 0;
  const badgeWords = urgent ? `${leaf.badge} waiting on you` : `${leaf.badge} new`;
  return (
    <Link href={leaf.href}
      title={collapsed ? `${leaf.label}${hasBadge ? ` (${badgeWords})` : ''}` : (leaf.hint ?? leaf.label)}
      aria-label={collapsed ? `${leaf.label}${hasBadge ? `, ${badgeWords}` : ''}` : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={active ? undefined : (e) => onTransitionClick(e, () => router.push(leaf.href))}
      style={active ? { color: 'var(--side-current-text, var(--color-text))' } : undefined}
      className={`relative flex items-center gap-2.5 transition-colors ${
        collapsed ? 'h-10 justify-center' : 'h-9 px-2.5'
      } ${
        active
          ? 'nav-joined -mr-2 rounded-l-lg font-semibold'
          : 'rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'
      }`}
    >
      {active && <span aria-hidden className="absolute left-1 top-2 bottom-2 w-[3px] rounded-full bg-[var(--color-current)]" />}
      <span className="relative shrink-0 inline-flex">
        <Icon className={`w-[17px] h-[17px] ${active ? '' : TONE_ICON[leaf.tone]}`} />
        {collapsed && hasBadge && (
          <span aria-hidden className={`absolute -top-1 -right-1 ui-dot ${urgent ? '' : 'is-quiet'} ring-2 ring-[var(--side-bg,#081d48)]`} />
        )}
      </span>
      {!collapsed && (
        <span className="text-[15px] truncate flex-1 leading-none">{leaf.label}</span>
      )}
      {!collapsed && hasBadge && (
        // The count is a doorway, not a scoreboard: clicking it opens the
        // Notification Center showing exactly the items it counts (a red
        // count opens filtered to what waits on you). The row itself
        // still goes to its tool. Unread news is plain figures, not a
        // badge: only what needs a decision is badged.
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); openCenter(urgent ? 'action' : 'all'); }}
          title={badgeWords}
          aria-label={`${leaf.label}: ${badgeWords}`}
          className={urgent
            ? 'ui-badge cursor-pointer hover:brightness-110'
            : 'min-w-5 h-5 px-1 rounded text-[12px] tabular-nums text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer'}
        >
          {badgeText(leaf.badge!)}
        </button>
      )}
    </Link>
  );
}
