import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// POST /api/tickets/watch  { ticketId, watching: boolean }
//
// WF-9: following / unfollowing a ticket used to be a client-side
// read-modify-write of the whole `tickets.watchers` array with no
// compare-and-set, so it could silently clobber (or be clobbered by) a
// concurrent workflow transition, which rewrites the same column. It now
// rides a server route that:
//   1. authenticates the caller and requires active membership of the
//      ticket's org (RLS let any member write any ticket — WF-2);
//   2. only ever adds or removes the CALLER — nobody edits another person's
//      follow;
//   3. applies the write compare-and-set on `last_modified`, exactly as the
//      workflow route and the comment route do, and retries the read once on
//      a conflict before reporting 409. The write bumps `last_modified` so a
//      transition racing it fails its own CAS instead of overwriting the
//      follow change.

interface Body {
  ticketId: string;
  watching: boolean;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.ticketId || typeof body.watching !== "boolean") {
    return NextResponse.json({ error: "ticketId and watching are required" }, { status: 400 });
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: row, error: loadErr } = await supabaseAdmin
      .from("tickets")
      .select("id, org_id, watchers, last_modified, archived_at")
      .eq("id", body.ticketId)
      .maybeSingle();
    if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    const t = row as { org_id: string; watchers: string[] | null; last_modified: string | null; archived_at: string | null };
    if (t.archived_at) {
      return NextResponse.json({ error: "This ticket is archived; restore it from its archive before following it." }, { status: 409 });
    }

    if (attempt === 0) {
      const { data: member } = await supabaseAdmin
        .from("org_members")
        .select("uid")
        .eq("org_id", t.org_id)
        .eq("uid", caller.id)
        .eq("status", "active")
        .maybeSingle();
      if (!member) {
        return NextResponse.json({ error: "Forbidden: not an active member of this workspace" }, { status: 403 });
      }
    }

    const current = Array.isArray(t.watchers) ? t.watchers : [];
    const already = current.includes(caller.id);
    if (already === body.watching) {
      return NextResponse.json({ ok: true, watching: body.watching, watchers: current });
    }
    const next = body.watching ? [...current, caller.id] : current.filter((w) => w !== caller.id);

    let casQuery = supabaseAdmin
      .from("tickets")
      .update({ watchers: next, last_modified: new Date().toISOString() })
      .eq("id", body.ticketId);
    casQuery = t.last_modified ? casQuery.eq("last_modified", t.last_modified) : casQuery.is("last_modified", null);
    const { data: casRows, error: updErr } = await casQuery.select("id");
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    if (((casRows as unknown[]) ?? []).length > 0) {
      return NextResponse.json({ ok: true, watching: body.watching, watchers: next });
    }
    // Somebody moved the ticket between our read and our write — re-read once.
  }
  return NextResponse.json(
    { error: "The ticket changed while you were acting — refresh and try again", conflict: true },
    { status: 409 },
  );
}
