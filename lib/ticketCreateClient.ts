// lib/ticketCreateClient.ts
//
// The browser's side of /api/tickets/create (drafting-flow Round G, DF-P2):
// the three creators — the request form, a document check-in and an intake
// collision — post the lib/ticketCreate.ts contract through here, with the
// caller's session token. Nothing here writes a ticket row, allocates a
// request number or sends a notification: the route does all three.

import { supabase } from "@/lib/supabase";
import { unitListReadFailure, type TicketCreateAttachment, type TicketCreateOrigin, type TicketCreateSourceDoc } from "@/lib/ticketCreate";

/** The body the route reads (lib/ticketCreate.ts parseTicketCreateBody). */
export interface TicketCreateBody {
  orgId: string;
  title: string;
  description: string;
  requestType: string;
  priority?: number;
  /** null / "" = "Unit unknown — triage assigns". */
  unit?: string | null;
  targetCompletionAt?: string | null;
  requesterRole?: string | null;
  customCategories?: Record<string, Record<string, unknown>> | null;
  sourceDocuments?: TicketCreateSourceDoc[];
  attachments?: TicketCreateAttachment[];
  origin: TicketCreateOrigin;
}

/** LIFE-7: what became of a check-in's PSM escalation, which the route sends
 *  (DF-P2 review fix) — "sent" to the controllers; "unrouted": no other
 *  controller exists (the route audited it; the reporter must escalate by
 *  hand); "failed": not sent this time (the ticket is not stamped, so the
 *  check-in's next attempt sends it). Absent when there was nothing to send
 *  or it had already gone. */
export type PsmAlertOutcome = "sent" | "unrouted" | "failed";

/** EDGE-8: `notified` is whether the route told the assignment queue — false
 *  when the notice failed or had nobody to go to, with `notifyReason` saying
 *  which. The request is filed either way; a resumed check-in sends the
 *  notice the first attempt did not. */
export type TicketCreateResult =
  | { ok: true; id: string; ticketNumber: string; resumed: boolean; notified?: boolean; notifyReason?: string; psmAlert?: PsmAlertOutcome; warnings?: string[] }
  | { ok: false; status: number; error: string; field?: string };

/** EDGE-8: the sentence a creator shows (the request form) or records (the
 *  check-in panel, the intake collision) when the route filed the request
 *  but could not tell the assignment queue. Nothing when the queue was told,
 *  or when the answer does not say. */
export function queueNotNotifiedLine(res: { ticketNumber: string; notified?: boolean; notifyReason?: string }): string | null {
  if (res.notified !== false) return null;
  return `${res.ticketNumber} is filed, but the assignment queue was not notified (${res.notifyReason || "the notice could not be sent"}) — tell your supervisor it is waiting.`;
}

/** DCW-7 / FRIC-3: the Site Codebook's units as the request form offers them
 *  — the read the create route makes (codebook_entries, kind "unit"), with
 *  its failure classed the same way (lib/ticketCreate.ts
 *  unitListReadFailure): "missing" (the codebook is not there yet) is no
 *  list, the free-text box; "unreadable" is a list the form cannot show, so
 *  it offers no unit at all (the request files as "Unit unknown") and says
 *  so — never a free-text box the route would refuse, or a silent empty
 *  list. lib/codebook loadCodebook answers an empty codebook for both, so the
 *  form does not use it for the unit list. */
export async function loadCodebookUnitList(orgId: string): Promise<{
  units: Array<{ code: string; label: string | null }>;
  failure: "none" | "missing" | "unreadable";
}> {
  try {
    const { data, error } = await supabase
      .from("codebook_entries").select("code, label").eq("org_id", orgId).eq("kind", "unit")
      .order("sort").order("code");
    const failure = unitListReadFailure(error);
    if (failure !== "none") return { units: [], failure };
    const units = ((data ?? []) as Array<{ code?: unknown; label?: unknown }>)
      .filter((u): u is { code: string; label: unknown } => typeof u.code === "string" && u.code !== "")
      .map((u) => ({ code: u.code, label: typeof u.label === "string" ? u.label : null }));
    return { units, failure };
  } catch {
    return { units: [], failure: "unreadable" };
  }
}

async function bearer(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** File a request. Never throws: a refusal names its field when it has one.
 *  The requester's calendar year rides along (`localYear`, this browser's
 *  clock): the request number carries it when it is a year in force
 *  somewhere right now (lib/ticketCreate.ts requestNumberYear). */
