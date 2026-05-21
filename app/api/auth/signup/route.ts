import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(req: NextRequest) {
  try {
    const { email, password, displayName, companyName } = await req.json();

    if (!email || !password || !displayName || !companyName) {
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }

    // 1. Create auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      user_metadata: { display_name: displayName },
      email_confirm: true,
    });

    if (authError) return NextResponse.json({ error: authError.message }, { status: 400 });
    const userId = authData.user.id;

    // 2. Create organization
    const { data: orgData, error: orgError } = await supabaseAdmin
      .from("orgs")
      .insert({
        name: companyName,
        type: "business",
        created_by: userId,
        billing: { status: "active", plan: "starter" },
      })
      .select("id")
      .single();

    if (orgError || !orgData) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      return NextResponse.json({ error: "Failed to create organization." }, { status: 500 });
    }

    const orgId = (orgData as { id: string }).id;

    // 3. Add user as Admin member
    await supabaseAdmin.from("org_members").insert({
      org_id: orgId,
      uid: userId,
      email,
      display_name: displayName,
      role: "Admin",
      status: "active",
      created_by: userId,
      created_at: new Date().toISOString(),
    });

    // 4. Create user profile
    await supabaseAdmin.from("users").upsert({
      id: userId,
      email,
      display_name: displayName,
      default_org_id: orgId,
      updated_at: new Date().toISOString(),
    });

    return NextResponse.json({ orgId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
