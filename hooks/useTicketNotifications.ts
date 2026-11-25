import { sharedLoad, lastLoaded } from "@/lib/warmLoads";
import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { useRole } from '@/components/providers/RoleContext';
import type { Role, Ticket } from '@/types/schema';
import {
  listMyNotifications, markRead, markAllRead, markManyRead, DECISION_KINDS, type NotificationRow,
} from '@/lib/inAppNotifications';
import {
  isActionRequired, attentionLabel, isManagementRole, isEngineerRole,
} from '@/lib/ticketAttention';
import { askForNotification, withAsk } from '@/lib/asks';

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
    case 'checkout_released':
    case 'overlap_advisory':
    case 'branch_open':
    case 'branch_resolved':
    case 'provenance_flag':
    case 'hold_opened':
    case 'hold_released':
      return 'documents';
    case 'project_member':
    case 'project_status':
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

/** What the attention feed is built from: the tickets that may need me and
 *  my unread notifications, with stale workflow alerts taken out. */
export interface AttentionLoad { tickets: Ticket[]; notifs: NotificationRow[]; problems: string[] }

/** One load per account, workspace and roles: the side menu, the bell and
 *  the dashboard read the same one (lib/warmLoads), and sign-in starts it. */
export const attentionKey = (orgId: string, uid: string, roles: readonly string[]) => `attn:${orgId}|${uid}|${roles.join(",")}`;

/** Read the feed. Tickets and notifications are asked for together; the
 *  live status of a ticket an alert is about is read only when the ticket
 *  list can't tell it. */
export async function loadAttention(orgId: string, uid: string, roles: Role[]): Promise<AttentionLoad> {
  const problems: string[] = [];
  const note = (e: { message?: string } | null | undefined) => { if (e?.message) problems.push(e.message); };

  // 1) My tickets, scoped by role (same visibility rules as the portal).
  // Management, engineers and controllers read every open ticket: then a
  // ticket missing from the list is closed or gone.
  const seesAllOpen = isManagementRole(roles) || isEngineerRole(roles) || roles.includes('DocCtrl');
  const loadList = async (): Promise<{ list: Ticket[]; complete: boolean }> => {
    if (seesAllOpen) {
      const { data, error } = await supabase.from('tickets').select('*').eq('org_id', orgId).neq('status', 'CLOSED').order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP);
      note(error);
      const list = (data || []).map((r) => fromDbTicket(r as Record<string, unknown>));
      return { list, complete: !error && list.length < OPEN_TICKET_CAP };
    }
    if (roles.includes('Drafter')) {
      const [assigned, pool] = await Promise.all([
        supabase.from('tickets').select('*').eq('org_id', orgId).eq('assigned_drafter_id', uid).order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP),
        supabase.from('tickets').select('*').eq('org_id', orgId).eq('status', 'PENDING_ASSIGNMENT').order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP),
      ]);
      note(assigned.error); note(pool.error);
      const map = new Map<string, Ticket>();
      for (const row of [...(assigned.data || []), ...(pool.data || [])]) {
        const t = fromDbTicket(row as Record<string, unknown>);
        map.set(t.id!, t);
      }
      return { list: Array.from(map.values()), complete: false };
    }
    const { data, error } = await supabase.from('tickets').select('*').eq('org_id', orgId).eq('requester_id', uid).neq('status', 'CLOSED').order('last_modified', { ascending: false }).limit(OPEN_TICKET_CAP);
    note(error);
    return { list: (data || []).map((r) => fromDbTicket(r as Record<string, unknown>)), complete: false };
  };

  // 2) My unread in-app notifications (the bell's events), scoped to the
  //    active workspace. Read alongside the tickets, not after them.
  const [{ list, complete }, unread] = await Promise.all([
    loadList(),
    listMyNotifications({ onlyUnread: true, limit: 50, orgId })
      .catch((e: Error) => { note(e); return [] as NotificationRow[]; }),
  ]);
  let n = unread;

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
    // The ticket list already has the live status of the tickets in it.
    // When it holds every open ticket, one missing from it is closed or
    // gone: stale, unless the alert itself is about closing it. Only the
    // rest are read.
    const statusById = new Map<string, string>(list.filter((t) => t.id).map((t) => [t.id!, String(t.status)]));
    const unknown = Array.from(new Set(workflowRows
      .filter((r) => !statusById.has(r.resourceId as string) && (!complete || r.metadata!.status === 'CLOSED'))
      .map((r) => r.resourceId as string)));
    let liveErr: { message?: string } | null = null;
    if (unknown.length > 0) {
      const { data: liveRows, error } = await supabase
        .from('tickets').select('id, status').eq('org_id', orgId).in('id', unknown);
      liveErr = error;
      // Without the live statuses nothing can be called stale: a failed
      // read must never clear real alerts.
      if (error) note(error);
      for (const row of (liveRows || []) as Array<{ id: string; status: string }>) statusById.set(row.id, row.status);
    }
    const staleIds = liveErr ? [] : workflowRows
      .filter((r) => statusById.get(r.resourceId as string) !== (r.metadata!.status as string))
      .map((r) => r.id);
    if (staleIds.length > 0) {
      const staleSet = new Set(staleIds);
      // Best-effort cleanup, in the background: the feed leaves them out now.
      void markManyRead(staleIds).catch(() => { /* best-effort cleanup */ });
      n = n.filter((r) => !staleSet.has(r.id));
    }
  }
  return { tickets: list, notifs: n, problems };
}

