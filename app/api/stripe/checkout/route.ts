// POST /api/stripe/checkout
// Body: { orgId, plan: 'starter'|'growth' }
//
// Creates a Stripe Checkout Session for the org's admin to subscribe.
// Reuses an existing Stripe customer if the org has one; otherwise
// creates a new customer and stores its id on the org row so subsequent
// portal sessions can be opened without re-creating.
//
// Returns { url } pointing to Stripe-hosted checkout. Client redirects.
//
// admin-and-org P4 (BILL-8): a workspace that already holds a live
// subscription is refused 409 (a second checkout would bill it twice) — the
// row is read first and a live-looking one confirmed with Stripe; the
// customer is created under an idempotency key derived from the org id, and
// its id is written to the org as a CHECKED write (a refusal is a 500 and no
// checkout session is minted, so a payment can never land on a customer the
// workspace does not record).

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { getStripe, getPriceIdForPlan, isStripeConfigured, customerIdempotencyKey, liveSubscriptionRefusal, type PlanKey } from "@/lib/stripe";

const ADMIN_ROLES = ["Admin", "Manager"];

interface CheckoutBody {
  orgId: string;
  plan?: string;
}

export async function POST(req: NextRequest) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing is not configured yet — ask your administrator to set STRIPE_SECRET_KEY." }, { status: 503 });
  }

  let body: CheckoutBody;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { orgId, plan } = body || {};
  const auth = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!plan || (plan !== "starter" && plan !== "growth")) {
    return NextResponse.json({ error: "Plan must be 'starter' or 'growth'." }, { status: 400 });
  }

  const priceId = getPriceIdForPlan(plan as PlanKey);
  if (!priceId) {
    return NextResponse.json({ error: `Price ID for plan '${plan}' not configured.` }, { status: 503 });
  }

  const stripe = getStripe();

  // Look up org for an existing stripe_customer_id (and, BILL-8, its
  // subscription). CHECKED: a failed read is a 500, never "not found".
  const { data: org, error: orgErr } = await auth.admin
    .from("orgs")
    .select("id, name, stripe_customer_id, stripe_subscription_id, subscription_status")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) return NextResponse.json({ error: `Could not read the workspace (${orgErr.message}); nothing was started.` }, { status: 500 });
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  // BILL-8 Done-when 1: one live subscription per workspace.
  const live = await liveSubscriptionRefusal(stripe, org as { stripe_subscription_id?: string | null; subscription_status?: string | null });
  if (live) return NextResponse.json({ error: live.error }, { status: live.status });

  let customerId = (org as { stripe_customer_id?: string }).stripe_customer_id || null;

  // Create customer if needed
  if (!customerId) {
    let customer: { id: string };
    try {
      customer = await stripe.customers.create({
        email: auth.email,
        name: (org as { name?: string }).name || undefined,
        metadata: { org_id: orgId, signup_user_id: auth.userId },
      }, { idempotencyKey: customerIdempotencyKey(orgId) });
    } catch (e) {
      return NextResponse.json({ error: `Could not create the workspace's Stripe customer (${(e as Error).message}); nothing was started. Try again in a moment.` }, { status: 502 });
    }
    customerId = customer.id;
    const { error: customerWriteErr } = await auth.admin
      .from("orgs")
      .update({ stripe_customer_id: customerId })
      .eq("id", orgId);
    if (customerWriteErr) {
      return NextResponse.json({ error: `The Stripe customer was created but could not be recorded on the workspace (${customerWriteErr.message}); nothing was charged. Try again — the same customer is reused.` }, { status: 500 });
    }
  }

  // Build return URLs from the request's origin
  const origin = req.headers.get("origin") || new URL(req.url).origin;

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/admin/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/admin/billing?checkout=canceled`,
    subscription_data: {
      metadata: { org_id: orgId, plan: String(plan) },
    },
    metadata: { org_id: orgId, plan: String(plan) },
    allow_promotion_codes: true,
    billing_address_collection: "required",
  });

  const { error: auditErr } = await auth.admin.from("audit_logs").insert({
    action: "STRIPE_CHECKOUT_CREATED",
    resource_id: orgId,
    resource_type: "org",
    org_id: orgId,
    user_id: auth.userId,
    user_email: auth.email,
    user_role: auth.role,
    details: { plan, session_id: session.id },
  });
  // CHECKED: the session stands (the customer is on their way to Stripe);
  // a refused audit row is said in the answer and the log, never swallowed.
  if (auditErr) {
    console.error(`[stripe/checkout] org ${orgId}: the STRIPE_CHECKOUT_CREATED audit row was not written: ${auditErr.message}`);
    return NextResponse.json({ url: session.url, warning: `Checkout started, but it could not be recorded in the audit log: ${auditErr.message}` });
  }

  return NextResponse.json({ url: session.url });
}
