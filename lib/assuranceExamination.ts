// lib/assuranceExamination.ts
//
// drafting-flow Round G, DF-P20 ASSURANCE EXAMINATION RECORD — GAP-102
// acceptances 1 and 4 as the integrator assigned them at the DF-P6 merge
// (DEC-31): what an assurance reviewer examined, recorded with the sign-off
// or the veto it backs. The integrator's rulings for DF-P20 (DEC-90):
//
//   (1) the record rides the slot EVENT the reviewer creates — the
//       append-only ledger `ticket_review_slot_events` (20261242) — in its
//       existing `details` jsonb, in the same insert as the sign-off
//       ("satisfied") or the veto (the "voided" rows a revision request
//       writes), so the record and the act can never disagree. No new
//       table, no new column, no migration;
//   (2) the record holds the reviewed version's sha256 exactly as the roster
//       computed it when it opened (`roster.contentHash`, and each file's
//       own sha256 from `roster.files` — DF-P5's bounded hashing; nothing is
//       hashed again here), the files examined (chosen from the reviewed
//       version's files: all by default, the reviewer may narrow), the
//       reviewer's note, and for a veto a REQUIRED note (trimmed);
//   (3) a slot that is not an assurance slot — and every request with no
//       assurance slot — behaves and renders exactly as before; an event
//       written before this shipped renders "Examination not recorded".
//
// An ASSURANCE SLOT is a property of the slot, never of its name (DEC-35),
// and never inferred (DF-P20 fix pass 2): a BLOCKING roster slot whose
// routing slot carries the controller's explicit opt-in
// (lib/routingControl.ts `records_examination`, set in the routing editor;
// copied to the roster slot as `recordsExamination` when the roster opens).
// The opt-in is refused on a notify-only or consent-window slot and on a
// slot only the requester fills; on top of it, the engineering sign-off (a
// slot filled by ticket.final_approve / ticket.eng_review, or the gate the
// roster appended — `engineering: true`) and a slot whose people resolved to
// the requester alone never record one. So no existing roster changes when
// this ships: a slot without the opt-in behaves and renders exactly as
// before (ruling (3)), whatever its mode, fill or label.
//
// A veto's note that falls back to the revision request's own comment is
// never a reason to refuse the revision request (bookkeeping never blocks a
// person's act — DEC-90): past EXAMINATION_NOTE_MAX it is kept shortened,
// marked `noteTruncated` (the comment itself is stored whole on the ticket).
// Only a note the reviewer typed into the record (the panel caps it) is
// length-checked.
//
// Pure, and safe for the browser (the roster panel imports it; lib/
// ticketRoster.ts hashes with node:crypto and cannot be imported there).

import type { Ticket, TicketReviewRoster, TicketReviewSlot } from "@/types/schema";

/** The longest note a record keeps. */
export const EXAMINATION_NOTE_MAX = 2000;

/** What the request page says for an assurance sign-off whose event carries
 *  no record — one written before DF-P20 shipped. Never an error. */
export const EXAMINATION_NOT_RECORDED = "Examination not recorded";

/** DF-P20 merge-time fix pass: what the request page says for an assurance
 *  sign-off whose ledger write the route just reported as failed — the
 *  record is on the transition's audit row (`details.reviewRoster.
 *  examination`) until a reconciliation copies it to the event. Never
 *  "not recorded" for that act. */
export const EXAMINATION_NOT_READ_YET = "Examination record could not be read yet";

/** What a reviewer examined, as it is stored on the slot event
 *  (`details.examination`) and repeated on the transition's audit row. */
