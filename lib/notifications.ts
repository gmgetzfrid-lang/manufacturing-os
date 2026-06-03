// lib/notifications.ts
// Central notification dispatcher.
//
// Every workflow event that should notify users goes through queueEmail(),
// which:
//   1. Honors the recipient's per-user preferences (skip if they opted out)
//   2. Writes a row to `email_notifications` (status='queued')
//   3. Hits /api/notifications/send-queued to flush new rows immediately
//      so the recipient sees the email within seconds, not minutes
//
// Mentions are extracted from comment text via the @[name](uid) syntax
// produced by MentionableTextarea.

import { supabase } from "@/lib/supabase";

export type QueueEmailInput = {
  orgId: string;
  toUserId: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  resourceType?: "ticket" | "project" | "document";
  resourceId?: string;
  eventType: string;
  metadata?: Record<string, unknown>;
};

/**
 * Drop an email into the queue. Honors notification preferences if the user
 * has set them (defaults to all-on). Fires-and-forgets a fetch to the
 * send-queued endpoint so delivery feels instant.
 */
export async function queueEmail(input: QueueEmailInput): Promise<void> {
  try {
    // Look up the user's preferences. Missing row = defaults (all on).
    const { data: prefs } = await supabase
      .from("notification_preferences")
      .select("*")
      .eq("user_id", input.toUserId)
      .maybeSingle();

    if (prefs?.email_enabled === false) return;
    if (prefs?.digest_frequency === "never") return;
    if (!shouldSendForEvent(prefs, input.eventType)) return;

    // Dedupe: if the same recipient got the same event for the same resource
    // within the last 60 seconds, suppress this one (prevents burst-spam when
    // a workflow action triggers multiple watchers + assignments simultaneously).
    const sixtySecAgo = new Date(Date.now() - 60_000).toISOString();
    const { data: dupes } = await supabase
      .from("email_notifications")
      .select("id")
      .eq("to_user_id", input.toUserId)
      .eq("event_type", input.eventType)
      .eq("resource_id", input.resourceId || "")
      .gte("created_at", sixtySecAgo)
      .limit(1);
    if (dupes && dupes.length > 0) return;

    await supabase.from("email_notifications").insert({
      org_id: input.orgId,
      to_user_id: input.toUserId,
      to_email: input.toEmail,
      subject: input.subject,
      body_text: input.bodyText,
      body_html: input.bodyHtml || null,
      resource_type: input.resourceType || null,
      resource_id: input.resourceId || null,
      event_type: input.eventType,
      metadata: input.metadata || null,
      status: "queued",
    });

    // Best-effort kick the sender. If this fails the row is still safely
    // queued — the hourly maintenance cron (/api/cron/maintenance) drains the
    // queue as the authoritative path, so a failed kick only delays delivery,
    // never drops it. We log instead of swallowing so a broken endpoint is
    // visible in the console rather than an invisible outage.
    if (typeof window !== "undefined") {
      void fetch("/api/notifications/send-queued", { method: "POST" })
        .then((r) => { if (!r.ok) console.warn(`send-queued kick returned HTTP ${r.status}; queued for cron retry`); })
        .catch((e) => console.warn("send-queued kick failed; queued for cron retry:", (e as Error).message));
    }
  } catch (e) {
    console.error("queueEmail failed:", e);
  }
}

function shouldSendForEvent(
  prefs: Record<string, unknown> | null,
  eventType: string
): boolean {
  if (!prefs) return true;
  switch (eventType) {
    case "comment_mention":           return prefs.email_on_mention !== false;
    case "assignment":
    case "engineer_review_requested": return prefs.email_on_assignment !== false;
    case "ticket_status_changed":
    case "ticket_approved":
    case "ticket_revision_requested":
    case "ticket_closed":             return prefs.email_on_status_change !== false;
    case "watcher_activity":          return prefs.email_on_watched_activity !== false;
    case "sla_warning":               return prefs.email_on_sla_warning !== false;
    default:                          return true;
  }
}

// ─── MENTION PARSING ─────────────────────────────────────────────────────
// Mentions are stored in comment text as @[Display Name](uuid). This lets
// the renderer click through to the user even if their display name changes.

const MENTION_RE = /@\[([^\]]+)\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

export function extractMentionUids(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    out.add(m[2]);
  }
  return Array.from(out);
}

export type MentionToken =
  | { kind: "text"; value: string }
  | { kind: "mention"; name: string; uid: string };

/** Split a comment body into a sequence of plain-text and mention tokens. */
export function tokenizeMentions(text: string): MentionToken[] {
  if (!text) return [];
  const tokens: MentionToken[] = [];
  let lastIndex = 0;
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ kind: "text", value: text.slice(lastIndex, m.index) });
    }
    tokens.push({ kind: "mention", name: m[1], uid: m[2] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    tokens.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return tokens;
}

// ─── ORG USER SEARCH ─────────────────────────────────────────────────────
// Powers the @-mention autocomplete in comment composers.

export type OrgUser = {
  uid: string;
  email: string;
  name: string;
  role: string;
};

export async function searchOrgUsers(orgId: string, query: string, limit = 8): Promise<OrgUser[]> {
  if (!orgId) return [];
  const q = (query || "").trim().toLowerCase();
  let req = supabase
    .from("org_members")
    .select("uid, email, role")
    .eq("org_id", orgId)
    .eq("status", "active")
    .limit(limit);
  if (q) req = req.ilike("email", `%${q}%`);
  const { data } = await req;
  return (data ?? []).map((r: any) => ({
    uid: r.uid as string,
    email: (r.email as string) || "",
    name: ((r.email as string) || "").split("@")[0] || "user",
    role: (r.role as string) || "",
  }));
}

// ─── HELPER: build action URLs ───────────────────────────────────────────

export function ticketUrl(ticketId: string): string {
  if (typeof window !== "undefined") {
    return `${window.location.origin}/requests/${ticketId}`;
  }
  return `/requests/${ticketId}`;
}

// ─── SLA: detect tickets past their target ───────────────────────────────

export function isPastDue(ticket: { targetCompletionAt?: string | null; status?: string }): boolean {
  if (!ticket.targetCompletionAt) return false;
  if (ticket.status === "CLOSED" || ticket.status === "CANCELED") return false;
  try {
    return new Date(ticket.targetCompletionAt).getTime() < Date.now();
  } catch { return false; }
}

export function isNearingDue(ticket: { targetCompletionAt?: string | null; status?: string }, warnDays = 1): boolean {
  if (!ticket.targetCompletionAt) return false;
  if (ticket.status === "CLOSED" || ticket.status === "CANCELED") return false;
  try {
    const due = new Date(ticket.targetCompletionAt).getTime();
    const now = Date.now();
    return due > now && due - now < warnDays * 24 * 60 * 60 * 1000;
  } catch { return false; }
}

// ─── DEFAULT SLA per request type ────────────────────────────────────────
// First fallback when an org hasn't configured sla_defaults rows.

export const DEFAULT_SLA_DAYS: Record<string, number> = {
  INSPECTION: 1,
  RFI: 3,
  MOC: 7,
  ISO: 14,
  ASBUILT: 21,
};

export function defaultSlaTargetDate(requestType: string): string | null {
  const days = DEFAULT_SLA_DAYS[requestType] ?? 14;
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(17, 0, 0, 0);
  return d.toISOString();
}
