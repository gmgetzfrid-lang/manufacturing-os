// /api/tickets/preauthorizations — drafting-flow Round G, DF-P22: GAP-109
// mechanism 2, STANDING PRE-AUTHORIZATION (DEC-90 ruling (2) for DF-P22).
//
//   GET    ?orgId=…            the caller's own records, and — for an Admin
//                              (by the held collection) — everyone's in the
//                              workspace.
//   POST   { orgId, id, libraryId?, requestType?, workClass?, expiresAt, signatureId }
//                              record the CALLER's own pre-authorization. The
//                              e-signature was minted by /api/signatures/sign
//                              for this record's id (resource type
//                              ticket_preauthorization), by the caller, as an
//                              acknowledgement of exactly the statement
//                              lib/ticketPreauthorization.ts composes from
//                              what is recorded (the library named as the
//                              workspace names it), recently. Nobody records
//                              one on another person's behalf.
//   PATCH  { orgId, id, action: "revoke", reason? }
//                              revoke — by the person who recorded it, or an
//                              Admin — effective immediately: the next review
//                              no longer uses it; requests that already did
//                              keep naming it (their history and audit rows).
//
// Every write is the service role's, after its checks (20261264 grants no
// client a write), audit row FIRST (TICKET_PREAUTHORIZATION_RECORDED /
// _REVOKED) and a _NOT_APPLIED row when the write then fails. Before
// 20261264 is pasted: 503 with the reason, nothing written.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { memberHoldsAny } from "@/lib/roleHeld";
import {
  PREAUTH_AUDIT, PREAUTH_MIGRATION, preauthDraftRefusal, preauthFromRow, preauthSignatureRefusal, preauthorizationStatement, isMissingPreauthTable,
  type PreauthSignatureRow,
} from "@/lib/ticketPreauthorization";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_MIGRATED = { error: `Standing pre-authorizations are not available yet (database update ${PREAUTH_MIGRATION} is not applied).`, code: "not_migrated" };
const bad = (error: string, status: number, extra?: Record<string, unknown>) => NextResponse.json({ error, ...(extra ?? {}) }, { status });
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

async function callerOf(req: NextRequest): Promise<{ id: string } | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  return error || !user ? null : { id: user.id };
}

/** The caller's ACTIVE membership in the workspace, or why not. */
async function membershipOf(orgId: string, uid: string): Promise<{ ok: true; member: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const { data, error } = await supabaseAdmin.from("org_members").select("uid, role, roles, display_name, email, status")
    .eq("org_id", orgId).eq("uid", uid).maybeSingle();
  if (error) return { ok: false, status: 503, error: "Couldn't check your membership — try again in a moment." };
  const m = data as Record<string, unknown> | null;
  if (!m || m.status !== "active") return { ok: false, status: 403, error: "You are not an active member of this workspace." };
  return { ok: true, member: m };
}

async function insertAudit(row: Record<string, unknown>): Promise<string | null> {
  const attempt = async (): Promise<string | null> => {
    try {
      const { error } = await supabaseAdmin.from("audit_logs").insert(row);
      if (!error || (error as { code?: string }).code === "23505") return null;
      return error.message || "insert refused";
    } catch (e) {
      return (e as Error)?.message ?? String(e);
    }
  };
  return (await attempt()) && (await attempt());
}

export async function GET(req: NextRequest) {
  const caller = await callerOf(req);
  if (!caller) return bad("Unauthorized", 401);
  const orgId = str(req.nextUrl.searchParams.get("orgId"));
  if (!UUID_RE.test(orgId)) return bad("orgId is required", 400);
  const mem = await membershipOf(orgId, caller.id);
  if (!mem.ok) return bad(mem.error, mem.status);
  const admin = memberHoldsAny(mem.member, ["Admin"]);
  let q = supabaseAdmin.from("ticket_preauthorizations").select("*").eq("org_id", orgId);
  if (!admin) q = q.eq("grantor_id", caller.id);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
  if (error) return isMissingPreauthTable(error) ? NextResponse.json(NOT_MIGRATED, { status: 503 }) : bad("Couldn't read the standing pre-authorizations — try again in a moment.", 503);
  return NextResponse.json({ ok: true, admin, records: ((data as Array<Record<string, unknown>> | null) ?? []).map(preauthFromRow) });
}

