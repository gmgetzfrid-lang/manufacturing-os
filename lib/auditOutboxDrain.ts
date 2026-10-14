// lib/auditOutboxDrain.ts — drafting-flow EVID-6 (admin-and-org package
// P13): the audit dead-letter outbox's DRAIN, one bounded step of the daily
// maintenance cron (app/api/cron/maintenance/route.ts step 7d — no new cron
// entry: a third vercel.json cron fails every deployment on this plan).
//
// SERVER-ONLY (the service role). Each undrained public.audit_dead_letters
// row (20261219) becomes ONE audit_logs row:
//   action AUDIT_DEAD_LETTER, resource_type 'org' / resource_id the
//   workspace — inside audit_logs_admin_trail's org-level set, so only the
//   Audit log permission's holders read it (the lost row may carry a node's
//   access list or a member's details);
//   a MACHINE row (user_id NULL, user_email AUDIT_OUTBOX_ACTOR, user_role
//   'system' — DEC-87 §2; actor_kind 'system' once 20261201 is pasted);
//   details: the outbox id, the lost action, the lost row AS ITS WRITER SENT
//   IT (labelled asSent — never identity), the verified reporter and source,
//   the refusal and when it was reported.
// It never re-inserts the lost action itself: a refusal the database meant
// (a member's forged consent row, a signed-in INTAKE_ action) must not land
// as the real action through the service role.
//
// Idempotent (fix pass — it was a check-then-insert with no key, so two
// overlapping runs could both write, and the check scanned the workspace's
// whole audit log per row):
//   * CLAIM first: each row is claimed by a compare-and-set on its attempt
//     count (UPDATE … SET drain_attempts = n + 1 WHERE id = … AND drained_at
//     IS NULL AND drain_attempts = n). A run that loses the race to another
//     run (a manual trigger beside the scheduled one) skips the row.
//   * KEYED write: the recovered audit row is written with the outbox row's
//     own id as its primary key, so a second write — an earlier run whose
//     "drained" stamp was refused, or a run that claimed the row after
//     another had written it — is refused 23505 by the primary key, and the
//     row found under that id (checked to be this outbox row's) is stamped.
//     No duplicate is possible and the lookup is the primary-key index.
// A row whose write is refused stays undrained with the refusal kept
// (drain_error); after AUDIT_OUTBOX_MAX_ATTEMPTS claims it is PARKED — no
// longer read, so a row that always fails cannot spend every night's budget
// ahead of newer ones — and every run reports how many are parked. Rows
// drained more than AUDIT_OUTBOX_KEEP_DAYS ago are pruned (their content
// lives on as the AUDIT_DEAD_LETTER row). The run's errors carry what was
// drained (the ALERT — DEC-102's dead-letter precedent: the operator's cron
// log and the audit trail an Admin reads) and every failure. Before 20261219
// the table is missing: nothing to do, nothing said.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/checkedWrite";

/** The machine label on every drained row (DEC-87 §2: system:<channel>). */
export const AUDIT_OUTBOX_ACTOR = "system:audit-outbox";
/** The action every drained row carries (lib/auditActions.ts registers it). */
export const AUDIT_DEAD_LETTER_ACTION = "AUDIT_DEAD_LETTER";
/** Outbox rows read per page. */
export const AUDIT_OUTBOX_PAGE = 50;
/** A row claimed this many times without draining is parked: no longer read, reported each run. */
export const AUDIT_OUTBOX_MAX_ATTEMPTS = 5;
/** Drained outbox rows are pruned this many days after they were drained. */
export const AUDIT_OUTBOX_KEEP_DAYS = 30;

export interface AuditOutboxReport {
  /** Rows written into the audit trail this run (or found already written and stamped). */
  drained: number;
  /** Rows whose audit row could not be written (left undrained, the refusal kept). */
  failed: number;
  /** Workspaces whose lost rows were recovered this run. */
  orgs: number;
  /** Rows another run claimed first (left to it). */
  skipped: number;
  /** Undrained rows past AUDIT_OUTBOX_MAX_ATTEMPTS — no longer retried, reported. */
  parked: number;
}

type OutboxRow = {
  id: string; org_id: string; action: string; entry: unknown; error: string | null;
  source: string; reported_by: string | null; reported_at: string; drain_attempts: number | null;
};

