// lib/inbox.ts
//
// Aggregates everything the current user has to act on across the whole
// product into a single "my work" snapshot. Powers /inbox — the cockpit
// page that mirrors SharePoint's "My Tasks" / Linear's "Inbox" / GitHub
// notifications behavior.
//
// One round trip per source table, fired in parallel. Each section's
// fetch is independent — a failure in one doesn't blank the rest.

import { supabase } from "@/lib/supabase";
import { listOpenTasks, bucketForTask, cleanTaskText } from "@/lib/notes";
import type { CheckoutSession, DocumentHold, Milestone, Ticket } from "@/types/schema";

export interface InboxSnapshot {
  // Tickets — three buckets: assigned to me, mentioned/unread on me, watching
  ticketsAssigned: Array<Ticket & { __subtitle?: string }>;
  ticketsUnread: Array<Ticket & { __subtitle?: string }>;
  ticketsWatching: Array<Ticket & { __subtitle?: string }>;

  // Checkouts I currently hold
  myCheckouts: CheckoutSession[];

  // Holds I opened that are still open (I'm responsible for clearing them)
  myOpenHolds: DocumentHold[];

  // Markup requests TO me (someone asked for my markups)
  markupRequestsToMe: Array<{
    id: string;
    documentId: string;
    projectId?: string | null;
    documentNumber?: string | null;
    documentTitle?: string | null;
    requestedByName?: string | null;
    message?: string | null;
    createdAt: string;
  }>;

  // Milestones due in the next 7 days from projects I'm a member of, or
  // assigned directly to me — anything that suggests "act this week".
  milestonesUpcoming: Array<Milestone & {
    __projectName?: string | null;
    __dueInDays?: number;
  }>;

  // Milestones already past their planned date but still open (planned /
  // in_progress / blocked) — the "this is late" list. Kept separate from
  // upcoming so each reads cleanly and the "due this week" UI stays accurate.
  milestonesOverdue: Array<Milestone & {
    __projectName?: string | null;
    __overdueDays?: number;
  }>;

  // Stale checkouts I hold that are past their expected release date
  myStaleCheckouts: CheckoutSession[];

  // Transmittals I issued that the recipient hasn't acknowledged yet —
  // the "did they confirm receipt?" follow-up loop. Empty (and harmless)
  // if the transmittals table hasn't been migrated yet.
  transmittalsAwaitingAck: Array<{
    id: string;
    number: string;
    subject?: string | null;
    recipientName?: string | null;
    recipientCompany?: string | null;
    issuedAt?: string | null;
    documentCount: number;
    __ageDays?: number;
  }>;

  // Open to-dos from my scratchpad that have hit their due date — the
  // "don't let me forget" signal. Overdue items carry their text so a nudge
  // can name one; scratchpadDueToday is just a count.
  scratchpadOverdue: Array<{ noteId: string; text: string; dueAt: string | null }>;
  scratchpadDueToday: number;

  // Unread in-app notifications count (for the inbox header badge)
  unreadNotificationCount: number;
}

