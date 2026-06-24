// lib/ticketShed.ts
//
// The space-saver's brain for closed tickets (Machine A, ticket edition).
//
// Rule: a ticket in a TERMINAL status (CLOSED/CANCELED) that's been quiet for at
// least `olderThanDays` is eligible to have its WHOLE self archived to cold
// storage — comment thread, history and attachment binaries move into one
// archive while a lightweight stub stays in the list. Open/in-flight tickets are
// never touched. Pure + deterministic so it unit-tests without a DB.

export const TERMINAL_TICKET_STATUSES = ["CLOSED", "CANCELED"] as const;
export type TerminalTicketStatus = (typeof TERMINAL_TICKET_STATUSES)[number];

export interface TicketAttachmentLite {
  url?: string | null; // R2 storage key
  size?: string | number | null;
}

export interface TicketShedRow {
  id: string;
  ticket_id?: string | null; // human ticket number, for display
  title?: string | null;
  status?: string | null;
  archived_at?: string | null;
  last_modified?: string | null;
  created_at?: string | null;
  attachments?: TicketAttachmentLite[] | null;
}

export interface TicketShedSelection {
  selected: TicketShedRow[];
  /** Attachment bytes reclaimable from R2 across the selected tickets. */
  totalBytes: number;
  totalCount: number;
  /** Eligible tickets left because the byte target was already met. */
  skipped: number;
}

export interface TicketShedOptions {
  /** Only archive terminal tickets quiet at least this long. */
  olderThanDays: number;
  now?: Date;
  /** Stop once this many attachment bytes are selected. Omit to take all eligible. */
  targetBytes?: number | null;
}

/** Sum the attachment binary sizes carried on a ticket (bytes; tolerant of string sizes). */
export function ticketAttachmentBytes(atts: TicketAttachmentLite[] | null | undefined): number {
  if (!Array.isArray(atts)) return 0;
  let n = 0;
  for (const a of atts) {
    const s = Number(a?.size);
    if (Number.isFinite(s) && s > 0) n += s;
  }
  return n;
}

const activityTs = (r: TicketShedRow) => Date.parse(r.last_modified || r.created_at || "") || 0;
const isTerminal = (status: string | null | undefined) =>
  (TERMINAL_TICKET_STATUSES as readonly string[]).includes((status || "").toUpperCase());

/** True when a ticket is terminal, not already archived, and quiet past the cutoff. */
export function isTicketEligible(row: TicketShedRow, cutoff: Date): boolean {
  if (row.archived_at) return false;
  if (!isTerminal(row.status)) return false;
  const ts = activityTs(row);
  return ts > 0 && ts <= cutoff.getTime();
}

/**
 * Choose which closed tickets to archive: terminal + quiet past the cutoff,
 * oldest first. When targetBytes is set, stop once that many attachment bytes
 * are captured (tickets with no attachments still count toward the selection but
 * add zero bytes — their win is freeing Postgres rows, not R2).
 */
export function selectTicketShedCandidates(rows: TicketShedRow[], opts: TicketShedOptions): TicketShedSelection {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - Math.max(0, opts.olderThanDays) * 86400 * 1000);

  const eligible = rows
    .filter((r) => isTicketEligible(r, cutoff))
    .sort((a, b) => activityTs(a) - activityTs(b)); // oldest first

  const target = opts.targetBytes ?? null;
  const selected: TicketShedRow[] = [];
  let totalBytes = 0;
  for (const r of eligible) {
    if (target != null && totalBytes >= target) break;
    selected.push(r);
    totalBytes += ticketAttachmentBytes(r.attachments);
  }

  return { selected, totalBytes, totalCount: selected.length, skipped: eligible.length - selected.length };
}
