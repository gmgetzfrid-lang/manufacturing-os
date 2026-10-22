// lib/ticketDeliverableCopy.ts
//
// What a printed or downloaded drafting-ticket file says, and how the copy is
// recorded — the ticket page's FileViewerModal (app/(protected)/requests/[id])
// is the only caller. Pulled out of the page so the rules are tested.
//
//   PHYS-2  The copy carries the revision of THE FILE being printed
//           (TicketAttachment.rev, stamped server-side by
//           lib/ticketTransitions.ts), never the ticket's live
//           deliverable_rev: a Rev 1 Final opened on a ticket now at Rev 2
//           prints "Rev 1" and its QR asks about Rev 1, so the scan answers
//           "superseded". A file with no recorded revision prints a QR with
//           no ?r= (the scan answers "cannot confirm") and a footer that says
//           the printing cannot be confirmed. The footer describes THE FILE
//           ("This file is KE-1 deliverable Rev 1"), never "Rev 1 at time of
//           printing" as if it were the deliverable then: when the page
//           already knows the file is superseded (a later issue on the
//           ticket — its issued label or its history) the stamp says
//           SUPERSEDED by Rev N, when the request was withdrawn (EDGE-2) it
//           says REQUEST WITHDRAWN, and when a newer revision is being worked
//           it says so; the page confirms before stamping any of them. The
//           ticket's live facts are a warning input ONLY — the QR keeps
//           file.rev.
//   PHYS-9  One control state per file drives both marks (DEC-64 §5): a Draft
//           is a review copy, everything else is an uncontrolled copy. No
//           caller literal; the watermark recorded is the one the stamper
//           prints for that state (stampWatermark(undefined, state)).
//   HAND-3  A ticket file is not a register revision, and its footer says so.
//   EVID-5  The record of the copy is awaited and checked, never a discarded
//   PHYS-8  promise, and is written in the columns download_audits HAS
//           (20261068: source; before it, the table's original shape).
//           WHICH file left is also recorded beside it, on a DOWNLOAD
//           audit_logs row on the ticket. A refused record never blocks the
//           copy on the page; the page says it.
//   PHYS-17 (DF-P12, 20261223) The distribution row names the ticket and the
//           file (ticket_id, attachment_id), so lib/staleCopies.ts can list
//           the holders of a superseded ticket deliverable. Before the paste
//           (42703 / PGRST204 naming either) the row is written as before.
//   SM-5    (DF-P12) The QR also names the FILE (?a=<attachment id>): the
//           scan checks the file is this ticket's and carries the printed
//           revision, so two prints of one label are told apart.
//   EVID-16 (DF-P12) The same plan and record serve the server stamping
//           route (app/api/tickets/copy), which stamps and records in the
//           request that issues the bytes.
//   GAP-101 (drafting-flow DF-P23 — acceptance 3, the deliverable limb) A
//           deliverable (any file but a review Draft) of a request its
//           requester declared like-in-kind carries the declaration,
//           attributed, beside the request reference the footer already
//           names: "KE-1 (declared like-in-kind by <name> on <date>: "<the
//           statement>")". A request with no declaration (or a database
//           before 20261250, where none can exist) prints exactly what it
//           printed before. A declaration the reader could not read is said
//           ("like-in-kind declaration not available"), never guessed, and
//           never blocks or delays the copy. (DF-P23 merge-time fix pass) A
//           part — the declarer's name, the statement — the stamp's font
//           cannot draw without a "?" substitute (a Cyrillic or CJK name or
//           sentence) is never printed as "?" runs: that part is replaced by
//           a plain-ASCII note naming the request ("[statement not printable
//           in this stamp - see request KE-1]"), each part on its own.
//           (Fix pass 2) A Latin-script part first has the letters the font
//           lacks folded ("Łukasz" → "Lukasz", "Dvořák" → "Dvorák"); only a
//           part that still cannot be drawn takes the note.

