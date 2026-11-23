// lib/workspaceSignupServer.ts - SERVER ONLY. A new workspace starts with
// a payment, and only then exists.
//
//   1. /signup: company, name, work email, plan -> startCheckout() checks
//      the name and email are new and opens a payment page. Nothing is made.
//   2. The payment goes through -> provisionWorkspace(session) makes the
//      workspace, its first admin's account (no password yet), the
//      membership and the profile. Run by the payment webhook and by the
//      finish page, whichever comes first; safe to run twice.
//   3. /signup/finish: the payer sets their password once (setFirstPassword),
//      then signs in. After that, the admin adds everyone else.
//
// There is no other way to make a workspace, and no way to make your own
// account (lib/accountsServer).

import type Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStripe, getPriceIdForPlan, isStripeConfigured, type PlanKey } from "@/lib/stripe";
import { accountByEmail, emailInUse, looksLikeEmail, normEmail } from "@/lib/accountsServer";
import { passwordProblem } from "@/lib/signinPolicy";

export const KIND = "new_workspace";
/** How long after paying the first password can be set from the finish page. */
const FINISH_WINDOW_MS = 7 * 86400_000;

export class SignupError extends Error { constructor(message: string, public status = 400) { super(message); } }

export interface CheckoutInput { company: string; name: string; email: string; plan: string; origin: string }

export async function startCheckout(input: CheckoutInput): Promise<{ url: string }> {
  if (!isStripeConfigured()) throw new SignupError("Payment isn't set up on this site yet, so new workspaces can't be started.", 503);
  const company = String(input.company ?? "").trim().replace(/\s+/g, " ");
  const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
  const email = normEmail(input.email);
  const plan = String(input.plan ?? "") as PlanKey;
  if (company.length < 2 || company.length > 120) throw new SignupError("Enter the company name.");
  if (name.length < 2 || name.length > 120) throw new SignupError("Enter your name.");
  if (!looksLikeEmail(email)) throw new SignupError("Enter your work email.");
  const price = plan === "starter" || plan === "growth" ? getPriceIdForPlan(plan) : null;
  if (!price) throw new SignupError("Pick a plan.");

  const { data: sameName, error: nErr } = await supabaseAdmin.from("orgs").select("id").ilike("name", company).limit(1);
  if (nErr) throw new SignupError("Couldn't check the company name. Try again.", 503);
  if ((sameName ?? []).length) throw new SignupError(`A workspace named "${company}" already exists. If you work there, ask its admin to add you.`, 409);
  if (await emailInUse(email)) throw new SignupError("This email already has an account. Sign in, or ask your workspace admin.", 409);

  const meta = { kind: KIND, company, name, email, plan };
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer_email: email,
    line_items: [{ price, quantity: 1 }],
    metadata: meta,
    subscription_data: { metadata: { kind: KIND, plan } },
    success_url: `${input.origin}/signup/finish?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/signup?canceled=1`,
    allow_promotion_codes: true,
    billing_address_collection: "required",
  });
  if (!session.url) throw new SignupError("The payment page couldn't be opened. Try again.", 502);
  return { url: session.url };
}

/** A finished payment for a new workspace, or a reason it isn't one. */
function paidNewWorkspace(s: Stripe.Checkout.Session): { company: string; name: string; email: string; plan: string } {
  const m = s.metadata ?? {};
  if (m.kind !== KIND) throw new SignupError("This payment isn't for a new workspace.", 404);
  if (s.status !== "complete" || !(s.payment_status === "paid" || s.payment_status === "no_payment_required")) {
    throw new SignupError("The payment hasn't gone through yet.", 402);
  }
  return { company: String(m.company ?? ""), name: String(m.name ?? ""), email: normEmail(m.email), plan: String(m.plan ?? "") };
}

const mapStatus = (s: string) => (s === "active" || s === "trialing" || s === "past_due" || s === "unpaid" || s === "paused" ? s : s === "canceled" || s === "incomplete_expired" ? "canceled" : "incomplete");

/** Make the paid workspace: account, workspace, membership, profile. Safe
 *  to run again for the same payment (it finds what it made). */
