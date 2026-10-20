// GET /api/storage/resolve?path=<r2 key>
//
// The archive-aware file opener. Given a storage key it returns EITHER a signed
// URL (binary present) OR archived metadata (binary shed for space) so the UI
// can prompt the user — any user — to provide the named offline archive instead
// of showing a broken link.
//
//   { archived:false, url }                              → open it normally
//   { archived:true, archiveId, root, fileName }         → prompt: provide
//                                                          <root>/data/<id>.zip
//   { archived:true, missing:true, … }                   → storage answered
//                                                          NotFound for the key
//   503 { error, retryable:true }                        → storage could not be
//                                                          asked (ORG-20) — try
//                                                          again; NOT "missing"
//
// Who may ask (drafting-flow AUTHZ-4, DF-P11): the same read decision as
// /api/storage/download-url — an active member of the key's workspace, then
// the document gate (lib/documentKeyGate.ts: the one read predicate over the
// full chain, the explicit download deny, DEC-43's controller rail and its
// CONTROLLER_RESTRICTED_READ row) for a key a revision names, then the
// ticket-file gate (lib/ticketKeyGate.ts, EVID-16 / DEC-90 ruling (2)) for a
// key under orgs/<org>/tickets/. A key that cannot be attributed to a
// workspace is refused, never signed. Both gates run before the archive
// answer, so a refused caller learns nothing about the file.

import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { assertSafeStorageKey } from "@/lib/storageKey";
import { PRESIGNED_MAX_SECONDS } from "@/lib/presignedLifetime";
import { presignedGetDisposition, wantsInline } from "@/lib/presignedDisposition";
import { documentKeyGate } from "@/lib/documentKeyGate";
import { ticketKeyGate } from "@/lib/ticketKeyGate";
// projects-tab GAP-401 remainder (b): a door upload is signed for
// UNTRUSTED_CONTENT_ORIGIN when set; everything else exactly as before.
import { signStorageGet } from "@/lib/untrustedContent";

/** ORG-20: storage's own "no such object" — the only HEAD failure that may be
 *  answered `missing: true`. Anything else (a 5xx, throttling, a timeout,
 *  bad credentials, a signing error) is an outage, not an absence. */
