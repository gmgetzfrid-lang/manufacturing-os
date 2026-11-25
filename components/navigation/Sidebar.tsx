"use client";

// Sidebar - the side menu.
//
// Design contract (matches the code; keep it that way):
//
//   * A panel that floats on the page gray with round corners and a soft
//     gradient of the workspace's deep color (light workspaces: white), not
//     a hard full-height bar. Its colors are the workspace's --side-* tokens.
//
//   * Header: the workspace's logo is one button (switch workspace, change
//     the logo). Beside it, the one toggle: collapse/expand (Cmd+B / Ctrl+B,
//     remembered), the same spot open or shut. On a phone the top bar's menu
//     button opens the drawer and the same spot closes it (X).
//
//   * Tools in three named groups: Work, Site, Tools. Alternate views of a
//     tool live behind the in-page ViewTabs, never as extra items; the
//     highlight is DERIVED from the same ViewTabs arrays (TOOL_ALIASES).
//     Projects and Drafting requests show a + on hover to start a new one.
//
//   * The current page is a white pill (the white of the page) that slides
//     from item to item.
//
//   * Admin (Admins and Document Control only) turns the menu into the
//     admin toolbar: the admin pages in four groups, "Back to the app" on
//     top. It is the menu's mode on any admin page.
//
//   * Under the tools, only when there is something: work running in the
//     background (uploads, the AI reading the library), with progress,
//     moved here from the floating corner cards (lib/runningWork); and
//     "On now": who else is in the app and what they're in, tap to go there
//     (lib/orgPresence). On now shrinks to faces when space is short.
//
//   * Badges: red = waiting on your decision, a quiet count = unread news,
//     nothing when clear. The header bell owns the org-wide total.
//
//   * The footer is the USER (photo, or initials), never a role letter.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { AppMark } from '@/components/brand/AppMark';
import { usePathname, useRouter } from 'next/navigation';
import { supabase, setPreferMicrosoft } from '@/lib/supabase';
import { signOutHere } from '@/lib/membershipClient';
import { useRole } from '@/components/providers/RoleContext';
import { useOrgBranding } from '@/components/providers/OrgBrandingProvider';
import {
  LayoutDashboard, Settings, Settings2, Users, LogOut, FileText,
  BarChart3, Briefcase, KeyRound, Factory, Gauge,
  ScrollText, Activity, MailPlus, BookMarked, FileOutput,
  ChevronRight, ChevronDown, ArrowLeft, PanelLeftClose, PanelLeftOpen,
  ShieldCheck, UsersRound, FileStack, Palette, Plus, Eye,
  Check, Image as ImageIcon, X, Bot, CreditCard, DatabaseBackup, ArchiveRestore, Compass,
  HardHat, Upload, BookOpenText, AlertCircle, CheckCircle2, Loader2,
} from 'lucide-react';
import { useTicketNotifications } from '@/hooks/useTicketNotifications';
import { useNotificationCenter } from '@/components/notifications/NotificationCenter';
import { useIsMobile } from '@/hooks/useIsMobile';
import LogoUploadModal from '@/components/branding/LogoUploadModal';
import UserAvatar from '@/components/ui/UserAvatar';
import MoreMenu, { type MoreItem } from '@/components/ui/MoreMenu';
import { badgeText } from '@/lib/badge';
import { onTransitionClick } from '@/lib/viewTransition';
import { useRunning, setRunningDock, type RunningItem } from '@/lib/runningWork';
import { useOrgPresence, type OnNowPerson, type PresenceWhere } from '@/lib/orgPresence';
import { cachedProfile, onProfilesChanged, requestProfile } from '@/lib/userProfiles';
import {
  DOCUMENT_VIEWS, EQUIPMENT_VIEWS, HOME_VIEWS, ACTIVITY_VIEWS, INTELLIGENCE_VIEWS,
} from '@/components/navigation/ViewTabs';

// A consolidated tool stays highlighted on any of its views. DERIVED from
// the ViewTabs arrays so the two surfaces can never drift again.
const viewHrefs = (views: Array<{ href: string }>, exclude: string) =>
  views.map((v) => v.href).filter((h) => h !== exclude);
const TOOL_ALIASES: Record<string, string[]> = {
  '/dashboard':    viewHrefs(HOME_VIEWS, '/dashboard'),
  '/documents':    viewHrefs(DOCUMENT_VIEWS, '/documents'),
  '/admin/assets': viewHrefs(EQUIPMENT_VIEWS, '/admin/assets'),
  '/activity':     viewHrefs(ACTIVITY_VIEWS, '/activity'),
  '/assistant':    viewHrefs(INTELLIGENCE_VIEWS, '/assistant'),
};

const COLLAPSED_KEY = 'mfg-os.sidebar.collapsed';
const LAST_APP_KEY = 'mfg-os.sidebar.lastAppPath';

type IconType = React.ComponentType<{ className?: string; style?: React.CSSProperties }>;