export async function provisionWorkspace(session: Stripe.Checkout.Session): Promise<{ orgId: string; uid: string; email: string; company: string }> {
  const p = paidNewWorkspace(session);
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;

  // Already made for this payment?
  if (customerId) {
    const { data: made } = await supabaseAdmin.from("orgs").select("id, created_by, name").eq("stripe_customer_id", customerId).maybeSingle();
    const o = made as { id: string; created_by: string; name: string } | null;
    if (o) return { orgId: o.id, uid: o.created_by, email: p.email, company: o.name };
  }

  // The first admin's account: no password until they set one on the finish page.
  let uid = (await accountByEmail(p.email))?.id ?? null;
  if (!uid) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: p.email, email_confirm: true,
      user_metadata: { display_name: p.name },
      app_metadata: { workspace_payment: session.id },
    });
    if (error || !data.user) {
      uid = (await accountByEmail(p.email))?.id ?? null;
      if (!uid) throw new SignupError(`The account couldn't be made: ${error?.message ?? "unknown"}`, 500);
    } else uid = data.user.id;
  }

  let status = "active";
  let periodEnd: string | null = null;
  if (subId) {
    try {
      const sub = await getStripe().subscriptions.retrieve(subId);
      status = mapStatus(sub.status);
      periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
    } catch { /* the webhook's subscription events fill it in */ }
  }

  const { data: org, error: oErr } = await supabaseAdmin.from("orgs").insert({
    name: p.company, type: "business", created_by: uid,
    billing: { status, plan: p.plan, checkout_session: session.id },
    subscription_status: status, subscribed_plan: p.plan,
    stripe_customer_id: customerId, stripe_subscription_id: subId, current_period_end: periodEnd,
  }).select("id").single();
  if (oErr || !org) {
    // Made a moment ago by the other caller (webhook or finish page)?
    if (customerId) {
      const { data: again } = await supabaseAdmin.from("orgs").select("id, name").eq("stripe_customer_id", customerId).maybeSingle();
      const a = again as { id: string; name: string } | null;
      if (a) return { orgId: a.id, uid, email: p.email, company: a.name };
    }
    throw new SignupError(`The workspace couldn't be made: ${oErr?.message ?? "unknown"}. The payment went through; contact support with this page's address.`, 500);
  }
  const orgId = (org as { id: string }).id;

  const { error: mErr } = await supabaseAdmin.from("org_members").insert({
    org_id: orgId, uid, email: p.email, display_name: p.name, role: "Admin", roles: ["Admin"], status: "active", created_by: uid, created_at: new Date().toISOString(),
  });
  if (mErr && !/duplicate|unique/i.test(mErr.message)) throw new SignupError(`The first admin couldn't be added: ${mErr.message}`, 500);

  const { data: prof } = await supabaseAdmin.from("users").select("id").eq("id", uid).maybeSingle();
  if (prof) await supabaseAdmin.from("users").update({ email: p.email, display_name: p.name, default_org_id: orgId, updated_at: new Date().toISOString() }).eq("id", uid);
  else await supabaseAdmin.from("users").insert({ id: uid, email: p.email, display_name: p.name, default_org_id: orgId, updated_at: new Date().toISOString() });

  await supabaseAdmin.from("audit_logs").insert({
    action: "WORKSPACE_STARTED", resource_type: "org", resource_id: orgId, org_id: orgId, user_id: uid, user_email: p.email,
    details: { plan: p.plan, checkout_session: session.id, status },
  }).then(() => undefined, () => undefined);
  return { orgId, uid, email: p.email, company: p.company };
}

export async function retrieveSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  if (!isStripeConfigured()) throw new SignupError("Payment isn't set up on this site.", 503);
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sessionId)) throw new SignupError("That link isn't right.", 400);
  try { return await getStripe().checkout.sessions.retrieve(sessionId); }
  catch { throw new SignupError("That payment wasn't found.", 404); }
}

/** The finish page: make sure the workspace exists, and say whether its
 *  first admin still has to set a password. */
export async function finishState(sessionId: string): Promise<{ email: string; company: string; needsPassword: boolean }> {
  const session = await retrieveSession(sessionId);
  const made = await provisionWorkspace(session);
  const { data } = await supabaseAdmin.auth.admin.getUserById(made.uid);
  const owned = !!(data.user?.app_metadata as { password_owned?: boolean } | undefined)?.password_owned;
  return { email: made.email, company: made.company, needsPassword: !owned };
}

/** The payer sets their first password, once, within a week of paying. */
export async function setFirstPassword(sessionId: string, password: string): Promise<{ email: string }> {
  const session = await retrieveSession(sessionId);
  const made = await provisionWorkspace(session);
  if (Date.now() - session.created * 1000 > FINISH_WINDOW_MS) throw new SignupError("This page has expired. Sign in, or ask for a password reset.", 410);
  const { data } = await supabaseAdmin.auth.admin.getUserById(made.uid);
  const meta = (data.user?.app_metadata ?? {}) as { password_owned?: boolean; workspace_payment?: string };
  if (meta.password_owned) throw new SignupError("Your password is already set. Sign in.", 409);
  const problem = passwordProblem(password, made.email);
  if (problem) throw new SignupError(problem, 400);
  const { error } = await supabaseAdmin.auth.admin.updateUserById(made.uid, { password, app_metadata: { ...meta, password_owned: true } });
  if (error) throw new SignupError(error.message, 500);
  return { email: made.email };
}