import type { TicketAttachment } from "@/types/schema";
import { StandardFontEmbedder, StandardFonts } from "pdf-lib";
import { stampFontPrints, stampText, stampWatermark, STAMP_PLACEHOLDER, type StampControlState } from "@/lib/stamping";
import { ticketVerifyUrl, ticketVerdict, issueInForce, isIssuedTicketRev } from "@/lib/verifyTicketVerdict";

export type TicketCopyChannel = "print" | "download";

export interface TicketCopyPlan {
  /** PHYS-9: the one state both marks come from. */
  controlState: StampControlState;
  /** PHYS-2: the file's own revision, or null when none is recorded. */
  rev: string | null;
  /** The QR target (undefined with no public origin — DEC-64 §2). */
  verifyUrl: string | undefined;
  footerNotice: string;
  /** The watermark the stamper prints for this state — what the record names. */
  watermark: string;
  /** What the page knows of this file against the ticket now (PHYS-2):
   *  the request withdrawn (EDGE-2), superseded by a later issue, a newer
   *  revision in progress, or null
   *  (latest as far as the page knows, or nothing to compare). */
  standing: TicketCopyStanding | null;
  /** The plain-words question the page asks before stamping a file whose
   *  standing is set; null when no confirmation is needed. */
  confirmMessage: string | null;
}

export type TicketCopyStanding =
  | { kind: "withdrawn" }
  | { kind: "superseded"; by: string }
  | { kind: "in_progress" };

/** The ticket's live facts as the page holds them — a warning input only. */
export interface TicketCopyLiveFacts {
  status: string | null;
  deliverableRev: string | null;
  history: unknown;
  /** The server-guarded cycle count: a history "issued Rev N" line above
   *  revisionCount + 1, or above the bound the live label proves (N − 1
   *  under a review label N<letters>, N under an issued label N,
   *  revisionCount itself with no label), is not an
   *  approval's (any member may append history in their own name) and never
   *  marks a file superseded. */
  revisionCount?: number | null;
  /** 20261221 (DF-P12): tickets.history_guarded_from — an issue line at or
   *  after it is the workflow's own (lib/verifyTicketVerdict.ts
   *  provenIssueFromHistory). Absent / null: read as before the paste. */
  historyGuardedFrom?: number | null;
  /** GAP-101 acceptance 3 (DF-P23): the requester's like-in-kind
   *  declaration (20261250), to print attributed on a deliverable. Absent /
   *  null: no declaration (or none can exist yet) — nothing printed.
   *  "unavailable": it could not be read — said on the copy. "unsigned"
   *  (DF-P23 fix pass): its e-signature is known not to stand, so the
   *  workflow treated the request as undeclared — the copy says it was not
   *  relied on, never attributes it. */
  declaration?: TicketCopyDeclaration | "unavailable" | "unsigned" | null;
}

/** GAP-101 acceptance 3 (DF-P23): the declaration as a copy prints it. */
export interface TicketCopyDeclaration {
  /** Who declared it, as the request names them (the requester). */
  by: string | null;
  /** When (ISO); printed as the date. */
  declaredAt: string | null;
  /** The requester's own sentence. */
  statement: string | null;
  /** DF-P23 fix pass: the declaration's e-signature could not be checked
   *  (the read failed, or has not answered yet) — said beside it. */
  signatureUnchecked?: boolean;
}

/** GAP-101 acceptance 3 (DF-P23): the longest part of the statement a footer
 *  prints (the request page and the audit trail carry it whole). */
export const DECLARATION_FOOTER_MAX = 140;
export const DECLARATION_NOT_AVAILABLE = "like-in-kind declaration not available";
/** DF-P23 fix pass: a declaration whose e-signature does not stand. */
export const DECLARATION_NOT_RELIED_ON = "like-in-kind declaration not relied on: its e-signature does not stand";
export const DECLARATION_SIGNATURE_UNCHECKED = "e-signature not checked";

/** DF-P23 fix pass (review, major): the stamper removes a scan instruction
 *  from a copy that carries no QR (lib/stamping.ts withoutScanInstruction —
 *  by sentence, then by dash clause), so the requester's words, printed
 *  inside the footer's sentence, may never read as one: "scan" before "the
 *  QR", "this code", "to verify" is bracketed ("[scan] the code" — the usual
 *  mark of an altered quotation), and a spaced dash is a hyphen. Otherwise
 *  the cut would fall inside the statement and take "not a controlled
 *  document revision" with it. */
