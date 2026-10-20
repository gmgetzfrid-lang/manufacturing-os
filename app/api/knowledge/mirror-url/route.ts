// GET /api/knowledge/mirror-url?id=<knowledge document id>
//
// intelligence KACL-5 criterion 4 / KACL-7 criterion 3 (Round G, I-29; the
// integrator's DEC-90 ruling at the I-12 merge): a SOURCE-LINKED knowledge
// mirror never hands the browser `knowledge_documents.file_key`. The
// knowledge viewer (CitedPageViewer, the knowledge library page) asks THIS
// route for a short-lived signed URL to a mirror's file and receives the URL,
// never the key.
//
// The decision is the bytes door's, not a second walk: once the mirror is
// resolved (server side) to its stored key, the key is signed by
// /api/storage/download-url's own handler — the I-12 read predicate
// (lib/permissions canServeContent: `read` or `download` over the FULL
// library → folder lineage → document chain, on every visibility, a private
// draft its creator's alone), DEC-43's controller record, DEC-7's ownership
// cascade, the explicit download deny, the archive answer, the URL lifetime
// and the inline disposition. So every reader who opened a mirror before
// (the viewer signed the same key through the same door) opens exactly what
// they opened before, and a reader the door refuses gets no URL.
//
// Before the door is asked, the mirror is BOUND to its source: its key must
// be a revision file of the very document the mirror names
// (document_versions.record_id = source_document_id) — so the decision is
// made about the mirror's source. A key under ANOTHER workspace's prefix is
// refused. A bound key from before the orgs/ prefix (registers can still
// carry one — the sync copies a revision's file_url unchanged) is decided by
// the door's own gate (documentKeyGate, exported for this: the same
// predicate, which the door's handler applies to org keys only) with the
// mirror's workspace as the key's, then signed by the door — one walk, never
// a key signed on membership alone. Anything that cannot be checked fails
// CLOSED and says so: a failed lookup is 503, an unbound key is 409, a key
// the door's guard refuses (its 400) is a permanent 409; the door's own
// 503 / 409 pass through. A refusal (403) carries no key, no URL and no
// detail beyond "the source is restricted".

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { GET as signStorageKey, documentKeyGate } from "@/app/api/storage/download-url/route";
import { isSafeStorageKey } from "@/lib/storageKey";
import {
  MIRROR_ACCESS_UNVERIFIED, MIRROR_IS_UPLOAD, MIRROR_KEY_INVALID, MIRROR_KEY_OUTSIDE_WORKSPACE, MIRROR_NOT_FOUND,
  MIRROR_SOURCE_RESTRICTED, MIRROR_UNBOUND,
} from "@/lib/knowledgeMirrorAccess";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: NO_STORE });

/** A refusal the door (its handler or its gate) answered, in this route's
 *  words — never the key. `null` = not a refusal this maps. */
