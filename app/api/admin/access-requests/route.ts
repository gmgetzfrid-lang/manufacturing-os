import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { queueAccessRequestOutcome } from "@/lib/accessRequestOutcome";

// Decline a pending access request (EGRESS-5 follow-through). The public
// request door (/api/auth/request-access) refuses a second request while one
// is pending, so without a decline path a request the admin does not want to
// grant blocks that address from ever re-requesting — and sits on the
// /admin/users card forever. Approval is not handled here: it happens as a
// side effect of granting the membership (/api/admin/create-user).
//
// Service-role route, so authority is checked explicitly: the caller must be
// an active Admin/DocCtrl of the org THE REQUEST names — resolved from the
// stored row, never from the request body, so a caller cannot decline
// another org's requests by lying about the org.

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, action } = (await req.json().catch(() => ({}))) as { id?: string; action?: string };
  if (!id || action !== "decline") {
    return NextResponse.json({ error: "Expected { id, action: 'decline' }" }, { status: 400 });
  }

  const { data: request, error: lookupError } = await supabaseAdmin
    .from("access_requests")
    .select("id, org_id, status, email, org_name")
    .eq("id", id)
    .maybeSingle();
  if (lookupError) {
    return NextResponse.json({ error: "Couldn't load the request — try again." }, { status: 500 });
  }
  if (!request || !request.org_id) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, roles")
    .eq("org_id", request.org_id as string)
    .eq("uid", caller.id)
    .eq("status", "active")
    .maybeSingle();
  const held = new Set<string>([
    String(member?.role ?? ""),
    ...(((member?.roles as string[] | null) ?? [])),
  ]);
  if (!member || !(held.has("Admin") || held.has("DocCtrl"))) {
    return NextResponse.json({ error: "Forbidden: insufficient permissions" }, { status: 403 });
  }

  // Only a pending row can be declined — approving happened elsewhere and a
  // decided row stays decided.
  const { data: declined, error: updateError } = await supabaseAdmin
    .from("access_requests")
    .update({ status: "declined" })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // PROD-2 dw2: the person who asked hears the answer, at the address they
  // gave — only when THIS call declined the row (a row already decided is
  // not re-announced). Queued here, server-side, from the stored row; best-
  // effort, never failing the decline.
  if (Array.isArray(declined) && declined.length > 0) {
    await queueAccessRequestOutcome(supabaseAdmin, {
      outcome: "declined",
      orgId: request.org_id as string,
      orgName: (request.org_name as string | null) ?? null,
      requestIds: [String(request.id ?? id)],
      toEmail: (request.email as string | null) ?? null,
      queuedBy: caller.id,
    });
  }

  return NextResponse.json({ ok: true });
}
