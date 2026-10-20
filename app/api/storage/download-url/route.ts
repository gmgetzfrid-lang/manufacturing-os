import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { assertSafeStorageKey } from "@/lib/storageKey";
import { resolvePresignedLifetime } from "@/lib/presignedLifetime";
import { presignedGetDisposition, wantsInline } from "@/lib/presignedDisposition";
// KACL-5: the per-key read decision (the one read predicate over the full
// chain, DEC-43's record, DEC-7's cascade, the explicit download deny) lives
// in lib/documentKeyGate.ts — moved there verbatim by the integrator's DEC-90
// ruling (4) at the intelligence I-29 merge, shared with /api/knowledge/mirror-url.
import { documentKeyGate } from "@/lib/documentKeyGate";
// drafting-flow AUTHZ-4 / EVID-16 (DF-P11, DEC-90 ruling (2)): a drafting-
// ticket file is signed only for a member who may read that ticket.
import { ticketKeyGate } from "@/lib/ticketKeyGate";
// projects-tab GAP-401 remainder (b) (DF-P11): a contractor door upload is
// signed for UNTRUSTED_CONTENT_ORIGIN when the operator sets it; everything
// else, and every key while it is unset, is signed exactly as before.
import { signStorageGet } from "@/lib/untrustedContent";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = req.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  // Refuse traversal / control-byte keys before the org-prefix gate reasons
  // about them — a key like orgs/<mine>/../../orgs/<other>/x would otherwise
  // authorize against my prefix while naming something else.
  try { assertSafeStorageKey(path); } catch { return NextResponse.json({ error: "Invalid path" }, { status: 400 }); }

  // EGR-4 / PKG-11 / DEC-44 §2: the URL's lifetime is the server's decision.
  // A presigned URL is a bearer capability nothing can revoke, so the window
  // it opens IS the control: absent → the default, garbage → 400 (never NaN
  // into the presigner), otherwise clamped to the shared ceiling. Decided
  // before any lookup so a bad request costs nothing.
  const lifetime = resolvePresignedLifetime(req.nextUrl.searchParams.get("expiresIn"));
  if (!lifetime.ok) {
    return NextResponse.json({ error: lifetime.reason }, { status: 400 });
  }

  // Authorize the KEY, not just the session. Every sensitive R2 key is
  // orgs/<orgId>/… — require the caller to be an active member of that org, or
  // any authenticated user could sign a URL for any key they can guess (IDOR /
  // cross-tenant read). Non-org-prefixed keys keep their prior behavior.
  const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//);
  if (orgMatch) {
    const { data: member } = await supabaseAdmin
      .from("org_members")
      .select("uid")
      .eq("org_id", orgMatch[1])
      .eq("uid", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!member) {
      return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
    }

    // KACL-5 / IEDGE-12: membership alone is never enough for a key that
    // belongs to a document. Every org key is resolved to EVERY document
    // that names it — as a revision's rendered file (file_url) or its native
    // source (source_file_key) — and the bytes are served only when the
    // caller may read one of them: lib/permissions canServeContent, the one
    // read predicate (read or download over the FULL library → folder
    // lineage → document chain, on every visibility — an allow-list or a deny
    // on a normal document, its folder or its library binds here exactly as
    // it binds the AI seam and the library page; a private draft is its
    // creator's alone). A key behind a record FAILS CLOSED: a lookup that
    // cannot be made answers 503, a chain with a rung that does not exist
    // answers 409 naming it — for anyone but a controller, who is answered
    // before the chain and recorded (DEC-43). Only a key with no document
    // behind it keeps the membership check alone (attachments, knowledge
    // uploads, logos — they have their own doors).
    const gate = await documentKeyGate(orgMatch[1], path, { id: user.id, email: user.email ?? null });
    if (gate) return gate;
    // AUTHZ-4 / EVID-16: a key under orgs/<org>/tickets/ that no revision
    // names is signed only for a member who may read a ticket naming it
    // (lib/ticketKeyGate.ts — /api/tickets/copy's read scope). Members who
    // are not Contractor-only are answered with no further lookup, as before.
    const ticketGate = await ticketKeyGate(orgMatch[1], path, { id: user.id });
    if (ticketGate) return ticketGate;
  }

  // ARCHIVE-AWARE: if this key's binary was shed to an offline space archive,
  // signing a URL would just 404 downstream. Answer with the archive identity
  // instead (HTTP 409) so the caller can prompt "provide <root>/data/<id>.zip"
  // — unaware callers treat 409 as their existing failure path. Indexed lookup
  // (document_versions_file_url_idx), one row, sub-ms.
  const { data: ver } = await supabaseAdmin
    .from("document_versions")
    .select("archive_id, archived_at")
    .eq("file_url", path)
    .not("archived_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (ver?.archived_at) {
    let root: string | null = null;
    if (orgMatch) {
      const { data: st } = await supabaseAdmin
        .from("archive_settings").select("location_hint")
        .eq("org_id", orgMatch[1]).maybeSingle();
      root = (st as { location_hint?: string | null } | null)?.location_hint ?? null;
    }
    return NextResponse.json(
      { archived: true, archiveId: (ver.archive_id as string | null) ?? null, root, fileName: path.split("/").pop() || "file" },
      { status: 409 },
    );
  }

  // SEC-7 / SEC-1 (DEC-49): the URL is an ATTACHMENT unless the caller asks
  // for inline (`?inline=1` — the in-app viewers) AND the key names a PDF or
  // a raster image; an inline URL also pins that Content-Type, so what the
  // uploader declared is never what the browser renders. The answer says
  // which it got, so a viewer never frames an attachment.
  const disposition = presignedGetDisposition(path, wantsInline(req.nextUrl.searchParams.get("inline")));
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: path,
    ...disposition.overrides,
  });

  const url = await signStorageGet(command, { expiresIn: lifetime.seconds });

  // The payload IS a bearer credential: never cacheable (XEDGE-6 — the
  // service worker refuses no-store and every /api/ response anyway; the
  // header is the contract every other cache honours). `expiresIn` is what
  // was GRANTED, so a caller can record the real window, not what it asked.
  return NextResponse.json(
    {
      url,
      expiresIn: lifetime.seconds,
      disposition: disposition.inline ? "inline" : "attachment",
      contentType: disposition.contentType,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
