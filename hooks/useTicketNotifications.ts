import { useState, useEffect, useMemo, useCallback, useId } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { Ticket } from '@/types/schema';
import { listMyNotifications, markRead, markAllRead, type NotificationRow } from '@/lib/inAppNotifications';

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

export interface AttentionItem {
  key: string;
  source: AttentionSource;
  /** Whether this is something I must DO (action-required) vs. FYI activity. */
  actionRequired: boolean;
  kind: NotificationRow['kind'] | 'ticket';
  title: string;
  subtitle: string;
  link: string;
  when: string;
  /** Present for notification-sourced items so they can be marked read. */
  notificationId?: string;
}

function attentionLabel(status: string): string {
  switch (status) {
    case 'PENDING_ASSIGNMENT': return 'Needs a drafter assigned';
    case 'PENDING_ENG_INITIAL':
    case 'PENDING_ENG_TEAM': return 'Engineering review';
    case 'PENDING_REVIEW': return 'Needs review';
    case 'PENDING_FINAL_APPROVAL': return 'Needs engineer sign-off';
    case 'DRAFTING':
    case 'REVISION_REQ': return 'Drafting in progress';
    case 'PENDING_IFC': return 'Issue the IFC package';
    case 'FINAL_DRAFT': return 'Acknowledge & close';
    default: return 'Needs your attention';
  }
}

export function useTicketNotifications() {
  const { activeRole, activeOrgId, uid } = useRole();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [notifs, setNotifs] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Unique per hook instance so multiple consumers (sidebar/bell/inbox) don't
  // collide on the same realtime channel name.
  const channelId = useId().replace(/[^a-z0-9]/gi, '');

  const isActionRequired = useCallback((ticket: Ticket) => {
    if (!uid) return false;

    if (ticket.assignedDrafterId === uid) {
      if (['DRAFTING', 'REVISION_REQ', 'PENDING_IFC'].includes(ticket.status)) return true;
    }
    if (ticket.requesterId === uid) {
      if (['PENDING_REVIEW', 'FINAL_DRAFT'].includes(ticket.status)) return true;
    }
    if (ticket.assignedEngineerId === uid) {
      if (['PENDING_ENG_TEAM', 'PENDING_FINAL_APPROVAL'].includes(ticket.status)) return true;
    }
    if (['Admin', 'Manager', 'Supervisor', 'DraftingSupervisor'].includes(activeRole)) {
      if (['PENDING_ASSIGNMENT', 'PENDING_ENG_INITIAL', 'PENDING_REVIEW', 'PENDING_FINAL_APPROVAL'].includes(ticket.status)) return true;
    }
    if (activeRole.includes('Engineer')) {
      if (ticket.status === 'PENDING_ENG_INITIAL') return true;
      if (ticket.status === 'PENDING_ENG_TEAM' && !ticket.assignedEngineerId) return true;
      if (ticket.status === 'PENDING_FINAL_APPROVAL' && !ticket.assignedEngineerId) return true;
      if (ticket.status === 'PENDING_REVIEW') return true;
    }
    if (activeRole === 'DocCtrl') {
      if (['FINAL_DRAFT', 'PENDING_IFC'].includes(ticket.status)) return true;
    }
    return false;
  }, [activeRole, uid]);

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
        if (['Admin', 'Manager', 'Supervisor', 'DraftingSupervisor', 'DocCtrl'].includes(activeRole) || activeRole.includes('Engineer')) {
          const { data } = await supabase.from('tickets').select('*').eq('org_id', activeOrgId).neq('status', 'CLOSED');
          list = (data || []).map((r) => fromDbTicket(r as Record<string, unknown>));
        } else if (activeRole === 'Drafter') {
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

        // 2) My unread in-app notifications (the bell's events).
        const n = await listMyNotifications({ onlyUnread: true, limit: 50 }).catch(() => [] as NotificationRow[]);

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
  }, [activeRole, activeOrgId, uid]);

  const { items, actionRequiredCount, unreadCount } = useMemo(() => {
    const out: AttentionItem[] = [];
    const ticketIds = new Set<string>();
    let ar = 0;
    let ur = 0;

    for (const t of tickets) {
      const actionReq = isActionRequired(t);
      const unread = !!uid && !!t.unreadBy?.includes(uid);
      if (!actionReq && !unread) continue;
      if (actionReq) ar++; else ur++;
      out.push({
        key: `ticket:${t.id}`,
        source: 'ticket',
        actionRequired: actionReq,
        kind: 'ticket',
        title: `${t.ticketId || ''} ${t.title || ''}`.trim() || 'Request',
        subtitle: actionReq ? attentionLabel(t.status) : 'New activity',
        link: `/requests/${t.id}`,
        when: String(t.lastModified || t.createdAt || ''),
      });
      if (t.id) ticketIds.add(t.id);
    }

    for (const n of notifs) {
      // Dedupe: if a ticket is already in the feed, fold its notification in.
      if (n.resourceId && ticketIds.has(n.resourceId)) continue;
      out.push({
        key: `notif:${n.id}`,
        source: 'notification',
        actionRequired: false,
        kind: n.kind,
        title: n.title,
        subtitle: n.body || '',
        link: n.link || (n.resourceId ? `/requests/${n.resourceId}` : '/inbox'),
        when: n.createdAt,
        notificationId: n.id,
      });
    }

    out.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
    return { items: out, actionRequiredCount: ar, unreadCount: ur };
  }, [tickets, notifs, isActionRequired, uid]);

  return {
    /** The unified feed every surface renders. */
    items,
    /** The single count every surface badges. */
    count: items.length,
    actionRequiredCount,
    unreadCount,
    totalNotifications: items.length,
    loading,
    // Re-exported so the bell can mark notification rows read without another import.
    markRead,
    markAllRead,
  };
}
