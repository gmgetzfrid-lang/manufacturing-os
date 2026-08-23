import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeEmail, emailLikePattern } from "@/lib/identity";

const TRIAL_DAYS = 60;

// Public, unauthenticated endpoint — cap attempts per source IP per hour so
// nobody can loop it to enumerate accounts or burn trial orgs. Best-effort:
// if the attempt table isn't present yet (pre-migration) the check no-ops
// rather than blocking real signups.
const SIGNUP_MAX_PER_HOUR = 8;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Returns true when the caller is over the limit and should be turned away. */
async function signupRateLimited(ip: string): Promise<boolean> {
  if (ip === "unknown") return false; // don't punish everyone if IP is missing
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error } = await supabaseAdmin
    .from("signup_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("created_at", since);
  if (error) return false; // table absent / transient — fail open
  return (count ?? 0) >= SIGNUP_MAX_PER_HOUR;
}

async function recordSignupAttempt(ip: string, email: string | null, outcome: string): Promise<void> {
  await supabaseAdmin.from("signup_attempts").insert({ ip, email, outcome })
    .then(() => undefined, () => undefined);
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  try {
    if (await signupRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many signup attempts from this network. Please wait a while and try again." },
        { status: 429 },
      );
    }

    const { email: rawEmail, password, displayName, companyName } = await req.json();

    if (!rawEmail || !password || !displayName || !companyName) {
      await recordSignupAttempt(ip, null, "error");
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }
    // One canonical casing for identity (IDENT-3) — otherwise an Azure-cased
    // UPN and a typed signup of the same address read as two different people.
    const email = normalizeEmail(String(rawEmail));

    const trimmedOrgName = companyName.trim();
    if (trimmedOrgName.length < 2) {
      return NextResponse.json({ error: "Organization name is too short." }, { status: 400 });
    }

    // Log every well-formed attempt so probing (repeated 409s) counts toward
    // the per-IP window, not just successful signups.
    await recordSignupAttempt(ip, String(email), "attempt");

    // 1. Check if org name already exists (case-insensitive)
    const { data: existingOrg } = await supabaseAdmin
      .from("orgs")
      .select("id, name")
      .ilike("name", trimmedOrgName)
      .maybeSingle();

    if (existingOrg) {
      return NextResponse.json(
        { error: `An organization named "${(existingOrg as { name: string }).name}" already exists. If you belong to this organization, use "Request Access" instead.` },
        { status: 409 }
      );
    }

    // 2. Check if email already exists — case-insensitively, so a re-cased
    // address finds its account (IDENT-3). limit(2) instead of maybeSingle:
    // pre-index data may hold two profiles on one address, and maybeSingle
    // errors (previously swallowed) on two rows — any row at all means
    // "taken". This pre-check is a courtesy; auth.createUser below is the
    // real enforcement and rejects an already-registered address either way.
    const { data: existingUsers } = await supabaseAdmin
      .from("users")
      .select("id")
      .ilike("email", emailLikePattern(email))
      .limit(2);

    if (existingUsers && existingUsers.length > 0) {
      return NextResponse.json(
        { error: "An account with this email already exists. Please sign in instead." },
        { status: 409 }
      );
    }

    // 3. Create auth user (email pre-confirmed so they can sign in immediately)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      user_metadata: { display_name: displayName },
      email_confirm: true,
    });

    if (authError || !authData.user) {
      // The duplicate-email refusal from auth lands here whenever the
      // pre-check missed (it reads the profile mirror, which can lag).
      // Say what happened instead of relaying the raw auth error.
      const authMsg = authError?.message ?? "";
      const authCode = (authError as { code?: string } | null)?.code;
      if (authCode === "email_exists" || /already (been )?registered/i.test(authMsg)) {
        return NextResponse.json(
          { error: "An account with this email already exists. Please sign in instead." },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: authMsg || "Failed to create account." }, { status: 400 });
    }
    const userId = authData.user.id;

    // 4. Create organization, starting a 60-day trial.
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: orgData, error: orgError } = await supabaseAdmin
      .from("orgs")
      .insert({
        name: trimmedOrgName,
        type: "business",
        created_by: userId,
        billing: { status: "trialing", plan: null },
        subscription_status: "trialing",
        trial_ends_at: trialEndsAt,
      })
      .select("id")
      .single();

    if (orgError || !orgData) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      // The DB-level unique index (orgs_name_unique_ci) is the real
      // enforcement — the ilike pre-check above can lose a race, this can't.
      if (orgError?.code === "23505" || /orgs_name_unique/i.test(orgError?.message ?? "")) {
        return NextResponse.json(
          { error: `An organization named "${trimmedOrgName}" already exists. If you belong to this organization, use "Request Access" instead.` },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: `Failed to create organization: ${orgError?.message ?? "unknown"}` }, { status: 500 });
    }
    const orgId = (orgData as { id: string }).id;

    // 5. Add user as Admin member
    const { error: memberError } = await supabaseAdmin.from("org_members").insert({
      org_id: orgId,
      uid: userId,
      email,
      display_name: displayName,
      role: "Admin",
      status: "active",
      created_by: userId,
      created_at: new Date().toISOString(),
    });

    if (memberError) {
      await supabaseAdmin.from("orgs").delete().eq("id", orgId);
      await supabaseAdmin.auth.admin.deleteUser(userId);
      return NextResponse.json({ error: `Failed to add admin: ${memberError.message}` }, { status: 500 });
    }

    // 6. Create user profile
    const { error: profileError } = await supabaseAdmin.from("users").upsert({
      id: userId,
      email,
      display_name: displayName,
      default_org_id: orgId,
      updated_at: new Date().toISOString(),
    });

    if (profileError) {
      console.error("User profile creation warning:", profileError);
    }

    return NextResponse.json({ orgId, userId, trialEndsAt });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unexpected server error.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
