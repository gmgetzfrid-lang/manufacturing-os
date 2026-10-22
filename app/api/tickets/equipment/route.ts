import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ticketReadScope } from "@/lib/ticketReadScope";
import { loadCapabilityPolicyStrict, policyAllows } from "@/lib/capabilityPolicy";
import { heldRoles } from "@/lib/roleHeld";
import { ticketResource } from "@/lib/workflow";
import { tagKey } from "@/lib/codebook";
import {
  cleanEquipmentTag, equipmentEditAllowed, equipmentOutcomeLine, equipmentTagListed, isMissingEquipmentTable, isTicketParticipant,
  EQUIPMENT_CLOSED_STATUSES, EQUIPMENT_TAG_MAX,
} from "@/lib/ticketEquipment";

// POST /api/tickets/equipment  { ticketId, action: "add" | "correct", tag, rowId? }
//
// drafting-flow Round G, DF-P18 — intelligence GAP-312 (equipment after
// filing). The request page lists the equipment a request names
// (ticket_equipment, 20261251) but only the create route wrote the table; a
// tag mistyped at filing, or one the registry did not know then, could never
// be added or corrected. This route is the one place that happens after
// filing. DEC-90 ruling (4) for DF-P18:
//   1. it authenticates the caller, requires active membership of the
//      request's workspace (checked here, on the server) and that they can
//      read the request (AUTHZ-13's read scope);
//   2. only the request's participants (its requester, its assigned
//      drafter, its assigned engineer) or the assignment queue (the holders
//      of `ticket.assign` for the request's resource — the policy read
//      fail-closed, DEC-89 item 3) may change it; a closed, canceled or
//      archived request is not changed;
//   3. the tag is resolved by the registry's one tag grammar
//      (assets.tag_normalized = lib/codebook.ts tagKey) in the request's
//      workspace, as the service role — a tag the registry does not know is
//      kept as typed and flagged, exactly as the create route does; a lookup
//      that fails keeps it as typed and says so;
//   4. the audit row is written FIRST (TICKET_EQUIPMENT_ADDED /
//      TICKET_EQUIPMENT_CORRECTED, the workflow route's discipline — a
//      change whose record cannot be written is refused, nothing applied),
//      then the checked write. A correction adds the corrected row, then
//      removes the one it replaces (20261251's integrity trigger keeps a
//      recorded tag immutable, so a correction is a replacement; the audit
//      row names both); a removal that fails after the add is said, and the
//      old row stays listed beside the new one.
//   5. (DF-P18 fix pass 3, review major — EVID-12's pairing contract, as the
//      workflow route keeps it.) The attempt row stands for a change that
//      landed unless a later row says otherwise, so every outcome that is
//      not the change it records gets a checked follow-up row naming it in
//      details.attempt: an insert that fails writes
//      TICKET_EQUIPMENT_ADDED_NOT_APPLIED / _CORRECTED_NOT_APPLIED (the
//      viewers' pairTicketAttempts then reads the attempt "not applied"); a
//      correction whose old entry could not be removed writes
//      TICKET_EQUIPMENT_CORRECTED_NOT_APPLIED (the replacement did not land)
//      AND a TICKET_EQUIPMENT_ADDED row recorded after the fact for the tag
//      that now stands beside the kept one, so the trail never reads a clean
//      replacement and never hides the tag that was added. Each follow-up is
//      retried once; one that still cannot be written is said in the answer.
// Before 20261251 is pasted every read and write meets 42P01 / PGRST205:
// the answer is 503 `not_migrated` and nothing is written (the request page
// says the list is not available, as the card does today).

