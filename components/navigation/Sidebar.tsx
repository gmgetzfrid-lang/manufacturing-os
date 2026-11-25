"use client";

// Sidebar - the side menu.
//
// Design contract (matches the code; keep it that way):
//
//   * The daily tools in sight, four of them (docs/design-rules.md A6):
//     Home, Documents, Projects, Drafting requests. The other tools sit
//     under More, one tap away; More opens by itself while one of them is
//     the page, and remembers being left open. Alternate views of a tool
//     live behind the in-page ViewTabs, never as extra items.
//
//   * Tool highlighting is DERIVED from the same ViewTabs arrays the pages
//     use (TOOL_ALIASES below), so a new view tab keeps the highlight right.
//
//   * The current item's tab is one shape that slides to the item and runs
//     into the page edge (nav-joined in globals.css).
//
//   * Under the tools, only when there is something: "Checked out to you"
//     (others wait on those, with when each is due) and "Jump back in"
//     (starred documents first, then what was opened last). No empty
//     headings (B7).
//
//   * Badges: red = waiting on your decision, a quiet count = unread news,
//     absent = clear. The header bell owns the org-wide total.
//
//   * Admin is a separate fold, closed until wanted. In the 64 px rail
//     (Cmd+B / Ctrl+B, remembered) More and Admin are one menu each. On a
//     phone the menu is a drawer that closes on navigation and Escape.
//
//   * The footer avatar is the USER (photo, or initials), never a role.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AppMark } from '@/components/brand/AppMark';
import { usePathname, useRouter } from 'next/navigation';
import { supabase, setPreferMicrosoft } from '@/lib/supabase';
import { signOutHere } from '@/lib/membershipClient';
import { useRole } from '@/components/providers/RoleContext';
import { useOrgBranding } from '@/components/providers/OrgBrandingProvider';
import {
  LayoutDashboard, Settings, Users, LogOut, FileText,
  BarChart3, Briefcase, KeyRound, Factory, Gauge,
  ScrollText, Activity, MailPlus, BookMarked, FileOutput,
  ChevronLeft, ChevronRight, ChevronDown,
  FolderKanban, ShieldCheck, UsersRound, FileStack, Palette,
  Check, Image as ImageIcon, X, Bot, CreditCard, DatabaseBackup, ArchiveRestore, Compass,
  HardHat, Lock, Star,
} from 'lucide-react';
import { useTicketNotifications } from '@/hooks/useTicketNotifications';
import { useNotificationCenter } from '@/components/notifications/NotificationCenter';
import { useIsMobile } from '@/hooks/useIsMobile';
import LogoUploadModal from '@/components/branding/LogoUploadModal';
import UserAvatar from '@/components/ui/UserAvatar';
import MoreMenu, { type MoreItem } from '@/components/ui/MoreMenu';
import { useSideUtility } from '@/lib/sideUtility';
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
const MORE_KEY       = 'mfg-os.sidebar.moreOpen';

// The tools in sight: what most people open every day (docs/design-rules.md
// A6, three to five). The rest sit under More, one tap away.
const DAILY = new Set(['/dashboard', '/documents', '/projects', '/requests']);

