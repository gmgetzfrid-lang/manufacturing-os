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
//           the printing cannot be confirmed.
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
import { ticketVerifyUrl } from "@/lib/verifyTicketVerdict";

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
}): TicketCopyPlan {
  const controlState = ticketCopyControlState(input.file);
  const rev = typeof input.file.rev === "string" && input.file.rev.trim() ? input.file.rev.trim() : null;
  const label = input.ticketNumber || "Ticket";
  const when = input.channel === "print" ? "printing" : "download";
  const footerNotice = rev
    ? `${label} deliverable Rev ${rev} at time of ${when} — not a controlled document revision — scan the QR to confirm it is still the latest.`
    : `${label} ${input.file.type ?? "ticket"} file — no deliverable revision is recorded for this file, so which printing this is cannot be confirmed. Not a controlled document revision.`;
  return {
    controlState,
    rev,
    verifyUrl: ticketVerifyUrl(input.origin, input.ticketRowId, rev),
    footerNotice,
    watermark: stampWatermark(undefined, controlState),
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