function doorRefusal(status: number, body: Record<string, unknown> | null): NextResponse | null {
  // The door refused this caller: the source is restricted for them.
  if (status === 403) return answer({ error: MIRROR_SOURCE_RESTRICTED, restricted: true }, 403);
  // An archived file (the archive identity, never the key) or a broken
  // chain the door named: passed through as the door said them.
  if (status === 409 && body) {
    if (body.archived === true) {
      return answer({
        archived: true,
        archiveId: body.archiveId ?? null,
        root: body.root ?? null,
        fileName: body.fileName ?? null,
      }, 409);
    }
    return answer({ error: typeof body.error === "string" ? body.error : MIRROR_ACCESS_UNVERIFIED }, 409);
  }
  // The door's guard refused the stored key itself (assertSafeStorageKey's
  // 400): permanent, so said as such — never "try again".
  if (status === 400) return answer({ error: MIRROR_KEY_INVALID }, 409);
  if (status === 401) return answer({ error: "Unauthorized" }, 401);
  return null;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return answer({ error: "Unauthorized" }, 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return answer({ error: "Unauthorized" }, 401);

  const id = (req.nextUrl.searchParams.get("id") ?? "").trim();
  if (!UUID.test(id)) return answer({ error: "id is required" }, 400);

  // The mirror, read as the service role — its key never leaves this route.
  const { data: row, error: rowErr } = await supabaseAdmin
    .from("knowledge_documents")
    .select("id, org_id, file_key, source_document_id")
    .eq("id", id)
    .maybeSingle();
  if (rowErr) return answer({ error: MIRROR_ACCESS_UNVERIFIED }, 503);
  const mirror = row as { org_id?: string | null; file_key?: string | null; source_document_id?: string | null } | null;
  if (!mirror?.org_id) return answer({ error: MIRROR_NOT_FOUND }, 404);

  // An active member of the mirror's workspace, or the row does not exist
  // for them (no answer that tells a stranger the id is real).
  const { data: member, error: memberErr } = await supabaseAdmin
    .from("org_members").select("uid")
    .eq("org_id", mirror.org_id).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (memberErr) return answer({ error: MIRROR_ACCESS_UNVERIFIED }, 503);
  if (!member) return answer({ error: MIRROR_NOT_FOUND }, 404);

  const sourceId = mirror.source_document_id ?? null;
  if (!sourceId) return answer({ error: MIRROR_IS_UPLOAD }, 400);
  const key = mirror.file_key ?? "";
  if (!key) return answer({ error: MIRROR_NOT_FOUND }, 404);

  // A key under ANOTHER workspace's prefix is not this workspace's mirror
  // to open — closed, and said. A key the storage guard refuses (a URL, a
  // traversal or control byte) can never be signed — permanent, and said.
  const orgKey = key.startsWith(`orgs/${mirror.org_id}/`);
  if (!orgKey && key.startsWith("orgs/")) return answer({ error: MIRROR_KEY_OUTSIDE_WORKSPACE }, 409);
  if (!isSafeStorageKey(key)) return answer({ error: MIRROR_KEY_INVALID }, 409);

  // Bound to the source: the key must be a revision file of the document the
  // mirror names (the sync writes file_key = that revision's file_url).
  const { data: bound, error: boundErr } = await supabaseAdmin
    .from("document_versions").select("id")
    .eq("record_id", sourceId).eq("file_url", key)
    .limit(1);
  if (boundErr) return answer({ error: MIRROR_ACCESS_UNVERIFIED }, 503);
  if ((Array.isArray(bound) ? bound : bound ? [bound] : []).length === 0) {
    return answer({ error: MIRROR_UNBOUND }, 409);
  }

  // A bound key from before the orgs/ prefix: the door's handler gates org
  // keys only, so its gate decides this one here — the same predicate, with
  // the mirror's workspace as the key's — before the door signs it.
  if (!orgKey) {
    const gate = await documentKeyGate(mirror.org_id, key, { id: user.id, email: user.email ?? null });
    if (gate) {
      const gateBody = (await gate.json().catch(() => null)) as Record<string, unknown> | null;
      return doorRefusal(gate.status, gateBody) ?? answer({ error: MIRROR_ACCESS_UNVERIFIED }, 503);
    }
  }

  // The bytes door's own decision and signature, for the caller's session.
  const doorUrl = new URL("/api/storage/download-url", req.nextUrl.origin);
  doorUrl.searchParams.set("path", key);
  doorUrl.searchParams.set("inline", "1");
  let door: Response;
  try {
    door = await signStorageKey(new NextRequest(doorUrl, { headers: { authorization: authHeader } }));
  } catch {
    return answer({ error: MIRROR_ACCESS_UNVERIFIED }, 503);
  }
  const body = (await door.json().catch(() => null)) as Record<string, unknown> | null;
  if (door.status === 200 && body && typeof body.url === "string") {
    return answer({
      url: body.url,
      expiresIn: body.expiresIn ?? null,
      disposition: body.disposition ?? null,
      contentType: body.contentType ?? null,
    }, 200);
  }
  // Anything the door refused, in this route's words; anything else (the
  // door's own 503): closed, and said.
  return doorRefusal(door.status, body) ?? answer({ error: MIRROR_ACCESS_UNVERIFIED }, 503);
}