// A change pushed by the database refreshes every reader of the feed with
// one load: the readers that hear it within a moment share it. The load
// waits 1 to 3 s (random, so open tabs don't all reload at the same
// instant) and a burst of changes in that time is one reload, not one per
// change. A change after the wait has started its load gets a new one.
const refreshing = new Map<string, Promise<AttentionLoad>>();
function refreshSoon(key: string, load: () => Promise<AttentionLoad>): Promise<AttentionLoad> {
  let p = refreshing.get(key);
  if (!p) {
    const mine: Promise<AttentionLoad> = new Promise<void>((r) => setTimeout(r, 1_000 + Math.random() * 2_000)).then(() => {
      if (refreshing.get(key) === mine) refreshing.delete(key);
      return sharedLoad(key, load, { fresh: true });
    });
    p = mine;
    refreshing.set(key, p);
  }
  return p;
}

// ONE realtime channel per tab for the feed, shared by every reader of it
// (the side menu, the bell, Home, the inbox...): each reader used to open
// its own, up to 7 per tab, and each heard every change.
type FeedChannel = { channel: ReturnType<typeof supabase.channel>; listeners: Set<() => void> };
const feedChannels = new Map<string, FeedChannel>();
let feedChannelSeq = 0;
function subscribeFeed(orgId: string, uid: string, listener: () => void): () => void {
  const k = `${orgId}|${uid}`;
  let entry = feedChannels.get(k);
  if (!entry) {
    const listeners = new Set<() => void>();
    const fire = () => { for (const l of [...listeners]) l(); };
    // A fresh name each time: a channel being removed keeps its name for a moment.
    const channel = supabase
      .channel(`attention-${orgId}-${uid}-${++feedChannelSeq}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `org_id=eq.${orgId}` }, fire)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, fire)
      .subscribe();
    entry = { channel, listeners };
    feedChannels.set(k, entry);
  }
  const mine = entry;
  mine.listeners.add(listener);
  return () => {
    mine.listeners.delete(listener);
    if (mine.listeners.size === 0 && feedChannels.get(k) === mine) {
      feedChannels.delete(k);
      void supabase.removeChannel(mine.channel);
    }
  };
}

export function useTicketNotifications() {
  const { roles, activeOrgId, uid } = useRole();
  const key = uid && activeOrgId ? attentionKey(activeOrgId, uid, roles) : null;
  // This reader's own latest answer, for the key it was loaded for.
  const [got, setGot] = useState<{ key: string; v?: AttentionLoad; err?: string } | null>(null);
  // The feed as last loaded (here or by another reader, or at sign-in):
  // shown at once on a screen opened again, while this one loads afresh.
  const kept = lastLoaded<AttentionLoad>(key);
  const mine = got && got.key === key ? got : null;
  const current: AttentionLoad | undefined = mine?.v ?? kept;
  const tickets = useMemo(() => current?.tickets ?? [], [current]);
  const notifs = useMemo(() => current?.notifs ?? [], [current]);
  const loading = !!key && !mine && !kept;
  // Why the feed couldn't be read (null when it was): surfaces say so
  // instead of showing "nothing needs you".
  const loadError = mine?.err ?? (current?.problems.length ? current.problems[0] : null);

  useEffect(() => {
    if (!key || !uid || !activeOrgId) return;
    let alive = true;
    const load = () => loadAttention(activeOrgId, uid, roles);
    const take = (p: Promise<AttentionLoad>) => p
      .then((v) => { if (alive) setGot({ key, v }); })
      .catch((e: unknown) => {
        console.error('Attention feed fetch failed', e);
        if (alive) setGot({ key, err: (e as Error)?.message || "It didn't load." });
      });

    // The side menu, the bell and the dashboard each mount this hook at
    // once: one load serves them all (lib/warmLoads, 1.5 s), and sign-in
    // may have started it already.
    void take(sharedLoad(key, load, { maxAgeMs: 1500 }));

    // The tab's one feed channel (shared by every reader); a change reloads
    // the feed once for all of them, a moment later.
    const off = subscribeFeed(activeOrgId, uid, () => { if (alive) void take(refreshSoon(key, load)); });

    return () => { alive = false; off(); };
  // `key` carries the roles, the workspace and the account.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

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
        // A request waiting on you opens with what to do at the top.
        link: withAsk(matched?.link || `/requests/${t.id}`, actionReq ? 'turn' : null),
        when: String(t.lastModified || t.createdAt || ''),
      });
      tally('requests', actionReq);
      if (t.id) ticketIds.add(t.id);
    }

    // Conflict-class notifications carry the "action" treatment in the feed:
    // a stale-base branch, a lost checkout, or an edit overlap is something
    // to ACT on, not passive activity.
    // Approvals, reviews, acknowledgements and holds wait on the person too.
    const actionKinds: ReadonlySet<string> = DECISION_KINDS;

    for (const n of notifs) {
      // Dedupe: if a ticket is already in the feed, fold its notification in.
      if (n.resourceId && ticketIds.has(n.resourceId)) continue;
      const section = sectionForKind(n.kind);
      out.push({
        key: `notif:${n.id}`,
        source: 'notification',
        actionRequired: actionKinds.has(n.kind),
        kind: n.kind,
        section,
        title: n.title,
        subtitle: n.body || '',
        // The link carries what is wanted (?ask=), so the screen it opens
        // says it at the top with the button (lib/asks.ts).
        link: withAsk(n.link || (n.resourceId
          ? (n.resourceType === 'document' ? `/search?q=${encodeURIComponent(n.resourceId)}`
             : n.resourceType === 'library' ? `/documents/${n.resourceId}`
             : `/requests/${n.resourceId}`)
          : '/inbox'), askForNotification(n.kind, n.metadata), n.id),
        when: n.createdAt,
        notificationId: n.id,
      });
      tally(section, actionKinds.has(n.kind));
      if (actionKinds.has(n.kind)) ar++; else ur++;
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
    /** Why the feed couldn't be read, or null. */
    loadError,
    // Re-exported so the bell can mark notification rows read without another import.
    markRead,
    // Scoped to the active workspace so "mark all read" clears only this
    // workspace's bell, not every workspace the user belongs to.
    markAllRead: () => markAllRead(activeOrgId),
  };
}
