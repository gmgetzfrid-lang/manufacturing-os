import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  assertSafeStorageKey, isWorkspaceLogoKey, logoUploadProblem,
  isNodeImageKey, NODE_CUSTOMIZE_ROLES, nodeImageUploadProblem,
} from "@/lib/storageKey";
import { memberHoldsAny } from "@/lib/roleHeld";
import { enforceOrgAccess } from "@/lib/serverAuth";
import { ticketKeyOverwriteRefusal, r2Head } from "@/lib/ticketKeyOverwrite";
import { versionKeyWriteRefusal } from "@/lib/versionKeyWriteGate";
import { outsideOrgWriteRefusal } from "@/lib/storageWriteAllowList";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { path, contentType, size } = body as { path: string; contentType?: string; size?: number };

  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  try { assertSafeStorageKey(path); } catch { return NextResponse.json({ error: "Invalid path" }, { status: 400 }); }

  // Authorize the KEY, not just the session. Every sensitive R2 key is
  // orgs/<orgId>/… — require the caller to be an active member of that org, or
  // any authenticated user could sign a PUT for any key they can guess and
  // overwrite another tenant's files (IDOR / cross-tenant write). Mirrors the
  // check in download-url. A key outside orgs/<uuid>/ is held to the
  // allow-list below (drafting-flow EVID-19).
  const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//);
  // ORG-5: the workspace logo (a file directly under orgs/<org>/branding/,
  // lib/storageKey.ts isWorkspaceLogoKey) is the AREA whose bytes every member
  // sees as the workspace's mark, and whose pointer only an Admin may change
  // (20260713). Writing it is Admin-only, by the full role collection, and
  // only as a PNG / JPEG / WebP of at most 5 MB, the type and length signed
  // into the PUT so the upload cannot swap them.
  const logo = isWorkspaceLogoKey(path);
  // ORG-16: a folder's or library's cover image and page background
  // (orgs/<org>/branding/covers/ and …/backgrounds/, lib/storageKey.ts
  // isNodeImageKey) are what every member who can see the node is shown.
  // Writing them is held to the authority that opens the node editor
  // (CustomizeNodeModal: the controller tier, NODE_CUSTOMIZE_ROLES, by the
  // full role collection), and only as an image type the server signs into
  // the PUT — ORG-5's rule on the smaller surface. No size cap.
  const nodeImage = isNodeImageKey(path);
  if (orgMatch) {
    const { data: member } = await supabaseAdmin
      .from("org_members")
      .select("uid, role, roles")
      .eq("org_id", orgMatch[1])
      .eq("uid", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!member) {
      return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
    }
    if (logo && !memberHoldsAny(member as { role?: unknown; roles?: unknown }, ["Admin"])) {
      return NextResponse.json({ error: "Only an Admin can change the workspace logo." }, { status: 403 });
    }
    if (nodeImage && !memberHoldsAny(member as { role?: unknown; roles?: unknown }, NODE_CUSTOMIZE_ROLES)) {
      return NextResponse.json(
        { error: "Only an Admin or a Document Controller can change a folder's or library's cover image or background." },
        { status: 403 },
      );
    }
    // BILL-10 (admin-and-org Round G P5, DEC-18): new stored bytes are a
    // billable resource. With SUBSCRIPTION_ENFORCE on, a lapsed workspace is
    // refused here (402, the reason in a sentence); off, the would-be refusal
    // is only logged. Downloads and exports never pass this gate.
    const gate = await enforceOrgAccess(supabaseAdmin, orgMatch[1], "storage/upload-url");
    if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  }
  // drafting-flow EVID-19 (DEC-90: deny by default): a key OUTSIDE
  // orgs/<uuid>/ is signed only when lib/storageWriteAllowList.ts allows it —
  // the caller's own avatars/<uid>/ folder, or the backup restore's put-back
  // of a legacy request file in its one historical shape,
  // tickets/<id>/attachments/<name> (an Admin of every workspace whose
  // request lists it, each past the subscription gate, only while the object
  // is absent). Everything else is refused in plain words, nothing signed; a
  // lookup that cannot be made is a 503.
  if (!orgMatch) {
    const outside = await outsideOrgWriteRefusal(supabaseAdmin, r2Head(r2 as never, R2_BUCKET), path, user.id, "storage/upload-url");
    if (outside) return NextResponse.json({ error: outside.error }, { status: outside.status });
  }
  if (logo) {
    const problem = logoUploadProblem(contentType, size);
    if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });
  }
  if (nodeImage) {
    const problem = nodeImageUploadProblem(contentType);
    if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });
  }

  // Authorize the KEY's MEANING, not just its org prefix (PKG-1). Every
  // upload the app mints targets a FRESH, timestamped key, so a request to
  // PUT a key that is already the stored bytes of a document version is never
  // a legitimate upload — it is an in-place overwrite of an issued,
  // hash-recorded, approved revision, which changes what every QR, doc pack
  // and download serves while every database fact (rev, file_hash,
  // approvals) stays untouched. Refuse to re-sign such a key; the immutable
  // revision bytes can only be replaced by publishing a new version (a fresh
  // key). Checked against both the rendered bytes (file_url) and the native
  // source (source_file_key). Fail closed (503) when the ledger cannot be
  // read. The check lives in lib/versionKeyWriteGate.ts (moved verbatim, so
  // /api/storage/multipart asks the same question — PKG-15).
  const versionRefusal = await versionKeyWriteRefusal(supabaseAdmin, path);
  if (versionRefusal) return NextResponse.json({ error: versionRefusal.error }, { status: versionRefusal.status });

  // drafting-flow EVID-17: a request's stored file (a key under
  // orgs/<org>/tickets/ that a request lists, whose bytes are in storage) is
  // never re-signed — the approval, the issue and the attach row's sha256
  // name those bytes. A fresh upload key, and the restore's put-back of a
  // file that is not in storage, are signed exactly as before. Fail closed.
  const ticketRefusal = await ticketKeyOverwriteRefusal(supabaseAdmin, r2Head(r2 as never, R2_BUCKET), path);
  if (ticketRefusal) return NextResponse.json({ error: ticketRefusal.error }, { status: ticketRefusal.status });

  if (logo && orgMatch) {
    // ORG-5: a logo upload is recorded, naming the actor, before it is signed
    // — the bytes it authorizes are what every member sees. Checked: a row
    // that cannot be written refuses the upload rather than signing it
    // unrecorded.
    const { error: auditErr } = await supabaseAdmin.from("audit_logs").insert({
      action: "BRANDING_LOGO_UPLOAD",
      resource_id: orgMatch[1],
      resource_type: "org_branding",
      org_id: orgMatch[1],
      user_id: user.id,
      user_email: user.email ?? null,
      user_role: "Admin",
      details: { path, contentType, size },
    });
    if (auditErr) {
      return NextResponse.json({ error: "Couldn't record the logo upload, so it was not signed. Try again." }, { status: 503 });
    }
  }

  const command = new PutObjectCommand(logo
    ? { Bucket: R2_BUCKET, Key: path, ContentType: contentType, ContentLength: size }
    : { Bucket: R2_BUCKET, Key: path, ContentType: contentType || "application/octet-stream" });

  // A logo's Content-Type is signed too (the presigner leaves it unsigned by
  // default), and its Content-Length is signed because it is set: a PUT with
  // another type or another byte count is refused by storage. A cover's or
  // background's Content-Type is signed the same way (ORG-16), so the PUT
  // cannot store an HTML page under the image type the route allowed.
  const url = await getSignedUrl(r2, command, logo || nodeImage
    ? { expiresIn: 900, signableHeaders: new Set(["content-type"]) }
    : { expiresIn: 900 }); // 15 min

  return NextResponse.json({ url, path });
}
