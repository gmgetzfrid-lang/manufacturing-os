// POST /api/signup/finish { sessionId, password? }
//
// After paying: makes sure the new workspace exists (the payment webhook
// may not have run yet) and, with a password, sets its first admin's
// password, once (lib/workspaceSignupServer). The payment's id in the
// address is the proof: only the payer is sent back to it.

import { NextRequest, NextResponse } from "next/server";
import { finishState, setFirstPassword, SignupError } from "@/lib/workspaceSignupServer";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { sessionId, password } = await req.json().catch(() => ({})) as { sessionId?: string; password?: string };
  try {
    if (typeof password === "string") return NextResponse.json(await setFirstPassword(String(sessionId ?? ""), password));
    return NextResponse.json(await finishState(String(sessionId ?? "")));
  } catch (e) {
    const status = e instanceof SignupError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
