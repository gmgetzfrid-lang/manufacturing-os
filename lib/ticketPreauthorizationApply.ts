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
//   * each record's grantor must have been an ACTIVE member continuously
//     since the record was created (readGrantorMemberships — merge-time fix
//     pass); a membership read that fails applies nothing;
//   * the audit row FIRST (TICKET_PREAUTHORIZATION_APPLIED, the system actor,
//     naming each record), then ONE database call (20261264's
//     apply_ticket_preauthorizations — merge-time fix pass) that locks the
//     grantors' membership rows and the records, re-checks in that same
//     transaction that each record is not revoked, not expired and its
//     grantor's membership continuous, and only then compare-and-sets the
//     request on (status, last_modified) writing the roster's satisfied
//     slot(s), the history line naming each record and last_modified. A
//     revocation (or a suspension) that commits before that call is seen and
//     nothing is applied (a _NOT_APPLIED row, reason "not_in_force"); one
//     that comes after waits for it and then governs every later use. Any
//     miss writes the _NOT_APPLIED row and nothing else;
//   * then the roster ledger (satisfied via 'preauthorization', the record's
//     signature) and a bell row to each person whose record was used.
//
// Never throws. It runs after the submission's response (the workflow route
// schedules it with next/server after() — DEC-90 ruling (5): bookkeeping
// never blocks or delays a person's act) and its answer is a note for the
// logs, never a refusal.

import type { TicketReviewRoster } from "@/types/schema";
import { currentRoster, separationOfDutiesActive } from "@/lib/workflow";
import { writeRosterLedger } from "@/lib/ticketRoster";
import { notifyBatchWithReason } from "@/lib/inAppNotifications";
import { slaNoticeSurvivesTransition } from "@/lib/ticketSla";
import {
  PREAUTH_ACTOR, PREAUTH_AUDIT, PREAUTH_MIGRATION, preauthEligibleSlots, preauthFromRow, preauthSignatureStands, planPreauthorizations,
  applyPreauthorizations, preauthHistoryEntry, isMissingPreauthTable, readGrantorMemberships, type Preauthorization, type PreauthSignatureRow,
} from "@/lib/ticketPreauthorization";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

