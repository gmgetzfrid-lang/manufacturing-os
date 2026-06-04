import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { presignDownload, storageAvailable } from "@/lib/serverStorage";

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

  if (!storageAvailable()) {
    return NextResponse.json({ error: "File storage isn't configured on the server." }, { status: 503 });
  }

  const path = req.nextUrl.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  const expiresIn = parseInt(req.nextUrl.searchParams.get("expiresIn") || "3600");

  try {
    const url = await presignDownload(path, expiresIn);
    return NextResponse.json({ url });
  } catch (e) {
    console.error("[storage/download-url] presign failed:", e);
    return NextResponse.json({ error: (e as Error).message || "Couldn't create a download URL." }, { status: 502 });
  }
}