interface NavLeaf {
  label: string;
  hint?: string;
  href: string;
  icon: IconType;
  badge?: number;
  badgeTone?: 'red' | 'blue';
  /** Start a new one from the menu (shown as + on hover). */
  onNew?: () => void;
  newLabel?: string;
}
interface NavGroup { title: string; items: NavLeaf[] }

// The admin toolbar: every admin page, grouped by what it's for.
const ADMIN_GROUPS: NavGroup[] = [
  { title: 'People', items: [
    { label: 'Users', href: '/admin/users', icon: Users },
    { label: 'Teams', href: '/admin/teams', icon: UsersRound },
    { label: 'Permissions', href: '/admin/permissions', icon: KeyRound },
  ] },
  { title: 'Library setup', items: [
    { label: 'Library config', href: '/admin/libraries', icon: Settings2 },
    { label: 'Request forms', href: '/admin/requests', icon: FileText },
    { label: 'Site codebook', href: '/admin/codebook', icon: BookMarked },
    { label: 'Operational scope', href: '/admin/scope', icon: Factory },
    { label: 'Facility setup', href: '/setup', icon: Compass },
  ] },
  { title: 'Data', items: [
    { label: 'Audit log', href: '/admin/audit', icon: ScrollText },
    { label: 'Analytics', href: '/admin/analytics', icon: BarChart3 },
    { label: 'Storage and backup', href: '/admin/storage', icon: Gauge },
    { label: 'Data export', href: '/admin/data-export', icon: DatabaseBackup },
    { label: 'Restore', href: '/admin/restore', icon: ArchiveRestore },
  ] },
  { title: 'Workspace', items: [
    { label: 'Branding', href: '/admin/branding', icon: Palette },
    { label: 'Billing', href: '/admin/billing', icon: CreditCard },
    { label: 'Settings', href: '/admin/settings', icon: Settings },
  ] },
];
const ADMIN_HREFS = ADMIN_GROUPS.flatMap((g) => g.items.map((i) => i.href));
const isAdminPath = (p: string | null) => !!p && ADMIN_HREFS.some((h) => p === h || p.startsWith(h + '/'));