export async function loadInbox(orgId: string, userId: string, userEmail?: string): Promise<InboxSnapshot> {
  const userName = userEmail?.split("@")[0];
  const nowIso = new Date().toISOString();
  const sevenDaysIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  // Look back ~6 months for still-open milestones so genuinely overdue ones
  // surface too (the query used to only look forward, hiding all of them).
  const milestoneLookbackIso = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

  // Parallel fan-out — each source is independent
  const [
    assignedRes, unreadRes, watchingRes,
    checkoutsRes, holdsRes, markupRes, milestonesRes, projectsRes,
    notifsRes, transmittalsRes, scratchpadRes,
  ] = await Promise.allSettled([
    // Tickets assigned to me as drafter or engineer
    supabase.from("tickets").select("*").eq("org_id", orgId)
      .or(`assigned_drafter_id.eq.${userId},assigned_engineer_id.eq.${userId}`)
      .neq("status", "CLOSED")
      .order("last_modified", { ascending: false }).limit(25),
    // Tickets where I have unread activity
    supabase.from("tickets").select("*").eq("org_id", orgId)
      .contains("unread_by", [userId])
      .neq("status", "CLOSED")
      .order("last_modified", { ascending: false }).limit(25),
    // Tickets I'm watching
    supabase.from("tickets").select("*").eq("org_id", orgId)
      .contains("watchers", [userId])
      .neq("status", "CLOSED")
      .order("last_modified", { ascending: false }).limit(25),
    // My active checkouts
    supabase.from("checkout_sessions").select("*").eq("org_id", orgId)
      .eq("user_id", userId).eq("status", "active")
      .order("started_at", { ascending: false }),
    // My open holds
    supabase.from("document_holds").select("*").eq("org_id", orgId)
      .eq("opened_by", userId).is("released_at", null)
      .order("opened_at", { ascending: false }),
    // Markup requests where I'm the recipient
    supabase.from("markup_requests").select("*").eq("org_id", orgId)
      .eq("requested_from_user_id", userId).eq("status", "open")
      .order("created_at", { ascending: false }),
    // Open milestones from the recent past (overdue) through the next 7 days
    // (due soon). We split them into overdue vs upcoming below.
    supabase.from("milestones").select("*").eq("org_id", orgId)
      .gte("planned_at", milestoneLookbackIso).lte("planned_at", sevenDaysIso)
      .in("status", ["planned", "in_progress", "blocked"])
      .order("planned_at", { ascending: true }).limit(100),
    // Projects I'm a member of — to scope milestones below
    supabase.from("project_members").select("project_id").eq("user_id", userId),
    // Unread notification count
    supabase.from("notifications").select("*", { count: "exact", head: true })
      .eq("user_id", userId).is("read_at", null),
    // Transmittals I issued that are still awaiting recipient acknowledgement.
    // If the table isn't migrated yet this resolves with an error → empty.
    supabase.from("transmittals").select("id, number, subject, recipient_name, recipient_company, issued_at, items")
      .eq("org_id", orgId).eq("created_by", userId).eq("status", "issued")
      .order("issued_at", { ascending: true }).limit(50),
    // My open scratchpad to-dos — so things I jotted down with a due date
    // resurface as nudges instead of being silently forgotten. Resilient: if
    // the notes table isn't there, this rejects and maps to an empty list.
    listOpenTasks(orgId, userId),
  ]);

  const toTickets = (data: unknown[]): Ticket[] => (data || []).map((r) => rowToTicket(r as Record<string, unknown>));

  const ticketsAssigned = assignedRes.status === "fulfilled" ? toTickets(assignedRes.value.data || []) : [];
  const ticketsUnread = unreadRes.status === "fulfilled" ? toTickets(unreadRes.value.data || []) : [];
  const ticketsWatching = watchingRes.status === "fulfilled" ? toTickets(watchingRes.value.data || []) : [];

  // Dedupe across the three ticket buckets — a ticket should show in
  // assigned even if it's also in unread/watching.
  const assignedIds = new Set(ticketsAssigned.map((t) => t.id));
  const unreadFiltered = ticketsUnread.filter((t) => !assignedIds.has(t.id));
  const watchingFilteredIds = new Set([...assignedIds, ...unreadFiltered.map((t) => t.id)]);
  const watchingFiltered = ticketsWatching.filter((t) => !watchingFilteredIds.has(t.id));

  const myCheckouts: CheckoutSession[] = checkoutsRes.status === "fulfilled"
    ? ((checkoutsRes.value.data || []) as Array<Record<string, unknown>>).map(rowToCheckout)
    : [];

  // Stale = past its expected_release_at / auto_expires_at, OR simply held a
  // long time. The second clause matters because many checkouts never get a
  // release date set — without it, holding a doc for weeks never registered.
  const CHECKOUT_LONGHELD_DAYS = 7;
  const longHeldBeforeIso = new Date(Date.now() - CHECKOUT_LONGHELD_DAYS * 86400000).toISOString();
  const myStaleCheckouts = myCheckouts.filter((s) => {
    const exp = s.expectedReleaseAt || s.autoExpiresAt;
    if (exp && exp < nowIso) return true;
    return !!s.startedAt && s.startedAt < longHeldBeforeIso;
  });

  const myOpenHolds: DocumentHold[] = holdsRes.status === "fulfilled"
    ? ((holdsRes.value.data || []) as Array<Record<string, unknown>>).map(rowToHold)
    : [];

  const markupRequestsToMe = markupRes.status === "fulfilled"
    ? ((markupRes.value.data || []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        documentId: String(r.document_id),
        projectId: (r.project_id as string) ?? null,
        documentNumber: (r.document_number as string) ?? null,
        documentTitle: (r.document_title as string) ?? null,
        requestedByName: (r.requested_by_name as string) ?? null,
        message: (r.message as string) ?? null,
        createdAt: String(r.created_at),
      }))
    : [];

  const myProjectIds = new Set<string>(
    projectsRes.status === "fulfilled"
      ? ((projectsRes.value.data || []) as Array<{ project_id: string }>).map((p) => p.project_id)
      : [],
  );

  const allMilestones = milestonesRes.status === "fulfilled"
    ? ((milestonesRes.value.data || []) as Array<Record<string, unknown>>).map(rowToMilestone)
    : [];
  // Mine = in one of my projects, or assigned directly (no projectId).
  const myMilestones = allMilestones.filter((m) => !m.projectId || myProjectIds.has(m.projectId));
  const msTime = (m: Milestone) => new Date(String(m.plannedAt ?? "")).getTime();
  // Due within the next 7 days — the forward-looking "this week" list.
  const milestonesUpcoming = myMilestones
    .filter((m) => { const t = msTime(m); return Number.isFinite(t) && t >= Date.now(); })
    .map((m) => ({ ...m, __dueInDays: Math.max(0, Math.round((msTime(m) - Date.now()) / 86400000)) }));
  // Past their planned date but still open — overdue (oldest first).
  const milestonesOverdue = myMilestones
    .filter((m) => { const t = msTime(m); return Number.isFinite(t) && t < Date.now(); })
    .map((m) => ({ ...m, __overdueDays: Math.max(0, Math.floor((Date.now() - msTime(m)) / 86400000)) }));

  const unreadNotificationCount = notifsRes.status === "fulfilled"
    ? (notifsRes.value.count ?? 0)
    : 0;

  // Resilient: a missing transmittals table resolves with `.error` set and
  // `.data` null, which maps cleanly to an empty list (no inbox breakage).
  const transmittalsAwaitingAck = transmittalsRes.status === "fulfilled" && transmittalsRes.value.data
    ? (transmittalsRes.value.data as Array<Record<string, unknown>>).map((r) => {
        const issuedAt = (r.issued_at as string) ?? null;
        const ageDays = issuedAt ? Math.max(0, Math.floor((Date.now() - new Date(issuedAt).getTime()) / 86400000)) : undefined;
        return {
          id: String(r.id),
          number: String(r.number ?? ""),
          subject: (r.subject as string) ?? null,
          recipientName: (r.recipient_name as string) ?? null,
          recipientCompany: (r.recipient_company as string) ?? null,
          issuedAt,
          documentCount: Array.isArray(r.items) ? r.items.length : 0,
          __ageDays: ageDays,
        };
      })
    : [];

  // Scratchpad to-dos with a due date that has hit/passed. Reuses the same
  // bucketing the scratchpad itself uses, so "overdue" means exactly what it
  // does there. Sorted most-overdue first; text is cleaned of date/priority
  // tokens for display.
  const openTasks = scratchpadRes.status === "fulfilled" ? scratchpadRes.value : [];
  const nowForTasks = new Date();
  const scratchpadOverdue: Array<{ noteId: string; text: string; dueAt: string | null }> = [];
  let scratchpadDueToday = 0;
  for (const { note, task } of openTasks) {
    const bucket = bucketForTask(task, nowForTasks);
    if (bucket === "overdue") scratchpadOverdue.push({ noteId: note.id, text: cleanTaskText(task), dueAt: task.dueAt });
    else if (bucket === "today") scratchpadDueToday += 1;
  }
  scratchpadOverdue.sort((a, b) => String(a.dueAt ?? "").localeCompare(String(b.dueAt ?? "")));

  // userName left here for future use; explicit void prevents lint flag.
  void userName;

  return {
    ticketsAssigned,
    ticketsUnread: unreadFiltered,
    ticketsWatching: watchingFiltered,
    myCheckouts,
    myOpenHolds,
    markupRequestsToMe,
    milestonesUpcoming,
    milestonesOverdue,
    myStaleCheckouts,
    transmittalsAwaitingAck,
    scratchpadOverdue: scratchpadOverdue.slice(0, 10),
    scratchpadDueToday,
    unreadNotificationCount,
  };
}

