// /api/schedule/convert-mpp — converts a raw .mpp binary upload to
// a JSON task list.
//
// Why server-side: .mpp is an OLE2 compound binary that browsers
// can't read meaningfully. We crack the container with SheetJS's
// `cfb` library on the server, then extract task data via the
// best-effort parser in lib/mppParser.ts.
//
// Two modes:
//
//   1. Native (default) — pure-JS parse using `cfb`. Works for a
//      lot of MS Project 2007 — 365 schedules. May miss exotic
//      fields or fail entirely on heavily customized files.
//
//   2. Remote (opt-in)  — if MPP_CONVERTER_URL is set in the env,
//      the route forwards the raw bytes to that converter and
//      trusts its JSON. Use this when you stand up MPXJ-as-a-
//      service or a paid converter (Aspose, Smartsheet).
//
// Auth: standard Supabase bearer token, same as the other server
// routes in /api.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { parseMppFile } from "@/lib/mppParser";

export const runtime = "nodejs";
// MPP files can be a few MB; raise the body limit conservatively.
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  // Auth
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = authHeader.slice(7);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Read the binary body. Accept both raw octet-stream and
  // multipart/form-data with a "file" field — different clients
  // send different things.
  let buf: ArrayBuffer;
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
      }
      buf = await file.arrayBuffer();
    } else {
      buf = await req.arrayBuffer();
    }
  } catch (e) {
    return NextResponse.json({ error: `Couldn't read upload: ${(e as Error).message}` }, { status: 400 });
  }

  if (!buf || buf.byteLength === 0) {
    return NextResponse.json({ error: "Empty upload" }, { status: 400 });
  }
  if (buf.byteLength > 64 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 64 MB)" }, { status: 413 });
  }

  try {
    const result = await parseMppFile(buf);
    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      via: result.via ?? null,
      message: result.message ?? null,
      projectName: result.projectName ?? null,
      tasks: result.tasks,
    });
  } catch (e) {
    console.error("[convert-mpp] parse failed:", e);
    return NextResponse.json(
      { ok: false, status: "error", message: `Server parser failed: ${(e as Error).message}`, tasks: [] },
      { status: 500 },
    );
  }
}
