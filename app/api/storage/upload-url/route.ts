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

  const body = await req.json();
  const { path, contentType } = body as { path: string; contentType?: string };

  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: path,
    ContentType: contentType || "application/octet-stream",
  });

  const url = await getSignedUrl(r2, command, { expiresIn: 900 }); // 15 min

  return NextResponse.json({ url, path });
}