export async function POST(req: NextRequest) {
  const caller = await callerOf(req);
  if (!caller) return bad("Unauthorized", 401);
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return bad("Invalid JSON body", 400); }
  const orgId = str(body.orgId), id = str(body.id), signatureId = str(body.signatureId);
  const libraryId = str(body.libraryId) || null, requestType = str(body.requestType) || null, workClass = str(body.workClass) || null;
  const expiresAt = str(body.expiresAt);
  if (!UUID_RE.test(orgId) || !UUID_RE.test(id) || !UUID_RE.test(signatureId)) return bad("orgId, id and signatureId are required", 400);
  const now = Date.now();
  const refusal = preauthDraftRefusal({ libraryId, requestType, workClass, expiresAt }, now);
  if (refusal) return bad(refusal, 400);
  const mem = await membershipOf(orgId, caller.id);
  if (!mem.ok) return bad(mem.error, mem.status);

  // The table first (a 42P01 / PGRST205 is "not pasted": nothing written).
  const { error: probeErr } = await supabaseAdmin.from("ticket_preauthorizations").select("id").eq("id", id).limit(1);
  if (probeErr) return isMissingPreauthTable(probeErr) ? NextResponse.json(NOT_MIGRATED, { status: 503 }) : bad("Couldn't check the standing pre-authorizations — try again in a moment.", 503);

  // The library, as the workspace names it (the statement names it so).
  let libraryName: string | null = null;
  if (libraryId) {
    const { data: lib, error: libErr } = await supabaseAdmin.from("libraries").select("id, name, org_id").eq("id", libraryId).maybeSingle();
    if (libErr) return bad("Couldn't check the library — try again in a moment.", 503);
    const l = lib as { id?: string; name?: string | null; org_id?: string } | null;
    if (!l || l.org_id !== orgId) return bad("That library is not one this workspace has.", 400, { field: "libraryId" });
    libraryName = l.name ?? null;
  }
  const statement = preauthorizationStatement({ libraryId, libraryName, requestType, workClass, expiresAt });

  const { data: sig, error: sigErr } = await supabaseAdmin.from("e_signatures")
    .select("id, org_id, resource_type, resource_id, signer_user_id, intent, statement, signed_at").eq("id", signatureId).maybeSingle();
  if (sigErr) return bad("Couldn't check the signature — try again in a moment.", 503);
  const sigRefusal = preauthSignatureRefusal(sig as PreauthSignatureRow | null, { orgId, id, grantorId: caller.id, statement, now });
  if (sigRefusal) return bad(sigRefusal, 400, { field: "signature" });

  const grantorName = (typeof mem.member.display_name === "string" && mem.member.display_name.trim()) || (typeof mem.member.email === "string" ? mem.member.email.split("@")[0] : null);
  const auditId = crypto.randomUUID();
  const auditRow = {
    id: auditId, action: PREAUTH_AUDIT.recorded, resource_type: "ticket_preauthorization", resource_id: id, org_id: orgId,
    user_id: caller.id, user_email: typeof mem.member.email === "string" ? mem.member.email : null,
    details: { preauthorizationId: id, signatureId, scope: { libraryId, libraryName, requestType, workClass }, expiresAt, statement, recordedBeforeApply: true },
  };
  const aErr = await insertAudit(auditRow);
  if (aErr) return bad(`The standing pre-authorization was not recorded: its audit row could not be written (${aErr}).`, 503);
  const { error: insErr } = await supabaseAdmin.from("ticket_preauthorizations").insert({
    id, org_id: orgId, grantor_id: caller.id, grantor_name: grantorName, library_id: libraryId, request_type: requestType, work_class: workClass,
    statement, signature_id: signatureId, expires_at: expiresAt,
  });
  if (insErr) {
    await insertAudit({ ...auditRow, id: crypto.randomUUID(), action: `${PREAUTH_AUDIT.recorded}_NOT_APPLIED`, details: { attempt: auditId, error: insErr.message } });
    if ((insErr as { code?: string }).code === "23505") return bad("This standing pre-authorization is already recorded.", 409);
    return bad(`The standing pre-authorization was not recorded: ${insErr.message}`, 500);
  }
  return NextResponse.json({ ok: true, id, statement });
}

export async function PATCH(req: NextRequest) {
  const caller = await callerOf(req);
  if (!caller) return bad("Unauthorized", 401);
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return bad("Invalid JSON body", 400); }
  const orgId = str(body.orgId), id = str(body.id);
  const reason = str(body.reason).slice(0, 500) || null;
  if (!UUID_RE.test(orgId) || !UUID_RE.test(id) || body.action !== "revoke") return bad("orgId, id and action: \"revoke\" are required", 400);
  const mem = await membershipOf(orgId, caller.id);
  if (!mem.ok) return bad(mem.error, mem.status);
  const { data, error } = await supabaseAdmin.from("ticket_preauthorizations").select("*").eq("id", id).eq("org_id", orgId).maybeSingle();
  if (error) return isMissingPreauthTable(error) ? NextResponse.json(NOT_MIGRATED, { status: 503 }) : bad("Couldn't read the standing pre-authorization — try again in a moment.", 503);
  if (!data) return bad("Standing pre-authorization not found", 404);
  const p = preauthFromRow(data as Record<string, unknown>);
  const admin = memberHoldsAny(mem.member, ["Admin"]);
  if (p.grantorId !== caller.id && !admin) return bad("Only the person who recorded it, or an Admin, can revoke a standing pre-authorization.", 403);
  if (p.revokedAt) return NextResponse.json({ ok: true, alreadyRevoked: true, revokedAt: p.revokedAt });
  const nowIso = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const auditRow = {
    id: auditId, action: PREAUTH_AUDIT.revoked, resource_type: "ticket_preauthorization", resource_id: id, org_id: orgId,
    user_id: caller.id, user_email: typeof mem.member.email === "string" ? mem.member.email : null,
    details: { preauthorizationId: id, grantorId: p.grantorId, byGrantor: p.grantorId === caller.id, reason, revokedAt: nowIso, recordedBeforeApply: true },
  };
  const aErr = await insertAudit(auditRow);
  if (aErr) return bad(`The standing pre-authorization was not revoked: its audit row could not be written (${aErr}).`, 503);
  const { data: done, error: uErr } = await supabaseAdmin.from("ticket_preauthorizations")
    .update({ revoked_at: nowIso, revoked_by: caller.id, revoke_reason: reason })
    .eq("id", id).eq("org_id", orgId).is("revoked_at", null).select("id");
  if (uErr || !Array.isArray(done) || done.length === 0) {
    await insertAudit({ ...auditRow, id: crypto.randomUUID(), action: `${PREAUTH_AUDIT.revoked}_NOT_APPLIED`, details: { attempt: auditId, ...(uErr ? { error: uErr.message } : { reason: "already_revoked" }) } });
    return uErr ? bad(`The standing pre-authorization was not revoked: ${uErr.message}`, 500) : NextResponse.json({ ok: true, alreadyRevoked: true });
  }
  return NextResponse.json({ ok: true, revokedAt: nowIso });
}
