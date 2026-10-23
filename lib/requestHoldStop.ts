// lib/requestHoldStop.ts
//
// drafting-flow Round G, DF-P26 ISSUING-PATH STOPS — GAP-116 (DEC-90 ruling
// (2) for DF-P26): a notify-only hold that stops the REQUEST, not only its
// document.
//
// DF-P25 gave the people of a notify-only routing slot opted in to recording
// what they examined (lib/assuranceExamination.ts isNotifyExaminationSlot) a
// hold on the request's SOURCE document that carries what they examined, in
// the hold's own insert (document_holds.examination, 20261267). Until now
// that hold stopped work on the document only (no new revision published,
// not transmitted or shared) — nothing on the request's issuing path read it.
//
// Now every issuing path asks this module first — the workflow route's
// issuing approvals (ISSUING_APPROVALS) and a roster sign-off that would
// complete the review (its dry run too), and the consent window's close that
// would issue (lib/consentWindowScan.ts). While an OPEN hold
// (released_at IS NULL) on the request's source document carries THIS
// request's examination record AND was placed by one of the people of the
// notify-only slot that record names, in the round it names
// (holdOpenerInSlot — the same rule the roster panel uses to show a record
// as a slot's stop), the issue is refused with a plain sentence naming the
// hold and who can release it. Releasing the hold lets it proceed.
//
// Read ONLY where such a record could exist: the request names a source
// document (a uuid) and the roster on record carries a notify-only slot
// opted in to recording what its people examined — or (DF-P26 fix pass 2)
// an earlier round's roster did (`notifyHoldRecordsEarlier`, carried
// forward by carryNotifyHoldMark when the route opens a new roster), so a
// hold placed then still stops the request after the routing drops the
// opt-in. Every other request —
// every request today — reads nothing and decides nothing here
// (`{ kind: "none" }`), so its outcome is byte-identical (pinned by an A/B
// sweep). Where a record could exist, a read that fails (the holds, or an
// earlier round's ledger rows needed to judge a record) is "unreadable": a
// retry (503 on the route; the window is not closed at the consent close),
// never a silent pass, and never a refusal of anything that is not an issue.
// Before 20261267 (the column is missing — 42703 / PGRST204) no hold can
// carry a record, so nothing stops the request (`clear`).
//
// Document Control's forced publish past a hold (lib/documentGuards.ts) is a
// different door and is unchanged. Server-only (issueHoldStopGate previews a
// sign-off through lib/ticketRoster.ts, which uses node:crypto).

import type { Ticket, TicketReviewRoster } from "@/types/schema";
import { parseSourceDocument } from "@/lib/sourceDocRef";
import { ISSUING_APPROVALS } from "@/lib/workflow";
import { signOffWouldComplete } from "@/lib/examinationScopeGate";
import {
  rosterOnRecord, isNotifyExaminationSlot, holdExaminationOf, holdOpenerInSlot, rosterOccupancy, type SlotOccupancy,
} from "@/lib/assuranceExamination";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many open holds on the source document naming this request are read
 *  at once. DF-P26 fix pass 4: a full page is followed by the next (keyset
 *  on the hold's id), so holds placed by people outside the slot never make
 *  the record unreadable however many there are — every page is judged. */
export const REQUEST_HOLD_READ_LIMIT = 100;
/** A runaway guard only: more pages than this (10,000 open holds naming one
 *  request) is "unreadable" — a retry, never a pass. */
export const REQUEST_HOLD_PAGE_CAP = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any };

/** One open hold that stops the request. */
export interface StoppingHold {
  id: string;
  reason: string;
  openedBy: string;
  openedAt: string | null;
  /** the slot's label as its round named it */
  slotLabel: string;
  /** the opener's name from the member list, or null when it gave none */
  openerName: string | null;
}

export type RequestHoldStop =
  /** No record could exist (no source document, or no opted-in notify-only
   *  slot on the roster on record): nothing was read. */
  | { kind: "none" }
  /** Read: no open hold of the slot's people carries this request's record. */
  | { kind: "clear" }
  /** An open hold of the slot's people carries this request's record. */
  | { kind: "stopped"; holds: StoppingHold[]; documentLabel: string; refusal: string }
  /** A read where a record could exist failed — a retry, never a pass. */
  | { kind: "unreadable"; error: string };

/** Could a hold with this request's examination record exist under this
 *  roster: it carries an opted-in notify-only slot, or (DF-P26 fix pass 2)
 *  an earlier round did (`notifyHoldRecordsEarlier`, carried forward when a
 *  new roster opens — a hold placed then keeps stopping the request after
 *  the routing drops the opt-in). Pure. */
export function couldHoldNotifyRecord(roster: Pick<TicketReviewRoster, "slots" | "notifyHoldRecordsEarlier">, ticket: Pick<Ticket, "requesterId">): boolean {
  return roster.notifyHoldRecordsEarlier === true || roster.slots.some((s) => isNotifyExaminationSlot(s, ticket));
}

