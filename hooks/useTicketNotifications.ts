import { createContext, useCallback, useContext, useState, useEffect, useMemo, useId, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { Ticket } from '@/types/schema';
import {
  listMyNotifications, countUnread, listUnreadKindsBeyond, markRead, markAllRead,
  NOTIFICATION_PAGE_SIZE, type NotificationRow, type NotificationCursor, type UnreadBeyondRow,
} from '@/lib/inAppNotifications';
import {
  isActionRow, isReconcileMark, reconcileClassOf, requestReconcile, workflowAlertGone, RECONCILE_MAX_IDS,
  type HeldNotification,
} from '@/lib/notificationReconcile';
import { SLA_NOTICE_ACTIONS } from '@/lib/ticketSla';
import { isTerminalTicketStatus, TERMINAL_TICKET_STATUSES } from '@/lib/ticketShed';
import {
  isActionRequired, attentionLabel, isQueueViewer, isEngineerRole,
} from '@/lib/ticketAttention';
import { loadCapabilityPolicyEntry, type CapabilityPolicy } from '@/lib/capabilityPolicy';
import { affordancePolicyFault } from '@/lib/checkoutAffordances';
import { loadRequesterRoles } from '@/lib/ticketRequesterRoles';
import { flaggedRequestTypes } from '@/lib/requestTypes';
import {
  KIND_META, NOTIFICATION_SECTIONS, isNotificationKind, type NotificationSection,
} from '@/lib/notificationKinds';

// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for "what needs my attention right now".
//
// Every notification surface — the sidebar badge, the header bell, and the
// /inbox cockpit — consumes THIS hook, so they always show the same count and
// the same items. The feed is the union of:
//   1. tickets that need my action (derived from my role + the ticket's state)
//   2. tickets with unread activity for me
//   3. unread in-app notification rows (mentions, comments, etc.)
// deduped so a notification about a ticket already in the feed doesn't double up.
//
// ONE feed per tab (notifications Round G, N4 — RT-3 / TRAIL-8): the state,
// the fetch and the ONE realtime channel live in useAttentionFeedState, which
// components/providers/AttentionProvider.tsx mounts once in the protected
// layout; every consumer of useTicketNotifications reads that one snapshot
// through AttentionContext, so a new consumer adds no query and no channel.
// Outside the provider (a test, a preview) the hook runs its own copy, as
// every instance did before.
//
// It stays current (RT-1): a burst of realtime events collapses into one
// refetch (FETCH_DEBOUNCE_MS, trailing — components/projects/ScheduleTab.tsx's
// pattern); the channel's status is watched, so a rejoin after a drop
// reconciles the whole feed, and a channel that errors or times out says so
// (AttentionStatus.stale); the tab coming back (visibilitychange / focus) and
// a visible-only VISIBLE_POLL_MS interval refetch too (the /inbox pattern).
//
// Its numbers are true (TAX-6 / DELIV-10 / TRAIL-7 / PROD-7): the feed lists
// the newest NOTIFICATION_PAGE_SIZE unread rows and pages older ones on
// request (a (created_at, id) keyset cursor), while the count comes from an
// exact head count (countUnread) and the rows below the loaded window are
// tallied by kind into the section badges and the action count — and the
// reconcilable ones among them are sent for reconcile too, so a discharged
// obligation below the window does not keep a badge red. A read that fails is
// an error the surfaces show, never an empty "all caught up"; what stays on
// screen then is the last good read OF THIS WORKSPACE — switching workspace
// (or person) clears the feed before the first read, so a failed read there
// shows nothing of the one left behind.
//
// Both the ticket feed AND the notification rows are scoped to the active
// workspace. A stale ticket workflow alert (its ticket has moved on) is left
// out of the feed as soon as it is seen, as before (DF-P1). Retiring a row
// whose condition is gone — that workflow alert; a hold_opened whose hold was
// released; a branch_open whose branch was resolved; a stale-checkout
// escalation whose session ended; an acknowledgment, sign-off or access
// recertification already discharged, and its overdue escalation copy once
// nobody owes it — is done on the SERVER: the feed sends
// the candidates' ids to POST /api/notifications/reconcile, which re-checks
// each against the database and marks the gone ones metadata.superseded_at
// (lib/notificationReconcile.ts; NEDGE-18, TRAIL-9, DEC-81 §2). Rows of any
// other kind are not reconciled: they stay until their recipient reads them.
// The browser writes no metadata, and the pass runs once per tab, after the
// read (a fetch is never also a write). Its echo is ignored (RT-8), and only
// its echo: an UPDATE is passed over only when it changes nothing but the
// server's own metadata.superseded_at mark, on a row the server answered it
// retired (or, while the request is in flight, a row it was asked about —
// held until the answer says whose mark it was); a mark-read or any other
// change refetches at once. An SLA notice ("Due soon" / "Overdue") is moot
// only once its request is CLOSED / CANCELED, never because an open request
// changed status (lib/ticketSla.ts SLA_NOTICE_ACTIONS; DF-P3, EDGE-7).
//
// Where a notification lands — its sidebar section, whether it is an action —
// is read from ONE table, lib/notificationKinds.ts KIND_META (notifications
// Round G, N2). A kind with no section there is bell-only: the header bell
// owns it, no rail row counts it.
//
// VOCABULARY — "unread" means three different things in this app (TAX-7):
//   * DB-unread: notifications.read_at IS NULL. Every notification row in
//     this feed is DB-unread (only those are loaded); marking one read removes
//     it. lib/inbox.ts's unreadNotificationCount is a head count of these.
//   * ticket-unread: tickets.unread_by contains me — a ticket with activity I
//     have not opened. It enters the feed as a non-action ticket row.
//   * action vs activity: the feed's own split. `counts.action` is every item
//     that needs me to DO something (an action-required ticket, or a kind
//     KIND_META marks actionRequired); `counts.activity` is everything else
//     (the Center's "Activity" filter). `counts` is computed here, once, and
//     every surface reads it — no surface recounts.
// ─────────────────────────────────────────────────────────────────────────────

// Open tickets are read a page at a time, most recently active first. The
// first page is OPEN_TICKET_CAP rows with an exact count; when the scope holds
// more, the next pages are read too, up to TICKET_SCAN_CEILING (TRAIL-7: an
// untouched ticket is often the one that needs attention, so truncating the
// oldest hid exactly those). Beyond the ceiling the scope is read OLDEST-
// modified first instead (drafting-flow EDGE-3 / ROUTE-7, DF-P9): the
// TICKET_SCAN_CEILING requests evaluated are the longest-neglected, and the
// ones left unevaluated are the most recently touched — and the surfaces say
// "the N longest-waiting of M" (AttentionStatus). Only the columns the
// attention rule reads are fetched (RT-3 dw3) — never the comments or history
// JSON.
const OPEN_TICKET_CAP = 500;
const TICKET_SCAN_CEILING = 5000;
/** The columns isActionRequired (lib/ticketAttention.ts → lib/workflow.ts)
 *  and the feed's rows read: identity, status, type, unit, the requester's
 *  role, and the attachments (a staged Draft offers "Submit Draft"). */
export const TICKET_ATTENTION_COLUMNS =
  'id, org_id, ticket_id, title, status, unit, request_type, requester_id, requester_role, assigned_drafter_id, assigned_engineer_id, attachments, unread_by, created_at, last_modified';
/** A burst of realtime events within this window is one refetch (RT-3 dw2). */
export const FETCH_DEBOUNCE_MS = 400;
/** The safety-net refetch while the tab is visible (RT-1 dw3). */
export const VISIBLE_POLL_MS = 60_000;
/** Rows below the loaded window tallied into the badges (TAX-6 dw1). */
export const REMAINDER_TALLY_CAP = 1000;
/** A row the server checked and kept is not sent again for this long. */
export const RECONCILE_KEEP_MS = 60_000;
/** The realtime echo of a row the reconcile pass answered it marked is
 *  ignored for this long (RT-8 dw2) — and only an echo that is exactly that
 *  mark (lib/notificationReconcile.ts isReconcileMark). */
export const RECONCILE_ECHO_MS = 30_000;

function fromDbTicket(row: Record<string, unknown>): Ticket {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    ticketId: row.ticket_id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    unit: typeof row.unit === 'string' ? row.unit : null, // PERS-6: NULL is "unknown" (DEC-101), never a cast string
    requestType: row.request_type as string,
    status: row.status as Ticket['status'],
    priority: row.priority as number | undefined,
    requesterId: row.requester_id as string,
    requesterName: row.requester_name as string | undefined,
    requesterEmail: row.requester_email as string | undefined,
    requesterRole: row.requester_role as Ticket['requesterRole'],
    assignedDrafterId: row.assigned_drafter_id as string | null | undefined,
    assignedDrafterName: row.assigned_drafter_name as string | null | undefined,
    assignedEngineerId: row.assigned_engineer_id as string | null | undefined,
    assignedEngineerName: row.assigned_engineer_name as string | null | undefined,
    assignedEngineerEmail: row.assigned_engineer_email as string | null | undefined,
    attachments: (row.attachments as Ticket['attachments']) ?? [],
    comments: (row.comments as Ticket['comments']) ?? [],
    history: (row.history as Ticket['history']) ?? [],
    unreadBy: (row.unread_by as string[]) ?? [],
    revisionCount: row.revision_count as number | undefined,
    createdAt: row.created_at as string,
    lastModified: row.last_modified as string | undefined,
  };
}