// ─── Row mappers ─────────────────────────────────────────────────────

function rowToTicket(r: Record<string, unknown>): Ticket {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    ticketId: r.ticket_id as string,
    title: r.title as string,
    description: r.description as string | undefined,
    unit: r.unit as string | undefined,
    requestType: r.request_type as Ticket["requestType"],
    status: r.status as Ticket["status"],
    priority: r.priority as number | undefined,
    requesterId: r.requester_id as string,
    requesterName: r.requester_name as string | undefined,
    requesterEmail: r.requester_email as string | undefined,
    requesterRole: r.requester_role as Ticket["requesterRole"],
    assignedDrafterId: r.assigned_drafter_id as string | undefined,
    assignedDrafterName: r.assigned_drafter_name as string | undefined,
    assignedEngineerId: (r.assigned_engineer_id as string | undefined) ?? undefined,
    assignedEngineerName: (r.assigned_engineer_name as string | undefined) ?? undefined,
    attachments: (r.attachments as Ticket["attachments"]) ?? [],
    comments: (r.comments as Ticket["comments"]) ?? [],
    history: (r.history as Ticket["history"]) ?? [],
    unreadBy: (r.unread_by as string[]) ?? [],
    watchers: (r.watchers as string[]) ?? [],
    revisionCount: r.revision_count as number | undefined,
    createdAt: r.created_at as string,
    lastModified: r.last_modified as string | undefined,
    updatedAt: r.updated_at as string | undefined,
  } as Ticket;
}