export interface ExaminationRecord {
  v: 1;
  /** "sign_off" — recorded with a sign-off; "veto" — with a revision request. */
  act: "sign_off" | "veto";
  /** The reviewed version's sha256 — the roster's content hash, as computed
   *  when the roster opened (every sign-off's e-signature is bound to it). */
  contentHash: string;
  /** The revision under review, as the roster names it. */
  cycle: string | null;
  /** The files examined, in the roster's order, each with the sha256 the
   *  roster recorded (null for a file bound by identity — EVID-12). */
  files: Array<{ id: string | null; name: string | null; sha256: string | null }>;
  /** How many files were under review (so "2 of 3" reads without the roster). */
  ofFiles: number;
  /** True when every file under review was examined (the default). */
  allFiles: boolean;
  /** The reviewer's note (trimmed); always present for a veto. */
  note: string | null;
  /** True when the note is the first EXAMINATION_NOTE_MAX characters of a
   *  longer revision comment (the comment is kept whole on the ticket).
   *  Absent otherwise. */
  noteTruncated?: true;
  /** DF-P20 fix pass 2: true when the act carried no examination body (the
   *  page's own Request Revision, an API caller): the files listed are every
   *  file under review, but the reviewer was never asked which they examined
   *  — it reads "Files under review", never "Examined". Absent otherwise. */
  defaulted?: true;
  /** DF-P20 fix pass 2: the slot's label as the roster named it, written per
   *  slot on its event (lib/ticketRoster.ts writeRosterLedger), so an earlier
   *  round reads by it once its roster is gone. Absent on the audit row. */
  slotLabel?: string;
}

/** The slot only the requester fills — "Is this what you asked for?" (the
 *  roster panel's slotQuestion uses the same rule). */
export function requesterOnlySlot(slot: Pick<TicketReviewSlot, "primaries">, ticket: Pick<Ticket, "requesterId">): boolean {
  return slot.primaries.length === 1 && slot.primaries[0] === ticket.requesterId;
}

/** True for an assurance slot (see the header): a blocking slot the
 *  controller opted in (`recordsExamination`), not the engineering approval,
 *  not the requester's own acceptance. Pure. */
export function isAssuranceSlot(slot: Pick<TicketReviewSlot, "primaries" | "engineering" | "mode" | "recordsExamination">, ticket: Pick<Ticket, "requesterId">): boolean {
  return slot.recordsExamination === true && slot.mode === "blocking" && slot.engineering !== true && !requesterOnlySlot(slot, ticket);
}

/** True when the roster carries at least one assurance slot. */
export function rosterHasAssuranceSlot(roster: Pick<TicketReviewRoster, "slots"> | null | undefined, ticket: Pick<Ticket, "requesterId">): boolean {
  return !!roster && Array.isArray(roster.slots) && roster.slots.some((s) => isAssuranceSlot(s, ticket));
}

/** The roster the ticket carries — open, complete or closed (unlike
 *  lib/workflow.ts currentRoster, which answers only for one under review). */
export function rosterOnRecord(ticket: Pick<Ticket, "metadata">): TicketReviewRoster | null {
  const r = (ticket.metadata as Record<string, unknown> | undefined)?.review_roster as TicketReviewRoster | undefined;
  return r && typeof r === "object" && r.v === 1 && Array.isArray(r.slots) && Array.isArray(r.files) ? r : null;
}

/** How a file under review is named in an examination request: its
 *  attachment id, else its storage key. */
export const examinationFileKey = (f: { id?: string | null; url?: string | null }): string => f.id ?? f.url ?? "";

/**
 * Build the record a sign-off or a veto carries, from the roster under review
 * and what the client sent (`{ files?: string[]; note?: string }`, or nothing:
 * every file, no note — marked `defaulted` whenever no file list was sent, so
 * it never reads as the reviewer's choice). `files` names files by
 * examinationFileKey; one that is
 * not under review, an empty list, or a malformed field is refused with the
 * reason (the client is stale or wrong — a record must never name files the
 * roster did not bind). A veto's note is the client's note, else the revision
 * request's comment; one with neither is refused. Pure.
 */
