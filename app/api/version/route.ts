// /api/version — which build is serving right now.
//
// The client compares this against the id it saw when it booted and offers a
// refresh when they diverge. Without this, a tab left open across deploys
// runs weeks-old JavaScript forever — and every fix shipped since looks like
// it never happened, which is exactly how it reads to the person staring at
// the old bundle.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUILD_ID =
  process.env.VERCEL_GIT_COMMIT_SHA
  ?? process.env.VERCEL_DEPLOYMENT_ID
  ?? "dev";

export async function GET() {
  return NextResponse.json({ id: BUILD_ID }, { headers: { "cache-control": "no-store" } });
}
