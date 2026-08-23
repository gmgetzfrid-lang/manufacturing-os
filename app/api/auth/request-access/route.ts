import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeEmail, emailLikePattern } from "@/lib/identity";

export async function POST(req: NextRequest) {
  try {
    const { displayName, email: rawEmail, orgName } = await req.json();

    if (!displayName || !rawEmail || !orgName) {
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }
    // One canonical casing for identity (IDENT-3).
    const email = normalizeEmail(String(rawEmail));

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

    // 2. Check for duplicate pending request — case-insensitively (IDENT-3),
    // and refuse on a failed lookup rather than reading it as "no pending
    // request" and stacking a duplicate row.
    const { data: existingReqs, error: dupCheckError } = await supabaseAdmin
      .from("access_requests")
      .select("id, status")
      .ilike("email", emailLikePattern(email))
      .eq("org_id", orgId)
      .eq("status", "pending")
      .limit(1);
    if (dupCheckError) {
      return NextResponse.json(
        { error: "Couldn't check for an existing request — please try again." },
        { status: 500 }
      );
    }
    const existingReq = existingReqs?.[0] ?? null;

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
