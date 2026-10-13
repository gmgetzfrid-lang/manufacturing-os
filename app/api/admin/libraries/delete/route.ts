// POST /api/admin/libraries/delete
// Body: { orgId, libraryId, preview?: boolean, expected?: LibraryDeleteImpact }
//
// admin-and-org ALOG-3 (Round G, P8): deleting a library cascades away every
// folder, document record and revision in it. This route is the one door the
// library admin page uses, in one request:
//   1. the caller is held to the library-config surface (lib/adminGate.ts —
//      Admin or Document Control, by the full role collection);
//   2. it counts what the cascade removes (lib/libraryDeleteImpact.ts), as
//      the service client so nothing the caller's ACL hides is left out —
//      a count that cannot be read REFUSES the delete (503), never shows 0;
//      `preview: true` stops here and returns the counts for the dialog;
//   3. when the dialog's counts (`expected`) no longer match, it refuses
//      (409) and returns the new ones — the person confirms what is deleted;
//   4. it deletes AS THE CALLER (lib/serverAuth.ts callerScopedClient), so
//      RLS and every database guard (the legal-hold delete guard, 20261149's
//      evidence guard) judge it exactly as they judged the browser's delete:
//      a refusal comes back in the database's own words, and a delete that
//      matched no row is a refusal, never a success;
//   5. it records LIBRARY_DELETED with the counts and the actor. When
//      20261204's trigger has already written the row in the delete's own
//      statement, the route adds none; before that paste the route's row is
//      the record. A failed audit write is said in the response (the
//      library is already gone), never swallowed.

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { callerScopedClient } from "@/lib/serverAuth";
import { countLibraryDeleteImpact, impactChanged, type LibraryDeleteImpact } from "@/lib/libraryDeleteImpact";

export const runtime = "nodejs";

const bad = (error: string, status: number, extra?: Record<string, unknown>) => NextResponse.json({ error, ...(extra ?? {}) }, { status });

export async function POST(req: NextRequest) {
  let body: { orgId?: unknown; libraryId?: unknown; preview?: unknown; expected?: unknown };
  try { body = await req.json(); } catch { return bad("Invalid JSON body", 400); }
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  const libraryId = typeof body.libraryId === "string" ? body.libraryId.trim() : "";
  if (!orgId || !libraryId) return bad("orgId and libraryId are required", 400);

  const actor = await authorizeAdminSurface(req, orgId, "libraries", "write");
  if ("error" in actor) return bad(actor.error, actor.status);
  const admin = actor.admin;

  const { data: lib, error: libErr } = await admin.from("libraries").select("id, org_id, name").eq("id", libraryId).maybeSingle();
  if (libErr) return bad(`Couldn't load the library: ${libErr.message}`, 500);
  const row = lib as { id: string; org_id: string; name: string | null } | null;
  if (!row || row.org_id !== orgId) return bad("Library not found.", 404);

  const counted = await countLibraryDeleteImpact(admin, orgId, libraryId);
  if (!counted.ok) {
    return bad(`Couldn't count what deleting this library would remove (${counted.error}) — nothing was deleted. Try again.`, 503);
  }
  const impact = counted.impact;
  if (body.preview === true) return NextResponse.json({ ok: true, library: { id: row.id, name: row.name }, impact });

  const expected = (body.expected && typeof body.expected === "object") ? body.expected as Partial<LibraryDeleteImpact> : null;
  if (impactChanged(expected, impact)) {
    return bad("this library changed since its counts were shown (folders, documents or revisions were added or removed) — review the new counts and confirm again. Nothing was deleted.", 409, { impact, changed: true });
  }

  const caller = callerScopedClient(req);
  if ("error" in caller) return bad(caller.error, caller.status);
  const { data: deleted, error: delErr } = await caller.from("libraries").delete().eq("id", libraryId).select("id");
  if (delErr) return bad(delErr.message, 409);
  if (!deleted || (deleted as unknown[]).length === 0) {
    return bad("the database deleted nothing (you may not have permission to delete this library); nothing was changed.", 403);
  }

  // The record. 20261204's trigger writes it inside the delete; look for it
  // first so a pasted database holds exactly one row. A read that fails is
  // treated as "not found": two rows are better than none.
  const { data: existing } = await admin.from("audit_logs").select("id")
    .eq("action", "LIBRARY_DELETED").eq("resource_id", libraryId).limit(1);
  if (Array.isArray(existing) && existing.length > 0) {
    return NextResponse.json({ ok: true, deleted: true, impact, recordedBy: "database" });
  }
  const { error: auditErr } = await admin.from("audit_logs").insert({
    action: "LIBRARY_DELETED", resource_type: "library", resource_id: libraryId, org_id: orgId,
    user_id: actor.userId, user_email: actor.email || null, user_role: actor.admittedRole,
    details: { name: row.name, via: "app", countedBeforeDelete: true, ...impact },
  });
  if (auditErr) {
    console.error(`[libraries/delete] LIBRARY_DELETED audit row failed for ${libraryId}: ${auditErr.message}`);
    return NextResponse.json({ ok: true, deleted: true, impact, recordedBy: null, auditError: auditErr.message });
  }
  return NextResponse.json({ ok: true, deleted: true, impact, recordedBy: "app" });
}
