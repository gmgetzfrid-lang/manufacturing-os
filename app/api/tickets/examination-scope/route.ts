import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ticketReadScope } from "@/lib/ticketReadScope";
import { loadCapabilityPolicyStrict, policyAllows, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { heldRoles } from "@/lib/roleHeld";
import { ticketResource } from "@/lib/workflow";
import { issueAuthorityNow } from "@/lib/workflowAuthority";
import { rowToTicket } from "@/lib/ticketTransitions";
import { checkedWrite } from "@/lib/checkedWrite";
import {
  parseExaminationScopeConfig, examinationScopeConfigured, examinationScopeStatus, parseScopeValues, parseScopeWaiver,
  checkScopeValuesInput, applyScopeChanges, checkScopeWrite, scopePhase, isMissingScopeTable, examinationScopeHistoryEntry,
  SCOPE_CLOSED_STATUSES, SCOPE_ISSUED_STATUSES, EXAMINATION_SCOPE_MIGRATION, EXAMINATION_WAIVER_REASON_MAX,
  type ExaminationScopeConfig, type ExaminationScopeWaiver,
} from "@/lib/examinationScope";
import type { Ticket } from "@/types/schema";

// POST /api/tickets/examination-scope
//   { ticketId, values: { <field key>: <value> | null } }   — record / clear
//   { ticketId, waiver: { reason } }                        — record a waiver
//   { ticketId, waiver: null }                              — withdraw it
// GET  /api/tickets/examination-scope?ticketId=…            — { mayWaive }
//
// drafting-flow Round G, DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE —
// GAP-102 acceptance 4 (the integrator's rulings (1) and (2) for DF-P24,
// DEC-90). The one place a request's examination data is written
// (ticket_examination_scopes, 20261266 — no client holds a write):
//   1. the caller is authenticated, an active member of the request's
//      workspace, and can read the request (AUTHZ-13's read scope); an
//      archived, closed or canceled request is not changed;
//   2. VALUES (merge-time fix pass — lib/examinationScope.ts checkScopeWrite /
//      scopeFieldRight decide, per field, from where the request stands):
//      * before review — the drafter or the engineer already in the flow
//        (the assigned drafter, the assigned engineer, a person named on an
//        engineering sign-off of the roster) or the assignment queue
//        (`ticket.assign` for the request, the policy read fail-closed,
//        DEC-89 item 3) record, change or clear; the requester (second fix
//        pass, GAP-102 acceptance 1) FILLS an empty field, and changes or
//        clears only a value they recorded themselves — never one someone
//        else recorded;
//      * in review (PENDING_REVIEW, PENDING_FINAL_APPROVAL) — only the
//        assigned engineer of record; each change is also put on the
//        request's history, old → new;
//      * after issue (PENDING_IFC / FINAL_DRAFT) — no value is changed or
//        cleared; a field still MISSING may be filled by the drafter, the
//        engineer or the queue, marked `afterIssue` ("completed after
//        issue", for the revision issued) and put on the history; it
//        re-opens nothing.
//      Each value is one of the field's own configured values (lib/
//      examinationScope.ts checkScopeValuesInput — never free text);
//   3. a WAIVER (why the request issues without the data its requirement
//      names) is recorded or withdrawn only by a person the workflow route
//      would accept an issuing act from now — merge-time fix pass: decided
//      by lib/workflowAuthority.ts issueAuthorityNow, built on the SAME
//      engine context, member-count rule and TIER-5 refusal the workflow
//      route uses (one shared helper, so the two always agree) — with a
//      required reason (≤ EXAMINATION_WAIVER_REASON_MAX). It names the
//      fields missing and enforced when it was recorded and the revision
//      under review; the workflow route honours it only for those fields and
//      that revision. Not once the request has issued (409 `issued`). The
//      GET answers whether the caller may (the request page shows the
//      waiver control only then);
//   4. the audit row is written FIRST (TICKET_EXAMINATION_SCOPE_SET /
//      _WAIVED / _WAIVER_WITHDRAWN — a change whose record cannot be written
//      is refused, nothing applied), then the write, compare-and-set on the
//      row's `updated_at` (a concurrent change answers 409, nothing lost);
//      a write that does not land gets a checked _NOT_APPLIED row naming the
//      attempt (EVID-12's pairing contract). A change in review, or a fill
//      after issue, then appends its history line — a bookkeeping append
//      that does not change last_modified (compare-and-set on the value
//      read, read again and tried once more — the deliverable-reference
//      route's rule); if it cannot be written the answer says so
//      (`historyNotWritten`) and the audit row stays the durable record;
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

type Member = { uid: string; role: string | null; roles: string[] | null; email: string | null; display_name?: string | null };
type Loaded = {
  caller: { id: string; email?: string | null };
  row: Record<string, unknown>;
  ticket: Ticket;
  m: Member;
  roles: string[];
  draftingCfg: Record<string, unknown> | null;
  config: ExaminationScopeConfig;
  policy: CapabilityPolicy;
};

async function authenticate(req: NextRequest): Promise<{ id: string; email?: string | null } | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  return authError || !caller ? null : { id: caller.id, email: caller.email ?? null };
}

