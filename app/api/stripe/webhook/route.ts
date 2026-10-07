// POST /api/stripe/webhook
//
// Stripe POSTs event payloads here. We verify the signature against
// STRIPE_WEBHOOK_SECRET, then update the org row based on the event:
//
//   customer.subscription.created    -> set status, plan, current_period_end
//   customer.subscription.updated    -> refresh status, plan, current_period_end
//   customer.subscription.deleted    -> status='canceled', plan cleared
//   invoice.payment_succeeded        -> status='active' (the current subscription's invoice)
//   invoice.payment_failed           -> status='past_due' (the current subscription's invoice)
//
// The webhook MUST receive the raw request body for signature
// verification — Next.js App Router gives us req.text() for that.
//
// admin-and-org P4 (BILL-9, BILL-4, BILL-1, BILL-3, BILL-6):
//   - every write is CHECKED: a refused orgs update, audit row or ledger
//     row answers non-2xx, so Stripe retries (it treats 2xx as delivered);
//   - the audit rows are machine rows (DEC-87 §2): user_id NULL,
//     user_email system:stripe-webhook, user_role system;
//   - the stripe_events ledger (20261175) keys on Stripe's event id: a
//     redelivered event is a no-op, and an event older than the last one
//     applied for its subscription is recorded and not applied. Before
//     20261175 is pasted the ledger is absent and every event is applied,
//     as before (said in the log and on the audit row);
//   - a Stripe status that means no payment was taken, or one this code does
//     not know, never maps to access (lib/subscription.ts mapStripeStatus),
//     and the plan is written only on a status that pays for it;
//   - a subscription the workspace is not on cannot take its access away,
//     and an invoice changes the status only for the workspace's current
//     subscription;
//   - two workspaces claiming one Stripe customer is answered 409 (Stripe
//     retries; the operator sees it), never silently dropped.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getStripe, isStripeConfigured, planFromSubscription } from "@/lib/stripe";
import { ACCESS_STATUSES, LIVE_STRIPE_STATUSES, PLAN_HOLDING_STRIPE_STATUSES, mapStripeStatus } from "@/lib/subscription";
import type Stripe from "stripe";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

/** DEC-87 §2: the webhook writes its audit rows as a machine, never as a person. */
const STRIPE_WEBHOOK_ACTOR = { email: "system:stripe-webhook", role: "system" } as const;
const CHANNEL = "stripe-webhook";
const LEDGER_MIGRATION = "20261175_ao_roundG_stripe_events_ledger.sql";

const HANDLED = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
type DbError = { code?: string; message: string } | null;
/** What happened to an event, as the ledger records it ("duplicate" is not recorded). */
type Outcome = "applied" | "duplicate" | "stale" | "unresolved" | "superseded" | "ignored";
type Handled = { ok: true; outcome: Outcome } | { ok: false; status: number; error: string };

