// POST /api/package-returns/codes  { projectId, keys: string[] }
//
// The codes printed as each package's cover QR. Signed in, and on the
// project (owner, member, or Admin / Doc Control). Makes the project's
// "printed packages" returns link the first time (no expiry, turned off from
// the Intake tab like any link).

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { packageCode, RETURNS_PURPOSE } from "@/lib/packageReturnsServer";

export const runtime = "nodejs";

const PRINTED = "Printed packages";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const { data: { user } } = await supabaseAdmin.auth.getUser(auth.slice(7));
  if (!user) return NextResponse.json({ error: "Sign in again." }, { status: 401 });

  let body: { projectId?: string; keys?: unknown } = {};
  try { body = await req.json(); } catch { /* checked below */ }
  const projectId = String(body.projectId ?? "");
  const keys = Array.isArray(body.keys) ? body.keys.map(String).filter((k) => k && k.length <= 80).slice(0, 500) : [];
  if (!/^[0-9a-f-]{36}$/i.test(projectId) || !keys.length) return NextResponse.json({ error: "Which project and packages?" }, { status: 400 });

  const { data: project } = await supabaseAdmin.from("projects").select("id, org_id, owner_user_id").eq("id", projectId).maybeSingle();
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  const orgId = String(project.org_id);
  const [{ data: member }, { data: pm }] = await Promise.all([
    supabaseAdmin.from("org_members").select("role, roles").eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle(),
    supabaseAdmin.from("project_members").select("user_id").eq("project_id", projectId).eq("user_id", user.id).maybeSingle(),
  ]);
  if (!member) return NextResponse.json({ error: "Not a member of this workspace." }, { status: 403 });
  const roles = [String(member.role), ...((member.roles as string[] | null) ?? [])];
  const onProject = !!pm || String(project.owner_user_id ?? "") === user.id || roles.includes("Admin") || roles.includes("DocCtrl");
  if (!onProject) return NextResponse.json({ error: "You're not on this project." }, { status: 403 });

  // The project's printed-packages link: made once.
  let { data: link } = await supabaseAdmin.from("project_intake_links").select("id, revoked_at")
    .eq("project_id", projectId).eq("purpose", RETURNS_PURPOSE).eq("company_name", PRINTED).is("revoked_at", null)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!link) {
    const { data: made, error } = await supabaseAdmin.from("project_intake_links").insert({
      org_id: orgId, project_id: projectId, token: randomBytes(24).toString("base64url"),
      company_name: PRINTED, purpose: RETURNS_PURPOSE, allow_auto_supersede: false, created_by: user.id,
    }).select("id, revoked_at").single();
    if (error || !made) return NextResponse.json({ error: `Couldn't make the returns link: ${error?.message ?? "unknown"}` }, { status: 500 });
    link = made;
  }
  const linkId = String(link.id);
  return NextResponse.json({ codes: Object.fromEntries(keys.map((k) => [k, packageCode(linkId, k)])) });
}
