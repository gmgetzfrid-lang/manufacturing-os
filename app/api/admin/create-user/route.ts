import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ALL_ROLES } from "@/types/schema";
import { mustUseMicrosoft, domainOf } from "@/lib/signinPolicy";
import { generateTempPassword, getSigninPolicy, sanitizeExpiry, tempMeta } from "@/lib/signinPolicyServer";
import { accountByEmail, looksLikeEmail, normEmail } from "@/lib/accountsServer";

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

  // No password comes from the admin: company emails sign in with
  // Microsoft, and everyone else gets a one-time password issued here that
  // they must replace the same day (see lib/signinPolicy).
  const { email: rawEmail, orgId, role, displayName, expiresAt } = await req.json() as {
    email: string;
    orgId: string;
    role: string;
    displayName?: string;
    /** The end of the admin's day, from their browser. */
    expiresAt?: string;
  };

  // One email is one person: kept trimmed and lower case everywhere.
  const email = normEmail(rawEmail);
  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  if (!looksLikeEmail(email)) {
    return NextResponse.json({ error: "That doesn't look like an email address." }, { status: 400 });
  }

  // Only real roles may be granted. Without this, `role` is a free string
  // written straight to org_members.role/roles — a typo silently strands a
  // member with rights nothing recognizes, and it's an unvalidated write on
  // a service-role (RLS-bypassing) path.
  if (!(ALL_ROLES as string[]).includes(String(role))) {
    return NextResponse.json({ error: `Invalid role: ${String(role)}` }, { status: 400 });
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

  // Only an Admin may grant the Admin role. Without this a DocCtrl (who can
  // otherwise manage members) could mint an Admin and escalate — the RLS
  // guard on org_members doesn't apply here because this route uses the
  // service-role key, which bypasses RLS.
  if (String(role) === "Admin" && (callerMember.role as string) !== "Admin") {
    return NextResponse.json({ error: "Only an Admin can grant the Admin role" }, { status: 403 });
  }

  const policy = await getSigninPolicy(orgId);
  const viaMicrosoft = mustUseMicrosoft(email, policy);
  if (!viaMicrosoft && !policy.allowPasswords) {
    return NextResponse.json({ error: `This workspace only lets people in with Microsoft. ${domainOf(email) || "That email"} isn't one of its Microsoft domains.` }, { status: 400 });
  }
  let tempPassword: string | null = null;
  let tempExpires: string | null = null;

  // Resolve the target auth user. Reuse an existing account when the email is
  // already registered — e.g. the person already signed in with Microsoft, or
  // they belong to another workspace — rather than failing on a duplicate email.
  let userId: string | null = null;
  let createdNewUser = false;

  // Found by their SIGN-IN email (only they and the server can change it),
  // never by the profile's email field.
  try {
    userId = (await accountByEmail(email))?.id ?? null;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }

  // Nobody else in this workspace may already have this email.
  const { data: sameEmail, error: sameErr } = await supabaseAdmin
    .from("org_members").select("uid").eq("org_id", orgId).ilike("email", email).limit(5);
  if (sameErr) return NextResponse.json({ error: sameErr.message }, { status: 503 });
  if (((sameEmail ?? []) as Array<{ uid: string }>).some((m) => m.uid !== userId)) {
    return NextResponse.json({ error: `${email} is already in this workspace under another account. Remove that one first.` }, { status: 409 });
  }

  if (!userId) {
    if (!viaMicrosoft) { tempPassword = generateTempPassword(); tempExpires = sanitizeExpiry(expiresAt); }
    const { data, error } = await supabaseAdmin.auth.admin.createUser(viaMicrosoft
      // Signs in with Microsoft: no password at all on the account.
      ? { email, email_confirm: true }
      : { email, password: tempPassword!, email_confirm: true, app_metadata: tempMeta(caller.id, tempExpires!) });
    if (data?.user) {
      userId = data.user.id;
      createdNewUser = true;
    } else {
      // Made a moment ago by someone else: it's the same person.
      const recovered = await accountByEmail(email).catch(() => null);
      if (recovered) {
        userId = recovered.id;
      } else {
        return NextResponse.json({ error: error?.message ?? "Failed to create user" }, { status: 400 });
      }
    }
  }

  // Create or refresh the org membership. Idempotent: re-adding an existing
  // member just (re)activates them with the chosen role instead of erroring.
  const { data: existingMember } = await supabaseAdmin
    .from("org_members")
    .select("uid, role")
    .eq("org_id", orgId)
    .eq("uid", userId)
    .maybeSingle();

  // "Add member" doubles as a role-change on the re-add path (it upserts the
  // role). That means a DocCtrl could re-add an existing Admin at a lower
  // role and silently demote them — an unintended privilege change that the
  // Admin-only guard above doesn't catch because the NEW role isn't Admin.
  // Only an Admin may alter an existing Admin's membership.
  if (existingMember && String(existingMember.role) === "Admin" && (callerMember.role as string) !== "Admin") {
    return NextResponse.json({ error: "Only an Admin can change an existing Admin's role" }, { status: 403 });
  }

  if (existingMember) {
    const { error: updateError } = await supabaseAdmin
      .from("org_members")
      .update({ role, roles: [role], status: "active", email, display_name: displayName ?? null })
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

  return NextResponse.json({
    uid: userId,
    signIn: viaMicrosoft ? "microsoft" : createdNewUser ? "password" : "existing",
    // Shown once to the admin to pass on; never stored or logged.
    tempPassword: createdNewUser ? tempPassword : null,
    expiresAt: createdNewUser ? tempExpires : null,
  });
}