export async function POST(req: NextRequest) {
  if (!isStripeConfigured() || !webhookSecret) {
    return NextResponse.json({ error: "Stripe webhook not configured" }, { status: 503 });
  }

  const sig = req.headers.get("stripe-signature") || "";
  const body = await req.text();
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (e) {
    return NextResponse.json({ error: `Signature verification failed: ${(e as Error).message}` }, { status: 400 });
  }

  // ignored events still return 200 so Stripe doesn't retry
  if (!HANDLED.has(event.type)) return NextResponse.json({ received: true });

  // Use 'any' for the supabase client type — the inferred type from
  // createClient<unknown> doesn't match the parameter type expected
  // elsewhere in the @supabase/supabase-js v2 generics tree, and we
  // don't need DB type-safety here (this is a webhook handler).
  const supabase: Db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  try {
    const result = await handleEvent(supabase, event);
    if (!result.ok) {
      console.error(`[stripe/webhook] ${event.type} ${event.id ?? ""}: ${result.error}`);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ received: true, outcome: result.outcome });
  } catch (e) {
    console.error("Stripe webhook handler error:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** A Stripe reference (an id, or an expanded object) as its id. */
function idOf(ref: unknown): string | null {
  if (typeof ref === "string") return ref || null;
  const id = (ref as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? id : null;
}

/** The subscription an invoice bills. Webhook payloads are rendered in the
 *  API version of the Stripe account / endpoint, not this SDK's: up to
 *  2025-02 it is `invoice.subscription`; from 2025-03 ("basil") it moved to
 *  `invoice.parent.subscription_details.subscription`. Both are read, so an
 *  account on either version correlates its invoices. */
function invoiceSubscriptionId(inv: Record<string, unknown>): string | null {
  const parent = inv.parent as { subscription_details?: { subscription?: unknown } | null } | null | undefined;
  return idOf(inv.subscription) ?? idOf(parent?.subscription_details?.subscription);
}

async function handleEvent(sb: Db, event: Stripe.Event): Promise<Handled> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const isInvoice = event.type.startsWith("invoice.");
  const subscriptionId = isInvoice ? invoiceSubscriptionId(obj) : idOf(obj.id);
  const customerId = idOf(obj.customer);
  const eventId = typeof event.id === "string" && event.id ? event.id : null;
  const createdIso = typeof event.created === "number" ? new Date(event.created * 1000).toISOString() : null;

  // ── BILL-4: the ledger — dedupe on Stripe's event id, then the ordering guard.
  const ledger = await readLedger(sb, eventId, subscriptionId, createdIso);
  if (!ledger.ok) return ledger;
  if (ledger.duplicate) return { ok: true, outcome: "duplicate" };
  const settle = async (outcome: Outcome, orgId: string | null): Promise<Handled> => {
    if (!ledger.present || !eventId) return { ok: true, outcome };
    const { error } = await sb.from("stripe_events").insert({
      id: eventId, type: event.type, event_created: createdIso,
      subscription_id: subscriptionId, customer_id: customerId, org_id: orgId, outcome,
    });
    if (!error || error.code === "23505" || isMissingLedger(error)) return { ok: true, outcome };
    return { ok: false, status: 500, error: `The event was handled (${outcome}) but not recorded in the Stripe event ledger (${error.message}); Stripe will retry, and the retry is applied the same way.` };
  };
  const ledgerNote = ledger.present ? {} : { ledger: "absent" as const };
  if (ledger.stale) {
    console.warn(`[stripe/webhook] ${event.type} ${eventId}: older than the last event applied for ${subscriptionId}; recorded, not applied.`);
    return settle("stale", null);
  }

  // ── The workspace.
  let orgId: string | null = null;
  let orgSubscriptionId: string | null = null;
  const metaOrg = isInvoice ? null : ((obj.metadata as Record<string, string> | null | undefined)?.org_id || null);
  if (metaOrg) {
    orgId = metaOrg;
  } else {
    const found = await resolveOrgFromCustomer(sb, customerId);
    if (!found.ok) return found;
    orgId = found.org?.id ?? null;
    orgSubscriptionId = found.org?.stripe_subscription_id ?? null;
  }
  if (!orgId) {
    console.warn(`[stripe/webhook] ${event.type} ${eventId ?? ""}: no workspace for Stripe customer ${customerId ?? "(none)"}; nothing written.`);
    return settle("unresolved", null);
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const { status, known } = mapStripeStatus(sub.status);
      // XEDGE-14: the plan comes from the PRICE the customer is billed on
      // (a Customer Portal plan change never rewrites checkout metadata),
      // falling back to metadata; a null / unmapped plan leaves the stored
      // value untouched instead of writing NULL over a paying workspace.
      const resolved = planFromSubscription(sub);
      // BILL-1 Done-when 2: and it is written only on a status that pays for
      // it — an incomplete subscription (no payment taken) writes no plan.
      const plan = PLAN_HOLDING_STRIPE_STATUSES.has(sub.status) ? resolved.plan : null;
      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;
      // The subscription id is the workspace's current subscription only
      // while Stripe can still bill it (BILL-8's checkout refusal reads it).
      const live = LIVE_STRIPE_STATUSES.has(sub.status);
      const removesAccess = !ACCESS_STATUSES.has(status);

      const write = await writeOrg(sb, orgId, {
        subscription_status: status,
        ...(plan ? { subscribed_plan: plan } : {}),
        ...(live ? { stripe_subscription_id: sub.id } : {}),
        current_period_end: periodEnd,
      }, removesAccess ? { subscription: sub.id, allowNone: true } : null);
      if (!write.ok) return write;
      if (!write.applied) return settle("superseded", orgId);

      if (!known) console.warn(`[stripe/webhook] ${eventId ?? ""}: unknown Stripe status "${sub.status}" stored as "${status}" (no access).`);
      const auditErr = await auditRow(sb, `STRIPE_${event.type.toUpperCase().replace(/\./g, "_")}`, orgId, {
        event_id: eventId, subscription_id: sub.id,
        stripe_status: sub.status, mapped_status: status, ...(known ? {} : { status_unknown: true }),
        plan, plan_source: plan ? resolved.source : null, ...(resolved.plan && !plan ? { plan_withheld: resolved.plan } : {}),
        period_end: periodEnd, ...ledgerNote,
      });
      if (auditErr) return auditRefused(auditErr);
      return settle("applied", orgId);
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      // BILL-3 Done-when 2: a canceled subscription keeps no plan.
      const write = await writeOrg(sb, orgId, {
        subscription_status: "canceled",
        stripe_subscription_id: null,
        subscribed_plan: null,
      }, { subscription: sub.id, allowNone: true });
      if (!write.ok) return write;
      if (!write.applied) return settle("superseded", orgId);
      const auditErr = await auditRow(sb, "STRIPE_CUSTOMER_SUBSCRIPTION_DELETED", orgId, {
        event_id: eventId, subscription_id: sub.id, plan_cleared: true, ...ledgerNote,
      });
      if (auditErr) return auditRefused(auditErr);
      return settle("applied", orgId);
    }

    case "invoice.payment_succeeded":
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      // BILL-4 Done-when 4: an invoice moves the status only for the
      // workspace's current subscription — not a one-off invoice, not an old
      // subscription's, not a first invoice before its subscription is live.
      if (!subscriptionId || orgSubscriptionId !== subscriptionId) {
        console.info(`[stripe/webhook] ${event.type} ${eventId ?? ""}: invoice ${inv.id} is not for workspace ${orgId}'s current subscription; status unchanged.`);
        return settle("ignored", orgId);
      }
      const succeeded = event.type === "invoice.payment_succeeded";
      const write = await writeOrg(sb, orgId, { subscription_status: succeeded ? "active" : "past_due" },
        { subscription: subscriptionId, allowNone: false });
      if (!write.ok) return write;
      if (!write.applied) return settle("superseded", orgId);
      const auditErr = await auditRow(sb, succeeded ? "STRIPE_INVOICE_PAYMENT_SUCCEEDED" : "STRIPE_INVOICE_PAYMENT_FAILED", orgId, {
        event_id: eventId, invoice_id: inv.id, subscription_id: subscriptionId,
        ...(succeeded ? {} : { attempt: inv.attempt_count }), ...ledgerNote,
      });
      if (auditErr) return auditRefused(auditErr);
      return settle("applied", orgId);
    }
  }
  return { ok: true, outcome: "ignored" };
}