function rowToCheckout(r: Record<string, unknown>): CheckoutSession {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    documentId: r.document_id as string,
    libraryId: r.library_id as string | undefined,
    userId: r.user_id as string,
    userName: r.user_name as string | undefined,
    mode: r.mode as CheckoutSession["mode"],
    note: r.note as string | undefined,
    status: r.status as CheckoutSession["status"],
    startedAt: r.started_at as string,
    lastSeenAt: r.last_seen_at as string | undefined,
    expiresAt: r.expires_at as string | undefined,
    endedAt: r.ended_at as string | undefined,
    projectId: r.project_id as string | undefined,
    purpose: r.purpose as string | undefined,
    expectedReleaseAt: r.expected_release_at as string | undefined,
    autoExpiresAt: r.auto_expires_at as string | undefined,
  } as CheckoutSession;
}

function rowToHold(r: Record<string, unknown>): DocumentHold {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    documentId: r.document_id as string,
    reason: r.reason as string,
    notes: r.notes as string | undefined,
    expectedReleaseAt: r.expected_release_at as string | undefined,
    openedBy: r.opened_by as string,
    openedByName: r.opened_by_name as string | undefined,
    openedAt: r.opened_at as string,
    releasedBy: r.released_by as string | undefined,
    releasedByName: r.released_by_name as string | undefined,
    releasedAt: r.released_at as string | undefined,
    releasedReason: r.released_reason as string | undefined,
  } as DocumentHold;
}

function rowToMilestone(r: Record<string, unknown>): Milestone {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string | undefined,
    documentId: r.document_id as string | undefined,
    name: r.name as string,
    description: r.description as string | undefined,
    weight: Number(r.weight ?? 1),
    plannedAt: r.planned_at as string,
    actualAt: r.actual_at as string | undefined,
    status: r.status as Milestone["status"],
    source: r.source as Milestone["source"],
    createdBy: r.created_by as string,
  } as Milestone;
}