export function isStorageNotFound(e: unknown): boolean {
  const err = e as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (!err || typeof err !== "object") return false;
  if (err.name === "NotFound" || err.name === "NoSuchKey" || err.Code === "NoSuchKey") return true;
  return err.$metadata?.httpStatusCode === 404;
}

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const path = req.nextUrl.searchParams.get("path") || "";
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
  try { assertSafeStorageKey(path); } catch { return NextResponse.json({ error: "Invalid path" }, { status: 400 }); }

  // AUTHZ-4: the key's own orgs/<org>/ prefix names its workspace, as at
  // /api/storage/download-url — a row of ANOTHER workspace that names the key
  // (a planted attachment) never moves the membership check to that
  // workspace. Only a key with no prefix (legacy) is attributed by its row.
  const prefixOrg = path.match(/^orgs\/([0-9a-fA-F-]{36})\//)?.[1] ?? null;

  // Which version owns this binary? Drives archive status + org membership check.
  let verQ = supabaseAdmin
    .from("document_versions")
    .select("org_id, archived_at, archive_id, created_at")
    .eq("file_url", path);
  if (prefixOrg) verQ = verQ.eq("org_id", prefixOrg);
  const { data: ver } = await verQ
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let v = ver as { org_id?: string; archived_at?: string | null; archive_id?: string | null } | null;
  // Ticket-attachment keys have no document_versions row — attribute them via
  // the owning ticket so a shed attachment still gets a NAMED archive prompt
  // instead of "ask an admin".
  if (!v) {
    let tkQ = supabaseAdmin
      .from("tickets")
      .select("org_id, archived_at, archive_id")
      .contains("attachments", JSON.stringify([{ url: path }]));
    if (prefixOrg) tkQ = tkQ.eq("org_id", prefixOrg);
    const { data: tk } = await tkQ
      .limit(1)
      .maybeSingle();
    if (tk) v = tk as { org_id?: string; archived_at?: string | null; archive_id?: string | null };
  }
  // Attribute the key to an org: the `orgs/<orgId>/…` prefix, else (a legacy
  // key) the row that names it — so the membership gate below ALWAYS applies.
  const orgId = prefixOrg ?? v?.org_id;
  const fileName = path.split("/").pop() || "file";

  // AUTHZ-4 done-when 2: a key no workspace can be attributed to is refused,
  // never signed for any signed-in caller (every key the app mints is
  // orgs/<org>/…; a legacy key is attributed through its revision row).
  if (!orgId) {
    return NextResponse.json({ error: "This file can't be attributed to a workspace" }, { status: 403 });
  }
  // The caller must be an active member of the key's workspace.
  {
    const { data: m } = await supabaseAdmin
      .from("org_members").select("uid")
      .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
    if (!m) return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
  }
  // AUTHZ-4 done-when 1: the same read decision as /api/storage/download-url —
  // the document gate (KACL-5 / IEDGE-12 / DEC-43 / DEC-7) for a key a
  // revision names, then the ticket-file gate for orgs/<org>/tickets/ keys.
  const docGate = await documentKeyGate(orgId, path, { id: user.id, email: user.email ?? null });
  if (docGate) return docGate;
  const ticketGate = await ticketKeyGate(orgId, path, { id: user.id });
  if (ticketGate) return ticketGate;

  const settingsFor = async (): Promise<{ root: string | null; namingNote: string | null }> => {
    const { data } = await supabaseAdmin.from("archive_settings").select("location_hint, naming").eq("org_id", orgId).maybeSingle();
    const s = data as { location_hint?: string | null; naming?: string | null } | null;
    return { root: s?.location_hint ?? null, namingNote: s?.naming ?? null };
  };

  // Explicitly shed for space.
  if (v?.archived_at) {
    const s = await settingsFor();
    return NextResponse.json({ archived: true, archiveId: v.archive_id ?? null, root: s.root, namingNote: s.namingNote, fileName });
  }

  // Otherwise sign it — but if the object is actually gone from R2, fall back to
  // the archived prompt so the user still has a path forward. ORG-20: only
  // storage's NotFound is "missing"; any other failure is a 503 the caller
  // can retry (the restore counts a non-200 as "not reported missing"; the
  // viewers say the error instead of an archive prompt).
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: path }));
  } catch (e) {
    if (!isStorageNotFound(e)) {
      return NextResponse.json(
        { error: "Storage couldn't be reached to check this file — try again in a moment.", retryable: true },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const s = await settingsFor();
    return NextResponse.json({ archived: true, missing: true, archiveId: v?.archive_id ?? null, root: s.root, namingNote: s.namingNote, fileName });
  }
  try {
    // EGR-4 / DEC-44 §2: the same ceiling as /api/storage/download-url — no
    // issuer is looser than another — and a signed payload is never cacheable.
    // SEC-18 (DEC-49): the same disposition as download-url — an ATTACHMENT
    // unless the caller asks for inline (`?inline=1`, the new-tab opener) AND
    // the key names a PDF or a raster image, whose type is then pinned — so a
    // stored HTML / SVG upload never opens as a page.
    const disposition = presignedGetDisposition(path, wantsInline(req.nextUrl.searchParams.get("inline")));
    const url = await signStorageGet(
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: path, ...disposition.overrides }),
      { expiresIn: PRESIGNED_MAX_SECONDS },
    );
    return NextResponse.json(
      {
        archived: false, url, expiresIn: PRESIGNED_MAX_SECONDS,
        disposition: disposition.inline ? "inline" : "attachment",
        contentType: disposition.contentType,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // ORG-20: the object is there (HEAD answered) but no URL could be signed.
    return NextResponse.json(
      { error: "This file couldn't be opened right now — try again in a moment.", retryable: true },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
