// GET /api/brand
//
// Which workspace this device signs in to, for the sign-in page: its name
// and its logo link. { logo: null } when there is no logo to show (the
// page then writes the product's name).

import { NextRequest, NextResponse } from "next/server";
import { brandFor, logoLinkFor } from "@/lib/brandServer";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const none = NextResponse.json({ logo: null, name: null }, { headers: { "Cache-Control": "private, no-store" } });
  try {
    const { brand } = await brandFor(req);
    const logo = brand ? await logoLinkFor(brand.orgId) : null;
    if (!brand || !logo) return none;
    return NextResponse.json(
      { logo, name: brand.name },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return none;
  }
}