const STATEMENT_SCAN = /\bscan(?=\s+(?:the\s+|this\s+)?(?:qr\b|code\b|to\s+verify\b))/gi;

/** DF-P23 fix pass (review, minor): the declaration as a copy prints it,
 *  from the request's own fields — one rule for the server copy route and
 *  the request page. A declaration is a declared time AND a statement
 *  (lib/reviewModel.ts isDeclaredLikeInKind); its e-signature, checked as
 *  the workflow route checks it (declarationSignatureStands): "missing" →
 *  "unsigned" (the workflow treated the request as undeclared), "unchecked"
 *  or not yet known → printed with "e-signature not checked". Pure. */
export function copyDeclarationFacts(input: {
  declaredAt: string | number | Date | null | undefined;
  statement: string | null | undefined;
  declaredBy: string | null | undefined;
  requesterId: string | null | undefined;
  requesterName: string | null | undefined;
  requesterEmail: string | null | undefined;
  signature: "verified" | "missing" | "unchecked" | "pending" | null | undefined;
}): TicketCopyDeclaration | "unsigned" | null {
  const statement = typeof input.statement === "string" ? input.statement : null;
  if (input.declaredAt === null || input.declaredAt === undefined || input.declaredAt === "" || !statement || !statement.trim()) return null;
  if (input.signature === "missing") return "unsigned";
  const at = new Date(input.declaredAt);
  return {
    by: (input.declaredBy && input.declaredBy === input.requesterId ? (input.requesterName || input.requesterEmail) : null) ?? null,
    declaredAt: Number.isNaN(at.getTime()) ? null : at.toISOString(),
    statement,
    ...(input.signature === "verified" ? {} : { signatureUnchecked: true }),
  };
}

/** DF-P23 merge-time fix pass: the font the stamper draws every footer in
 *  (lib/stamping.ts applyStampToPdfDoc embeds StandardFonts.HelveticaBold —
 *  pinned by a test). Its encoder is built once, on first use; null when it
 *  could not be built (then stampText's own check decides — its character set
 *  is pinned to this encoder code point by code point, lib/__tests__/
 *  psP7StampText.test.ts — so a Latin name is never replaced for want of it). */
