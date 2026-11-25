import { NextRequest, NextResponse } from "next/server";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { assertSafeStorageKey } from "@/lib/storageKey";

/** true / false, or null when storage couldn't say (treated as a refusal). */
async function objectExists(key: string): Promise<boolean | null> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) return false;
    return null;
  }
}

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
  const { path, contentType } = body as { path: string; contentType?: string };

  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  try { assertSafeStorageKey(path); } catch { return NextResponse.json({ error: "Invalid path" }, { status: 400 }); }

  // Authorize the KEY, not just the session. Every R2 key the app writes is
  // orgs/<orgId>/… (caller must be an active member of that org) or the
  // caller's own avatars/<uid>/ folder; anything else is refused, or any
  // authenticated user could sign a PUT for any key they can guess and
  // overwrite another tenant's files (IDOR / cross-tenant write).
  const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//);
  const ownAvatar = path.startsWith(`avatars/${user.id}/`);
  if (!orgMatch && !ownAvatar) {
    return NextResponse.json({ error: "You can't upload to that place." }, { status: 403 });
  }
  let controller = false;
  if (orgMatch) {
    const { data: member } = await supabaseAdmin
      .from("org_members")
      .select("role, roles")
      .eq("org_id", orgMatch[1])
      .eq("uid", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!member) {
      return NextResponse.json({ error: "Not a member of this workspace" }, { status: 403 });
    }
    const roles = [member.role as string, ...(((member.roles as string[] | null) ?? []))];
    controller = roles.includes("Admin") || roles.includes("DocCtrl");
  }

  // Uploads go to fresh keys, so replacing a stored file is never routine:
  // only Admin or Doc Control may overwrite one (own avatar aside), or any
  // member could swap the bytes of a released drawing.
  if (!controller && !ownAvatar) {
    const exists = await objectExists(path);
    if (exists === null) {
      return NextResponse.json({ error: "Couldn't check storage. Try again." }, { status: 503 });
    }
    if (exists) {
      return NextResponse.json({ error: "A file is already stored there. Only Admin or Doc Control can replace it." }, { status: 409 });
    }
  }

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: path,
    ContentType: contentType || "application/octet-stream",
  });

  const url = await getSignedUrl(r2, command, { expiresIn: 900 }); // 15 min

  return NextResponse.json({ url, path });
}
