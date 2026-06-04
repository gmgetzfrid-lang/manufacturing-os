// POST /api/stripe/checkout
// Body: { orgId, plan: 'starter'|'growth' }
//
// Creates a Stripe Checkout Session for the org's admin to subscribe.
// Reuses an existing Stripe customer if the org has one; otherwise
// creates a new customer and stores its id on the org row so subsequent
// portal sessions can be opened without re-creating.
//
// Returns { url } pointing to Stripe-hosted checkout. Client redirects.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { getStripe, getPriceIdForPlan, isStripeConfigured, type PlanKey } from "@/lib/stripe";

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

  // Look up org for an existing stripe_customer_id
  const { data: org } = await auth.admin
    .from("orgs")
    .select("id, name, stripe_customer_id")
    .eq("id", orgId)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  let customerId = (org as { stripe_customer_id?: string }).stripe_customer_id || null;

  // Create customer if needed
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: auth.email,
      name: (org as { name?: string }).name || undefined,
      metadata: { org_id: orgId, signup_user_id: auth.userId },
    });
    customerId = customer.id;
    await auth.admin
      .from("orgs")
      .update({ stripe_customer_id: customerId })
      .eq("id", orgId);
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

  await auth.admin.from("audit_logs").insert({
    action: "STRIPE_CHECKOUT_CREATED",
    resource_id: orgId,
    resource_type: "org",
    org_id: orgId,
    user_id: auth.userId,
    user_email: auth.email,
    user_role: auth.role,
    details: { plan, session_id: session.id },
  });

  return NextResponse.json({ url: session.url });
}
