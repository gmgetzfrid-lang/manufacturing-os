import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2, R2_BUCKET, r2Configured, R2_NOT_CONFIGURED } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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

  if (!r2Configured()) {
    return NextResponse.json({ error: R2_NOT_CONFIGURED }, { status: 503 });
  }

  const path = req.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  const expiresIn = parseInt(req.nextUrl.searchParams.get("expiresIn") || "3600");

  try {
    const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: path });
    const url = await getSignedUrl(r2, command, { expiresIn });
    return NextResponse.json({ url });
  } catch (e) {
    console.error("[storage/download-url] presign failed:", e);
    return NextResponse.json({ error: "Couldn't create a download URL. Check the server's storage configuration." }, { status: 502 });
  }
}
