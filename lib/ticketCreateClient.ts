// lib/ticketCreateClient.ts
//
// The browser's side of /api/tickets/create (drafting-flow Round G, DF-P2):
// the three creators — the request form, a document check-in and an intake
// collision — post the lib/ticketCreate.ts contract through here, with the
// caller's session token. Nothing here writes a ticket row, allocates a
// request number or sends a notification: the route does all three.

import { supabase } from "@/lib/supabase";
import type { TicketCreateAttachment, TicketCreateOrigin, TicketCreateSourceDoc } from "@/lib/ticketCreate";

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

export type TicketCreateResult =
  | { ok: true; id: string; ticketNumber: string; resumed: boolean; notified?: boolean; unmovedAttachments?: number; warnings?: string[] }
  | { ok: false; status: number; error: string; field?: string };

async function bearer(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** File a request. Never throws: a refusal names its field when it has one. */
export async function submitTicketCreate(body: TicketCreateBody): Promise<TicketCreateResult> {
  const token = await bearer();
  if (!token) return { ok: false, status: 401, error: "You're signed out — sign in again and resubmit." };
  let res: Response;
  try {
    res = await fetch("/api/tickets/create", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
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
    ...(typeof j.unmovedAttachments === "number" ? { unmovedAttachments: j.unmovedAttachments } : {}),
    ...(Array.isArray(j.warnings) && j.warnings.length > 0 ? { warnings: j.warnings.filter((w): w is string => typeof w === "string") } : {}),
  };
}

/** The most keys one DELETE /api/tickets/create takes. */
export const DISCARD_BATCH = 50;

/** Best-effort: discard files staged for a submit that never reached the
 *  route (an upload that failed part-way), DISCARD_BATCH keys per call. The
 *  route refuses any key that is not the caller's own staged file, or that a
 *  ticket names. Never called after a submit whose answer did not arrive
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
 *  already filed" answered. */
export interface ResumeRead {
  ticket: { id: string; number: string } | null;
  error: string | null;
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
): Promise<{ id: string; number: string } | null> {
  if (!pending) return null;
  const first = await pending;
  if (!first.error) return first.ticket;
  const second = await reread();
  return second.error ? null : second.ticket;
}
