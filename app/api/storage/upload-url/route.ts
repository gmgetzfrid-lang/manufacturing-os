import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { presignUpload, storageAvailable } from "@/lib/serverStorage";

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

  if (!storageAvailable()) {
    return NextResponse.json({ error: "File storage isn't configured on the server." }, { status: 503 });
  }

  const body = await req.json();
  const { path, contentType } = body as { path: string; contentType?: string };
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  try {
    // Uses R2 when configured, else Supabase Storage (auto-created bucket).
    const url = await presignUpload(path, contentType);
    return NextResponse.json({ url, path });
  } catch (e) {
    console.error("[storage/upload-url] presign failed:", e);
    return NextResponse.json({ error: (e as Error).message || "Couldn't create an upload URL." }, { status: 502 });
  }
}