/** 20261264's one-transaction re-check and write (merge-time fix pass). */
export const PREAUTH_APPLY_RPC = "apply_ticket_preauthorizations";

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
    // In force only while the grantor has been an active member continuously
    // since the record was created (merge-time fix pass).
    const memberships = await readGrantorMemberships(db, input.orgId, preauths, now);
    if (!memberships.ok) return { applied: [], note: `${memberships.error}, so no standing pre-authorization was applied` };
    const continuous = new Set(preauths.filter((p) => memberships.byId.get(p.id) === "continuous").map((p) => p.id));

    const activeMembers = new Set(input.members.map((m) => String(m.uid ?? "")).filter(Boolean));
    const apps = planPreauthorizations({
      roster,
      ticket: {
        orgId: input.orgId, requesterId: (row.requester_id as string | null) ?? null, assignedDrafterId: (row.assigned_drafter_id as string | null) ?? null,
        libraryId: (row.library_id as string | null) ?? null, requestType: (row.request_type as string | null) ?? null, workClass: (row.work_class as string | null) ?? null,
      },
      engineered: false, preauths, signed, continuous, activeMembers, sodActive: separationOfDutiesActive(activeMembers.size), now,
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

    // Merge-time fix pass: the re-check and the write are ONE transaction.
    // apply_ticket_preauthorizations locks the grantors' membership rows and
    // the records (FOR SHARE), re-checks revoked_at, expires_at and the
    // grantor's continuous membership on the rows it locked, and only then
    // compare-and-sets the request — so no use lands after a revocation (or a
    // suspension) commits: one committed first is seen ("not_in_force"), one
    // committing later waits for this call. Fail-safe: any other answer
    // applies nothing.
    const usedIds = [...new Set(apps.map((a) => a.preauth.id))];
    const history = Array.isArray(row.history) ? row.history : [];
    const { data: rpcOut, error: rpcErr } = await db.rpc(PREAUTH_APPLY_RPC, {
      p_ticket_id: input.ticketId,
      p_org_id: input.orgId,
      p_expected_last_modified: row.last_modified ? String(row.last_modified) : null,
      p_preauthorization_ids: usedIds,
      p_metadata: { ...metadata, review_roster: next },
      p_history: [...history, entry],
      p_last_modified: nowIso,
      p_unread_by: unread && released.size > 0 ? unread.filter((u) => !released.has(u)) : null,
    });
    const outcome = rpcErr ? null : String((rpcOut as { result?: unknown } | null)?.result ?? "");
    if (outcome !== "applied") {
      const missingFn = !!rpcErr && /^(PGRST202|42883)$/.test(String((rpcErr as { code?: string }).code ?? ""));
      const gone = Array.isArray((rpcOut as { gone?: unknown } | null)?.gone) ? ((rpcOut as { gone: unknown[] }).gone.map(String)) : [];
      const reason = rpcErr ? (missingFn ? "function_missing" : "write_failed") : outcome === "not_in_force" ? "not_in_force" : outcome === "conflict" ? "conflict" : "unexpected_answer";
      const { error: naErr } = await db.from("audit_logs").insert({
        ...auditRow, id: crypto.randomUUID(), action: `${PREAUTH_AUDIT.applied}_NOT_APPLIED`,
        details: { attempt: auditId, reason, ...(rpcErr ? { error: rpcErr.message } : {}), ...(reason === "not_in_force" ? { gone } : {}), ...(reason === "unexpected_answer" ? { answer: outcome } : {}) },
      });
      const why = reason === "function_missing"
        ? `the database function ${PREAUTH_APPLY_RPC} is missing (re-paste ${PREAUTH_MIGRATION})`
        : reason === "write_failed" ? String(rpcErr?.message ?? "the write failed")
        : reason === "not_in_force" ? "a record it would use was revoked, expired, or its grantor's membership lapsed since it was read"
        : reason === "conflict" ? "the request changed first"
        : `the database answered "${outcome}"`;
      return { applied: [], note: `no standing pre-authorization was applied — ${why}; the slots wait for their sign-offs${naErr ? ` (and the not-applied record was refused: ${naErr.message})` : ""}` };
    }

    const notes: string[] = [];
    const touched = next.slots.filter((s) => apps.some((a) => a.slot.kind === s.kind));
    const ledgerErr = await writeRosterLedger(db, { orgId: input.orgId, ticketId: input.ticketId, roster: next, event: "satisfied", slots: touched, actor: { uid: null, name: PREAUTH_ACTOR } });
    if (ledgerErr) notes.push(`the roster ledger was not written for the applied pre-authorization(s) (audit row ${auditId}) — reconcile from tickets.metadata.review_roster: ${ledgerErr}`);
    // DF-P23 (the DF-P22 follow-up, DEC-31): the submission's fan-out was
    // computed before this applied, so a person whose record signed off
    // their slot (and whom the request no longer waits on) still holds its
    // "review opened" alert. Retire it as rosterReleased does for a partial
    // sign-off — MARKED superseded, read_at never touched (EVID-13), the SLA
    // notices kept (slaNoticeSurvivesTransition: no exit here) — so the bell
    // is exact. Best-effort: the sign-off has landed; a failure is a note.
    const retireErr = await retireReleasedAlerts(db, { ticketId: input.ticketId, orgId: input.orgId, released: [...released], at: nowIso });
    if (retireErr) notes.push(`the "review opened" alert of a person whose pre-authorization was used was not retired: ${retireErr}`);
    // Tell each person whose record was used (bell; best-effort).
    const { error: bellErr } = await notifyBatchWithReason(apps.map((a) => ({
      orgId: input.orgId, userId: a.preauth.grantorId, kind: "ticket_status" as const,
      title: `Signed off by your standing pre-authorization · ${input.ticketLabel}`.slice(0, 200),
      body: `"${a.slot.label || a.slot.kind}" was signed off by your standing pre-authorization (expires ${a.preauth.expiresAt.slice(0, 10)}). You can revoke it at any time: it then stops at once for every use not yet made, and this sign-off, completed while it was valid, stands and keeps naming it.`,
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

/** The action a retired alert is marked superseded by (the bell row this
 *  step writes next carries the same action). */
export const PREAUTH_RELEASED_SUPERSEDED_BY = "preauthorization_applied";

/**
 * DF-P23 (the DF-P22 follow-up): retire the unread workflow alerts (rows
 * carrying metadata.action, not yet superseded) of the people a standing
 * pre-authorization released on this request — the "review opened" alert
 * the submission's fan-out sent them before it applied. Marked superseded
 * (metadata.superseded_at / superseded_by), never read_at (EVID-13); an SLA
 * notice stays (the request has not exited). null when done (or nobody to
 * retire); otherwise why not. Never throws.
 */
export async function retireReleasedAlerts(db: Db, input: { ticketId: string; orgId: string; released: readonly string[]; at: string }): Promise<string | null> {
  if (input.released.length === 0) return null;
  try {
    const { data: stale, error: readErr } = await db.from("notifications")
      .select("id, user_id, metadata")
      .eq("resource_id", input.ticketId)
      .eq("org_id", input.orgId)
      .in("user_id", [...input.released])
      .is("read_at", null)
      .not("metadata->>action", "is", null)
      .is("metadata->>superseded_at", null);
    if (readErr) return String(readErr.message ?? "the alerts could not be read");
    const failed: string[] = [];
    for (const row of ((stale as Array<{ id: string; metadata: Record<string, unknown> | null }> | null) ?? [])) {
      const action = String(row.metadata?.action ?? "");
      if (slaNoticeSurvivesTransition(action, false)) continue;
      const { error: updErr } = await db.from("notifications")
        .update({ metadata: { ...(row.metadata ?? {}), superseded_at: input.at, superseded_by: PREAUTH_RELEASED_SUPERSEDED_BY } })
        .eq("id", row.id)
        .is("read_at", null);
      if (updErr) failed.push(String(updErr.message ?? row.id));
    }
    return failed.length ? failed.join("; ") : null;
  } catch (e) {
    return (e as Error)?.message ?? String(e);
  }
}