/** The roster a submission opens, marked when the roster on record (the
 *  request's previous round) could hold such a record; otherwise the very
 *  same object (every request whose earlier rounds carried no opted-in
 *  notify-only slot — its new roster is today's, byte for byte). Pure. */
export function carryNotifyHoldMark(opened: TicketReviewRoster, ticket: Pick<Ticket, "metadata" | "requesterId">): TicketReviewRoster {
  const previous = rosterOnRecord(ticket);
  if (!previous || previous.id === opened.id || !couldHoldNotifyRecord(previous, ticket)) return opened;
  return { ...opened, notifyHoldRecordsEarlier: true };
}

/** Where a record could exist: the source document's id and the roster on
 *  record, or null (nothing to read). Pure. */
export function holdStopScope(ticket: Pick<Ticket, "metadata" | "requesterId">): { sourceId: string; documentLabel: string; roster: TicketReviewRoster } | null {
  const roster = rosterOnRecord(ticket);
  if (!roster || !couldHoldNotifyRecord(roster, ticket)) return null;
  const src = parseSourceDocument(ticket.metadata as Record<string, unknown> | null | undefined);
  if (!src?.id || !UUID_RE.test(src.id)) return null;
  return { sourceId: src.id, documentLabel: src.documentNumber || "The source document", roster };
}

/** Before 20261267: the hold has no examination column (no record can exist). */
export function isMissingHoldExamination(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  return (code === "42703" || code === "PGRST204") && /examination/.test(String(err.message ?? ""));
}

/** The plain sentence an issue refused by such a hold carries. Pure. */
export function requestHoldRefusal(documentLabel: string, holds: readonly StoppingHold[]): string {
  const first = holds[0];
  const who = first.openerName || `a member of ${first.slotLabel}`;
  const more = holds.length > 1 ? ` (and ${holds.length - 1} more hold${holds.length === 2 ? "" : "s"} like it)` : "";
  return `${documentLabel} is on hold (${first.reason}), placed by ${who} for ${first.slotLabel} with what they examined for this request${more}. The hold stops this request: it cannot issue until the hold is released. The person who placed it, or anyone allowed to release holds, can release it on the document — then try again.`;
}

/**
 * The slot occupancy a hold's record is judged against (holdOpenerInSlot):
 * the roster on record's own slots, plus — for any record naming an earlier
 * round — that round's slots from the roster ledger (ticket_review_slots).
 * The ledger is read only when a record names an earlier round. Shared by
 * the stop (where a failed read is "unreadable") and the issue notice
 * (lib/issueNoticeExamination.ts — where it is left out). Never throws.
 */
