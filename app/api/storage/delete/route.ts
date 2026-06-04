import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { removeObject, storageAvailable } from "@/lib/serverStorage";

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

  if (!storageAvailable()) {
    return NextResponse.json({ error: "File storage isn't configured on the server." }, { status: 503 });
  }

  const { path } = await req.json() as { path: string };
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  try {
    await removeObject(path);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[storage/delete] delete failed:", e);
    return NextResponse.json({ error: (e as Error).message || "Couldn't delete the file." }, { status: 502 });
  }
}
