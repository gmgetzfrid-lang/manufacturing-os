// /api/admin/sla-escalation — drafting-flow Round G, DF-P22 fix pass: the
// escalation tier above the queue owners (FRIC-1 done-when 2 / GAP-106),
// behind an ADMIN-ONLY write.
//
//   GET ?orgId=                  the setting, for anyone the Request forms
//                                surface admits (lib/adminGate.ts, "requests")
//                                — { config, error, canEdit }.
//   PUT { orgId, config }        Admin only (by the held collection): config
//                                is { contact: { kind: "member", uid } |
//                                { kind: "role", role }, periodDays } or null
//                                (off).
//
// Why a route of its own: the queue owners the tier sits above — the
// DraftingSupervisor holders (lib/ticketRouting.ts queuePool) — edit the
// request forms (DRAFTING_CONFIG_EDITORS). If the tier rode that
// configuration they could switch off, or point at themselves, the
// escalation of their own queue, silently. So the value lives in its own
// org_configurations key (lib/ticketSla.ts SLA_ESCALATION_KEY), whose every
// client write 20261264 refuses; this route writes it as the service role
// after the Admin check — the audit row FIRST (TICKET_SLA_ESCALATION_SET,
// details.recordedBeforeApply, the old and the new value), a
// TICKET_SLA_ESCALATION_SET_NOT_APPLIED row when the write then fails — and
// tells the people the previous contact named who are no longer named
// (a bell row each; best effort, said in the answer when it fails).
//
// A contact must be able to read the requests it is told of: a Contractor
// role, or a Contractor-only member, is refused (20261166 narrows their read
// to their own requests; the escalation pass also filters per request).

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminSurface } from "@/lib/adminGate";
import { memberHoldsAny } from "@/lib/roleHeld";
import { isContractorOnly } from "@/lib/ticketReadScope";
import { notifyBatchWithReason } from "@/lib/inAppNotifications";
import { ALL_ROLES } from "@/types/schema";
import {
  SLA_ESCALATION_KEY, SLA_ESCALATION_SET_AUDIT, parseSlaEscalation, escalationRecipients, type SlaEscalationConfig,
} from "@/lib/ticketSla";

export const runtime = "nodejs";

const ADMIN_ONLY = "Only an Admin can change who hears about overdue requests — the queue owners it sits above cannot switch it off or point it at themselves.";

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const same = (a: SlaEscalationConfig | null, b: SlaEscalationConfig | null) => JSON.stringify(a) === JSON.stringify(b);

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId") || "";
  const actor = await authorizeAdminSurface(req, orgId, "requests");
  if ("error" in actor) return bad(actor.error, actor.status);
  const { data, error } = await actor.admin.from("org_configurations").select("data")
    .eq("org_id", orgId).eq("key", SLA_ESCALATION_KEY).maybeSingle();
  if (error) return bad(`Couldn't read the escalation setting: ${error.message}`, 503);
  const parsed = parseSlaEscalation((data as { data?: unknown } | null)?.data ?? null);
  return NextResponse.json({
    config: parsed.ok ? parsed.config : null,
    error: parsed.ok ? null : parsed.error,
    canEdit: memberHoldsAny({ roles: actor.roles }, ["Admin"]),
  });
}