export function buildExaminationRecord(
  roster: Pick<TicketReviewRoster, "contentHash" | "cycle" | "files">,
  raw: unknown,
  opts: { act: "sign_off" | "veto"; comment?: string | null },
): { ok: true; record: ExaminationRecord } | { ok: false; error: string } {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, error: "The record of what you examined is not in the expected shape — reload the request and try again." };
  }
  const o = (raw ?? {}) as { files?: unknown; note?: unknown };
  const all = roster.files ?? [];
  let picked = all;
  if (o.files !== undefined && o.files !== null) {
    if (!Array.isArray(o.files) || !o.files.every((x) => typeof x === "string")) {
      return { ok: false, error: "The files you examined must be a list of the files under review." };
    }
    const want = new Set(o.files as string[]);
    if (want.size === 0) return { ok: false, error: "Mark at least one file you examined." };
    const known = new Set(all.map(examinationFileKey));
    if ([...want].some((k) => !known.has(k))) {
      return { ok: false, error: "A file you marked as examined is not one of the files under review — reload the request and try again." };
    }
    picked = all.filter((f) => want.has(examinationFileKey(f)));
  }
  let note: string | null = null;
  if (o.note !== undefined && o.note !== null) {
    if (typeof o.note !== "string") return { ok: false, error: "The note must be text." };
    note = o.note.trim() || null;
  }
  // Only the note the reviewer typed into the record is length-checked.
  if (note && note.length > EXAMINATION_NOTE_MAX) return { ok: false, error: `The note is longer than ${EXAMINATION_NOTE_MAX} characters.` };
  // A veto's note falls back to the revision comment — never refused for its
  // length (the revision request works as before): kept shortened, marked.
  let noteTruncated = false;
  if (opts.act === "veto" && !note) {
    note = (opts.comment ?? "").trim() || null;
    if (note && note.length > EXAMINATION_NOTE_MAX) { note = note.slice(0, EXAMINATION_NOTE_MAX); noteTruncated = true; }
  }
  if (opts.act === "veto" && !note) return { ok: false, error: "A revision request must say why — add a note." };
  // No file list sent: every file is listed, but nobody chose it.
  const defaulted = o.files === undefined || o.files === null;
  return {
    ok: true,
    record: {
      v: 1,
      act: opts.act,
      contentHash: roster.contentHash,
      cycle: roster.cycle ?? null,
      files: picked.map((f) => ({ id: f.id ?? null, name: f.name ?? null, sha256: f.sha256 ?? null })),
      ofFiles: all.length,
      allFiles: picked.length === all.length,
      note,
      ...(noteTruncated ? { noteTruncated: true as const } : {}),
      ...(defaulted ? { defaulted: true as const } : {}),
    },
  };
}

type Occupied = { slot: Pick<TicketReviewSlot, "kind" | "primaries" | "engineering" | "mode" | "recordsExamination"> };
export type ExaminationOnAct = { kinds: string[]; record: ExaminationRecord };

/**
 * DF-P20 fix pass 2 — the workflow route's two calls, kept here so the
 * route carries one line each. A sign-off: the assurance slots among the
 * slots it fills (`fillable`) carry the record. A veto (a revision request):
 * the assurance slots the caller occupies, open to them or blocked
 * (`occupied`), carry it with the reason. `value` null: nothing to record
 * (the act is exactly as before, the body ignored). Pure.
 */
export function examinationForAct(
  roster: Pick<TicketReviewRoster, "contentHash" | "cycle" | "files">,
  ticket: Pick<Ticket, "requesterId">,
  occupied: readonly Occupied[],
  raw: unknown,
  opts: { act: "sign_off" | "veto"; comment?: string | null },
): { ok: true; value: ExaminationOnAct | null } | { ok: false; error: string } {
  const kinds = occupied.filter((x) => isAssuranceSlot(x.slot, ticket)).map((x) => x.slot.kind);
  if (kinds.length === 0) return { ok: true, value: null };
  const built = buildExaminationRecord(roster, raw, opts);
  return built.ok ? { ok: true, value: { kinds, record: built.record } } : built;
}

/** The audit row's copy of the record (`reviewRoster.examination`), or
 *  nothing. Pure. */
export const examinationAuditFields = (e: ExaminationOnAct | null): { examination?: ExaminationRecord & { slots: string[] } } =>
  e ? { examination: { slots: e.kinds, ...e.record } } : {};

/** The record on a slot event's `details`, or null — an event written before
 *  DF-P20, or one that is not an assurance event. Tolerant of any shape: a
 *  row it cannot read is "not recorded", never an error. */
