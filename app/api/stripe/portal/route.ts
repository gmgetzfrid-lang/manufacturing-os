// POST /api/stripe/portal
// Body: { orgId }
//
// Returns a Stripe Customer Portal session URL so the admin can update
// their card, see invoices, cancel, or change plan — all from a
// Stripe-hosted page. We just create the session; Stripe handles the UI.

import { NextRequest, NextResponse } from "next/server";
import { authorizeOrgRole } from "@/lib/serverAuth";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

const ADMIN_ROLES = ["Admin", "Manager"];

interface PortalBody {
  orgId: string;
}

export async function POST(req: NextRequest) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing is not configured." }, { status: 503 });
  }

  let body: PortalBody;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { orgId } = body || {};
  const auth = await authorizeOrgRole(req, orgId, ADMIN_ROLES);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data: org } = await auth.admin
    .from("orgs")
    .select("stripe_customer_id")
    .eq("id", orgId)
    .maybeSingle();
  const customerId = (org as { stripe_customer_id?: string } | null)?.stripe_customer_id;
  if (!customerId) {
    return NextResponse.json({ error: "No Stripe customer on file. Subscribe first to create one." }, { status: 400 });
  }

  const stripe = getStripe();
  const origin = req.headers.get("origin") || new URL(req.url).origin;

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/admin/billing`,
  });

  return NextResponse.json({ url: session.url });
}