export type AttentionSource = 'ticket' | 'notification';

/** Which sidebar destination an item belongs to. Drives the PER-SECTION
 *  badges so a document conflict never shows up on the Drafting Requests
 *  item, and vice-versa. Exactly the rows the Sidebar badges (a test pins
 *  the two equal); a bell-only item has section null. */
export type AttentionSection = NotificationSection;

/** Map a notification kind (or a ticket row) to the section it belongs to,
 *  or null when it is bell-only. Read from KIND_META, where each kind's
 *  section is decided and written down. */
export function sectionForKind(kind: NotificationRow['kind'] | 'ticket'): AttentionSection | null {
  if (kind === 'ticket') return 'requests';
  if (isNotificationKind(kind)) return KIND_META[kind].section;
  // Exhaustiveness (GAP-201): every NotificationKind returned above, so a
  // kind added to the union without a KIND_META entry is a BUILD ERROR here
  // (and at KIND_META's `satisfies`) until it is classified.
  const _never: never = kind;
  void _never;
  // Runtime only: a row whose kind no union declares any more (a legacy
  // task_nudge from the removed scratchpad) is bell-only — where it badged
  // before (its 'scratchpad' / 'other' bucket was rendered by no row).
  return null;
}

export interface AttentionItem {
  key: string;
  source: AttentionSource;
  /** Whether this is something I must DO (action-required) vs. FYI activity. */
  actionRequired: boolean;
  kind: NotificationRow['kind'] | 'ticket';
  /** The sidebar section this item badges; null = bell-only. */
  section: AttentionSection | null;
  title: string;
  subtitle: string;
  link: string;
  when: string;
  /** Present for notification-sourced items so they can be marked read. */
  notificationId?: string;
}

export interface SectionCount { total: number; actionRequired: number; }
export type SectionCounts = Record<AttentionSection, SectionCount>;

/** The feed's counts, computed once here and read by every surface (the
 *  Center, the cockpit, the dashboard widget, the Command Deck): `all` items,
 *  `action` items, and `activity` (the rest) — see VOCABULARY above — plus
 *  `notifications`, the items that are notification rows: what "Mark all
 *  read" clears, so a surface offers it exactly when there is one (the header
 *  bell's rule), whichever filter is showing. */
export interface AttentionCounts { all: number; action: number; activity: number; notifications: number; }

/** One bucket per section a sidebar row renders — and no other. */
function emptySectionCounts(): SectionCounts {
  return Object.fromEntries(
    NOTIFICATION_SECTIONS.map((s) => [s, { total: 0, actionRequired: 0 }]),
  ) as SectionCounts;
}

