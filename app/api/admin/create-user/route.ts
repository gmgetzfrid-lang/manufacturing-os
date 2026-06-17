import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Bounded lookup of an auth user by email. Only used in the rare path where the
// auth account already exists (e.g. they signed in with Microsoft first) but
// has no profile row to read the id from.
async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  const target = email.toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users?.length) return null;
    const match = data.users.find((u) => (u.email || "").toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < perPage) return null;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { email, password, orgId, role, displayName } = await req.json() as {
    email: string;
    password: string;
    orgId: string;
    role: string;
    displayName?: string;
  };

  if (!email?.trim()) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  // Verify caller is Admin or DocCtrl in the target org
  const { data: callerMember } = await supabaseAdmin
    .from("org_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("uid", caller.id)
    .eq("status", "active")
    .single();

  if (!callerMember || !["Admin", "DocCtrl"].includes(callerMember.role as string)) {
    return NextResponse.json({ error: "Forbidden: insufficient permissions" }, { status: 403 });
  }

  // Resolve the target auth user. Reuse an existing account when the email is
  // already registered — e.g. the person already signed in with Microsoft, or
  // they belong to another workspace — rather than failing on a duplicate email.
  let userId: string | null = null;
  let createdNewUser = false;

  const { data: existingProfile } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (existingProfile?.id) {
    userId = existingProfile.id as string;
  }

  if (!userId) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (data?.user) {
      userId = data.user.id;
      createdNewUser = true;
    } else {
      // Email may already exist in auth without a readable profile row.
      const recovered = await findAuthUserIdByEmail(email);
      if (recovered) {
        userId = recovered;
      } else {
        return NextResponse.json({ error: error?.message ?? "Failed to create user" }, { status: 400 });
      }
    }
  }

  // Create or refresh the org membership. Idempotent: re-adding an existing
  // member just (re)activates them with the chosen role instead of erroring.
  const { data: existingMember } = await supabaseAdmin
    .from("org_members")
    .select("uid")
    .eq("org_id", orgId)
    .eq("uid", userId)
    .maybeSingle();

  if (existingMember) {
    const { error: updateError } = await supabaseAdmin
      .from("org_members")
      .update({ role, roles: [role], status: "active", display_name: displayName ?? null })
      .eq("org_id", orgId)
      .eq("uid", userId);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
  } else {
    const { error: memberError } = await supabaseAdmin
      .from("org_members")
      .insert({
        org_id: orgId,
        uid: userId,
        email,
        role,
        display_name: displayName ?? null,
        status: "active",
        created_by: caller.id,
        created_at: new Date().toISOString(),
      });

    if (memberError) {
      // Only roll back the auth user if THIS request created it.
      if (createdNewUser && userId) {
        await supabaseAdmin.auth.admin.deleteUser(userId);
      }
      return NextResponse.json({ error: memberError.message }, { status: 500 });
    }

    // Seed the additive role collection to match the headline role. Best-effort:
    // if the `roles` column isn't present yet (pre-migration), this no-ops and
    // the app falls back to [role]. Never blocks user creation.
    await supabaseAdmin.from("org_members").update({ roles: [role] }).eq("org_id", orgId).eq("uid", userId);
  }

  // Create / update the user profile.
  await supabaseAdmin.from("users").upsert({
    id: userId,
    email,
    display_name: displayName ?? null,
    updated_at: new Date().toISOString(),
  });

  return NextResponse.json({ uid: userId });
}