// A row's hover: a tint of the menu's own text color, so it reads on a deep
// menu and a light one alike.
const HOVER = 'hover:bg-[color-mix(in_srgb,var(--color-text)_8%,transparent)] hover:text-[var(--color-text)]';

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
  // clear.
  const badgeOf = useCallback((s: { total: number; actionRequired: number }): { badge?: number; badgeTone?: 'red' | 'blue' } => {
    if (s.total <= 0) return {};
    return s.actionRequired > 0
      ? { badge: s.actionRequired, badgeTone: 'red' }
      : { badge: s.total, badgeTone: 'blue' };
  }, []);
  const { logoUrl, canEdit: canEditBranding } = useOrgBranding();
  const [logoModalOpen, setLogoModalOpen] = useState(false);
  const isMobile = useIsMobile();

  // The desktop's remembered choice; a phone always shows the full menu
  // (it's a drawer there).
  const [railCollapsed, setRailCollapsed] = useState(false);
  const collapsed = railCollapsed && !isMobile;
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- this device's own choice, read once after mount
      if (localStorage.getItem(COLLAPSED_KEY) === '1') setRailCollapsed(true);
    } catch {}
  }, []);
  useEffect(() => { try { localStorage.setItem(COLLAPSED_KEY, railCollapsed ? '1' : '0'); } catch {} }, [railCollapsed]);

  // Cmd+B / Ctrl+B.
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

  // The drawer closes on navigation and Escape.
  useEffect(() => { onMobileClose?.(); }, [pathname, onMobileClose]);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onMobileClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onMobileClose]);

  // On a desktop this menu shows running work; the corner cards stand down.
  useEffect(() => { setRunningDock(!isMobile); return () => setRunningDock(false); }, [isMobile]);

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
  const isAdmin = activeRole === 'Admin' || activeRole === 'DocCtrl';

  // The workspace menu: switch workspace and the logo. (Its settings are in
  // Admin, not here too.)
  const workspaceItems: MoreItem[] = [
    ...(orgOptions.length > 1 ? orgOptions.map((o) => ({
      icon: o.id === activeOrgId ? <Check aria-hidden className="w-4 h-4" /> : <span aria-hidden className="w-4 h-4" />,
      label: o.name, current: o.id === activeOrgId,
      onClick: () => { if (o.id !== activeOrgId) setActiveOrgId(o.id); },
    })) : []),
    ...(canEditBranding ? [{ icon: <ImageIcon aria-hidden className="w-4 h-4" />, label: logoUrl ? 'Change logo' : 'Add your logo', line: orgOptions.length > 1, onClick: () => setLogoModalOpen(true) }] : []),
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

  // "+" on Projects: on the Projects page, open the form there; elsewhere,
  // go there with it open.
  const newProject = useCallback(() => {
    if (pathname === '/projects') window.dispatchEvent(new Event('mfgos:new-project'));
    else router.push('/projects?new=1');
  }, [pathname, router]);

  const groups: NavGroup[] = useMemo(() => {
    const all: NavGroup[] = [
      { title: 'Work', items: [
        { label: 'Home', hint: 'Your dashboard', href: '/dashboard', icon: LayoutDashboard },
        { label: 'Documents', hint: 'Libraries, board, checkouts, packages', href: '/documents', icon: FileStack, ...badgeOf(sectionCounts.documents) },
        { label: 'Projects', hint: 'Project workspaces and milestones', href: '/projects', icon: Briefcase, ...badgeOf(sectionCounts.projects), onNew: newProject, newLabel: 'New project' },
        { label: 'Drafting requests', hint: 'Drafting and design requests', href: '/requests', icon: MailPlus, ...badgeOf(sectionCounts.requests), onNew: () => router.push('/requests/new'), newLabel: 'New drafting request' },
      ] },
      { title: 'Site', items: [
        { label: 'Operating areas', hint: 'Equipment by unit, plot plans', href: '/admin/assets', icon: Factory },
        { label: 'Companies', hint: 'Contractors and vendors, scored on evidence', href: '/companies', icon: HardHat },
      ] },
      { title: 'Tools', items: [
        { label: 'Intelligence', hint: 'Ask the AI: your documents, the system, the web', href: '/assistant', icon: Bot },
        { label: 'Output docs', hint: 'Scopes and letters from templates and data', href: '/output-templates', icon: FileOutput },
        { label: 'Activity', hint: 'History and audit log', href: '/activity', icon: Activity },
      ] },
    ];
    // Viewers and contractors hold few or no capabilities: the daily four.
    if (activeRole === 'Viewer' || activeRole === 'Contractor') {
      return [{ title: 'Work', items: all[0]!.items.map((i) => (i.label === 'Projects' ? { ...i, onNew: undefined } : i)) }];
    }
    return all;
  }, [sectionCounts, badgeOf, activeRole, newProject, router]);

  // The menu's mode: the admin toolbar on any admin page; Admin / Back to
  // the app switch it by hand until the next page.
  const onAdminPage = isAdminPath(pathname);
  const [modePick, setModePick] = useState<{ path: string | null; admin: boolean } | null>(null);
  const adminMode = isAdmin && (modePick && modePick.path === pathname ? modePick.admin : onAdminPage);
  useEffect(() => {
    if (!pathname || onAdminPage) return;
    try { sessionStorage.setItem(LAST_APP_KEY, pathname); } catch {}
  }, [pathname, onAdminPage]);
  const backToApp = () => {
    if (onAdminPage) {
      let to = '/dashboard';
      try { to = sessionStorage.getItem(LAST_APP_KEY) || to; } catch {}
      router.push(to);
    } else setModePick({ path: pathname, admin: false });
  };
  const navGroups = adminMode ? ADMIN_GROUPS : groups;

  // Where this person is, for others' "On now" (a page that knows says more).
  const here = navGroups.flatMap((g) => g.items).find((l) => isPathActive(l.href));
  const fallbackWhere: PresenceWhere | null = adminMode ? { verb: 'In', label: 'Admin' } : here ? { verb: 'In', label: here.label, href: here.href } : null;
  const myName = useProfileName(uid, userEmail?.split('@')[0] ?? 'Someone');
  const others = useOrgPresence(activeOrgId, { userId: uid, name: myName }, fallbackWhere);
  const running = useRunning();

  // The current item's pill: one shape behind the list that slides to it.
  // Set on the element itself (no extra render, nothing to flash).
  const navBox = useRef<HTMLDivElement | null>(null);
  const pill = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const box = navBox.current;
    const tab = pill.current;
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
    const raf = requestAnimationFrame(() => tab.classList.add('is-ready'));
    const ro = new ResizeObserver(place);
    ro.observe(box);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [pathname, collapsed, adminMode]);

  // How much room is left under the tools, for On now: two people, faces
  // only, or nothing (the tools come first).
  const panel = useRef<HTMLDivElement | null>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = panel.current;
    const box = navBox.current;
    if (!el || !box) return;
    const measure = () => {
      const head = el.querySelector<HTMLElement>('[data-side-head]')?.offsetHeight ?? 0;
      const foot = el.querySelector<HTMLElement>('[data-side-foot]')?.offsetHeight ?? 0;
      const work = el.querySelector<HTMLElement>('[data-side-work]')?.offsetHeight ?? 0;
      setRoom(el.clientHeight - head - foot - work - box.offsetHeight - 24);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(box);
    return () => ro.disconnect();
  }, [collapsed, adminMode, running.length]);
  const onNowFit: 'full' | 'faces' | 'none' = room >= 150 ? 'full' : room >= 56 ? 'faces' : 'none';

  // Names on the collapsed rail: a label pops out beside the icon.
  const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null);
  const tipOn = (label: string) => (e: React.SyntheticEvent<HTMLElement>) => {
    if (!collapsed) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ label, x: r.right + 12, y: r.top + r.height / 2 });
  };
  const tipOff = () => setTip(null);
  useEffect(() => { setTip(null); }, [pathname, collapsed]); // eslint-disable-line react-hooks/set-state-in-effect -- a moved page or menu drops its pop-out

  const handleLogout = async () => {
    setPreferMicrosoft(false);
    // This device is signed out at once, even when the server is busy
    // (plant PCs are shared); everywhere else follows when it answers.
    await signOutHere();
    router.push('/');
  };

  const shownWork = isMobile ? [] : running;

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
        className={`shrink-0 fixed inset-y-0 left-0 z-[70] p-2 md:p-2.5 md:relative md:inset-auto md:z-[35] transition-[transform,width] duration-200 ease-out ${collapsed ? 'md:w-[84px]' : 'w-[280px] md:w-[284px]'} ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}
      >
      <div ref={panel} className={`vt-side surface-side side-panel relative h-full flex flex-col overflow-hidden rounded-[18px] border border-[var(--color-border)] text-[var(--color-text-muted)] ${mobileOpen ? 'ui-float' : ''}`}>

      {/* The workspace (one button) and the one toggle. */}
      <div data-side-head className={`shrink-0 relative ${collapsed ? 'flex flex-col items-center gap-1.5 pt-3 pb-2' : 'flex items-center gap-2 px-3 pt-3 pb-2'}`}>
        {collapsed ? (
          workspaceItems.length > 0 ? (
            <MoreMenu items={workspaceItems} label={`Workspace: ${orgName ?? 'Manufacturing OS'}. Switch and logo`}
              triggerClass="w-11 h-11 inline-flex items-center justify-center rounded-xl"
              trigger={orgName ? <OrgInitials name={orgName} /> : <AppMark size={30} ring />} />
          ) : (orgName ? <OrgInitials name={orgName} /> : <AppMark size={30} ring />)
        ) : workspaceItems.length > 0 ? (
          <MoreMenu items={workspaceItems} label={`Workspace: ${orgName ?? 'Manufacturing OS'}. Switch and logo`} boxClass="flex-1 min-w-0"
            triggerClass="w-full text-left rounded-xl"
            trigger={<WorkspaceCard logoUrl={logoUrl} name={orgName} menu />} />
        ) : (
          <div className="flex-1 min-w-0"><WorkspaceCard logoUrl={logoUrl} name={orgName} /></div>
        )}
        <button
          type="button"
          onClick={() => (isMobile ? onMobileClose?.() : setRailCollapsed((v) => !v))}
          title={isMobile ? 'Close menu' : collapsed ? 'Expand (⌘B)' : 'Collapse (⌘B)'}
          aria-label={isMobile ? 'Close menu' : collapsed ? 'Expand the menu' : 'Collapse the menu'}
          className={`shrink-0 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-[10px] text-[var(--color-text-muted)] transition-colors ${HOVER}`}
        >
          {isMobile ? <X className="w-[18px] h-[18px]" /> : collapsed ? <PanelLeftOpen className="w-[18px] h-[18px]" /> : <PanelLeftClose className="w-[18px] h-[18px]" />}
        </button>
      </div>

      {logoModalOpen && <LogoUploadModal onClose={() => setLogoModalOpen(false)} />}

      <nav className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar px-3 pb-2">
        <div ref={navBox} className="relative">
          {/* The current page: a white pill that slides to it. */}
          <div ref={pill} aria-hidden style={{ opacity: 0 }}
            className="absolute left-0 right-0 top-0 rounded-[10px] bg-[var(--side-current,#fff)] pointer-events-none [&.is-ready]:transition-[transform,height] [&.is-ready]:duration-200 [&.is-ready]:ease-out motion-reduce:!transition-none" />

          {adminMode && (
            collapsed ? (
              <button type="button" onClick={backToApp} aria-label="Back to the app" onMouseEnter={tipOn('Back to the app')} onMouseLeave={tipOff} onFocus={tipOn('Back to the app')} onBlur={tipOff}
                className={`relative z-[1] w-full h-10 mt-1 inline-flex items-center justify-center rounded-[10px] bg-[color-mix(in_srgb,var(--color-text)_8%,transparent)] text-[var(--color-text)] ${HOVER}`}>
                <ArrowLeft className="w-[18px] h-[18px]" />
              </button>
            ) : (
              <>
                <button type="button" onClick={backToApp}
                  className={`relative z-[1] w-full flex items-center gap-2.5 h-9 pointer-coarse:h-11 px-2.5 mt-1 rounded-[10px] bg-[color-mix(in_srgb,var(--color-text)_8%,transparent)] text-[var(--color-text)] text-body font-medium ${HOVER}`}>
                  <ArrowLeft aria-hidden className="w-[18px] h-[18px]" /> Back to the app
                </button>
                <div className="px-2.5 pt-3 font-display text-section font-bold text-[var(--color-text)]">Admin</div>
              </>
            )
          )}

          {navGroups.map((g, gi) => (
            <div key={g.title}>
              {collapsed
                ? (gi > 0 || adminMode) && <div aria-hidden className="h-px mx-2 my-2 bg-[var(--color-border)]" />
                : <div className={`px-2.5 ${gi === 0 && !adminMode ? 'pt-2' : 'pt-4'} pb-1 text-caption font-semibold uppercase tracking-[0.09em] text-[var(--color-text-faint)]`}>{g.title}</div>}
              <div className="space-y-px">
                {g.items.map((leaf) => (
                  <SidebarLeaf key={leaf.href} leaf={leaf} active={isPathActive(leaf.href)} collapsed={collapsed} dense={adminMode}
                    onTip={tipOn} offTip={tipOff} />
                ))}
              </div>
            </div>
          ))}

          {isAdmin && !adminMode && (
            collapsed ? (
              <>
                <div aria-hidden className="h-px mx-2 my-2 bg-[var(--color-border)]" />
                <button type="button" onClick={() => setModePick({ path: pathname, admin: true })} aria-label="Admin"
                  onMouseEnter={tipOn('Admin')} onMouseLeave={tipOff} onFocus={tipOn('Admin')} onBlur={tipOff}
                  className={`relative z-[1] w-full h-10 inline-flex items-center justify-center rounded-[10px] text-[var(--color-text-muted)] ${HOVER}`}>
                  <ShieldCheck className="w-[18px] h-[18px]" />
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setModePick({ path: pathname, admin: true })}
                className={`relative z-[1] mt-3 w-full flex items-center gap-2.5 h-9 pointer-coarse:h-11 px-2.5 rounded-[10px] text-[var(--color-text-muted)] transition-colors ${HOVER}`}>
                <ShieldCheck aria-hidden className="w-[18px] h-[18px] shrink-0" />
                <span className="flex-1 text-left text-reading leading-none">Admin</span>
                <ChevronRight aria-hidden className="w-4 h-4 text-[var(--color-text-faint)]" />
              </button>
            )
          )}
        </div>
      </nav>

      {/* Live: work running now, and who else is here. */}
      {shownWork.length > 0 && (
        <div data-side-work className={`shrink-0 ${collapsed ? 'flex justify-center pb-2' : 'px-3 pb-2'}`}>
          {collapsed
            ? <RunningDot items={shownWork} onOpen={() => setRailCollapsed(false)} onTip={tipOn} offTip={tipOff} />
            : <RunningCard items={shownWork} />}
        </div>
      )}
      {others && others.length > 0 && onNowFit !== 'none' && (
        <div className={`shrink-0 ${collapsed ? 'flex justify-center pb-2' : 'px-3 pb-2'}`}>
          {collapsed
            ? <OnNowFaces people={others} onTip={tipOn} offTip={tipOff} />
            : <OnNowCard people={others} fit={onNowFit} />}
        </div>
      )}

      {/* You. */}
      <div data-side-foot className="shrink-0 border-t border-[var(--color-border)] p-2">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <Link href="/profile" aria-label="Your profile" onMouseEnter={tipOn(userEmail ?? 'Profile')} onMouseLeave={tipOff}
              className="ui-hit rounded-full hover:opacity-90 transition-opacity">
              <UserAvatar uid={uid} email={userEmail} size={36} />
            </Link>
            <button onClick={handleLogout} aria-label="Sign out" onMouseEnter={tipOn('Sign out')} onMouseLeave={tipOff}
              className={`w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-[10px] text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)] ${HOVER}`}>
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 pl-1.5">
            <Link href="/profile" className="flex items-center gap-2.5 min-w-0 flex-1 pointer-coarse:min-h-11 rounded-[10px]" title="Open profile">
              <UserAvatar uid={uid} email={userEmail} size={36} />
              <span className="min-w-0">
                <span className="block text-body font-semibold text-[var(--color-text)] truncate">{myName}</span>
                <span className="block text-caption text-[var(--color-text-muted)] truncate">{activeOrgId ? (activeRole ?? '…') : 'No workspace'}</span>
              </span>
            </Link>
            <button onClick={handleLogout} aria-label="Sign out" title="Sign out"
              className={`shrink-0 w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-[10px] text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)] ${HOVER}`}>
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
      </div>
      </aside>

      {tip && typeof document !== 'undefined' && createPortal(
        <div role="tooltip" style={{ left: tip.x, top: tip.y }}
          className="fixed z-[80] -translate-y-1/2 pointer-events-none px-2.5 py-1.5 rounded-lg bg-[var(--color-surface)] text-[var(--color-text)] text-body font-semibold whitespace-nowrap border border-[var(--color-border)] ui-float">
          {tip.label}
        </div>,
        document.body,
      )}
    </>
  );
}

/** This person's display name, once the profile cache has it. */
function useProfileName(uid: string | null | undefined, fallback: string): string {
  const [, bump] = useState(0);
  useEffect(() => onProfilesChanged(() => bump((n) => n + 1)), []);
  useEffect(() => { if (uid) requestProfile(uid); }, [uid]);
  return (uid ? cachedProfile(uid)?.displayName : null) || fallback;
}

// ─── A row ───────────────────────────────────────────────────
// The current item sits on the sliding white pill: its words take the
// pill's text color and its icon the current-item blue. A red count is
// something waiting on you; in the rail it becomes a dot on the icon.

function SidebarLeaf({
  leaf, active, collapsed, dense = false, onTip, offTip,
}: {
  leaf: NavLeaf;
  active: boolean;
  collapsed: boolean;
  /** The admin toolbar's longer list: a little shorter rows. */
  dense?: boolean;
  onTip: (label: string) => (e: React.SyntheticEvent<HTMLElement>) => void;
  offTip: () => void;
}) {
  const Icon = leaf.icon;
  const router = useRouter();
  const { open: openCenter } = useNotificationCenter();
  const urgent = leaf.badgeTone === 'red';
  const hasBadge = !!leaf.badge && leaf.badge > 0;
  const badgeWords = urgent ? `${leaf.badge} waiting on you` : `${leaf.badge} new`;
  const tipLabel = `${leaf.label}${hasBadge ? ` (${badgeWords})` : ''}`;
  return (
    <div className="group/leaf relative">
      <Link href={leaf.href}
        title={collapsed ? undefined : (leaf.hint ?? leaf.label)}
        aria-label={collapsed ? `${leaf.label}${hasBadge ? `, ${badgeWords}` : ''}` : undefined}
        aria-current={active ? 'page' : undefined}
        onClick={active ? undefined : (e) => onTransitionClick(e, () => router.push(leaf.href))}
        onMouseEnter={onTip(tipLabel)} onMouseLeave={offTip} onFocus={onTip(tipLabel)} onBlur={offTip}
        data-navleaf=""
        className={`relative z-[1] flex items-center gap-2.5 rounded-[10px] transition-colors ${
          collapsed ? 'h-10 pointer-coarse:h-11 justify-center' : `${dense ? 'h-8' : 'h-9'} pointer-coarse:h-11 px-2.5`
        } ${active ? 'text-[var(--side-current-text,#1f2733)] font-semibold' : `text-[var(--color-text-muted)] ${HOVER}`}`}
      >
        <span className="relative shrink-0 inline-flex">
          <Icon className={`w-[18px] h-[18px] ${active ? 'text-[var(--color-current)]' : ''}`} />
          {collapsed && hasBadge && (
            <span aria-hidden className={`absolute -top-1 -right-1 ui-dot ${urgent ? '' : 'is-quiet'} ring-2 ring-[var(--side-bg,#081d48)]`} />
          )}
        </span>
        {!collapsed && <span className={`${dense ? 'text-body' : 'text-reading'} truncate flex-1 leading-none`}>{leaf.label}</span>}
        {!collapsed && hasBadge && (
          // The count is a doorway: it opens the Notification Center with
          // exactly what it counts. The row still goes to its tool.
          <button
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
        {/* Room for the + so the count doesn't jump when it shows. */}
        {!collapsed && leaf.onNew && <span aria-hidden className="w-6 shrink-0 pointer-coarse:hidden" />}
      </Link>
      {!collapsed && leaf.onNew && (
        // Start a new one without leaving the page you're on. Shows on
        // hover or keyboard focus; on a touch screen the page's own button
        // does this.
        <button type="button" onClick={leaf.onNew} aria-label={leaf.newLabel} title={leaf.newLabel}
          className={`absolute z-[2] right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 inline-flex items-center justify-center rounded-md opacity-0 group-hover/leaf:opacity-100 focus-visible:opacity-100 pointer-coarse:hidden transition-opacity ${
            active ? 'text-[var(--side-current-text,#1f2733)] hover:bg-[color-mix(in_srgb,var(--side-current-text,#1f2733)_10%,transparent)]' : 'text-[var(--color-text)] bg-[color-mix(in_srgb,var(--color-text)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-text)_20%,transparent)]'}`}>
          <Plus className="w-[15px] h-[15px]" strokeWidth={2.25} />
        </button>
      )}
    </div>
  );
}