export async function submitTicketCreate(body: TicketCreateBody): Promise<TicketCreateResult> {
  const token = await bearer();
  if (!token) return { ok: false, status: 401, error: "You're signed out — sign in again and resubmit." };
  let res: Response;
  try {
    res = await fetch("/api/tickets/create", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, localYear: new Date().getFullYear() }),
    });
  } catch {
    return { ok: false, status: 0, error: "Couldn't reach the server — check your connection and try again." };
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: typeof j.error === "string" && j.error ? j.error : `The request was not filed (HTTP ${res.status}).`,
      ...(typeof j.field === "string" ? { field: j.field } : {}),
    };
  }
  if (typeof j.id !== "string" || typeof j.ticketNumber !== "string") {
    return { ok: false, status: res.status, error: "The server answered without the request it filed — check the queue before resubmitting." };
  }
  return {
    ok: true,
    id: j.id,
    ticketNumber: j.ticketNumber,
    resumed: j.resumed === true,
    ...(typeof j.notified === "boolean" ? { notified: j.notified } : {}),
    ...(j.notified === false && typeof j.notifyReason === "string" && j.notifyReason ? { notifyReason: j.notifyReason } : {}),
    ...(j.psmAlert === "sent" || j.psmAlert === "unrouted" || j.psmAlert === "failed" ? { psmAlert: j.psmAlert } : {}),
    ...(Array.isArray(j.warnings) && j.warnings.length > 0 ? { warnings: j.warnings.filter((w): w is string => typeof w === "string") } : {}),
  };
}

/** The most keys one DELETE /api/tickets/create takes. */
export const DISCARD_BATCH = 50;

/** Best-effort: discard files staged for a submit that never reached the
 *  route (an upload that failed part-way), DISCARD_BATCH keys per call. The
 *  route deletes only the caller's own staged keys that no ticket names, and
 *  answers each key as deleted, kept (a ticket names it), unchecked or
 *  foreign. Never called after a submit whose answer did not arrive
 *  (status 0): the route may still be filing those files — the orphan sweep,
 *  which works by reference, reclaims them if it did not. */
export async function discardStagedFiles(orgId: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const token = await bearer();
  if (!token) return;
  for (let i = 0; i < keys.length; i += DISCARD_BATCH) {
    try {
      await fetch("/api/tickets/create", {
        method: "DELETE",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId, keys: keys.slice(i, i + DISCARD_BATCH) }),
      });
    } catch { /* the orphan sweep reclaims them */ }
  }
}

/** LEAK-6: what a check-in's mount-time read of "the ticket this episode
 *  already filed" answered. `escalationPending`: the ticket records an
 *  undocumented field change and carries no psm_escalated_at stamp — the
 *  PSM escalation never went out. `noticePending` (EDGE-8): the ticket is
 *  still waiting in the queue and carries no created_notice_at stamp — the
 *  creation notice never went out. Either way the panel hands the check-in
 *  to the route (which resumes the ticket and sends what is missing, once)
 *  instead of reusing the ticket silently. */
export interface ResumeRead {
  ticket: { id: string; number: string; escalationPending?: boolean; noticePending?: boolean } | null;
  error: string | null;
}

/** True when a ticket's metadata records an undocumented field change whose
 *  PSM escalation was never stamped as sent. */
export function psmEscalationPending(metadata: unknown): boolean {
  const m = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  return m.undocumented_change === true && !m.psm_escalated_at;
}

/** EDGE-8: true when a ticket is still waiting for assignment and its
 *  creation notice was never stamped as sent (the route stamps
 *  metadata.created_notice_at once the queue is told). */
export function creationNoticePending(status: unknown, metadata: unknown): boolean {
  const m = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  return status === "PENDING_ASSIGNMENT" && !m.created_notice_at;
}

/** LEAK-6: the ticket a check-in resumes, decided BEFORE anything is filed.
 *  The panel's mount-time read is awaited (a slow read is waited for, never
 *  raced past); a read that failed is made once more; and when it still
 *  cannot answer, null — the create route then resumes by the same
 *  episode itself, server-side, so a failed or slow read can never file a
 *  second ticket. */
export async function resumeCheckinTicket(
  pending: Promise<ResumeRead> | null,
  reread: () => Promise<ResumeRead>,
): Promise<{ id: string; number: string; escalationPending?: boolean; noticePending?: boolean } | null> {
  if (!pending) return null;
  const first = await pending;
  if (!first.error) return first.ticket;
  const second = await reread();
  return second.error ? null : second.ticket;
}
