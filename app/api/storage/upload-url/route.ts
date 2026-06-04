import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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

  // Fail loudly + clearly when object storage isn't configured, instead of
  // handing back a bogus presigned URL that 404s/DNS-fails on the PUT and
  // surfaces to the user as an opaque "Upload network error".
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    return NextResponse.json(
      { error: "File storage isn't configured on the server (missing R2 credentials). Ask an admin to set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME." },
      { status: 503 },
    );
  }

  const body = await req.json();
  const { path, contentType } = body as { path: string; contentType?: string };

  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  try {
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: path,
      ContentType: contentType || "application/octet-stream",
    });
    const url = await getSignedUrl(r2, command, { expiresIn: 900 }); // 15 min
    return NextResponse.json({ url, path });
  } catch (e) {
    console.error("[storage/upload-url] presign failed:", e);
    return NextResponse.json({ error: "Couldn't create an upload URL. Check the server's storage configuration." }, { status: 502 });
  }
}
