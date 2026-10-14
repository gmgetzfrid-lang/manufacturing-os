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
//           (20261068: source; before it, the table's original shape). The
//           table has no ticket or attachment column, so WHICH file left is
//           recorded beside it, on a DOWNLOAD audit_logs row on the ticket.
//           A refused record never blocks the copy; the page says it.

import type { TicketAttachment } from "@/types/schema";
import { stampWatermark, type StampControlState } from "@/lib/stamping";
import { ticketVerifyUrl, ticketVerdict, issueOnRecord, isIssuedTicketRev } from "@/lib/verifyTicketVerdict";

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
  const v = ticketVerdict({ status: live.status, deliverable_rev: live.deliverableRev, history: live.history, revision_count: live.revisionCount }, rev);
  if (v.verdict === "withdrawn") return { kind: "withdrawn" };
  // The scan cannot confirm this file (a CLOSED row with no label; a CLOSED
  // review label whose history issue line its bound set aside): the page
  // derives no standing from the history either — no SUPERSEDED stamp from a
  // line any member may append (the integrator's ruling, DEC-90 fail-safe).
  if (v.verdict === "unknown") return null;
  const fromRow = isIssuedTicketRev(live.deliverableRev) ? parseInt(live.deliverableRev, 10) : null;
  const fromHistory = issueOnRecord(live.history, live.revisionCount, live.deliverableRev);
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
  file: Pick<TicketAttachment, "type" | "rev">;
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
  const label = input.ticketNumber || "Ticket";
  const when = input.channel === "print" ? "printing" : "download";
  const standing = ticketCopyStanding(rev, input.live);
  const what = input.file.type === "Draft" ? "review draft" : "deliverable";
  let footerNotice: string;
  if (!rev) {
    footerNotice = `${label} ${input.file.type ?? "ticket"} file — no deliverable revision is recorded for this file, so which printing this is cannot be confirmed. Not a controlled document revision.`;
  } else if (standing?.kind === "withdrawn") {
    footerNotice = `REQUEST WITHDRAWN at time of ${when} — this file is ${label} ${what} Rev ${rev} — do not work from it — not a controlled document revision — scan the QR for the current status.`;
  } else if (standing?.kind === "superseded") {
    footerNotice = `SUPERSEDED by Rev ${standing.by} at time of ${when} — this file is ${label} ${what} Rev ${rev}, not the current revision — not a controlled document revision — scan the QR for the current status.`;
  } else if (standing?.kind === "in_progress") {
    footerNotice = `This file is ${label} ${what} Rev ${rev} — a newer revision is in progress at time of ${when} — not a controlled document revision — scan the QR to confirm it is still the latest.`;
  } else {
    footerNotice = `This file is ${label} ${what} Rev ${rev} — not a controlled document revision — scan the QR to confirm it is still the latest.`;
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
    verifyUrl: ticketVerifyUrl(input.origin, input.ticketRowId, rev),
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

/** Record one ticket copy: the distribution row (download_audits) and the
 *  row naming the file (audit_logs DOWNLOAD on the ticket). Both are awaited
 *  and checked; the result says whether both landed. Never throws. */
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
  };
  try {
    let { error } = await client.from("download_audits").insert(row);
    if (error && isMissingSourceColumn(error)) {
      // Before 20261068 the table has no `source`: record the pull in the
      // original shape (who, when, until when) and say why the channel is
      // missing — the record degrades, the copy is not lost from it.
      console.warn("[download_audits] the `source` column is missing (20261068 not applied) — recording the ticket copy without its channel.");
      const legacy = { ...row };
      delete legacy.source;
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
