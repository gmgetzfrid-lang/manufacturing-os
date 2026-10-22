// lib/issueNoticeExamination.ts
//
// drafting-flow Round G, DF-P26 ISSUING-PATH STOPS — GAP-102 acceptance 2
// (DEC-90 ruling (3) for DF-P26): the issue notice carries the request's
// recorded examination data.
//
// When a request ISSUES — an issuing approval or the roster sign-off that
// completes the review (the workflow route's fan-out), or the consent
// window's close that completes it (lib/consentWindowScan.ts) — the notice
// people already get (the existing `ticket_status` bell row and the
// `ticket_approved` email; no new notification kind) gains ONE line naming
// what was recorded about its examination:
//   * the examination-scope values (ticket_examination_scopes, DF-P24), by
//     the workspace's own field and value labels;
//   * each assurance sign-off's record on the roster that issued it
//     (ticket_review_slot_events details.examination, DF-P20) — the slot's
//     label and how many files were examined of how many;
//   * how many holds the people of a notify-only slot placed on the source
//     document with what they examined for this request (DF-P25).
// Names and counts only — never a note, a file name, a waiver's reason or a
// hold's description (the notice reaches people the record's author did not
// choose).
//
// A request with none of these — every request of a workspace that
// configures nothing — sends exactly today's notice: each read happens only
// where that kind of record could exist (examination fields configured; an
// assurance slot on the issuing roster; an opted-in notify-only slot and a
// source document), and with nothing found there is no line (pinned).
// Bookkeeping never blocks or delays the act (DEC-90 ruling (4)): it runs
// after the act has landed, any read that fails leaves its part out, and the
// whole read is bounded (ISSUE_EXAMINATION_DEADLINE_MS) — past it the notice
// goes out as today's.

import type { Ticket, TicketReviewRoster } from "@/types/schema";
import { parseExaminationScopeConfig, parseScopeValues, scopeValueOf } from "@/lib/examinationScope";
import { isAssuranceSlot, rosterHasAssuranceSlot, examinationOf, holdExaminationOf, holdOpenerInSlot, rosterOccupancy } from "@/lib/assuranceExamination";
import { holdStopScope } from "@/lib/requestHoldStop";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };

/** How long the issue notice waits for its examination line at most. */
export const ISSUE_EXAMINATION_DEADLINE_MS = 2500;
/** How many holds are counted at most. */
const HOLD_COUNT_LIMIT = 100;

/** What the issue notice names — names and counts only. */
export interface IssueExaminationSummary {
  /** field label → value label, in the workspace's field order */
  scope: Array<{ field: string; value: string }>;
  /** one per assurance slot that recorded what it examined */
  assurance: Array<{ slot: string; examined: number; of: number; defaulted: boolean }>;
  /** holds placed by a notify-only slot's people with this request's record */
  holds: { total: number; open: number };
}

