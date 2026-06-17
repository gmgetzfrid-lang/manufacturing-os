import { useState, useEffect, useMemo, useId } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { Ticket } from '@/types/schema';
import {
  listMyNotifications, markRead, markAllRead, markManyRead, type NotificationRow,
} from '@/lib/inAppNotifications';
import {
  isActionRequired, attentionLabel, isManagementRole, isEngineerRole,
} from '@/lib/ticketAttention';

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
// ─────────────────────────────────────────────────────────────────────────────

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
 *  badges so a scratchpad nudge never shows up on the Drafting Requests item,
 *  and vice-versa. 'other' is anything not pinned to a specific section. */
export type AttentionSection = 'requests' | 'scratchpad' | 'documents' | 'projects' | 'other';

/** Map a notification kind (or a ticket row) to the section it belongs to. */
export function sectionForKind(kind: NotificationRow['kind'] | 'ticket'): AttentionSection {
  switch (kind) {
    case 'ticket':
    case 'ticket_comment':
    case 'ticket_mention':
    case 'ticket_status':
    case 'ticket_assigned':
    case 'request_pending_approval':
      return 'requests';
    case 'task_nudge':
    case 'task_overdue_digest':
    case 'morning_digest':
      return 'scratchpad';
    case 'doc_superseded':
    case 'markup_request':
    case 'checkout_conflict':
    case 'checkout_handoff':
    case 'checkout_message':
    case 'hold_opened':
    case 'hold_released':
      return 'documents';
    case 'project_member':
    case 'project_status':
    case 'milestone_assigned':
    case 'milestone_attention':
    case 'milestone_overdue':
      return 'projects';
    default:
      return 'other';
  }
}

export interface AttentionItem {
  key: string;
  source: AttentionSource;
  /** Whether this is something I must DO (action-required) vs. FYI activity. */
  actionRequired: boolean;
  kind: NotificationRow['kind'] | 'ticket';
  /** The sidebar section this item badges. */
  section: AttentionSection;
  title: string;
  subtitle: string;
  link: string;
  when: string;
  /** Present for notification-sourced items so they can be marked read. */
  notificationId?: string;
}

export interface SectionCount { total: number; actionRequired: number; }
export type SectionCounts = Record<AttentionSection, SectionCount>;

function emptySectionCounts(): SectionCounts {
  return {
    requests: { total: 0, actionRequired: 0 },
    scratchpad: { total: 0, actionRequired: 0 },
    documents: { total: 0, actionRequired: 0 },
    projects: { total: 0, actionRequired: 0 },
    other: { total: 0, actionRequired: 0 },
  };
}

export function useTicketNotifications() {
  const { roles, activeOrgId, uid } = useRole();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [notifs, setNotifs] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Unique per hook instance so multiple consumers (sidebar/bell/inbox) don't
  // collide on the same realtime channel name.
  const channelId = useId().replace(/[^a-z0-9]/gi, '');

  useEffect(() => {
    let alive = true;

    if (!uid || !activeOrgId) {
      void (async () => { if (alive) { setTickets([]); setNotifs([]); setLoading(false); } })();
      return () => { alive = false; };
    }

    const fetchAll = async () => {
      try {
        // 1) My tickets, scoped by role (same visibility rules as the portal).
        let list: Ticket[] = [];
        if (isManagementRole(roles) || isEngineerRole(roles) || roles.includes('DocCtrl')) {
          const { data } = await supabase.from('tickets').select('*').eq('org_id', activeOrgId).neq('status', 'CLOSED');
          list = (data || []).map((r) => fromDbTicket(r as Record<string, unknown>));
        } else if (roles.includes('Drafter')) {
          const [assigned, pool] = await Promise.all([
            supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('assigned_drafter_id', uid),
            supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('status', 'PENDING_ASSIGNMENT'),
          ]);
          const map = new Map<string, Ticket>();
          for (const row of [...(assigned.data || []), ...(pool.data || [])]) {
            const t = fromDbTicket(row as Record<string, unknown>);
            map.set(t.id!, t);
          }
          list = Array.from(map.values());
        } else {
          const { data } = await supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('requester_id', uid).neq('status', 'CLOSED');
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
        //    mark them read so the bell, the sidebar badge, and the portal
        //    can never disagree.
        const workflowRows = n.filter(
          (r) => r.resourceId
            && r.metadata
            && typeof r.metadata.status === 'string'
            && r.metadata.action != null,
        );
        if (workflowRows.length > 0) {
          const refIds = Array.from(new Set(workflowRows.map((r) => r.resourceId as string)));
          const { data: liveRows } = await supabase
            .from('tickets').select('id, status').eq('org_id', activeOrgId).in('id', refIds);
          const statusById = new Map<string, string>();
          for (const row of (liveRows || []) as Array<{ id: string; status: string }>) {
            statusById.set(row.id, row.status);
          }
          const staleIds = workflowRows
            .filter((r) => statusById.get(r.resourceId as string) !== (r.metadata!.status as string))
            .map((r) => r.id);
          if (staleIds.length > 0) {
            const staleSet = new Set(staleIds);
            await markManyRead(staleIds).catch(() => { /* best-effort cleanup */ });
            n = n.filter((r) => !staleSet.has(r.id));
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
  }, [roles, activeOrgId, uid, channelId]);

  const { items, actionRequiredCount, unreadCount, sectionCounts } = useMemo(() => {
    const out: AttentionItem[] = [];
    const ticketIds = new Set<string>();
    let ar = 0;
    let ur = 0;

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
      const actionReq = isActionRequired(t, { uid, roles });
      const unread = !!uid && !!t.unreadBy?.includes(uid);
      if (!actionReq && !unread) continue;
      if (actionReq) ar++; else ur++;
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
      out.push({
        key: `notif:${n.id}`,
        source: 'notification',
        actionRequired: false,
        kind: n.kind,
        section,
        title: n.title,
        subtitle: n.body || '',
        link: n.link || (n.resourceId ? `/requests/${n.resourceId}` : '/inbox'),
        when: n.createdAt,
        notificationId: n.id,
      });
      tally(section, false);
    }

    out.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
    return { items: out, actionRequiredCount: ar, unreadCount: ur, sectionCounts };
  }, [tickets, notifs, uid, roles]);

  return {
    /** The unified feed every surface renders. */
    items,
    /** The single count every surface badges (the header bell + Home). */
    count: items.length,
    actionRequiredCount,
    unreadCount,
    totalNotifications: items.length,
    /** Per-sidebar-section counts so each nav item badges only ITS own items. */
    sectionCounts,
    loading,
    // Re-exported so the bell can mark notification rows read without another import.
    markRead,
    markAllRead,
  };
}
