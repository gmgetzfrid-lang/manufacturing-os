// GET /api/brand/logo[?ws=<workspace id>][&plate=1]
//
// The workspace's uploaded logo, its empty margin cut off: for the sign-in
// page and the pages someone outside the company opens. plate=1 puts it on
// its own background color with a margin. 404 when the workspace has none.

import { NextRequest, NextResponse } from "next/server";
import { brandFor, cacheFor, logoPng } from "@/lib/brandServer";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const { brand, shared } = await brandFor(req);
    const png = brand ? await logoPng(brand, req.nextUrl.searchParams.get("plate") === "1") : null;
    if (!png) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    return new NextResponse(new Uint8Array(png), {
      headers: { "Content-Type": "image/png", "Cache-Control": cacheFor(shared) },
    });
  } catch {
    return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