export function examinationOf(details: unknown): ExaminationRecord | null {
  const e = (details && typeof details === "object" ? (details as Record<string, unknown>).examination : null) as Partial<ExaminationRecord> | null | undefined;
  if (!e || typeof e !== "object" || typeof e.contentHash !== "string" || !Array.isArray(e.files)) return null;
  const files = e.files.filter((f): f is ExaminationRecord["files"][number] => !!f && typeof f === "object")
    .map((f) => ({ id: typeof f.id === "string" ? f.id : null, name: typeof f.name === "string" ? f.name : null, sha256: typeof f.sha256 === "string" ? f.sha256 : null }));
  return {
    v: 1,
    act: e.act === "veto" ? "veto" : "sign_off",
    contentHash: e.contentHash,
    cycle: typeof e.cycle === "string" ? e.cycle : null,
    files,
    ofFiles: typeof e.ofFiles === "number" && e.ofFiles >= files.length ? e.ofFiles : files.length,
    allFiles: e.allFiles === true,
    note: typeof e.note === "string" && e.note.trim() ? e.note : null,
    ...(e.noteTruncated === true ? { noteTruncated: true as const } : {}),
    ...(e.defaulted === true ? { defaulted: true as const } : {}),
    ...(typeof e.slotLabel === "string" && e.slotLabel.trim() ? { slotLabel: e.slotLabel } : {}),
  };
}

/** A hash shortened for reading (the full value is copied, never shown cut). */
export const shortHash = (h: string, n = 12): string => (h.length > n ? `${h.slice(0, n)}…` : h);

/** "Examined all 3 files: a.pdf, b.pdf, c.pdf" / "Examined 1 of 3 files: a.pdf".
 *  A defaulted record (the reviewer was not asked) never says "Examined":
 *  "Files under review: all 3 (not narrowed — the reviewer was not asked): …". */
export function examinedFilesText(r: Pick<ExaminationRecord, "files" | "ofFiles" | "allFiles" | "defaulted">): string {
  const names = r.files.map((f) => f.name || "a file").join(", ");
  const n = r.ofFiles;
  // DF-P25 (review fix pass 2): a round with no files under review (a hold's
  // record of a review on its description) says so, not "all 0 files".
  if (n === 0 && r.files.length === 0) return "No files were under review";
  if (r.defaulted) return `Files under review: all ${n} (not narrowed — the reviewer was not asked)${names ? `: ${names}` : ""}`;
  const count = r.allFiles ? `all ${n} ${n === 1 ? "file" : "files"}` : `${r.files.length} of ${n} ${n === 1 ? "file" : "files"}`;
  return `Examined ${count}${names ? `: ${names}` : ""}`;
}

// ─── drafting-flow DF-P25 — GAP-102 ruling (2), the notify-only limb ─────────
// A notify-only slot the controller opted in (`recordsExamination` on a
// notify_only slot — lib/routingControl.ts notifyExaminationOptInAllowed) is
// told, never waited on; its people's stop is a document HOLD on the
// request's source document, and the hold carries what they examined in its
// own insert (document_holds.examination, 20261267 — lib/holds.ts openHold).
// It is never an assurance SIGN-OFF slot (isAssuranceSlot stays
// blocking-only), so nothing about a sign-off, a veto or the ledger changes.

/** True for a notify-only slot opted in to recording what its people
 *  examined (the stop is a hold with the record). Pure. */
export function isNotifyExaminationSlot(slot: Pick<TicketReviewSlot, "primaries" | "engineering" | "mode" | "recordsExamination">, ticket: Pick<Ticket, "requesterId">): boolean {
  return slot.recordsExamination === true && slot.mode === "notify_only" && slot.engineering !== true && !requesterOnlySlot(slot, ticket);
}

/** What a hold placed from a request's review carries: the examination
 *  record (the veto shape — a stop must say why) plus where it came from. */
export interface HoldExaminationRecord extends ExaminationRecord {
  stop: "hold";
  ticketId: string;
  rosterId: string;
  slotKind: string;
}

