// /api/links/propose — run the link proposers for an org.
//
// POST { orgId } → one bounded pass: reads the facts extraction already
// stored (off-page connectors, equipment tags, aliases), applies provable
// connections, queues the rest for review, and audits system links whose
// evidence no longer holds. Returns `more: true` when there's another slice
// to run, so the caller drives it in loops and no single request approaches
// the platform's function timeout.
//
// Authority: the controller tier (isControllerRole over the held role
// collection — what is_org_controller means; DEC-35: no role list here) —
// this writes links into the controlled document web. Membership and role
// are verified server-side against the caller's bearer token; the service
// role is used only AFTER that check.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { runLinkProposers } from "@/lib/linkProposerServer";
import { workerSkillMatcher } from "@/lib/customSkillRunner";
import { memberHoldsAny } from "@/lib/roleHeld";
import { isControllerRole } from "@/lib/permissions";
import { ALL_ROLES } from "@/types/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

/** The controller tier — every role isControllerRole admits (DEC-35: the
 *  tier by its one definition, never a role list at the call site). */
const CONTROLLER_ROLES = ALL_ROLES.filter((r) => isControllerRole(r));

export async function POST(req: NextRequest) {
  let body: { orgId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }); }
  const orgId = (body.orgId ?? "").trim();
  if (!orgId) return NextResponse.json({ error: "orgId required" }, { status: 400 });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, roles, status")
    .eq("org_id", orgId).eq("uid", userData.user.id).maybeSingle();
  const role = (member as { role?: string; status?: string } | null);
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  if (!role || role.status !== "active" || !memberHoldsAny(role, CONTROLLER_ROLES)) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  }

  try {
    // LNK-6: custom-skill patterns run in a worker under a hard deadline.
    const result = await runLinkProposers(supabaseAdmin, orgId, { matcher: workerSkillMatcher() });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
