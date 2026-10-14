// lib/slaDefaultsEditor.ts — the sla_defaults editor's data layer
// (drafting-flow Round G, DF-P13: EDGE-7 done-when 2's editor, EDGE-16).
//
// sla_defaults holds, per workspace and request type, the window
// /api/tickets/create stamps on a request filed without a requested date
// (default_days from now, at 17:00) and the window the SLA clock
// (lib/ticketSla.ts) gives an open request that has no due date of its own.
// Neither reader changes here: the create route keeps its own bound
// (lib/notifications.ts boundedSlaDays — the SAME rule the editor validates
// with, and the one the clock skips a stored row by, EDGE-17) and its built-in
// fallback (DEFAULT_SLA_DAYS); the clock warns at SLA_WARN_FRACTION of the
// window, a fixed constant — so the table's warn_before_days column, which no
// code reads, is not offered.
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
import { SLA_CLOCK_COLUMN, SLA_CLOCK_MIGRATION, SLA_WARN_FRACTION, effectiveTarget, warnAt } from "@/lib/ticketSla";
import { BUILTIN_REQUEST_TYPES } from "@/lib/ticketCreate";
import type { SelectOption } from "@/types/schema";

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

/** How long after filing the SLA clock warns an open request it times by a
 *  `days` window from its filing date (one with no due date of its own), in
 *  ms. Computed by the clock's own functions (lib/ticketSla.ts effectiveTarget
 *  and warnAt) — never rounded — so the page states the instant the clock
 *  compares against. */
export function warnAfterMs(days: number): number {
  const filed = Date.UTC(2026, 0, 1);
  const t = { id: "window", orgId: "window", status: "DRAFTING", requestType: "window", createdAt: new Date(filed).toISOString() };
  const target = effectiveTarget(t, new Map([["window", days]]));
  return target === null ? 0 : warnAt(t, target) - filed;
}

/** A span as days, hours and minutes ("2 days and 6 hours", "18 hours"). A
 *  window of whole days at the 75 % warn fraction is always whole hours, so
 *  nothing is rounded away (pinned for 1–3650). */
