// lib/estate/serverAuth.ts — who is calling, and are they in this org?
//
// Every estate route verifies the bearer token and the caller's membership
// BEFORE touching the service-role client. Roles are returned so a route can
// require document control for writes while letting any member read.

import type { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export interface Caller { userId: string; email: string | null; role: string; orgId: string }

export async function requireMember(req: NextRequest, orgId: string, roles?: string[]): Promise<{ caller?: Caller; error?: { status: number; message: string } }> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return { error: { status: 401, message: "Unauthorized" } };
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (error || !user) return { error: { status: 401, message: "Unauthorized" } };
  if (!orgId) return { error: { status: 400, message: "orgId is required" } };
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role, status").eq("org_id", orgId).eq("uid", user.id).maybeSingle();
  const m = member as { role?: string; status?: string } | null;
  if (!m || m.status !== "active") return { error: { status: 403, message: "Not a member of this workspace" } };
  if (roles && !roles.includes(m.role ?? "")) return { error: { status: 403, message: "Document control only" } };
  return { caller: { userId: user.id, email: user.email ?? null, role: m.role ?? "", orgId } };
}
