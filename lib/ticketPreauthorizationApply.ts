// lib/ticketPreauthorizationApply.ts
//
// drafting-flow Round G, DF-P22 — GAP-109 mechanism 2, the server half:
// applying standing pre-authorizations to a review the workflow route just
// opened. Server-only (lib/ticketRoster.ts hashes with node:crypto). The
// rules are lib/ticketPreauthorization.ts's; this file does the reads and
// the writes, each checked:
//
//   * nothing is read unless the roster has an eligible (opted-in, blocking,
//     non-engineering, non-assurance) slot and the request is not engineered
//     work — an unconfigured workspace's review is untouched, no query made;
//   * the request is re-read (the window open, the roster, last_modified);
//     the records and their signatures are read as the service role; any
//     read that fails, or the table missing (before 20261264), applies
//     nothing (today's review: the slot waits for its sign-off);
//   * the audit row FIRST (TICKET_PREAUTHORIZATION_APPLIED, the system actor,
//     naming each record), then the compare-and-set on (status,
//     last_modified, the roster still the one read) writing the roster's
//     satisfied slot(s), the history line naming each record and
//     last_modified; a miss writes the _NOT_APPLIED row and nothing else;
//   * then the roster ledger (satisfied via 'preauthorization', the record's
//     signature) and a bell row to each person whose record was used.
//
// Never throws. It runs after the submission landed (DEC-90 ruling (5):
// bookkeeping never blocks or delays a person's act) and its answer is a
// note for the logs, never a refusal.

import type { TicketReviewRoster } from "@/types/schema";
import { currentRoster, separationOfDutiesActive } from "@/lib/workflow";
import { writeRosterLedger } from "@/lib/ticketRoster";
import { notifyBatchWithReason } from "@/lib/inAppNotifications";
import {
  PREAUTH_ACTOR, PREAUTH_AUDIT, preauthEligibleSlots, preauthFromRow, preauthSignatureStands, planPreauthorizations,
  applyPreauthorizations, preauthHistoryEntry, isMissingPreauthTable, type Preauthorization, type PreauthSignatureRow,
} from "@/lib/ticketPreauthorization";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };

type Member = Record<string, unknown>;

export interface PreauthApplyResult {
  /** The slots satisfied, each with the record that satisfied it. */
  applied: Array<{ slot: string; label: string; preauthorizationId: string; grantorId: string }>;
  /** What happened when nothing (or not everything) was applied — for the
   *  logs; null when there was nothing to do. */
  note: string | null;
}

const NONE: PreauthApplyResult = { applied: [], note: null };

/**
 * Apply the standing pre-authorizations that cover this review's opted-in
 * slots (lib/ticketPreauthorization.ts planPreauthorizations). `engineered`:
 * the route's own engineered-lane answer at submission (the engineering gate,
 * or a declaration whose signature could not be checked) — true applies
 * nothing.
 */