// A row in the lists under the tools: one step quieter than a tool (14 px,
// muted), the same height and icon column, 44 px on touch.
const SIDE_ROW = 'flex items-center gap-2.5 h-9 pointer-coarse:h-11 px-2.5 rounded-lg text-body text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] transition-colors';

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
  /** Space above it: the first item of a new group. */
  startsGroup?: boolean;
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
  const [moreOpen, setMoreOpen] = useState(false);

  // Hydrate persisted prefs.
  useEffect(() => {
    try {
      const c = localStorage.getItem(COLLAPSED_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- this device's own choice, read once after mount
      if (c === '1') setRailCollapsed(true);
      const s = localStorage.getItem(SECTIONS_KEY);
      if (s) setClosedSections(new Set(JSON.parse(s) as string[]));
      if (localStorage.getItem(MORE_KEY) === '1') setMoreOpen(true);
    } catch {}
  }, []);

  useEffect(() => { try { localStorage.setItem(COLLAPSED_KEY, railCollapsed ? '1' : '0'); } catch {} }, [railCollapsed]);
  useEffect(() => { try { localStorage.setItem(SECTIONS_KEY, JSON.stringify([...closedSections])); } catch {} }, [closedSections]);
  useEffect(() => { try { localStorage.setItem(MORE_KEY, moreOpen ? '1' : '0'); } catch {} }, [moreOpen]);

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
    };
    void load();
    return () => { alive = false; };
  }, [uid]);

  const orgOptions = useMemo(() => orgs.slice().sort((a, b) => a.name.localeCompare(b.name)), [orgs]);
  const orgName = orgOptions.find((o) => o.id === activeOrgId)?.name ?? null;
  // Under the tools: what this person holds, and where they left off.
  const side = useSideUtility(activeOrgId, uid);
  const isAdmin = activeRole === 'Admin' || activeRole === 'DocCtrl';

  // The workspace menu: switch workspace, the logo, settings (only what this
  // person can do; empty = the header is just the face).
  const workspaceItems: MoreItem[] = [
    ...(orgOptions.length > 1 ? orgOptions.map((o) => ({
      icon: o.id === activeOrgId ? <Check aria-hidden className="w-4 h-4" /> : <span aria-hidden className="w-4 h-4" />,
      label: o.name, current: o.id === activeOrgId,
      onClick: () => { if (o.id !== activeOrgId) setActiveOrgId(o.id); },
    })) : []),
    ...(canEditBranding ? [{ icon: <ImageIcon aria-hidden className="w-4 h-4" />, label: logoUrl ? 'Change logo' : 'Add your logo', line: orgOptions.length > 1, onClick: () => setLogoModalOpen(true) }] : []),
    ...(isAdmin ? [{ icon: <Settings aria-hidden className="w-4 h-4" />, label: 'Workspace settings', line: orgOptions.length > 1 && !canEditBranding, onClick: () => router.push('/admin/settings') }] : []),
  ];

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
      // Three groups split by space, not labels (docs/design-rules.md B3):
      // the daily work, the plant, and the tools.
      { label: 'Documents',   hint: 'Libraries · board · locks · packages · blocked', href: '/documents',    icon: FileStack, tone: 'blue', ...badgeOf(sectionCounts.documents)   },
      { label: 'Projects',    hint: 'Project workspaces & milestones',                         href: '/projects',     icon: Briefcase, tone: 'indigo', ...badgeOf(sectionCounts.projects) },
      {
        label: 'Drafting requests', hint: 'Drafting & design request portal', href: '/requests', icon: MailPlus, tone: 'orange',
        ...badgeOf(sectionCounts.requests),
      },
      { label: 'Operating areas', hint: 'Equipment registry by unit · plot-plan map',  href: '/admin/assets', icon: Factory,   tone: 'purple', startsGroup: true },
      { label: 'Companies',   hint: 'Known contractors & vendors - scored on evidence',        href: '/companies',    icon: HardHat,   tone: 'amber' },
      { label: 'Intelligence', hint: 'Ask the AI: your documents, the system, the web', href: '/assistant', icon: Bot, tone: 'violet', startsGroup: true },
      { label: 'Output docs', hint: 'Generate scopes & letters from templates + data', href: '/output-templates', icon: FileOutput, tone: 'orange' },
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
        ? workAll.filter((item) => ['Home', 'Documents', 'Drafting requests', 'Projects'].includes(item.label)).map((item) => ({ ...item, startsGroup: false }))
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

  const workItems = sections.find((x) => x.id === 'work')?.items ?? [];
  const daily = workItems.filter((leaf) => DAILY.has(leaf.href));
  const more = workItems.filter((leaf) => !DAILY.has(leaf.href));
  // More opens by itself while one of its tools is the page.
  const moreHot = more.some((leaf) => isPathActive(leaf.href));
  const moreShown = moreOpen || moreHot;
  const adminItems = sections.find((x) => x.id === 'admin')?.items ?? [];
  const adminHot = adminItems.some((leaf) => isPathActive(leaf.href));
  const adminShown = adminHot || !closedSections.has('admin');

  // The current item's tab: one shape behind the list that slides to the
  // current item (and its text takes the page's color). Set on the element
  // itself, not through state: no extra render, nothing to flash.
  const navBox = useRef<HTMLDivElement | null>(null);
  const tabEl = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const box = navBox.current;
    const tab = tabEl.current;
    if (!box || !tab) return;
    const place = () => {
      const cur = box.querySelector<HTMLElement>('a[data-navleaf][aria-current="page"]');
      if (!cur) { tab.style.opacity = '0'; return; }
      const y = cur.getBoundingClientRect().top - box.getBoundingClientRect().top;
      tab.style.transform = `translateY(${Math.round(y)}px)`;
      tab.style.height = `${cur.offsetHeight}px`;
      tab.style.opacity = '1';
    };
    place();
    // Glide only after it has a place (the first paint just shows it there).
    const raf = requestAnimationFrame(() => tab.classList.add('is-ready'));
    // The list above it can change height (More opening, a list loading).
    const ro = new ResizeObserver(place);
    ro.observe(box);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [pathname, collapsed, moreShown, adminShown, side]);

  const toggleSection = (id: string) => {
    setClosedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleLogout = async () => {
    setPreferMicrosoft(false);
    // This device is signed out at once, even when the server is busy
    // (plant PCs are shared); everywhere else follows when it answers.
    await signOutHere();
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
        className={`${collapsed ? 'w-16' : 'w-64'} vt-side surface-side h-full flex flex-col text-[var(--color-text-muted)] shrink-0 fixed inset-y-0 left-0 z-[70] md:relative md:inset-auto md:z-[35] transition-[transform,width] duration-200 ease-out bg-[var(--color-canvas)] shadow-[inset_-1px_0_0_var(--color-border)] ${mobileOpen ? 'translate-x-0 ui-float' : '-translate-x-full'} md:translate-x-0`}
      >

      {/* THE WORKSPACE: one block. The logo (or the initials and name) is
          the button for everything about the workspace: switch to another,
          change the logo, its settings. Its arrow sits inside it, so nothing
          floats beside it. Collapse (or close, on a phone) is a small round
          button on the menu's edge, apart from the brand. */}
      <button
        type="button"
        onClick={() => (isMobile ? onMobileClose?.() : setRailCollapsed((v) => !v))}
        title={isMobile ? 'Close menu' : collapsed ? 'Expand (⌘B)' : 'Collapse (⌘B)'}
        aria-label={isMobile ? 'Close menu' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="ui-hit absolute z-[75] top-7 -right-3.5 w-7 h-7 inline-flex items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-canvas)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] shadow-[var(--shadow-control)] transition-colors"
      >
        {isMobile ? <X className="w-3.5 h-3.5" /> : collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
      </button>
      <div className={`shrink-0 ${collapsed ? 'px-2 pt-4 pb-3 flex justify-center' : 'px-3 pt-4 pb-3'}`}>
        {collapsed ? (
          // The rail: the workspace's initials (a wordmark is too wide here).
          workspaceItems.length > 0 ? (
            <MoreMenu items={workspaceItems} label={`Workspace: ${orgName ?? 'Manufacturing OS'}. Switch, logo and settings`}
              triggerClass="w-10 h-10 inline-flex items-center justify-center rounded-lg hover:bg-[var(--color-surface)] transition-colors"
              trigger={orgName ? <OrgInitials name={orgName} /> : <AppMark size={28} ring />} />
          ) : (orgName ? <OrgInitials name={orgName} /> : <AppMark size={28} ring />)
        ) : workspaceItems.length > 0 ? (
          <MoreMenu items={workspaceItems} label={`Workspace: ${orgName ?? 'Manufacturing OS'}. Switch, logo and settings`} boxClass="w-full"
            triggerClass="group w-full text-left rounded-xl"
            trigger={<WorkspaceCard logoUrl={logoUrl} name={orgName} menu />} />
        ) : (
          <WorkspaceCard logoUrl={logoUrl} name={orgName} />
        )}
      </div>
      {/* A short line between the brand and the menu, inset like the menu. */}
      <div aria-hidden className={`shrink-0 h-px bg-[var(--color-border)] ${collapsed ? 'mx-3' : 'mx-5'}`} />

      {logoModalOpen && <LogoUploadModal onClose={() => setLogoModalOpen(false)} />}

      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 custom-scrollbar min-h-0">
        {/* Everything in the menu sits in one positioned box, so the current
            item's tab can slide from item to item (docs/design-rules.md,
            ideas: a sliding current-item marker). */}
        <div ref={navBox} className="relative">
          <div ref={tabEl} aria-hidden style={{ opacity: 0 }}
            className="nav-joined !absolute left-2 right-0 top-0 rounded-l-lg pointer-events-none [&.is-ready]:transition-[transform,height] [&.is-ready]:duration-200 [&.is-ready]:ease-out motion-reduce:!transition-none">
            <span className="absolute left-1 top-2 bottom-2 w-[3px] rounded-full bg-[var(--color-current)]" />
          </div>

          {/* The daily tools, in sight (docs/design-rules.md A6: three to five). */}
          <div className="px-2 space-y-0.5">
            {daily.map((leaf) => (
              <SidebarLeaf key={leaf.href} leaf={leaf} active={isPathActive(leaf.href)} collapsed={collapsed} />
            ))}
          </div>

          {/* The rest, one tap away; open by itself while one of them is the page. */}
          {more.length > 0 && (collapsed ? (
            <div className="px-2 mt-1 space-y-0.5">
              {more.filter((leaf) => isPathActive(leaf.href)).map((leaf) => (
                <SidebarLeaf key={leaf.href} leaf={leaf} active collapsed />
              ))}
              <div className="flex justify-center">
                <MoreMenu label="More tools" iconOnly
                  triggerClass="w-10 h-10 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] transition-colors"
                  items={more.map((leaf) => ({ icon: <leaf.icon className="w-4 h-4" />, label: leaf.label, current: isPathActive(leaf.href), onClick: () => router.push(leaf.href) }))} />
              </div>
            </div>
          ) : (
            <div className="px-2 mt-0.5">
              <button type="button" onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreShown}
                className="w-full flex items-center gap-2.5 h-9 pointer-coarse:h-11 px-2.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] transition-colors">
                <ChevronDown aria-hidden className={`ui-chevron w-[17px] h-[17px] ${moreShown ? '' : '-rotate-90'}`} />
                <span className="text-reading leading-none">More</span>
              </button>
              {moreShown && (
                <div className="mt-0.5 space-y-0.5">
                  {more.map((leaf) => (
                    <SidebarLeaf key={leaf.href} leaf={leaf} active={isPathActive(leaf.href)} collapsed={false} />
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* What this person holds, and where they left off: plain rows
              like the tools above (no box), each list only when it has
              something (B7). */}
          {!collapsed && side && side.held.length > 0 && (
            <div className="px-2 mt-6">
              <div className="px-2.5 mb-1 flex items-baseline gap-1.5 text-caption font-medium text-[var(--color-text-muted)]">
                Checked out to you <span className="tabular-nums">{side.held.length}</span>
              </div>
              <ul className="space-y-0.5">
                {side.held.slice(0, 3).map((h) => {
                  const due = dueWords(h.dueAt);
                  return (
                    <li key={h.documentId}>
                      <Link href={h.libraryId ? `/documents/${h.libraryId}?doc=${h.documentId}` : `/documents?doc=${h.documentId}`} title={`${h.label}${due ? `, ${due.words.toLowerCase()}` : ''}`}
                        className={SIDE_ROW}>
                        <Lock aria-hidden className="shrink-0 w-4 h-4" />
                        <span className="ui-id truncate flex-1 min-w-0 !text-[color:inherit]">{h.label}</span>
                        {due && (
                          <span className={`shrink-0 inline-flex items-center gap-1.5 text-caption ${due.late ? 'text-[var(--color-text)] font-medium' : ''}`}>
                            {due.late && <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-[var(--state-overdue)]" />}{due.words}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
                {side.held.length > 3 && (
                  <li><Link href="/checkouts" className={SIDE_ROW}><span aria-hidden className="w-4 shrink-0" /><span className="text-caption font-medium">All {side.held.length}</span></Link></li>
                )}
              </ul>
            </div>
          )}
          {!collapsed && side && side.jump.length > 0 && (
            <div className="px-2 mt-6">
              <div className="px-2.5 mb-1 text-caption font-medium text-[var(--color-text-muted)]">Jump back in</div>
              <ul className="space-y-0.5">
                {side.jump.map((j) => {
                  const here = j.kind === 'project' ? (pathname?.startsWith(`/projects/${j.id}`) ?? false) : false;
                  const KindIcon = j.starred ? Star : j.kind === 'project' ? Briefcase : FileText;
                  // The title, without the number it already starts with.
                  const rest = j.code && j.title.startsWith(j.code) ? j.title.slice(j.code.length).trim() : j.title;
                  return (
                    <li key={`${j.kind}:${j.id}`}>
                      <Link href={j.href} aria-current={here ? 'page' : undefined} title={j.code && rest ? `${j.code}, ${rest}` : j.title}
                        className={`${SIDE_ROW} ${here ? '!text-[var(--color-text)] bg-[var(--color-surface)]' : ''}`}>
                        <KindIcon aria-hidden className={`shrink-0 w-4 h-4 ${j.starred ? 'fill-current' : ''}`} />
                        {j.starred && <span className="sr-only">Starred: </span>}
                        {j.code && <span className="ui-id truncate min-w-0 max-w-[60%] shrink-0 !text-[color:inherit]">{j.code}</span>}
                        {rest && <span className="truncate min-w-0 flex-1">{rest}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Admin: a different place, kept closed until wanted. In the rail,
              one menu instead of a dozen icons. */}
          {adminItems.length > 0 && (collapsed ? (
            <div className="px-2 mt-4 space-y-0.5">
              {adminItems.filter((leaf) => isPathActive(leaf.href)).map((leaf) => (
                <SidebarLeaf key={leaf.href} leaf={leaf} active collapsed />
              ))}
              <div className="flex justify-center">
                <MoreMenu label="Admin" iconOnly
                  triggerClass="w-10 h-10 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] transition-colors"
                  trigger={<ShieldCheck aria-hidden className="w-[17px] h-[17px]" />}
                  items={adminItems.map((leaf) => ({ icon: <leaf.icon className="w-4 h-4" />, label: leaf.label, current: isPathActive(leaf.href), onClick: () => router.push(leaf.href) }))} />
              </div>
            </div>
          ) : (
            <div className="px-2 mt-6">
              <SectionHeader section={{ id: 'admin', title: 'Admin', hint: 'Org configuration', icon: ShieldCheck, tone: 'slate', items: adminItems }} open={adminShown} active={adminHot} onToggle={() => toggleSection('admin')} />
              {adminShown && (
                <div className="mt-1 space-y-0.5">
                  {adminItems.map((leaf) => (
                    <SidebarLeaf key={leaf.href} leaf={leaf} active={isPathActive(leaf.href)} collapsed={false} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </nav>

      {/* USER FOOTER — the person, not the role. */}
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-canvas)] p-2">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5">
            <Link href="/profile" title={`${userEmail ?? 'Profile'} · ${activeRole ?? ''}`} className="ui-hit hover:opacity-90 transition-opacity">
              <UserAvatar uid={uid} email={userEmail} size={40} rounded="xl" />
            </Link>
            <button onClick={handleLogout} title="Sign out"
              className="w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)] hover:bg-[var(--color-surface-2)] rounded-xl transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="rounded-md hover:bg-[var(--color-surface)] p-1.5 transition-colors flex items-center gap-2">
            <Link href="/profile" className="flex items-center min-w-0 flex-1 group pointer-coarse:min-h-11" title="Open profile">
              <UserAvatar uid={uid} email={userEmail} size={36} rounded="lg" />
              <div className="ml-2.5 overflow-hidden">
                <div className="text-body font-medium text-[var(--color-text)] truncate">{userEmail?.split('@')[0] ?? '-'}</div>
                <div className="text-caption text-[var(--color-text-muted)] truncate">{activeOrgId ? (activeRole ?? '…') : 'No workspace'}</div>
              </div>
            </Link>
            <button
              onClick={handleLogout}
              aria-label="Sign out"
              className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)] hover:bg-[var(--color-surface-2)] rounded-lg transition-colors shrink-0"
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
      className="group/sec w-full flex items-center gap-1.5 px-2.5 h-8 rounded-md hover:bg-[var(--color-surface-2)] transition-colors select-none"
    >
      <span className={`text-caption font-medium truncate ${active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-faint)]'}`}>
        {section.title}
      </span>
      <ChevronDown aria-hidden className={`ui-chevron w-3.5 h-3.5 text-[var(--color-text-faint)] group-hover/sec:text-[var(--color-text-muted)] ${open ? '' : '-rotate-90'}`} />
    </button>
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
      data-navleaf=""
      style={active ? { color: 'var(--side-current-text, var(--color-text))' } : undefined}
      // The current item's tab is drawn once behind the list and slides to it
      // (Sidebar's navBox); the item itself only takes its text color.
      className={`relative z-[1] flex items-center gap-2.5 transition-colors ${
        collapsed ? 'h-10 pointer-coarse:h-11 justify-center' : 'h-9 pointer-coarse:h-11 px-2.5'
      } ${
        active
          ? 'rounded-l-lg font-medium'
          : 'rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'
      }`}
    >
      <span className="relative shrink-0 inline-flex">
        <Icon className={`w-[17px] h-[17px] ${active ? '' : TONE_ICON[leaf.tone]}`} />
        {collapsed && hasBadge && (
          <span aria-hidden className={`absolute -top-1 -right-1 ui-dot ${urgent ? '' : 'is-quiet'} ring-2 ring-[var(--side-bg,#081d48)]`} />
        )}
      </span>
      {!collapsed && (
        <span className="text-reading truncate flex-1 leading-none">{leaf.label}</span>
      )}
      {!collapsed && hasBadge && (
        // The count is a doorway, not a scoreboard: clicking it opens the
        // Notification Center showing exactly the items it counts (a red
        // count opens filtered to what waits on you). The row itself
        // still goes to its tool. Unread news is plain figures, not a
        // badge: only what needs a decision is badged.
        <button
          // Keyed by the count, so a change pops (globals.css .ui-badge).
          key={String(leaf.badge)}
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); openCenter(urgent ? 'action' : 'all'); }}
          title={badgeWords}
          aria-label={`${leaf.label}: ${badgeWords}`}
          className={urgent
            ? 'ui-badge ui-hit cursor-pointer hover:brightness-110'
            : 'ui-hit min-w-5 h-5 px-1 rounded text-caption tabular-nums text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer'}
        >
          {badgeText(leaf.badge!)}
        </button>
      )}
    </Link>
  );
}

/** When a checked-out document is due back, in two words: "Overdue",
 *  "Due today", "Due Fri", "Due Dec 3". */
function dueWords(at: string | null): { words: string; late: boolean } | null {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return null;
  if (t < Date.now()) return { words: 'Overdue', late: true };
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const d = new Date(t);
  const days = Math.round((day(d) - day(new Date())) / 86_400_000);
  if (days === 0) return { words: 'Due today', late: false };
  if (days < 7) return { words: `Due ${d.toLocaleDateString('en-US', { weekday: 'short' })}`, late: false };
  return { words: `Due ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, late: false };
}

// ─── The workspace card at the top ───────────────────────────
// With a logo: the logo on a white plate (logos are drawn for white), as big
// as the menu is wide; the logo already says the name, so it isn't repeated.
// Without one: the initials and the name. When it opens a menu, its arrow
// sits inside the card, quietly, at the right.
function WorkspaceCard({ logoUrl, name, menu = false }: { logoUrl: string | null | undefined; name: string | null; menu?: boolean }) {
  if (logoUrl) {
    return (
      <span className="flex items-center gap-2 w-full h-14 pl-3 pr-2.5 rounded-xl border border-[var(--color-border)]" style={{ background: 'var(--side-logo-plate, var(--color-surface))' }}>
        <span className="flex-1 min-w-0 h-full flex items-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- org logo is a signed storage URL */}
          <img src={logoUrl} alt={name ? `${name} logo` : 'Workspace logo'} className="max-h-10 w-auto max-w-full object-contain" draggable={false} />
        </span>
        {menu && <ChevronDown aria-hidden className="shrink-0 w-4 h-4 text-[var(--side-logo-ink)]" />}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2.5 w-full h-14 px-2.5 rounded-xl bg-[var(--color-surface)]">
      {name ? <OrgInitials name={name} /> : <AppMark size={30} ring />}
      <span className="flex-1 min-w-0">
        <span className="block font-display text-reading font-semibold text-[var(--color-text)] leading-tight truncate">{name ?? 'Manufacturing OS'}</span>
        {name && <span className="block text-caption text-[var(--color-text-muted)] leading-tight">Workspace</span>}
      </span>
      {menu && <ChevronDown aria-hidden className="shrink-0 w-4 h-4 text-[var(--color-text-muted)]" />}
    </span>
  );
}

/** A workspace's initials on a tile (the rail, or no logo yet). */
function OrgInitials({ name }: { name: string }) {
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  return (
    <span aria-hidden className="shrink-0 w-8 h-8 rounded-lg inline-flex items-center justify-center bg-[var(--color-text)] text-[var(--color-canvas)] font-display text-body font-bold">{letters}</span>
  );
}
