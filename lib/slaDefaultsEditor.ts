// lib/slaDefaultsEditor.ts — the sla_defaults editor's data layer
// (drafting-flow Round G, DF-P13: EDGE-7 done-when 2's editor, EDGE-16).
//
// sla_defaults holds, per workspace and request type, the window
// /api/tickets/create stamps on a request filed without a requested date
// (default_days from now, at 17:00) and the window the SLA clock
// (lib/ticketSla.ts) gives an open request that has no due date of its own.
// Neither reader changes here: the create route keeps its own bound
// (lib/notifications.ts boundedSlaDays — the SAME rule the editor validates
// with) and its built-in fallback (DEFAULT_SLA_DAYS); the clock warns at
// SLA_WARN_FRACTION of the window, a fixed constant — so the table's
// warn_before_days column, which no code reads, is not offered.
//
// Who may write: the drafting-configuration editors (lib/adminSurfaces.ts
// DRAFTING_CONFIG_EDITORS — Admin, DocCtrl, DraftingSupervisor). The admin
// gate already holds /admin/requests to that set; 20261218 makes it the
// database's rule too, and bounds default_days to 1–3650. Every write here is
// a checked write (lib/checkedWrite): a refusal is never a silent success, and
// the database's own refusal text is carried to the screen with it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkedWrite, isMissingSchemaError, type CheckedWriteFailure } from "@/lib/checkedWrite";
import { DEFAULT_SLA_DAYS, SLA_DEFAULT_DAYS_MAX, boundedSlaDays } from "@/lib/notifications";
import { DRAFTING_CONFIG_EDITORS } from "@/lib/adminSurfaces";
import { SLA_WARN_FRACTION } from "@/lib/ticketSla";

/** The migration that makes the editor set the database's write rule. */
export const SLA_DEFAULTS_RAIL_MIGRATION = "20261218";

const DAY_MS = 24 * 3600 * 1000;

export interface SlaDefaultRow {
  id: string;
  requestType: string;
  /** As stored. A row written before 20261218 may hold a value outside
   *  1–3650; the create route then uses the built-in window. */
  defaultDays: number;
}

export type SlaDefaultsLoad =
  | { ok: true; rows: SlaDefaultRow[] }
  | { ok: false; missing: boolean; error: string };

/** The built-in window the create route stamps for a type with no row
 *  (app/api/tickets/create → defaultSlaTargetDate: DEFAULT_SLA_DAYS, else 14). */
export function builtInSlaDays(requestType: string): number {
  return DEFAULT_SLA_DAYS[requestType] ?? 14;
}

/** True when a stored value is one the create route would use. */
export function storedWindowUsable(days: number): boolean {
  return boundedSlaDays(days) !== null;
}

export type SlaDaysParse = { ok: true; days: number } | { ok: false; error: string };

/** The editor's validation: a whole number of days from 1 to
 *  SLA_DEFAULT_DAYS_MAX (3650), typed as digits only — the create route's own
 *  bound (boundedSlaDays), so a window the editor accepts is one every reader
 *  uses, and the database's CHECK (20261218) refuses nothing it sends. */
export function parseSlaDays(input: string): SlaDaysParse {
  const t = input.trim();
  if (t === "") return { ok: false, error: `Enter a number of days from 1 to ${SLA_DEFAULT_DAYS_MAX}.` };
  if (!/^\d+$/.test(t)) return { ok: false, error: `Whole days only — a number from 1 to ${SLA_DEFAULT_DAYS_MAX}, without fractions, signs or units.` };
  const days = boundedSlaDays(Number(t));
  if (days === null) return { ok: false, error: `Between 1 and ${SLA_DEFAULT_DAYS_MAX} days (ten years).` };
  return { ok: true, days };
}

/** The share of the window at which the clock warns, as a whole percent
 *  (lib/ticketSla.ts SLA_WARN_FRACTION). */
export const SLA_WARN_PERCENT = Math.round(SLA_WARN_FRACTION * 100);

/** The warning point the clock uses, in whole days after filing (floored),
 *  for the editor's explanation. */
export function warnAfterDays(days: number): number {
  return Math.floor(days * SLA_WARN_FRACTION);
}

