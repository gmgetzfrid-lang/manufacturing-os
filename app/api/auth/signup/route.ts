import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(req: NextRequest) {
  try {
    const { email, password, displayName, companyName } = await req.json();

    if (!email || !password || !displayName || !companyName) {
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }

    const trimmedOrgName = companyName.trim();
    if (trimmedOrgName.length < 2) {
      return NextResponse.json({ error: "Organization name is too short." }, { status: 400 });
    }

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

    // 2. Check if email already exists
    const { data: existingUser } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingUser) {
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
      return NextResponse.json({ error: authError?.message || "Failed to create account." }, { status: 400 });
    }
    const userId = authData.user.id;

    // 4. Create organization
    const { data: orgData, error: orgError } = await supabaseAdmin
      .from("orgs")
      .insert({
        name: trimmedOrgName,
        type: "business",
        created_by: userId,
        billing: { status: "active", plan: "starter" },
      })
      .select("id")
      .single();

    if (orgError || !orgData) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
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

    return NextResponse.json({ orgId, userId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unexpected server error.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
