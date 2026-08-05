// /api/knowledge/exclusion — the AI gatekeeper, enforced when it's flipped.
//
// POST { orgId, documentId, excluded } → { excluded, purged }
//
// The per-document carve-out already existed as a flag, and the sync already
// honoured it: an excluded document is never mirrored into a knowledge
// library. The hole was TIMING. A document that had already been synced kept
// its mirror — chunks, page entities, mentions, all of it retrievable — until
// the next sync ran. Somebody holding back a confidential report expects it
// invisible now, not at the next cron tick, and "it'll stop being searchable
// within the hour" is not a boundary anybody can sign off on.
//
// So excluding PURGES. The knowledge mirror is deleted, and chunks, page
// entities and mentions cascade with it. What survives is the controlled
// document itself — untouched, still in its library, still readable by people.
// Only the AI's copy goes.
//
// Un-excluding does not restore anything by itself: the next sync re-mirrors
// the document and it re-indexes from the current version. Rebuilding
// silently here would put a stale file back in front of the model.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";

export const runtime = "nodejs";
export const maxDuration = 60;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; documentId?: string; excluded?: unknown };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const documentId = String(body.documentId ?? "").trim();
  if (!orgId || !documentId) return bad("orgId and documentId are required");
  if (typeof body.excluded !== "boolean") return bad("excluded must be true or false");
  const excluded = body.excluded;

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);
  if (!principal.isController) {
    return bad("Only Admin or Doc Control can change what the AI may read.", 403);
  }

  // Scope the write to the org explicitly. The service-role key ignores RLS,
  // so the org check has to be in the query, not assumed from the caller.
  const { data: doc } = await supabaseAdmin
    .from("documents").select("id").eq("id", documentId).eq("org_id", orgId).maybeSingle();
  if (!doc) return bad("No such document in this workspace", 404);

  const { error: flagError } = await supabaseAdmin
    .from("documents").update({ ai_excluded: excluded })
    .eq("id", documentId).eq("org_id", orgId);
  if (flagError) {
    const missing = flagError.code === "42703" || /column/i.test(flagError.message);
    return bad(
      missing
        ? "The AI carve-out needs migration 20260807 — run it in Supabase, then try again."
        : flagError.message,
      missing ? 424 : 500,
    );
  }

  if (!excluded) return NextResponse.json({ excluded, purged: 0 });

  // Purge every knowledge mirror of this document. chunks, page entities and
  // mentions are all ON DELETE CASCADE from knowledge_documents, so this one
  // delete takes the whole indexed footprint with it.
  const { data: mirrors } = await supabaseAdmin
    .from("knowledge_documents").select("id")
    .eq("org_id", orgId).eq("source_document_id", documentId);
  const mirrorIds = (mirrors ?? []).map((m) => m.id as string);

  if (mirrorIds.length > 0) {
    const { error: purgeError } = await supabaseAdmin
      .from("knowledge_documents").delete().in("id", mirrorIds);
    if (purgeError) {
      // The flag is set but the copy is still there — say so rather than
      // reporting success. A boundary reported as enforced when it isn't is
      // worse than one reported as failed.
      return bad(
        `The document is marked held-back, but its indexed copy could not be removed: ${purgeError.message}`,
        500,
      );
    }
  }

  // Mentions recorded directly against the CONTROLLED document (rather than
  // against a knowledge mirror) have no cascade to ride — clear them too.
  await supabaseAdmin.from("entity_mentions").delete()
    .eq("org_id", orgId).eq("document_id", documentId)
    .then(() => undefined, () => undefined);

  return NextResponse.json({ excluded, purged: mirrorIds.length });
}