const fileCount = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** The one line the notice carries, or null when nothing was recorded (the
 *  notice is then exactly today's). Pure. */
export function issueExaminationLine(s: IssueExaminationSummary): string | null {
  const parts: string[] = [];
  if (s.scope.length > 0) parts.push(`Examination data: ${s.scope.map((x) => `${x.field}: ${x.value}`).join("; ")}.`);
  if (s.assurance.length > 0) {
    parts.push(`Assurance records: ${s.assurance.map((a) => (a.of === 0 && a.examined === 0
      ? `${a.slot} (no files were under review)`
      : a.defaulted
        ? `${a.slot} (files under review: ${fileCount(a.of)}, not narrowed)`
        : `${a.slot} (examined ${a.examined === a.of ? `all ${fileCount(a.of)}` : `${a.examined} of ${fileCount(a.of)}`})`)).join("; ")}.`);
  }
  if (s.holds.total > 0) {
    const released = s.holds.total - s.holds.open;
    parts.push(`Holds placed on the source document with what was examined: ${s.holds.total}${s.holds.open > 0 ? ` (${s.holds.open} still in force)` : released === s.holds.total ? " (released)" : ""}.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Would any read be made for this request? (No → no line, no read.) Pure. */
export function issueExaminationMayExist(input: { ticket: Ticket; draftingCfg: Record<string, unknown> | null; roster: TicketReviewRoster | null }): boolean {
  return parseExaminationScopeConfig(input.draftingCfg).fields.length > 0
    || (!!input.roster && rosterHasAssuranceSlot(input.roster, input.ticket))
    || !!holdStopScope(input.ticket);
}

/**
 * Read what was recorded and summarise it. Every read is conditional (see
 * the header) and every failure leaves its part out — never throws.
 *   `ticket`  — the request as it stood before the issuing act;
 *   `roster`  — the roster that issued it (the completing sign-off's), or null.
 */
export async function readIssueExamination(db: Db, input: { ticket: Ticket; ticketId: string; orgId: string; draftingCfg: Record<string, unknown> | null; roster: TicketReviewRoster | null }): Promise<IssueExaminationSummary> {
  const out: IssueExaminationSummary = { scope: [], assurance: [], holds: { total: 0, open: 0 } };
  const { ticket, ticketId, orgId, roster } = input;
  // 1. The examination-scope values, by the workspace's own labels.
  const config = parseExaminationScopeConfig(input.draftingCfg);
  if (config.fields.length > 0) {
    try {
      const { data, error } = await db.from("ticket_examination_scopes").select("field_values").eq("ticket_id", ticketId).maybeSingle();
      if (!error && data) {
        const values = parseScopeValues((data as { field_values?: unknown }).field_values);
        for (const f of config.fields) {
          const v = scopeValueOf(values, f.key);
          if (!v) continue;
          out.scope.push({ field: f.label, value: f.options.find((o) => o.value === v.value)?.label ?? v.value });
        }
      }
    } catch { /* left out */ }
  }
  // 2. Each assurance slot's record on the roster that issued the request.
  if (roster && rosterHasAssuranceSlot(roster, ticket)) {
    const kinds = new Map(roster.slots.filter((s) => isAssuranceSlot(s, ticket)).map((s) => [s.kind, s.label || s.kind]));
    try {
      const { data, error } = await db.from("ticket_review_slot_events").select("slot_kind, details, created_at")
        .eq("ticket_id", ticketId).eq("roster_id", roster.id).eq("event", "satisfied").in("slot_kind", [...kinds.keys()]).order("created_at", { ascending: true });
      if (!error) {
        const latest = new Map<string, ReturnType<typeof examinationOf>>();
        for (const e of (data ?? []) as Array<{ slot_kind: string; details?: unknown }>) {
          const rec = examinationOf(e.details);
          if (rec) latest.set(e.slot_kind, rec);
        }
        for (const [kind, label] of kinds) {
          const rec = latest.get(kind);
          if (!rec) continue;
          out.assurance.push({ slot: label, examined: rec.files.length, of: rec.ofFiles, defaulted: rec.defaulted === true });
        }
      }
    } catch { /* left out */ }
  }
  // 3. Holds the notify-only slot's people placed with this request's record.
  const scope = holdStopScope(ticket);
  if (scope) {
    try {
      const { data, error } = await db.from("document_holds").select("opened_by, released_at, examination")
        .eq("org_id", orgId).eq("document_id", scope.sourceId).eq("examination->>ticketId", ticketId).limit(HOLD_COUNT_LIMIT);
      if (!error) {
        const occupancy = rosterOccupancy(scope.roster);
        for (const h of (data ?? []) as Array<{ opened_by?: string | null; released_at?: string | null; examination?: unknown }>) {
          const rec = holdExaminationOf(h.examination, ticketId);
          if (!rec || holdOpenerInSlot(h.opened_by, rec, occupancy) !== "slot") continue;
          out.holds.total += 1;
          if (!h.released_at) out.holds.open += 1;
        }
      }
    } catch { /* left out */ }
  }
  return out;
}

/** The line for one issue, or null: no read where nothing could exist; past
 *  the deadline or on any failure, null (today's notice). */
export async function issueExaminationNote(db: Db, input: Parameters<typeof readIssueExamination>[1], deadlineMs: number = ISSUE_EXAMINATION_DEADLINE_MS): Promise<string | null> {
  if (!issueExaminationMayExist(input)) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); });
    const summary = await Promise.race([readIssueExamination(db, input), late]);
    return summary ? issueExaminationLine(summary) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