/** The keyset condition for rows after (reported_at, id), oldest first. */
function afterCursor(c: { at: string; id: string }): string {
  const v = (x: string) => `"${x.replace(/["\\]/g, (ch) => `\\${ch}`)}"`;
  return `reported_at.gt.${v(c.at)},and(reported_at.eq.${v(c.at)},id.gt.${v(c.id)})`;
}

/** The audit_logs row an outbox row becomes — under the outbox row's own id
 *  (the primary key makes a second write impossible). */
export function drainedAuditRow(o: OutboxRow): Record<string, unknown> {
  const entry = (o.entry && typeof o.entry === "object" ? o.entry : {}) as { row?: Record<string, unknown>; reporter?: unknown };
  return {
    id: o.id,
    action: AUDIT_DEAD_LETTER_ACTION,
    resource_type: "org",
    resource_id: o.org_id,
    org_id: o.org_id,
    user_id: null,
    user_email: AUDIT_OUTBOX_ACTOR,
    user_role: "system",
    details: {
      outboxId: o.id,
      lostAction: o.action,
      lost: { ...(entry.row ?? {}), asSent: true },
      reportedBy: o.reported_by,
      reporter: entry.reporter ?? null,
      source: o.source,
      error: o.error,
      reportedAt: o.reported_at,
    },
  };
}

/** Drain the outbox until `stopBy` (epoch ms). Never throws; failures are pushed to `errors`. */
export async function drainAuditDeadLetters(sb: SupabaseClient, opts: { stopBy: number; errors: string[] }): Promise<AuditOutboxReport> {
  const report: AuditOutboxReport = { drained: 0, failed: 0, orgs: 0, skipped: 0, parked: 0 };
  const orgs = new Map<string, number>();
  let cursor: { at: string; id: string } | null = null;
  let installed = true;
  try {
    while (Date.now() < opts.stopBy) {
      let q = sb.from("audit_dead_letters")
        .select("id, org_id, action, entry, error, source, reported_by, reported_at, drain_attempts")
        .is("drained_at", null)
        .lt("drain_attempts", AUDIT_OUTBOX_MAX_ATTEMPTS);
      if (cursor) q = q.or(afterCursor(cursor));
      const { data, error } = await q.order("reported_at", { ascending: true }).order("id", { ascending: true }).limit(AUDIT_OUTBOX_PAGE);
      if (error) {
        // a missing table: before 20261219 — nothing to do and nothing said
        if (isMissingSchemaError(error)) installed = false;
        else opts.errors.push(`audit-outbox: the outbox could not be read (${error.message}) — nothing drained from here; the next run continues`);
        break;
      }
      const rows = (data as OutboxRow[] | null) ?? [];
      if (rows.length === 0) break;
      for (const o of rows) {
        if (Date.now() >= opts.stopBy) break;
        cursor = { at: o.reported_at, id: o.id };
        // CLAIM: compare-and-set on the attempt count; a run that loses the race skips the row.
        const attempts = o.drain_attempts ?? 0;
        const { data: claimed, error: claimError } = await sb.from("audit_dead_letters")
          .update({ drain_attempts: attempts + 1 })
          .eq("id", o.id).is("drained_at", null).eq("drain_attempts", attempts)
          .select("id");
        if (claimError) {
          report.failed++;
          opts.errors.push(`audit-outbox: outbox ${o.id} (the lost ${o.action} row of workspace ${o.org_id}) could not be claimed (${claimError.message}); it stays in the outbox`);
          continue;
        }
        if (((claimed as unknown[] | null) ?? []).length === 0) { report.skipped++; continue; }
        const landed = await writeOnce(sb, o);
        if ("error" in landed) {
          report.failed++;
          const { error: noteError } = await sb.from("audit_dead_letters")
            .update({ drain_error: landed.error.slice(0, 1000) })
            .eq("id", o.id);
          const parks = attempts + 1 >= AUDIT_OUTBOX_MAX_ATTEMPTS;
          opts.errors.push(`audit-outbox: the lost ${o.action} row of workspace ${o.org_id} (outbox ${o.id}) could not be written to the audit log (${landed.error}); it stays in the outbox${parks ? ` and, after ${AUDIT_OUTBOX_MAX_ATTEMPTS} attempts, is no longer retried` : ""}${noteError ? ` — and its refusal could not be recorded (${noteError.message})` : ""}`);
          continue;
        }
        const { error: stampError } = await sb.from("audit_dead_letters")
          .update({ drained_at: new Date().toISOString(), audit_log_id: landed.id, drain_error: null })
          .eq("id", o.id);
        if (stampError) {
          // written, not stamped: the next run's write is refused by the primary key, and it only stamps
          opts.errors.push(`audit-outbox: outbox ${o.id} was written to the audit log (${landed.id}) but could not be marked drained (${stampError.message}); the next run marks it without writing it again`);
        }
        report.drained++;
        orgs.set(o.org_id, (orgs.get(o.org_id) ?? 0) + 1);
      }
      if (rows.length < AUDIT_OUTBOX_PAGE) break;
    }
    if (installed) {
      // PARKED rows: said every run until someone looks (the outbox is read from the SQL editor).
      const { count: parked, error: parkedError } = await sb.from("audit_dead_letters")
        .select("id", { count: "exact", head: true })
        .is("drained_at", null).gte("drain_attempts", AUDIT_OUTBOX_MAX_ATTEMPTS);
      if (parkedError) {
        if (!isMissingSchemaError(parkedError)) opts.errors.push(`audit-outbox: the parked rows could not be counted (${parkedError.message})`);
      }
      else if ((parked ?? 0) > 0) {
        report.parked = parked ?? 0;
        opts.errors.push(`audit-outbox: ${report.parked} audit row(s) in the outbox failed ${AUDIT_OUTBOX_MAX_ATTEMPTS} times and are no longer retried — read public.audit_dead_letters (drain_error) in the SQL editor, fix the cause, then set drain_attempts = 0 on them to retry`);
      }
      // PRUNE: rows drained AUDIT_OUTBOX_KEEP_DAYS ago or more (their content is the AUDIT_DEAD_LETTER row).
      if (Date.now() < opts.stopBy) {
        const before = new Date(Date.now() - AUDIT_OUTBOX_KEEP_DAYS * 86_400_000).toISOString();
        const { error: pruneError } = await sb.from("audit_dead_letters").delete().lte("drained_at", before);
        if (pruneError) opts.errors.push(`audit-outbox: drained rows older than ${AUDIT_OUTBOX_KEEP_DAYS} days could not be pruned (${pruneError.message}); the next run tries again`);
      }
    }
  } catch (e) {
    opts.errors.push(`audit-outbox: ${(e as Error).message}`);
  }
  report.orgs = orgs.size;
  if (report.drained > 0) {
    const line = `audit-outbox: ${report.drained} audit row(s) that could not be written were recovered into the audit log as ${AUDIT_DEAD_LETTER_ACTION} (${[...orgs].map(([org, n]) => `${n} in workspace ${org}`).join(", ")}) — an Admin reads them under Admin → Audit log`;
    opts.errors.push(line);
    console.error(`[cron/maintenance] ${line}`);
  }
  return report;
}

