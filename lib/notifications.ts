// lib/notifications.ts
// Central notification dispatcher.
//
// Every workflow event that should notify users goes through queueEmail(),
// which:
//   1. Asks email_gate() (20261148, SECURITY DEFINER) whether the RECIPIENT's
//      preferences allow this email and whether the same email for the same
//      resource was queued in the last 60 seconds — evaluated where the
//      recipient's row is visible, whoever is calling (DELIV-2, DELIV-9)
//   2. Writes a row to `email_notifications` (status='queued')
//   3. Hits /api/notifications/send-queued to flush new rows immediately
//      so the recipient sees the email within seconds, not minutes
//
// Mentions are extracted from comment text via the @[name](uid) syntax
// produced by MentionableTextarea.

import { supabase } from "@/lib/supabase";
import { emailAllowedByPrefs, isMissingEmailGate } from "@/lib/notificationPrefs";

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
  /** Absolute call-to-action URL for the message. Carried on the row as
   *  metadata.link for the drain's renderer (N6); nothing reads it yet. */
  link?: string;
};

/** Kick the email drain from the browser, authenticated with the current
 *  user's session so the (auth-gated) send-queued route accepts it. Best-
 *  effort and browser-only: a failure just defers delivery to the cron. */
export async function kickEmailDrain(): Promise<Response | null> {
  if (typeof window === "undefined") return null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = {};
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    return await fetch("/api/notifications/send-queued", { method: "POST", headers });
  } catch (e) {
    console.warn("send-queued kick failed; queued for cron retry:", (e as Error).message);
    return null;
  }
}

/** The gate's answer. 'unverified' = it could not be evaluated where the
 *  recipient's row is visible; the email is sent (a dropped compliance email
 *  is worse than an unwanted one) and the row says so in metadata.pref_gate. */
type GateVerdict = "send" | "suppress" | "unverified";

async function evaluateEmailGate(input: QueueEmailInput): Promise<GateVerdict> {
  const { data, error } = await supabase.rpc("email_gate", {
    p_org: input.orgId,
    p_to_user: input.toUserId,
    p_event_type: input.eventType,
    p_resource_id: input.resourceId || null,
  });
  if (!error) return data === false ? "suppress" : "send";
  if (isMissingEmailGate(error)) {
    console.warn(
      "queueEmail: email_gate() is not deployed (paste migration 20261148) — falling back to the caller-side preference read, which cannot see another member's opt-out",
    );
    return legacyEmailGate(input);
  }
  console.warn(
    `queueEmail: email_gate failed (${error.code ?? "?"}: ${error.message}) — sending anyway, stamped pref_gate=unverified`,
  );
  return "unverified";
}

/** The pre-20261148 gate, unchanged in effect: the recipient's row and the
 *  60-second window read through the CALLER's client. Under the service role
 *  that is authoritative; from a browser RLS hides another member's row, so a
 *  missing row is reported as 'unverified' rather than read as all-on. */
async function legacyEmailGate(input: QueueEmailInput): Promise<GateVerdict> {
  const { data: prefs, error: prefsErr } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("user_id", input.toUserId)
    .maybeSingle();
  if (!emailAllowedByPrefs(prefs ?? null, input.eventType)) return "suppress";

  if (input.resourceId) {
    const sixtySecAgo = new Date(Date.now() - 60_000).toISOString();
    const { data: dupes } = await supabase
      .from("email_notifications")
      .select("id")
      .eq("to_user_id", input.toUserId)
      .eq("event_type", input.eventType)
      .eq("resource_id", input.resourceId)
      .gte("created_at", sixtySecAgo)
      .limit(1);
    if (dupes && dupes.length > 0) return "suppress";
  }
  return prefs && !prefsErr ? "send" : "unverified";
}

/**
 * Drop an email into the queue. Honors the recipient's notification
 * preferences (no row = the defaults, all on) and the 60-second dedupe through
 * email_gate(). Fires-and-forgets a fetch to the send-queued endpoint so
 * delivery feels instant.
 */
export async function queueEmail(input: QueueEmailInput): Promise<void> {
  try {
    // The recipient's preferences + the 60-second dedupe (same recipient, same
    // event, same resource), evaluated by email_gate() where both are visible.
    const verdict = await evaluateEmailGate(input);
    if (verdict === "suppress") return;

    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
    if (input.link) metadata.link = input.link;
    if (verdict === "unverified") metadata.pref_gate = "unverified";

    const { error: insErr } = await supabase.from("email_notifications").insert({
      org_id: input.orgId,
      to_user_id: input.toUserId,
      to_email: input.toEmail,
      subject: input.subject,
      body_text: input.bodyText,
      body_html: input.bodyHtml || null,
      resource_type: input.resourceType || null,
      resource_id: input.resourceId || null,
      event_type: input.eventType,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      status: "queued",
    });
    if (insErr) {
      console.error("queueEmail: the email was not queued:", insErr);
      return;
    }

    // Best-effort kick the sender. If this fails the row is still safely
    // queued — the maintenance cron drains the queue as the authoritative
    // path, so a failed kick only delays delivery, never drops it.
    void kickEmailDrain().then((r) => {
      if (r && !r.ok) console.warn(`send-queued kick returned HTTP ${r.status}; queued for cron retry`);
    });
  } catch (e) {
    console.error("queueEmail failed:", e);
  }
}


// queueExternalEmail was removed under SURF-17: external mail (transmittal
// recipients, intake submitters) is queued server-side from the row, and
// migration 20261047 makes a client INSERT with metadata.external = true
// impossible. The legitimate path is /api/transmittal/send-email.

// shouldSendForEvent moved to lib/notificationPrefs.ts (notifications Round G,
// N1) with the rest of the preference rule, so queueEmail, email_gate() and
// the compliance digest share one definition.

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
  // Strip characters that would break the PostgREST or() filter syntax.
  const q = (query || "").trim().replace(/[,()*%]/g, "");
  let req = supabase
    .from("org_members")
    .select("uid, email, role, display_name")
    .eq("org_id", orgId)
    .eq("status", "active")
    .limit(limit);
  // Match the typed text against the display name OR the email, so "Mike",
  // "Leonard", or "mleonard@…" all find the same person. (`*` is the wildcard
  // inside an or() filter; `%` is only for the standalone .ilike().)
  if (q) req = req.or(`display_name.ilike.*${q}*,email.ilike.*${q}*`);
  const { data } = await req;
  return (data ?? []).map((r: { uid: string; email: string | null; role: string | null; display_name?: string | null }) => {
    const email = (r.email as string) || "";
    const dn = (r.display_name as string | null)?.trim();
    return {
      uid: r.uid as string,
      email,
      name: dn || email.split("@")[0] || "user",
      role: (r.role as string) || "",
    };
  });
}

// ─── HELPER: build action URLs ───────────────────────────────────────────

export function ticketUrl(ticketId: string): string {
  if (typeof window !== "undefined") {
    return `${window.location.origin}/requests/${ticketId}`;
  }
  return `/requests/${ticketId}`;
}

// ─── SLA: detect tickets past their target ───────────────────────────────

export function isPastDue(ticket: { targetCompletionAt?: string | number | Date | null; status?: string }): boolean {
  if (!ticket.targetCompletionAt) return false;
  if (ticket.status === "CLOSED" || ticket.status === "CANCELED") return false;
  try {
    return new Date(ticket.targetCompletionAt).getTime() < Date.now();
  } catch { return false; }
}

export function isNearingDue(ticket: { targetCompletionAt?: string | number | Date | null; status?: string }, warnDays = 1): boolean {
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
