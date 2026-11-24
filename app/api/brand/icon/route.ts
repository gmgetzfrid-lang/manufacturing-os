// GET /api/brand/icon?s=<16..1024>[&m=mask|apple][&ws=<workspace id>]
//
// The app icon, made from the workspace's uploaded logo: the browser tab,
// the home-screen icon, the install icon. Public (the browser fetches it
// by itself, before sign-in); it only ever serves a workspace's logo.

import { NextRequest, NextResponse } from "next/server";
import { brandFor, cacheFor, iconPng, type IconKind } from "@/lib/brandServer";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const size = Math.min(1024, Math.max(16, Math.round(Number(q.get("s")) || 192)));
  const m = q.get("m");
  const kind: IconKind = m === "mask" || m === "apple" ? m : "any";
  let brand = null, shared = false;
  try { ({ brand, shared } = await brandFor(req)); } catch { /* plain fallback */ }
  const png = await iconPng(brand, size, kind);
  return new NextResponse(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": cacheFor(shared && !!brand) },
  });
}