// ─── Running work ────────────────────────────────────────────

function RunningCard({ items }: { items: RunningItem[] }) {
  return (
    <div className="rounded-[14px] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-text)_6%,transparent)] px-3 py-2.5 space-y-3" role="status" aria-live="polite">
      {items.map((it) => {
        const Icon = it.state === 'error' ? AlertCircle : it.state === 'done' ? CheckCircle2 : it.kind === 'upload' ? Upload : BookOpenText;
        return (
          <div key={it.id}>
            <div className="flex items-center gap-2.5">
              <Icon aria-hidden className={`w-4 h-4 shrink-0 ${it.state === 'error' ? 'text-[var(--state-overdue)]' : it.state === 'done' ? 'text-[var(--state-released)]' : 'text-[var(--color-accent-text)]'}`} />
              <span className="flex-1 min-w-0">
                <span className="block text-body font-semibold text-[var(--color-text)] truncate">{it.title}</span>
                {it.detail && <span className="block text-caption text-[var(--color-text-muted)] truncate" title={it.detail}>{it.detail}</span>}
              </span>
              {it.right && <span className="shrink-0 text-caption font-semibold tabular-nums text-[var(--color-text)]">{it.right}</span>}
              {it.dismiss && (
                <button type="button" onClick={it.dismiss} aria-label="Close" className={`ui-hit shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-md text-[var(--color-text-faint)] ${HOVER}`}>
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {it.state === 'running' && it.pct !== null && (
              <div className="mt-2 h-1 rounded-full bg-[color-mix(in_srgb,var(--color-text)_14%,transparent)] overflow-hidden">
                <div className="h-full rounded-full bg-[var(--color-accent-text)] transition-[width] duration-300" style={{ width: `${Math.max(4, it.pct)}%` }} />
              </div>
            )}
            {it.state === 'error' && it.error && <div className="mt-1 text-caption text-[var(--color-text-muted)] line-clamp-2">{it.error}</div>}
            {it.state === 'error' && it.retry && (
              <button type="button" onClick={it.retry}
                className={`mt-2 h-8 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border-strong)] text-caption font-semibold text-[var(--color-text)] ${HOVER}`}>
                Try again
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The rail: one icon for all running work; opens the menu to see it. */
function RunningDot({ items, onOpen, onTip, offTip }: { items: RunningItem[]; onOpen: () => void; onTip: (l: string) => (e: React.SyntheticEvent<HTMLElement>) => void; offTip: () => void }) {
  const bad = items.some((i) => i.state === 'error');
  const going = items.some((i) => i.state === 'running');
  const words = items.map((i) => `${i.title}${i.right ? ` ${i.right}` : ''}`).join(', ');
  return (
    <button type="button" onClick={onOpen} aria-label={words} onMouseEnter={onTip(words)} onMouseLeave={offTip} onFocus={onTip(words)} onBlur={offTip}
      className={`relative w-10 h-10 inline-flex items-center justify-center rounded-[10px] text-[var(--color-accent-text)] ${HOVER}`}>
      {going ? <Loader2 className="w-[18px] h-[18px] animate-spin motion-reduce:animate-none" /> : bad ? <AlertCircle className="w-[18px] h-[18px] text-[var(--state-overdue)]" /> : <CheckCircle2 className="w-[18px] h-[18px] text-[var(--state-released)]" />}
      {bad && going && <span aria-hidden className="absolute top-1.5 right-1.5 ui-dot ring-2 ring-[var(--side-bg,#081d48)]" />}
    </button>
  );
}

// ─── On now ──────────────────────────────────────────────────

/** Names resolve from people's profiles once known; until then, what their
 *  own tab said. */
function usePeopleNames(people: OnNowPerson[]): (p: OnNowPerson) => string {
  const [, bump] = useState(0);
  useEffect(() => onProfilesChanged(() => bump((n) => n + 1)), []);
  const ids = people.map((p) => p.userId).join(',');
  useEffect(() => { for (const id of ids.split(',')) if (id) requestProfile(id); }, [ids]);
  return (p) => cachedProfile(p.userId)?.displayName || p.name;
}

const whereWords = (w: PresenceWhere | null) => (w ? `${w.verb} ${w.label}` : 'Online');

function Face({ p, size, name }: { p: OnNowPerson; size: number; name: string }) {
  return (
    <span className="relative shrink-0 inline-flex rounded-full ring-2 ring-[var(--side-bg,#081d48)]">
      <UserAvatar uid={p.userId} name={name} size={size} title={`${name}, ${whereWords(p.where).toLowerCase()}`} />
    </span>
  );
}

function OnNowCard({ people, fit }: { people: OnNowPerson[]; fit: 'full' | 'faces' }) {
  const nameOf = usePeopleNames(people);
  const shown = fit === 'full' ? people.slice(0, 2) : [];
  const rest = fit === 'full' ? people.slice(2) : people;
  const head = (
    <span className="flex items-center gap-2 text-caption font-semibold uppercase tracking-[0.09em] text-[var(--color-text-muted)]">
      <span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-released)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--state-released)_25%,transparent)]" />
      On now <span className="tabular-nums tracking-normal text-[var(--color-text)]">{people.length}</span>
    </span>
  );
  return (
    <div className="rounded-[14px] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-text)_6%,transparent)] px-3 py-2.5">
      {fit === 'faces' ? (
        <div className="flex items-center gap-2">{head}<span className="ml-auto"><FaceStack people={rest} nameOf={nameOf} max={5} size={24} /></span></div>
      ) : (
        <>
          {head}
          <ul className="mt-1.5 space-y-0.5">
            {shown.map((p) => {
              const name = nameOf(p);
              const Where = p.where?.verb === 'Viewing' ? Eye : p.where?.href?.startsWith('/projects/') ? Briefcase : null;
              const body = (
                <>
                  <span className="relative shrink-0">
                    <UserAvatar uid={p.userId} name={name} size={28} />
                    <span aria-hidden className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full bg-[var(--state-released)] ring-2 ring-[var(--side-bg,#081d48)]" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-body font-semibold text-[var(--color-text)] truncate leading-tight">{name}</span>
                    <span className="flex items-center gap-1 text-caption text-[var(--color-text-muted)] truncate">
                      {Where && <Where aria-hidden className="w-3 h-3 shrink-0" />}<span className="truncate">{whereWords(p.where)}</span>
                    </span>
                  </span>
                </>
              );
              return (
                <li key={p.userId}>
                  {p.where?.href
                    ? <Link href={p.where.href} title={`Go to ${p.where.label}`} className={`flex items-center gap-2.5 -mx-1.5 px-1.5 py-1 pointer-coarse:min-h-11 rounded-lg ${HOVER}`}>{body}</Link>
                    : <div className="flex items-center gap-2.5 py-1">{body}</div>}
                </li>
              );
            })}
          </ul>
          {rest.length > 0 && (
            <div className="mt-1 flex items-center gap-2 text-caption text-[var(--color-text-muted)]">
              <FaceStack people={rest} nameOf={nameOf} max={3} size={22} />
              {rest.length === 1 ? '1 other' : `${rest.length} others`}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FaceStack({ people, nameOf, max, size }: { people: OnNowPerson[]; nameOf: (p: OnNowPerson) => string; max: number; size: number }) {
  return (
    <span className="inline-flex">
      {people.slice(0, max).map((p, i) => (
        <span key={p.userId} className={i ? '-ml-1.5' : ''}><Face p={p} size={size} name={nameOf(p)} /></span>
      ))}
    </span>
  );
}

/** The rail: faces stacked down, the rest as "+N". */
function OnNowFaces({ people, onTip, offTip }: { people: OnNowPerson[]; onTip: (l: string) => (e: React.SyntheticEvent<HTMLElement>) => void; offTip: () => void }) {
  const nameOf = usePeopleNames(people);
  const words = `On now: ${people.map((p) => `${nameOf(p)} (${whereWords(p.where).toLowerCase()})`).join(', ')}`;
  return (
    <div className="flex flex-col items-center" tabIndex={0} aria-label={words} onMouseEnter={onTip(words.length > 60 ? `On now: ${people.length}` : words)} onMouseLeave={offTip} onFocus={onTip(`On now: ${people.length}`)} onBlur={offTip}>
      {people.slice(0, 3).map((p, i) => <span key={p.userId} className={i ? '-mt-2' : ''}><Face p={p} size={30} name={nameOf(p)} /></span>)}
      {people.length > 3 && <span className="mt-1 text-caption font-semibold text-[var(--color-text-muted)]">+{people.length - 3}</span>}
    </div>
  );
}

// ─── The workspace at the top ────────────────────────────────
// With a logo: the logo on its white plate (logos are drawn for white),
// with the menu's arrow inside the plate. Without: initials and the name.
function WorkspaceCard({ logoUrl, name, menu = false }: { logoUrl: string | null | undefined; name: string | null; menu?: boolean }) {
  if (logoUrl) {
    return (
      <span className="flex items-center gap-1.5 w-full h-11 pl-2.5 pr-2 rounded-xl" style={{ background: 'var(--side-logo-plate, var(--color-surface))' }}>
        <span className="flex-1 min-w-0 h-full flex items-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- org logo is a signed storage URL */}
          <img src={logoUrl} alt={name ? `${name} logo` : 'Workspace logo'} className="max-h-8 w-auto max-w-full object-contain object-left" draggable={false} />
        </span>
        {menu && <ChevronDown aria-hidden className="shrink-0 w-4 h-4 text-[var(--side-logo-ink)]" />}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2.5 w-full h-11 px-2 rounded-xl bg-[color-mix(in_srgb,var(--color-text)_8%,transparent)]">
      {name ? <OrgInitials name={name} /> : <AppMark size={28} ring />}
      <span className="flex-1 min-w-0 block font-display text-reading font-semibold text-[var(--color-text)] leading-tight truncate">{name ?? 'Manufacturing OS'}</span>
      {menu && <ChevronDown aria-hidden className="shrink-0 w-4 h-4 text-[var(--color-text-muted)]" />}
    </span>
  );
}

/** A workspace's initials on a white tile (the rail, or no logo yet). */
function OrgInitials({ name }: { name: string }) {
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  return (
    <span aria-hidden className="shrink-0 w-9 h-9 rounded-[10px] inline-flex items-center justify-center bg-[var(--side-current,#fff)] text-[var(--side-current-text,#1f2733)] font-display text-body font-bold">{letters}</span>
  );
}
