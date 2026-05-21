import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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

  // Create the auth user
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    return NextResponse.json({ error: error?.message ?? "Failed to create user" }, { status: 400 });
  }

  // Create org membership
  const { error: memberError } = await supabaseAdmin
    .from("org_members")
    .insert({
      org_id: orgId,
      uid: data.user.id,
      email,
      role,
      display_name: displayName ?? null,
      status: "active",
      created_by: caller.id,
      created_at: new Date().toISOString(),
    });

  if (memberError) {
    // Clean up the auth user if membership fails
    await supabaseAdmin.auth.admin.deleteUser(data.user.id);
    return NextResponse.json({ error: memberError.message }, { status: 500 });
  }

  // Create user profile
  await supabaseAdmin.from("users").upsert({
    id: data.user.id,
    email,
    display_name: displayName ?? null,
    updated_at: new Date().toISOString(),
  });

  return NextResponse.json({ uid: data.user.id });
}