/** The checks every call makes (1. above), the workspace's configuration
 *  and its policy. `mode` "get" answers mayWaive false where a POST would
 *  refuse for the request's state. */
async function load(caller: { id: string; email?: string | null }, ticketId: string, mode: "post" | "get"): Promise<{ ok: true; v: Loaded } | { ok: false; res: NextResponse }> {
  const fail = (res: NextResponse) => ({ ok: false as const, res });

  const { data: row, error: loadErr } = await supabaseAdmin.from("tickets").select("*").eq("id", ticketId).maybeSingle();
  if (loadErr) return fail(NextResponse.json({ error: "Couldn't read the request — try again in a moment." }, { status: 503 }));
  if (!row) return fail(NextResponse.json({ error: "Request not found" }, { status: 404 }));
  const ticket = rowToTicket(row as Record<string, unknown>);

  const { data: member, error: memErr } = await supabaseAdmin
    .from("org_members").select("uid, role, roles, email, display_name")
    .eq("org_id", ticket.orgId).eq("uid", caller.id).eq("status", "active").maybeSingle();
  if (memErr) return fail(NextResponse.json({ error: "Couldn't confirm your membership — try again in a moment." }, { status: 503 }));
  if (!member) return fail(NextResponse.json({ error: "Forbidden: not an active member of this workspace" }, { status: 403 }));
  const scope = await ticketReadScope(supabaseAdmin, member, caller.id, {
    id: ticketId, requesterId: ticket.requesterId, assignedDrafterId: ticket.assignedDrafterId, assignedEngineerId: ticket.assignedEngineerId, watchers: ticket.watchers,
  });
  if (scope === "unknown") return fail(NextResponse.json({ error: "Couldn't confirm you can see this request — try again in a moment." }, { status: 503 }));
  if (scope === "out") return fail(NextResponse.json({ error: "Request not found" }, { status: 404 }));
  if ((row as { archived_at?: string | null }).archived_at) {
    return fail(mode === "get" ? NextResponse.json({ mayWaive: false }) : NextResponse.json({ error: "This request is archived; restore it from its archive before changing its examination data." }, { status: 409 }));
  }
  if (SCOPE_CLOSED_STATUSES.has(String(ticket.status ?? ""))) {
    return fail(mode === "get" ? NextResponse.json({ mayWaive: false }) : NextResponse.json({ error: "This request is closed — its examination data is part of its record and is not changed." }, { status: 409 }));
  }
  if (mode === "get" && SCOPE_ISSUED_STATUSES.has(String(ticket.status ?? ""))) return fail(NextResponse.json({ mayWaive: false }));

  const { data: cfgRow, error: cfgErr } = await supabaseAdmin
    .from("org_configurations").select("data").eq("org_id", ticket.orgId).eq("key", "drafting").maybeSingle();
  if (cfgErr) return fail(NextResponse.json({ error: "Couldn't read this workspace's examination data settings — try again in a moment." }, { status: 503 }));
  const draftingCfg = ((cfgRow as { data?: unknown } | null)?.data ?? null) as Record<string, unknown> | null;
  const config = parseExaminationScopeConfig(draftingCfg);
  if (!examinationScopeConfigured(config)) {
    return fail(mode === "get" ? NextResponse.json({ mayWaive: false }) : NextResponse.json({ error: "This workspace records no examination data (Admin → Request forms → Examination data)." }, { status: 409 }));
  }

  const m = member as Member;
  const loaded = await loadCapabilityPolicyStrict(ticket.orgId, supabaseAdmin);
  if (!loaded.ok) return fail(NextResponse.json({ error: "Couldn't read this workspace's permissions — try again in a moment." }, { status: 503 }));
  return { ok: true, v: { caller, row: row as Record<string, unknown>, ticket, m, roles: heldRoles(m), draftingCfg, config, policy: loaded.policy } };
}

