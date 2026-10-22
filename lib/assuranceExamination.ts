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
// An ASSURANCE SLOT is a property of the slot, never of its name (DEC-35):
// a BLOCKING roster slot — one a person signs, the act a record can ride —
// that asks "is it correct?" of someone other than the requester, and is not
// the request's engineering approval. So the engineering sign-off (a slot
// filled by an engineering capability, or the gate the roster appended —
// `engineering: true`), the requester's own acceptance (a slot only the
// requester fills — the panel's "Is this what you asked for?"), a notify-only
// slot (told, never signed: no act to record on) and a consent-window slot
// (it can advance by silence, when nobody examined anything — DF-P7) are
// not; a facility's other blocking checks are. DF-P20 fix pass: this derived
// reading still reaches the existing non-engineering blocking slots of
// configured rosters, so it is put to the integrator (DEC-44 (DF-P20) item 1).
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
}

/** The slot only the requester fills — "Is this what you asked for?" (the
 *  roster panel's slotQuestion uses the same rule). */
export function requesterOnlySlot(slot: Pick<TicketReviewSlot, "primaries">, ticket: Pick<Ticket, "requesterId">): boolean {
  return slot.primaries.length === 1 && slot.primaries[0] === ticket.requesterId;
}

/** True for an assurance slot (see the header): a blocking slot, not the
 *  engineering approval, not the requester's own acceptance. Pure. */
export function isAssuranceSlot(slot: Pick<TicketReviewSlot, "primaries" | "engineering" | "mode">, ticket: Pick<Ticket, "requesterId">): boolean {
  return slot.mode === "blocking" && slot.engineering !== true && !requesterOnlySlot(slot, ticket);
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
 * every file, no note). `files` names files by examinationFileKey; one that is
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
    },
  };
}

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
  };
}

/** A hash shortened for reading (the full value is copied, never shown cut). */
export const shortHash = (h: string, n = 12): string => (h.length > n ? `${h.slice(0, n)}…` : h);

/** "Examined all 3 files: a.pdf, b.pdf, c.pdf" / "Examined 1 of 3 files: a.pdf". */
export function examinedFilesText(r: Pick<ExaminationRecord, "files" | "ofFiles" | "allFiles">): string {
  const names = r.files.map((f) => f.name || "a file").join(", ");
  const n = r.ofFiles;
  const count = r.allFiles ? `all ${n} ${n === 1 ? "file" : "files"}` : `${r.files.length} of ${n} ${n === 1 ? "file" : "files"}`;
  return `Examined ${count}${names ? `: ${names}` : ""}`;
}