export function formatSpan(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const parts = [
    Math.floor(totalMin / 1440) ? unit(Math.floor(totalMin / 1440), "day") : "",
    Math.floor((totalMin % 1440) / 60) ? unit(Math.floor((totalMin % 1440) / 60), "hour") : "",
    totalMin % 60 ? unit(totalMin % 60, "minute") : "",
  ].filter(Boolean);
  if (parts.length === 0) return "0 minutes";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The warning point the clock uses for a `days` window, as the editor says
 *  it: the exact time after filing (warnAfterMs). */
export function warnAfterLabel(days: number): string {
  return formatSpan(warnAfterMs(days));
}

/** Where a request type in the editor comes from: the SAVED request form, the
 *  built-in vocabulary the create route accepts whatever the form lists
 *  (lib/ticketCreate.ts BUILTIN_REQUEST_TYPES — check-in's "Revision" and
 *  "ASBUILT", and "RFI"), or a stored window for a type on neither. */
export type SlaTypeSource = "form" | "builtin" | "stored";
export interface SlaEditorType { value: string; label: string; source: SlaTypeSource }

/** The types the editor lists, each once, in this order: the request types on
 *  the SAVED form (blank values skipped — never an unsaved edit of it), then
 *  every built-in type not on it, then any stored window whose type is on
 *  neither (so it can be removed). Every type the create route reads
 *  sla_defaults for — a form type or a built-in one — can be configured. */
export function slaEditorTypes(savedOptions: readonly SelectOption[], rows: readonly SlaDefaultRow[]): SlaEditorType[] {
  const out: SlaEditorType[] = [];
  const listed = (value: string) => out.some((t) => t.value === value);
  for (const o of savedOptions) {
    const value = String(o.value ?? "").trim();
    if (value && !listed(value)) out.push({ value, label: o.label || value, source: "form" });
  }
  for (const value of BUILTIN_REQUEST_TYPES) {
    if (!listed(value)) out.push({ value, label: value, source: "builtin" });
  }
  for (const r of rows) {
    if (!listed(r.requestType)) out.push({ value: r.requestType, label: r.requestType, source: "stored" });
  }
  return out;
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

/** Whether the SLA clock has started, read exactly as the clock's own gate
 *  reads it (lib/ticketSla.ts runTicketSlaScan, step 0): SLA_CLOCK_COLUMN on
 *  tickets exists once SLA_CLOCK_MIGRATION (20261195) is pasted. Before that
 *  the nightly run sends nothing, and the paste itself records every open
 *  request then past its window as overdue WITHOUT a notice of its own, with
 *  ONE summary notice to each workspace's assignment queue (20261195 §5).
 *  "unknown": the probe failed for another reason. */
export type SlaClockRead =
  | { state: "started" }
  | { state: "not_started" }
  | { state: "unknown"; error: string };

export async function slaClockState(sb: SupabaseClient): Promise<SlaClockRead> {
  const { error } = await sb.from("tickets").select(SLA_CLOCK_COLUMN).limit(1);
  if (!error) return { state: "started" };
  const code = (error as { code?: string }).code;
  if ((code === "42703" || code === "PGRST204") && (error.message ?? "").includes(SLA_CLOCK_COLUMN)) return { state: "not_started" };
  return { state: "unknown", error: error.message };
}

/** The question the editor asks before saving `days` for a type, or null when
 *  nothing would fall due (EDGE-7's residual). What happens to the requests
 *  it counts depends on whether the SLA clock has started (slaClockState):
 *  once it has, the nightly run sends each its own notice, starting with its
 *  next run (a run that stops at its read cap or its time leaves the rest for
 *  the runs after it, lib/ticketSla.ts); before it has, nothing is sent until
 *  20261195 is pasted, and that paste records the ones then past their window
 *  as overdue with one summary notice to the queue — never a notice each. The
 *  warning point is said exactly as the clock computes it (warnAfterLabel). */
export function untargetedImpactQuestion(
  label: string,
  days: number,
  impact: { ok: true; impact: SlaUntargetedImpact } | { ok: false; error: string },
  clock: SlaClockRead,
): string | null {
  const M = SLA_CLOCK_MIGRATION;
  const started = `the nightly SLA run (the maintenance job) records each as overdue and sends an "Overdue" notice to the person it waits on, the assignment queue and the requester, starting with its next run`;
  const atClockStart = `recorded as overdue without a notice of their own, and the workspace's assignment queue gets one summary notice naming how many`;
  const notStarted = `The SLA clock has not started yet (migration ${M} is not applied), so nothing is sent for them now`;
  const warnPoint = `the warning point (${warnAfterLabel(days)} after filing)`;
  if (!impact.ok) {
    const lead = `Whether this window puts open ${label} requests with no due date of their own past due could not be checked (${impact.error}).`;
    const nightly = `are recorded as overdue with an "Overdue" notice by the nightly SLA run (the maintenance job), starting with its next run`;
    const atPaste = `when ${M} is applied, any filed more than ${days} day(s) before then are ${atClockStart}`;
    const tail =
      clock.state === "started"
        ? `Any filed more than ${days} day(s) ago ${nightly}.`
        : clock.state === "not_started"
          ? `${notStarted}: ${atPaste}.`
          : `Whether the SLA clock has started could not be read either (${clock.error}): if it has, any filed more than ${days} day(s) ago ${nightly}; if it has not, ${atPaste}.`;
    return `${lead} ${tail} Save anyway?`;
  }
  const { overdue, dueSoon } = impact.impact;
  if (overdue + dueSoon === 0) return null;
  const lead = `${overdue} open ${label} request(s) with no due date of their own were filed more than ${days} day(s) ago`;
  if (clock.state === "started") {
    return `${lead}: ${started}. ${dueSoon} more are past ${warnPoint}: each gets a "Due soon" notice, or the "Overdue" one if the run reaches it after its due date. Save anyway?`;
  }
  const atPaste = `when ${M} is applied, the ones then past this window are ${atClockStart}`;
  const soon = `${dueSoon} more are past ${warnPoint}: once the clock has started, the SLA run sends each one still inside this window a "Due soon" notice.`;
  if (clock.state === "not_started") {
    return `${lead}. ${notStarted}: ${atPaste}. ${soon} Save anyway?`;
  }
  return `${lead}. Whether the SLA clock has started could not be read (${clock.error}): if it has, ${started}; if it has not, ${atPaste}. ${soon} Save anyway?`;
}
