import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(req: NextRequest) {
  try {
    const { displayName, email, orgName } = await req.json();

    if (!displayName || !email || !orgName) {
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }

    // 1. Find the organization (case-insensitive)
    const { data: org } = await supabaseAdmin
      .from("orgs")
      .select("id, name")
      .ilike("name", orgName.trim())
      .maybeSingle();

    if (!org) {
      return NextResponse.json(
        { error: `No organization named "${orgName}" was found. Check spelling, or create a new organization if you're the first admin.` },
        { status: 404 }
      );
    }

    const orgId = (org as { id: string; name: string }).id;
    const orgRealName = (org as { id: string; name: string }).name;

    // 2. Check for duplicate pending request
    const { data: existingReq } = await supabaseAdmin
      .from("access_requests")
      .select("id, status")
      .eq("email", email)
      .eq("org_id", orgId)
      .eq("status", "pending")
      .maybeSingle();

    if (existingReq) {
      return NextResponse.json(
        { error: `You already have a pending request to join "${orgRealName}". Please wait for an admin to respond.` },
        { status: 409 }
      );
    }

    // 3. Insert request linked to the org
    const { error: insertError } = await supabaseAdmin.from("access_requests").insert({
      org_id: orgId,
      org_name: orgRealName,
      display_name: displayName,
      email,
      status: "pending",
      created_at: new Date().toISOString(),
    });

    if (insertError) {
      return NextResponse.json({ error: `Failed to submit request: ${insertError.message}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true, orgName: orgRealName });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unexpected server error.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