interface Body {
  ticketId?: unknown;
  action?: unknown;
  tag?: unknown;
  rowId?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_MIGRATED = { error: "The equipment list is not available yet (database update 20261251 is not applied).", code: "not_migrated" };

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
  const action = body.action === "add" || body.action === "correct" ? body.action : null;
  const tag = cleanEquipmentTag(body.tag);
  const rowId = typeof body.rowId === "string" ? body.rowId : "";
  if (!UUID_RE.test(ticketId) || !action) {
    return NextResponse.json({ error: "ticketId and action (add or correct) are required" }, { status: 400 });
  }
  if (!tag) return NextResponse.json({ error: `Enter an equipment tag (1 to ${EQUIPMENT_TAG_MAX} characters).`, field: "tag" }, { status: 400 });
  if (action === "correct" && !UUID_RE.test(rowId)) return NextResponse.json({ error: "Name the equipment entry to correct." }, { status: 400 });

  const { data: row, error: loadErr } = await supabaseAdmin
    .from("tickets")
    .select("id, org_id, status, archived_at, request_type, unit, requester_id, assigned_drafter_id, assigned_engineer_id, watchers")
    .eq("id", ticketId)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: "Couldn't read the request — try again in a moment." }, { status: 503 });
  if (!row) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  const t = row as {
    id: string; org_id: string; status: string | null; archived_at: string | null; request_type: string | null; unit: string | null;
    requester_id: string | null; assigned_drafter_id: string | null; assigned_engineer_id: string | null; watchers: string[] | null;
  };

  const { data: member, error: memErr } = await supabaseAdmin
    .from("org_members").select("uid, role, roles, email")
    .eq("org_id", t.org_id).eq("uid", caller.id).eq("status", "active").maybeSingle();
  if (memErr) return NextResponse.json({ error: "Couldn't confirm your membership — try again in a moment." }, { status: 503 });
  if (!member) return NextResponse.json({ error: "Forbidden: not an active member of this workspace" }, { status: 403 });
  const m = member as { uid: string; role: string | null; roles: string[] | null; email: string | null };
  const scope = await ticketReadScope(supabaseAdmin, m, caller.id, {
    id: t.id, requesterId: t.requester_id, assignedDrafterId: t.assigned_drafter_id, assignedEngineerId: t.assigned_engineer_id, watchers: t.watchers,
  });
  if (scope === "unknown") return NextResponse.json({ error: "Couldn't confirm you can see this request — try again in a moment." }, { status: 503 });
  if (scope === "out") return NextResponse.json({ error: "Request not found" }, { status: 404 });

  if (t.archived_at) return NextResponse.json({ error: "This request is archived; restore it from its archive before changing its equipment." }, { status: 409 });
  if (EQUIPMENT_CLOSED_STATUSES.has(String(t.status ?? ""))) {
    return NextResponse.json({ error: "This request is closed — its equipment is part of its record and is not changed." }, { status: 409 });
  }

  const participant = isTicketParticipant({ requesterId: t.requester_id, assignedDrafterId: t.assigned_drafter_id, assignedEngineerId: t.assigned_engineer_id }, caller.id);
  let queue = false;
  if (!participant) {
    const loaded = await loadCapabilityPolicyStrict(t.org_id, supabaseAdmin);
    if (!loaded.ok) return NextResponse.json({ error: "Couldn't read this workspace's permissions — try again in a moment." }, { status: 503 });
    queue = policyAllows(loaded.policy, "ticket.assign", m.role, heldRoles(m), caller.id, ticketResource({ requestType: t.request_type ?? "", unit: t.unit }));
  }
  if (!equipmentEditAllowed({ participant, queue, status: t.status, archived: !!t.archived_at })) {
    return NextResponse.json({ error: "Only the request's requester, drafter or engineer, or whoever runs the assignment queue, can add or correct its equipment." }, { status: 403 });
  }

  // The row a correction replaces — in this request and this workspace.
  let previous: { id: string; tag: string; asset_id: string | null } | null = null;
  if (action === "correct") {
    const { data: prev, error: prevErr } = await supabaseAdmin
      .from("ticket_equipment").select("id, tag, asset_id")
      .eq("id", rowId).eq("ticket_id", t.id).eq("org_id", t.org_id).maybeSingle();
    if (prevErr) return isMissingEquipmentTable(prevErr) ? NextResponse.json(NOT_MIGRATED, { status: 503 }) : NextResponse.json({ error: "Couldn't read the equipment entry — try again in a moment." }, { status: 503 });
    if (!prev) return NextResponse.json({ error: "That equipment entry is not on this request." }, { status: 404 });
    previous = prev as { id: string; tag: string; asset_id: string | null };
  }
  // The request's listed tags (this request, this workspace) — read before
  // any audit row, so an unpasted table answers first, and (DF-P18 fix pass,
  // review minor) a tag already listed is not written again: an add of a
  // listed tag (a double click, a later retry) changes nothing; a correction
  // to a tag listed on another entry is refused. This is a check, not a
  // constraint (ticket_equipment has no unique key — DF-P18 fix pass 2): two
  // requests that read before either writes can both insert the tag.
  const { data: listedRows, error: listErr } = await supabaseAdmin
    .from("ticket_equipment").select("id, tag")
    .eq("ticket_id", t.id).eq("org_id", t.org_id).limit(500);
  if (listErr) return isMissingEquipmentTable(listErr) ? NextResponse.json(NOT_MIGRATED, { status: 503 }) : NextResponse.json({ error: "Couldn't read this request's equipment — try again in a moment." }, { status: 503 });
  const already = equipmentTagListed((listedRows ?? []) as Array<{ id: string; tag: string }>, tag, previous?.id ?? null);
  if (already) {
    if (action === "add") return NextResponse.json({ ok: true, unchanged: true, id: already.id, message: `${already.tag} is already listed on this request.` });
    return NextResponse.json({ error: `${already.tag} is already listed on this request — correcting this entry to it would list it twice.`, code: "already_listed" }, { status: 409 });
  }

  // Resolve through the registry's one tag grammar, in this workspace.
  let assetId: string | null = null;
  let resolution: "linked" | "not_found" | "lookup_failed" = "not_found";
  const key = tagKey(tag);
  if (key) {
    const { data: assets, error: assetErr } = await supabaseAdmin
      .from("assets").select("id, archived")
      .eq("org_id", t.org_id).eq("tag_normalized", key)
      .order("archived", { ascending: true }).limit(1);
    if (assetErr) resolution = "lookup_failed";
    else {
      const hit = ((assets ?? []) as Array<{ id: string }>)[0];
      if (hit) { assetId = hit.id; resolution = "linked"; }
    }
  }
  if (previous && previous.tag === tag && (previous.asset_id ?? null) === assetId) {
    return NextResponse.json({ ok: true, unchanged: true, message: `${tag} is already recorded as it is.` });
  }

  const auditId = crypto.randomUUID();
  const auditErr = await insertAuditRowOnce({
    id: auditId,
    action: action === "add" ? "TICKET_EQUIPMENT_ADDED" : "TICKET_EQUIPMENT_CORRECTED",
    resource_id: t.id, resource_type: "ticket", org_id: t.org_id,
    user_id: caller.id, user_email: m.email ?? caller.email ?? null, user_role: m.role ?? null,
    details: {
      tag, assetId, resolution,
      ...(previous ? { replaces: { rowId: previous.id, tag: previous.tag, assetId: previous.asset_id ?? null } } : {}),
      authority: participant ? "participant" : "assignment_queue",
      recordedBeforeApply: true,
    },
  });
  if (auditErr) {
    console.error(`[ticket-equipment] AUDIT ROW NOT WRITTEN for ticket ${t.id}: ${auditErr} — nothing applied`);
    return NextResponse.json({ error: "The change was not applied: its audit record could not be written. Try again in a moment.", code: "audit_unwritable", applied: false }, { status: 500 });
  }

  const attemptAction = action === "add" ? "TICKET_EQUIPMENT_ADDED" : "TICKET_EQUIPMENT_CORRECTED";
  const actor = { resource_id: t.id, resource_type: "ticket", org_id: t.org_id, user_id: caller.id, user_email: m.email ?? caller.email ?? null, user_role: m.role ?? null };
  // A follow-up row (retried once, fixed id); null when it landed, else why
  // not — logged with both ids so the trail can be reconciled.
  const recordFollowUp = async (followAction: string, details: Record<string, unknown>): Promise<string | null> => {
    const err = await insertAuditRowOnce({ id: crypto.randomUUID(), action: followAction, ...actor, details });
    if (err) console.error(`[ticket-equipment] could not write ${followAction} for audit row ${auditId} on ticket ${t.id} — reconcile from ticket_equipment: ${err}`);
    return err;
  };

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("ticket_equipment")
    .insert({ org_id: t.org_id, ticket_id: t.id, tag, asset_id: assetId, created_by: caller.id })
    .select("id");
  if (insErr || !Array.isArray(inserted) || inserted.length === 0) {
    const missing = !!insErr && isMissingEquipmentTable(insErr);
    console.error(`[ticket-equipment] write refused for ticket ${t.id} (audit ${auditId}): ${insErr?.message ?? "no row written"}`);
    // The attempt row above did not land: say so, naming it (EVID-12).
    const followErr = await recordFollowUp(`${attemptAction}_NOT_APPLIED`, {
      attempt: auditId, tag, reason: missing ? "not_migrated" : insErr ? "write_failed" : "no_row_written",
      ...(insErr?.message ? { error: insErr.message } : {}),
    });
    const trailNote = followErr
      ? ` The audit trail could not record that it was not applied (audit row ${auditId}) — tell an Admin.`
      : "";
    if (missing) return NextResponse.json({ ...NOT_MIGRATED, error: NOT_MIGRATED.error + trailNote, applied: false, attempt: auditId, notAppliedRecorded: !followErr }, { status: 503 });
    return NextResponse.json({ error: `The equipment was not recorded — try again in a moment.${trailNote}`, applied: false, attempt: auditId, notAppliedRecorded: !followErr }, { status: 500 });
  }
  const newId = (inserted[0] as { id: string }).id;

  let warning: string | null = null;
  let partial = false;
  if (previous) {
    const { data: removed, error: delErr } = await supabaseAdmin
      .from("ticket_equipment").delete()
      .eq("id", previous.id).eq("ticket_id", t.id).eq("org_id", t.org_id)
      .select("id");
    if (delErr || !Array.isArray(removed) || removed.length === 0) {
      partial = true;
      console.error(`[ticket-equipment] the corrected entry ${previous.id} on ticket ${t.id} was not removed (audit ${auditId}): ${delErr?.message ?? "no row matched"}`);
      // The replacement the CORRECTED row records did not land: the old entry
      // stays and the corrected tag was added beside it. Two rows say exactly
      // that — the correction not applied, and the add that did happen.
      const kept = { rowId: previous.id, tag: previous.tag, assetId: previous.asset_id ?? null };
      const notAppliedErr = await recordFollowUp("TICKET_EQUIPMENT_CORRECTED_NOT_APPLIED", {
        attempt: auditId, reason: "old_entry_not_removed", kept, added: { rowId: newId, tag, assetId },
        ...(delErr?.message ? { error: delErr.message } : {}),
      });
      const addedErr = await recordFollowUp("TICKET_EQUIPMENT_ADDED", {
        tag, assetId, resolution, rowId: newId, besideKept: kept, fromCorrection: auditId,
        authority: participant ? "participant" : "assignment_queue",
      });
      warning = `The corrected tag was recorded, but the old entry (${previous.tag}) could not be removed — it is still listed. Try the correction again, or tell an Admin.`
        + (notAppliedErr || addedErr ? ` The audit trail could not record this outcome in full (audit row ${auditId}) — tell an Admin.` : "");
    }
  }
  return NextResponse.json({
    ok: true, id: newId, tag, assetId, resolution,
    message: equipmentOutcomeLine(tag, resolution),
    ...(warning ? { warning } : {}),
    ...(partial ? { partial: true, attempt: auditId } : {}),
  });
}
