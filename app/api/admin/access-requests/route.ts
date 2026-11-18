import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { clearAccessRequestNotices, queueAccessRequestOutcome } from "@/lib/accessRequestOutcome";
import { checkedWrite } from "@/lib/checkedWrite";
import { answered, keptAnswer } from "@/lib/checkedWriteAnswer";

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
  // projects-tab SAF-22 (J15e): class (a) — the decline is the person's
  // decision. A match of no row means the request is no longer pending: if
  // it is declined already (a second click) the decline holds and nothing is
  // re-announced, as before; if it was answered otherwise meanwhile (granted
  // through Add member), the decline is refused, never answered ok.
  const kept = keptAnswer();
  const w = await checkedWrite(answered(supabaseAdmin
    .from("access_requests")
    .update({ status: "declined" })
    .eq("id", id)
    .eq("status", "pending")
    .select("id"), kept));
  if (kept.error) {
    return NextResponse.json({ error: kept.error.message }, { status: 500 });
  }
  const declined = kept.data;
  if (!w.ok) {
    const { data: now } = await supabaseAdmin.from("access_requests").select("status").eq("id", id).maybeSingle();
    if ((now as { status?: string } | null)?.status !== "declined") {
      return NextResponse.json({ error: "This request was already answered (it is no longer pending), so it was not declined. Reload to see where it stands." }, { status: 409 });
    }
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
    // The request is closed: the pool's notices about it stop waiting on
    // anyone (N8's review fix — the PROD-3 rule). Best-effort.
    await clearAccessRequestNotices(supabaseAdmin, request.org_id as string, [String(request.id ?? id)]);
  }

  return NextResponse.json({ ok: true });
}
