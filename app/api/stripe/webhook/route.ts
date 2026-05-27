// POST /api/stripe/webhook
//
// Stripe POSTs event payloads here. We verify the signature against
// STRIPE_WEBHOOK_SECRET, then update the org row based on the event:
//
//   customer.subscription.created    -> set status, plan, current_period_end
//   customer.subscription.updated    -> refresh status, plan, current_period_end
//   customer.subscription.deleted    -> status='canceled'
//   invoice.payment_succeeded        -> ensure status='active'
//   invoice.payment_failed           -> status='past_due'
//
// The webhook MUST receive the raw request body for signature
// verification — Next.js App Router gives us req.text() for that.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import type Stripe from "stripe";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

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

  // Use 'any' for the supabase client type — the inferred type from
  // createClient<unknown> doesn't match the parameter type expected
  // elsewhere in the @supabase/supabase-js v2 generics tree, and we
  // don't need DB type-safety here (this is a webhook handler).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const orgId = (sub.metadata?.org_id as string) || await resolveOrgIdFromCustomer(supabase, sub.customer as string);
        if (!orgId) break;

        const status = mapStripeStatus(sub.status);
        const plan = (sub.metadata?.plan as string) || null;
        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null;

        await supabase.from("orgs").update({
          subscription_status: status,
          subscribed_plan: plan,
          stripe_subscription_id: sub.id,
          current_period_end: periodEnd,
        }).eq("id", orgId);

        await supabase.from("audit_logs").insert({
          action: `STRIPE_${event.type.toUpperCase().replace(/\./g, "_")}`,
          resource_id: orgId,
          resource_type: "org",
          org_id: orgId,
          user_id: "stripe",
          user_email: "stripe-webhook",
          details: { stripe_status: sub.status, mapped_status: status, plan, period_end: periodEnd },
        });
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const orgId = (sub.metadata?.org_id as string) || await resolveOrgIdFromCustomer(supabase, sub.customer as string);
        if (!orgId) break;
        await supabase.from("orgs").update({
          subscription_status: "canceled",
          stripe_subscription_id: null,
        }).eq("id", orgId);
        await supabase.from("audit_logs").insert({
          action: "STRIPE_CUSTOMER_SUBSCRIPTION_DELETED",
          resource_id: orgId, resource_type: "org", org_id: orgId,
          user_id: "stripe", user_email: "stripe-webhook",
          details: { subscription_id: sub.id },
        });
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = inv.customer as string;
        const orgId = await resolveOrgIdFromCustomer(supabase, customerId);
        if (!orgId) break;
        await supabase.from("orgs").update({
          subscription_status: "active",
        }).eq("id", orgId);
        break;
      }

      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = inv.customer as string;
        const orgId = await resolveOrgIdFromCustomer(supabase, customerId);
        if (!orgId) break;
        await supabase.from("orgs").update({
          subscription_status: "past_due",
        }).eq("id", orgId);
        await supabase.from("audit_logs").insert({
          action: "STRIPE_INVOICE_PAYMENT_FAILED",
          resource_id: orgId, resource_type: "org", org_id: orgId,
          user_id: "stripe", user_email: "stripe-webhook",
          details: { invoice_id: inv.id, attempt: inv.attempt_count },
        });
        break;
      }

      default:
        // ignored events still return 200 so Stripe doesn't retry
        break;
    }
  } catch (e) {
    console.error("Stripe webhook handler error:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveOrgIdFromCustomer(supabase: any, customerId: string): Promise<string | null> {
  if (!customerId) return null;
  const { data } = await supabase
    .from("orgs")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return (data as { id?: string } | null)?.id || null;
}

function mapStripeStatus(s: string): string {
  // Stripe subscription statuses: incomplete, incomplete_expired, trialing,
  // active, past_due, canceled, unpaid, paused
  // We mirror the schema's CHECK constraint exactly.
  switch (s) {
    case "active": return "active";
    case "trialing": return "trialing";
    case "past_due": return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "unpaid": return "unpaid";
    case "paused": return "paused";
    default: return "trialing";
  }
}
