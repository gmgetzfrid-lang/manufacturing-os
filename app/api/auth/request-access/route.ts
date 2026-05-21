import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(req: NextRequest) {
  try {
    const { displayName, email, orgName, message } = await req.json();

    await supabaseAdmin.from("access_requests").insert({
      display_name: displayName,
      email,
      org_name: orgName,
      message: message ?? null,
      status: "pending",
      created_at: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to submit request." }, { status: 500 });
  }
}
