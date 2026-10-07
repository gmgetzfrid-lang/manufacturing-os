import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { assertSafeStorageKey, isWorkspaceLogoKey, logoUploadProblem } from "@/lib/storageKey";
import { memberHoldsAny } from "@/lib/roleHeld";

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
  // check in download-url. Non-org-prefixed keys keep their prior behavior.
  const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//);
  // ORG-5: the workspace logo (a file directly under orgs/<org>/branding/,
  // lib/storageKey.ts isWorkspaceLogoKey) is the AREA whose bytes every member
  // sees as the workspace's mark, and whose pointer only an Admin may change
  // (20260713). Writing it is Admin-only, by the full role collection, and
  // only as a PNG / JPEG / WebP of at most 5 MB, the type and length signed
  // into the PUT so the upload cannot swap them.
  const logo = isWorkspaceLogoKey(path);
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
  }
  if (logo) {
    const problem = logoUploadProblem(contentType, size);
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
  // source (source_file_key).
  // Two exact-equality lookups rather than a PostgREST .or() raw string:
  // assertSafeStorageKey permits commas and parentheses, which would break or
  // inject an .or() filter expression.
  for (const col of ["file_url", "source_file_key"] as const) {
    const { data: clash, error: clashErr } = await supabaseAdmin
      .from("document_versions")
      .select("id")
      .eq(col, path)
      .limit(1)
      .maybeSingle();
    if (clashErr) {
      // Fail closed — never sign a PUT we could not clear against the version
      // ledger, because the write it authorizes is irreversible.
      return NextResponse.json({ error: "Couldn't verify the target key; upload refused." }, { status: 503 });
    }
    if (clash) {
      return NextResponse.json(
        { error: "That file already belongs to a published revision and cannot be overwritten. Publish a new revision instead." },
        { status: 409 },
      );
    }
  }

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
  // another type or another byte count is refused by storage.
  const url = await getSignedUrl(r2, command, logo
    ? { expiresIn: 900, signableHeaders: new Set(["content-type"]) }
    : { expiresIn: 900 }); // 15 min

  return NextResponse.json({ url, path });
}
