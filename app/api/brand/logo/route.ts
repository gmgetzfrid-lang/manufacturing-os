// GET /api/brand/logo?ws=<workspace id>[&plate=1]
//
// A workspace's uploaded logo, its empty margin cut off, for the pages
// someone outside the company opens (the sender's logo). plate=1 puts it on
// its own background color with a margin. 404 when the workspace has none.

import { NextRequest, NextResponse } from "next/server";
import { brandFor, logoPng } from "@/lib/brandServer";

export const runtime = "nodejs";

const none = () => new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(req: NextRequest) {
  try {
    const brand = await brandFor(req);
    const png = brand ? await logoPng(brand, req.nextUrl.searchParams.get("plate") === "1") : null;
    if (!png) return none();
    return new NextResponse(new Uint8Array(png), {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch {
    return none();
  }
}
