// POST /api/stripe/portal
// Body: { orgId }
//
// Returns a Stripe Customer Portal session URL so the admin can update
// their card, see invoices, cancel, or change plan — all from a
// Stripe-hosted page. We just create the session; Stripe handles the UI.
//
// admin-and-org P4 (BILL-6 Done-when 4): before the session is minted, the
// customer on file is confirmed as this workspace's — a customer whose
// metadata names another workspace (or a deleted one) is refused 409. A
// customer with no org metadata opens as before.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { getStripe, isStripeConfigured, customerOwnershipRefusal } from "@/lib/stripe";

// roles-and-permissions SURF-19 (stripe limb, admin-and-org Round G P5): the
// billing surface's gate decides who may start a checkout or open the portal
// — its `writes` set (lib/adminSurfaces.ts: Admin, Manager, by the full role
// collection), the constant this route used to spell.

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
  const auth = await authorizeAdminSurface(req, orgId, "billing", "write");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data: org, error: orgErr } = await auth.admin
    .from("orgs")
    .select("stripe_customer_id")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) return NextResponse.json({ error: `Could not read the workspace (${orgErr.message}).` }, { status: 500 });
  const customerId = (org as { stripe_customer_id?: string } | null)?.stripe_customer_id;
  if (!customerId) {
    return NextResponse.json({ error: "No Stripe customer on file. Subscribe first to create one." }, { status: 400 });
  }

  const stripe = getStripe();
  const refusal = await customerOwnershipRefusal(stripe, customerId, orgId);
  if (refusal) {
    console.error(`[stripe/portal] org ${orgId}: portal refused for customer ${customerId}: ${refusal.error}`);
    return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  }
  const origin = req.headers.get("origin") || new URL(req.url).origin;

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/admin/billing`,
  });

  return NextResponse.json({ url: session.url });
}
