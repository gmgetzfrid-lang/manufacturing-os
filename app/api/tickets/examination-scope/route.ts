import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ticketReadScope } from "@/lib/ticketReadScope";
import { loadCapabilityPolicyStrict, policyAllows } from "@/lib/capabilityPolicy";
import { heldRoles } from "@/lib/roleHeld";
import { WorkflowEngine, ISSUING_APPROVALS, ticketResource, currentRoster, slotSignPlan } from "@/lib/workflow";
import { applySignPlan, rosterCompletion } from "@/lib/ticketRoster";
import { rowToTicket } from "@/lib/ticketTransitions";
import { flaggedRequestTypes } from "@/lib/requestTypes";
import { isDeclaredLikeInKind, declarationSignatureStands, type DeclarationSignatureRow } from "@/lib/reviewModel";
import { checkedWrite } from "@/lib/checkedWrite";
import {
  parseExaminationScopeConfig, examinationScopeConfigured, examinationScopeStatus, parseScopeValues, parseScopeWaiver,
  checkScopeValuesInput, applyScopeChanges, scopeEditorBasis, isMissingScopeTable,
  SCOPE_CLOSED_STATUSES, EXAMINATION_SCOPE_MIGRATION, EXAMINATION_WAIVER_REASON_MAX,
  type ExaminationScopeWaiver,
} from "@/lib/examinationScope";
import type { Role } from "@/types/schema";

// POST /api/tickets/examination-scope
//   { ticketId, values: { <field key>: <value> | null } }   — record / clear
//   { ticketId, waiver: { reason } }                        — record a waiver
//   { ticketId, waiver: null }                              — withdraw it
//
// drafting-flow Round G, DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE —
// GAP-102 acceptance 4 (the integrator's rulings (1) and (2) for DF-P24,
// DEC-90). The one place a request's examination data is written
// (ticket_examination_scopes, 20261266 — no client holds a write):
//   1. the caller is authenticated, an active member of the request's
//      workspace, and can read the request (AUTHZ-13's read scope); an
//      archived, closed or canceled request is not changed;
//   2. VALUES are recorded by the drafter or the engineer already in the flow
//      — the assigned drafter, the assigned engineer, a person named on an
//      engineering sign-off of the request's roster — or the assignment
//      queue that sets the class (`ticket.assign` for the request, the policy
//      read fail-closed, DEC-89 item 3); never a new role, slot or stop. Each
//      value is one of the field's own configured values (lib/
//      examinationScope.ts checkScopeValuesInput — never free text);
//   3. a WAIVER (why the request issues without the data its requirement
//      names) is recorded or withdrawn only by a person who already holds the
//      issue authority on the request now — the state machine offers them an
//      issuing approval or a roster sign-off, evaluated with the workspace's
//      own policy as the workflow route evaluates it — with a required reason
//      (≤ EXAMINATION_WAIVER_REASON_MAX). It names the fields missing and
//      enforced when it was recorded and the revision under review; the
//      workflow route honours it only for those fields and that revision;
//   4. the audit row is written FIRST (TICKET_EXAMINATION_SCOPE_SET /
//      _WAIVED / _WAIVER_WITHDRAWN — a change whose record cannot be written
//      is refused, nothing applied), then the write, compare-and-set on the
//      row's `updated_at` (a concurrent change answers 409, nothing lost);
//      a write that does not land gets a checked _NOT_APPLIED row naming the
//      attempt (EVID-12's pairing contract);
//   5. before 20261266 every read and write meets 42P01 / PGRST205: the answer
//      is 503 not_migrated and nothing is written.

interface Body { ticketId?: unknown; values?: unknown; waiver?: unknown }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_MIGRATED = { error: `Examination data can't be recorded yet (database update ${EXAMINATION_SCOPE_MIGRATION} is not applied).`, code: "not_migrated" };