let stampEncoder: StandardFontEmbedder | null | undefined;
function stampFontEncoder(): StandardFontEmbedder | null {
  if (stampEncoder === undefined) {
    try {
      // (pdf-lib's StandardFonts and the embedder's FontNames are one string enum, typed apart)
      stampEncoder = StandardFontEmbedder.for(StandardFonts.HelveticaBold as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
    } catch {
      stampEncoder = null;
    }
  }
  return stampEncoder;
}

/** DF-P23 merge-time fix pass (review minor): true when the stamp draws
 *  `text` with no "?" substitute — every character printed as typed or in a
 *  plain form the stamper already uses (a Unicode dash as "-", a format
 *  character removed and named; lib/stamping.ts stampText), and what it
 *  draws accepted by the font's own encoder (pdf-lib's WinAnsi encoding for
 *  Helvetica-Bold). False for a Cyrillic or CJK name or sentence, which the
 *  stamper would print as "?" runs. Pure. */
export function stampPrintsWithoutSubstitute(text: string): boolean {
  const { text: drawn, mapped } = stampText(text);
  // a "?" the stamper drew for a character it has no form for (a compatibility
  // form of the question mark itself is a question mark, not a substitute)
  if (mapped.some((m) => m.printedAs === STAMP_PLACEHOLDER && m.char.normalize("NFKC") !== STAMP_PLACEHOLDER)) return false;
  const encoder = stampFontEncoder();
  if (!encoder) return true;
  try {
    encoder.encodeText(drawn);
    return true;
  } catch {
    return false;
  }
}

/** DF-P23 merge-time fix pass 2 (review nit): letters canonical
 *  decomposition (NFD) does not split into a base letter and a mark. Ø / ø
 *  and ß are WinAnsi letters, so they are printed as typed and never reach
 *  this map in practice; they are listed so the fold is the ruling's. */
const FOLD_LETTERS: Readonly<Record<string, string>> = { "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "Ø": "O", "ø": "o" };

/** DF-P23 merge-time fix pass 2 (review nit): a Latin-script part with a
 *  letter the stamp's font lacks ("Łukasz Nowak", "Dvořák"), its diacritics
 *  folded: each character the font cannot print is decomposed (NFD) and its
 *  combining marks dropped, or taken from FOLD_LETTERS — "Lukasz Nowak",
 *  "Dvorák". Characters the font prints are kept exactly as typed. A
 *  character with no such form (Cyrillic, CJK) is left as it is, so the part
 *  stays unprintable and is replaced by the bracketed note. Pure. */
export function foldForStamp(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    if (stampFontPrints(ch.codePointAt(0) ?? 0)) { out += ch; continue; }
    const folded = FOLD_LETTERS[ch] ?? ch.normalize("NFD").replace(/\p{M}/gu, "");
    out += folded ? folded : ch;
  }
  return out;
}

/** DF-P23 merge-time fix pass 2: a part as the stamp prints it — as typed
 *  when the font draws it (byte for byte as before), else its folded form
 *  when that draws, else null (the caller prints the bracketed note). */
function printablePart(text: string): string | null {
  if (stampPrintsWithoutSubstitute(text)) return text;
  const folded = foldForStamp(text);
  return folded !== text && stampPrintsWithoutSubstitute(folded) ? folded : null;
}

/** DF-P23 merge-time fix pass: what a part of the declaration the stamp
 *  cannot print reads instead — plain ASCII, naming where the words are. */
export function declarationPartNotPrintable(part: "name" | "statement", requestRef: string | null | undefined): string {
  const ref = typeof requestRef === "string" && requestRef.trim() && stampPrintsWithoutSubstitute(requestRef.trim()) ? requestRef.trim() : null;
  return `[${part} not printable in this stamp - ${ref ? `see request ${ref}` : "see the request"}]`;
}

/** GAP-101 acceptance 3 (DF-P23): the parenthesis printed beside the request
 *  reference on a deliverable — "" for no declaration. `requestRef` (the
 *  request number the footer names) is cited by a part the stamp cannot
 *  print (DF-P23 merge-time fix pass): the name and the statement are each
 *  checked on their own, and a part the font cannot draw without a "?" is
 *  printed diacritic-folded when that draws (foldForStamp, fix pass 2), else
 *  replaced by declarationPartNotPrintable — never printed as "?" runs, and
 *  a part it can draw is printed exactly as before. Pure. */
export function declarationFooterClause(d: TicketCopyLiveFacts["declaration"], requestRef?: string | null): string {
  if (d === undefined || d === null) return "";
  if (d === "unavailable") return ` (${DECLARATION_NOT_AVAILABLE})`;
  if (d === "unsigned") return ` (${DECLARATION_NOT_RELIED_ON})`;
  const name = d.by && d.by.trim() ? d.by.trim() : null;
  const namePrinted = name === null ? null : printablePart(name);
  const by = name === null ? "the requester" : namePrinted ?? `the requester ${declarationPartNotPrintable("name", requestRef)}`;
  const date = d.declaredAt && !Number.isNaN(Date.parse(d.declaredAt)) ? new Date(d.declaredAt).toISOString().slice(0, 10) : null;
  // A dash clause in the sentence would read as one of the footer's own
  // clauses (the stamper drops the scan clause by them), so it is a hyphen
  // here; and a scan instruction in it is bracketed (STATEMENT_SCAN).
  const words = (d.statement ?? "").replace(/\s+/g, " ").trim();
  const cut = words.length > DECLARATION_FOOTER_MAX ? `${words.slice(0, DECLARATION_FOOTER_MAX - 1).trimEnd()}…` : words;
  const text = cut.replace(/ [—–] /g, " - ").replace(STATEMENT_SCAN, (w) => `[${w}]`);
  const statementPrinted = text ? printablePart(text) : null;
  const quoted = !text ? "" : statementPrinted !== null ? `: "${statementPrinted}"` : `: ${declarationPartNotPrintable("statement", requestRef)}`;
  return ` (declared like-in-kind by ${by}${date ? ` on ${date}` : ""}${quoted}${d.signatureUnchecked ? `; ${DECLARATION_SIGNATURE_UNCHECKED}` : ""})`;
}

/** Where an issued file stands against the ticket as the page holds it.
 *  Withdrawn: the verify ladder answers "withdrawn" for it (EDGE-2 — the
 *  request was CANCELED, or ended on a review label with no issue
 *  anywhere); checked first, as the scan answers it whatever the rev.
 *  None when the ladder answers "cannot confirm" (a CLOSED row with no
 *  label, or a CLOSED review label with a set-aside issue line): no
 *  standing is derived from a history line there.
 *  Superseded: a later number is issued — on the row (deliverable_rev) or in
 *  the history's "issued Rev N" lines (only those within revisionCount + 1
 *  and the live label's bound — issueOnRecord, the trust boundary in
 *  lib/verifyTicketVerdict.ts),
 *  whichever is higher. In progress: the
 *  file IS the last issue and the verify ladder reads the ticket as being
 *  re-worked (ticketVerdict's revision_in_progress — reopened, sent back, or
 *  a review label on the row). A Draft / letter label or a rev-less file has
 *  no standing here (its watermark and its "cannot confirm" footer speak). */
export function ticketCopyStanding(rev: string | null, live: TicketCopyLiveFacts | null | undefined): TicketCopyStanding | null {
  if (!live || !isIssuedTicketRev(rev)) return null;
  const v = ticketVerdict({ status: live.status, deliverable_rev: live.deliverableRev, history: live.history, revision_count: live.revisionCount, history_guarded_from: live.historyGuardedFrom }, rev);
  if (v.verdict === "withdrawn") return { kind: "withdrawn" };
  // The scan cannot confirm this file (a CLOSED row with no label; a CLOSED
  // review label whose history issue line its bound set aside): the page
  // derives no standing from the history either — no SUPERSEDED stamp from a
  // line any member may append (the integrator's ruling, DEC-90 fail-safe).
  if (v.verdict === "unknown") return null;
  const fromRow = isIssuedTicketRev(live.deliverableRev) ? parseInt(live.deliverableRev, 10) : null;
  const fromHistory = issueInForce(live.history, live.revisionCount, live.deliverableRev, live.historyGuardedFrom);
  const latest = Math.max(fromRow ?? 0, fromHistory ? parseInt(fromHistory, 10) : 0);
  if (latest > parseInt(rev, 10)) return { kind: "superseded", by: String(latest) };
  return v.verdict === "revision_in_progress" ? { kind: "in_progress" } : null;
}

/** The control state a ticket file is stamped with: a Draft is a review
 *  copy; every other file is an uncontrolled copy (never "controlled" —
 *  DEC-64 §5; a Final is uncontrolled until it is a register revision). */
export function ticketCopyControlState(file: Pick<TicketAttachment, "type">): StampControlState {
  return file.type === "Draft" ? "review" : "uncontrolled";
}

/** Everything the stamp of one ticket file says. */
export function ticketCopyPlan(input: {
  /** The file — its id (when given) rides the QR as ?a= (SM-5 done-when 3). */
  file: Pick<TicketAttachment, "type" | "rev"> & { id?: string | null };
  ticketNumber?: string | null;
  ticketRowId?: string | null;
  origin: string;
  channel: TicketCopyChannel;
  /** The ticket as the page holds it now — a WARNING input only; the QR and
   *  the revision printed are the file's own. */
  live?: TicketCopyLiveFacts | null;
}): TicketCopyPlan {
  const controlState = ticketCopyControlState(input.file);
  const rev = typeof input.file.rev === "string" && input.file.rev.trim() ? input.file.rev.trim() : null;
  // GAP-101 acceptance 3 (DF-P23): a deliverable names the request's
  // like-in-kind declaration beside the request reference ("" when none).
  const label = input.ticketNumber || "Ticket";
  const ref = `${label}${input.file.type === "Draft" ? "" : declarationFooterClause(input.live?.declaration, input.ticketNumber)}`;
  const when = input.channel === "print" ? "printing" : "download";
  const standing = ticketCopyStanding(rev, input.live);
  const what = input.file.type === "Draft" ? "review draft" : "deliverable";
  let footerNotice: string;
  if (!rev) {
    footerNotice = `${ref} ${input.file.type ?? "ticket"} file — no deliverable revision is recorded for this file, so which printing this is cannot be confirmed. Not a controlled document revision.`;
  } else if (standing?.kind === "withdrawn") {
    footerNotice = `REQUEST WITHDRAWN at time of ${when} — this file is ${ref} ${what} Rev ${rev} — do not work from it — not a controlled document revision — scan the QR for the current status.`;
  } else if (standing?.kind === "superseded") {
    footerNotice = `SUPERSEDED by Rev ${standing.by} at time of ${when} — this file is ${ref} ${what} Rev ${rev}, not the current revision — not a controlled document revision — scan the QR for the current status.`;
  } else if (standing?.kind === "in_progress") {
    footerNotice = `This file is ${ref} ${what} Rev ${rev} — a newer revision is in progress at time of ${when} — not a controlled document revision — scan the QR to confirm it is still the latest.`;
  } else {
    footerNotice = `This file is ${ref} ${what} Rev ${rev} — not a controlled document revision — scan the QR to confirm it is still the latest.`;
  }
  const verb = input.channel === "print" ? "Print" : "Download";
  const confirmMessage = !standing || !rev
    ? null
    : standing.kind === "withdrawn"
      ? `This file is Rev ${rev}, but the ${label} request was withdrawn. The copy will be stamped WITHDRAWN. ${verb} it anyway?`
      : standing.kind === "superseded"
      ? `This file is Rev ${rev}, but ${label} has since issued Rev ${standing.by}. The copy will be stamped SUPERSEDED. ${verb} it anyway?`
      : `This file is Rev ${rev}, the last issue of ${label}, but a newer revision is in progress. The copy will say so. ${verb} it anyway?`;
  return {
    controlState,
    rev,
    verifyUrl: ticketVerifyUrl(input.origin, input.ticketRowId, rev, input.file.id ?? null),
    footerNotice,
    watermark: stampWatermark(undefined, controlState),
    standing,
    confirmMessage,
  };
}

/** The download_audits channel for a ticket copy (20261068's `source`). */
export function ticketCopySource(channel: TicketCopyChannel, stamped: boolean): string {
  const base = channel === "print" ? "drafting_print" : "drafting";
  return stamped ? base : `${base}_unstamped`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InsertClient = { from: (table: string) => any };
type PgError = { code?: string; message?: string } | null | undefined;
type AuditWriter = (entry: {
  action: string; resourceId: string; resourceType: string; orgId?: string;
  userId: string; userEmail?: string; userRole?: string; details?: Record<string, unknown>;
}) => Promise<{ ok: boolean; error: string | null }>;

/** A refusal that is the unapplied 20261223 (no ticket_id / attachment_id
 *  column — PHYS-17): today's row is written instead. */
export function isMissingTicketCopyColumn(error: PgError): boolean {
  if (!error) return false;
  const msg = error.message ?? "";
  if (!/\b(ticket_id|attachment_id)\b/.test(msg)) return false;
  return error.code === "PGRST204" || error.code === "42703" || /column|schema cache/i.test(msg);
}

/** A refusal that is the unapplied 20261068 itself (no `source` column). */
export function isMissingSourceColumn(error: PgError): boolean {
  if (!error) return false;
  const msg = error.message ?? "";
  if (error.code === "PGRST204" || error.code === "42703") return /\bsource\b/.test(msg) || !msg;
  return /\bsource\b/.test(msg) && /column|schema cache/i.test(msg);
}

export interface TicketCopyRecordInput {
  orgId: string;
  userId: string;
  userEmail?: string | null;
  userRole?: string | null;
  ticketRowId?: string | null;
  ticketNumber?: string | null;
  file: Pick<TicketAttachment, "id" | "name" | "type" | "rev">;
  channel: TicketCopyChannel;
  /** false when the stamp failed and the original left unmarked. */
  stamped: boolean;
  /** The watermark the stamper printed (plan.watermark); null when unstamped. */
  watermark: string | null;
  expiresAt: Date | null;
}

export interface TicketCopyRecordResult {
  recorded: boolean;
  /** Plain words for the page when the copy is missing from the record. */
  error: string | null;
}

/** Record one ticket copy: the distribution row (download_audits — naming
 *  the ticket and the file since 20261223) and the row naming the file
 *  (audit_logs DOWNLOAD on the ticket). Both are awaited and checked; the
 *  result says whether both landed. Never throws. */
export async function recordTicketCopy(
  client: InsertClient,
  logAudit: AuditWriter,
  input: TicketCopyRecordInput,
): Promise<TicketCopyRecordResult> {
  const problems: string[] = [];
  const source = ticketCopySource(input.channel, input.stamped);
  const row: Record<string, unknown> = {
    org_id: input.orgId,
    user_id: input.userId,
    user_email: input.userEmail ?? null,
    expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
    source,
    // PHYS-17 (20261223): which ticket file left — the stale-copies ticket arm reads these.
    ticket_id: input.ticketRowId ?? null,
    attachment_id: typeof input.file.id === "string" && input.file.id ? input.file.id : null,
  };
  try {
    let { error } = await client.from("download_audits").insert(row);
    if (error && isMissingTicketCopyColumn(error)) {
      // Before 20261223 the table has no ticket / attachment column: today's
      // row (the file is still named on the audit row below).
      console.warn("[download_audits] ticket_id / attachment_id are missing (20261223 not applied) — recording the ticket copy without naming the file in the distribution row.");
      delete row.ticket_id;
      delete row.attachment_id;
      ({ error } = await client.from("download_audits").insert(row));
    }
    if (error && isMissingSourceColumn(error)) {
      // Before 20261068 the table has no `source` (nor, then, the 20261223
      // columns, which need it): record the pull in the original shape (who,
      // when, until when) and say why the channel is missing — the record
      // degrades, the copy is not lost from it.
      console.warn("[download_audits] the `source` column is missing (20261068 not applied) — recording the ticket copy without its channel.");
      const legacy = { ...row };
      delete legacy.source;
      delete legacy.ticket_id;
      delete legacy.attachment_id;
      ({ error } = await client.from("download_audits").insert(legacy));
    }
    if (error) {
      console.error("[download_audits] REFUSED — this ticket copy is missing from the distribution record:", error.message ?? error);
      problems.push(`the distribution record refused it (${error.message || "no reason given"})`);
    }
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error("[download_audits] insert failed — this ticket copy is missing from the distribution record:", msg);
    problems.push(`the distribution record could not be written (${msg})`);
  }

  if (input.ticketRowId) {
    const audit = await logAudit({
      action: "DOWNLOAD",
      resourceId: input.ticketRowId,
      resourceType: "ticket",
      orgId: input.orgId,
      userId: input.userId,
      userEmail: input.userEmail ?? undefined,
      userRole: input.userRole ?? undefined,
      details: {
        channel: input.channel,
        source,
        ticketNumber: input.ticketNumber ?? null,
        attachmentId: input.file.id,
        attachmentType: input.file.type,
        fileName: input.file.name,
        rev: typeof input.file.rev === "string" ? input.file.rev : null,
        watermark: input.stamped ? input.watermark : "UNSTAMPED (stamping failed)",
        expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
      },
    });
    if (!audit.ok) problems.push(`the audit trail refused it (${audit.error || "no reason given"})`);
  } else {
    problems.push("the ticket is not identified, so the audit trail cannot name the file");
  }

  return problems.length === 0
    ? { recorded: true, error: null }
    : { recorded: false, error: problems.join("; ") };
}