export async function loadSlaDefaults(sb: SupabaseClient, orgId: string): Promise<SlaDefaultsLoad> {
  const { data, error } = await sb.from("sla_defaults").select("id, request_type, default_days").eq("org_id", orgId);
  if (error) return { ok: false, missing: isMissingSchemaError(error), error: error.message };
  const rows = ((data as Array<{ id: string; request_type: string; default_days: number }> | null) ?? [])
    .map((r) => ({ id: String(r.id), requestType: String(r.request_type), defaultDays: Number(r.default_days) }));
  return { ok: true, rows };
}

export type SlaWriteResult = { ok: true } | { ok: false; refused: boolean; message: string };

interface PgErr { message: string; code?: string | null }

/** The sentence a failed write shows: the checked write's plain-language
 *  reason, the database's own words (the refusal text), and — for a refusal —
 *  who saves these windows. */
export function slaWriteFailure(w: CheckedWriteFailure, dbError: PgErr | null): { refused: boolean; message: string } {
  const raw = (dbError?.message ?? "").trim();
  const refused = w.code === "refused" || dbError?.code === "42501" || /row-level security|permission denied/i.test(raw);
  const parts = [`Not saved: ${w.error}`];
  if (raw) parts.push(`The database said: "${raw}"${dbError?.code ? ` (${dbError.code})` : ""}.`);
  if (refused) parts.push(`Due-date windows are saved by ${DRAFTING_CONFIG_EDITORS.join(", ")}.`);
  return { refused, message: parts.join(" ") };
}

/** Set a type's window (insert or replace its row). Checked: the row must come
 *  back, and a refusal carries the database's text. */
export async function saveSlaDefault(sb: SupabaseClient, orgId: string, requestType: string, days: number): Promise<SlaWriteResult> {
  let dbError: PgErr | null = null;
  const w = await checkedWrite(
    sb.from("sla_defaults")
      .upsert({ org_id: orgId, request_type: requestType, default_days: days, updated_at: new Date().toISOString() }, { onConflict: "org_id,request_type" })
      .select("id")
      .then((r) => { dbError = r.error; return r; }),
  );
  if (w.ok) return { ok: true };
  return { ok: false, ...slaWriteFailure(w, dbError) };
}

/** Remove a type's window: new requests of the type use the built-in window
 *  again, and the clock stops timing its open requests that have no due date
 *  of their own. Checked: a delete that removed nothing is a refusal. */
export async function clearSlaDefault(sb: SupabaseClient, orgId: string, requestType: string): Promise<SlaWriteResult> {
  let dbError: PgErr | null = null;
  const w = await checkedWrite(
    sb.from("sla_defaults").delete().eq("org_id", orgId).eq("request_type", requestType)
      .select("id")
      .then((r) => { dbError = r.error; return r; }),
  );
  if (w.ok) return { ok: true };
  return { ok: false, ...slaWriteFailure(w, dbError) };
}

export interface SlaUntargetedImpact {
  /** Open requests of the type with no due date of their own, filed more
   *  than `days` ago and not yet recorded overdue: the next clock run records
   *  each as overdue and sends its "Overdue" notice. */
  overdue: number;
  /** …filed more than SLA_WARN_FRACTION of `days` ago (but not `days`) and
   *  not yet warned: each gets a "Due soon" notice. */
  dueSoon: number;
}

/** What saving `days` for a type does at once to its open requests that have
 *  no due date of their own (drafting-flow EDGE-7's residual: a window added
 *  later gives those requests a window immediately, so the old ones breach on
 *  the next run). The same filters as lib/ticketSla.ts's sla_defaults pass;
 *  counts only. */
export async function untargetedImpact(
  sb: SupabaseClient, orgId: string, requestType: string, days: number, now: number = Date.now(),
): Promise<{ ok: true; impact: SlaUntargetedImpact } | { ok: false; error: string }> {
  const breachFrom = new Date(now - days * DAY_MS).toISOString();
  const warnFrom = new Date(now - days * DAY_MS * SLA_WARN_FRACTION).toISOString();
  const base = () => sb.from("tickets").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("request_type", requestType)
    .not("status", "in", "(CLOSED,CANCELED)")
    .is("archived_at", null)
    .is("sla_breached_at", null)
    .is("target_completion_at", null);
  const [over, soon] = await Promise.all([
    base().lte("created_at", breachFrom),
    base().lte("created_at", warnFrom).gt("created_at", breachFrom).is("sla_breach_warned_at", null),
  ]);
  const err = over.error ?? soon.error;
  if (err) return { ok: false, error: err.message };
  return { ok: true, impact: { overdue: over.count ?? 0, dueSoon: soon.count ?? 0 } };
}
