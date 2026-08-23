import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ALL_ROLES, type Role } from "@/types/schema";
import { normalizeEmail, emailLikePattern } from "@/lib/identity";
import { normalizeRoles, primaryRole } from "@/lib/roleCapabilities";

// Bounded lookup of auth users by email. Only used in the rare path where the
// auth account already exists (e.g. they signed in with Microsoft first) but
// has no profile row to read the id from. Collects EVERY match rather than
// returning the first: with two auth identities on one address, "first in
// listUsers page order" is not a property anyone controls, and attaching a
// role to an arbitrary identity is exactly the defect this route had (IDENT-2).
async function findAuthUsersByEmail(email: string): Promise<string[] | null> {
  const target = normalizeEmail(email);
  const matches: string[] = [];
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) return null; // lookup failed — caller must refuse, not guess
    if (!data?.users?.length) break;
    for (const u of data.users) {
      if ((u.email || "").toLowerCase() === target) matches.push(u.id);
    }
    if (data.users.length < perPage) break;
  }
  return matches;
}

/** The refusal every ambiguous-identity path lands on. Copies the pattern the
 *  projects member-picker already uses — select two, refuse on two — which was
 *  the only call site in the codebase defending against email collisions. */
function identityCollisionResponse(email: string, ids: string[]) {
  return NextResponse.json(
    {
      error: `Multiple accounts share the email ${email} — contact your admin. No role was granted.`,
      collidingUids: ids,
    },
    { status: 409 }
  );
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

  const { email: rawEmail, password, orgId, role, displayName } = await req.json() as {
    email: string;
    password: string;
    orgId: string;
    role: string;
    displayName?: string;
  };

  if (!rawEmail?.trim()) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  // Identity is matched and stored in one canonical form (IDENT-3) — the
  // lower(email) unique indexes are the database backstop.
  const email = normalizeEmail(rawEmail);

  // Only real roles may be granted. Without this, `role` is a free string
  // written straight to org_members.role/roles — a typo silently strands a
  // member with rights nothing recognizes, and it's an unvalidated write on
  // a service-role (RLS-bypassing) path.
  if (!(ALL_ROLES as string[]).includes(String(role))) {
    return NextResponse.json({ error: `Invalid role: ${String(role)}` }, { status: 400 });
  }
  const grantedRole = role as Role;

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

  // Resolve the target auth user. Reuse an existing account when the email is
  // already registered — e.g. the person already signed in with Microsoft, or
  // they belong to another workspace — rather than failing on a duplicate email.
  //
  // This lookup decides WHICH HUMAN gets the role, so it fails loudly in both
  // directions (IDENT-2): a lookup error refuses rather than falling through
  // to account creation, and two profiles on one address refuse rather than
  // guessing. The case-insensitive match also finds rows stored before
  // normalization (IDENT-3).
  let userId: string | null = null;
  let createdNewUser = false;

  const { data: profileRows, error: profileLookupError } = await supabaseAdmin
    .from("users")
    .select("id, email")
    .ilike("email", emailLikePattern(email))
    .limit(2);
  if (profileLookupError) {
    return NextResponse.json(
      { error: `Couldn't verify whether ${email} already has an account — try again. No role was granted.` },
      { status: 500 }
    );
  }
  const profiles = (profileRows ?? []) as Array<{ id: string; email: string | null }>;
  if (profiles.length > 1) {
    return identityCollisionResponse(email, profiles.map((p) => p.id));
  }
  if (profiles[0]?.id) {
    userId = profiles[0].id;
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
      const recovered = await findAuthUsersByEmail(email);
      if (recovered === null) {
        return NextResponse.json(
          { error: `Couldn't resolve the account for ${email} — try again. No role was granted.` },
          { status: 500 }
        );
      }
      if (recovered.length > 1) {
        return identityCollisionResponse(email, recovered);
      }
      if (recovered.length === 1) {
        userId = recovered[0];
      } else {
        return NextResponse.json({ error: error?.message ?? "Failed to create user" }, { status: 400 });
      }
    }
  }

  // Create or refresh the org membership. Idempotent: re-adding an existing
  // member (re)activates them and ADDS the chosen role to their collection.
  // A transient lookup error must refuse here — misreading "member exists"
  // as "new member" would send an existing member down the insert path.
  const { data: existingMember, error: memberLookupError } = await supabaseAdmin
    .from("org_members")
    .select("uid, role, roles, display_name")
    .eq("org_id", orgId)
    .eq("uid", userId)
    .maybeSingle();
  if (memberLookupError) {
    return NextResponse.json(
      { error: `Couldn't check existing membership — try again. No role was granted.` },
      { status: 500 }
    );
  }

  // "Add member" doubles as a role grant on the re-add path. That means a
  // DocCtrl could re-add an existing Admin and alter their membership — an
  // unintended privilege change that the Admin-only guard above doesn't
  // catch because the NEW role isn't Admin. Only an Admin may alter an
  // existing Admin's membership.
  if (existingMember && String(existingMember.role) === "Admin" && (callerMember.role as string) !== "Admin") {
    return NextResponse.json({ error: "Only an Admin can change an existing Admin's role" }, { status: 403 });
  }

  if (existingMember) {
    // MERGE into the additive collection — never assign over it (ORGSEL-3).
    // The old `roles: [role]` write silently deleted every other hat the
    // member held: a DraftingSupervisor + DocCtrl re-added as DocCtrl came
    // out holding only DocCtrl, and the loss reached RLS via the mirrored
    // headline. Removing a role is the role editor's job, where it is
    // explicit. The headline is recomputed from the merged collection so
    // `role` can never rank below a role the member still holds.
    const merged = normalizeRoles(existingMember.roles, existingMember.role as Role | undefined);
    if (!merged.includes(grantedRole)) merged.push(grantedRole);
    const headline = primaryRole(merged);
    const { error: updateError } = await supabaseAdmin
      .from("org_members")
      .update({
        role: headline,
        roles: merged,
        status: "active",
        // Keep the existing display name unless the caller provided one —
        // the old write nulled it on every re-add (ORGSEL-5).
        display_name: displayName?.trim() ? displayName : (existingMember.display_name as string | null),
      })
      .eq("org_id", orgId)
      .eq("uid", userId);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // Refresh the profile email/display name; the membership row above is
    // the authority on roles.
    await supabaseAdmin.from("users").upsert({
      id: userId,
      email,
      ...(displayName?.trim() ? { display_name: displayName } : {}),
      updated_at: new Date().toISOString(),
    });

    return NextResponse.json({ uid: userId, roles: merged, merged: true });
  }

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
  // the app falls back to [role]. Never blocks user creation. Keyed on
  // (org_id, uid) it can only reach the row inserted above, never an
  // existing member's collection.
  await supabaseAdmin.from("org_members").update({ roles: [role] }).eq("org_id", orgId).eq("uid", userId);

  // Create / update the user profile.
  await supabaseAdmin.from("users").upsert({
    id: userId,
    email,
    display_name: displayName ?? null,
    updated_at: new Date().toISOString(),
  });

  return NextResponse.json({ uid: userId });
}
