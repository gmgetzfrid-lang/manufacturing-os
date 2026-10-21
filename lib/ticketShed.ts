// lib/ticketShed.ts
//
// The space-saver's brain for closed tickets (Machine A, ticket edition).
//
// Rule: a ticket in a TERMINAL status (CLOSED/CANCELED) that's been quiet for at
// least `olderThanDays` is eligible to have its WHOLE self archived to cold
// storage — comment thread, history and attachment binaries move into one
// archive while a lightweight stub stays in the list. Open/in-flight tickets are
// never touched. Pure + deterministic so it unit-tests without a DB (except
// keysOnOtherLiveTickets at the end, which the reclaim uses).

import type { SupabaseClient } from "@supabase/supabase-js";
import { isSafeStorageKey } from "@/lib/storageKey";

export const TERMINAL_TICKET_STATUSES = ["CLOSED", "CANCELED"] as const;
export type TerminalTicketStatus = (typeof TERMINAL_TICKET_STATUSES)[number];
/** True for either terminal status. WF-17: every "live work" surface reads
 *  THIS predicate — a `!== 'CLOSED'` check kept a canceled request active. */
export const isTerminalTicketStatus = (status: string | null | undefined): boolean =>
  (TERMINAL_TICKET_STATUSES as readonly string[]).includes((status || "").toUpperCase());

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
  /** When the ticket entered terminal state — the correct "quiet since" clock.
   *  Preferred over last_modified, which a post-close comment would reset. */
  closed_at?: string | null;
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

/** Bytes from a size that may be a number OR a display string. Every ticket
 *  attachment in the app stores its size FORMATTED ("1.23 MB") rather than as
 *  a count, so a plain Number() yields NaN for all of them and the reclaim
 *  estimate reported zero no matter how many files those tickets carried. */
export function attachmentSizeBytes(size: unknown): number {
  if (typeof size === "number") return Number.isFinite(size) && size > 0 ? size : 0;
  if (typeof size !== "string") return 0;
  const m = size.trim().match(/^([\d.]+)\s*([KMGT]?B)?$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = (m[2] ?? "B").toUpperCase();
  const scale = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit] ?? 1;
  return Math.round(n * scale);
}

/** Sum the attachment binary sizes carried on a ticket (bytes; tolerant of string sizes). */
export function ticketAttachmentBytes(atts: TicketAttachmentLite[] | null | undefined): number {
  if (!Array.isArray(atts)) return 0;
  let n = 0;
  for (const a of atts) n += attachmentSizeBytes(a?.size);
  return n;
}

// "Quiet since" = when the ticket was closed, NOT the last generic touch. A
// comment/edit on a closed ticket bumps last_modified but must not reset the
// archive clock, or long-closed tickets that get the odd note never qualify.
// Falls back to last_modified/created_at for rows closed before closed_at existed.
const activityTs = (r: TicketShedRow) => Date.parse(r.closed_at || r.last_modified || r.created_at || "") || 0;
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
    // Oldest first; tie-break on id so a byte-target cut is deterministic.
    .sort((a, b) => (activityTs(a) - activityTs(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

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

// ── drafting-flow AUTHZ-5 / SM-4 / SM-9 (DF-P11): what the ticket shed may
// delete, and when a captured ticket may still be freed. These are the only
// non-pure helpers in this module (the last one reads the database).


/** True when `key` is a file a drafting request of THIS workspace stores:
 *  under orgs/<org>/tickets/ (lib/storage.ts makeTicketAttachmentPath, and
 *  the requester's staging folder) or an intake redline the external door
 *  appended (orgs/<org>/project-intake/<project>/redlines/…,
 *  app/api/intake/upload/route.ts). AUTHZ-5: `attachments[].url` is a
 *  member-writable column on a database without 20261166, so only these two
 *  shapes are ever deleted by the reclaim (ticket-shed/commit); any other key
 *  is counted and left in storage — this workspace's library, knowledge or
 *  project files as kept references (a request started from a document names
 *  its library file as a `Source`), another workspace's as refused. Capture
 *  (ticket-shed produce) keeps the org-prefix rule (lib/shedKeyGuard.ts
 *  isOrgOwnedKey, DC RET-6) so such a ticket stays sheddable. */
export function isShedTicketKey(key: string | null | undefined, orgId: string): key is string {
  if (!key || !orgId || !isSafeStorageKey(key)) return false;
  if (key.startsWith(`orgs/${orgId}/tickets/`) && key.length > `orgs/${orgId}/tickets/`.length) return true;
  return new RegExp(`^orgs/${orgId.replace(/[^0-9a-fA-F-]/g, "")}/project-intake/[^/]+/redlines/[^/]+$`).test(key);
}

/** How far a writer's clock may sit behind the database's: a ticket whose
 *  last_modified is later than (the archive's production time − this) is
 *  treated as changed since it was captured (a false positive only returns
 *  the ticket to the live list; it is never freed on a stale capture). */
export const TICKET_CAPTURE_SKEW_MS = 5 * 60 * 1000;

/** SM-4 / SM-9: why a ticket captured into an archive (archive_id set,
 *  archived_at still null) must NOT be reclaimed now — it left its terminal
 *  status since the archive was produced (a reopen), or it was written since
 *  (a comment, a file, a transition: every writer stamps last_modified) so
 *  the archive's copy is stale — or null when it may be. `producedAt` is the
 *  archive catalog row's created_at (stamped before the capture began). */
export function changedSinceCapture(
  row: { status?: string | null; last_modified?: string | null },
  producedAt: string | null | undefined,
): "left_terminal" | "changed_since_capture" | null {
  if (!isTerminalTicketStatus(row.status)) return "left_terminal";
  const produced = Date.parse(producedAt ?? "");
  const touched = Date.parse(row.last_modified ?? "");
  if (Number.isFinite(produced) && Number.isFinite(touched) && touched > produced - TICKET_CAPTURE_SKEW_MS) {
    return "changed_since_capture";
  }
  return null;
}

/** AUTHZ-5 done-when 2: the keys among `keys` that a LIVE ticket outside
 *  `excludeIds` (the tickets being freed) still names in its attachments — a
 *  copied request, or a reference planted on purpose. Such a key is never
 *  deleted. THROWS on any read error (fail closed: the reclaim stops before
 *  it deletes anything). */
export async function keysOnOtherLiveTickets(
  sb: Pick<SupabaseClient, "from">,
  orgId: string,
  keys: readonly string[],
  excludeIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const uniq = Array.from(new Set(keys.filter(Boolean)));
  const shared = new Set<string>();
  for (let i = 0; i < uniq.length; i += 20) {
    const batch = uniq.slice(i, i + 20);
    const answers = await Promise.all(batch.map(async (key) => {
      const { data, error } = await sb
        .from("tickets")
        .select("id")
        .eq("org_id", orgId)
        .contains("attachments", JSON.stringify([{ url: key }]))
        .is("archived_at", null)
        .limit(50);
      if (error) throw new Error(`Couldn't verify which live requests still name these files (${error.message}); refusing to delete.`);
      const rows = (Array.isArray(data) ? data : data ? [data] : []) as Array<{ id: string }>;
      return rows.some((r) => !excludeIds.has(r.id)) ? key : null;
    }));
    for (const k of answers) if (k) shared.add(k);
  }
  return shared;
}
