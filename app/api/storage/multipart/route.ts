// POST /api/storage/multipart — chunked uploads for big files (laser scans
// run into the GBs; a single presigned PUT is fragile over office uplinks
// and impossible past R2's 5 GB per-PUT ceiling). The browser drives the
// dance: create → sign each part → PUT parts directly to R2 with retries →
// complete (or abort on failure, so no orphaned part storage accrues).
//
// Auth mirrors /api/storage/upload-url exactly: bearer session + active
// membership of the org that owns the key prefix.

import { NextRequest, NextResponse } from "next/server";
import {
  CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return bad("Unauthorized", 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const action = String(body.action ?? "");
  const path = String(body.path ?? "");
  if (!path) return bad("path is required");

  // Same key-level authorization as upload-url: org-prefixed keys demand
  // active membership in that org.
  const orgMatch = path.match(/^orgs\/([0-9a-fA-F-]{36})\//);
  if (orgMatch) {
    const { data: member } = await supabaseAdmin
      .from("org_members").select("uid")
      .eq("org_id", orgMatch[1]).eq("uid", user.id).eq("status", "active")
      .maybeSingle();
    if (!member) return bad("Not a member of this workspace", 403);
  }

  try {
    if (action === "create") {
      const out = await r2.send(new CreateMultipartUploadCommand({
        Bucket: R2_BUCKET, Key: path,
        ContentType: String(body.contentType ?? "application/octet-stream"),
      }));
      if (!out.UploadId) return bad("Storage did not open a multipart upload.", 502);
      return NextResponse.json({ uploadId: out.UploadId });
    }

    if (action === "sign") {
      const uploadId = String(body.uploadId ?? "");
      const partNumber = Number(body.partNumber ?? 0);
      if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
        return bad("uploadId and partNumber (1-10000) are required");
      }
      const url = await getSignedUrl(r2, new UploadPartCommand({
        Bucket: R2_BUCKET, Key: path, UploadId: uploadId, PartNumber: partNumber,
      }), { expiresIn: 3600 });
      return NextResponse.json({ url });
    }

    if (action === "complete") {
      const uploadId = String(body.uploadId ?? "");
      const parts = body.parts as Array<{ partNumber: number; etag: string }> | undefined;
      if (!uploadId || !Array.isArray(parts) || parts.length === 0) {
        return bad("uploadId and parts are required");
      }
      await r2.send(new CompleteMultipartUploadCommand({
        Bucket: R2_BUCKET, Key: path, UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }));
      return NextResponse.json({ ok: true });
    }

    if (action === "abort") {
      const uploadId = String(body.uploadId ?? "");
      if (!uploadId) return bad("uploadId is required");
      await r2.send(new AbortMultipartUploadCommand({
        Bucket: R2_BUCKET, Key: path, UploadId: uploadId,
      }));
      return NextResponse.json({ ok: true });
    }

    return bad(`Unknown action: ${action}`);
  } catch (e) {
    console.error(`[storage/multipart] ${action} failed`, e);
    return bad(`Storage ${action} failed: ${(e as Error).message}`, 502);
  }
}
