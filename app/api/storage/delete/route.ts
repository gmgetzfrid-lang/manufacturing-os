import { NextRequest, NextResponse } from "next/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2, R2_BUCKET, r2Configured, R2_NOT_CONFIGURED } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function DELETE(req: NextRequest) {
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

  const { path } = await req.json() as { path: string };
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: path }));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[storage/delete] delete failed:", e);
    return NextResponse.json({ error: "Couldn't delete the file. Check the server's storage configuration." }, { status: 502 });
  }
}
