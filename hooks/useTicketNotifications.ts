import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import { Ticket } from '@/types/schema';

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
    attachments: (row.attachments as Ticket['attachments']) ?? [],
    comments: (row.comments as Ticket['comments']) ?? [],
    history: (row.history as Ticket['history']) ?? [],
    unreadBy: (row.unread_by as string[]) ?? [],
    revisionCount: row.revision_count as number | undefined,
    createdAt: row.created_at as string,
    lastModified: row.last_modified as string | undefined,
    updatedAt: row.updated_at as string | undefined,
  };
}

export function useTicketNotifications() {
  const { activeRole, activeOrgId, uid } = useRole();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  const isActionRequired = useCallback((ticket: Ticket) => {
    if (!uid) return false;

    if (ticket.assignedDrafterId === uid) {
      if (['DRAFTING', 'REVISION_REQ', 'PENDING_IFC'].includes(ticket.status)) return true;
    }
    if (ticket.requesterId === uid) {
      if (['PENDING_REVIEW', 'FINAL_DRAFT'].includes(ticket.status)) return true;
    }
    if (['Admin', 'Manager', 'Supervisor'].includes(activeRole)) {
      if (['PENDING_ASSIGNMENT', 'PENDING_ENG_INITIAL', 'PENDING_REVIEW', 'PENDING_FINAL_APPROVAL'].includes(ticket.status)) return true;
    }
    if (activeRole.includes('Engineer')) {
      if (['PENDING_ENG_INITIAL', 'PENDING_ENG_TEAM', 'PENDING_REVIEW'].includes(ticket.status)) return true;
    }
    if (activeRole === 'DocCtrl') {
      if (['FINAL_DRAFT', 'PENDING_IFC'].includes(ticket.status)) return true;
    }
    return false;
  }, [activeRole, uid]);

  useEffect(() => {
    if (!uid || !activeOrgId) {
      setTickets([]);
      setLoading(false);
      return;
    }

    let alive = true;

    const fetchTickets = async () => {
      try {
        let query = supabase.from('tickets').select('*').eq('org_id', activeOrgId);

        if (['Admin', 'Manager', 'Supervisor', 'DocCtrl'].includes(activeRole) || activeRole.includes('Engineer')) {
          query = query.neq('status', 'CLOSED');
        } else if (activeRole === 'Drafter') {
          // Fetch assigned + pool separately and merge
          const [assigned, pool] = await Promise.all([
            supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('assigned_drafter_id', uid),
            supabase.from('tickets').select('*').eq('org_id', activeOrgId).eq('status', 'PENDING_ASSIGNMENT'),
          ]);
          const map = new Map<string, Ticket>();
          for (const row of [...(assigned.data || []), ...(pool.data || [])]) {
            const t = fromDbTicket(row as Record<string, unknown>);
            map.set(t.id!, t);
          }
          if (alive) { setTickets(Array.from(map.values())); setLoading(false); }
          return;
        } else {
          query = query.eq('requester_id', uid).neq('status', 'CLOSED');
        }

        const { data } = await query;
        if (alive) {
          setTickets((data || []).map((r) => fromDbTicket(r as Record<string, unknown>)));
          setLoading(false);
        }
      } catch (e) {
        console.error("Ticket notification fetch failed", e);
        if (alive) setLoading(false);
      }
    };

    fetchTickets();

    const channel = supabase
      .channel(`tickets-notif-${activeOrgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `org_id=eq.${activeOrgId}` },
        () => { if (alive) fetchTickets(); })
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [activeRole, activeOrgId, uid]);

  const metrics = useMemo(() => {
    const actionRequiredCount = tickets.filter((t) => isActionRequired(t)).length;
    const unreadCount = tickets.filter((t) =>
      uid && t.unreadBy?.includes(uid) && !isActionRequired(t)
    ).length;

    return {
      actionRequiredCount,
      unreadCount,
      totalNotifications: actionRequiredCount + unreadCount,
    };
  }, [tickets, isActionRequired, uid]);

  return { ...metrics, loading };
}