async function insertAuditRowOnce(row: { id: string } & Record<string, unknown>): Promise<string | null> {
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

const memberName = (m: { display_name?: unknown; email?: unknown } | null | undefined): string | null => {
  const d = typeof m?.display_name === "string" ? m.display_name.trim() : "";
  if (d) return d;
  const e = typeof m?.email === "string" ? m.email.trim() : "";
  return e ? e.split("@")[0] : null;
};

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
  if (!UUID_RE.test(ticketId)) return NextResponse.json({ error: "ticketId is required" }, { status: 400 });
  const hasValues = body.values !== undefined;
  const hasWaiver = body.waiver !== undefined;
  if (hasValues === hasWaiver) return NextResponse.json({ error: "Send either values or a waiver." }, { status: 400 });
  let waiverReason: string | null = null;
  if (hasWaiver && body.waiver !== null) {
    const r = (body.waiver as { reason?: unknown } | null)?.reason;
    waiverReason = typeof r === "string" ? r.trim() : "";
    if (!waiverReason) return NextResponse.json({ error: "Say why this request issues without the missing examination data.", field: "reason" }, { status: 400 });
    if (waiverReason.length > EXAMINATION_WAIVER_REASON_MAX) return NextResponse.json({ error: `The reason is longer than ${EXAMINATION_WAIVER_REASON_MAX} characters.`, field: "reason" }, { status: 400 });
  }

  const { data: row, error: loadErr } = await supabaseAdmin.from("tickets").select("*").eq("id", ticketId).maybeSingle();
  if (loadErr) return NextResponse.json({ error: "Couldn't read the request — try again in a moment." }, { status: 503 });
  if (!row) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  const ticket = rowToTicket(row as Record<string, unknown>);

  const { data: member, error: memErr } = await supabaseAdmin
    .from("org_members").select("uid, role, roles, email, display_name")
    .eq("org_id", ticket.orgId).eq("uid", caller.id).eq("status", "active").maybeSingle();
  if (memErr) return NextResponse.json({ error: "Couldn't confirm your membership — try again in a moment." }, { status: 503 });
  if (!member) return NextResponse.json({ error: "Forbidden: not an active member of this workspace" }, { status: 403 });
  const scope = await ticketReadScope(supabaseAdmin, member, caller.id, {
    id: ticketId, requesterId: ticket.requesterId, assignedDrafterId: ticket.assignedDrafterId, assignedEngineerId: ticket.assignedEngineerId, watchers: ticket.watchers,
  });
  if (scope === "unknown") return NextResponse.json({ error: "Couldn't confirm you can see this request — try again in a moment." }, { status: 503 });
  if (scope === "out") return NextResponse.json({ error: "Request not found" }, { status: 404 });
  if ((row as { archived_at?: string | null }).archived_at) {
    return NextResponse.json({ error: "This request is archived; restore it from its archive before changing its examination data." }, { status: 409 });
  }
  if (SCOPE_CLOSED_STATUSES.has(String(ticket.status ?? ""))) {
    return NextResponse.json({ error: "This request is closed — its examination data is part of its record and is not changed." }, { status: 409 });
  }

  const { data: cfgRow, error: cfgErr } = await supabaseAdmin
    .from("org_configurations").select("data").eq("org_id", ticket.orgId).eq("key", "drafting").maybeSingle();
  if (cfgErr) return NextResponse.json({ error: "Couldn't read this workspace's examination data settings — try again in a moment." }, { status: 503 });
  const draftingCfg = ((cfgRow as { data?: unknown } | null)?.data ?? null) as Record<string, unknown> | null;
  const config = parseExaminationScopeConfig(draftingCfg);
  if (!examinationScopeConfigured(config)) {
    return NextResponse.json({ error: "This workspace records no examination data (Admin → Request forms → Examination data)." }, { status: 409 });
  }

  const m = member as { uid: string; role: string | null; roles: string[] | null; email: string | null; display_name?: string | null };
  const roles = heldRoles(m);
  const loaded = await loadCapabilityPolicyStrict(ticket.orgId, supabaseAdmin);
  if (!loaded.ok) return NextResponse.json({ error: "Couldn't read this workspace's permissions — try again in a moment." }, { status: 503 });

  // ── Who may act ────────────────────────────────────────────────────────
  let authority: string;
  if (hasValues) {
    const queue = policyAllows(loaded.policy, "ticket.assign", m.role, roles, caller.id, ticketResource(ticket));
    const basis = scopeEditorBasis(ticket, caller.id, queue);
    if (!basis) {
      return NextResponse.json({ error: "The request's drafter or engineer records its examination data (or whoever runs the assignment queue)." }, { status: 403 });
    }
    authority = basis;
  } else {
    // A person who already holds the issue authority on this request now:
    // the state machine offers them an issuing approval or a roster
    // sign-off, under the workspace's own policy (as the workflow route).
    const evalTicket = { ...ticket };
    if (evalTicket.engineeringRequired === false && isDeclaredLikeInKind(evalTicket)) {
      const sigId = evalTicket.likeInKindSignatureId ?? "";
      const { data: dsig, error: dsigErr } = UUID_RE.test(sigId)
        ? await supabaseAdmin.from("e_signatures").select("id, org_id, resource_type, resource_id, signer_user_id").eq("id", sigId).maybeSingle()
        : { data: null, error: null };
      if (dsigErr) return NextResponse.json({ error: "This request's like-in-kind declaration could not be checked (it decides who may issue). Try again in a moment." }, { status: 503 });
      if (!declarationSignatureStands(dsig as DeclarationSignatureRow | null, { id: ticketId, orgId: ticket.orgId, likeInKindDeclaredBy: ticket.likeInKindDeclaredBy })) evalTicket.engineeringRequired = true;
    }
    const { count: memberCount, error: countErr } = await supabaseAdmin
      .from("org_members").select("uid", { count: "exact", head: true }).eq("org_id", ticket.orgId).eq("status", "active");
    if (countErr) return NextResponse.json({ error: "This workspace's members could not be counted (it decides who may issue). Try again in a moment." }, { status: 503 });
    let requesterRoles: string[] = [];
    if (ticket.requesterId) {
      const { data: reqMember } = await supabaseAdmin.from("org_members").select("role, roles")
        .eq("org_id", ticket.orgId).eq("uid", ticket.requesterId).eq("status", "active").maybeSingle();
      requesterRoles = heldRoles(reqMember as { role?: unknown; roles?: unknown } | null);
    }
    const flaggedClose = flaggedRequestTypes(draftingCfg, "closeWithoutReview");
    const actions = WorkflowEngine.getActions(evalTicket, (m.role as Role) ?? "Viewer", caller.id, loaded.policy, {
      userRoles: roles as Role[],
      activeMemberCount: memberCount ?? 0,
      engineeringFirstTypes: flaggedRequestTypes(draftingCfg, "engineeringFirst"),
      closeWithoutReviewTypes: flaggedClose.length > 0 ? flaggedClose : ["RFI"],
      requesterRoles,
    });
    // Fix pass (ruling (2)): a roster sign-off is issue authority only when
    // the caller's own sign-off would COMPLETE the review (the preview the
    // workflow route's gate computes) — a peer checker whose sign-off never
    // issues may not waive the requirement for the whole issue.
    const sodActive = (memberCount ?? 0) >= 3;
    const signOffIssues = (): boolean => {
      const r = currentRoster(ticket);
      const p = r ? slotSignPlan(r, ticket, caller.id, sodActive, Date.now()) : null;
      return !!r && !!p && p.fillable.length > 0
        && rosterCompletion(applySignPlan(r, p, { uid: caller.id, name: null }, "examination-scope-preview", new Date().toISOString()), { sodActive, drafterId: ticket.assignedDrafterId }).complete;
    };
    const issuing = actions.filter((a) => !a.disabledReason && (ISSUING_APPROVALS.has(a.action) || (a.action === "sign_slot" && signOffIssues())));
    if (issuing.length === 0) {
      return NextResponse.json({ error: "Only someone who can issue this request now may record why it issues without its examination data." }, { status: 403 });
    }
    authority = `issue_authority:${issuing.map((a) => a.action).join(",")}`;
  }

  // ── The request's current examination data ─────────────────────────────
  const { data: cur, error: curErr } = await supabaseAdmin
    .from("ticket_examination_scopes").select("ticket_id, field_values, waiver, updated_at").eq("ticket_id", ticketId).maybeSingle();
  if (curErr) return isMissingScopeTable(curErr) ? NextResponse.json(NOT_MIGRATED, { status: 503 }) : NextResponse.json({ error: "Couldn't read this request's examination data — try again in a moment." }, { status: 503 });
  const current = cur as { field_values?: unknown; waiver?: unknown; updated_at?: string | null } | null;
  const values = parseScopeValues(current?.field_values);
  const waiver = parseScopeWaiver(current?.waiver);
  const nowIso = new Date().toISOString();
  const who = { uid: caller.id, name: memberName(m) };

  let nextValues = values;
  let nextWaiver: ExaminationScopeWaiver | null = waiver;
  let action: string;
  let details: Record<string, unknown>;
  if (hasValues) {
    const checked = checkScopeValuesInput(config, body.values);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
    const applied = applyScopeChanges(values, checked.changes, who, nowIso);
    if (applied.changed.length === 0) return NextResponse.json({ ok: true, unchanged: true, values, waiver });
    nextValues = applied.values;
    action = "TICKET_EXAMINATION_SCOPE_SET";
    details = { changed: applied.changed.map((k) => ({ field: k, from: values[k]?.value ?? null, to: nextValues[k]?.value ?? null })) };
  } else if (waiverReason) {
    const status = examinationScopeStatus(config, ticket, values, draftingCfg);
    if (status.blocking.length === 0) {
      return NextResponse.json({ error: "Nothing this request needs before it can issue is missing — there is nothing to waive." }, { status: 409 });
    }
    nextWaiver = { reason: waiverReason, by: caller.id, ...(who.name ? { byName: who.name } : {}), at: nowIso, fields: status.blocking.map((b) => b.key), rev: ticket.deliverableRev ?? null };
    action = "TICKET_EXAMINATION_SCOPE_WAIVED";
    details = { waiver: nextWaiver, ...(waiver ? { replaces: waiver } : {}) };
  } else {
    if (!waiver) return NextResponse.json({ ok: true, unchanged: true, values, waiver: null });
    nextWaiver = null;
    action = "TICKET_EXAMINATION_SCOPE_WAIVER_WITHDRAWN";
    details = { withdrawn: waiver };
  }

  const auditId = crypto.randomUUID();
  const auditErr = await insertAuditRowOnce({
    id: auditId, action,
    resource_id: ticketId, resource_type: "ticket", org_id: ticket.orgId,
    user_id: caller.id, user_email: m.email ?? caller.email ?? null, user_role: m.role ?? null,
    details: { ...details, authority, deliverable_rev: ticket.deliverableRev ?? null, recordedBeforeApply: true },
  });
  if (auditErr) {
    console.error(`[examination-scope] AUDIT ROW NOT WRITTEN for ticket ${ticketId}: ${auditErr} — nothing applied`);
    return NextResponse.json({ error: "The change was not applied: its audit record could not be written. Try again in a moment.", code: "audit_unwritable", applied: false }, { status: 500 });
  }
  const notApplied = async (reason: "conflict" | "write_failed", error?: string): Promise<boolean> => {
    const err = await insertAuditRowOnce({
      id: crypto.randomUUID(), action: `${action}_NOT_APPLIED`,
      resource_id: ticketId, resource_type: "ticket", org_id: ticket.orgId,
      user_id: caller.id, user_email: m.email ?? caller.email ?? null, user_role: m.role ?? null,
      details: { attempt: auditId, reason, ...(error ? { error } : {}) },
    });
    if (err) console.error(`[examination-scope] ${action}_NOT_APPLIED row not written for attempt ${auditId}: ${err}`);
    return !err;
  };

  const patch = { field_values: nextValues, waiver: nextWaiver, updated_at: nowIso, updated_by: caller.id };
  const write = current
    ? await checkedWrite(supabaseAdmin.from("ticket_examination_scopes").update(patch).eq("ticket_id", ticketId).eq("updated_at", current.updated_at ?? "").select("ticket_id"))
    : await checkedWrite(supabaseAdmin.from("ticket_examination_scopes").insert({ ticket_id: ticketId, org_id: ticket.orgId, ...patch }).select("ticket_id"));
  if (!write.ok) {
    const conflict = write.code === "refused" || write.pgCode === "23505";
    if (!conflict && isMissingScopeTable({ code: write.pgCode, message: write.error })) {
      await notApplied("write_failed", "not_migrated");
      return NextResponse.json(NOT_MIGRATED, { status: 503 });
    }
    const recorded = await notApplied(conflict ? "conflict" : "write_failed", conflict ? undefined : write.error);
    return conflict
      ? NextResponse.json({ error: "Someone else changed this request's examination data at the same moment — nothing was changed. Reload and try again.", code: "conflict", ...(recorded ? {} : { notAppliedUnrecorded: true }) }, { status: 409 })
      : NextResponse.json({ error: `The change was not applied: ${write.error}`, ...(recorded ? {} : { notAppliedUnrecorded: true }) }, { status: 500 });
  }
  return NextResponse.json({ ok: true, values: nextValues, waiver: nextWaiver, updatedAt: nowIso });
}
