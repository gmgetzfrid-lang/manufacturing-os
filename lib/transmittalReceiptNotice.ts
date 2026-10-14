// lib/transmittalReceiptNotice.ts
//
// SERVER-ONLY (it binds the shared client with lib/serverClientScope). The
// issuer's notice that a transmittal they issued was acknowledged — ONE
// helper for both doors that record a receipt (notifications Round G, N9):
//
//   · the recipient's portal (app/api/transmittal/route.ts POST), and
//   · the register's receipt route (app/api/transmittal/receipt/route.ts —
//     acknowledgeTransmittal in lib/transmittals.ts posts to it: a signed
//     cover sheet came back, the recipient confirmed by phone).
//
// PROD-12 dw1: until N9 only the portal told the issuer; a receipt recorded
// on the register was silent. Both now write the same ack_complete bell row
// ("Transmittal <n> acknowledged") and the same receipt email, except that
// nobody is told of their own act: an issuer who records the receipt
// themselves gets neither.
//
// DELIV-15 dw1: the receipt email (event 'watcher_activity') is gated by the
// recipient's preferences like every other event email — queueEmail run as
// the service role (runWithServerClient), so email_gate() (20261148) reads
// the issuer's row; before that migration is pasted queueEmail's fallback
// reads it with the same rule (emailAllowedByPrefs) on the same service-role
// client, which sees every row. The bell row is always written (DEC-74 §7).
// The portal's unstamped / refused-PDF notice is a different notice
// (tellIssuerUnstampable in the route) and is preference-exempt (DEC-90 A10).
//
// Best-effort by contract: the receipt is already recorded; this never
// throws and never changes the route's answer.

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyWithReason } from "@/lib/inAppNotifications";
import { formatRecordTime, orgTimeZone } from "@/lib/recordTime";
// queueEmail and the request-scoped client binding are loaded when an email
// is sent (below): the two routes that call this load nothing more than they
// did before N9 until a receipt is actually told.

/** The receipt email's event type — the 'watched' category's, so the
 *  "Activity on things I watch" toggle governs it. */
export const RECEIPT_EMAIL_EVENT = "watcher_activity";

export interface ReceiptNoticeInput {
  orgId: string;
  transmittalId: string;
  number: string;
  subject?: string | null;
  /** The transmittal's issuer (transmittals.created_by). */
  issuerUid: string | null | undefined;
  /** Who acknowledged receipt — the recipient's own name (portal) or the
   *  name the register recorded for them. */
  acknowledgedByName: string;
  via: "portal" | "manual";
  /** The member who recorded a register receipt (manual only). */
  recordedByUid?: string | null;
  /** How the notice names that member (their email in the org). */
  recordedByLabel?: string | null;
  note?: string | null;
  /** When the receipt was recorded (ISO). */
  at: string;
}

export interface ReceiptNoticeOutcome {
  /** The bell row landed. */
  told: boolean;
  /** The email went to queueEmail (which may still drop it for the
   *  issuer's preferences, or a 60-second repeat). */
  emailQueued: boolean;
  /** Why nothing was sent, when nothing was. */
  skipped?: "no_issuer" | "recorded_by_issuer";
}

/** The receipt email's subject and plain text — the portal's words as they
 *  were before N9, and the register's own. NEDGE-12 dw1 (notifications N15):
 *  the time is written through lib/recordTime.ts formatRecordTime — ISO-8601
 *  with its offset and the zone named, in the org's configured zone (else
 *  UTC, labelled) — never the server's unlabelled toLocaleString(). */
export function receiptEmailText(input: ReceiptNoticeInput, timeZone?: string | null): { subject: string; bodyText: string } {
  const subjectLine = input.subject ? ` (${input.subject})` : "";
  const noteLine = input.note ? `\n\nTheir note: ${input.note}` : "";
  const when = formatRecordTime(input.at, timeZone);
  if (input.via === "portal") {
    return {
      subject: `Transmittal ${input.number} acknowledged by ${input.acknowledgedByName}`,
      bodyText: `${input.acknowledgedByName} confirmed receipt of transmittal ${input.number}${subjectLine} through the recipient portal on ${when}.${noteLine}`,
    };
  }
  const recorder = input.recordedByLabel?.trim() || "A member of your workspace";
  return {
    subject: `Transmittal ${input.number} acknowledged by ${input.acknowledgedByName}`,
    bodyText: `${recorder} recorded ${input.acknowledgedByName}'s receipt of transmittal ${input.number}${subjectLine} on ${when}.${input.note ? `\n\nThe note: ${input.note}` : ""}`,
  };
}

/** Tell the issuer — the bell row, then the preference-gated email. */
export async function tellIssuerOfReceipt(admin: SupabaseClient, input: ReceiptNoticeInput): Promise<ReceiptNoticeOutcome> {
  const issuer = input.issuerUid ?? null;
  if (!issuer) return { told: false, emailQueued: false, skipped: "no_issuer" };
  if (input.via === "manual" && input.recordedByUid && input.recordedByUid === issuer) {
    return { told: false, emailQueued: false, skipped: "recorded_by_issuer" };
  }
  let told = false;
  try {
    const recorder = input.recordedByLabel?.trim() || "A member of your workspace";
    const bell = await notifyWithReason({
      orgId: input.orgId, userId: issuer,
      kind: "ack_complete",
      title: `Transmittal ${input.number} acknowledged`,
      body: input.via === "portal"
        ? `${input.acknowledgedByName} confirmed receipt through the portal.`
        : `${recorder} recorded ${input.acknowledgedByName}'s receipt on the register.`,
      link: "/transmittals",
      resourceType: "transmittal", resourceId: input.transmittalId,
      actorName: input.via === "portal" ? input.acknowledgedByName : recorder,
      ...(input.via === "manual" && input.recordedByUid ? { actorUserId: input.recordedByUid } : {}),
    }, admin);
    told = bell.ok;
    if (!bell.ok) console.error("[transmittal receipt] the issuer's bell notice was refused", bell.error);
  } catch (e) {
    console.error("[transmittal receipt] the issuer's bell notice failed", (e as Error)?.message ?? e);
  }

  let emailQueued = false;
  try {
    const { data: member, error } = await admin
      .from("org_members").select("email")
      .eq("org_id", input.orgId).eq("uid", issuer)
      .maybeSingle();
    if (error) console.error("[transmittal receipt] the issuer's email address could not be read", error.message);
    const toEmail = (member as { email?: string | null } | null)?.email ?? null;
    if (toEmail) {
      const { subject, bodyText } = receiptEmailText(input, await orgTimeZone(admin, input.orgId));
      const [{ queueEmail }, { runWithServerClient }] = await Promise.all([
        import("@/lib/notifications"),
        import("@/lib/serverClientScope"),
      ]);
      await runWithServerClient(admin, () => queueEmail({
        orgId: input.orgId,
        toUserId: issuer,
        toEmail,
        subject,
        bodyText,
        resourceId: input.transmittalId,
        eventType: RECEIPT_EMAIL_EVENT,
      }));
      emailQueued = true;
    }
  } catch (e) {
    console.error("[transmittal receipt] the issuer's receipt email failed", (e as Error)?.message ?? e);
  }
  return { told, emailQueued };
}
