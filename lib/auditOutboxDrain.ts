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
// Idempotent: before writing, it looks for an AUDIT_DEAD_LETTER row already
// naming the outbox id (a run whose "drained" stamp was refused after the
// write), and only stamps it. A row whose write is refused stays undrained,
// counts an attempt and keeps the refusal (drain_error) for the next run.
// The run's errors carry what was drained (the ALERT — DEC-102's dead-letter
// precedent: the operator's cron log and the audit trail an Admin reads) and
// every failure. Before 20261219 the table is missing: nothing to do, nothing
// said.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/checkedWrite";

/** The machine label on every drained row (DEC-87 §2: system:<channel>). */
export const AUDIT_OUTBOX_ACTOR = "system:audit-outbox";
/** The action every drained row carries (lib/auditActions.ts registers it). */
export const AUDIT_DEAD_LETTER_ACTION = "AUDIT_DEAD_LETTER";
/** Outbox rows read per page. */
export const AUDIT_OUTBOX_PAGE = 50;

export interface AuditOutboxReport {
  /** Rows written into the audit trail this run (or found already written and stamped). */
  drained: number;
  /** Rows whose audit row could not be written (left undrained, the refusal kept). */
  failed: number;
  /** Workspaces whose lost rows were recovered this run. */
  orgs: number;
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

/** The audit_logs row an outbox row becomes. */
export function drainedAuditRow(o: OutboxRow): Record<string, unknown> {
  const entry = (o.entry && typeof o.entry === "object" ? o.entry : {}) as { row?: Record<string, unknown>; reporter?: unknown };
  return {
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
  const report: AuditOutboxReport = { drained: 0, failed: 0, orgs: 0 };
  const orgs = new Map<string, number>();
  let cursor: { at: string; id: string } | null = null;
  try {
    while (Date.now() < opts.stopBy) {
      let q = sb.from("audit_dead_letters")
        .select("id, org_id, action, entry, error, source, reported_by, reported_at, drain_attempts")
        .is("drained_at", null);
      if (cursor) q = q.or(afterCursor(cursor));
      const { data, error } = await q.order("reported_at", { ascending: true }).order("id", { ascending: true }).limit(AUDIT_OUTBOX_PAGE);
      if (error) {
        if (!isMissingSchemaError(error)) opts.errors.push(`audit-outbox: the outbox could not be read (${error.message}) — nothing drained from here; the next run continues`);
        break;
      }
      const rows = (data as OutboxRow[] | null) ?? [];
      if (rows.length === 0) break;
      for (const o of rows) {
        if (Date.now() >= opts.stopBy) break;
        cursor = { at: o.reported_at, id: o.id };
        const landed = await writeOnce(sb, o);
        if ("error" in landed) {
          report.failed++;
          const { error: noteError } = await sb.from("audit_dead_letters")
            .update({ drain_attempts: (o.drain_attempts ?? 0) + 1, drain_error: landed.error.slice(0, 1000) })
            .eq("id", o.id);
          opts.errors.push(`audit-outbox: the lost ${o.action} row of workspace ${o.org_id} (outbox ${o.id}) could not be written to the audit log (${landed.error}); it stays in the outbox${noteError ? ` — and its attempt could not be recorded (${noteError.message})` : ""}`);
          continue;
        }
        const { error: stampError } = await sb.from("audit_dead_letters")
          .update({ drained_at: new Date().toISOString(), audit_log_id: landed.id, drain_error: null })
          .eq("id", o.id);
        if (stampError) {
          // written, not stamped: the next run finds the audit row by its outbox id and stamps it
          opts.errors.push(`audit-outbox: outbox ${o.id} was written to the audit log (${landed.id}) but could not be marked drained (${stampError.message}); the next run marks it without writing it again`);
        }
        report.drained++;
        orgs.set(o.org_id, (orgs.get(o.org_id) ?? 0) + 1);
      }
      if (rows.length < AUDIT_OUTBOX_PAGE) break;
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

/** Write the outbox row's audit row, unless one already names it. */
async function writeOnce(sb: SupabaseClient, o: OutboxRow): Promise<{ id: string } | { error: string }> {
  const { data: found, error: findError } = await sb.from("audit_logs")
    .select("id")
    .eq("org_id", o.org_id).eq("action", AUDIT_DEAD_LETTER_ACTION).eq("resource_type", "org").is("user_id", null)
    .eq("details->>outboxId", o.id)
    .limit(1);
  if (findError) return { error: `the earlier write could not be checked: ${findError.message}` };
  const prior = ((found as Array<{ id: string }> | null) ?? [])[0];
  if (prior) return { id: prior.id };
  const { data, error } = await sb.from("audit_logs").insert(drainedAuditRow(o)).select("id").single();
  if (error) return { error: error.message || "audit insert refused" };
  const id = (data as { id?: string } | null)?.id;
  return id ? { id } : { error: "the audit insert returned no id" };
}