/** The waiver's authority: the issuing acts the workflow route would accept
 *  from this member now (lib/workflowAuthority.ts — the route's own context). */
async function waiverAuthority(v: Loaded, ticketId: string): Promise<{ ok: true; authority: string } | { ok: false; res: NextResponse }> {
  const decided = await issueAuthorityNow(supabaseAdmin, { ticket: v.ticket, ticketId, callerId: v.caller.id, member: v.m, capPolicy: v.policy, draftingCfg: v.draftingCfg });
  if (decided.kind === "unreadable") return { ok: false, res: NextResponse.json({ error: decided.error }, { status: 503 }) };
  if (decided.kind === "none") {
    return { ok: false, res: NextResponse.json({ error: "Only someone who can issue this request now may record why it issues without its examination data." }, { status: 403 }) };
  }
  return { ok: true, authority: `issue_authority:${decided.actions.join(",")}` };
}

export async function GET(req: NextRequest) {
  const caller = await authenticate(req);
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ticketId = req.nextUrl.searchParams.get("ticketId") ?? "";
  if (!UUID_RE.test(ticketId)) return NextResponse.json({ error: "ticketId is required" }, { status: 400 });
  const l = await load(caller, ticketId, "get");
  if (!l.ok) return l.res;
  const a = await waiverAuthority(l.v, ticketId);
  if (a.ok) return NextResponse.json({ mayWaive: true });
  return a.res.status === 403 ? NextResponse.json({ mayWaive: false }) : NextResponse.json({ mayWaive: false, error: "Couldn't confirm who may issue this request — try again in a moment." }, { status: a.res.status });
}

/** The request's history line for a change in review or a fill after issue:
 *  a bookkeeping append that does NOT change last_modified (compare-and-set
 *  on the value read; read again and tried once more on a conflict) — never
 *  a blind overwrite of the array, never a 409 for anyone else. True when it
 *  landed. */