/** The ledger table is absent: 20261175 is not pasted yet (PostgREST
 *  PGRST205, or Postgres 42P01 undefined_table). */
function isMissingLedger(error: DbError): boolean {
  if (!error) return false;
  if (error.code === "PGRST205" || error.code === "42P01") return true;
  return /stripe_events/.test(error.message) && /does not exist|schema cache/i.test(error.message);
}

/** BILL-4: has this event been handled already, and has a newer event for
 *  its subscription been applied? A read that fails (other than the table
 *  being absent) is a non-2xx, so Stripe retries rather than the event
 *  being applied unguarded. */
async function readLedger(sb: Db, eventId: string | null, subscriptionId: string | null, createdIso: string | null):
  Promise<{ ok: true; present: boolean; duplicate: boolean; stale: boolean } | { ok: false; status: number; error: string }> {
  if (!eventId) return { ok: true, present: false, duplicate: false, stale: false };
  const { data: seen, error } = await sb.from("stripe_events").select("id").eq("id", eventId).maybeSingle();
  if (error) {
    if (isMissingLedger(error)) {
      console.warn(`[stripe/webhook] the stripe_events ledger is absent (${LEDGER_MIGRATION} not pasted): event ${eventId} is applied without the duplicate and ordering guards.`);
      return { ok: true, present: false, duplicate: false, stale: false };
    }
    return { ok: false, status: 500, error: `Could not read the Stripe event ledger (${error.message}); Stripe will retry.` };
  }
  if (seen) return { ok: true, present: true, duplicate: true, stale: false };
  if (!subscriptionId || !createdIso) return { ok: true, present: true, duplicate: false, stale: false };
  const { data: newer, error: newerErr } = await sb.from("stripe_events").select("id")
    .eq("subscription_id", subscriptionId).eq("outcome", "applied").gt("event_created", createdIso).limit(1);
  if (newerErr) return { ok: false, status: 500, error: `Could not read the Stripe event ledger (${newerErr.message}); Stripe will retry.` };
  return { ok: true, present: true, duplicate: false, stale: Array.isArray(newer) && newer.length > 0 };
}