export async function PUT(req: NextRequest) {
  let body: { orgId?: unknown; config?: unknown };
  try { body = await req.json(); } catch { return bad("Invalid JSON", 400); }
  const orgId = typeof body.orgId === "string" ? body.orgId : "";
  const actor = await authorizeAdminSurface(req, orgId, "requests");
  if ("error" in actor) return bad(actor.error, actor.status);
  if (!memberHoldsAny({ roles: actor.roles }, ["Admin"])) return bad(ADMIN_ONLY, 403);

  const parsed = parseSlaEscalation(body.config ?? null);
  if (!parsed.ok) return bad(`Not saved: ${parsed.error}.`, 400);
  const next = parsed.config;

  // Who is active now (the contact must be someone who can be told, and
  // who reads the workspace's requests).
  const { data: memberRows, error: mErr } = await actor.admin.from("org_members")
    .select("uid, role, roles").eq("org_id", orgId).eq("status", "active");
  if (mErr) return bad(`Couldn't check the workspace's members: ${mErr.message}`, 503);
  const members = ((memberRows as Array<{ uid: string; role?: string | null; roles?: string[] | null }> | null) ?? [])
    .map((m) => ({ uid: m.uid, role: m.role ?? null, roles: [...new Set([...(m.roles ?? []), ...(m.role ? [m.role] : [])])] }));
  if (next?.contact.kind === "role" && !(ALL_ROLES as readonly string[]).includes(next.contact.role)) {
    return bad(`Not saved: "${next.contact.role}" is not a role.`, 400);
  }
  if (next?.contact.kind === "member") {
    const m = members.find((x) => x.uid === (next.contact as { uid: string }).uid);
    if (!m) return bad("Not saved: that person is not an active member of this workspace.", 400);
    if (isContractorOnly(m)) return bad("Not saved: a Contractor-only member reads only their own requests, so they cannot be the escalation contact.", 400);
  }

  const { data: priorRow, error: pErr } = await actor.admin.from("org_configurations").select("data")
    .eq("org_id", orgId).eq("key", SLA_ESCALATION_KEY).maybeSingle();
  if (pErr) return bad(`Couldn't read the current setting: ${pErr.message}`, 503);
  const priorRaw = (priorRow as { data?: unknown } | null)?.data ?? null;
  const priorParsed = parseSlaEscalation(priorRaw);
  const prior = priorParsed.ok ? priorParsed.config : null;
  if (priorParsed.ok && same(prior, next)) return NextResponse.json({ ok: true, unchanged: true, config: next });

  // The audit row FIRST (who, when, the old value and the new).
  const auditId = crypto.randomUUID();
  const auditRow = {
    id: auditId, action: SLA_ESCALATION_SET_AUDIT, resource_type: "org_configuration", resource_id: orgId, org_id: orgId,
    user_id: actor.userId, user_email: actor.email, user_role: "Admin",
    details: { key: SLA_ESCALATION_KEY, before: priorRaw, after: next, switchedOff: next === null, recordedBeforeApply: true },
  };
  const { error: aErr } = await actor.admin.from("audit_logs").insert(auditRow);
  if (aErr) return bad(`Not saved: the change could not be recorded on the audit trail (${aErr.message}).`, 500);

  const write = next === null
    ? actor.admin.from("org_configurations").delete().eq("org_id", orgId).eq("key", SLA_ESCALATION_KEY)
    : actor.admin.from("org_configurations").upsert({ org_id: orgId, key: SLA_ESCALATION_KEY, data: next }, { onConflict: "org_id,key" });
  const { error: wErr } = await write;
  if (wErr) {
    const { error: naErr } = await actor.admin.from("audit_logs").insert({
      ...auditRow, id: crypto.randomUUID(), action: `${SLA_ESCALATION_SET_AUDIT}_NOT_APPLIED`,
      details: { attempt: auditId, reason: "write_failed", error: wErr.message },
    });
    return bad(`Not saved: ${wErr.message}${naErr ? ` (and the not-applied record was refused: ${naErr.message})` : ""}.`, 500);
  }

  // Tell the people the previous contact named who are no longer named.
  let warning: string | null = null;
  if (prior) {
    const before = escalationRecipients(prior.contact, members);
    const after = new Set(next ? escalationRecipients(next.contact, members) : []);
    const dropped = before.filter((u) => !after.has(u) && u !== actor.userId);
    if (dropped.length > 0) {
      const { error: nErr } = await notifyBatchWithReason(dropped.map((uid) => ({
        orgId, userId: uid, kind: "ticket_status" as const,
        title: next ? "You are no longer the escalation contact for overdue requests" : "Escalation of overdue requests was switched off",
        body: next
          ? `${actor.email} changed who hears about requests still overdue after their queue was told. You will not be told of them any more.`
          : `${actor.email} switched off the escalation of requests still overdue after their queue was told. Nobody above the queue is told of them now.`,
        link: "/admin/requests", resourceType: "org_configuration", resourceId: orgId, actorUserId: actor.userId, actorName: actor.email,
        metadata: { action: "sla_escalation_contact_changed", audit: auditId, switchedOff: next === null },
      })), actor.admin as never);
      if (nErr) warning = `Saved, but the previous contact could not be told on the bell: ${nErr}`;
    }
  }
  return NextResponse.json({ ok: true, config: next, audit: auditId, ...(warning ? { warning } : {}) });
}