async function appendHistoryLine(ticketId: string, row: Record<string, unknown>, entry: Record<string, unknown>): Promise<boolean> {
  let hist: unknown[] = Array.isArray(row.history) ? row.history as unknown[] : [];
  let lastModified: string | null = (row.last_modified as string | null | undefined) ?? null;
  for (let tryNo = 0; tryNo < 2; tryNo++) {
    try {
      let cas = supabaseAdmin.from("tickets").update({ history: [...hist, entry] }).eq("id", ticketId).is("archived_at", null);
      cas = lastModified ? cas.eq("last_modified", lastModified) : cas.is("last_modified", null);
      const { data: landed, error: hErr } = await cas.select("id");
      if (!hErr && Array.isArray(landed) && landed.length > 0) return true;
      if (hErr) { console.error(`[examination-scope] ${ticketId}: the history line could not be written: ${hErr.message}`); return false; }
      const { data: again, error: againErr } = await supabaseAdmin.from("tickets").select("history, last_modified, archived_at").eq("id", ticketId).maybeSingle();
      if (againErr || !again || (again as { archived_at?: string | null }).archived_at) {
        console.error(`[examination-scope] ${ticketId}: the history line could not be written: the request changed and could not be read again`);
        return false;
      }
      hist = Array.isArray((again as { history?: unknown }).history) ? (again as { history: unknown[] }).history : [];
      lastModified = (again as { last_modified?: string | null }).last_modified ?? null;
    } catch (e) {
      console.error(`[examination-scope] ${ticketId}: the history line could not be written: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }
  console.error(`[examination-scope] ${ticketId}: the history line could not be written: the request kept changing`);
  return false;
}

export async function POST(req: NextRequest) {
  const authed = await authenticate(req);
  if (!authed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  const l = await load(authed, ticketId, "post");
  if (!l.ok) return l.res;
  const v = l.v;
  const { caller, ticket, m, config, draftingCfg } = v;
  const phase = scopePhase(ticket.status);
  if (hasWaiver && phase === "after_issue") {
    return NextResponse.json({ error: "This request has issued — the examination data it issued with is part of its record, and no reason to issue without it is recorded now (it can be again if the request is sent back).", code: "issued" }, { status: 409 });
  }

  // ── Who may act ────────────────────────────────────────────────────────
  let authority: string;
  let queue = false;
  if (hasValues) {
    queue = policyAllows(v.policy, "ticket.assign", m.role, v.roles, caller.id, ticketResource(ticket));
    // Who has no say at all is refused before anything else is read; what
    // each may do per field is decided below, once the row is read.
    const early = checkScopeWrite(ticket, caller.id, queue, config, {}, {});
    if (!early.ok) return NextResponse.json({ error: early.error, code: early.code }, { status: early.status });
    authority = early.basis;
  } else {
    const a = await waiverAuthority(v, ticketId);
    if (!a.ok) return a.res;
    authority = a.authority;
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
  let changedRows: Array<{ field: string; from: string | null; to: string | null }> = [];
  if (hasValues) {
    const checked = checkScopeValuesInput(config, body.values);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
    const allowed = checkScopeWrite(ticket, caller.id, queue, config, values, checked.changes);
    if (!allowed.ok) return NextResponse.json({ error: allowed.error, code: allowed.code }, { status: allowed.status });
    const applied = applyScopeChanges(values, checked.changes, who, nowIso, phase === "after_issue" ? { afterIssue: { rev: ticket.deliverableRev ?? null } } : undefined);
    if (applied.changed.length === 0) return NextResponse.json({ ok: true, unchanged: true, values, waiver });
    nextValues = applied.values;
    action = "TICKET_EXAMINATION_SCOPE_SET";
    changedRows = applied.changed.map((k) => ({ field: k, from: values[k]?.value ?? null, to: nextValues[k]?.value ?? null }));
    details = {
      changed: changedRows,
      ...(phase === "in_review" ? { phase, historyLine: true } : {}),
      ...(phase === "after_issue" ? { phase, completedAfterIssue: true, historyLine: true } : {}),
    };
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
  // Merge-time fix pass (ruling 4): a change in review (old → new), or a
  // fill after issue ("completed after issue"), goes on the request's own
  // history too.
  let historyNotWritten = false;
  if (hasValues && (phase === "in_review" || phase === "after_issue")) {
    const entry = examinationScopeHistoryEntry({
      phase, config, changed: changedRows, user: m.email ?? caller.email ?? null, role: m.role ?? null, now: nowIso, attempt: auditId, actorId: caller.id,
    });
    historyNotWritten = !(await appendHistoryLine(ticketId, v.row, entry));
  }
  return NextResponse.json({ ok: true, values: nextValues, waiver: nextWaiver, updatedAt: nowIso, ...(historyNotWritten ? { historyNotWritten: true } : {}) });
}
