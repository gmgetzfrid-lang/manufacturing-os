import { useState, useEffect, useMemo, useId } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { Ticket } from '@/types/schema';
import {
  listMyNotifications, markRead, markAllRead, type NotificationRow,
} from '@/lib/inAppNotifications';
import {
  isActionRequired, attentionLabel, isQueueViewer, isEngineerRole,
} from '@/lib/ticketAttention';
import { loadCapabilityPolicy, type CapabilityPolicy } from '@/lib/capabilityPolicy';
import { flaggedRequestTypes } from '@/lib/requestTypes';
import {
  KIND_META, NOTIFICATION_SECTIONS, isNotificationKind, kindMeta, type NotificationSection,
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
// Both the ticket feed AND the notification rows are scoped to the active
// workspace, and stale workflow alerts (whose ticket has already moved on) are
// reconciled away — so the badge can never disagree with the portal.
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

// Cap open-ticket fetches so the attention feed can't pull an unbounded set
// (and re-pull it on every realtime change). Newest-first, so the most
// recently active tickets — the ones likely to need attention — are kept.
const OPEN_TICKET_CAP = 500;

function fromDbTicket(row: Record<string, unknown>): Ticket {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    ticketId: row.ticket_id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    unit: row.unit as string,
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

export function useTicketNotifications() {
  const { roles, activeOrgId, uid, membershipState } = useRole();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [notifs, setNotifs] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  // WF-24: "must act" is derived from the workflow engine under the org's
  // OWN capability policy — the same inputs the ticket page evaluates — so
  // the badge cannot count a ticket the page will show as view-only.
  const [policy, setPolicy] = useState<CapabilityPolicy | undefined>(undefined);
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
    if (!activeOrgId) return;
    void loadCapabilityPolicy(activeOrgId).then((p) => { if (alive) setPolicy(p); }).catch(() => {});
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
  }, [activeOrgId]);
  // Unique per hook instance so multiple consumers (sidebar/bell/inbox) don't
  // collide on the same realtime channel name.
  const channelId = useId().replace(/[^a-z0-9]/gi, '');

  useEffect(() => {
    let alive = true;

    // This hook is also mounted PRE-GATE (the notification center panel
    // exists before the protected layout admits the app), where `roles` is
    // still the unresolved placeholder []. Acting then would fetch under the
    // wrong (least-privileged) scope and run the mark-read reconciliation as
    // a not-yet-resolved identity — then refetch everything when the real
    // roles land (SESS-5). Wait for the answer instead.
    if (!uid || !activeOrgId || membershipState !== 'member') {
      void (async () => { if (alive) { setTickets([]); setNotifs([]); setLoading(false); } })();
      return () => { alive = false; };
    }

    const fetchAll = async () => {
      try {
        // 1) My tickets, scoped by role (same visibility rules as the portal).
        let list: Ticket[] = [];
        if (isQueueViewer(roles) || isEngineerRole(roles) || roles.includes('DocCtrl')) {
          const { data } = await supabase.from('tickets').select('*').eq('org_id', activeOrgId).not('status', 'in', '("CLOSED","CANCELED")').order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP);
          list = (data || []).map((r) => fromDbTicket(r as Record<string, unknown>));
        } else if (roles.includes('Drafter')) {
          const [assigned, pool] = await Promise.all([
            supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('assigned_drafter_id', uid).order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP),
            supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('status', 'PENDING_ASSIGNMENT').order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP),
          ]);
          const map = new Map<string, Ticket>();
          for (const row of [...(assigned.data || []), ...(pool.data || [])]) {
            const t = fromDbTicket(row as Record<string, unknown>);
            map.set(t.id!, t);
          }
          list = Array.from(map.values());
        } else {
          const { data } = await supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('requester_id', uid).not('status', 'in', '("CLOSED","CANCELED")').order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP);
          list = (data || []).map((r) => fromDbTicket(r as Record<string, unknown>));
        }

        // 2) My unread in-app notifications (the bell's events), scoped to the
        //    active workspace.
        let n = await listMyNotifications({ onlyUnread: true, limit: 50, orgId: activeOrgId })
          .catch(() => [] as NotificationRow[]);

        // 3) Reconcile stale workflow alerts. A workflow notification (one that
        //    carries metadata.action) means "this ticket entered state X —
        //    someone must act". Once the ticket LEAVES state X (advanced,
        //    reassigned, or closed) that alert is moot, but it lingers unread
        //    until the recipient happens to open the ticket. We detect those —
        //    the ticket's live status no longer matches the alert's recorded
        //    status, or the ticket is no longer live in this workspace — and
        //    leave them out so the bell, the sidebar badge, and the portal
        //    can never disagree.
        //    drafting-flow EVID-13 (DF-P1): read_at is the recipient's own act
        //    of opening a row (the only "did they see it" signal), so no
        //    reconciliation stamps it. The workflow route marks a retired alert
        //    metadata.superseded_at (the unread list already omits those). This
        //    catches any the route missed, e.g. a ticket the shed archived or
        //    a status reached by a path that does not fan out, and marks it
        //    the same way, in the recipient's own session on their own rows.
        //    Otherwise those rows would stay unread forever, fill the 50-row
        //    window and push live alerts off it. A failed ticket read proves
        //    nothing, so in that case nothing is marked or left out.
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
          const staleRows = liveErr ? [] : workflowRows
            .filter((r) => statusById.get(r.resourceId as string) !== (r.metadata!.status as string));
          if (staleRows.length > 0) {
            const staleSet = new Set(staleRows.map((r) => r.id));
            n = n.filter((r) => !staleSet.has(r.id));
            // Best-effort: the filter above already hides them, so a refused
            // mark never touches the feed.
            const supersededAt = new Date().toISOString();
            try {
              await Promise.all(staleRows.map((r) => supabase
                .from('notifications')
                .update({ metadata: { ...(r.metadata ?? {}), superseded_at: supersededAt } })
                .eq('id', r.id).eq('user_id', uid).is('read_at', null)
                .then(() => undefined, () => undefined)));
            } catch { /* the next load retries */ }
          }
        }

        if (alive) { setTickets(list); setNotifs(n); setLoading(false); }
      } catch (e) {
        console.error('Attention feed fetch failed', e);
        if (alive) setLoading(false);
      }
    };

    void fetchAll();

    const channel = supabase
      .channel(`attention-${activeOrgId}-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `org_id=eq.${activeOrgId}` },
        () => { if (alive) void fetchAll(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` },
        () => { if (alive) void fetchAll(); })
      .subscribe();

    return () => { alive = false; supabase.removeChannel(channel); };
  }, [roles, activeOrgId, uid, channelId, membershipState]);

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
      const actionReq = isActionRequired(t, { uid, roles, policy, engineeringFirstTypes, closeWithoutReviewTypes, activeMemberCount });
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
        subtitle: actionReq ? attentionLabel(t.status) : (matched?.title || 'New activity'),
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
      // branch, a lost checkout, an edit overlap). A legacy kind no union
      // declares is FYI.
      const actionRequired = kindMeta(n.kind)?.actionRequired ?? false;
      out.push({
        key: `notif:${n.id}`,
        source: 'notification',
        actionRequired,
        kind: n.kind,
        section,
        title: n.title,
        subtitle: n.body || '',
        link: n.link || (n.resourceId
          ? (n.resourceType === 'document' ? `/search?q=${encodeURIComponent(n.resourceId)}`
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
    const action = out.filter((i) => i.actionRequired).length;
    const notifications = out.filter((i) => i.source === 'notification').length;
    const counts: AttentionCounts = { all: out.length, action, activity: out.length - action, notifications };
    return { items: out, counts, sectionCounts };
  }, [tickets, notifs, uid, roles, policy, engineeringFirstTypes, closeWithoutReviewTypes, activeMemberCount]);

  return {
    /** The unified feed every surface renders. */
    items,
    /** The single count every surface badges (the header bell + Home). */
    count: items.length,
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
    markAllRead: () => markAllRead(activeOrgId),
  };
}