/** What every surface reads — the hook's return shape, unchanged by N4. */
export interface TicketNotifications {
  /** The unified feed every surface renders. */
  items: AttentionItem[];
  /** The single count every surface badges (the header bell + Home). */
  count: number;
  /** { all, action, activity, notifications } — the one place the feed is
   *  counted (TAX-7). */
  counts: AttentionCounts;
  /** = counts.action. */
  actionRequiredCount: number;
  /** = counts.activity. */
  unreadCount: number;
  /** Per-sidebar-section counts so each nav item badges only ITS own items. */
  sectionCounts: SectionCounts;
  loading: boolean;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

/** How current and how complete the feed is — for the surfaces that say so
 *  (components/cockpit/AttentionFeed.tsx). Read with useAttentionStatus(). */
export interface AttentionStatus {
  /** The realtime channel errored, timed out or closed (RT-1 dw4): the
   *  numbers may be out of date until it rejoins (the refetches go on). */
  stale: boolean;
  /** A read failed (DELIV-10 dw5): what is shown is the last good read, or
   *  nothing on a first load — never a claim that nothing is unread. */
  error: string | null;
  /** Notification rows the feed lists (the loaded window, stale workflow
   *  alerts left out). */
  notificationsShown: number;
  /** My unread notification rows in the workspace (an exact count), or null
   *  when it could not be read. */
  notificationsTotal: number | null;
  /** Older unread rows exist below the window. */
  hasMoreNotifications: boolean;
  /** Load the next page of older rows (a created_at cursor — TAX-6 dw2). */
  loadMoreNotifications: () => void;
  loadingMore: boolean;
  /** Open tickets the feed evaluated, and how many the scope holds (null =
   *  not counted). They differ only past TICKET_SCAN_CEILING. */
  ticketsLoaded: number;
  ticketsTotal: number | null;
  /** EDGE-3 / ROUTE-7: past the ceiling the evaluated requests are the
   *  longest-waiting (read oldest-modified first), not the most recent. */
  ticketsOldestFirst: boolean;
}

/** The provider's value: the hook's shape plus the status. */
export interface AttentionFeedState {
  value: TicketNotifications;
  status: AttentionStatus;
}

const IDLE_STATUS: AttentionStatus = Object.freeze({
  stale: false,
  error: null,
  notificationsShown: 0,
  notificationsTotal: null,
  hasMoreNotifications: false,
  loadMoreNotifications: () => {},
  loadingMore: false,
  ticketsLoaded: 0,
  ticketsTotal: null,
  ticketsOldestFirst: false,
});

/** The one feed of the tab (AttentionProvider). Null outside it. */
export const AttentionContext = createContext<AttentionFeedState | null>(null);

type TicketQuery = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null; count?: number | null }> & {
  limit: (n: number) => TicketQuery;
  range: (from: number, to: number) => TicketQuery;
};
/** A scope's query: the select (with its count), its filters, and its order —
 *  most recently modified first, or (`oldestFirst`) least recently. */
type TicketScopeBuild = (cols: string, counted: boolean, oldestFirst: boolean) => TicketQuery;

/** One ticket scope, read a page at a time (see OPEN_TICKET_CAP). `build`
 *  starts a fresh query each call (the select with its count, then the
 *  scope's filters and order). A database without one of the attention
 *  columns (42703) is read with '*', as it always was. `single`: one capped
 *  read, uncounted and never paged (a scope that holds closed tickets, read
 *  as it was before the paging — it is not "open requests").
 *
 *  Range pages over a last_modified order can return a ticket twice when it
 *  is modified between two page reads (it moves up into a page already
 *  read), so the rows are deduplicated by id — the first (newest) copy kept
 *  — and the next page starts after the rows read, duplicates included.
 *
 *  EDGE-3 / ROUTE-7 (DF-P9): when the count says the scope holds more than
 *  TICKET_SCAN_CEILING, the pages are read OLDEST first, so the requests
 *  left unevaluated are the most recently touched, never the longest-
 *  neglected (`oldestFirst` in the answer). In that order a ticket modified
 *  between two page reads moves to the end and the row behind it can slip
 *  past one page boundary for that one read; the modification is itself a
 *  tickets event, so the feed reads again straight after. */
