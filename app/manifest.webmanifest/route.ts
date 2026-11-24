// GET /manifest.webmanifest
//
// Makes the app installable ("Add to Home Screen"). The icons are the
// workspace's own logo (see /api/brand/icon): the workspace this device
// signs in to, from the mos_ws cookie the app sets after sign-in. The
// page asks for this file with credentials so the cookie comes along.

import { NextRequest, NextResponse } from "next/server";
import { brandFor } from "@/lib/brandServer";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  let q = "";
  try {
    const { brand } = await brandFor(req);
    if (brand?.logoPath) q = `&ws=${brand.orgId}&v=${brand.version}`;
  } catch { /* plain icons */ }
  const icon = (s: number, purpose: "any" | "maskable") => ({
    src: `/api/brand/icon?s=${s}${purpose === "maskable" ? "&m=mask" : ""}${q}`,
    sizes: `${s}x${s}`, type: "image/png", purpose,
  });
  const manifest = {
    id: "/",
    name: "Manufacturing OS",
    short_name: "MfgOS",
    description: "Industrial document control, drafting workflow, and audit trail",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    categories: ["business", "productivity", "utilities"],
    icons: [icon(192, "any"), icon(512, "any"), icon(192, "maskable"), icon(512, "maskable")],
  };
  return new NextResponse(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "private, max-age=300" },
  });
}