/** Write the outbox row's audit row under the outbox id. A primary-key clash
 *  means it was written already (an earlier run whose stamp was refused, or
 *  an overlapping run): the row under that id is used once it is checked to
 *  be this outbox row's recovered row. */
async function writeOnce(sb: SupabaseClient, o: OutboxRow): Promise<{ id: string } | { error: string }> {
  const row = drainedAuditRow(o);
  const { data, error } = await sb.from("audit_logs").insert(row).select("id").single();
  if (!error) {
    const id = (data as { id?: string } | null)?.id;
    return id ? { id } : { error: "the audit insert returned no id" };
  }
  if (error.code !== "23505") return { error: error.message || "audit insert refused" };
  const { data: found, error: findError } = await sb.from("audit_logs")
    .select("id")
    .eq("id", o.id).eq("action", AUDIT_DEAD_LETTER_ACTION).is("user_id", null)
    .eq("details->>outboxId", o.id)
    .limit(1);
  if (findError) return { error: `the earlier write could not be checked: ${findError.message}` };
  const prior = ((found as Array<{ id: string }> | null) ?? [])[0];
  if (prior) return { id: prior.id };
  // The id is held by a row that is not this outbox row's recovery: write it
  // under a fresh id (the claim above keeps runs from racing on it).
  const { id: _taken, ...fresh } = row;
  void _taken;
  const second = await sb.from("audit_logs").insert(fresh).select("id").single();
  if (second.error) return { error: second.error.message || "audit insert refused" };
  const id = (second.data as { id?: string } | null)?.id;
  return id ? { id } : { error: "the audit insert returned no id" };
}