/** BILL-6 Done-when 3: the workspace that holds this Stripe customer. More
 *  than one is a conflict answered 409 — Stripe retries, and the delivery
 *  shows as failing in its dashboard — never a silent drop. */
async function resolveOrgFromCustomer(sb: Db, customerId: string | null):
  Promise<{ ok: true; org: { id: string; stripe_subscription_id: string | null } | null } | { ok: false; status: number; error: string }> {
  if (!customerId) return { ok: true, org: null };
  const { data, error } = await sb
    .from("orgs")
    .select("id, stripe_subscription_id")
    .eq("stripe_customer_id", customerId)
    .limit(2);
  if (error) return { ok: false, status: 500, error: `Could not look up the workspace for Stripe customer ${customerId} (${error.message}); Stripe will retry.` };
  const rows = (Array.isArray(data) ? data : []) as Array<{ id: string; stripe_subscription_id?: string | null }>;
  if (rows.length > 1) {
    return { ok: false, status: 409, error: `More than one workspace claims Stripe customer ${customerId}; nothing was written. Clear the stray orgs.stripe_customer_id (${LEDGER_MIGRATION}'s inventory counts them) and Stripe's retry applies the event.` };
  }
  return { ok: true, org: rows[0] ? { id: rows[0].id, stripe_subscription_id: rows[0].stripe_subscription_id ?? null } : null };
}

const pgrstQuote = (v: string) => `"${v.replace(/["\\]/g, "\\$&")}"`;

/** One CHECKED orgs update. With a guard it applies only while the
 *  workspace is on that subscription (or, with allowNone, on none), and says
 *  whether it did: a subscription the workspace is not on cannot take its
 *  access away, and an invoice moves only the current subscription. */
async function writeOrg(sb: Db, orgId: string, patch: Record<string, unknown>, guard: { subscription: string; allowNone: boolean } | null):
  Promise<{ ok: true; applied: boolean } | { ok: false; status: number; error: string }> {
  let q = sb.from("orgs").update(patch).eq("id", orgId);
  if (guard) {
    q = guard.allowNone
      ? q.or(`stripe_subscription_id.is.null,stripe_subscription_id.eq.${pgrstQuote(guard.subscription)}`)
      : q.eq("stripe_subscription_id", guard.subscription);
    q = q.select("id");
  }
  const { data, error } = await q;
  if (error) return { ok: false, status: 500, error: `The workspace's billing state was not written (${error.message}); Stripe will retry.` };
  return { ok: true, applied: guard ? Array.isArray(data) && data.length > 0 : true };
}

/** DEC-87 §2: a machine audit row, CHECKED by the caller. */
async function auditRow(sb: Db, action: string, orgId: string, details: Record<string, unknown>): Promise<DbError> {
  const { error } = await sb.from("audit_logs").insert({
    action,
    resource_id: orgId,
    resource_type: "org",
    org_id: orgId,
    user_id: null,
    user_email: STRIPE_WEBHOOK_ACTOR.email,
    user_role: STRIPE_WEBHOOK_ACTOR.role,
    details: { channel: CHANNEL, ...details },
  });
  return error ?? null;
}

function auditRefused(error: NonNullable<DbError>): Handled {
  return { ok: false, status: 500, error: `The workspace's billing state was written but its audit row was not (${error.message}); Stripe will retry, which writes both again.` };
}
