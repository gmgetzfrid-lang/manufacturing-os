// POST /api/webhooks/resend
//
// drafting-flow EVID-9 done-when 1 (notifications Round G, N18 DELIVERY
// RECORD; DEC-90 ruling (1) — fail-safe): the email provider's delivery and
// bounce reports, written onto the email row each one names, so "handed to
// the provider" (status = sent) and "delivered" / "bounced" / "complained"
// are separate facts.
//
//   * RESEND_WEBHOOK_SECRET (the endpoint's signing secret, "whsec_…") not
//     set → 503, nothing read or recorded. An unsigned, mis-signed or stale
//     (> 5 minutes) delivery → 401, nothing recorded (lib/resendWebhook.ts
//     verifyWebhookSignature). The body is never trusted before that.
//   * A delivery outcome (email.delivered / .delivery_delayed / .bounced /
//     .complained / .failed) → record_email_delivery (20261258, service role
//     only): the first time of each outcome is kept and the strongest outcome
//     wins, so the provider's retries and out-of-order deliveries are
//     harmless. Every other event type → 200, ignored.
//   * The row its message id names is not found: within ten minutes of the
//     event → 409 (the provider retries — the drain may not have written the
//     id yet); later → 200, nothing recorded (an email this app did not send,
//     or one sent before the drain kept ids).
//   * Before 20261258 is pasted the function is missing (PGRST202 / 42883) →
//     503 "paste 20261258"; the provider retries, nothing is written.
//
// The send itself is untouched: an email that works today sends exactly as
// today (app/api/notifications/send-queued/route.ts). Configure in the
// provider's dashboard: endpoint https://<site>/api/webhooks/resend, the
// email.delivered, email.delivery_delayed, email.bounced, email.complained
// and email.failed events, and copy its signing secret into
// RESEND_WEBHOOK_SECRET.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { RESEND_WEBHOOK_MAX_BYTES, parseDeliveryReport, verifyWebhookSignature } from "@/lib/resendWebhook";

export const runtime = "nodejs";

/** How long after an event an unknown message id is answered 409 (retry):
 *  the drain writes the id right after the provider accepts the send. */
export const NO_ROW_RETRY_WINDOW_MS = 10 * 60 * 1000;

const MIGRATION = "20261258_notif_roundG_delivery_record.sql";

function isMissingFunction(e: { code?: string; message?: string } | null | undefined): boolean {
  if (!e) return false;
  return e.code === "PGRST202" || e.code === "42883" || /could not find the function|function .* does not exist/i.test(e.message ?? "");
}

export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET || "";
  if (!secret) {
    return NextResponse.json({ error: "The delivery webhook is not configured (RESEND_WEBHOOK_SECRET is not set) — nothing was recorded." }, { status: 503 });
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > RESEND_WEBHOOK_MAX_BYTES) {
    return NextResponse.json({ error: "Too large — nothing was recorded." }, { status: 413 });
  }
  const body = await req.text();
  if (body.length > RESEND_WEBHOOK_MAX_BYTES) {
    return NextResponse.json({ error: "Too large — nothing was recorded." }, { status: 413 });
  }
  const h = (a: string, b: string) => req.headers.get(a) ?? req.headers.get(b);
  const verdict = verifyWebhookSignature({
    secret,
    id: h("svix-id", "webhook-id"),
    timestamp: h("svix-timestamp", "webhook-timestamp"),
    signature: h("svix-signature", "webhook-signature"),
    body,
  });
  if (!verdict.ok) {
    console.warn(`[webhooks/resend] refused a delivery: ${verdict.reason}`);
    return NextResponse.json({ error: "The signature could not be verified — nothing was recorded." }, { status: 401 });
  }

  let json: unknown;
  try { json = JSON.parse(body); } catch { return NextResponse.json({ error: "Not JSON — nothing was recorded." }, { status: 400 }); }
  const parsed = parseDeliveryReport(json);
  if (parsed.kind === "invalid") return NextResponse.json({ error: `Not a delivery report (${parsed.reason}) — nothing was recorded.` }, { status: 400 });
  if (parsed.kind === "ignored") return NextResponse.json({ recorded: false, ignored: parsed.type });

  const r = parsed.report;
  const { data, error } = await supabaseAdmin.rpc("record_email_delivery", {
    p_provider_message_id: r.providerMessageId,
    p_outcome: r.outcome,
    p_at: r.at,
    p_detail: r.detail,
  });
  if (error) {
    if (isMissingFunction(error)) {
      console.warn(`[webhooks/resend] the delivery record is not installed — paste ${MIGRATION}; the provider will retry`);
      return NextResponse.json({ error: `The delivery record is not installed yet (paste ${MIGRATION}) — nothing was recorded; the provider retries.` }, { status: 503 });
    }
    console.error(`[webhooks/resend] the ${r.outcome} report was not recorded: ${error.message}`);
    return NextResponse.json({ error: "The report could not be recorded — the provider retries." }, { status: 500 });
  }
  if (data === "no_row") {
    const atMs = r.at ? Date.parse(r.at) : Date.now();
    if (Date.now() - atMs < NO_ROW_RETRY_WINDOW_MS) {
      return NextResponse.json({ recorded: false, retry: true, reason: "No email row names this message yet." }, { status: 409 });
    }
    return NextResponse.json({ recorded: false, reason: "No email row names this message." });
  }
  return NextResponse.json({ recorded: true, outcome: r.outcome });
}