export async function holdRecordOccupancy(
  db: Db,
  input: { orgId: string; ticketId: string; roster: TicketReviewRoster; records: ReadonlyArray<{ rosterId?: string | null }> },
): Promise<{ ok: true; occupancy: SlotOccupancy[] } | { ok: false; error: string }> {
  const current = rosterOccupancy(input.roster);
  const earlier = [...new Set(input.records.map((r) => r.rosterId).filter((r): r is string => !!r && r !== input.roster.id))];
  if (earlier.length === 0) return { ok: true, occupancy: current };
  let slots: { data: unknown; error: { message?: string } | null };
  try {
    slots = await db.from("ticket_review_slots")
      .select("roster_id, slot_kind, label, mode, primaries, alternates")
      .eq("org_id", input.orgId).eq("ticket_id", input.ticketId).in("roster_id", earlier);
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
  if (slots.error) return { ok: false, error: slots.error.message || "the review ledger could not be read" };
  const ledger: SlotOccupancy[] = ((slots.data ?? []) as Array<{ roster_id: string; slot_kind: string; label?: string | null; mode: string; primaries?: string[] | null; alternates?: string[] | null }>)
    .map((r) => ({ rosterId: r.roster_id, kind: r.slot_kind, mode: r.mode, primaries: r.primaries ?? [], alternates: r.alternates ?? [], label: r.label ?? null }));
  return { ok: true, occupancy: [...current, ...ledger] };
}

/**
 * Does an open hold of a notify-only slot's people stop this request? Reads
 * (as the caller's client — the service role on the route and the cron):
 * the open holds on the source document whose record names this request
 * (filtered in the query), the roster ledger rows of any earlier round a
 * record names (to judge its opener), and the openers' names (member list —
 * a failed name read only leaves the name out; bookkeeping never decides).
 */
export async function requestHoldStop(db: Db, input: { ticket: Ticket; ticketId: string; orgId: string }): Promise<RequestHoldStop> {
  const scope = holdStopScope(input.ticket);
  if (!scope) return { kind: "none" };
  const { ticketId, orgId } = input;
  type HoldRow = { id: string; reason?: string | null; opened_by?: string | null; opened_at?: string | null; examination?: unknown };
  // DF-P26 fix pass 4: every open hold naming this request is read, page by
  // page (keyset on id), never only the first page — a pile of holds placed
  // by people outside the slot neither stops the request nor makes it
  // unreadable.
  const rows: HoldRow[] = [];
  let after: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= REQUEST_HOLD_PAGE_CAP) return { kind: "unreadable", error: `more than ${REQUEST_HOLD_READ_LIMIT * REQUEST_HOLD_PAGE_CAP} open holds name this request` };
    let read: { data: unknown; error: { code?: string; message?: string } | null };
    try {
      let q = db.from("document_holds")
        .select("id, reason, opened_by, opened_at, examination")
        .eq("org_id", orgId).eq("document_id", scope.sourceId).eq("examination->>ticketId", ticketId).is("released_at", null);
      if (after !== null) q = q.gt("id", after);
      read = await q.order("id", { ascending: true }).limit(REQUEST_HOLD_READ_LIMIT);
    } catch (e) {
      return { kind: "unreadable", error: (e as Error)?.message ?? String(e) };
    }
    if (read.error) {
      if (isMissingHoldExamination(read.error)) return { kind: "clear" };
      return { kind: "unreadable", error: read.error.message || "the holds could not be read" };
    }
    const pageRows = (read.data ?? []) as HoldRow[];
    rows.push(...pageRows);
    if (pageRows.length < REQUEST_HOLD_READ_LIMIT) break;
    const last = String(pageRows[pageRows.length - 1]?.id ?? "");
    // A page that does not move past the last one read proves nothing.
    if (!last || (after !== null && last <= after)) return { kind: "unreadable", error: "the holds could not be read page by page" };
    after = last;
  }
  const records = rows.map((h) => ({ h, rec: holdExaminationOf(h.examination, ticketId) })).filter((x) => x.rec !== null) as Array<{ h: typeof rows[number]; rec: NonNullable<ReturnType<typeof holdExaminationOf>> }>;
  // An earlier round's slots come from the roster ledger.
  const occ = await holdRecordOccupancy(db, { orgId, ticketId, roster: scope.roster, records: records.map((x) => x.rec) });
  if (!occ.ok) return { kind: "unreadable", error: occ.error };
  const occupancy = occ.occupancy;
  // (read by id; named oldest first, as before)
  const stopping = records.filter((x) => holdOpenerInSlot(x.h.opened_by, x.rec, occupancy) === "slot")
    .sort((a, b) => String(a.h.opened_at ?? "\uffff").localeCompare(String(b.h.opened_at ?? "\uffff")) || String(a.h.id).localeCompare(String(b.h.id)));
  if (stopping.length === 0) return { kind: "clear" };
  const openers = [...new Set(stopping.map((x) => String(x.h.opened_by)))];
  const names = new Map<string, string>();
  try {
    const { data: mem, error: memErr } = await db.from("org_members").select("uid, display_name, email").eq("org_id", orgId).in("uid", openers);
    if (!memErr) {
      for (const m of (mem ?? []) as Array<{ uid: string; display_name?: string | null; email?: string | null }>) {
        const n = (m.display_name ?? "").trim() || (m.email ?? "").split("@")[0];
        if (n) names.set(m.uid, n);
      }
    }
  } catch { /* the names are bookkeeping: left out */ }
  const holds: StoppingHold[] = stopping.map(({ h, rec }) => ({
    id: h.id,
    reason: (h.reason ?? "").trim() || "hold",
    openedBy: String(h.opened_by),
    openedAt: h.opened_at ?? null,
    slotLabel: occupancy.find((o) => o.rosterId === rec.rosterId && o.kind === rec.slotKind)?.label || rec.slotKind || "a notify-only slot",
    openerName: names.get(String(h.opened_by)) ?? null,
  }));
  return { kind: "stopped", holds, documentLabel: scope.documentLabel, refusal: requestHoldRefusal(scope.documentLabel, holds) };
}

/**
 * The workflow route's hold stop in ONE call (so the A/B regression sweep can
 * switch it off whole): an issuing approval, or a roster sign-off that would
 * complete the review (its dry run too — no e-signature is minted for a
 * refused sign-off), on a request where a record could exist. Every other
 * action — and every request where no record could exist — is `none`, with
 * nothing read and nothing previewed.
 */
export async function issueHoldStopGate(db: Db, input: { action: string; ticket: Ticket; ticketId: string; callerId: string; sodActive: boolean }): Promise<RequestHoldStop> {
  const approval = ISSUING_APPROVALS.has(input.action);
  if (!approval && input.action !== "sign_slot") return { kind: "none" };
  if (!holdStopScope(input.ticket)) return { kind: "none" };
  if (!approval && !signOffWouldComplete(input.ticket, input.callerId, input.sodActive)) return { kind: "none" };
  return requestHoldStop(db, { ticket: input.ticket, ticketId: input.ticketId, orgId: input.ticket.orgId });
}
