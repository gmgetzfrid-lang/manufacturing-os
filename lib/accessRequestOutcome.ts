// lib/accessRequestOutcome.ts
//
// SERVER-ONLY. The answer to an access request, emailed to the address the
// person gave at the door (notifications PROD-2 done-when 2, N8 PRODUCERS-
// FREE), and the pool told about a new request (ACCESS_REQUEST_AUDIENCE).
// Two service-role routes call the outcome email after their own write succeeded:
//
//   · /api/admin/access-requests — a decline (the person has no account:
//     the row is EXTERNAL mail, queued from the stored request, never from a
//     request body — the SURF-17 shape /api/transmittal/send-email uses);
//   · /api/admin/create-user — the membership that answered a pending
//     request (the address is now the new member's own).
//
// email_notifications.to_user_id is NOT NULL (20260529): an external row
// carries the deciding controller as its owner and metadata.external = true,
// as the transmittal route's does; the approval row carries the new member.
// Best-effort: a queue failure is logged and never fails the decision, which
// is already recorded. The maintenance cron drains the queue.

import type { SupabaseClient } from "@supabase/supabase-js";
import { configuredPublicOrigin } from "@/lib/publicOrigin";

/** The roles told about a NEW request (the request door, PROD-2 dw1): the
 *  org's Admin / DocCtrl pool — DEC-44 (N8) item 1, the pool the holds
 *  audience uses; both may grant the membership at /api/admin/create-user
 *  and decline at /api/admin/access-requests. */
export const ACCESS_REQUEST_AUDIENCE = ["Admin", "DocCtrl"] as const;

export type AccessRequestOutcome = "approved" | "declined";

export interface AccessRequestOutcomeInput {
  outcome: AccessRequestOutcome;
  orgId: string;
  orgName: string | null;
  /** The access_requests rows this decision answered. */
  requestIds: string[];
  /** The address on the request. Nothing is queued without one. */
  toEmail: string | null;
  /** The row's owner: the deciding controller (a decline), or the new
   *  member (an approval). */
  queuedBy: string;
  /** The address belongs to a member of the org now (an approval). */
  toMember?: boolean;
}

/** The message, rendered from the stored request only. Exported for the test. */
export function renderAccessRequestOutcome(input: Pick<AccessRequestOutcomeInput, "outcome" | "orgName">, origin = configuredPublicOrigin()): {
  subject: string; text: string;
} {
  const org = input.orgName?.trim() || "the workspace";
  if (input.outcome === "approved") {
    const where = origin ? ` Sign in at ${origin}/login.` : " Sign in to the app to get started.";
    return {
      subject: `Your request to join ${org} was approved`,
      text: `Your request to join ${org} was approved — you now have access.${where}`,
    };
  }
  return {
    subject: `Your request to join ${org}`,
    text: `Your request to join ${org} was declined. If you think this is a mistake, contact the workspace's administrator.`,
  };
}

/** Queue the outcome email. Never throws. Answers whether a row was queued. */
export async function queueAccessRequestOutcome(
  sb: SupabaseClient,
  input: AccessRequestOutcomeInput,
): Promise<boolean> {
  const to = input.toEmail?.trim() ?? "";
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || input.requestIds.length === 0) return false;
  const { subject, text } = renderAccessRequestOutcome(input);
  try {
    const { error } = await sb.from("email_notifications").insert({
      org_id: input.orgId,
      to_user_id: input.queuedBy,
      to_email: to,
      subject,
      body_text: text,
      body_html: null,
      resource_type: null,
      resource_id: input.requestIds[0],
      event_type: input.outcome === "approved" ? "access_request_approved" : "access_request_declined",
      metadata: {
        accessRequestIds: input.requestIds,
        sentVia: "server",
        ...(input.toMember ? {} : { external: true }),
      },
      status: "queued",
    });
    if (error) {
      console.warn(`[access-request] the ${input.outcome} email was not queued: ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[access-request] the ${input.outcome} email was not queued: ${(e as Error).message}`);
    return false;
  }
}