export async function applyStandingPreauthorizations(db: Db, input: {
  ticketId: string;
  orgId: string;
  roster: TicketReviewRoster;
  engineered: boolean;
  members: ReadonlyArray<Member>;
  ticketLabel: string;
  now?: number;
}): Promise<PreauthApplyResult> {
  if (input.engineered || preauthEligibleSlots(input.roster).length === 0) return NONE;
  const now = input.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  try {
    // The request as it stands now (the consent window may have stamped it).
    const { data: tRow, error: tErr } = await db.from("tickets")
      .select("id, org_id, status, last_modified, metadata, history, unread_by, requester_id, assigned_drafter_id, library_id, request_type, work_class, archived_at")
      .eq("id", input.ticketId).maybeSingle();
    if (tErr) return { applied: [], note: `the request could not be re-read, so no standing pre-authorization was applied: ${tErr.message}` };
    const row = tRow as Record<string, unknown> | null;
    if (!row || row.org_id !== input.orgId || row.archived_at) return NONE;
    const metadata = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
    const roster = currentRoster({ status: row.status as never, metadata });
    if (!roster || roster.id !== input.roster.id) return NONE;
    const eligible = preauthEligibleSlots(roster);
    if (eligible.length === 0) return NONE;
    const occupants = [...new Set(eligible.flatMap((s) => [...s.primaries, ...s.alternates]))];
    if (occupants.length === 0) return NONE;

    const { data: pRows, error: pErr } = await db.from("ticket_preauthorizations")
      .select("*").eq("org_id", input.orgId).in("grantor_id", occupants).is("revoked_at", null).gt("expires_at", nowIso);
    if (pErr) {
      if (isMissingPreauthTable(pErr)) return NONE;
      return { applied: [], note: `the standing pre-authorizations could not be read, so none was applied: ${pErr.message}` };
    }
    const preauths: Preauthorization[] = ((pRows as Array<Record<string, unknown>> | null) ?? []).map(preauthFromRow);
    if (preauths.length === 0) return NONE;
    const sigIds = [...new Set(preauths.map((p) => p.signatureId).filter(Boolean))];
    const { data: sRows, error: sErr } = await db.from("e_signatures")
      .select("id, org_id, resource_type, resource_id, signer_user_id, intent, statement").in("id", sigIds);
    if (sErr) return { applied: [], note: `the standing pre-authorizations' signatures could not be read, so none was applied: ${sErr.message}` };
    const sigById = new Map(((sRows as PreauthSignatureRow[] | null) ?? []).map((s) => [String(s.id ?? ""), s] as const));
    const signed = new Set(preauths.filter((p) => preauthSignatureStands(sigById.get(p.signatureId), p)).map((p) => p.id));

    const activeMembers = new Set(input.members.map((m) => String(m.uid ?? "")).filter(Boolean));
    const apps = planPreauthorizations({
      roster,
      ticket: {
        orgId: input.orgId, requesterId: (row.requester_id as string | null) ?? null, assignedDrafterId: (row.assigned_drafter_id as string | null) ?? null,
        libraryId: (row.library_id as string | null) ?? null, requestType: (row.request_type as string | null) ?? null, workClass: (row.work_class as string | null) ?? null,
      },
      engineered: false, preauths, signed, activeMembers, sodActive: separationOfDutiesActive(activeMembers.size), now,
    });
    if (apps.length === 0) return NONE;

    const nameOf = (uid: string): string => {
      const m = input.members.find((x) => x.uid === uid);
      const dn = typeof m?.display_name === "string" ? m.display_name.trim() : "";
      return dn || (typeof m?.email === "string" ? m.email.split("@")[0] : "");
    };
    const next = applyPreauthorizations(roster, apps, nowIso, nameOf);
    const entry = preauthHistoryEntry(apps, nowIso, nameOf);
    // A person whose record was used is no longer waited on unless another
    // open blocking slot still names them.
    const stillWaitedOn = new Set(next.slots.filter((s) => s.status === "open" && s.mode !== "notify_only").flatMap((s) => [...s.primaries, ...s.alternates]));
    const released = new Set(apps.map((a) => a.preauth.grantorId).filter((u) => !stillWaitedOn.has(u)));
    const unread = Array.isArray(row.unread_by) ? (row.unread_by as unknown[]).filter((u): u is string => typeof u === "string") : null;

    // The audit row FIRST (a recorded system act naming each record).
    const auditId = crypto.randomUUID();
    const auditRow = {
      id: auditId, action: PREAUTH_AUDIT.applied, resource_type: "ticket", resource_id: input.ticketId, org_id: input.orgId,
      user_id: null, user_email: PREAUTH_ACTOR, user_role: "system",
      details: {
        rosterId: roster.id,
        applied: apps.map((a) => ({
          slot: a.slot.kind, label: a.slot.label || a.slot.kind, preauthorizationId: a.preauth.id, grantorId: a.preauth.grantorId,
          signatureId: a.preauth.signatureId, scope: { libraryId: a.preauth.libraryId, requestType: a.preauth.requestType, workClass: a.preauth.workClass },
          recordedAt: a.preauth.createdAt, expiresAt: a.preauth.expiresAt,
        })),
        recordedBeforeApply: true,
      },
    };
    const { error: aErr } = await db.from("audit_logs").insert(auditRow);
    if (aErr) return { applied: [], note: `the audit row could not be written, so no standing pre-authorization was applied (the slots wait for their sign-offs): ${aErr.message}` };

    const history = Array.isArray(row.history) ? row.history : [];
    const update: Record<string, unknown> = {
      metadata: { ...metadata, review_roster: next },
      history: [...history, entry],
      last_modified: nowIso,
      ...(unread && released.size > 0 ? { unread_by: unread.filter((u) => !released.has(u)) } : {}),
    };
    let q = db.from("tickets").update(update).eq("id", input.ticketId).eq("status", "PENDING_REVIEW");
    q = row.last_modified ? q.eq("last_modified", String(row.last_modified)) : q.is("last_modified", null);
    const { data: landed, error: uErr } = await q.select("id");
    if (uErr || !Array.isArray(landed) || landed.length === 0) {
      const { error: naErr } = await db.from("audit_logs").insert({
        ...auditRow, id: crypto.randomUUID(), action: `${PREAUTH_AUDIT.applied}_NOT_APPLIED`,
        details: { attempt: auditId, reason: uErr ? "write_failed" : "conflict", ...(uErr ? { error: uErr.message } : {}) },
      });
      return { applied: [], note: `no standing pre-authorization was applied — ${uErr ? uErr.message : "the request changed first"}; the slots wait for their sign-offs${naErr ? ` (and the not-applied record was refused: ${naErr.message})` : ""}` };
    }

    const notes: string[] = [];
    const touched = next.slots.filter((s) => apps.some((a) => a.slot.kind === s.kind));
    const ledgerErr = await writeRosterLedger(db, { orgId: input.orgId, ticketId: input.ticketId, roster: next, event: "satisfied", slots: touched, actor: { uid: null, name: PREAUTH_ACTOR } });
    if (ledgerErr) notes.push(`the roster ledger was not written for the applied pre-authorization(s) (audit row ${auditId}) — reconcile from tickets.metadata.review_roster: ${ledgerErr}`);
    // Tell each person whose record was used (bell; best-effort).
    const { error: bellErr } = await notifyBatchWithReason(apps.map((a) => ({
      orgId: input.orgId, userId: a.preauth.grantorId, kind: "ticket_status" as const,
      title: `Signed off by your standing pre-authorization · ${input.ticketLabel}`.slice(0, 200),
      body: `"${a.slot.label || a.slot.kind}" was signed off by your standing pre-authorization (expires ${a.preauth.expiresAt.slice(0, 10)}). You can revoke it at any time; requests that already used it keep naming it.`,
      link: `/requests/${input.ticketId}`, resourceType: "ticket", resourceId: input.ticketId, actorName: "System",
      metadata: { action: "preauthorization_applied", slot: a.slot.kind, preauthorizationId: a.preauth.id },
    })), db as never);
    if (bellErr) notes.push(`the people whose pre-authorization was used were not told on the bell: ${bellErr}`);
    return {
      applied: apps.map((a) => ({ slot: a.slot.kind, label: a.slot.label || a.slot.kind, preauthorizationId: a.preauth.id, grantorId: a.preauth.grantorId })),
      note: notes.length ? notes.join("; ") : null,
    };
  } catch (e) {
    return { applied: [], note: `no standing pre-authorization was applied: ${(e as Error)?.message ?? String(e)}` };
  }
}