async function loadTicketScope(
  build: TicketScopeBuild,
  opts?: { single?: boolean },
): Promise<{ rows: Record<string, unknown>[]; total: number | null; failed: boolean; oldestFirst: boolean }> {
  const single = opts?.single === true;
  let cols = TICKET_ATTENTION_COLUMNS;
  let first = await build(cols, !single, false).limit(OPEN_TICKET_CAP);
  if (first.error && first.error.code === '42703') {
    cols = '*';
    first = await build(cols, !single, false).limit(OPEN_TICKET_CAP);
  }
  if (first.error) return { rows: [], total: null, failed: true, oldestFirst: false };
  const total = !single && typeof first.count === 'number' ? first.count : null;
  const oldestFirst = total !== null && total > TICKET_SCAN_CEILING;
  let rows = [...((first.data as Record<string, unknown>[] | null) ?? [])];
  if (oldestFirst) {
    // Past the ceiling: start again from the oldest end.
    const again = await build(cols, false, true).limit(OPEN_TICKET_CAP);
    if (again.error) return { rows: [], total: null, failed: true, oldestFirst: false };
    rows = [...((again.data as Record<string, unknown>[] | null) ?? [])];
  }
  while (total !== null && rows.length < total && rows.length < TICKET_SCAN_CEILING && rows.length % OPEN_TICKET_CAP === 0) {
    const page = await build(cols, false, oldestFirst).range(rows.length, Math.min(rows.length + OPEN_TICKET_CAP, TICKET_SCAN_CEILING) - 1);
    if (page.error) break;
    const got = (page.data as Record<string, unknown>[] | null) ?? [];
    if (got.length === 0) break;
    rows.push(...got);
  }
  const seen = new Set<unknown>();
  const unique = rows.filter((r) => {
    if (r.id == null) return true;
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  return { rows: unique, total, failed: false, oldestFirst };
}

/** A ticket the feed counts as an open request (the scopes' status filter;
 *  WF-17: CLOSED and CANCELED are both terminal). */
const isOpenTicket = (t: Pick<Ticket, 'status'>) => !isTerminalTicketStatus(t.status);

/**
 * The feed itself — state, fetch, realtime — for ONE consumer: the
 * AttentionProvider (enabled), or a hook used outside it. Disabled, it does
 * nothing (no read, no channel) and answers the empty feed.
 */
export function useAttentionFeedState(enabled: boolean): AttentionFeedState {
  const { roles, activeOrgId, uid, membershipState } = useRole();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // The loaded window, as read (stale workflow alerts included); `hidden`
  // names the stale workflow alerts the feed leaves out.
  const [rawNotifs, setRawNotifs] = useState<NotificationRow[]>([]);
  const rawRef = useRef<NotificationRow[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [notifTotal, setNotifTotal] = useState<number | null>(null);
  const [remainder, setRemainder] = useState<UnreadBeyondRow[]>([]);
  const remainderRef = useRef<UnreadBeyondRow[]>([]);
  // The ids of the tickets the feed holds — a tickets DELETE is acted on only
  // when it is one of these (the unfiltered companion hears every tenant's).
  const ticketIdsRef = useRef<ReadonlySet<string>>(new Set<string>());
  // Whose feed the state holds (`${uid}:${activeOrgId}`): the last good read
  // is kept across refetches of the SAME feed only (DELIV-10 dw5).
  const feedKeyRef = useRef<string | null>(null);
  const [remainderRead, setRemainderRead] = useState(true);
  const [docLibrary, setDocLibrary] = useState<Record<string, string>>({});
  const [ticketTotal, setTicketTotal] = useState<number | null>(null);
  // EDGE-3 / ROUTE-7: the scope was past the ceiling and read oldest first.
  const [ticketsOldestFirst, setTicketsOldestFirst] = useState(false);
  // FRIC-7: the requesters' current collections (an entry per requester of
  // the tickets held; [] = not an active member), read with the tickets.
  const [requesterRoles, setRequesterRoles] = useState<ReadonlyMap<string, readonly string[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pagesRef = useRef(1);
  const requestNowRef = useRef<() => void>(() => {});
  // The reconcile pass's memory, for the life of the tab: rows the server
  // kept (not re-sent for RECONCILE_KEEP_MS), rows it answered it marked
  // (their realtime echo is ignored when it is exactly that mark — RT-8),
  // and the request in flight (its candidates as the feed held them, and the
  // candidates whose mark arrived before the answer).
  const keptAtRef = useRef(new Map<string, number>());
  const echoRef = useRef(new Map<string, { until: number; window: { from: number; to: number }; held: HeldNotification }>());
  const inFlightRef = useRef<null | { sentAt: number; held: Map<string, HeldNotification>; early: Set<string> }>(null);
  const reconcilingRef = useRef(false);
  // WF-24: "must act" is derived from the workflow engine under the org's
  // OWN capability policy — the same inputs the ticket page evaluates — so
  // the badge cannot count a ticket the page will show as view-only.
  const [policy, setPolicy] = useState<CapabilityPolicy | undefined>(undefined);
  // AUTHZ-15 (DF-P9): the policy could not be read and no last good copy was
  // served — "must act" is then NOT counted (the shipped defaults are not the
  // org's policy), and the feed says why. A `stale` answer is the last good
  // policy and counts as usual. Re-read on each feed pass while it holds.
  const [policyFault, setPolicyFault] = useState<string | null>(null);
  const [policyAttempt, setPolicyAttempt] = useState(0);
  const policyFaultRef = useRef<string | null>(null);
  // DRAFT-2 / WF-15: the type-level flags the ticket page evaluates too — an
  // "engineering first" type disables pick-up in the queue, so without them
  // the badge flagged a Drafter the page showed as view-only.
  const [engineeringFirstTypes, setEngineeringFirstTypes] = useState<string[]>([]);
  const [closeWithoutReviewTypes, setCloseWithoutReviewTypes] = useState<string[] | undefined>(undefined);
  // GAP-2 / DEC-12: separation of duties is active at 3+ members, and it
  // DOES change the answer — a Drafter who filed the request is offered only
  // a disabled pick-up in the queue, so the page shows them view-only; the
  // badge must evaluate under the same count or it counts what the page
  // refuses (the unclearable-badge class WF-24 was opened for).
  const [activeMemberCount, setActiveMemberCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    if (!enabled || !activeOrgId) return;
    void loadCapabilityPolicyEntry(activeOrgId).then((entry) => {
      if (!alive) return;
      const fault = affordancePolicyFault(entry);
      policyFaultRef.current = fault;
      setPolicyFault(fault);
      setPolicy(fault ? undefined : entry.policy);
    }).catch((e: unknown) => {
      if (!alive) return;
      const fault = (e as Error)?.message || 'the capability policy could not be read';
      policyFaultRef.current = fault;
      setPolicyFault(fault);
      setPolicy(undefined);
    });
    void supabase
      .from('org_members')
      .select('uid', { count: 'exact', head: true })
      .eq('org_id', activeOrgId)
      .eq('status', 'active')
      .then(({ count }) => { if (alive && typeof count === 'number') setActiveMemberCount(count); }, () => {});
    void supabase
      .from('org_configurations')
      .select('data')
      .eq('org_id', activeOrgId)
      .eq('key', 'drafting')
      .maybeSingle()
      .then(({ data: cfgRow }) => {
        if (!alive) return;
        setEngineeringFirstTypes(flaggedRequestTypes(cfgRow?.data, 'engineeringFirst'));
        const closeTypes = flaggedRequestTypes(cfgRow?.data, 'closeWithoutReview');
        setCloseWithoutReviewTypes(closeTypes.length > 0 ? closeTypes : undefined);
      }, () => {});
    return () => { alive = false; };
  }, [enabled, activeOrgId, policyAttempt]);
  // Unique per feed instance: the provider's one channel, and a test's own.
  const channelId = useId().replace(/[^a-z0-9]/gi, '');

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    // This hook is also mounted PRE-GATE (the notification center panel
    // exists before the protected layout admits the app), where `roles` is
    // still the unresolved placeholder []. Acting then would fetch under the
    // wrong (least-privileged) scope and run the reconciliation as a
    // not-yet-resolved identity — then refetch everything when the real
    // roles land (SESS-5). Wait for the answer instead.
    if (!uid || !activeOrgId || membershipState !== 'member') {
      void (async () => {
        if (alive) {
          feedKeyRef.current = null;
          rawRef.current = []; remainderRef.current = []; ticketIdsRef.current = new Set();
          setTickets([]); setRawNotifs([]); setHidden(new Set()); setNotifTotal(null); setRemainder([]);
          setTicketTotal(null); setTicketsOldestFirst(false); setRequesterRoles(null); setLoadError(null); setLoading(false);
        }
      })();
      return () => { alive = false; };
    }

    // A different person or workspace than the state holds (RoleContext's
    // setActiveOrgId changes activeOrgId alone — membershipState stays
    // 'member' — so the guard above does not reset a workspace switch): clear
    // everything the previous feed showed BEFORE the first read, so a read
    // that fails here keeps nothing of the workspace left behind. A refetch
    // of the same feed (a role change, a rejoin) keeps its last good read.
    const feedKey = `${uid}:${activeOrgId}`;
    if (feedKeyRef.current !== feedKey) {
      void (async () => {
        if (!alive) return;
        feedKeyRef.current = feedKey;
        rawRef.current = []; remainderRef.current = []; ticketIdsRef.current = new Set();
        pagesRef.current = 1;
        keptAtRef.current.clear(); echoRef.current.clear(); inFlightRef.current = null;
        setTickets([]); setRawNotifs([]); setHidden(new Set()); setNotifTotal(null);
        setRemainder([]); setRemainderRead(true); setTicketTotal(null); setTicketsOldestFirst(false); setRequesterRoles(null); setDocLibrary({});
        setLoadError(null); setLoading(true);
      })();
    }

    /** The reconcile pass — after the read, never inside it (RT-8 dw3): send
     *  the candidates to the server, which re-checks and marks the gone ones;
     *  drop what it retired. One pass in flight per feed. */
    const reconcile = async (rows: NotificationRow[], staleWorkflow: ReadonlySet<string>, below: UnreadBeyondRow[]) => {
      if (reconcilingRef.current) return;
      const now = Date.now();
      const kept = keptAtRef.current;
      for (const [id, at] of kept) if (now - at > RECONCILE_KEEP_MS) kept.delete(id);
      const fromWindow = rows
        .filter((r) => {
          const cls = reconcileClassOf(r);
          if (!cls) return false;
          // A workflow alert is sent when the feed has seen it go stale.
          if (cls === 'workflow' && !staleWorkflow.has(r.id)) return false;
          return !kept.has(r.id);
        })
        .map((r) => r.id);
      // The rows below the window count in the badges, so their discharged
      // obligations are sent too (after the window's, within the request's
      // cap). A workflow alert there is not: the feed has not checked its
      // ticket (it is not an action either).
      const fromBelow = below
        .filter((r) => {
          const cls = reconcileClassOf(r);
          return !!cls && cls !== 'workflow' && !kept.has(r.id);
        })
        .map((r) => r.id);
      const ids = [...fromWindow, ...fromBelow].slice(0, RECONCILE_MAX_IDS);
      if (ids.length === 0) return;
      reconcilingRef.current = true;
      // RT-8 dw2: the server marks each row BEFORE it answers, so a mark's
      // realtime UPDATE can arrive while the request is in flight. Nothing
      // is pre-registered as an echo: the candidates are kept as the feed
      // held them, and an UPDATE to one in that gap is held back (not a
      // refetch) only when it changes nothing but a fresh
      // metadata.superseded_at (isReconcileMark). Anything else — the
      // recipient's own mark-read on a row they just clicked, any other
      // edit — refetches at once, as before. Once the server answers, a
      // held-back mark on a row it did NOT retire was someone else's, and
      // refetches; the retired rows whose echo has not arrived yet are
      // registered, by id, for RECONCILE_ECHO_MS.
      const echo = echoRef.current;
      const held = new Map<string, HeldNotification>();
      const byId = new Map<string, HeldNotification>();
      for (const r of rows) byId.set(r.id, r);
      for (const r of below) if (!byId.has(r.id)) byId.set(r.id, r);
      for (const id of ids) { const h = byId.get(id); if (h) held.set(id, h); }
      const flight = { sentAt: Date.now(), held, early: new Set<string>() };
      inFlightRef.current = flight;
      try {
        const answer = await requestReconcile(activeOrgId, ids);
        const at = Date.now();
        if (inFlightRef.current === flight) inFlightRef.current = null;
        // Not answered (offline, no session, a route not deployed): nothing
        // is retired and every row keeps showing; it is asked again after
        // RECONCILE_KEEP_MS, not on every refetch. A mark held back meanwhile
        // was not proven ours: refetch.
        if (!answer) {
          for (const id of ids) kept.set(id, at);
          if (flight.early.size > 0 && alive) schedule();
          return;
        }
        if (!alive) return;
        const retired = new Set(answer.retired);
        for (const id of ids) if (!retired.has(id)) kept.set(id, at);
        if ([...flight.early].some((id) => !retired.has(id))) schedule();
        const window = { from: flight.sentAt, to: at };
        for (const id of retired) {
          const h = held.get(id);
          if (h && !flight.early.has(id)) echo.set(id, { until: at + RECONCILE_ECHO_MS, window, held: h });
        }
        if (retired.size === 0) return;
        const current = rawRef.current;
        const gone = current.filter((r) => retired.has(r.id)).length;
        const goneBelow = remainderRef.current.filter((r) => retired.has(r.id)).length;
        if (goneBelow > 0) {
          const nextBelow = remainderRef.current.filter((r) => !retired.has(r.id));
          remainderRef.current = nextBelow;
          setRemainder(nextBelow);
        }
        if (gone > 0) {
          const next = current.filter((r) => !retired.has(r.id));
          rawRef.current = next;
          setRawNotifs(next);
        }
        if (gone + goneBelow > 0) {
          const loaded = rawRef.current.length;
          setNotifTotal((t) => (t === null ? t : Math.max(loaded, t - gone - goneBelow)));
        }
        setHidden((prev) => {
          if (![...prev].some((id) => retired.has(id))) return prev;
          return new Set([...prev].filter((id) => !retired.has(id)));
        });
      } finally {
        if (inFlightRef.current === flight) inFlightRef.current = null;
        reconcilingRef.current = false;
      }
    };

    const fetchAll = async () => {
      let failure: string | null = null;
      try {
        // 1) My tickets, scoped by role (same visibility rules as the portal).
        let list: Ticket[] | null = null;
        let total: number | null = null;
        let oldestFirstRead = false;
        if (isQueueViewer(roles) || isEngineerRole(roles) || roles.includes('DocCtrl')) {
          const scope = await loadTicketScope((cols, counted, oldestFirst) => supabase.from('tickets').select(cols, counted ? { count: 'exact' } : undefined).eq('org_id', activeOrgId).not('status', 'in', '("CLOSED","CANCELED")').order('last_modified', { ascending: oldestFirst }) as unknown as TicketQuery);
          if (!scope.failed) { list = scope.rows.map((r) => fromDbTicket(r)); total = scope.total; oldestFirstRead = scope.oldestFirst; }
        } else if (roles.includes('Drafter')) {
          // The drafter's assigned tickets: the OPEN ones paged with a count
          // (TRAIL-7), and the closed ones in one capped, uncounted read as
          // before the paging — a long-tenured drafter's thousands of closed
          // tickets are never paged on every refetch. EDGE-3 (DF-P9): a
          // closed ticket enters the feed only while it is unread for me, so
          // the closed read asks the server for exactly those (unread_by
          // holds me) — closed rows the feed would drop never fill its cap.
          const [assigned, assignedClosed, pool] = await Promise.all([
            loadTicketScope((cols, counted, oldestFirst) => supabase.from('tickets').select(cols, counted ? { count: 'exact' } : undefined).eq('org_id', activeOrgId).eq('assigned_drafter_id', uid).not('status', 'in', '("CLOSED","CANCELED")').order('last_modified', { ascending: oldestFirst }) as unknown as TicketQuery),
            loadTicketScope((cols, counted) => supabase.from('tickets').select(cols, counted ? { count: 'exact' } : undefined).eq('org_id', activeOrgId).eq('assigned_drafter_id', uid).in('status', [...TERMINAL_TICKET_STATUSES]).contains('unread_by', [uid]).order('last_modified', { ascending: false }) as unknown as TicketQuery, { single: true }),
            loadTicketScope((cols, counted, oldestFirst) => supabase.from('tickets').select(cols, counted ? { count: 'exact' } : undefined).eq('org_id', activeOrgId).eq('status', 'PENDING_ASSIGNMENT').order('last_modified', { ascending: oldestFirst }) as unknown as TicketQuery),
          ]);
          if (!assigned.failed && !assignedClosed.failed && !pool.failed) {
            const map = new Map<string, Ticket>();
            for (const row of [...assigned.rows, ...pool.rows, ...assignedClosed.rows]) {
              const t = fromDbTicket(row);
              if (!map.has(t.id!)) map.set(t.id!, t);
            }
            list = Array.from(map.values());
            // The two open scopes can overlap, so their counts are summed
            // only when one was cut at the ceiling.
            const cut = (x: { rows: unknown[]; total: number | null }) => x.total !== null && x.rows.length < x.total;
            total = cut(assigned) || cut(pool) ? (assigned.total ?? 0) + (pool.total ?? 0) : list.filter(isOpenTicket).length;
            oldestFirstRead = assigned.oldestFirst || pool.oldestFirst;
          }
        } else {
          const scope = await loadTicketScope((cols, counted, oldestFirst) => supabase.from('tickets').select(cols, counted ? { count: 'exact' } : undefined).eq('org_id', activeOrgId).eq('requester_id', uid).not('status', 'in', '("CLOSED","CANCELED")').order('last_modified', { ascending: oldestFirst }) as unknown as TicketQuery);
          if (!scope.failed) { list = scope.rows.map((r) => fromDbTicket(r)); total = scope.total; oldestFirstRead = scope.oldestFirst; }
        }
        if (list === null) failure = 'Your requests could not be loaded.';

        // 1b) FRIC-7: the requesters' current collections — the input the
        //     ticket page and the route give the engine, so a departed
        //     requester's co-review is counted here too. A failed read is
        //     "unknown" (null): every requester assumed present, as before.
        let requesterMap: Map<string, string[]> | null = null;
        if (list !== null) {
          requesterMap = await loadRequesterRoles(activeOrgId, list.map((t) => t.requesterId));
        }
        // AUTHZ-15: while the policy is unreadable, read it again each pass.
        if (policyFaultRef.current && alive) setPolicyAttempt((n) => n + 1);

        // 2) My unread in-app notifications (the bell's events), scoped to the
        //    active workspace: the newest page, and older pages on request
        //    (a created_at cursor); the true count alongside (TAX-6, DELIV-10).
        //    A failed read is an error the surfaces show (DELIV-10 dw5) and
        //    keeps the last good window — never an empty "all caught up".
        let n: NotificationRow[] | null = [];
        let cursor: NotificationCursor | null = null;
        try {
          for (let page = 0; page < pagesRef.current; page++) {
            const got = await listMyNotifications({ onlyUnread: true, limit: NOTIFICATION_PAGE_SIZE, orgId: activeOrgId, before: cursor });
            n.push(...got);
            if (got.length < NOTIFICATION_PAGE_SIZE) break;
            const tail = got[got.length - 1];
            cursor = { createdAt: tail.createdAt, id: tail.id };
          }
        } catch {
          n = null;
          failure = 'Your notifications could not be loaded.';
        }
        let unreadTotal: number | null = null;
        try { unreadTotal = await countUnread(activeOrgId); } catch { failure = failure ?? 'Your unread count could not be read.'; }

        // 3) Stale workflow alerts. A workflow notification (one that carries
        //    metadata.action) means "this ticket entered state X — someone must
        //    act". Once the ticket LEAVES state X (advanced, reassigned, or
        //    closed) that alert is moot, but it lingers unread until the
        //    recipient happens to open the ticket. We detect those — the
        //    ticket's live status no longer matches the alert's recorded
        //    status, or the ticket is no longer live in this workspace — and
        //    leave them out so the bell, the sidebar badge, and the portal can
        //    never disagree.
        //    drafting-flow EVID-13 (DF-P1): read_at is the recipient's own act
        //    of opening a row (the only "did they see it" signal), so nothing
        //    stamps it. The workflow route marks a retired alert
        //    metadata.superseded_at (the unread list already omits those). One
        //    the route missed — a ticket the shed archived, a status reached by
        //    a path that does not fan out — is marked the same way by the
        //    reconcile pass on the SERVER (NEDGE-18: since 20261161 the
        //    browser may change only read_at), so it leaves the unread window
        //    for good instead of filling it. A failed ticket read proves
        //    nothing, so in that case nothing is left out or sent.
        const staleSet = new Set<string>();
        const rawWindow = n;
        if (n) {
          const workflowRows = n.filter(
            (r) => r.resourceId
              && r.metadata
              && typeof r.metadata.status === 'string'
              && r.metadata.action != null,
          );
          if (workflowRows.length > 0) {
            const refIds = Array.from(new Set(workflowRows.map((r) => r.resourceId as string)));
            const { data: liveRows, error: liveErr } = await supabase
              .from('tickets').select('id, status').eq('org_id', activeOrgId).in('id', refIds);
            const statusById = new Map<string, string>();
            for (const row of (liveRows || []) as Array<{ id: string; status: string }>) {
              statusById.set(row.id, row.status);
            }
            // An SLA notice stays while its request is open: only CLOSED /
            // CANCELED (or the ticket's absence) retires it — the workflow
            // route's rule (lib/ticketSla.ts SLA_NOTICE_ACTIONS; DF-P3 fix
            // pass 3, EDGE-7). Every other alert is moot once its ticket
            // left the recorded status.
            const staleRows = liveErr ? [] : workflowRows
              .filter((r) => workflowAlertGone(r.metadata, statusById.get(r.resourceId as string), SLA_NOTICE_ACTIONS));
            for (const r of staleRows) staleSet.add(r.id);
            if (staleSet.size > 0) n = n.filter((r) => !staleSet.has(r.id));
          }
        }

        // 4) The rows below the window, tallied by kind into the badges
        //    (TAX-6 dw1) — only when the count says there are any.
        let beyond: UnreadBeyondRow[] = [];
        let beyondRead = true;
        if (rawWindow && unreadTotal !== null && unreadTotal > rawWindow.length) {
          // After the window's last row, by the same keyset — never an
          // offset, which a row sharing a created_at could straddle.
          const tail = rawWindow[rawWindow.length - 1];
          try {
            beyond = await listUnreadKindsBeyond(activeOrgId, tail ? { createdAt: tail.createdAt, id: tail.id } : null, REMAINDER_TALLY_CAP);
          } catch {
            beyondRead = false;
          }
        }

        // 5) TRAIL-12: a document row written without a link (its producer
        //    did not know the library) links to the document in its library —
        //    resolved in ONE batched read — never to a search for its id.
        const unlinked = (n ?? []).filter((r) => !r.link && r.resourceType === 'document' && r.resourceId).map((r) => r.resourceId as string);
        let libs: Record<string, string> | null = null;
        if (unlinked.length > 0) {
          const { data: docRows } = await supabase
            .from('documents').select('id, library_id').eq('org_id', activeOrgId).in('id', Array.from(new Set(unlinked)));
          libs = {};
          for (const d of (docRows || []) as Array<{ id: string; library_id: string | null }>) {
            if (d.library_id) libs[d.id] = d.library_id;
          }
        }

        if (alive) {
          if (list !== null) {
            ticketIdsRef.current = new Set(list.map((t) => t.id).filter((x): x is string => !!x));
            setTickets(list); setTicketTotal(total); setTicketsOldestFirst(oldestFirstRead);
            setRequesterRoles(requesterMap);
          }
          if (rawWindow !== null) {
            rawRef.current = rawWindow;
            setRawNotifs(rawWindow);
            setHidden(staleSet);
            setNotifTotal(unreadTotal === null ? null : Math.max(unreadTotal, rawWindow.length));
            remainderRef.current = beyond;
            setRemainder(beyond);
            setRemainderRead(beyondRead);
          } else if (unreadTotal !== null) {
            setNotifTotal(unreadTotal);
          }
          if (libs) { const add = libs; setDocLibrary((prev) => ({ ...prev, ...add })); }
          setLoadError(failure);
          setLoading(false);
        }
        if (alive && rawWindow) void reconcile(rawWindow, staleSet, beyond);
      } catch (e) {
        console.error('Attention feed fetch failed', e);
        if (alive) { setLoadError('The attention feed could not be loaded.'); setLoading(false); }
      }
    };

    // One fetch at a time; a request while one runs queues exactly one more.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let again = false;
    const run = async () => {
      if (!alive) return;
      if (running) { again = true; return; }
      running = true;
      try { await fetchAll(); } finally {
        running = false;
        if (alive) setLoadingMore(false);
        if (again && alive) { again = false; void run(); }
      }
    };
    /** RT-3 dw2: a burst collapses into one trailing refetch. */
    const schedule = (delay: number = FETCH_DEBOUNCE_MS) => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void run(); }, delay);
    };
    requestNowRef.current = () => schedule(0);

    void run();

    /** A notifications event: the echo of the reconcile pass's own mark is
     *  not a reason to refetch (RT-8 dw2) — and nothing else is passed over.
     *  An UPDATE is held back only when it changes nothing but a fresh
     *  metadata.superseded_at (isReconcileMark) on a row the server answered
     *  it retired, or on a candidate of the request in flight (decided when
     *  the answer comes); one echo per row. A mark-read, any other edit, an
     *  INSERT or a DELETE refetches. */
    const onNotification = (payload: { eventType?: string; new?: Record<string, unknown> | null } | undefined) => {
      if (!alive) return;
      const next = payload?.new ?? null;
      const id = typeof next?.id === 'string' ? next.id : null;
      const echo = echoRef.current;
      const now = Date.now();
      for (const [k, e] of echo) if (e.until < now) echo.delete(k);
      if (payload?.eventType === 'UPDATE' && id) {
        const flight = inFlightRef.current;
        if (flight && flight.held.has(id) && !flight.early.has(id)
          && isReconcileMark(next, flight.held.get(id), { from: flight.sentAt, to: now })) {
          flight.early.add(id);
          return;
        }
        const e = echo.get(id);
        if (e) {
          echo.delete(id);
          if (isReconcileMark(next, e.held, e.window)) return;
        }
      }
      schedule();
    };

    let joined = false;
    const channel = supabase
      .channel(`attention-${activeOrgId}-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `org_id=eq.${activeOrgId}` },
        () => { if (alive) schedule(); })
      // RT-4: Supabase does not filter DELETE events, so the org filter above
      // never hears one. This unfiltered companion (lib/libraryCollections.ts's
      // pattern) hears EVERY tenant's tickets DELETEs — the old record's
      // primary key alone — so, unlike that one, it acts only on a ticket
      // this feed holds: a bulk delete elsewhere is not a refetch for
      // everyone online. No app path hard-deletes a ticket, so it is rare
      // (DEC-105 §4 records the id exposure).
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tickets' },
        (payload) => {
          if (!alive) return;
          const gone = (payload as { old?: { id?: string } | null } | undefined)?.old?.id;
          if (gone && ticketIdsRef.current.has(gone)) schedule();
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` },
        (payload) => onNotification(payload as unknown as { eventType?: string; new?: Record<string, unknown> | null }))
      // RT-1: the channel's status is watched. Every join after the first is a
      // rejoin after a drop, and no event missed meanwhile is replayed — so a
      // rejoin reconciles the whole feed. An error, a timeout or a close says
      // the numbers may be stale until it rejoins.
      .subscribe((status: string) => {
        if (!alive) return;
        if (status === 'SUBSCRIBED') {
          setStale(false);
          if (joined) schedule();
          joined = true;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setStale(true);
        }
      });

    // RT-1: the tab coming back, and a visible-only safety net.
    const onReturn = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') schedule();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    const poll = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') schedule();
    }, VISIBLE_POLL_MS);

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      requestNowRef.current = () => {};
      supabase.removeChannel(channel);
    };
  }, [enabled, roles, activeOrgId, uid, channelId, membershipState]);

  const notifs = useMemo(
    () => (hidden.size === 0 ? rawNotifs : rawNotifs.filter((r) => !hidden.has(r.id))),
    [rawNotifs, hidden],
  );

  const { items, counts, sectionCounts } = useMemo(() => {
    const out: AttentionItem[] = [];
    const ticketIds = new Set<string>();

    // Index the most recent notification per ticket so a ticket row can carry
    // the latest activity's description + deep-link (e.g. straight to a comment)
    // instead of dropping you at the top of the ticket.
    const notifByTicket = new Map<string, NotificationRow>();
    for (const n of notifs) {
      if (n.resourceId && !notifByTicket.has(n.resourceId)) notifByTicket.set(n.resourceId, n);
    }

    const sectionCounts = emptySectionCounts();
    const tally = (section: AttentionSection, actionReq: boolean) => {
      sectionCounts[section].total++;
      if (actionReq) sectionCounts[section].actionRequired++;
    };

    for (const t of tickets) {
      // AUTHZ-15: an unreadable policy counts nothing as "must act" (the
      // defaults are not the org's policy); the feed says so (status.error).
      const actionReq = !policyFault && isActionRequired(t, { uid, roles, policy, engineeringFirstTypes, closeWithoutReviewTypes, activeMemberCount, requesterRoles });
      const unread = !!uid && !!t.unreadBy?.includes(uid);
      if (!actionReq && !unread) continue;
      const matched = t.id ? notifByTicket.get(t.id) : undefined;
      out.push({
        key: `ticket:${t.id}`,
        source: 'ticket',
        actionRequired: actionReq,
        kind: 'ticket',
        section: 'requests',
        title: `${t.ticketId || ''} ${t.title || ''}`.trim() || 'Request',
        subtitle: actionReq ? attentionLabel(t.status, { hasDrafter: !!t.assignedDrafterId }) : (matched?.title || 'New activity'),
        // Prefer the latest notification's deep-link (e.g. ?c=<commentId>) even
        // for action-required tickets, so clicking lands on (and highlights) the
        // new comment instead of the top of the ticket.
        link: matched?.link || `/requests/${t.id}`,
        when: String(t.lastModified || t.createdAt || ''),
      });
      tally('requests', actionReq);
      if (t.id) ticketIds.add(t.id);
    }

    for (const n of notifs) {
      // Dedupe: if a ticket is already in the feed, fold its notification in.
      if (n.resourceId && ticketIds.has(n.resourceId)) continue;
      const section = sectionForKind(n.kind);
      // KIND_META decides what is an action: the conflict class (a stale-base
      // branch, a lost checkout, an edit overlap) and the PSM obligations
      // whose rows the reconcile pass clears once discharged (DEC-81 §2) —
      // per row through isActionRow, which keeps the cron's review-health
      // nudge (a review_overdue nothing clears) FYI (DEC-90 A11). A legacy
      // kind no union declares is FYI.
      const actionRequired = isActionRow(n);
      const library = n.resourceId ? docLibrary[n.resourceId] : undefined;
      out.push({
        key: `notif:${n.id}`,
        source: 'notification',
        actionRequired,
        kind: n.kind,
        section,
        title: n.title,
        subtitle: n.body || '',
        // TRAIL-12: a document row without a link opens the document in its
        // library (resolved by one batched read), or the Documents home when
        // the library cannot be read — never a search for a raw id, which
        // nothing in search matches.
        link: n.link || (n.resourceId
          ? (n.resourceType === 'document' ? (library ? `/documents/${library}?doc=${n.resourceId}` : '/documents')
             : n.resourceType === 'library' ? `/documents/${n.resourceId}`
             : `/requests/${n.resourceId}`)
          : '/inbox'),
        when: n.createdAt,
        notificationId: n.id,
      });
      // TRAIL-5: the computed flag reaches the tally, so a notification can
      // turn its row's badge red. A bell-only kind tallies into no row.
      if (section) tally(section, actionRequired);
    }

    out.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
    let action = out.filter((i) => i.actionRequired).length;
    let notifications = out.filter((i) => i.source === 'notification').length;
    let all = out.length;

    // TAX-6 dw1 / TRAIL-7 dw1: the unread rows below the loaded window count
    // too — by kind into their section and the action count (a row about a
    // ticket already in the feed folds in, as above) — and any the tally
    // could not reach count in the total as activity. The list pages them in
    // on request; the number never waits for that.
    const rawLoaded = rawNotifs.length;
    if (notifTotal !== null && notifTotal > rawLoaded) {
      let tallied = 0;
      for (const r of remainder) {
        tallied++;
        if (r.resourceId && ticketIds.has(r.resourceId)) continue;
        const section = sectionForKind(r.kind as NotificationRow['kind']);
        const actionReq = isActionRow(r);
        all++; notifications++;
        if (actionReq) action++;
        if (section) tally(section, actionReq);
      }
      const untallied = Math.max(0, notifTotal - rawLoaded - (remainderRead ? tallied : 0));
      all += untallied; notifications += untallied;
    }
    const counts: AttentionCounts = { all, action, activity: all - action, notifications };
    return { items: out, counts, sectionCounts };
  }, [tickets, notifs, rawNotifs, notifTotal, remainder, remainderRead, docLibrary, uid, roles, policy, policyFault, engineeringFirstTypes, closeWithoutReviewTypes, activeMemberCount, requesterRoles]);

  const markAll = useCallback(() => markAllRead(activeOrgId), [activeOrgId]);
  const value = useMemo<TicketNotifications>(() => ({
    /** The unified feed every surface renders. */
    items,
    /** The single count every surface badges (the header bell + Home) — the
     *  true count, including unread rows below the loaded window (TAX-6). */
    count: counts.all,
    /** { all, action, activity, notifications } — the one place the feed is
     *  counted (TAX-7). */
    counts,
    /** = counts.action: every action item, tickets AND notifications (TRAIL-13
     *  — it used to count tickets only, so the Command Deck's Action stat
     *  disagreed with the Center's Action tab it opens). */
    actionRequiredCount: counts.action,
    /** = counts.activity: the feed's non-action items (the "Activity" filter)
     *  — not DB-unread and not ticket-unread; see VOCABULARY above. */
    unreadCount: counts.activity,
    /** Per-sidebar-section counts so each nav item badges only ITS own items. */
    sectionCounts,
    loading,
    // Re-exported so the bell can mark notification rows read without another import.
    markRead,
    // Scoped to the active workspace so "mark all read" clears only this
    // workspace's bell, not every workspace the user belongs to.
    markAllRead: markAll,
  }), [items, counts, sectionCounts, loading, markAll]);

  const loadMoreNotifications = useCallback(() => {
    pagesRef.current += 1;
    setLoadingMore(true);
    requestNowRef.current();
  }, []);
  // The feed's ticket list can hold a drafter's closed (unread) tickets; the
  // "N of M open requests" line counts the open ones.
  const openTicketsLoaded = useMemo(() => tickets.filter(isOpenTicket).length, [tickets]);
  const status = useMemo<AttentionStatus>(() => ({
    stale,
    error: loadError ?? (policyFault ? 'Permissions could not be read, so requests that need you are not counted until they can be.' : null),
    notificationsShown: notifs.length,
    notificationsTotal: notifTotal === null ? null : Math.max(notifs.length, notifTotal - hidden.size),
    hasMoreNotifications: notifTotal !== null && notifTotal > rawNotifs.length,
    loadMoreNotifications,
    loadingMore,
    ticketsLoaded: openTicketsLoaded,
    ticketsTotal: ticketTotal,
    ticketsOldestFirst,
  }), [stale, loadError, policyFault, notifs.length, notifTotal, hidden.size, rawNotifs.length, loadMoreNotifications, loadingMore, openTicketsLoaded, ticketTotal, ticketsOldestFirst]);

  return useMemo(() => ({ value, status }), [value, status]);
}

/** The attention feed. Inside AttentionProvider (the protected layout) every
 *  caller reads the tab's ONE feed; outside it (a test, a preview) this runs
 *  its own copy. The return shape is the one every surface has always read. */
export function useTicketNotifications(): TicketNotifications {
  const shared = useContext(AttentionContext);
  const own = useAttentionFeedState(shared === null);
  return (shared ?? own).value;
}

/** How current and complete the feed is (stale channel, a failed read, the
 *  rows below the window and how to page them). Idle outside the provider. */
export function useAttentionStatus(): AttentionStatus {
  return useContext(AttentionContext)?.status ?? IDLE_STATUS;
}
