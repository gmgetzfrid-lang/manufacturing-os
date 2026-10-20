import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeEmail, applyEmailLookup, findOrgByTypedName } from "@/lib/identity";
import { publicDoorClientIp, publicDoorVerdict, recordPublicDoorAttempt } from "@/lib/publicDoorLimiter";

const TRIAL_DAYS = 60;

// Public, unauthenticated endpoint — attempts are capped per source IP per
// hour so nobody can loop it to enumerate accounts or burn trial orgs. The
// window is the one /api/auth/request-access draws on too, and what it does
// when it cannot count (no client address, no table, a failed read) is
// decided in lib/publicDoorLimiter.ts (ORG-8 / BILL-14, admin-and-org Round G
// P5): a header-less caller shares one budget, a missing table leaves the door
// open as before (logged), and any other failed read refuses with a 503.

export async function POST(req: NextRequest) {
  const ip = publicDoorClientIp(req);
  try {
    const door = await publicDoorVerdict(supabaseAdmin, ip, "signup attempts");
    if (!door.allowed) {
      return NextResponse.json({ error: door.error }, { status: door.status });
    }

    const { email: rawEmail, password, displayName, companyName } = await req.json();

    if (!rawEmail || !password || !displayName || !companyName) {
      await recordPublicDoorAttempt(supabaseAdmin, ip, null, "error");
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }
    // One canonical casing for identity (IDENT-3) — otherwise an Azure-cased
    // UPN and a typed signup of the same address read as two different people.
    const email = normalizeEmail(String(rawEmail));

    const trimmedOrgName = companyName.trim();
    if (trimmedOrgName.length < 2) {
      // ORG-8: a short name is an attempt too — recorded BEFORE the answer,
      // so short-name probes spend the per-IP window like every other one.
      await recordPublicDoorAttempt(supabaseAdmin, ip, String(email), "rejected");
      return NextResponse.json({ error: "Organization name is too short." }, { status: 400 });
    }

    // Log every well-formed attempt so probing (repeated 409s) counts toward
    // the per-IP window, not just successful signups.
    await recordPublicDoorAttempt(supabaseAdmin, ip, String(email), "attempt");

    // 1. Check if org name already exists (case-insensitive). The typed name
    // is matched literally, never as a pattern (the integrator's ruling 1 at
    // the AO-P5 merge, DEC-90): "Acm%" is not "Acme". lib/identity.ts
    // findOrgByTypedName.
    const existingOrg = await findOrgByTypedName(supabaseAdmin, trimmedOrgName);

    if (existingOrg) {
      // ORG-8: the name is taken — a real need to say so (the person must
      // pick another, or ask to join), but the answer repeats the name as
      // TYPED, never the workspace's stored casing, so a fuzzy guess is not
      // turned into the exact registered name.
      return NextResponse.json(
        { error: `An organization named "${trimmedOrgName}" already exists. If you belong to this organization, use "Request Access" instead.` },
        { status: 409 }
      );
    }

    // 2. Check if email already exists — case-insensitively, so a re-cased
    // address finds its account (IDENT-3). limit(2) instead of maybeSingle:
    // pre-index data may hold two profiles on one address, and maybeSingle
    // errors (previously swallowed) on two rows — any row at all means
    // "taken". This pre-check is a courtesy; auth.createUser below is the
    // real enforcement and rejects an already-registered address either way.
    const { data: existingUsers } = await applyEmailLookup(
      supabaseAdmin.from("users").select("id"),
      "email",
      email
    ).limit(2);

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
      // Seed the additive roles array too (DB-3 / DEC-1 step 1). `roles` is
      // NOT NULL DEFAULT '{}', so leaving it unset makes every additive check
      // (org_capability_allows, acl_index_denies) evaluate the founding Admin
      // against an EMPTY array and deny them. It must contain at least the
      // headline role.
      roles: ["Admin"],
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