/** Build the record a notify-only occupant's hold carries — the roster under
 *  review, the files they examined (by examinationFileKey; default every
 *  file), their note (else the hold's own description), the request, the
 *  round and the slot. The note is required (a stop says why). Pure. */
export function holdExaminationRecord(
  roster: Pick<TicketReviewRoster, "id" | "contentHash" | "cycle" | "files">,
  ticketId: string,
  slot: Pick<TicketReviewSlot, "kind" | "label">,
  raw: unknown,
  holdNote?: string | null,
): { ok: true; record: HoldExaminationRecord } | { ok: false; error: string } {
  const built = buildExaminationRecord(roster, raw, { act: "veto", comment: holdNote ?? null });
  if (!built.ok) return { ok: false, error: built.error === "A revision request must say why — add a note." ? "A hold must say why — add a note of what you found." : built.error };
  return {
    ok: true,
    record: {
      ...built.record,
      ...(slot.label ? { slotLabel: slot.label } : {}),
      stop: "hold",
      ticketId,
      rosterId: roster.id,
      slotKind: slot.kind,
    },
  };
}

/** A hold's examination record read back for one request, or null — a hold
 *  without one, one placed from another request, or a shape this cannot
 *  read (never an error). */
export function holdExaminationOf(examination: unknown, ticketId: string): (ExaminationRecord & { slotKind: string | null; rosterId: string | null }) | null {
  if (!examination || typeof examination !== "object" || Array.isArray(examination)) return null;
  const e = examination as Record<string, unknown>;
  if (e.stop !== "hold" || e.ticketId !== ticketId) return null;
  const rec = examinationOf({ examination: e });
  if (!rec) return null;
  return { ...rec, slotKind: typeof e.slotKind === "string" ? e.slotKind : null, rosterId: typeof e.rosterId === "string" ? e.rosterId : null };
}

/** Who filled one slot of one review round: the roster on record's slots, or
 *  the roster ledger's rows (ticket_review_slots — roster_id, slot_kind,
 *  mode, primaries, alternates) for an earlier round. */
export interface SlotOccupancy {
  rosterId: string;
  kind: string;
  mode: string;
  primaries: readonly string[];
  alternates: readonly string[];
  /** The slot's label as that round named it (shown instead of the
   *  record's own claim). */
  label?: string | null;
}

/** The occupancy of the roster on record (empty without one). Pure. */
export function rosterOccupancy(roster: Pick<TicketReviewRoster, "id" | "slots"> | null | undefined): SlotOccupancy[] {
  if (!roster || !Array.isArray(roster.slots)) return [];
  return roster.slots.map((s) => ({ rosterId: roster.id, kind: s.kind, mode: s.mode, primaries: s.primaries ?? [], alternates: s.alternates ?? [], label: s.label ?? null }));
}

/**
 * DF-P25 review fix: may a hold's record be shown as a stop by the slot it
 * names? The record names its round (`rosterId`) and slot (`slotKind`), but
 * those — and the hold's opener — are what the client wrote, so the record
 * is shown as that slot's stop only when the hold's opener (`opened_by`,
 * which 20261267 ties to the session for a record) is a primary or an
 * alternate of that notify-only slot in that round:
 *   "slot"     — yes;
 *   "not_slot" — the round is known and the opener is not one of that
 *                notify-only slot's people (or the record names no round or
 *                slot);
 *   "unknown"  — the round is neither the roster on record nor in the
 *                ledger rows given (the ledger could not be read): it is
 *                not shown as anyone's stop either. Pure.
 */
export function holdOpenerInSlot(
  openedBy: string | null | undefined,
  rec: { rosterId: string | null; slotKind: string | null },
  occupancy: readonly SlotOccupancy[],
): "slot" | "not_slot" | "unknown" {
  if (!openedBy || !rec.rosterId || !rec.slotKind) return "not_slot";
  const round = occupancy.filter((o) => o.rosterId === rec.rosterId);
  if (round.length === 0) return "unknown";
  const s = round.find((o) => o.kind === rec.slotKind && o.mode === "notify_only");
  return s && (s.primaries.includes(openedBy) || s.alternates.includes(openedBy)) ? "slot" : "not_slot";
}
